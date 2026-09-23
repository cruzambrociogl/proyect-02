package p2.net.udp;

import java.nio.ByteBuffer;
import java.util.LinkedHashMap;
import java.util.Map;

import p2.net.Link;
import p2.net.Wire;

/**
 * The session layer, speaking our own protocol instead of a WebSocket.
 *
 * This is the swap the {@link Link} interface was written for. Everything above it - which
 * units the view needs, what the viewer already holds, what to abandon when it moves - is the
 * same code whether the bytes leave over TCP or over our UDP protocol. What changes is
 * underneath: a message handed over here is not written to a socket but offered to the
 * {@link Sender}, with a deadline and a class, and the sender decides what actually goes on
 * the wire and when.
 *
 * The epoch in each message header does one more job here. When it rises, the viewer has
 * moved, so everything still queued for the old view is dropped before the new work is
 * offered - the cancellation the viewer feels as "it stopped sending me tiles I can no longer
 * see" happens right here, in one call.
 */
public final class SenderLink implements Link {

    /** How much the session may run ahead of the wire. Small, so cancelling stays cheap. */
    private static final int QUEUE_LIMIT = 64;

    /** A tile the viewer is waiting for is worth nothing if it takes longer than this. */
    private static final long UNIT_DEADLINE_MILLIS = 5_000;

    /** Answers about the image itself are worth waiting longer for. */
    private static final long CONTROL_DEADLINE_MILLIS = 20_000;

    private final Sender sender;
    private final Runnable onClose;
    private int epoch;
    private boolean closed;

    public SenderLink(Sender sender, Runnable onClose) {
        this.sender = sender;
        this.onClose = onClose;
    }

    /** Wired after the session exists, so it hears about work the sender gives up on. */
    public void inbound(Link.Inbound inbound) {
        sender.onAbandoned(message -> inbound.abandoned(ByteBuffer.wrap(message)));
    }

    public Sender sender() { return sender; }

    @Override
    public boolean send(byte[] message) {
        if (closed) return false;
        ByteBuffer header = ByteBuffer.wrap(message);
        if (!Wire.looksValid(header)) return false;
        int type = Wire.type(header);
        int messageEpoch = Wire.epoch(header);

        if (messageEpoch > epoch) {
            epoch = messageEpoch;
            sender.epoch(messageEpoch);                // the viewer moved: drop the old view's work
        }
        // Tiles belong to the view that asked for them and go stale with it. Everything else
        // is offered as timeless - epoch zero - because the answer to "what shape is this
        // image" does not stop being true when the viewer moves.
        boolean tile = type == Wire.UNIT;
        sender.offer(message, tile ? messageEpoch : 0,
                tile ? Sender.Class.VISIBLE : Sender.Class.URGENT,
                tile ? UNIT_DEADLINE_MILLIS : CONTROL_DEADLINE_MILLIS);
        return true;
    }

    @Override
    public boolean writable() {
        return !closed && sender.queued() < QUEUE_LIMIT;
    }

    @Override public long bytesSent() { return sender.bytesSent(); }

    @Override public long messagesSent() { return sender.symbolsSent(); }

    @Override
    public void close() {
        closed = true;
        onClose.run();
    }

    /** What the panel shows about the path, measured by the side that is sending. */
    @Override
    public Map<String, Object> extra() {
        RateControl control = sender.control();
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("rate", control.rate() * 8);                    // bits per second
        out.put("rttMicros", sender.rttMicros());
        out.put("queueMicros", control.queueMicros());
        out.put("floorMicros", control.rttMinMicros());
        out.put("loss", sender.lossRate());
        out.put("queued", sender.queued());
        out.put("truncated", sender.truncatedReports());
        out.put("receiverHolds", sender.heldByReceiver());
        out.put("symbols", sender.symbolsSent());
        out.put("unitsDelivered", sender.unitsDelivered());
        out.put("unitsDropped", sender.unitsDropped());
        return out;
    }
}
