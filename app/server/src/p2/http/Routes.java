package p2.http;

import p2.media.Catalog;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * What the server answers over HTTP: the two pages, their static files, the catalog API, and
 * image uploads. Tiles do not travel over HTTP - they belong to the protocol.
 */
public final class Routes implements HttpServer.Handler, HttpServer.Uploads {

    /** Accept sources up to this size; a gigapixel TIFF is comfortably under it. */
    /**
     * As big as anything anyone is going to look at. The images this is meant for run to
     * ninety gigabytes, so the limit is not the interesting constraint - the disk is, and
     * that is checked separately and said out loud.
     */
    private static final long MAX_UPLOAD = 128L * 1024 * 1024 * 1024;

    /** Room to leave behind on the disk after an upload, so the machine still works. */
    private static final long KEEP_FREE = 2L * 1024 * 1024 * 1024;

    private final Catalog catalog;
    private final Path webRoot;
    private final int udpPort;

    public Routes(Catalog catalog, Path webRoot, int udpPort) {
        this.catalog = catalog;
        this.webRoot = webRoot;
        this.udpPort = udpPort;
    }

    @Override
    public Response handle(Request request) throws Exception {
        Response response = route(request);
        System.out.printf("%s %s%s -> %d%n", request.method(), request.path(),
                request.query().isEmpty() ? "" : "?" + request.query(), response.status);
        return response;
    }

    private Response route(Request request) throws Exception {
        String path = request.path();
        if (path.equals("/")) return page("admin/index.html");
        if (path.equals("/viewer") || path.equals("/viewer/")) return page("viewer/index.html");

        if (path.startsWith("/api/")) return api(request, path.substring(5));

        return staticFile(path.substring(1));
    }

    // ---------------------------------------------------------------- API

    private Response api(Request request, String rest) throws IOException {
        if (rest.equals("status")) {
            return Response.json(Map.of(
                    "images", catalog.root().toString(),
                    "method", catalog.method().id(),
                    "udpPort", udpPort));
        }
        if (rest.equals("images")) {
            return Response.json(Map.of("images", catalog.describeAll(), "method", catalog.method().id()));
        }
        if (rest.startsWith("images/")) {
            String tail = rest.substring("images/".length());
            int slash = tail.indexOf('/');
            String name = slash < 0 ? tail : tail.substring(0, slash);
            String action = slash < 0 ? "" : tail.substring(slash + 1);
            if (!catalog.has(name)) return Response.notFound(name);

            return switch (action) {
                case "" -> Response.json(catalog.describe(name));
                case "preview.jpg" -> catalog.preview(name)
                        .map(p -> {
                            try {
                                return Response.file(p);
                            } catch (IOException e) {
                                return Response.error(String.valueOf(e));
                            }
                        })
                        .orElseGet(() -> Response.notFound("preview of " + name));
                case "prepare" -> {
                    if (!request.method().equals("POST")) yield Response.text(405, "use POST");
                    boolean started = catalog.prepare(name);
                    yield Response.json(Map.of("started", started, "image", catalog.describe(name)));
                }
                default -> Response.notFound(action);
            };
        }
        return Response.notFound(rest);
    }

    /** Bytes as somebody would say them. */
    private static String size(long bytes) {
        if (bytes >= 1L << 30) return String.format("%.1f GB", bytes / (double) (1L << 30));
        if (bytes >= 1L << 20) return String.format("%.0f MB", bytes / (double) (1L << 20));
        return bytes + " bytes";
    }

    // ---------------------------------------------------------------- uploads

    @Override
    public HttpServer.UploadSink open(Request request) throws IOException {
        if (!request.method().equals("POST") || !request.path().equals("/api/upload")) return null;
        String name = request.query().get("name");
        if (name == null || name.isBlank() || name.contains("/") || name.contains("\\")) {
            throw new IOException("upload needs a ?name= with no path separators");
        }
        if (request.contentLength() > MAX_UPLOAD) {
            throw new IOException(String.format("upload of %s is beyond the %s limit",
                    size(request.contentLength()), size(MAX_UPLOAD)));
        }

        // Refuse before writing rather than fill the disk and fail in the middle: a partly
        // written file of this size is minutes wasted and a machine with nothing left on it.
        long free = Files.getFileStore(catalog.root()).getUsableSpace();
        if (request.contentLength() + KEEP_FREE > free) {
            throw new IOException(String.format(
                    "not enough room: %s needs %s and the disk has %s free. Put the file in %s "
                    + "directly, or start the server with --images pointing at another disk",
                    name, size(request.contentLength()), size(free), catalog.root()));
        }

        Path target = catalog.root().resolve(name);
        Path partial = catalog.root().resolve(name + ".uploading");
        FileChannel out = FileChannel.open(partial, StandardOpenOption.CREATE,
                StandardOpenOption.TRUNCATE_EXISTING, StandardOpenOption.WRITE);

        return new HttpServer.UploadSink() {
            long written;

            @Override public void chunk(ByteBuffer bytes) throws IOException {
                while (bytes.hasRemaining()) written += out.write(bytes);
            }

            @Override public Response finish() throws IOException {
                out.close();
                Files.move(partial, target, java.nio.file.StandardCopyOption.REPLACE_EXISTING);
                Map<String, Object> body = new LinkedHashMap<>();
                body.put("uploaded", name);
                body.put("bytes", written);
                body.put("image", catalog.describe(name));
                return Response.json(body).header("Cache-Control", "no-store");
            }

            @Override public void abort() {
                try {
                    out.close();
                    Files.deleteIfExists(partial);
                } catch (IOException ignored) {
                    // nothing better to do while unwinding
                }
            }
        };
    }

    // ---------------------------------------------------------------- static files

    private Response page(String relative) throws IOException {
        Path p = webRoot.resolve(relative);
        return Files.isRegularFile(p) ? Response.file(p) : Response.notFound(relative);
    }

    private Response staticFile(String relative) throws IOException {
        Path p = webRoot.resolve(relative).normalize();
        if (!p.startsWith(webRoot) || !Files.isRegularFile(p)) return Response.notFound(relative);
        return Response.file(p);
    }
}
