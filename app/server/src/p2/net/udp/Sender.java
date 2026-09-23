package p2.net.udp;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;

import p2.fec.MessageCodec;

/**
 * Decides what to put on the wire next, and how much of it.
 *
 * Three questions, kept apart on purpose:
 *
 *   which unit    - the one whose deadline is nearest, among those the viewer is still
 *                   looking at. A unit the viewer has moved away from is dropped where it
 *                   stands, however much of it has already been sent; a unit whose deadline
 *                   has passed is dropped too, because a tile that arrives after the viewer
 *                   has left is worse than no tile - it cost bandwidth the next view needed.
 *                   Work the viewer may need soon travels as a second class that yields to
 *                   the first, so guessing wrong costs nothing that was going to be seen.
 *
 *   how much      - k symbols plus repair in proportion to the loss the receiver reports, so
 *                   the redundancy is paid only where the path actually loses packets. On a
 *                   clean path the overhead is one packet per unit.
 *
 *   how fast      - a rate set from outside (the congestion control) and paced out, never a
 *                   burst. Nothing is sent that the receiver has no room to hold.
 *
 * What is absent is as deliberate: no timer per packet, no retransmission queue, no record of
 * which packets were sent. A unit is finished when the receiver stops asking for it.
 */
public final class Sender {

    /** Where the chosen symbols go. */
    public interface Out {
        void symbol(Packet.DataHeader header, byte[] data);
    }

    /** Units the viewer is waiting on, and units we think it will want. */
    public enum Class { VISIBLE, PREFETCH }

    private final Out out;
    private final List<Outgoing> outgoing = new ArrayList<>();
    private int nextUnitId = 1;
    private int epoch;

    private double lossRate;
    private int credit = 1 << 20;
    private int rttMicros = 50_000;
    private long bytesPerSecond = 6_000_000;          // replaced by the congestion control
    private double tokens;
    private long lastFillNanos = System.nanoTime();

    private long unitsOffered, unitsDelivered, unitsDropped, symbolsSent, bytesSent;

    public Sender(Out out) {
        this.out = out;
    }

    /** One whole protocol message to deliver, if it can be delivered in time. */
    public void offer(byte[] message, int epoch, Class klass, long deadlineMillis) {
        Outgoing unit = new Outgoing(nextUnitId++, epoch, klass, message,
                System.nanoTime() + deadlineMillis * 1_000_000L);
        unit.plan(lossRate);
        outgoing.add(unit);
        unitsOffered++;
    }

    /** The viewer has moved: everything still queued for an older view is now waste. */
    public void epoch(int epoch) {
        this.epoch = epoch;
        for (Iterator<Outgoing> it = outgoing.iterator(); it.hasNext(); ) {
            Outgoing unit = it.next();
            if (unit.epoch < epoch && unit.klass == Class.VISIBLE) {
                it.remove();
                unitsDropped++;
            }
        }
    }

    public void rate(long bytesPerSecond) {
        this.bytesPerSecond = Math.max(16_000, bytesPerSecond);
    }

    public int rttMicros() { return rttMicros; }

    public double lossRate() { return lossRate; }

    public int queued() { return outgoing.size(); }

    public long unitsDelivered() { return unitsDelivered; }

    public long unitsDropped() { return unitsDropped; }

    public long symbolsSent() { return symbolsSent; }

    public long bytesSent() { return bytesSent; }

    /**
     * What the receiver said.
     *
     * A need adds symbols back to a unit's plan. A unit that has been fully sent and is still
     * not mentioned once the receiver has had time to notice and to say so is finished: it
     * would be asking otherwise. That is the only completion signal in the protocol, and it
     * costs no packet of its own.
     *
     * The waiting matters. The receiver stays quiet about a unit while its symbols are still
     * arriving, so a report that arrives the moment the last symbol leaves says nothing about
     * whether it was enough. Freeing a unit on that silence loses it for good: the request
     * that follows finds nothing left to answer it. So a unit is held for the time the
     * receiver takes to notice a gap, plus the trip back.
     */
    public void report(Report report, int nowMicros) {
        lossRate = 0.75 * lossRate + 0.25 * report.lossRate();
        credit = report.credit();
        int sample = nowMicros - report.echoMicros() - report.holdMicros();
        if (sample > 0 && sample < 5_000_000) rttMicros = (int) (0.8 * rttMicros + 0.2 * sample);

        for (Report.Need need : report.needs()) {
            for (Outgoing unit : outgoing) {
                if (unit.id == need.unit() && need.block() < unit.owed.length) {
                    // one spare, plus the share the path is expected to swallow
                    unit.owed[need.block()] = Math.max(unit.owed[need.block()],
                            need.count() + 1 + (int) Math.ceil(need.count() * lossRate));
                    unit.finishedAtNanos = 0;
                }
            }
        }
        long now = System.nanoTime();
        long hold = (long) (rttMicros * 2.5 + 30_000) * 1000L;
        for (Iterator<Outgoing> it = outgoing.iterator(); it.hasNext(); ) {
            Outgoing unit = it.next();
            if (unit.finishedAtNanos > 0 && now - unit.finishedAtNanos > hold
                    && !mentions(report, unit.id)
                    && after(report.echoMicros(), unit.lastSymbolMicros)) {
                it.remove();
                unitsDelivered++;
            }
        }
    }

    /**
     * Sends whatever the clock and the receiver's room allow. Called often; does nothing if it
     * is too early for the next packet.
     */
    public void pump() {
        fillTokens();
        while (tokens >= Packet.MAX_DATAGRAM && credit > Packet.MAX_DATAGRAM) {
            expire();
            Outgoing unit = next();
            if (unit == null) return;
            int block = unit.blockToSend();
            if (block < 0) return;

            byte[] symbol = unit.encoder.symbol(block, unit.next[block]);
            Packet.DataHeader header = new Packet.DataHeader(
                    unit.epoch, unit.id, unit.message.length, block, unit.next[block]);
            unit.next[block]++;
            unit.owed[block]--;
            unit.lastSymbolMicros = Packet.now();
            if (unit.sentEverything()) unit.finishedAtNanos = System.nanoTime();
            out.symbol(header, symbol);

            symbolsSent++;
            bytesSent += Packet.MAX_DATAGRAM;
            tokens -= Packet.MAX_DATAGRAM;
            credit -= Packet.MAX_DATAGRAM;
        }
    }

    /** Whether there is anything left worth sending now. */
    public boolean idle() {
        for (Outgoing unit : outgoing) {
            if (!unit.sentEverything()) return false;
        }
        return true;
    }

    /** Earliest deadline first, with the visible class always ahead of the speculative one. */
    private Outgoing next() {
        Outgoing best = null;
        for (Outgoing unit : outgoing) {
            if (unit.sentEverything()) continue;
            if (best == null
                    || (unit.klass.ordinal() < best.klass.ordinal())
                    || (unit.klass == best.klass && unit.deadlineNanos < best.deadlineNanos)) {
                best = unit;
            }
        }
        return best;
    }

    /** Throws away work that can no longer arrive in time to be of any use. */
    private void expire() {
        long now = System.nanoTime();
        for (Iterator<Outgoing> it = outgoing.iterator(); it.hasNext(); ) {
            Outgoing unit = it.next();
            if (!unit.sentEverything() && now > unit.deadlineNanos) {
                it.remove();
                unitsDropped++;
            }
        }
    }

    private void fillTokens() {
        long now = System.nanoTime();
        tokens += (now - lastFillNanos) / 1e9 * bytesPerSecond;
        lastFillNanos = now;
        double burst = Math.max(4, bytesPerSecond * rttMicros / 1e6 / Packet.MAX_DATAGRAM);
        tokens = Math.min(tokens, burst * Packet.MAX_DATAGRAM);
    }

    private static boolean mentions(Report report, int unit) {
        for (Report.Need need : report.needs()) {
            if (need.unit() == unit) return true;
        }
        return false;
    }

    /** Microsecond stamps wrap; only the difference means anything. */
    private static boolean after(int a, int b) {
        return a - b > 0;
    }

    /** One message on its way out. */
    private static final class Outgoing {
        final int id, epoch;
        final Class klass;
        final byte[] message;
        final long deadlineNanos;
        final MessageCodec.Encoder encoder;
        final int[] next;                              // the next symbol number per block
        final int[] owed;                              // symbols still to send per block
        int lastSymbolMicros;
        long finishedAtNanos;                          // when the last planned symbol left

        Outgoing(int id, int epoch, Class klass, byte[] message, long deadlineNanos) {
            this.id = id;
            this.epoch = epoch;
            this.klass = klass;
            this.message = message;
            this.deadlineNanos = deadlineNanos;
            this.encoder = new MessageCodec.Encoder(message);
            this.next = new int[encoder.blocks()];
            this.owed = new int[encoder.blocks()];
        }

        void plan(double lossRate) {
            for (int block = 0; block < owed.length; block++) {
                owed[block] = encoder.symbolsToSend(block, lossRate);
            }
        }

        int blockToSend() {
            for (int block = 0; block < owed.length; block++) {
                if (owed[block] > 0) return block;
            }
            return -1;
        }

        boolean sentEverything() {
            return blockToSend() < 0;
        }
    }
}
