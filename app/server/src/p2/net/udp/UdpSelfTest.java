package p2.net.udp;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.SocketAddress;
import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Random;
import java.util.concurrent.atomic.AtomicBoolean;

import p2.fec.Block;
import p2.fec.MessageCodec;
import p2.net.Wire;

/**
 * Sends one unit across a real UDP socket, over a path that loses, delays, reorders and
 * duplicates packets, and checks it arrives intact.
 *
 *   java -cp server/build p2.net.udp.UdpSelfTest
 *
 * The two halves here are deliberately small: they are not the real sender and receiver, which
 * schedule by deadline and control their rate. They are the least code that exercises the
 * decision this protocol rests on - that a receiver only ever reports a *count* of what it
 * still needs, and the sender answers with fresh symbols rather than with the packets that
 * were lost. If that works under 20% loss and reordering, the rest is scheduling.
 */
public final class UdpSelfTest {

    private static final int UNIT_BYTES = 60_000;
    private static int failures;

    public static void main(String[] args) throws Exception {
        String[] paths = {
                "none",
                "delay=20ms",
                "loss=5%,delay=20ms",
                "loss=20%,delay=30ms,jitter=15ms",
                "loss=10%,delay=20ms,jitter=25ms,reorder=5%,duplicate=2%",
                "loss=5%,delay=20ms,rate=20mbit",
        };
        System.out.printf("%-52s %-9s %-10s %-8s %s%n", "path", "packets", "overhead", "time", "result");
        for (String path : paths) run(path);
        System.out.println(failures == 0 ? "\nall checks passed" : "\n" + failures + " CHECKS FAILED");
        if (failures > 0) System.exit(1);
    }

    private static void run(String setting) throws Exception {
        byte[] unit = new byte[UNIT_BYTES];
        new Random(5).nextBytes(unit);

        // The impairment belongs to the sending side of the path: the server's packets are the
        // ones that matter, and reports travel the clean way back.
        try (UdpEndpoint server = new UdpEndpoint(0, Impairment.parse(setting), "server");
             UdpEndpoint client = new UdpEndpoint(0, Impairment.NONE, "client")) {

            SocketAddress serverAddress = new InetSocketAddress("127.0.0.1", server.port());
            SocketAddress clientAddress = new InetSocketAddress("127.0.0.1", client.port());

            AtomicBoolean done = new AtomicBoolean();
            byte[][] received = new byte[1][];
            List<Report> reports = new ArrayList<>();

            ClientSide side = new ClientSide(client, serverAddress, done, received);
            client.handler(side);
            Thread ticker = new Thread(() -> {
                while (!done.get()) {
                    side.tick();
                    try {
                        Thread.sleep(5);
                    } catch (InterruptedException stop) {
                        return;
                    }
                }
            }, "client-tick");
            ticker.setDaemon(true);
            ticker.start();
            server.handler((from, packet) -> {
                if (Packet.type(packet) == Packet.REPORT) {
                    packet.position(packet.position() + Packet.HEADER);
                    synchronized (reports) { reports.add(Report.readFrom(packet)); }
                }
            });

            long started = System.nanoTime();
            sendUnit(server, clientAddress, unit, reports, done);
            double seconds = (System.nanoTime() - started) / 1e9;

            boolean intact = received[0] != null && Arrays.equals(unit, received[0]);
            int minimum = Block.symbolCount(UNIT_BYTES);
            check(intact, setting + ": the unit arrived intact");
            check(seconds < 20, setting + ": finished in reasonable time");
            System.out.printf("%-52s %-9d %-10s %-8s %s%n", setting, server.packetsSent(),
                    String.format("%.0f%%", 100.0 * (server.packetsSent() - minimum) / minimum),
                    String.format("%.2fs", seconds),
                    intact ? "intact" : "CORRUPT");
        }
    }

    /**
     * The sending half: put the unit's symbols on the wire, then answer each report by sending
     * as many more as it asks for. Note what is missing - no timer per packet, no record of
     * what was sent, nothing to match an acknowledgement against.
     */
    private static void sendUnit(UdpEndpoint server, SocketAddress to, byte[] unit,
                                 List<Report> reports, AtomicBoolean done) throws Exception {
        MessageCodec.Encoder encoder = new MessageCodec.Encoder(unit);
        int[] next = new int[encoder.blocks()];          // the next symbol number to use per block
        ByteBuffer out = Packet.allocate();
        int sequence = 0;
        double loss = 0;

        for (int block = 0; block < encoder.blocks(); block++) {
            int send = encoder.symbolsToSend(block, loss);
            for (int i = 0; i < send; i++) {
                sendSymbol(server, to, out, sequence++, encoder, block, next[block]++, unit.length);
            }
        }

        long deadline = System.currentTimeMillis() + 20_000;
        while (!done.get() && System.currentTimeMillis() < deadline) {
            Thread.sleep(10);
            List<Report> pending;
            synchronized (reports) {
                pending = new ArrayList<>(reports);
                reports.clear();
            }
            for (Report report : pending) {
                loss = report.lossRate();
                for (Report.Need need : report.needs()) {
                    // one extra beyond what was asked for, so a report lost on the way back
                    // does not cost another round trip
                    int send = need.count() + 1 + (int) Math.ceil(need.count() * loss);
                    for (int i = 0; i < send; i++) {
                        sendSymbol(server, to, out, sequence++, encoder,
                                need.block(), next[need.block()]++, unit.length);
                    }
                }
            }
        }
    }

    private static void sendSymbol(UdpEndpoint server, SocketAddress to, ByteBuffer out, int sequence,
                                   MessageCodec.Encoder encoder, int block, int index, int length)
            throws IOException {
        Packet.header(out, Packet.DATA, 1, sequence, Packet.now());
        new Packet.DataHeader(1, 42, length, block, index).writeTo(out);
        out.put(encoder.symbol(block, index));
        out.flip();
        server.send(out, to);
    }

    /**
     * The receiving half: feed every symbol to the decoder and say what is still missing. It
     * never learns or cares which packets were lost.
     *
     * The one rule that is easy to get wrong: a gap is not a loss. While symbols are still
     * arriving, whatever is missing is simply on its way, and a receiver that asks for it
     * doubles the traffic for nothing. So it asks only after the flow has gone quiet for
     * {@link #QUIET_MILLIS}, and then not again until another quiet spell has passed - long
     * enough for an answer to the previous request to have arrived.
     */
    private static final class ClientSide implements UdpEndpoint.Handler {

        private static final long QUIET_MILLIS = 25;
        private final UdpEndpoint client;
        private final SocketAddress server;
        private final AtomicBoolean done;
        private final byte[][] out;
        private MessageCodec.Receiver receiver;
        private int packets, highest, lastMicros;
        private long lastData, lastAsk;

        ClientSide(UdpEndpoint client, SocketAddress server, AtomicBoolean done, byte[][] out) {
            this.client = client;
            this.server = server;
            this.done = done;
            this.out = out;
        }

        @Override public synchronized void packet(SocketAddress from, ByteBuffer packet) {
            if (Packet.type(packet) != Packet.DATA || done.get()) return;
            packets++;
            lastData = System.currentTimeMillis();
            highest = Math.max(highest, Packet.sequence(packet));
            lastMicros = Packet.micros(packet);
            packet.position(packet.position() + Packet.HEADER);
            Packet.DataHeader header = Packet.DataHeader.readFrom(packet);
            if (receiver == null) receiver = new MessageCodec.Receiver(header.length());

            byte[] symbol = new byte[Block.SYMBOL_BYTES];
            packet.get(symbol, 0, Math.min(symbol.length, packet.remaining()));
            receiver.accept(header.block(), header.symbol(), symbol);

            try {
                if (receiver.complete()) {
                    out[0] = receiver.message();
                    done.set(true);
                    finish();
                }
            } catch (IOException problem) {
                System.err.println("client: " + problem);
            }
        }

        /** Called a few times a second, whether or not anything is arriving. */
        synchronized void tick() {
            if (done.get() || receiver == null) return;
            long now = System.currentTimeMillis();
            if (now - lastData < QUIET_MILLIS || now - lastAsk < QUIET_MILLIS) return;
            lastAsk = now;
            try {
                report();
            } catch (IOException problem) {
                System.err.println("client: " + problem);
            }
        }

        private void report() throws IOException {
            int[] missing = receiver.missing();
            List<Report.Need> needs = new ArrayList<>();
            for (int block = 0; block < missing.length; block++) {
                if (missing[block] > 0) needs.add(new Report.Need(42, block, missing[block]));
            }
            Report report = new Report(lastMicros, 0, packets, highest, 8 << 20, 0,
                    needs.size(), false, needs);
            ByteBuffer out = ByteBuffer.allocate(Packet.HEADER + report.bytes());
            Packet.header(out, Packet.REPORT, 1, packets, Packet.now());
            report.writeTo(out);
            out.flip();
            client.send(out, server);
        }

        private void finish() throws IOException {
            ByteBuffer bye = ByteBuffer.allocate(Packet.HEADER);
            Packet.header(bye, Wire.BYE, 1, packets, Packet.now());
            bye.flip();
            client.send(bye, server);
        }
    }

    private static void check(boolean condition, String what) {
        if (!condition) {
            failures++;
            System.out.println("  FAILED: " + what);
        }
    }
}
