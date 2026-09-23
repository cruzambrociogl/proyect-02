package p2.net.udp;

import java.nio.ByteBuffer;
import java.util.Locale;
import java.util.Random;
import java.util.concurrent.DelayQueue;
import java.util.concurrent.Delayed;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

/**
 * A network that misbehaves, on purpose.
 *
 * On a loopback nothing is ever lost, nothing is ever late and nothing arrives out of order,
 * which is the one condition under which this protocol's hard parts - repair symbols,
 * congestion control, deadlines - cannot be seen to work or to fail. So the impairment sits
 * between the socket and the rest of the program from the first day rather than being added
 * once everything else is written, and the same code runs whether it is configured or not.
 *
 * It is described by a string, so a run can be reproduced from a command line:
 *
 *   --impair loss=5%,delay=40ms,jitter=10ms,rate=20mbit,reorder=1%,duplicate=0.5%
 *
 * Delay is one way. Jitter varies it; when jitter is large enough packets genuinely overtake
 * each other, which is the point - a protocol that assumes order is broken by this and ours
 * must not be. The seed is fixed, so two runs with the same setting lose the same packets.
 */
public final class Impairment {

    public static final Impairment NONE = new Impairment(0, 0, 0, 0, 0, 0);

    private final double loss, reorder, duplicate;
    private final int delayMicros, jitterMicros;
    private final long bitsPerSecond;

    private final Random random = new Random(20260923);
    private final DelayQueue<Held> held = new DelayQueue<>();
    private final AtomicLong sequence = new AtomicLong();
    private final AtomicLong dropped = new AtomicLong(), passed = new AtomicLong();
    private long nextFreeMicros;                       // for the rate limit, a token bucket's clock

    private Impairment(double loss, double reorder, double duplicate,
                       int delayMicros, int jitterMicros, long bitsPerSecond) {
        this.loss = loss;
        this.reorder = reorder;
        this.duplicate = duplicate;
        this.delayMicros = delayMicros;
        this.jitterMicros = jitterMicros;
        this.bitsPerSecond = bitsPerSecond;
    }

    public boolean active() {
        return loss > 0 || delayMicros > 0 || jitterMicros > 0 || bitsPerSecond > 0
                || reorder > 0 || duplicate > 0;
    }

    public long dropped() { return dropped.get(); }

    public long passed() { return passed.get(); }

    /**
     * Offers one packet to the emulated path.
     *
     * Returns true if the packet was taken; the packet does not come out here but later, from
     * {@link #due()}, once its delay has run. A copy is taken because the caller reuses its
     * buffer for the next packet.
     */
    public boolean offer(ByteBuffer packet, Object destination) {
        if (!active()) throw new IllegalStateException("an unimpaired path should not queue");
        if (random.nextDouble() < loss) {
            dropped.incrementAndGet();
            return false;
        }
        byte[] copy = new byte[packet.remaining()];
        packet.duplicate().get(copy);

        long wait = delayMicros;
        if (jitterMicros > 0) wait += random.nextInt(jitterMicros * 2 + 1) - jitterMicros;
        if (random.nextDouble() < reorder) wait += delayMicros + jitterMicros + 1_000;
        if (bitsPerSecond > 0) {
            // a queue in front of a narrow pipe: each packet leaves after the one before it.
            // This clock is a plain long, not the wire's wrapping one, because a wrap here
            // would turn into a packet held for the better part of an hour.
            long micros = Math.max(1, copy.length * 8L * 1_000_000L / bitsPerSecond);
            long now = System.nanoTime() / 1000L;
            long start = Math.max(now, nextFreeMicros);
            nextFreeMicros = start + micros;
            wait += (start + micros) - now;
        }
        wait = Math.max(0, wait);

        held.put(new Held(copy, destination, System.nanoTime() + wait * 1000L, sequence.incrementAndGet()));
        if (random.nextDouble() < duplicate) {
            held.put(new Held(copy, destination, System.nanoTime() + (wait + 500) * 1000L,
                    sequence.incrementAndGet()));
        }
        passed.incrementAndGet();
        return true;
    }

    /** The next packet whose delay has run, or null if none is ready within the timeout. */
    public Held due(long timeoutMillis) throws InterruptedException {
        return held.poll(timeoutMillis, TimeUnit.MILLISECONDS);
    }

    /** A packet waiting out its delay. */
    public static final class Held implements Delayed {
        public final byte[] data;
        public final Object destination;
        private final long readyAtNanos;
        private final long order;

        Held(byte[] data, Object destination, long readyAtNanos, long order) {
            this.data = data;
            this.destination = destination;
            this.readyAtNanos = readyAtNanos;
            this.order = order;
        }

        @Override public long getDelay(TimeUnit unit) {
            return unit.convert(readyAtNanos - System.nanoTime(), TimeUnit.NANOSECONDS);
        }

        @Override public int compareTo(Delayed other) {
            if (other instanceof Held that) {
                int byTime = Long.compare(this.readyAtNanos, that.readyAtNanos);
                return byTime != 0 ? byTime : Long.compare(this.order, that.order);
            }
            return Long.compare(getDelay(TimeUnit.NANOSECONDS), other.getDelay(TimeUnit.NANOSECONDS));
        }
    }

    /**
     * Reads a setting such as {@code loss=5%,delay=40ms,jitter=10ms,rate=20mbit}.
     * An empty or missing setting means a perfect path.
     */
    public static Impairment parse(String setting) {
        if (setting == null || setting.isBlank() || setting.equals("none")) return NONE;
        double loss = 0, reorder = 0, duplicate = 0;
        int delay = 0, jitter = 0;
        long rate = 0;
        for (String part : setting.toLowerCase(Locale.ROOT).split(",")) {
            String[] pair = part.trim().split("=", 2);
            if (pair.length != 2) throw new IllegalArgumentException("not a setting: " + part);
            String value = pair[1].trim();
            switch (pair[0].trim()) {
                case "loss" -> loss = fraction(value);
                case "reorder" -> reorder = fraction(value);
                case "duplicate", "dup" -> duplicate = fraction(value);
                case "delay" -> delay = micros(value);
                case "jitter" -> jitter = micros(value);
                case "rate" -> rate = bits(value);
                default -> throw new IllegalArgumentException("unknown setting: " + pair[0]);
            }
        }
        return new Impairment(loss, reorder, duplicate, delay, jitter, rate);
    }

    private static double fraction(String value) {
        return value.endsWith("%")
                ? Double.parseDouble(value.substring(0, value.length() - 1)) / 100.0
                : Double.parseDouble(value);
    }

    private static int micros(String value) {
        if (value.endsWith("ms")) return (int) (Double.parseDouble(value.substring(0, value.length() - 2)) * 1000);
        if (value.endsWith("us")) return Integer.parseInt(value.substring(0, value.length() - 2));
        if (value.endsWith("s")) return (int) (Double.parseDouble(value.substring(0, value.length() - 1)) * 1e6);
        return (int) (Double.parseDouble(value) * 1000);            // bare numbers are milliseconds
    }

    private static long bits(String value) {
        if (value.endsWith("mbit")) return (long) (Double.parseDouble(value.substring(0, value.length() - 4)) * 1_000_000);
        if (value.endsWith("kbit")) return (long) (Double.parseDouble(value.substring(0, value.length() - 4)) * 1_000);
        if (value.endsWith("bit")) return Long.parseLong(value.substring(0, value.length() - 3));
        return Long.parseLong(value);
    }

    @Override public String toString() {
        if (!active()) return "clean path";
        StringBuilder out = new StringBuilder();
        if (loss > 0) out.append(String.format("loss %.1f%% ", loss * 100));
        if (delayMicros > 0) out.append(String.format("delay %.0fms ", delayMicros / 1000.0));
        if (jitterMicros > 0) out.append(String.format("jitter %.0fms ", jitterMicros / 1000.0));
        if (bitsPerSecond > 0) out.append(String.format("rate %.1fmbit ", bitsPerSecond / 1e6));
        if (reorder > 0) out.append(String.format("reorder %.1f%% ", reorder * 100));
        if (duplicate > 0) out.append(String.format("duplicate %.1f%% ", duplicate * 100));
        return out.toString().trim();
    }
}
