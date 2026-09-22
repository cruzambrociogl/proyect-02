package project2;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Base64;

/**
 * Minimal RFC 6455 implementation - handshake and frame codec, written by hand.
 *
 * Only what this protocol needs: binary data frames, ping/pong, close. Client-to-server
 * frames are masked (RFC 6455 section 5.3) and must be unmasked; server-to-client frames
 * are never masked.
 */
public final class WebSocketCodec {

    public static final int OP_TEXT = 0x1, OP_BINARY = 0x2, OP_CLOSE = 0x8, OP_PING = 0x9, OP_PONG = 0xA;

    /** The GUID from RFC 6455 section 1.3. */
    private static final String GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

    public record Frame(int opcode, byte[] payload) {}

    public static byte[] handshakeResponse(String clientKey) throws Exception {
        MessageDigest sha1 = MessageDigest.getInstance("SHA-1");
        byte[] digest = sha1.digest((clientKey + GUID).getBytes(StandardCharsets.US_ASCII));
        String accept = Base64.getEncoder().encodeToString(digest);
        String response = "HTTP/1.1 101 Switching Protocols\r\n"
                + "Upgrade: websocket\r\n"
                + "Connection: Upgrade\r\n"
                + "Sec-WebSocket-Accept: " + accept + "\r\n\r\n";
        return response.getBytes(StandardCharsets.ISO_8859_1);
    }

    /**
     * Reads one frame if a complete one is buffered, else returns null leaving the buffer
     * untouched. Assumes unfragmented frames, which is all our client sends.
     */
    public static Frame readFrame(ByteBuffer in) {
        int start = in.position();
        if (in.remaining() < 2) return null;

        int b0 = in.get() & 0xFF;
        int b1 = in.get() & 0xFF;
        int opcode = b0 & 0x0F;
        boolean masked = (b1 & 0x80) != 0;
        long len = b1 & 0x7F;

        if (len == 126) {
            if (in.remaining() < 2) { in.position(start); return null; }
            len = ((in.get() & 0xFFL) << 8) | (in.get() & 0xFFL);
        } else if (len == 127) {
            if (in.remaining() < 8) { in.position(start); return null; }
            len = 0;
            for (int i = 0; i < 8; i++) len = (len << 8) | (in.get() & 0xFFL);
        }
        if (len > Integer.MAX_VALUE) throw new IllegalStateException("frame too large");

        byte[] mask = new byte[4];
        if (masked) {
            if (in.remaining() < 4) { in.position(start); return null; }
            in.get(mask);
        }
        if (in.remaining() < len) { in.position(start); return null; }

        byte[] payload = new byte[(int) len];
        in.get(payload);
        if (masked) for (int i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
        return new Frame(opcode, payload);
    }

    public static byte[] writeFrame(int opcode, byte[] payload) {
        int n = payload.length;
        int header = n < 126 ? 2 : n < 65536 ? 4 : 10;
        byte[] out = new byte[header + n];
        out[0] = (byte) (0x80 | opcode);                 // FIN + opcode
        if (n < 126) {
            out[1] = (byte) n;
        } else if (n < 65536) {
            out[1] = 126;
            out[2] = (byte) (n >> 8);
            out[3] = (byte) n;
        } else {
            out[1] = 127;
            for (int i = 0; i < 8; i++) out[2 + i] = (byte) (n >>> (56 - 8 * i));
        }
        System.arraycopy(payload, 0, out, header, n);
        return out;
    }

    private WebSocketCodec() {}
}
