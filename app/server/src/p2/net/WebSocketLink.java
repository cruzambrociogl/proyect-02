package p2.net;

import p2.http.Request;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.AsynchronousSocketChannel;
import java.nio.channels.CompletionHandler;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayDeque;
import java.util.Arrays;
import java.util.Base64;
import java.util.Deque;

/**
 * A browser-facing {@link Link}: RFC 6455 WebSocket, written here rather than taken from a
 * library so the whole path stays ours.
 *
 * This is a bridge, not the protocol. TCP underneath already retransmits and controls
 * congestion, so what runs here is the message layer only; the hand-written transport lives
 * over UDP (milestone 3) and the browser reaches it through this bridge.
 *
 * Only what this project needs is implemented: single-frame binary messages both ways,
 * close and ping. Fragmented client messages are rejected - the viewer never sends one.
 */
public final class WebSocketLink implements Link {

    private static final String GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    /** Stop handing the session more once this much is waiting to go out. */
    private static final int QUEUE_LIMIT = 256 * 1024;
    private static final int READ_SIZE = 16 * 1024;

    private final AsynchronousSocketChannel channel;
    private Inbound inbound;
    private final Deque<ByteBuffer> outbox = new ArrayDeque<>();
    private final ByteBuffer readBuffer = ByteBuffer.allocate(READ_SIZE);
    private byte[] pending = new byte[0];
    private boolean writing;
    private boolean closed;
    private int queued;
    private long bytesSent;
    private long messagesSent;

    /**
     * Answer the upgrade request; returns null if it is not a valid WebSocket handshake. The
     * session is built from the link before any frame is read, so a client that sends its
     * first message in the same packet as the handshake is still handled in order.
     */
    public static WebSocketLink accept(Request request, AsynchronousSocketChannel channel,
                                       byte[] leftover, java.util.function.Function<Link, Inbound> session) {
        String key = request.header("sec-websocket-key");
        if (key == null) return null;
        String accept = Base64.getEncoder().encodeToString(sha1(key + GUID));
        String response = "HTTP/1.1 101 Switching Protocols\r\n"
                + "Upgrade: websocket\r\n"
                + "Connection: Upgrade\r\n"
                + "Sec-WebSocket-Accept: " + accept + "\r\n\r\n";
        WebSocketLink link = new WebSocketLink(channel);
        link.inbound = session.apply(link);
        link.writeRaw(ByteBuffer.wrap(response.getBytes(StandardCharsets.ISO_8859_1)));
        if (leftover.length > 0) link.onBytes(leftover);      // frames sent with the handshake
        link.readMore();
        return link;
    }

    private WebSocketLink(AsynchronousSocketChannel channel) {
        this.channel = channel;
    }

    private static byte[] sha1(String s) {
        try {
            return MessageDigest.getInstance("SHA-1").digest(s.getBytes(StandardCharsets.UTF_8));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    // ---------------------------------------------------------------- Link

    @Override
    public synchronized boolean send(byte[] message) {
        if (closed) return false;
        writeRaw(ByteBuffer.wrap(encode(message)));
        bytesSent += message.length;
        messagesSent++;
        return true;
    }

    @Override public synchronized boolean writable() { return !closed && queued < QUEUE_LIMIT; }

    @Override public synchronized long bytesSent() { return bytesSent; }

    @Override public synchronized long messagesSent() { return messagesSent; }

    @Override
    public synchronized void close() {
        if (closed) return;
        closed = true;
        try {
            channel.close();
        } catch (IOException ignored) {
            // already gone
        }
        inbound.closed();
    }

    // ---------------------------------------------------------------- frames out

    /** A server-to-client binary frame: FIN set, opcode 2, never masked. */
    private static byte[] encode(byte[] payload) {
        int n = payload.length;
        int headerLength = n < 126 ? 2 : n <= 0xFFFF ? 4 : 10;
        byte[] frame = new byte[headerLength + n];
        frame[0] = (byte) 0x82;
        if (n < 126) {
            frame[1] = (byte) n;
        } else if (n <= 0xFFFF) {
            frame[1] = 126;
            frame[2] = (byte) (n >>> 8);
            frame[3] = (byte) n;
        } else {
            frame[1] = 127;
            for (int i = 0; i < 8; i++) frame[2 + i] = (byte) (((long) n) >>> (56 - 8 * i));
        }
        System.arraycopy(payload, 0, frame, headerLength, n);
        return frame;
    }

    private synchronized void writeRaw(ByteBuffer buffer) {
        queued += buffer.remaining();
        outbox.add(buffer);
        if (!writing) pumpOut();
    }

    private void pumpOut() {
        ByteBuffer next;
        synchronized (this) {
            next = outbox.peek();
            if (next == null || closed) {
                writing = false;
                return;
            }
            writing = true;
        }
        channel.write(next, null, new CompletionHandler<Integer, Void>() {
            @Override public void completed(Integer written, Void attachment) {
                boolean roomAgain;
                synchronized (WebSocketLink.this) {
                    boolean wasFull = queued >= QUEUE_LIMIT;
                    queued -= written;
                    if (!next.hasRemaining()) outbox.poll();
                    roomAgain = wasFull && queued < QUEUE_LIMIT;
                }
                if (roomAgain) inbound.drained();      // the session can hand over more now
                pumpOut();
            }

            @Override public void failed(Throwable t, Void attachment) {
                close();
            }
        });
    }

    // ---------------------------------------------------------------- frames in

    private void readMore() {
        readBuffer.clear();
        channel.read(readBuffer, null, new CompletionHandler<Integer, Void>() {
            @Override public void completed(Integer n, Void attachment) {
                if (n < 0) {
                    close();
                    return;
                }
                readBuffer.flip();
                byte[] chunk = new byte[readBuffer.remaining()];
                readBuffer.get(chunk);
                onBytes(chunk);
                if (!closed) readMore();
            }

            @Override public void failed(Throwable t, Void attachment) {
                close();
            }
        });
    }

    private void onBytes(byte[] chunk) {
        pending = concat(pending, chunk);
        while (true) {
            int consumed = decodeOne(pending);
            if (consumed <= 0) return;
            pending = Arrays.copyOfRange(pending, consumed, pending.length);
        }
    }

    /** Decode one client frame; returns bytes consumed, or 0 if more are needed. */
    private int decodeOne(byte[] b) {
        if (b.length < 2) return 0;
        boolean fin = (b[0] & 0x80) != 0;
        int opcode = b[0] & 0x0f;
        boolean masked = (b[1] & 0x80) != 0;
        long length = b[1] & 0x7f;
        int at = 2;
        if (length == 126) {
            if (b.length < 4) return 0;
            length = ((b[2] & 0xffL) << 8) | (b[3] & 0xffL);
            at = 4;
        } else if (length == 127) {
            if (b.length < 10) return 0;
            length = 0;
            for (int i = 0; i < 8; i++) length = (length << 8) | (b[2 + i] & 0xffL);
            at = 10;
        }
        byte[] mask = new byte[4];
        if (masked) {
            if (b.length < at + 4) return 0;
            System.arraycopy(b, at, mask, 0, 4);
            at += 4;
        }
        if (length > Integer.MAX_VALUE || b.length < at + length) return 0;

        byte[] payload = Arrays.copyOfRange(b, at, at + (int) length);
        if (masked) {
            for (int i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
        }
        int consumed = at + (int) length;

        switch (opcode) {
            case 0x1, 0x2 -> {
                if (!fin) {                       // the viewer never fragments; refuse politely
                    close();
                    return consumed;
                }
                inbound.message(ByteBuffer.wrap(payload));
            }
            case 0x8 -> close();                                   // close
            case 0x9 -> writeRaw(ByteBuffer.wrap(pong(payload)));  // ping
            default -> { }                                          // pong and anything else: ignore
        }
        return consumed;
    }

    private static byte[] pong(byte[] payload) {
        byte[] frame = new byte[2 + payload.length];
        frame[0] = (byte) 0x8A;
        frame[1] = (byte) payload.length;
        System.arraycopy(payload, 0, frame, 2, payload.length);
        return frame;
    }

    private static byte[] concat(byte[] a, byte[] b) {
        if (a.length == 0) return b;
        byte[] out = Arrays.copyOf(a, a.length + b.length);
        System.arraycopy(b, 0, out, a.length, b.length);
        return out;
    }
}
