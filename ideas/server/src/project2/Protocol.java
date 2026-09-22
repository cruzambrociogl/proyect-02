package project2;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;

/**
 * The Project 2 wire protocol: our own binary messages carried in WebSocket binary frames.
 *
 * Every message starts with a 12-byte header, big-endian (network byte order):
 *
 *     magic 'P' '2' (2) | version (1) | type (1) | epoch (4) | payload length (4)
 *
 * The epoch is how stale work is cancelled: every GAZE the client sends increments it, and
 * the server drops queued tiles from older epochs instead of transmitting views the user
 * has already moved away from.
 */
public final class Protocol {

    public static final byte MAGIC_0 = 'P', MAGIC_1 = '2';
    public static final byte VERSION = 1;
    public static final int HEADER = 12;

    // client -> server
    public static final int GREET = 1;   // screen w,h, tile budget
    public static final int GAZE  = 3;   // centre x,y, scale, viewport w,h
    public static final int OPEN  = 6;   // image name, UTF-8
    public static final int PART  = 9;   // goodbye

    // server -> client
    public static final int CHART = 2;   // image dimensions, tile size, ladder ratio
    public static final int TILE  = 4;   // level, tx, ty, jpeg bytes
    public static final int FAULT = 5;   // error text

    public record Header(int type, int epoch, int length) {}

    public static Header readHeader(ByteBuffer b) {
        b.order(ByteOrder.BIG_ENDIAN);
        if (b.remaining() < HEADER) return null;
        if (b.get() != MAGIC_0 || b.get() != MAGIC_1) throw new IllegalStateException("bad magic");
        b.get();                                   // version, ignored while there is only one
        int type = b.get() & 0xFF;
        int epoch = b.getInt();
        int length = b.getInt();
        return new Header(type, epoch, length);
    }

    /** Allocates a message with the header filled in and the position left at the payload. */
    public static ByteBuffer message(int type, int epoch, int payloadLength) {
        ByteBuffer b = ByteBuffer.allocate(HEADER + payloadLength).order(ByteOrder.BIG_ENDIAN);
        b.put(MAGIC_0).put(MAGIC_1).put(VERSION).put((byte) type);
        b.putInt(epoch).putInt(payloadLength);
        return b;
    }

    private Protocol() {}
}
