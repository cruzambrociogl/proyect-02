package p2.net.udp;

import java.util.ArrayDeque;

/**
 * How fast to send, decided by how long packets are waiting rather than by whether they are
 * being lost.
 *
 * Loss is the wrong signal for this protocol twice over. The repair symbols already absorb
 * loss, so a sender that also slowed down for it would be paying for the same packet twice;
 * and on a path that loses packets for its own reasons - anything wireless - loss says nothing
 * about congestion at all, so a loss-driven sender crawls on a link that is perfectly idle.
 *
 * What this watches instead is the queue. The round trip has a floor: the time the path takes
 * when nothing is waiting in it. Anything above that floor is time our own packets are
 * spending in somebody's buffer. The sender aims for a rate at which that waiting time settles
 * at about one packet's worth of queue - fast enough to use the path, slow enough that a
 * viewer's next request is not stuck behind a queue we built ourselves. A sender that instead
 * pushes until packets drop leaves a full buffer behind it, and on a viewer that means every
 * movement of the mouse waits out the backlog.
 *
 *   target rate = 1 / (aim x queueing delay)
 *
 * Above the target it slows, below it speeds up, by a step that grows while it keeps moving
 * the same way, so a path that suddenly gets faster or slower is followed in a few round trips
 * rather than a few hundred. {@code aim} is how much queue to tolerate: the small value is for
 * what the viewer is looking at, the large one for work sent on speculation, which gives way
 * as soon as the path shows any sign of filling.
 */
public final class RateControl {

    /** How much queueing to aim for: smaller means more aggressive. */
    private static final double AIM_VISIBLE = 0.5;
    private static final double AIM_SCAVENGER = 2.0;

    /** A queue below this is treated as empty: clocks are not that precise. */
    private static final int FLOOR_MICROS = 1_000;

    private static final long MIN_RATE = 64_000;              // ~0.5 mbit, the slowest we go
    private static final long MAX_RATE = 1_250_000_000L;      // 10 gbit, a sanity bound

    private final ArrayDeque<long[]> recent = new ArrayDeque<>();   // (nanos, rtt micros)
    private long rate = 125_000;                              // 1 mbit, before anything is known
    private int rttMin = Integer.MAX_VALUE;
    private int rttMinOther = Integer.MAX_VALUE;              // the half-built next window
    private long windowStartedNanos = System.nanoTime();
    private int rttSmooth;
    private double velocity = 1;
    private int direction;                                    // +1 speeding up, -1 slowing down
    private int sameDirection;
    private boolean probing = true;                           // doubling, until the queue first fills
    private long lastUpdateNanos = System.nanoTime();
    private int queueMicros;
    private long delivered;                                   // bytes per second actually arriving
    private long deliveredOther;                              // the half-built next window
    private long deliveredWindowNanos = System.nanoTime();

    /**
     * One round trip measurement, with the receiver's own delay already taken out, and how
     * fast bytes are actually reaching the far end.
     *
     * The delivered rate is what keeps the rest honest. Sending faster than the path can carry
     * does not make anything arrive sooner - it only lengthens the queue, and the queue is
     * what the viewer feels. So the rate is never allowed far above what is measurably getting
     * through, and when the first doubling ends it drops straight to that measurement rather
     * than to whatever inflated number the doubling had reached.
     */
    public void sample(int rttMicros, long deliveredBytesPerSecond) {
        if (rttMicros <= 0 || rttMicros > 5_000_000) return;
        if (deliveredBytesPerSecond > 0) {
            // the best seen recently, not an average: an average falls as soon as the sender
            // slows down, which would read a path we are deliberately not filling as a path
            // that has got narrower - and there is no way back out of that
            long now = System.nanoTime();
            if (now - deliveredWindowNanos > 5_000_000_000L) {
                deliveredWindowNanos = now;
                delivered = deliveredOther;
                deliveredOther = 0;
            }
            delivered = Math.max(delivered, deliveredBytesPerSecond);
            deliveredOther = Math.max(deliveredOther, deliveredBytesPerSecond);
        }
        long now = System.nanoTime();
        rttSmooth = rttSmooth == 0 ? rttMicros : (int) (0.875 * rttSmooth + 0.125 * rttMicros);

        // the floor of the path, over a window long enough to survive a busy patch but short
        // enough to notice a route that has genuinely changed
        if (now - windowStartedNanos > 10_000_000_000L) {
            windowStartedNanos = now;
            rttMin = rttMinOther == Integer.MAX_VALUE ? rttMicros : rttMinOther;
            rttMinOther = Integer.MAX_VALUE;
        }
        rttMin = Math.min(rttMin, rttMicros);
        rttMinOther = Math.min(rttMinOther, rttMicros);

        // The queue as it stands right now: the lowest round trip seen over a recent window,
        // so that a single late packet does not invent a queue that is not there. The window
        // has to be wide enough to hold several measurements - a path with jitter of ten
        // milliseconds will show ten milliseconds of imaginary queue if we believe any one
        // sample, and a sender that believes it will crawl on an empty link.
        recent.addLast(new long[]{now, rttMicros});
        long window = Math.min(400_000, Math.max(150_000, rttSmooth * 3L)) * 1000L;
        while (!recent.isEmpty() && now - recent.peekFirst()[0] > window) recent.pollFirst();
        int standing = Integer.MAX_VALUE;
        for (long[] entry : recent) standing = Math.min(standing, (int) entry[1]);

        queueMicros = Math.max(0, standing - rttMin);

        // While the rate is doubling, that patient window is exactly the wrong instrument: a
        // minimum taken over a seventh of a second is blind for a seventh of a second, and a
        // rate that doubles every round trip is eight times too fast by the time it can see.
        // So the doubling watches the newest measurement on its own and stops the moment one
        // round trip comes back plainly stretched, jitter or not - stopping early costs
        // nothing, because what follows picks up from what the path was measurably carrying.
        if (probing && rttMicros > rttMin + Math.max(2_000, rttMin / 4)) probing = false;
        adjust(now);
    }

    private void adjust(long now) {
        double seconds = Math.max(1e-6, (now - lastUpdateNanos) / 1e9);
        lastUpdateNanos = now;
        double rtt = Math.max(1e-3, rttSmooth / 1e6);

        int wanted;
        if (queueMicros <= FLOOR_MICROS) {
            // Nothing is waiting: either the path is idle or we are well below what it can
            // carry. While that lasts, double each round trip - the only time the rate moves
            // quickly - and afterwards keep climbing steadily. There is no target to compute
            // here: a queue this small is a queue of zero, and a zero has no rate in it.
            if (probing) {
                step(+1, rate * (seconds / rtt));
                return;
            }
            wanted = +1;
        } else {
            if (probing) {
                // the queue has started to build: the doubling has found the path's limit, so
                // fall back to what was actually getting through, not to where we had reached
                probing = false;
                if (delivered > 0) rate = Math.max(MIN_RATE, delivered);
            }
            double queue = queueMicros / 1e6;
            double target = Packet.MAX_DATAGRAM / (AIM_VISIBLE * queue);   // bytes per second
            wanted = rate < target ? +1 : -1;
        }

        if (wanted == direction) {
            sameDirection++;
            if (sameDirection >= 3) velocity = Math.min(velocity * 2, 32);
        } else {
            direction = wanted;
            sameDirection = 0;
            velocity = 1;
        }
        // a packet per round trip, or a fiftieth of the rate if that is larger - on a fast path
        // a single packet is far too small a step to follow the path with - times however fast
        // we are currently moving
        double perRtt = Math.max(Packet.MAX_DATAGRAM / (AIM_VISIBLE * rtt), rate * 0.02);
        perRtt = Math.min(velocity * perRtt, rate * 0.12);     // never more than an eighth a trip
        step(wanted, perRtt * (seconds / rtt));

        // Bracketed by what the path has actually been carrying: never far above it, because
        // the excess would be queue and nothing else, and not far below it either, because
        // the path has just demonstrated it can take that much. The delay signal chooses
        // within the bracket; on a path that jitters, which is most of them, that keeps a
        // measurement error from talking the sender down to a crawl on an idle link.
        if (delivered > 0) {
            rate = Math.min(rate, Math.max(MIN_RATE, (long) (delivered * 1.25)));
            rate = Math.max(rate, Math.min(MAX_RATE, (long) (delivered * 0.8)));
        }
    }

    private void step(int direction, double bytesPerSecond) {
        rate = Math.max(MIN_RATE, Math.min(MAX_RATE, rate + direction * (long) bytesPerSecond));
    }

    /** Bytes per second the sender may put on the wire. */
    public long rate() { return rate; }

    /** How long packets are currently waiting in queues along the path, in microseconds. */
    public int queueMicros() { return queueMicros; }

    public int rttMinMicros() { return rttMin == Integer.MAX_VALUE ? 0 : rttMin; }

    /**
     * Whether speculative work may go out at all. It uses the same path as everything else, so
     * it is allowed only while the queue is far below what the visible traffic tolerates: a
     * guess about where the viewer will look next must never delay where it is looking now.
     */
    public boolean allowsScavenger() {
        if (queueMicros <= FLOOR_MICROS) return true;
        double queue = queueMicros / 1e6;
        return rate < Packet.MAX_DATAGRAM / (AIM_SCAVENGER * queue);
    }

    @Override public String toString() {
        return String.format("%.1f mbit%s, queue %.1f ms, floor %.1f ms, round trip %.1f ms, "
                        + "arriving %.1f mbit, v%.0f",
                rate * 8 / 1e6, probing ? " (probing)" : "", queueMicros / 1000.0,
                rttMinMicros() / 1000.0, rttSmooth / 1000.0, delivered * 8 / 1e6, velocity);
    }
}
