package project2;

import java.io.BufferedOutputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.URLDecoder;
import java.nio.ByteBuffer;
import java.nio.channels.AsynchronousServerSocketChannel;
import java.nio.channels.AsynchronousSocketChannel;
import java.nio.channels.CompletionHandler;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayDeque;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Asynchronous HTTP server (proactor pattern, AsynchronousServerSocketChannel).
 *
 * Serves the static frontend, a small JSON API for the image catalog and uploads, and
 * upgrades /project2 to a WebSocket carrying our own binary image protocol. No third-party
 * code - the project is graded offline, so everything here is hand-written.
 */
public final class HttpServer {

    /**
     * Uploads stream to disk as bytes arrive, so size is bounded by the filesystem rather
     * than by heap. This guard only rejects absurd Content-Length values.
     */
    private static final long MAX_UPLOAD = 64L * 1024 * 1024 * 1024;

    private final int port;
    private final Path webRoot;
    private final ImageRegistry registry;
    private final AtomicInteger sessions = new AtomicInteger();

    private static final Map<String, String> MIME = new HashMap<>();
    static {
        MIME.put("html", "text/html; charset=utf-8");
        MIME.put("js", "application/javascript; charset=utf-8");
        MIME.put("css", "text/css; charset=utf-8");
        MIME.put("png", "image/png");
        MIME.put("jpg", "image/jpeg");
        MIME.put("tif", "image/tiff");
        MIME.put("tiff", "image/tiff");
        MIME.put("ico", "image/x-icon");
    }

    public HttpServer(int port, Path webRoot, ImageRegistry registry) {
        this.port = port;
        this.webRoot = webRoot;
        this.registry = registry;
    }

    public void start() throws IOException {
        AsynchronousServerSocketChannel server = AsynchronousServerSocketChannel.open()
                .bind(new InetSocketAddress(port));
        server.accept(null, new CompletionHandler<AsynchronousSocketChannel, Void>() {
            @Override public void completed(AsynchronousSocketChannel ch, Void att) {
                server.accept(null, this);
                new Conn(ch).readMore();
            }
            @Override public void failed(Throwable t, Void att) {
                System.err.println("accept failed: " + t);
                server.accept(null, this);
            }
        });
    }

    private final class Conn {
        private final AsynchronousSocketChannel ch;
        private ByteBuffer in = ByteBuffer.allocate(64 * 1024);
        private final ArrayDeque<ByteBuffer> outQueue = new ArrayDeque<>();
        private boolean writing = false;
        private boolean upgraded = false;
        private Session session;

        // In-flight upload being written straight to disk.
        private OutputStream uploadOut;
        private long uploadRemaining, uploadTotal;
        private String uploadName;

        Conn(AsynchronousSocketChannel ch) { this.ch = ch; }

        void readMore() {
            ch.read(in, null, new CompletionHandler<Integer, Void>() {
                @Override public void completed(Integer n, Void att) {
                    if (n < 0) { close(); return; }
                    in.flip();
                    try {
                        if (uploadOut != null) drainUpload();
                        else if (upgraded) drainFrames();
                        else tryHttp();
                    } catch (Exception e) {
                        System.err.println("connection error: " + e);
                        close();
                        return;
                    }
                    in.compact();
                    if (in.remaining() == 0) grow();
                    readMore();
                }
                @Override public void failed(Throwable t, Void att) { close(); }
            });
        }

        private void grow() {
            // Bodies no longer accumulate here, so this only ever needs to hold headers or
            // one WebSocket frame. The ceiling stops a malformed request eating the heap.
            ByteBuffer bigger = ByteBuffer.allocate(Math.min(in.capacity() * 2, 8 << 20));
            in.flip();
            bigger.put(in);
            in = bigger;
        }

        // ------------------------------------------------------------------ HTTP

        private void tryHttp() throws Exception {
            // Peek without consuming: a request is only dispatched once headers AND body
            // are fully buffered, otherwise we wait for more bytes.
            String text = StandardCharsets.ISO_8859_1.decode(in.duplicate()).toString();
            int end = text.indexOf("\r\n\r\n");
            if (end < 0) return;

            String[] lines = text.substring(0, end).split("\r\n");
            String[] request = lines[0].split(" ");
            if (request.length < 2) { close(); return; }
            String method = request[0], target = request[1];

            Map<String, String> headers = new HashMap<>();
            for (int i = 1; i < lines.length; i++) {
                int c = lines[i].indexOf(':');
                if (c > 0) headers.put(lines[i].substring(0, c).trim().toLowerCase(),
                        lines[i].substring(c + 1).trim());
            }

            long contentLength = headers.containsKey("content-length")
                    ? Long.parseLong(headers.get("content-length").trim()) : 0;
            if (contentLength > MAX_UPLOAD) {
                sendSimple(413, "text/plain", "upload too large".getBytes());
                close();
                return;
            }

            // Uploads are streamed to disk chunk by chunk: a gigapixel source runs to tens of
            // gigabytes and must never be held in memory. Every other request is small, so
            // those still wait for the whole body.
            if (target.startsWith("/api/upload") && method.equals("POST")) {
                in.position(in.position() + end + 4);
                startUpload(target, contentLength);
                if (uploadOut != null) drainUpload();
                return;
            }

            if (in.remaining() < end + 4 + contentLength) return;      // body still arriving

            in.position(in.position() + end + 4);
            byte[] body = new byte[(int) contentLength];
            if (contentLength > 0) in.get(body);

            if (target.equals("/project2") && "websocket".equalsIgnoreCase(headers.get("upgrade"))) {
                String key = headers.get("sec-websocket-key");
                if (key == null) { sendSimple(400, "text/plain", "missing key".getBytes()); return; }
                send(ByteBuffer.wrap(WebSocketCodec.handshakeResponse(key)));
                upgraded = true;
                session = new Session(registry, sessions.incrementAndGet(), this::sendFrame);
                System.out.printf("session %d connected%n", session.id());
                // First frames often share the handshake's TCP segment; waiting for the next
                // read would deadlock a client that sends GREET then waits for CHART.
                drainFrames();
                return;
            }

            if (target.equals("/api/images") && method.equals("GET")) { sendCatalog(); return; }
            if (!method.equals("GET")) { sendSimple(405, "text/plain", "method not allowed".getBytes()); return; }

            serveStatic(target);
        }

        private void sendCatalog() {
            List<ImageRegistry.Entry> list = registry.list();
            StringBuilder json = new StringBuilder("[");
            for (int i = 0; i < list.size(); i++) {
                ImageRegistry.Entry e = list.get(i);
                if (i > 0) json.append(',');
                json.append("{\"name\":\"").append(escape(e.name()))
                        .append("\",\"width\":").append(e.width())
                        .append(",\"height\":").append(e.height())
                        .append(",\"bytes\":").append(e.bytes())
                        .append(",\"ready\":").append(e.ready()).append('}');
            }
            json.append(']');
            sendSimple(200, "application/json; charset=utf-8", json.toString().getBytes(StandardCharsets.UTF_8));
        }

        /** POST /api/upload?name=foo.tif with the raw file as the body, streamed to disk. */
        private void startUpload(String target, long contentLength) {
            try {
                int q = target.indexOf("?name=");
                if (q < 0) throw new IllegalArgumentException("missing name");
                String name = ImageRegistry.sanitize(
                        URLDecoder.decode(target.substring(q + 6), StandardCharsets.UTF_8));
                if (contentLength <= 0) throw new IllegalArgumentException("empty body");

                Path dest = registry.directory().resolve(name);
                uploadOut = new BufferedOutputStream(new FileOutputStream(dest.toFile()), 1 << 20);
                uploadName = name;
                uploadRemaining = contentLength;
                uploadTotal = contentLength;
                System.out.printf("receiving %s (%.1f MB)…%n", name, contentLength / 1048576.0);
            } catch (Exception e) {
                sendSimple(400, "application/json; charset=utf-8",
                        ("{\"ok\":false,\"error\":\"" + escape(String.valueOf(e.getMessage())) + "\"}")
                                .getBytes(StandardCharsets.UTF_8));
                close();   // the body is still coming and we have nowhere to put it
            }
        }

        /** Writes whatever body bytes are buffered, finishing when the last one lands. */
        private void drainUpload() throws IOException {
            int n = (int) Math.min(in.remaining(), uploadRemaining);
            if (n > 0) {
                byte[] chunk = new byte[n];
                in.get(chunk);
                uploadOut.write(chunk);
                uploadRemaining -= n;
            }
            if (uploadRemaining > 0) return;

            uploadOut.close();
            uploadOut = null;
            System.out.printf("uploaded %s (%.1f MB)%n", uploadName, uploadTotal / 1048576.0);
            sendSimple(200, "application/json; charset=utf-8",
                    ("{\"ok\":true,\"name\":\"" + escape(uploadName) + "\"}").getBytes(StandardCharsets.UTF_8));
        }

        private void serveStatic(String target) throws IOException {
            String path = target.contains("?") ? target.substring(0, target.indexOf('?')) : target;
            String rel = path.equals("/") ? "index.html" : path.substring(1);
            Path file = webRoot.resolve(rel).normalize();
            if (!file.startsWith(webRoot) || !Files.isRegularFile(file)) {
                sendSimple(404, "text/plain", "not found".getBytes());
                return;
            }
            String ext = rel.contains(".") ? rel.substring(rel.lastIndexOf('.') + 1) : "";
            sendSimple(200, MIME.getOrDefault(ext, "application/octet-stream"), Files.readAllBytes(file));
        }

        private void sendSimple(int status, String type, byte[] body) {
            String reason = switch (status) {
                case 200 -> "OK";
                case 400 -> "Bad Request";
                case 404 -> "Not Found";
                case 405 -> "Method Not Allowed";
                case 413 -> "Payload Too Large";
                default -> "Error";
            };
            String head = "HTTP/1.1 " + status + " " + reason + "\r\n"
                    + "Content-Type: " + type + "\r\n"
                    + "Content-Length: " + body.length + "\r\n"
                    + "Cache-Control: no-store\r\n\r\n";
            ByteBuffer buf = ByteBuffer.allocate(head.length() + body.length);
            buf.put(head.getBytes(StandardCharsets.ISO_8859_1)).put(body).flip();
            send(buf);
        }

        private static String escape(String s) {
            return s.replace("\\", "\\\\").replace("\"", "\\\"");
        }

        // ------------------------------------------------------------- WebSocket

        private void drainFrames() throws Exception {
            while (true) {
                WebSocketCodec.Frame f = WebSocketCodec.readFrame(in);
                if (f == null) return;
                switch (f.opcode()) {
                    case WebSocketCodec.OP_BINARY -> session.onMessage(ByteBuffer.wrap(f.payload()));
                    case WebSocketCodec.OP_PING -> sendFrame(WebSocketCodec.OP_PONG, f.payload());
                    case WebSocketCodec.OP_CLOSE -> { close(); return; }
                    default -> { }
                }
            }
        }

        void sendFrame(int opcode, byte[] payload) {
            send(ByteBuffer.wrap(WebSocketCodec.writeFrame(opcode, payload)));
        }

        // ----------------------------------------------------------------- writes

        private void send(ByteBuffer buf) {
            synchronized (outQueue) {
                outQueue.add(buf);
                if (writing) return;
                writing = true;
            }
            pump();
        }

        private void pump() {
            ByteBuffer next;
            synchronized (outQueue) {
                next = outQueue.poll();
                if (next == null) { writing = false; return; }
            }
            ch.write(next, null, new CompletionHandler<Integer, Void>() {
                @Override public void completed(Integer n, Void att) {
                    if (next.hasRemaining()) ch.write(next, null, this);
                    else pump();
                }
                @Override public void failed(Throwable t, Void att) { close(); }
            });
        }

        private void close() {
            try { ch.close(); } catch (IOException ignored) { }
            if (session != null) System.out.printf("session %d disconnected%n", session.id());
        }
    }
}
