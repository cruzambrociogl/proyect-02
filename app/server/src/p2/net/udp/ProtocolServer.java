package p2.net.udp;

import java.io.IOException;
import java.net.SocketAddress;
import java.nio.ByteBuffer;
import java.util.Iterator;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

import p2.media.Catalog;
import p2.net.Wire;
import p2.session.Session;

/**
 * The image server, speaking our protocol over UDP.
 *
 * There is nothing here that resembles accepting a connection: a session exists because
 * packets are arriving from an address, and stops existing when they stop. Nothing is
 * negotiated, nothing is torn down, and a client that vanishes costs one timeout.
 *
 * What arrives from a viewer is one of two things. A control packet carries a whole message
 * of the ordinary protocol - hello, open this image, this is where I am looking - and is
 * handed to the session layer unchanged, which is why that layer does not know which
 * transport it is running on. A report says what has arrived and what is still wanted, and
 * goes to the sender.
 *
 * Control packets are repeated by the client rather than acknowledged by us. They carry
 * state, not events: the newest view replaces the last one, so a lost one costs the time until
 * the next repeat and nothing else. Sending the same one twice must therefore be harmless,
 * and the duplicate check here makes sure of it.
 */
public final class ProtocolServer implements AutoCloseable {

    /** A viewer that has said nothing for this long is gone. */
    private static final long IDLE_MILLIS = 30_000;

    private final UdpEndpoint endpoint;
    private final Catalog catalog;
    private final Map<SocketAddress, Client> clients = new ConcurrentHashMap<>();
    private final AtomicInteger nextSession = new AtomicInteger(1);
    private final Thread pump;
    private volatile boolean running = true;

    public ProtocolServer(int port, Catalog catalog, Impairment path) throws IOException {
        this.catalog = catalog;
        this.endpoint = new UdpEndpoint(port, path, "p2-udp");
        this.endpoint.handler(this::packet);
        this.pump = new Thread(this::pumpLoop, "p2-udp-pump");
        this.pump.setDaemon(true);
        this.pump.start();
    }

    public int port() throws IOException { return endpoint.port(); }

    public int sessions() { return clients.size(); }

    private void packet(SocketAddress from, ByteBuffer packet) {
        Client client = clients.computeIfAbsent(from, address -> new Client(address));
        client.lastHeardMillis = System.currentTimeMillis();
        int type = Packet.type(packet);
        packet.position(packet.position() + Packet.HEADER);
        switch (type) {
            case Packet.CONTROL -> client.control(packet);
            case Packet.REPORT -> client.report(packet);
            case Wire.BYE -> {
                clients.remove(from);
                client.close();
            }
            default -> { }
        }
    }

    private void pumpLoop() {
        while (running) {
            long now = System.currentTimeMillis();
            for (Iterator<Map.Entry<SocketAddress, Client>> it = clients.entrySet().iterator();
                 it.hasNext(); ) {
                Client client = it.next().getValue();
                if (now - client.lastHeardMillis > IDLE_MILLIS) {
                    it.remove();
                    client.close();
                    continue;
                }
                client.pump();
            }
            try {
                Thread.sleep(0, 200_000);
            } catch (InterruptedException stop) {
                return;
            }
        }
    }

    @Override
    public void close() {
        running = false;
        pump.interrupt();
        endpoint.close();
    }

    /** One viewer: its sender, its session, and the packets it has most recently sent us. */
    private final class Client {
        private final SocketAddress address;
        private final int session = nextSession.getAndIncrement();
        private final Sender sender;
        private final SenderLink link;
        private final Session layer;
        private final ByteBuffer out = Packet.allocate();
        private int sequence;
        private final Map<Integer, byte[]> lastControl = new java.util.HashMap<>();
        private final Map<Integer, Long> lastControlMillis = new java.util.HashMap<>();
        volatile long lastHeardMillis = System.currentTimeMillis();

        Client(SocketAddress address) {
            this.address = address;
            this.sender = new Sender(this::write);
            this.link = new SenderLink(sender, () -> clients.remove(address));
            this.layer = new Session(catalog, link);
            this.link.inbound(layer);
        }

        /** Called by the sender, already holding this client's lock. */
        private void write(Packet.DataHeader header, byte[] data) {
            Packet.header(out, Packet.DATA, session, sequence++, Packet.now());
            header.writeTo(out);
            out.put(data);
            out.flip();
            try {
                endpoint.send(out, address);
            } catch (IOException problem) {
                System.err.println("udp send to " + address + ": " + problem);
            }
        }

        void control(ByteBuffer payload) {
            byte[] message = new byte[payload.remaining()];
            payload.duplicate().get(message);
            ByteBuffer header = ByteBuffer.wrap(message);
            if (!Wire.looksValid(header)) return;
            int type = Wire.type(header);
            long now = System.currentTimeMillis();
            synchronized (this) {
                // The same message again means the client did not hear our answer, not that
                // anything changed, so acting on it again would only rebuild a queue that is
                // already right. Each kind is remembered separately: the client repeats them
                // in a cycle, so comparing against whatever came last would find a difference
                // every time and act on all of them, for ever. After a second we do act on a
                // repeat anyway, in case it was our answer that was lost.
                byte[] previous = lastControl.get(type);
                long when = lastControlMillis.getOrDefault(type, 0L);
                if (java.util.Arrays.equals(message, previous) && now - when < 1_000) return;
                lastControl.put(type, message);
                lastControlMillis.put(type, now);
                layer.message(ByteBuffer.wrap(message));
            }
        }

        void report(ByteBuffer payload) {
            Report report = Report.readFrom(payload);
            synchronized (this) {
                sender.report(report, Packet.now());
                layer.drained();                        // room on the wire: offer the next units
            }
        }

        void pump() {
            synchronized (this) {
                sender.pump();
            }
        }

        void close() {
            synchronized (this) {
                layer.closed();
            }
        }
    }
}
