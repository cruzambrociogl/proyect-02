package project2;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.Socket;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;

/**
 * Headless protocol test - proves the whole path works without a browser:
 * HTTP upgrade -> WebSocket handshake -> GREET -> CHART -> GAZE -> TILE frames.
 *
 * The handshake check uses the test vector from RFC 6455 section 1.3: the key
 * "dGhlIHNhbXBsZSBub25jZQ==" must produce accept "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=", so this
 * validates our SHA-1 + base64 against the spec itself rather than against our own code.
 *
 *   java -cp build project2.TestClient [host] [port]
 */
public final class TestClient {

    private static final String RFC_KEY = "dGhlIHNhbXBsZSBub25jZQ==";
    private static final String RFC_EXPECTED_ACCEPT = "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=";

    public static void main(String[] args) throws Exception {
        String host = args.length > 0 ? args[0] : "localhost";
        int port = args.length > 1 ? Integer.parseInt(args[1]) : 8080;
        int failures = 0;

        try (Socket sock = new Socket(host, port)) {
            sock.setSoTimeout(4000);
            OutputStream out = sock.getOutputStream();
            InputStream in = sock.getInputStream();

            // ---- handshake ----
            String request = "GET /project2 HTTP/1.1\r\n"
                    + "Host: " + host + ":" + port + "\r\n"
                    + "Upgrade: websocket\r\n"
                    + "Connection: Upgrade\r\n"
                    + "Sec-WebSocket-Key: " + RFC_KEY + "\r\n"
                    + "Sec-WebSocket-Version: 13\r\n\r\n";
            out.write(request.getBytes(StandardCharsets.ISO_8859_1));
            out.flush();

            String response = readHeaders(in);
            boolean is101 = response.startsWith("HTTP/1.1 101");
            boolean acceptOk = response.contains(RFC_EXPECTED_ACCEPT);
            System.out.println("handshake 101 Switching Protocols : " + pass(is101));
            System.out.println("Sec-WebSocket-Accept matches RFC   : " + pass(acceptOk));
            if (!is101) failures++;
            if (!acceptOk) failures++;

            // ---- GREET + OPEN -> CHART ----
            ByteBuffer greet = msg(Protocol.GREET, 0, 6);
            greet.putShort((short) 1280).putShort((short) 720).putShort((short) 420);
            out.write(maskedFrame(greet.array()));

            String image = args.length > 2 ? args[2] : firstImage(host, port);
            System.out.println("opening image                      : " + image);
            byte[] nameBytes = image.getBytes(StandardCharsets.UTF_8);
            ByteBuffer open = msg(Protocol.OPEN, 0, nameBytes.length);
            open.put(nameBytes);
            out.write(maskedFrame(open.array()));
            out.flush();

            byte[] chart = readFrame(in);
            ByteBuffer cb = ByteBuffer.wrap(chart).order(ByteOrder.BIG_ENDIAN);
            Protocol.Header ch = Protocol.readHeader(cb);
            boolean chartOk = ch != null && ch.type() == Protocol.CHART;
            System.out.println("CHART received                     : " + pass(chartOk));
            if (!chartOk) {
                // Show what the server actually said, otherwise a FAULT looks like a timeout.
                if (ch != null && ch.type() == Protocol.FAULT) {
                    byte[] text = new byte[ch.length()];
                    cb.get(text);
                    System.out.println("   server said: " + new String(text, StandardCharsets.UTF_8));
                } else if (ch != null) {
                    System.out.println("   unexpected message type " + ch.type());
                }
                System.out.println("aborting");
                failures++;
                System.out.println("\n" + failures + " CHECK(S) FAILED");
                System.exit(1);
            }

            int iw = cb.getInt(), ih = cb.getInt();
            int tile = cb.getShort() & 0xFFFF;
            float ratio = cb.getFloat();
            int maxLevel = cb.getShort() & 0xFFFF;
            System.out.printf("   image %dx%d  tile %d  ratio %.2f  maxLevel %d%n",
                    iw, ih, tile, ratio, maxLevel);

            // ---- GAZE at whole-image scale -> TILE stream ----
            float scale = Math.max(iw / 1280f, ih / 720f);
            ByteBuffer gaze = msg(Protocol.GAZE, 1, 16);
            gaze.putFloat(iw / 2f).putFloat(ih / 2f).putFloat(scale)
                .putShort((short) 1280).putShort((short) 720);
            out.write(maskedFrame(gaze.array()));
            out.flush();

            int tiles = 0, bytes = 0;
            try {
                while (tiles < 64) {
                    byte[] frame = readFrame(in);
                    if (frame == null) break;
                    ByteBuffer tb = ByteBuffer.wrap(frame).order(ByteOrder.BIG_ENDIAN);
                    Protocol.Header th = Protocol.readHeader(tb);
                    if (th == null) break;
                    if (th.type() == Protocol.TILE) { tiles++; bytes += frame.length; }
                }
            } catch (java.net.SocketTimeoutException e) {
                // no more tiles for this viewport - expected end of the burst
            }

            boolean tilesOk = tiles > 0;
            System.out.println("TILE frames received               : " + pass(tilesOk));
            System.out.printf("   %d tiles, %.1f KB, avg %.1f KB/tile%n",
                    tiles, bytes / 1024.0, tiles == 0 ? 0 : bytes / 1024.0 / tiles);
            if (!tilesOk) failures++;

            // ---- zoomed-in GAZE should pick a finer ladder level ----
            ByteBuffer zoom = msg(Protocol.GAZE, 2, 16);
            zoom.putFloat(iw / 2f).putFloat(ih / 2f).putFloat(1.7f)
                .putShort((short) 1280).putShort((short) 720);
            out.write(maskedFrame(zoom.array()));
            out.flush();

            int zoomTiles = 0;
            try {
                while (zoomTiles < 64) {
                    byte[] frame = readFrame(in);
                    if (frame == null) break;
                    ByteBuffer tb = ByteBuffer.wrap(frame).order(ByteOrder.BIG_ENDIAN);
                    Protocol.Header th = Protocol.readHeader(tb);
                    if (th != null && th.type() == Protocol.TILE) zoomTiles++;
                }
            } catch (java.net.SocketTimeoutException ignored) { }

            System.out.println("TILEs after zoom-in GAZE           : " + pass(zoomTiles > 0));
            System.out.printf("   %d tiles at scale 1.7%n", zoomTiles);
            if (zoomTiles == 0) failures++;
        }

        System.out.println(failures == 0 ? "\nALL CHECKS PASSED" : "\n" + failures + " CHECK(S) FAILED");
        if (failures > 0) System.exit(1);
    }

    private static String pass(boolean ok) { return ok ? "PASS" : "FAIL"; }

    /** Asks the catalog API for something to open, so the test needs no hard-coded name. */
    private static String firstImage(String host, int port) throws Exception {
        try (Socket s = new Socket(host, port)) {
            s.setSoTimeout(3000);
            s.getOutputStream().write(("GET /api/images HTTP/1.1\r\nHost: " + host
                    + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.ISO_8859_1));
            s.getOutputStream().flush();
            String all = new String(s.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
            int i = all.indexOf("\"name\":\"");
            if (i < 0) throw new IllegalStateException("catalog is empty - put an image in images/");
            return all.substring(i + 8, all.indexOf('"', i + 8));
        }
    }

    private static ByteBuffer msg(int type, int epoch, int len) {
        return Protocol.message(type, epoch, len);
    }

    private static String readHeaders(InputStream in) throws Exception {
        StringBuilder sb = new StringBuilder();
        int state = 0;
        while (state < 4) {
            int c = in.read();
            if (c < 0) break;
            sb.append((char) c);
            state = (c == '\r' && (state == 0 || state == 2)) || (c == '\n' && (state == 1 || state == 3))
                    ? state + 1 : 0;
        }
        return sb.toString();
    }

    /** Client-to-server frames must be masked (RFC 6455 section 5.3). */
    private static byte[] maskedFrame(byte[] payload) {
        byte[] mask = new byte[4];
        new SecureRandom().nextBytes(mask);
        int n = payload.length;
        int headerLen = n < 126 ? 2 : 4;
        byte[] out = new byte[headerLen + 4 + n];
        out[0] = (byte) (0x80 | WebSocketCodec.OP_BINARY);
        if (n < 126) {
            out[1] = (byte) (0x80 | n);
        } else {
            out[1] = (byte) (0x80 | 126);
            out[2] = (byte) (n >> 8);
            out[3] = (byte) n;
        }
        System.arraycopy(mask, 0, out, headerLen, 4);
        for (int i = 0; i < n; i++) out[headerLen + 4 + i] = (byte) (payload[i] ^ mask[i & 3]);
        return out;
    }

    /** Reads one unmasked server frame's payload. */
    private static byte[] readFrame(InputStream in) throws Exception {
        int b0 = in.read();
        if (b0 < 0) return null;
        int b1 = in.read();
        if (b1 < 0) return null;
        long len = b1 & 0x7F;
        if (len == 126) len = ((long) in.read() << 8) | in.read();
        else if (len == 127) { len = 0; for (int i = 0; i < 8; i++) len = (len << 8) | in.read(); }
        byte[] payload = new byte[(int) len];
        int read = 0;
        while (read < payload.length) {
            int n = in.read(payload, read, payload.length - read);
            if (n < 0) return null;
            read += n;
        }
        return payload;
    }

    private TestClient() {}
}
