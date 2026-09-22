package p2.http;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.ByteBuffer;
import java.nio.channels.AsynchronousServerSocketChannel;
import java.nio.channels.AsynchronousSocketChannel;
import java.nio.channels.CompletionHandler;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;

/**
 * Asynchronous HTTP/1.1 server: one proactor loop, no thread per connection.
 *
 * Bodies come in three flavours. Requests with no body are handled as soon as the headers
 * land; small bodies are buffered to {@link #MAX_BUFFERED_BODY}; and routes that accept an
 * upload get the bytes streamed to them as they arrive, so uploading a gigapixel source never
 * needs the server to hold it.
 *
 * A request that asks to upgrade (WebSocket) is handed to {@link Upgrade}, which takes the
 * channel over completely - after that this class stops reading it.
 */
public final class HttpServer {

    public static final int MAX_BUFFERED_BODY = 32 * 1024 * 1024;
    private static final int MAX_HEAD = 64 * 1024;
    private static final int READ_SIZE = 32 * 1024;

    /** Handles a request whose body (if any) is already in memory. */
    public interface Handler {
        Response handle(Request request) throws Exception;
    }

    /** Streams a request body somewhere, a chunk at a time. */
    public interface UploadSink {
        void chunk(ByteBuffer bytes) throws IOException;

        Response finish() throws IOException;

        void abort();
    }

    /** Decides whether a request is an upload, and where its bytes should go. */
    public interface Uploads {
        UploadSink open(Request request) throws IOException;
    }

    /** Takes over a connection that asked to upgrade. Returns true if it did. */
    public interface Upgrade {
        boolean handle(Request request, AsynchronousSocketChannel channel, byte[] leftover);
    }

    private final int port;
    private final Handler handler;
    private final Uploads uploads;
    private final Upgrade upgrade;
    private AsynchronousServerSocketChannel server;

    public HttpServer(int port, Handler handler, Uploads uploads, Upgrade upgrade) {
        this.port = port;
        this.handler = handler;
        this.uploads = uploads;
        this.upgrade = upgrade;
    }

    public void start() throws IOException {
        server = AsynchronousServerSocketChannel.open().bind(new InetSocketAddress(port));
        server.accept(null, new CompletionHandler<AsynchronousSocketChannel, Void>() {
            @Override public void completed(AsynchronousSocketChannel channel, Void attachment) {
                server.accept(null, this);
                new Connection(channel).readMore();
            }

            @Override public void failed(Throwable t, Void attachment) {
                if (server.isOpen()) server.accept(null, this);
            }
        });
    }

    public void stop() throws IOException {
        if (server != null) server.close();
    }

    /** One client connection, driven entirely by completion callbacks. */
    private final class Connection {
        private final AsynchronousSocketChannel channel;
        private final ByteBuffer readBuffer = ByteBuffer.allocate(READ_SIZE);
        private byte[] pending = new byte[0];        // bytes read but not yet consumed
        private Request request;                     // set once the head is parsed
        private UploadSink sink;                     // set for streaming routes
        private long bodyRemaining;

        Connection(AsynchronousSocketChannel channel) {
            this.channel = channel;
        }

        void readMore() {
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
                    try {
                        onBytes(chunk);
                    } catch (Exception e) {
                        fail(e);
                    }
                }

                @Override public void failed(Throwable t, Void attachment) {
                    close();
                }
            });
        }

        private void onBytes(byte[] chunk) throws Exception {
            if (request != null && sink != null) {                       // streaming a body
                int take = (int) Math.min(chunk.length, bodyRemaining);
                sink.chunk(ByteBuffer.wrap(chunk, 0, take));
                bodyRemaining -= take;
                if (bodyRemaining == 0) {
                    Response response = sink.finish();
                    sink = null;
                    finish(response);
                } else {
                    readMore();
                }
                return;
            }

            pending = concat(pending, chunk);
            if (request == null) {
                int end = headEnd(pending);
                if (end < 0) {
                    if (pending.length > MAX_HEAD) {
                        finish(Response.badRequest("headers too large"));
                    } else {
                        readMore();
                    }
                    return;
                }
                String head = new String(pending, 0, end, StandardCharsets.ISO_8859_1);
                byte[] rest = Arrays.copyOfRange(pending, end + 4, pending.length);
                pending = new byte[0];
                request = Request.parse(head);

                if (request.isWebSocketUpgrade() && upgrade != null
                        && upgrade.handle(request, channel, rest)) {
                    return;                                              // the channel is theirs now
                }

                bodyRemaining = request.contentLength();
                sink = uploads == null ? null : uploads.open(request);
                if (sink != null) {
                    int take = (int) Math.min(rest.length, bodyRemaining);
                    if (take > 0) {
                        sink.chunk(ByteBuffer.wrap(rest, 0, take));
                        bodyRemaining -= take;
                    }
                    if (bodyRemaining == 0) {
                        Response response = sink.finish();
                        sink = null;
                        finish(response);
                    } else {
                        readMore();
                    }
                    return;
                }
                pending = rest;
            }

            if (bodyRemaining > MAX_BUFFERED_BODY) {
                finish(Response.text(413, "body too large"));
                return;
            }
            if (pending.length < bodyRemaining) {
                readMore();
                return;
            }
            byte[] body = Arrays.copyOfRange(pending, 0, (int) bodyRemaining);
            byte[] leftover = Arrays.copyOfRange(pending, (int) bodyRemaining, pending.length);
            pending = leftover;
            Request complete = request.withBody(body);
            Response response;
            try {
                response = handler.handle(complete);
            } catch (Exception e) {
                response = Response.error(String.valueOf(e));
                e.printStackTrace();
            }
            finish(response);
        }

        /** Write the response, then either serve the next request or close. */
        private void finish(Response response) {
            boolean keepAlive = request != null && request.keepAlive();
            response.headers.putIfAbsent("Connection", keepAlive ? "keep-alive" : "close");
            ByteBuffer out = ByteBuffer.wrap(response.toBytes());
            request = null;
            bodyRemaining = 0;
            channel.write(out, null, new CompletionHandler<Integer, Void>() {
                @Override public void completed(Integer n, Void attachment) {
                    if (out.hasRemaining()) {
                        channel.write(out, null, this);
                    } else if (keepAlive) {
                        if (pending.length > 0) {
                            byte[] more = pending;
                            pending = new byte[0];
                            try {
                                onBytes(more);
                            } catch (Exception e) {
                                fail(e);
                            }
                        } else {
                            readMore();
                        }
                    } else {
                        close();
                    }
                }

                @Override public void failed(Throwable t, Void attachment) {
                    close();
                }
            });
        }

        private void fail(Exception e) {
            e.printStackTrace();
            if (sink != null) {
                sink.abort();
                sink = null;
            }
            finish(Response.error(String.valueOf(e)));
        }

        private void close() {
            if (sink != null) {
                sink.abort();
                sink = null;
            }
            try {
                channel.close();
            } catch (IOException ignored) {
                // the client is gone; nothing to do
            }
        }
    }

    private static byte[] concat(byte[] a, byte[] b) {
        if (a.length == 0) return b;
        byte[] out = Arrays.copyOf(a, a.length + b.length);
        System.arraycopy(b, 0, out, a.length, b.length);
        return out;
    }

    /** Index of the blank line that ends the head, or -1. */
    private static int headEnd(byte[] data) {
        for (int i = 3; i < data.length; i++) {
            if (data[i] == '\n' && data[i - 1] == '\r' && data[i - 2] == '\n' && data[i - 3] == '\r') {
                return i - 3;
            }
        }
        return -1;
    }
}
