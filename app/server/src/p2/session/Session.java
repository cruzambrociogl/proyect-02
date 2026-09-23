package p2.session;

import p2.media.Catalog;
import p2.media.ImageMethod;
import p2.media.ImageMethod.UnitId;
import p2.media.ImageMethod.Viewport;
import p2.net.Link;
import p2.net.Wire;
import p2.util.Json;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * One viewer, for as long as it is connected: what it is looking at, what it already holds,
 * and what to send next.
 *
 * The rules that matter are here rather than in the transport, so they hold whichever
 * transport is underneath:
 *
 *   - send only units the current view needs, nearest the centre of the screen first;
 *   - never send a unit the client says it holds;
 *   - when the view changes, throw away whatever is still queued for the old one, because
 *     the viewer has moved on and those bytes would arrive already stale;
 *   - stop filling the transport once it says it has enough, so cancelling stays cheap.
 */
public final class Session implements Link.Inbound {

    private final Catalog catalog;
    private final Link link;

    private String imageName;
    private ImageMethod.Served served;
    private int epoch;
    private Viewport viewport;

    /** What the client holds, as it has told us: never send these again unless it drops them. */
    private final Set<UnitId> held = new HashSet<>();
    private List<UnitId> queue = List.of();
    private int queueAt;

    private long unitsSent, bytesSent, unitsCancelled, viewsSeen;
    private long lastStats;
    private boolean wasIdle = true;
    private boolean regather;            // the transport gave work back: work out what is missing

    public Session(Catalog catalog, Link link) {
        this.catalog = catalog;
        this.link = link;
    }

    @Override
    public void message(ByteBuffer message) {
        try {
            if (!Wire.looksValid(message)) {
                fault("not a protocol message");
                return;
            }
            int type = Wire.type(message);
            int messageEpoch = Wire.epoch(message);
            message.position(message.position() + Wire.HEADER);
            switch (type) {
                case Wire.HELLO -> welcome();
                case Wire.OPEN -> open(text(message));
                case Wire.VIEW -> view(messageEpoch, message);
                case Wire.BYE -> link.close();
                default -> fault("unexpected message type " + type);
            }
        } catch (Exception e) {
            fault(String.valueOf(e));
        }
    }

    @Override
    public void closed() {
        served = null;
        queue = List.of();
    }

    // ---------------------------------------------------------------- messages in

    private void welcome() {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("version", Wire.VERSION);
        body.put("method", catalog.method().id());
        send(Wire.text(Wire.WELCOME, epoch, Json.write(body)));
    }

    private void open(String name) throws IOException {
        if (name.equals(imageName) && served != null) {
            chart();                    // already open: they only missed the answer
            return;
        }
        if (!catalog.has(name)) {
            fault("no such image: " + name);
            return;
        }
        if (!catalog.method().isPrepared(catalog.preparedDir(name))) {
            fault(name + " is not prepared yet - prepare it on the server page first");
            return;
        }
        imageName = name;
        served = catalog.served(name);
        held.clear();
        queue = List.of();
        queueAt = 0;
        unitsSent = bytesSent = unitsCancelled = viewsSeen = 0;
        // The epoch is deliberately left alone: it counts the viewer's moves for as long as
        // the session lasts, and both ends read a lower one as an older view.

        chart();
    }

    /** What this image looks like: its shape, its method, how it is cut up. */
    private void chart() {
        ImageMethod.Meta meta = served.meta();
        Map<String, Object> chart = new LinkedHashMap<>();
        chart.put("image", imageName);
        chart.put("method", catalog.method().id());
        chart.put("contentType", served.unitContentType());
        chart.put("width", meta.width());
        chart.put("height", meta.height());
        chart.put("unitSize", meta.unitSize());
        chart.put("ratio", meta.ratio());
        chart.put("maxLevel", meta.maxLevel());
        chart.put("units", meta.units());
        chart.put("bytes", meta.bytes());
        send(Wire.text(Wire.CHART, epoch, Json.write(chart)));
    }

    /**
     * A new view. Payload: centre x and y and scale as doubles, the screen size, then the
     * units the client has dropped since last time (it is bounded by its memory budget, and
     * we must know, or we would never send them again).
     */
    private void view(int viewEpoch, ByteBuffer b) throws IOException {
        if (served == null) {
            fault("open an image first");
            return;
        }
        double cx = b.getDouble(), cy = b.getDouble(), scale = b.getDouble();
        int screenW = b.getShort() & 0xffff, screenH = b.getShort() & 0xffff;
        int dropped = b.getShort() & 0xffff;
        for (int i = 0; i < dropped; i++) {
            held.remove(new UnitId(b.getShort() & 0xffff, b.getInt(), b.getInt()));
        }
        if (viewEpoch < epoch) return;                  // an older view overtook a newer one
        viewsSeen++;
        epoch = viewEpoch;
        viewport = new Viewport(cx, cy, scale, screenW, screenH);

        List<UnitId> wanted = served.unitsFor(viewport);
        List<UnitId> next = new ArrayList<>(wanted.size());
        for (UnitId id : wanted) {
            if (!held.contains(id)) next.add(id);
        }
        unitsCancelled += Math.max(0, queue.size() - queueAt);   // whatever the old view still wanted
        queue = next;
        queueAt = 0;
        pump();
    }

    // ---------------------------------------------------------------- messages out

    /** Hand the transport as much as it will take, in priority order, for the current view. */
    private void pump() throws IOException {
        while (queueAt < queue.size() && link.writable()) {
            UnitId id = queue.get(queueAt++);
            if (held.contains(id)) continue;
            byte[] payload = served.bytes(id);
            if (!link.send(Wire.unit(epoch, id.level(), id.x(), id.y(), payload).array())) break;
            held.add(id);
            unitsSent++;
            bytesSent += payload.length;
        }
        stats();
    }

    /**
     * The transport gave up on a unit. Strike it from the ledger, and if the view still wants
     * it, queue it again.
     *
     * Without this the ledger lies. A unit is written into it the moment it is handed over,
     * because the transport is the thing that knows how to deliver it; when the transport then
     * abandons it - the viewer moved, the deadline passed - the session would go on believing
     * the viewer had a tile it was never sent, and would never offer it again. The hole stays
     * on the screen for as long as the viewer keeps looking at it, which is exactly the case
     * where it is most obvious.
     */
    @Override
    public void abandoned(ByteBuffer message) {
        if (!Wire.looksValid(message) || Wire.type(message) != Wire.UNIT) return;
        int at = message.position() + Wire.HEADER;
        UnitId id = new UnitId(message.getShort(at) & 0xffff,
                message.getInt(at + 2), message.getInt(at + 6));
        if (!held.remove(id)) return;
        unitsSent--;
        bytesSent -= message.remaining() - Wire.HEADER - Wire.UNIT_HEADER;
        // Not queued here and now: this is called from inside the sending loop, which is
        // walking the very queue that would be replaced. The next turn of the loop picks it up.
        regather = true;
    }

    /** Work out again what the current view is missing, after units were given back. */
    private void regather() {
        regather = false;
        if (served == null || viewport == null) return;
        List<UnitId> next = new ArrayList<>();
        for (UnitId id : served.unitsFor(viewport)) {
            if (!held.contains(id)) next.add(id);
        }
        queue = next;
        queueAt = 0;
    }

    /** Called by the transport when it drains, so a big view keeps flowing. */
    @Override
    public void drained() {
        try {
            if (regather) regather();
            pump();
        } catch (IOException e) {
            fault(String.valueOf(e));
        }
    }

    /**
     * Statistics for the panel, a few times a second at most, plus one the moment the queue
     * empties so the last numbers are the true ones.
     *
     * The throttle has to hold even when there is nothing left to send. Over our own protocol
     * this is called every time the client reports, a hundred times a second, and each of
     * these is a message the sender then has to deliver: for one image of twelve tiles the
     * wire was carrying seven hundred units, almost all of them statistics about carrying
     * statistics.
     */
    private void stats() {
        long now = System.currentTimeMillis();
        boolean idle = queueAt >= queue.size();
        boolean justFinished = idle && !wasIdle;
        wasIdle = idle;
        if (now - lastStats < 200 && !justFinished) return;
        lastStats = now;
        Map<String, Object> s = new LinkedHashMap<>();
        s.put("epoch", epoch);
        s.put("image", imageName);
        s.put("queued", Math.max(0, queue.size() - queueAt));
        s.put("held", held.size());
        s.put("unitsSent", unitsSent);
        s.put("bytesSent", bytesSent);
        s.put("unitsCancelled", unitsCancelled);
        s.put("views", viewsSeen);
        s.put("linkBytes", link.bytesSent());
        s.put("linkMessages", link.messagesSent());
        s.putAll(link.extra());
        send(Wire.text(Wire.STATS, epoch, Json.write(s)));
    }

    private void fault(String text) {
        send(Wire.text(Wire.FAULT, epoch, text));
    }

    private void send(byte[] message) {
        link.send(message);
    }

    private static String text(ByteBuffer b) {
        byte[] bytes = new byte[b.remaining()];
        b.get(bytes);
        return new String(bytes, StandardCharsets.UTF_8);
    }
}
