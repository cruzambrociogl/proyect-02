package p2.net.udp;

import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.List;

/**
 * Everything the receiver ever says back, in one packet.
 *
 * It is worth being precise about what is *not* here, because it is the protocol's main
 * decision. There is no list of packets that went missing, no acknowledgement of the ones that
 * arrived, and no request to send a particular packet again. A receiver only ever says: I have
 * seen this many packets, the highest number I saw was that, I am holding this much room, and
 * for unit 42 block 0 I need three more symbols - any three.
 *
 * That is enough for everything the sender has to decide:
 *   - {@code received} against {@code highestSequence} gives the loss rate, which sets how much
 *     repair to add to what follows;
 *   - {@code echoMicros} and {@code holdMicros} give the round trip with the receiver's own
 *     thinking time removed, which is what the congestion control watches;
 *   - {@code credit} is how many more bytes the receiver has room to hold, so the sender can
 *     never push a viewer into swapping;
 *   - the needs say what to send next, without either side naming a lost packet.
 *
 * A report is a snapshot, not an event: losing one costs nothing, because the next one carries
 * the whole picture again. That is why there is no acknowledgement of reports either.
 */
public record Report(int echoMicros, int holdMicros, int received, int highestSequence,
                     int credit, List<Need> needs) {

    /** "For this block of this unit, send me this many more symbols - whichever ones." */
    public record Need(int unit, int block, int count) {}

    /** How many needs fit in one datagram alongside the fixed part. */
    public static final int MAX_NEEDS = 100;

    private static final int FIXED = 22;
    private static final int NEED_BYTES = 8;

    public void writeTo(ByteBuffer out) {
        out.putInt(echoMicros);
        out.putInt(holdMicros);
        out.putInt(received);
        out.putInt(highestSequence);
        out.putInt(credit);
        int count = Math.min(needs.size(), MAX_NEEDS);
        out.putShort((short) count);
        for (int i = 0; i < count; i++) {
            Need need = needs.get(i);
            out.putInt(need.unit());
            out.putShort((short) need.block());
            out.putShort((short) need.count());
        }
    }

    public static Report readFrom(ByteBuffer in) {
        int echo = in.getInt(), hold = in.getInt(), received = in.getInt();
        int highest = in.getInt(), credit = in.getInt();
        int count = in.getShort() & 0xffff;
        List<Need> needs = new ArrayList<>(count);
        for (int i = 0; i < count && in.remaining() >= NEED_BYTES; i++) {
            needs.add(new Need(in.getInt(), in.getShort() & 0xffff, in.getShort() & 0xffff));
        }
        return new Report(echo, hold, received, highest, credit, needs);
    }

    public int bytes() {
        return FIXED + Math.min(needs.size(), MAX_NEEDS) * NEED_BYTES;
    }

    /** The share of packets that did not arrive, as the sender's own numbering sees it. */
    public double lossRate() {
        int expected = highestSequence + 1;
        if (expected <= 0 || received <= 0) return 0;
        return Math.max(0, Math.min(1, 1.0 - (double) received / expected));
    }
}
