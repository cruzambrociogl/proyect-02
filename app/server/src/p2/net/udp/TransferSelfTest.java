package p2.net.udp;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.SocketAddress;
import java.nio.ByteBuffer;
import java.util.Arrays;
import java.util.Random;
import java.util.concurrent.atomic.AtomicInteger;

import p2.fec.Block;

/**
 * The sender and the receiver, on a real socket, over a path that misbehaves.
 *
 *   java -cp server/build p2.net.udp.TransferSelfTest
 *
 * Two hundred units of the size the image method actually produces are handed over as fast as
 * they can be sent, and every one is checked byte for byte at the far end. What the numbers
 * are for: overhead says what the repair symbols cost against the ideal of no loss at all,
 * and the latency says how long a viewer waits for a tile once it has been asked for.
 *
 * The last scenario is the one that matters most for the viewer: half way through, the viewer
 * moves. Everything queued for where it used to be looking should be dropped on the spot
 * rather than finish sending.
 */
public final class TransferSelfTest {

    private static final int UNITS = 200;
    private static int failures;
    private static boolean trace;

    public static void main(String[] args) throws Exception {
        trace = args.length > 0 && args[0].equals("--trace");
        String[] paths = {
                "delay=20ms,rate=50mbit",
                "loss=2%,delay=25ms,jitter=5ms,rate=50mbit",
                "loss=10%,delay=40ms,jitter=15ms,rate=20mbit,reorder=2%",
        };
        System.out.printf("%-46s %-10s %-9s %-9s %-9s %-9s %s%n",
                "path", "delivered", "overhead", "goodput", "latency", "queue", "result");
        for (String path : paths) transfer(path);
        cancellation();
        speculation();
        System.out.println(failures == 0 ? "\nall checks passed" : "\n" + failures + " CHECKS FAILED");
        if (failures > 0) System.exit(1);
    }

    private static void transfer(String setting) throws Exception {
        byte[][] units = new byte[UNITS][];
        long payload = 0;
        for (int i = 0; i < UNITS; i++) {
            Random random = new Random(i);
            units[i] = new byte[8_000 + random.nextInt(82_000)];
            random.nextBytes(units[i]);
            payload += units[i].length;
        }

        try (Pair pair = new Pair(setting, 64 << 20)) {
            long[] offeredAt = new long[UNITS + 1], completedAt = new long[UNITS + 1];
            AtomicInteger intact = new AtomicInteger(), corrupt = new AtomicInteger();
            pair.onMessage((unit, message) -> {
                completedAt[unit] = System.nanoTime();
                if (unit >= 1 && unit <= UNITS && Arrays.equals(units[unit - 1], message)) {
                    intact.incrementAndGet();
                } else {
                    corrupt.incrementAndGet();
                }
            });

            long started = System.nanoTime();
            for (int i = 0; i < UNITS; i++) {
                offeredAt[i + 1] = System.nanoTime();
                pair.sender.offer(units[i], 1, Sender.Class.VISIBLE, 60_000);
            }
            pair.runUntil(() -> intact.get() + corrupt.get() >= UNITS, 30_000);
            double seconds = (System.nanoTime() - started) / 1e9;

            double latency = 0;
            int measured = 0;
            for (int i = 1; i <= UNITS; i++) {
                if (completedAt[i] > 0) {
                    latency += (completedAt[i] - offeredAt[i]) / 1e6;
                    measured++;
                }
            }
            long ideal = 0;
            for (byte[] unit : units) ideal += (long) Block.symbolCount(unit.length) * Packet.MAX_DATAGRAM;

            if (intact.get() + corrupt.get() < UNITS) {
                System.out.printf("  stalled: sender has %d queued, %d delivered, %d dropped; "
                                + "receiver is part way through %d%n",
                        pair.sender.queued(), pair.sender.unitsDelivered(),
                        pair.sender.unitsDropped(), pair.receiver.partial());
            }
            check(corrupt.get() == 0, setting + ": no unit arrived corrupt");
            check(intact.get() == UNITS, setting + ": every unit arrived (" + intact.get() + "/" + UNITS + ")");
            check(pair.sender.control().queueMicros() < 250_000,
                    setting + ": the queue it builds stays small");
            System.out.printf("%-46s %-10s %-9s %-9s %-9s %-9s %s%n", setting,
                    intact.get() + "/" + UNITS,
                    String.format("%.0f%%", 100.0 * (pair.server.bytesSent() - ideal) / ideal),
                    String.format("%.1fmbit", payload * 8 / seconds / 1e6),
                    String.format("%.0fms", measured == 0 ? 0 : latency / measured),
                    String.format("%.0fms", pair.sender.control().queueMicros() / 1000.0),
                    corrupt.get() == 0 && intact.get() == UNITS ? "intact" : "INCOMPLETE");
        }
    }

    /** The viewer moves away: what was queued for the old view should never reach the wire. */
    private static void cancellation() throws Exception {
        System.out.println("\nthe viewer moves away mid-transfer");
        try (Pair pair = new Pair("delay=20ms,rate=10mbit", 64 << 20)) {
            AtomicInteger arrived = new AtomicInteger();
            pair.onMessage((unit, message) -> arrived.incrementAndGet());

            byte[] big = new byte[80_000];
            new Random(3).nextBytes(big);
            for (int i = 0; i < 100; i++) pair.sender.offer(big, 1, Sender.Class.VISIBLE, 10_000);

            pair.runUntil(() -> arrived.get() >= 5, 10_000);
            int whenMoved = arrived.get();
            pair.sender.epoch(2);
            pair.receiver.epoch(2);
            long queued = pair.sender.queued();
            pair.runUntil(() -> false, 400);

            check(queued <= 2, "the queue emptied on the move (left " + queued + ")");
            check(arrived.get() - whenMoved <= 3,
                    "almost nothing from the old view arrived afterwards ("
                            + (arrived.get() - whenMoved) + ")");
            System.out.printf("  %d units sent, then the viewer moved: %d left queued, %d more arrived%n",
                    whenMoved, queued, arrived.get() - whenMoved);
            System.out.printf("  dropped without sending: %d units%n", pair.sender.unitsDropped());
        }
    }

    /**
     * Work sent on a guess must not delay work the viewer is actually waiting for. The same
     * sixty visible units are sent twice: alone, and behind two hundred and forty speculative
     * ones. If the second wait is much longer than the first, the guessing is costing the
     * viewer time, which is the whole reason the speculative class exists.
     */
    private static void speculation() throws Exception {
        System.out.println("\nspeculative work behind visible work");
        byte[] unit = new byte[40_000];
        new Random(9).nextBytes(unit);

        double alone = visibleLatency(unit, 0);
        double behind = visibleLatency(unit, 240);

        check(behind < alone * 1.6, String.format(
                "visible units are not held up by speculation (%.0fms against %.0fms)", behind, alone));
        System.out.printf("  60 visible units alone: %.0fms each%n", alone);
        System.out.printf("  the same 60 with 240 speculative units queued first: %.0fms each%n", behind);
    }

    private static double visibleLatency(byte[] unit, int speculative) throws Exception {
        int visible = 60;
        try (Pair pair = new Pair("delay=30ms,rate=10mbit", 64 << 20)) {
            long[] offeredAt = new long[speculative + visible + 1];
            double[] total = {0};
            AtomicInteger arrived = new AtomicInteger();
            pair.onMessage((id, message) -> {
                if (id > speculative) {
                    total[0] += (System.nanoTime() - offeredAt[id]) / 1e6;
                    arrived.incrementAndGet();
                }
            });
            long now = System.nanoTime();
            for (int i = 1; i <= speculative; i++) {
                offeredAt[i] = now;
                pair.sender.offer(unit, 1, Sender.Class.PREFETCH, 30_000);
            }
            for (int i = speculative + 1; i <= speculative + visible; i++) {
                offeredAt[i] = System.nanoTime();
                pair.sender.offer(unit, 1, Sender.Class.VISIBLE, 30_000);
            }
            pair.runUntil(() -> arrived.get() >= visible, 60_000);
            check(arrived.get() == visible,
                    "every visible unit arrived (" + arrived.get() + "/" + visible + ")");
            return arrived.get() == 0 ? 0 : total[0] / arrived.get();
        }
    }

    /** A server and a client, wired together the way the real ones will be. */
    private static final class Pair implements AutoCloseable {
        final UdpEndpoint server, client;
        final Sender sender;
        final Receiver receiver;
        private final SocketAddress clientAddress, serverAddress;
        private final ByteBuffer out = Packet.allocate();
        private volatile Receiver.Out sink = (unit, message) -> {};
        private int sequence;

        Pair(String impairment, int budget) throws IOException {
            server = new UdpEndpoint(0, Impairment.parse(impairment), "server");
            client = new UdpEndpoint(0, Impairment.NONE, "client");
            clientAddress = new InetSocketAddress("127.0.0.1", client.port());
            serverAddress = new InetSocketAddress("127.0.0.1", server.port());

            receiver = new Receiver((unit, message) -> sink.message(unit, message), budget);
            sender = new Sender((header, data) -> {
                Packet.header(out, Packet.DATA, 1, sequence++, Packet.now());
                header.writeTo(out);
                out.put(data);
                out.flip();
                try {
                    server.send(out, clientAddress);
                } catch (IOException problem) {
                    throw new RuntimeException(problem);
                }
            });

            server.handler((from, packet) -> {
                if (Packet.type(packet) != Packet.REPORT) return;
                packet.position(packet.position() + Packet.HEADER);
                synchronized (sender) { sender.report(Report.readFrom(packet), Packet.now()); }
            });
            client.handler((from, packet) -> {
                if (Packet.type(packet) != Packet.DATA) return;
                int sequenceIn = Packet.sequence(packet), micros = Packet.micros(packet);
                packet.position(packet.position() + Packet.HEADER);
                Packet.DataHeader header = Packet.DataHeader.readFrom(packet);
                byte[] symbol = new byte[Block.SYMBOL_BYTES];
                packet.get(symbol, 0, Math.min(symbol.length, packet.remaining()));
                synchronized (receiver) { receiver.accept(sequenceIn, micros, header, symbol); }
            });
        }

        void onMessage(Receiver.Out sink) {
            this.sink = sink;
        }

        /** Drives both sides until the condition holds or the time runs out. */
        void runUntil(java.util.function.BooleanSupplier until, long millis) throws Exception {
            long deadline = System.currentTimeMillis() + millis;
            long lastReport = 0, lastTrace = 0, traceStarted = System.nanoTime();
            while (System.currentTimeMillis() < deadline && !until.getAsBoolean()) {
                synchronized (sender) { sender.pump(); }
                long now = System.currentTimeMillis();
                if (now - lastReport >= 10) {
                    lastReport = now;
                    Report report;
                    synchronized (receiver) {
                        receiver.rtt(sender.rttMicros());
                        report = receiver.report();
                    }
                    ByteBuffer buffer = ByteBuffer.allocate(Packet.HEADER + report.bytes());
                    Packet.header(buffer, Packet.REPORT, 1, receiver.packets(), Packet.now());
                    report.writeTo(buffer);
                    buffer.flip();
                    client.send(buffer, serverAddress);
                }
                if (trace && now - lastTrace >= 200) {
                    lastTrace = now;
                    System.out.printf("    %5.1fs  %s  queued %d, sent %d%n",
                            (System.nanoTime() - traceStarted) / 1e9, sender.control(),
                            sender.queued(), sender.symbolsSent());
                }
                Thread.sleep(0, 200_000);
            }
        }

        @Override public void close() {
            server.close();
            client.close();
        }
    }

    private static void check(boolean condition, String what) {
        if (!condition) {
            failures++;
            System.out.println("  FAILED: " + what);
        }
    }
}
