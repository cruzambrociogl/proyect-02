package p2.util;

import java.util.List;
import java.util.Map;

/** Just enough JSON to answer the server site's API calls, with no dependencies. */
public final class Json {

    private Json() {}

    /** Render a value: Map, List, String, Number, Boolean or null. */
    public static String write(Object value) {
        StringBuilder sb = new StringBuilder(256);
        render(value, sb);
        return sb.toString();
    }

    private static void render(Object v, StringBuilder sb) {
        switch (v) {
            case null -> sb.append("null");
            case String s -> string(s, sb);
            case Boolean b -> sb.append(b);
            case Double d -> sb.append(d.isNaN() || d.isInfinite() ? "null" : trim(d));
            case Float f -> render(f.doubleValue(), sb);
            case Number n -> sb.append(n);
            case Map<?, ?> m -> {
                sb.append('{');
                boolean first = true;
                for (Map.Entry<?, ?> e : m.entrySet()) {
                    if (!first) sb.append(',');
                    first = false;
                    string(String.valueOf(e.getKey()), sb);
                    sb.append(':');
                    render(e.getValue(), sb);
                }
                sb.append('}');
            }
            case List<?> l -> {
                sb.append('[');
                for (int i = 0; i < l.size(); i++) {
                    if (i > 0) sb.append(',');
                    render(l.get(i), sb);
                }
                sb.append(']');
            }
            default -> string(String.valueOf(v), sb);
        }
    }

    /** Keep doubles short: 1.25 not 1.2500000000000002, 4.0 not 4. */
    private static String trim(double d) {
        String s = String.format("%.6f", d);
        s = s.replaceAll("0+$", "");
        return s.endsWith(".") ? s + "0" : s;
    }

    private static void string(String s, StringBuilder sb) {
        sb.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"' -> sb.append("\\\"");
                case '\\' -> sb.append("\\\\");
                case '\n' -> sb.append("\\n");
                case '\r' -> sb.append("\\r");
                case '\t' -> sb.append("\\t");
                default -> {
                    if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
                    else sb.append(c);
                }
            }
        }
        sb.append('"');
    }
}
