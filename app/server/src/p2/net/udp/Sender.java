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

    /**
     * Told about a message that will not be delivered after all, because the viewer moved on
     * or its deadline passed.
     *
     * Dropping work is the point of the deadlines and the classes, but whoever handed it over
     * has to hear about it. The session keeps a ledger of what the viewer holds, and writes a
     * unit into that ledger when it hands it to the transport; if the transport then quietly
     * abandons it, the ledger says the viewer has a tile that was never sent and nothing will
     * ever ask for it again - a hole in the picture that no amount of waiting fills.
     */
    public interface Abandoned {
        void message(byte[] message);
    }

    /**
     * What a message is for, in the order it is sent.
     *
     * URGENT is the protocol talking about itself - the answer to a hello, the shape of an
     * image, a fault, the statistics behind the panel. It goes first because it is small and
     * everything else waits on it, and it survives a change of view: the viewer moving does
     * not make the answer to its question stale.
     */
    public enum Class { URGENT, VISIBLE, PREFETCH }

    private final Out out;
    private final List<Outgoing> outgoing = new ArrayList<>();
    private int nextUnitId = 1;
    private int epoch;

    private final RateControl control = new RateControl();
    private double lossRate;
    private int credit = 1 << 20;
    private int rttMicros = 50_000;
    private double tokens;
    private long lastFillNanos = System.nanoTime();

    private long unitsOffered, unitsDelivered, unitsDropped, symbolsSent, bytesSent;
    private final java.util.ArrayDeque<Long> recentlySent = new java.util.ArrayDeque<>();
    private long lastReportNanos, lastReceived, lastSymbolsSent;
    private boolean starved;                          // the queue of work ran dry since the last measure

    private Abandoned abandoned = message -> {};

    public Sender(Out out) {
        this.out = out;
    }

    public void onAbandoned(Abandoned abandoned) {
        this.abandoned = abandoned;
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
            if (unit.epoch < epoch && unit.klass != Class.URGENT) {
                it.remove();
                unitsDropped++;
                abandoned.message(unit.message);
            }
        }
    }

    /** The rate control, for the panel and the traces. */
    public RateControl control() { return control; }

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
        boolean timed = report.echoMicros() != 0 || report.holdMicros() != 0;
        if (timed && sample > 0 && sample < 5_000_000) {
            rttMicros = (int) (0.8 * rttMicros + 0.2 * sample);
            control.sample(sample, deliveredRate(report));
        }

        for (Report.Need need : report.needs()) {
            if (need.count() == 0) continue;        // named only so we keep it: nothing to send yet
            for (Outgoing unit : outgoing) {
                if (unit.id == need.unit() && need.block() < unit.owed.length) {
                    // one spare, plus the share the path is expected to swallow
                    unit.owed[need.block()] = Math.max(unit.owed[need.block()],
                            need.count() + 1 + (int) Math.ceil(need.count() * lossRate));
                    unit.finishedAtNanos = 0;
                }
            }
        }
        // The receiver has thrown away everything older than the view it is on now, so its
        // silence about those units means the opposite of delivery. They go back to whoever
        // offered them, as work still to do, rather than being quietly counted as done.
        for (Iterator<Outgoing> it = outgoing.iterator(); it.hasNext(); ) {
            Outgoing unit = it.next();
            if (unit.klass != Class.URGENT && unit.epoch != 0 && unit.epoch < report.epoch()) {
                it.remove();
                unitsDropped++;
                abandoned.message(unit.message);
            }
        }

        if (report.truncated()) return;        // it had more to say than fitted: prove nothing from silence
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
        while (tokens >= Packet.MAX_DATAGRAM && credit > Packet.MAX_DATAGRAM
                && inFlight() + Packet.MAX_DATAGRAM <= window()) {
            expire();
            Outgoing unit = next();
            if (unit == null) {
                starved = true;                        // room to send, nothing to send: not the path's fault
                return;
            }
            int block = unit.blockToSend();
            if (block < 0) {
                starved = true;
                return;
            }

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
            recentlySent.addLast(System.nanoTime());
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
        boolean speculation = control.allowsScavenger();
        Outgoing best = null;
        for (Outgoing unit : outgoing) {
            if (unit.sentEverything()) continue;
            if (unit.klass == Class.PREFETCH && !speculation) continue;
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
                abandoned.message(unit.message);
            }
        }
    }

    /**
     * How much is on the wire right now: what was sent within the last round trip, since
     * nothing sent longer ago than that can still be in the air.
     *
     * This is where the absence of acknowledgements shows. A protocol that acknowledges
     * packets knows precisely what is outstanding; this one has to reason from the clock. The
     * first attempt counted every unit not yet confirmed, and deadlocked: confirmation takes
     * two round trips to arrive, by which time the window had been full for longer than that
     * and nothing could be sent to trigger it.
     */
    private long inFlight() {
        long cutoff = System.nanoTime() - Math.max(5_000, rttMicros) * 1000L;
        while (!recentlySent.isEmpty() && recentlySent.peekFirst() < cutoff) recentlySent.pollFirst();
        return (long) recentlySent.size() * Packet.MAX_DATAGRAM;
    }

    /**
     * How much may be in the air at once: one round trip's worth of the current rate, and half
     * as much again so the path does not run dry between reports. The pacing does most of the
     * work; this is the backstop for when a measurement goes wrong.
     */
    private long window() {
        return Math.max(8L * Packet.MAX_DATAGRAM,
                (long) (control.rate() * (rttMicros / 1e6) * 1.5));
    }

    private void fillTokens() {
        long now = System.nanoTime();
        long rate = control.rate();
        tokens += (now - lastFillNanos) / 1e9 * rate;
        lastFillNanos = now;
        double burst = Math.max(4, rate * rttMicros / 1e6 / Packet.MAX_DATAGRAM);
        tokens = Math.min(tokens, burst * Packet.MAX_DATAGRAM);
    }

    /**
     * How fast bytes are arriving at the far end, from the count of packets two successive
     * reports have seen. It is measured rather than assumed: the sender knows what it put on
     * the wire, but only the receiver knows what came out the other side.
     *
     * It counts only while the sender was actually pushing as hard as its rate allows. A
     * sender with nothing to send also delivers nothing, and reading that as a slow path would
     * be a trap it could not climb out of: it would slow down, deliver less, read the path as
     * slower still, and end up crawling on an empty link. So a stretch in which the queue of
     * work ran dry is reported as no measurement at all rather than as a small one.
     */
    private long deliveredRate(Report report) {
        long now = System.nanoTime();
        if (lastReportNanos == 0) {
            lastReportNanos = now;
            lastReceived = report.received();
            lastSymbolsSent = symbolsSent;
            return 0;
        }
        // Measured over a long enough stretch to be worth believing. Packets arrive in clumps
        // - a path with a queue in it releases them in bursts - so a rate taken over a few
        // milliseconds can read several times the truth, and a sender pacing at a speed the
        // path cannot carry fills the queue and keeps it full.
        double seconds = (now - lastReportNanos) / 1e9;
        if (seconds < 0.2) return 0;

        long arrived = report.received() - lastReceived;
        boolean ranDry = starved;

        lastReportNanos = now;
        lastReceived = report.received();
        lastSymbolsSent = symbolsSent;
        starved = false;

        if (arrived <= 0 || ranDry) return 0;                      // we were the slow part, not the path
        return (long) (arrived * (long) Packet.MAX_DATAGRAM / seconds);
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
