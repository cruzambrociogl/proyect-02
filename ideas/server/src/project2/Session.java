package project2;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Set;
import java.util.function.BiConsumer;

/**
 * Per-client protocol state.
 *
 * The server tracks what each client holds, so it only ever sends the difference - this is
 * requirement #2 of the brief ("the server keeps control of each client's resolution").
 * For now the ledger is a plain set of tile keys; credits and FADE (server-driven eviction)
 * come next.
 */
public final class Session {

    private final ImageRegistry registry;
    private final int id;
    private final BiConsumer<Integer, byte[]> out;

    private Source store;
    private final Set<String> held = new HashSet<>();
    private int epoch = 0;
    private int screenW = 1280, screenH = 720;

    /** Cap per GAZE so one viewport cannot monopolise the socket. Credits will replace this. */
    private static final int MAX_TILES_PER_GAZE = 48;

    public Session(ImageRegistry registry, int id, BiConsumer<Integer, byte[]> out) {
        this.registry = registry;
        this.id = id;
        this.out = out;
    }

    public int id() { return id; }

    public void onMessage(ByteBuffer buf) throws Exception {
        Protocol.Header h = Protocol.readHeader(buf);
        if (h == null) return;
        switch (h.type()) {
            case Protocol.GREET -> onGreet(buf);
            case Protocol.OPEN -> onOpen(buf, h.length());
            case Protocol.GAZE -> onGaze(buf, h.epoch());
            case Protocol.PART -> { }
            default -> fault("unknown message type " + h.type());
        }
    }

    private void onGreet(ByteBuffer b) {
        screenW = b.getShort() & 0xFFFF;
        screenH = b.getShort() & 0xFFFF;
        b.getShort();                        // tile budget, used once eviction lands
    }

    /** Client asks for an image by name; the server replies with its geometry. */
    private void onOpen(ByteBuffer b, int length) {
        byte[] nameBytes = new byte[length];
        b.get(nameBytes);
        String name = new String(nameBytes, StandardCharsets.UTF_8);
        try {
            store = registry.open(name);
            held.clear();                    // new image, the client holds nothing of it
            epoch = 0;
            System.out.printf("session %d opened %s (%dx%d)%n", id, name, store.width(), store.height());

            ByteBuffer m = Protocol.message(Protocol.CHART, 0, 4 + 4 + 2 + 4 + 2);
            m.putInt(store.width());
            m.putInt(store.height());
            m.putShort((short) store.tileSize());
            m.putFloat((float) store.ratio());
            m.putShort((short) store.maxLevel());
            send(m);
        } catch (Exception e) {
            fault("cannot open image: " + e.getMessage());
        }
    }

    /**
     * The client reports where it is looking; the server decides which tiles that requires.
     * Scale is source pixels per screen pixel, so the ladder level is floor(log_ratio scale)
     * - the finest ladder step that is not finer than the screen can show.
     */
    private void onGaze(ByteBuffer b, int gazeEpoch) throws Exception {
        float cx = b.getFloat(), cy = b.getFloat(), scale = b.getFloat();
        int vw = b.getShort() & 0xFFFF, vh = b.getShort() & 0xFFFF;
        if (store == null) { fault("no image open"); return; }
        if (gazeEpoch < epoch) return;                  // stale view, drop it
        epoch = gazeEpoch;

        int level = (int) Math.floor(Math.log(Math.max(1e-6, scale)) / Math.log(store.ratio()));
        level = Math.max(0, Math.min(store.maxLevel(), level));

        double ls = store.ladderScale(level);
        double halfW = vw * scale / 2, halfH = vh * scale / 2;
        int ts = store.tileSize();

        int tx0 = (int) Math.floor((cx - halfW) / ls / ts);
        int tx1 = (int) Math.floor((cx + halfW) / ls / ts);
        int ty0 = (int) Math.floor((cy - halfH) / ls / ts);
        int ty1 = (int) Math.floor((cy + halfH) / ls / ts);

        double centreTx = (cx / ls) / ts, centreTy = (cy / ls) / ts;

        record Want(int tx, int ty, double d) {}
        var wanted = new java.util.ArrayList<Want>();
        for (int ty = ty0; ty <= ty1; ty++)
            for (int tx = tx0; tx <= tx1; tx++) {
                if (tx < 0 || ty < 0) continue;
                if (tx * ts >= store.levelWidth(level) || ty * ts >= store.levelHeight(level)) continue;
                if (held.contains(level + ":" + tx + ":" + ty)) continue;
                double d = Math.hypot(tx + 0.5 - centreTx, ty + 0.5 - centreTy);
                wanted.add(new Want(tx, ty, d));
            }
        // Centre-out: what the user is looking at arrives first.
        wanted.sort((a, c) -> Double.compare(a.d(), c.d()));

        int sent = 0;
        for (Want w : wanted) {
            if (sent >= MAX_TILES_PER_GAZE) break;
            if (gazeEpoch < epoch) return;              // a newer view arrived mid-send
            byte[] jpeg = store.tile(level, w.tx(), w.ty());
            if (jpeg == null) continue;

            ByteBuffer m = Protocol.message(Protocol.TILE, gazeEpoch, 2 + 4 + 4 + jpeg.length);
            m.putShort((short) level);
            m.putInt(w.tx());
            m.putInt(w.ty());
            m.put(jpeg);
            send(m);

            held.add(level + ":" + w.tx() + ":" + w.ty());
            sent++;
        }
    }

    private void fault(String text) {
        byte[] msg = text.getBytes(StandardCharsets.UTF_8);
        ByteBuffer m = Protocol.message(Protocol.FAULT, epoch, msg.length);
        m.put(msg);
        send(m);
    }

    private void send(ByteBuffer m) {
        out.accept(WebSocketCodec.OP_BINARY, m.array());
    }
}
