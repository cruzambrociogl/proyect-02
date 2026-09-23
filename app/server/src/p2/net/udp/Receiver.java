package p2.net.udp;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;

import p2.fec.Block;
import p2.fec.MessageCodec;

/**
 * Puts arriving symbols back into messages, and says what is still wanted.
 *
 * A unit is set up by whichever of its symbols arrives first, so there is no first packet
 * whose loss would delay everything behind it. Symbols for a view the viewer has already left
 * are thrown away unopened - the epoch is in the packet header for exactly that, so a stale
 * unit costs no memory and no decoding.
 *
 * The rule that keeps the protocol quiet: a gap is not a loss. While symbols for a unit are
 * still arriving, whatever is missing is simply still on its way, and asking for it would
 * double the traffic for nothing. So a unit is only asked about once it has gone quiet for
 * about a round trip, and not asked about again until another has passed.
 */
public final class Receiver {

    /** What to do with a message once it is whole. */
    public interface Out {
        void message(int unit, byte[] message);
    }

    private final Out out;
    // in the order the units first appeared, so the oldest are asked about first and a long
    // queue of needs cannot starve the units that have been waiting longest
    private final Map<Integer, Partial> partial = new LinkedHashMap<>();
    private final ArrayDeque<Integer> finished = new ArrayDeque<>();   // recent, so late symbols are ignored
    private final java.util.Set<Integer> finishedSet = new java.util.HashSet<>();

    private final int memoryBudget;
    private int epoch;
    private int packets, highest, lastMicros;
    private long lastArrivalNanos;
    private int quietMicros = 30_000;
    private long unitsComplete, unitsStale, symbolsUseless;

    public Receiver(Out out, int memoryBudget) {
        this.out = out;
        this.memoryBudget = memoryBudget;
    }

    /** The viewer has moved. Everything held for an older view is dropped now, not later. */
    public void epoch(int epoch) {
        this.epoch = epoch;
        for (Iterator<Map.Entry<Integer, Partial>> it = partial.entrySet().iterator(); it.hasNext(); ) {
            if (it.next().getValue().epoch < epoch) {
                it.remove();
                unitsStale++;
            }
        }
    }

    /** How long a unit must be quiet before we ask about it: about one round trip. */
    public void rtt(int rttMicros) {
        quietMicros = Math.max(15_000, Math.min(400_000, (int) (rttMicros * 1.5)));
    }

    public long unitsComplete() { return unitsComplete; }

    public long unitsStale() { return unitsStale; }

    public long symbolsUseless() { return symbolsUseless; }

    public int packets() { return packets; }

    /** Units part-built and still waiting for symbols. */
    public int partial() { return partial.size(); }

    /** Takes one DATA packet: its header, and the symbol bytes that follow. */
    public void accept(int sequence, int micros, Packet.DataHeader header, byte[] symbol) {
        packets++;
        if (sequence - highest > 0) highest = sequence;
        lastMicros = micros;
        lastArrivalNanos = System.nanoTime();

        if (header.epoch() < epoch || finishedSet.contains(header.unit())) {
            unitsStale++;
            return;
        }
        Partial unit = partial.computeIfAbsent(header.unit(),
                id -> new Partial(header.epoch(), header.length()));
        unit.lastArrivalNanos = lastArrivalNanos;
        if (!unit.decoder.accept(header.block(), header.symbol(), symbol)) symbolsUseless++;

        if (unit.decoder.complete()) {
            byte[] message = unit.decoder.message();
            partial.remove(header.unit());
            remember(header.unit());
            unitsComplete++;
            out.message(header.unit(), message);
        }
    }

    /**
     * The report to send now. Units still arriving are left out of the needs: only the ones
     * that have gone quiet are asked about.
     */
    public Report report() {
        long now = System.nanoTime();
        List<Report.Need> needs = new ArrayList<>();
        boolean truncated = false;
        for (Map.Entry<Integer, Partial> entry : partial.entrySet()) {
            Partial unit = entry.getValue();
            boolean arriving = now - unit.lastArrivalNanos < quietMicros * 1000L;
            boolean askedRecently = now - unit.lastAskNanos < quietMicros * 1000L;

            // Every unit being held is named, every time. Only the ones that have gone quiet
            // ask for symbols; the rest are named with a count of zero, which means "still
            // here, send nothing yet". That is what makes the sender's rule safe: it frees a
            // unit when the receiver stops naming it, and the receiver stops naming a unit
            // only when it no longer holds it. A unit left out to save room, or because it
            // was asked about a moment ago, would be thrown away by a sender that had every
            // reason to think it had arrived.
            int[] missing = (arriving || askedRecently) ? null : unit.decoder.missing();
            int wanted = 0;
            if (missing != null) {
                for (int count : missing) {
                    if (count > 0) wanted++;
                }
            }
            if (needs.size() + Math.max(1, wanted) > Report.MAX_NEEDS) {
                truncated = true;                  // say so: the sender must not read this as delivered
                break;
            }
            if (missing == null) {
                needs.add(new Report.Need(entry.getKey(), 0, 0));
                continue;
            }
            unit.lastAskNanos = now;
            for (int block = 0; block < missing.length; block++) {
                if (missing[block] > 0) needs.add(new Report.Need(entry.getKey(), block, missing[block]));
            }
        }
        // Before anything has arrived there is nothing to echo, and a made-up stamp would be
        // read as a round trip of no time at all - which would become the path's floor and
        // make its propagation delay look like a queue for ever after. Zero means "no timing
        // in this report", and the sender skips it.
        if (packets == 0) return new Report(0, 0, 0, 0, credit(), partial.size(), truncated, needs);

        int hold = (int) ((System.nanoTime() - lastArrivalNanos) / 1000L);
        return new Report(lastMicros, Math.max(0, hold), packets, highest, credit(),
                partial.size(), truncated, needs);
    }

    /** Room left for units in flight - the sender never sends more than this. */
    private int credit() {
        int held = 0;
        for (Partial unit : partial.values()) held += unit.bytes;
        return Math.max(0, memoryBudget - held);
    }

    private void remember(int unit) {
        finished.add(unit);
        finishedSet.add(unit);
        while (finished.size() > 4096) finishedSet.remove(finished.poll());
    }

    /** One message being rebuilt. */
    private static final class Partial {
        final int epoch, bytes;
        final MessageCodec.Receiver decoder;
        long lastArrivalNanos = System.nanoTime();
        long lastAskNanos;

        Partial(int epoch, int length) {
            this.epoch = epoch;
            this.bytes = Block.blockCount(length) * Block.MAX_SYMBOLS * Block.SYMBOL_BYTES;
            this.decoder = new MessageCodec.Receiver(length);
        }
    }
}
