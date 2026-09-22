package p2.http;

import p2.util.Json;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

/** One HTTP response: a status, headers and a body already in memory. */
public final class Response {

    public final int status;
    public final Map<String, String> headers = new LinkedHashMap<>();
    public final byte[] body;

    private Response(int status, String contentType, byte[] body) {
        this.status = status;
        this.body = body;
        headers.put("Content-Type", contentType);
        headers.put("Content-Length", String.valueOf(body.length));
    }

    public static Response text(int status, String text) {
        return new Response(status, "text/plain; charset=utf-8", text.getBytes(StandardCharsets.UTF_8));
    }

    public static Response json(Object value) {
        return new Response(200, "application/json; charset=utf-8",
                Json.write(value).getBytes(StandardCharsets.UTF_8));
    }

    public static Response bytes(byte[] body, String contentType) {
        return new Response(200, contentType, body);
    }

    public static Response file(Path path) throws java.io.IOException {
        Response r = new Response(200, contentTypeOf(path.getFileName().toString()), Files.readAllBytes(path));
        r.headers.put("Cache-Control", "no-cache");
        return r;
    }

    public static Response notFound(String what) { return text(404, "not found: " + what); }

    public static Response badRequest(String why) { return text(400, why); }

    public static Response error(String why) { return text(500, why); }

    public Response header(String name, String value) {
        headers.put(name, value);
        return this;
    }

    public static String contentTypeOf(String name) {
        String n = name.toLowerCase(Locale.ROOT);
        if (n.endsWith(".html")) return "text/html; charset=utf-8";
        if (n.endsWith(".js")) return "text/javascript; charset=utf-8";
        if (n.endsWith(".css")) return "text/css; charset=utf-8";
        if (n.endsWith(".json")) return "application/json; charset=utf-8";
        if (n.endsWith(".svg")) return "image/svg+xml";
        if (n.endsWith(".png")) return "image/png";
        if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
        if (n.endsWith(".ico")) return "image/x-icon";
        return "application/octet-stream";
    }

    byte[] toBytes() {
        StringBuilder head = new StringBuilder(160);
        head.append("HTTP/1.1 ").append(status).append(' ').append(reason(status)).append("\r\n");
        headers.forEach((k, v) -> head.append(k).append(": ").append(v).append("\r\n"));
        head.append("\r\n");
        byte[] h = head.toString().getBytes(StandardCharsets.ISO_8859_1);
        byte[] out = new byte[h.length + body.length];
        System.arraycopy(h, 0, out, 0, h.length);
        System.arraycopy(body, 0, out, h.length, body.length);
        return out;
    }

    private static String reason(int status) {
        return switch (status) {
            case 200 -> "OK";
            case 201 -> "Created";
            case 204 -> "No Content";
            case 400 -> "Bad Request";
            case 404 -> "Not Found";
            case 405 -> "Method Not Allowed";
            case 409 -> "Conflict";
            case 413 -> "Payload Too Large";
            case 500 -> "Internal Server Error";
            default -> "Status";
        };
    }
}
