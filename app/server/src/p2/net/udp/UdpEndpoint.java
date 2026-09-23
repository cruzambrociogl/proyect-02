package p2.net.udp;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.SocketAddress;
import java.net.StandardSocketOptions;
import java.nio.ByteBuffer;
import java.nio.channels.ClosedChannelException;
import java.nio.channels.DatagramChannel;
import java.util.concurrent.atomic.AtomicLong;

/**
 * One UDP socket, with the emulated path in front of it.
 *
 * Both ends of the protocol use this: the server binds a known port, the client binds any
 * free one. Neither end has a connection in the operating system's sense - there is no accept,
 * no handshake underneath us and nothing that retransmits on our behalf. A packet is either
 * delivered once, or lost, and everything above this class is written knowing that.
 *
 * A single thread receives, so a handler never sees two packets at once and needs no locking
 * of its own. Sending may happen from any thread; when the path is impaired a second thread
 * releases packets as their delay runs out.
 */
public final class UdpEndpoint implements AutoCloseable {

    /** What the protocol above does with an arriving packet. Called on the receive thread. */
    public interface Handler {
        void packet(SocketAddress from, ByteBuffer packet);
    }

    private final DatagramChannel channel;
    private final Impairment path;
    private final Thread receiver;
    private final Thread releaser;
    private volatile boolean running = true;
    private volatile Handler handler = (from, packet) -> {};

    private final AtomicLong packetsSent = new AtomicLong(), bytesSent = new AtomicLong();
    private final AtomicLong packetsReceived = new AtomicLong(), bytesReceived = new AtomicLong();

    public UdpEndpoint(int port, Impairment path, String name) throws IOException {
        this.path = path;
        this.channel = DatagramChannel.open();
        channel.setOption(StandardSocketOptions.SO_RCVBUF, 4 << 20);
        channel.setOption(StandardSocketOptions.SO_SNDBUF, 4 << 20);
        channel.bind(new InetSocketAddress(port));

        this.receiver = new Thread(this::receiveLoop, name + "-receive");
        receiver.setDaemon(true);
        receiver.start();

        if (path.active()) {
            this.releaser = new Thread(this::releaseLoop, name + "-path");
            releaser.setDaemon(true);
            releaser.start();
        } else {
            this.releaser = null;
        }
    }

    public void handler(Handler handler) {
        this.handler = handler;
    }

    public int port() throws IOException {
        return ((InetSocketAddress) channel.getLocalAddress()).getPort();
    }

    /** Sends one packet. The buffer is consumed; nothing is retained after this returns. */
    public void send(ByteBuffer packet, SocketAddress to) throws IOException {
        int length = packet.remaining();
        if (path.active()) {
            // counted whether or not the emulated path keeps it: the sender did spend it
            packetsSent.incrementAndGet();
            bytesSent.addAndGet(length);
            path.offer(packet, to);
            packet.position(packet.limit());
            return;
        }
        int written = channel.send(packet, to);
        if (written > 0) {
            packetsSent.incrementAndGet();
            bytesSent.addAndGet(written);
        }
    }

    public long packetsSent() { return packetsSent.get(); }

    public long bytesSent() { return bytesSent.get(); }

    public long packetsReceived() { return packetsReceived.get(); }

    public long bytesReceived() { return bytesReceived.get(); }

    private void receiveLoop() {
        ByteBuffer buffer = ByteBuffer.allocateDirect(Packet.MAX_DATAGRAM);
        while (running) {
            try {
                buffer.clear();
                SocketAddress from = channel.receive(buffer);
                if (from == null) continue;
                buffer.flip();
                if (!Packet.looksValid(buffer)) continue;          // not ours, or a different version
                packetsReceived.incrementAndGet();
                bytesReceived.addAndGet(buffer.remaining());
                handler.packet(from, buffer);
            } catch (ClosedChannelException closed) {
                return;
            } catch (IOException problem) {
                if (running) System.err.println("udp receive: " + problem);
            } catch (RuntimeException problem) {
                System.err.println("udp handler: " + problem);
            }
        }
    }

    private void releaseLoop() {
        while (running) {
            try {
                Impairment.Held ready = path.due(50);
                if (ready == null) continue;
                channel.send(ByteBuffer.wrap(ready.data), (SocketAddress) ready.destination);
            } catch (InterruptedException stop) {
                return;
            } catch (ClosedChannelException closed) {
                return;
            } catch (IOException problem) {
                if (running) System.err.println("udp send: " + problem);
            }
        }
    }

    @Override public void close() {
        running = false;
        try {
            channel.close();
        } catch (IOException ignored) {
            // closing is best effort; the threads end either way
        }
        if (releaser != null) releaser.interrupt();
        receiver.interrupt();
    }
}
