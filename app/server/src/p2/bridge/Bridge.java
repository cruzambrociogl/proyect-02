package p2.bridge;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.SocketAddress;
import java.nio.ByteBuffer;
import java.util.LinkedHashMap;
import java.util.Map;

import p2.net.Link;
import p2.net.Wire;
import p2.net.udp.Impairment;
import p2.net.udp.Packet;
import p2.net.udp.Receiver;
import p2.net.udp.Report;
import p2.net.udp.UdpEndpoint;
import p2.util.Json;

/**
 * The half of the protocol that runs next to the viewer.
 *
 * A browser cannot open a UDP socket, so it cannot be the client of this protocol; it can only
 * be the screen. The client is this class: it holds its own socket, speaks the protocol to the
 * server, rebuilds units from the symbols that arrive, and hands the finished messages to the
 * browser over the WebSocket it is already connected by. In the other direction it passes the
 * viewer's own messages - hello, open, this is where I am looking - through to the server.
 *
 * It can run anywhere: beside the server, as it does now, or on the viewer's own machine, with
 * the browser talking to it over the loopback. Nothing about the protocol changes either way,
 * which is the point of putting it here rather than in the page.
 *
 * Two habits make it robust without a single acknowledgement. It repeats its latest control
 * message a few times a second - those messages carry state, so repeating one is free and a
 * lost one costs a fraction of a second. And it reports a few times a second what has arrived
 * and what is still missing, so the server can measure the path and answer what is wanted.
 */
public final class Bridge implements Link.Inbound {

    /** How often the client says what it has and what it wants. */
    private static final long REPORT_MILLIS = 10;

    /** How often it repeats where the viewer is looking, in case a packet was lost. */
    private static final long REPEAT_MILLIS = 150;

    /** How often the viewer's panel is told about the path. */
    private static final long PATH_MILLIS = 250;

    /** How much of a part-built image the client will hold at once. */
    private static final int MEMORY_BUDGET = 32 << 20;

    private final Link browser;
    private final UdpEndpoint endpoint;
    private final SocketAddress server;
    private final Receiver receiver;
    private final Thread ticker;
    private final ByteBuffer out = Packet.allocate();

    private volatile boolean running = true;
    private byte[] hello, open, view;                  // the state worth repeating, newest wins
    private int epoch;
    private int sequence;
    private long unitsForwarded;

    public Bridge(Link browser, int serverPort, Impairment path) throws IOException {
        this.browser = browser;
        this.server = new InetSocketAddress("127.0.0.1", serverPort);
        this.endpoint = new UdpEndpoint(0, path, "p2-bridge");
        this.receiver = new Receiver(this::rebuilt, MEMORY_BUDGET);
        this.endpoint.handler(this::packet);
        this.ticker = new Thread(this::tick, "p2-bridge-tick");
        this.ticker.setDaemon(true);
        this.ticker.start();
    }

    // ---------------------------------------------------------------- from the browser

    /**
     * A message from the viewer. It goes straight through: the bridge does not interpret the
     * protocol, it carries it. The one thing it reads is the epoch, because a viewer that has
     * moved should not be handed units it asked for before it moved - they can be dropped here
     * rather than decoded and thrown away in the page.
     */
    @Override
    public void message(ByteBuffer message) {
        try {
            carry(message);
        } catch (RuntimeException problem) {
            // This runs on the socket's own thread. An exception that escapes here kills that
            // thread, and with it the session: no more messages in either direction, a viewer
            // frozen half drawn with no error anywhere. One bad message is worth a line in the
            // log, not the connection.
            System.err.println("bridge: could not carry a message: " + problem);
        }
    }

    private void carry(ByteBuffer message) {
        byte[] bytes = new byte[message.remaining()];
        message.duplicate().get(bytes);
        ByteBuffer header = ByteBuffer.wrap(bytes);
        if (!Wire.looksValid(header)) return;

        switch (Wire.type(header)) {
            case Wire.HELLO -> hello = bytes;
            case Wire.OPEN -> open = bytes;
            case Wire.VIEW -> {
                view = bytes;
                int viewEpoch = Wire.epoch(header);
                if (viewEpoch > epoch) {
                    epoch = viewEpoch;
                    synchronized (receiver) { receiver.epoch(viewEpoch); }
                }
            }
            case Wire.BYE -> {
                send(Wire.BYE, new byte[0]);
                close();
                return;
            }
            default -> { }
        }
        send(Packet.CONTROL, bytes);
    }

    @Override
    public void closed() {
        close();
    }

    // ---------------------------------------------------------------- from the server

    private void packet(SocketAddress from, ByteBuffer packet) {
        if (Packet.type(packet) != Packet.DATA) return;
        int sequenceIn = Packet.sequence(packet), micros = Packet.micros(packet);
        packet.position(packet.position() + Packet.HEADER);
        Packet.DataHeader header = Packet.DataHeader.readFrom(packet);
        byte[] symbol = new byte[p2.fec.Block.SYMBOL_BYTES];
        packet.get(symbol, 0, Math.min(symbol.length, packet.remaining()));
        synchronized (receiver) {
            receiver.accept(sequenceIn, micros, header, symbol);
        }
    }

    /**
     * One whole message, rebuilt from its symbols: hand it to the page unchanged.
     *
     * The answers also say what no longer needs repeating. Once the server has said hello, or
     * described the image, the question behind it has been answered and asking again would
     * only make it answer twice.
     */
    private void rebuilt(int unit, byte[] message) {
        unitsForwarded++;
        ByteBuffer header = ByteBuffer.wrap(message);
        if (Wire.looksValid(header)) {
            switch (Wire.type(header)) {
                case Wire.WELCOME -> hello = null;
                case Wire.CHART -> open = null;
                default -> { }
            }
        }
        browser.send(message);
    }

    // ---------------------------------------------------------------- the clock

    private void tick() {
        long lastReport = 0, lastRepeat = 0, lastPath = 0;
        while (running) {
            long now = System.currentTimeMillis();
            try {
                if (now - lastReport >= REPORT_MILLIS) {
                    lastReport = now;
                    Report report;
                    synchronized (receiver) { report = receiver.report(); }
                    ByteBuffer buffer = ByteBuffer.allocate(Packet.HEADER + report.bytes());
                    Packet.header(buffer, Packet.REPORT, 0, nextSequence(), Packet.now());
                    report.writeTo(buffer);
                    buffer.flip();
                    endpoint.send(buffer, server);
                }
                if (now - lastRepeat >= REPEAT_MILLIS) {
                    lastRepeat = now;
                    repeat();
                }
                if (now - lastPath >= PATH_MILLIS) {
                    lastPath = now;
                    browser.send(Wire.text(Wire.PATH, epoch, Json.write(path())));
                }
                Thread.sleep(2);
            } catch (InterruptedException stop) {
                return;
            } catch (IOException | RuntimeException problem) {
                System.err.println("bridge: " + problem);   // one bad turn, not the end of the clock
            }
        }
    }

    /**
     * Say again what the viewer wants. Whichever of these was lost, saying it again puts the
     * server back in step - there is nothing to work out, because each of them describes how
     * things are rather than something that happened.
     */
    private void repeat() {
        if (hello != null) send(Packet.CONTROL, hello);
        if (open != null) send(Packet.CONTROL, open);
        if (view != null) send(Packet.CONTROL, view);
    }

    /** What this side of the path can see, for the viewer's panel. */
    private Map<String, Object> path() {
        Map<String, Object> out = new LinkedHashMap<>();
        synchronized (receiver) {
            out.put("packetsIn", endpoint.packetsReceived());
            out.put("packetsOut", endpoint.packetsSent());
            out.put("bytesIn", endpoint.bytesReceived());
            out.put("unitsRebuilt", receiver.unitsComplete());
            out.put("unitsPartial", receiver.partial());
            out.put("unitsStale", receiver.unitsStale());
            out.put("symbolsWasted", receiver.symbolsUseless());
            out.put("unitsForwarded", unitsForwarded);
        }
        return out;
    }

    private synchronized int nextSequence() {
        return sequence++;
    }

    /** Synchronised because the browser's thread and the clock's both send from here. */
    private synchronized void send(int type, byte[] payload) {
        if (Packet.HEADER + payload.length > Packet.MAX_DATAGRAM) {
            // One message, one datagram - so a control message that does not fit is a fault in
            // whatever built it. Saying so is better than throwing: this used to escape and
            // take the thread with it whenever a viewer dropped enough tiles at once to make
            // its next view message too long.
            System.err.println("bridge: a control message of " + payload.length
                    + " bytes does not fit in a datagram, so it was not sent");
            return;
        }
        try {
            Packet.header(out, type, 0, sequence++, Packet.now());
            out.put(payload);
            out.flip();
            endpoint.send(out, server);
        } catch (IOException problem) {
            System.err.println("bridge: " + problem);
        }
    }

    private void close() {
        if (!running) return;
        running = false;
        ticker.interrupt();
        endpoint.close();
        browser.close();
    }
}
