package p2.http;

import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

/**
 * One parsed HTTP request line plus headers. The body is handled separately: small bodies are
 * buffered, uploads are streamed straight to disk, so a request never has to fit in memory.
 */
public record Request(String method, String path, Map<String, String> query, Map<String, String> headers,
                      byte[] body) {

    public String header(String name) { return headers.get(name.toLowerCase(Locale.ROOT)); }

    public long contentLength() {
        String v = header("content-length");
        try {
            return v == null ? 0 : Long.parseLong(v.trim());
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    public boolean keepAlive() {
        String c = header("connection");
        return c == null || !c.toLowerCase(Locale.ROOT).contains("close");
    }

    public boolean isWebSocketUpgrade() {
        String upgrade = header("upgrade");
        return upgrade != null && upgrade.toLowerCase(Locale.ROOT).contains("websocket");
    }

    /** Parse "GET /path?a=1&b=2 HTTP/1.1" plus header lines into a Request with no body yet. */
    public static Request parse(String head) {
        String[] lines = head.split("\r\n");
        String[] first = lines[0].split(" ");
        if (first.length < 2) throw new IllegalArgumentException("bad request line: " + lines[0]);
        String target = first[1];
        String path = target;
        Map<String, String> query = new LinkedHashMap<>();
        int q = target.indexOf('?');
        if (q >= 0) {
            path = target.substring(0, q);
            for (String pair : target.substring(q + 1).split("&")) {
                if (pair.isEmpty()) continue;
                int eq = pair.indexOf('=');
                String k = eq < 0 ? pair : pair.substring(0, eq);
                String v = eq < 0 ? "" : pair.substring(eq + 1);
                query.put(decode(k), decode(v));
            }
        }
        Map<String, String> headers = new LinkedHashMap<>();
        for (int i = 1; i < lines.length; i++) {
            int colon = lines[i].indexOf(':');
            if (colon > 0) {
                headers.put(lines[i].substring(0, colon).trim().toLowerCase(Locale.ROOT),
                        lines[i].substring(colon + 1).trim());
            }
        }
        return new Request(first[0], decode(path), query, headers, new byte[0]);
    }

    public Request withBody(byte[] body) {
        return new Request(method, path, query, headers, body);
    }

    private static String decode(String s) {
        return URLDecoder.decode(s, StandardCharsets.UTF_8);
    }
}
