package p2.net;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;

/**
 * The message format, shared by every transport underneath it.
 *
 * Each message is a 12-byte header followed by a payload:
 *
 *   0  'P'        magic, so a stray connection is rejected immediately
 *   1  '2'
 *   2  version    bumped when the meaning of anything below changes
 *   3  type       one of the constants here
 *   4  epoch      which view this belongs to; the client counts up, the server echoes
 *   8  length     payload bytes that follow
 *
 * The epoch is what makes cancelling cheap: when the viewer moves it raises its epoch, and
 * everything the server had queued for an older epoch is dropped instead of sent. A client
 * that receives a unit from an old epoch can still use it - it is not wrong, only stale.
 *
 * It only ever counts up, for as long as the session lasts - opening a different image does
 * not start it again. Three places read a lower epoch as an older view and throw its units
 * away, so a counter that went back to zero would make every tile of the newly opened image
 * look stale, and the screen would stay black.
 */
public final class Wire {

    public static final byte MAGIC_0 = 'P', MAGIC_1 = '2';
    public static final int VERSION = 1;
    public static final int HEADER = 12;

    /** client -> server: I speak version N. */
    public static final int HELLO = 1;
    /** server -> client: so do I, and here is what I serve. */
    public static final int WELCOME = 2;
    /** client -> server: show me this image (payload: UTF-8 name). */
    public static final int OPEN = 3;
    /** server -> client: this image's shape (payload: JSON). */
    public static final int CHART = 4;
    /** client -> server: this is where I am looking, and what I have dropped. */
    public static final int VIEW = 5;
    /** server -> client: one unit of the image (header below, then its bytes). */
    public static final int UNIT = 6;
    /** server -> client: something went wrong (payload: UTF-8 text). */
    public static final int FAULT = 7;
    /** either way: I am done. */
    public static final int BYE = 8;
    /** server -> client: how this session is going (payload: JSON), for the viewer's panel. */
    public static final int STATS = 9;
    // 10 to 15 are packet types, not message types: see p2.net.udp.Packet.
    /** bridge -> client: what the client's own side of the path sees (payload: JSON). */
    public static final int PATH = 16;

    private Wire() {}

    /** A buffer holding the header, positioned ready for the payload to be appended. */
    public static ByteBuffer message(int type, int epoch, int payloadLength) {
        ByteBuffer b = ByteBuffer.allocate(HEADER + payloadLength);
        b.put(MAGIC_0).put(MAGIC_1).put((byte) VERSION).put((byte) type);
        b.putInt(epoch);
        b.putInt(payloadLength);
        return b;
    }

    public static byte[] text(int type, int epoch, String text) {
        byte[] utf8 = text.getBytes(StandardCharsets.UTF_8);
        return message(type, epoch, utf8.length).put(utf8).array();
    }

    public static boolean looksValid(ByteBuffer b) {
        return b.remaining() >= HEADER && b.get(b.position()) == MAGIC_0
                && b.get(b.position() + 1) == MAGIC_1 && b.get(b.position() + 2) == VERSION;
    }

    public static int type(ByteBuffer b) { return b.get(b.position() + 3) & 0xff; }

    public static int epoch(ByteBuffer b) { return b.getInt(b.position() + 4); }

    public static int length(ByteBuffer b) { return b.getInt(b.position() + 8); }

    /** A UNIT payload starts with where the unit belongs, then the method's own bytes. */
    public static final int UNIT_HEADER = 10;

    public static ByteBuffer unit(int epoch, int level, int x, int y, byte[] payload) {
        ByteBuffer b = message(UNIT, epoch, UNIT_HEADER + payload.length);
        b.putShort((short) level);
        b.putInt(x);
        b.putInt(y);
        b.put(payload);
        return b.flip();
    }
}
