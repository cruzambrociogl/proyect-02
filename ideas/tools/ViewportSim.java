// Screen-space delivery vs a tile viewer, over a scripted browsing path.
//
// Both strategies are charged REAL bytes: every strip, frame and tile is actually JPEG
// encoded at the same quality and its length counted. Nothing here is modelled.
//
//   SCREEN-SPACE  the server composes exactly the viewport at exactly the requested scale.
//                 A pan re-uses the overlap via a COPY instruction (8 bytes) and pays only
//                 for the newly exposed strips. A zoom pays for a whole frame.
//                 Optional --halo composes a margin beyond the viewport so small pans are
//                 already covered.
//
//   TILES         a power-of-two pyramid. For scale s the client takes level floor(log2 s)
//                 and downscales, so it fetches up to 2x more linear resolution than the
//                 screen shows, plus whole tiles that are only partly visible. Tiles are
//                 cached client-side (LRU, --cachemb of DECODED bytes) so revisits are free.
//
// The path deliberately includes a revisit phase, because that is where the tile cache wins
// and screen-space loses - the crux of the comparison.
//
// Java 21, no dependencies:
//   java tools/ViewportSim.java img.jpg --view 1920x1080 --q 0.85 --tile 256 --cachemb 30

import javax.imageio.IIOImage;
import javax.imageio.ImageIO;
import javax.imageio.ImageWriteParam;
import javax.imageio.ImageWriter;
import javax.imageio.stream.ImageOutputStream;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public class ViewportSim {

    static BufferedImage[] levels;      // levels[i] = source downsampled by 2^i
    static int vw = 1920, vh = 1080;
    static float q = 0.85f;
    static int tileSize = 256;
    static double halo = 0.0;
    // Ladder ratio for the third strategy. Powers of two (2.0) waste up to 4x in area
    // because the client must take the next finer level and downscale; a 1.25 ladder caps
    // that at 1.56x while keeping cache keys stable, which exact-per-request scales cannot.
    static double ratio = 1.25;
    // Zoom factors the scripted path visits. The default is deliberately NOT powers of two:
    // a path of {4,2,1} gives a pow2 pyramid zero waste by construction, which rigs the
    // comparison in its favour. Pass --scales 4,2,1 to reproduce that case.
    static double[] pathScales = {5.5, 3.1, 1.7, 1.0};

    /** A viewport: centre in FULL-RESOLUTION image coordinates, plus scale (src px per screen px). */
    record View(double cx, double cy, double s, String label) {}

    public static void main(String[] args) throws Exception {
        String path = null;
        int cacheMb = 30;
        for (int i = 0; i < args.length; i++) {
            switch (args[i]) {
                case "--view" -> { String[] p = args[++i].split("x"); vw = Integer.parseInt(p[0]); vh = Integer.parseInt(p[1]); }
                case "--q" -> q = Float.parseFloat(args[++i]);
                case "--tile" -> tileSize = Integer.parseInt(args[++i]);
                case "--cachemb" -> cacheMb = Integer.parseInt(args[++i]);
                case "--halo" -> halo = Double.parseDouble(args[++i]);
                case "--ratio" -> ratio = Double.parseDouble(args[++i]);
                case "--scales" -> {
                    String[] parts = args[++i].split(",");
                    pathScales = new double[parts.length];
                    for (int k = 0; k < parts.length; k++) pathScales[k] = Double.parseDouble(parts[k].trim());
                }
                default -> { if (!args[i].startsWith("--")) path = args[i]; }
            }
        }
        if (path == null) { System.err.println("usage: java ViewportSim.java <image> [opts]"); return; }

        BufferedImage src = ImageIO.read(new File(path));
        int nLevels = 1;
        while ((src.getWidth() >> nLevels) > 256 && nLevels < 6) nLevels++;
        levels = new BufferedImage[nLevels];
        levels[0] = src;
        for (int i = 1; i < nLevels; i++) levels[i] = boxDown(levels[i - 1], 2);

        System.out.printf("%s  %dx%d   viewport %dx%d   q%.2f   tiles %dpx   cache %d MB   halo %.0f%%%n",
                new File(path).getName(), src.getWidth(), src.getHeight(), vw, vh, q, tileSize, cacheMb, halo * 100);

        List<View> pathViews = scriptedPath(src.getWidth(), src.getHeight());

        ScreenSpace ss = new ScreenSpace();
        Tiles tiles = new Tiles(cacheMb * 1024 * 1024);
        LadderTiles ladder = new LadderTiles(cacheMb * 1024 * 1024);

        System.out.printf("%n%-4s %-20s %-13s %-13s %-15s %s%n",
                "#", "action", "screen-space", "pow2 tiles", "ladder r=" + ratio, "note");

        long ssTotal = 0, tTotal = 0, ssFresh = 0, tFresh = 0, ssRevisit = 0, tRevisit = 0;
        long lTotal = 0, lFresh = 0, lRevisit = 0;
        for (int i = 0; i < pathViews.size(); i++) {
            View v = pathViews.get(i);
            boolean revisit = v.label.startsWith("revisit");

            int ssBytes = ss.deliver(v);
            Tiles.Result tr = tiles.deliver(v);
            Tiles.Result lr = ladder.deliver(v);

            ssTotal += ssBytes; tTotal += tr.bytes; lTotal += lr.bytes;
            if (revisit) { ssRevisit += ssBytes; tRevisit += tr.bytes; lRevisit += lr.bytes; }
            else { ssFresh += ssBytes; tFresh += tr.bytes; lFresh += lr.bytes; }

            // A step that does not move the viewport is a degenerate sample, not a result.
            View prev = i > 0 ? pathViews.get(i - 1) : null;
            boolean still = prev != null && prev.cx == v.cx && prev.cy == v.cy && prev.s == v.s;
            String note = still ? "NO MOVEMENT (degenerate)"
                    : ssBytes < tr.bytes ? "screen-space cheaper" : "tiles cheaper";

            System.out.printf("%-4d %-20s %-13s %-13s %-15s %s%n",
                    i, v.label, kb(ssBytes), kb(tr.bytes),
                    kb(lr.bytes) + " " + lr.fetched + "/" + lr.hits, note);
        }

        System.out.printf("%n=== TOTALS (lower is better) ===%n");
        System.out.printf("screen-space      : %8.1f KB%n", ssTotal / 1024.0);
        System.out.printf("pow2 tiles        : %8.1f KB%n", tTotal / 1024.0);
        System.out.printf("ladder r=%.2f     : %8.1f KB%n", ratio, lTotal / 1024.0);

        System.out.printf("%n%-18s %12s %12s %12s%n", "", "screen-space", "pow2 tiles", "ladder");
        System.out.printf("%-18s %12.1f %12.1f %12.1f%n", "fresh territory",
                ssFresh / 1024.0, tFresh / 1024.0, lFresh / 1024.0);
        System.out.printf("%-18s %12.1f %12.1f %12.1f%n", "revisited areas",
                ssRevisit / 1024.0, tRevisit / 1024.0, lRevisit / 1024.0);
        System.out.printf("%-18s %12.1f %12.1f %12.1f%n", "TOTAL",
                ssTotal / 1024.0, tTotal / 1024.0, lTotal / 1024.0);
        System.out.println("\nThe ladder keeps the tile cache while cutting the pow2 resolution waste.");
    }

    static String kb(int b) { return String.format("%.1f KB", b / 1024.0); }

    /** Keep the whole viewport inside the image; a real viewer clamps at the edges. */
    static View clamped(double cx, double cy, double s, String label, int W, int H) {
        double halfW = vw * s / 2 * (1 + halo), halfH = vh * s / 2 * (1 + halo);
        return new View(Math.max(halfW, Math.min(W - halfW, cx)),
                        Math.max(halfH, Math.min(H - halfH, cy)), s, label);
    }

    static boolean fits(double s, int W, int H) {
        return vw * s * (1 + halo) <= W && vh * s * (1 + halo) <= H;
    }

    /**
     * Explore fresh territory, then retrace it exactly.
     *
     * Bounds-aware: scales whose viewport would not fit inside the image are skipped, and
     * pan distances are a fraction of the freedom actually available at that scale. An
     * earlier version hard-coded pan distances, walked off the right edge of the image, and
     * produced a comparison in which the tile strategy silently delivered nothing.
     */
    static List<View> scriptedPath(int W, int H) {
        List<Double> scales = new ArrayList<>();
        for (double s : pathScales) if (fits(s, W, H)) scales.add(s);
        if (scales.isEmpty()) {
            System.err.println("viewport too large for this image at every scale - use a smaller --view");
            return List.of();
        }
        System.out.printf("usable scales: %s%n", scales);

        List<View> explore = new ArrayList<>();
        double cx = W / 2.0, cy = H / 2.0;
        for (int si = 0; si < scales.size(); si++) {
            double s = scales.get(si);
            double freeX = Math.max(0, W - vw * s * (1 + halo));
            double freeY = Math.max(0, H - vh * s * (1 + halo));
            double stepX = freeX / 3, stepY = freeY / 4;

            String tag = String.format("%.2g", s);
            explore.add(clamped(cx, cy, s, si == 0 ? "open 1:" + tag : "zoom -> 1:" + tag, W, H));
            if (stepX > 16) { cx += stepX; explore.add(clamped(cx, cy, s, "pan right", W, H)); }
            if (stepY > 16) { cy += stepY; explore.add(clamped(cx, cy, s, "pan down", W, H)); }
            if (stepX > 16) { cx += stepX; explore.add(clamped(cx, cy, s, "pan right", W, H)); }
        }

        // Retrace the exact same views backwards: the tile cache should hit on all of them.
        List<View> out = new ArrayList<>(explore);
        for (int i = explore.size() - 2; i >= 0; i--) {
            View v = explore.get(i);
            out.add(new View(v.cx, v.cy, v.s, "revisit " + v.label));
        }
        return out;
    }

    // ------------------------------------------------------------- screen space

    static class ScreenSpace {
        double coveredX, coveredY, coveredW, coveredH, coveredScale = -1;

        int deliver(View v) throws Exception {
            double halfW = vw * v.s / 2 * (1 + halo), halfH = vh * v.s / 2 * (1 + halo);
            double nx = v.cx - halfW, ny = v.cy - halfH, nw = halfW * 2, nh = halfH * 2;

            // Scale change: the whole composed area must be re-rendered.
            if (v.s != coveredScale) {
                int bytes = encodeRegion(nx, ny, nw, nh, v.s);
                coveredX = nx; coveredY = ny; coveredW = nw; coveredH = nh; coveredScale = v.s;
                return bytes;
            }

            // Same scale: pay only for what moved into view. COPY handles the overlap.
            double ix = Math.max(nx, coveredX), iy = Math.max(ny, coveredY);
            double ix2 = Math.min(nx + nw, coveredX + coveredW), iy2 = Math.min(ny + nh, coveredY + coveredH);
            int bytes = 8;   // the COPY instruction itself
            if (ix2 <= ix || iy2 <= iy) {
                bytes += encodeRegion(nx, ny, nw, nh, v.s);           // no overlap at all
            } else {
                if (nx < ix) bytes += encodeRegion(nx, ny, ix - nx, nh, v.s);          // left strip
                if (nx + nw > ix2) bytes += encodeRegion(ix2, ny, nx + nw - ix2, nh, v.s); // right strip
                double sx = Math.max(nx, ix), sw = Math.min(nx + nw, ix2) - sx;
                if (ny < iy) bytes += encodeRegion(sx, ny, sw, iy - ny, v.s);          // top strip
                if (ny + nh > iy2) bytes += encodeRegion(sx, iy2, sw, ny + nh - iy2, v.s); // bottom strip
            }
            coveredX = nx; coveredY = ny; coveredW = nw; coveredH = nh;
            return bytes;
        }
    }

    /** Render a source-coordinate rect at the exact requested scale and JPEG it. */
    static int encodeRegion(double x, double y, double w, double h, double s) throws Exception {
        int outW = (int) Math.round(w / s), outH = (int) Math.round(h / s);
        if (outW < 1 || outH < 1) return 0;
        BufferedImage img = sample(x, y, w, h, outW, outH);
        return img == null ? 0 : jpeg(img).length;
    }

    /** Crop from the cheapest pyramid level that still has enough detail, then resize exactly. */
    static BufferedImage sample(double x, double y, double w, double h, int outW, int outH) {
        double s = w / outW;
        int lvl = Math.max(0, Math.min(levels.length - 1, (int) Math.floor(log2(Math.max(1, s)))));
        BufferedImage L = levels[lvl];
        double f = 1.0 / (1 << lvl);
        int lx = (int) Math.round(x * f), ly = (int) Math.round(y * f);
        int lw = (int) Math.round(w * f), lh = (int) Math.round(h * f);
        lx = Math.max(0, Math.min(L.getWidth() - 1, lx));
        ly = Math.max(0, Math.min(L.getHeight() - 1, ly));
        lw = Math.max(1, Math.min(L.getWidth() - lx, lw));
        lh = Math.max(1, Math.min(L.getHeight() - ly, lh));
        BufferedImage crop = L.getSubimage(lx, ly, lw, lh);
        if (crop.getWidth() == outW && crop.getHeight() == outH) return crop;
        BufferedImage out = new BufferedImage(Math.max(1, outW), Math.max(1, outH), BufferedImage.TYPE_INT_RGB);
        Graphics2D g = out.createGraphics();
        g.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BILINEAR);
        g.drawImage(crop, 0, 0, out.getWidth(), out.getHeight(), null);
        g.dispose();
        return out;
    }

    // ------------------------------------------------------------------- tiles

    static class Tiles {
        record Result(int bytes, int fetched, int hits) {}

        final long capacity;
        long used = 0;
        final Map<String, Integer> cache = new LinkedHashMap<>(16, 0.75f, true); // LRU, value = decoded bytes

        Tiles(long capacity) { this.capacity = capacity; }

        Result deliver(View v) throws Exception {
            int lvl = Math.max(0, Math.min(levels.length - 1, (int) Math.floor(log2(Math.max(1, v.s)))));
            BufferedImage L = levels[lvl];
            double f = 1.0 / (1 << lvl);

            double halfW = vw * v.s / 2, halfH = vh * v.s / 2;
            int x0 = (int) Math.floor(((v.cx - halfW) * f) / tileSize);
            int x1 = (int) Math.floor(((v.cx + halfW) * f) / tileSize);
            int y0 = (int) Math.floor(((v.cy - halfH) * f) / tileSize);
            int y1 = (int) Math.floor(((v.cy + halfH) * f) / tileSize);

            int bytes = 0, fetched = 0, hits = 0;
            for (int ty = y0; ty <= y1; ty++)
                for (int tx = x0; tx <= x1; tx++) {
                    int px = tx * tileSize, py = ty * tileSize;
                    if (px < 0 || py < 0 || px >= L.getWidth() || py >= L.getHeight()) continue;
                    String key = lvl + ":" + tx + ":" + ty;
                    if (cache.containsKey(key)) { hits++; continue; }
                    int tw = Math.min(tileSize, L.getWidth() - px), th = Math.min(tileSize, L.getHeight() - py);
                    bytes += jpeg(L.getSubimage(px, py, tw, th)).length;
                    fetched++;
                    int decoded = tw * th * 4;
                    cache.put(key, decoded);
                    used += decoded;
                    var it = cache.entrySet().iterator();
                    while (used > capacity && it.hasNext()) {   // LRU eviction
                        var e = it.next();
                        used -= e.getValue();
                        it.remove();
                    }
                }
            return new Result(bytes, fetched, hits);
        }
    }

    // ------------------------------------------------------------ ladder tiles

    /**
     * Tiles on a fine geometric scale ladder (ratio r) instead of powers of two.
     * For scale s the client takes ladder level floor(log_r s), so it downscales by at most
     * r (area waste <= r^2) instead of at most 2 (area waste <= 4). Tiles stay cacheable
     * because ladder scales come from a fixed set - which is precisely what per-request
     * exact scaling would destroy.
     */
    static class LadderTiles {
        final long capacity;
        long used = 0;
        final Map<String, Integer> cache = new LinkedHashMap<>(16, 0.75f, true);

        LadderTiles(long capacity) { this.capacity = capacity; }

        Tiles.Result deliver(View v) throws Exception {
            int L = Math.max(0, (int) Math.floor(Math.log(Math.max(1, v.s)) / Math.log(ratio)));
            double ls = Math.pow(ratio, L);                  // source px per ladder px
            double vwL = vw * v.s / ls, vhL = vh * v.s / ls;  // viewport size in ladder px
            double lcx = v.cx / ls, lcy = v.cy / ls;
            int imgW = (int) Math.round(levels[0].getWidth() / ls);
            int imgH = (int) Math.round(levels[0].getHeight() / ls);

            int x0 = (int) Math.floor((lcx - vwL / 2) / tileSize);
            int x1 = (int) Math.floor((lcx + vwL / 2) / tileSize);
            int y0 = (int) Math.floor((lcy - vhL / 2) / tileSize);
            int y1 = (int) Math.floor((lcy + vhL / 2) / tileSize);

            int bytes = 0, fetched = 0, hits = 0;
            for (int ty = y0; ty <= y1; ty++)
                for (int tx = x0; tx <= x1; tx++) {
                    int lx = tx * tileSize, ly = ty * tileSize;
                    if (lx < 0 || ly < 0 || lx >= imgW || ly >= imgH) continue;
                    String key = L + ":" + tx + ":" + ty;
                    if (cache.containsKey(key)) { hits++; continue; }
                    int tw = Math.min(tileSize, imgW - lx), th = Math.min(tileSize, imgH - ly);
                    BufferedImage tile = sample(lx * ls, ly * ls, tw * ls, th * ls, tw, th);
                    bytes += jpeg(tile).length;
                    fetched++;
                    int decoded = tw * th * 4;
                    cache.put(key, decoded);
                    used += decoded;
                    var it = cache.entrySet().iterator();
                    while (used > capacity && it.hasNext()) {
                        var e = it.next();
                        used -= e.getValue();
                        it.remove();
                    }
                }
            return new Tiles.Result(bytes, fetched, hits);
        }
    }

    // ----------------------------------------------------------------- helpers

    static double log2(double v) { return Math.log(v) / Math.log(2); }

    static BufferedImage boxDown(BufferedImage img, int n) {
        int w = img.getWidth() / n, h = img.getHeight() / n;
        BufferedImage out = new BufferedImage(w, h, BufferedImage.TYPE_INT_RGB);
        for (int y = 0; y < h; y++)
            for (int x = 0; x < w; x++) {
                int r = 0, g = 0, b = 0;
                for (int j = 0; j < n; j++)
                    for (int i = 0; i < n; i++) {
                        int p = img.getRGB(x * n + i, y * n + j);
                        r += (p >> 16) & 255; g += (p >> 8) & 255; b += p & 255;
                    }
                int c = n * n;
                out.setRGB(x, y, ((r / c) << 16) | ((g / c) << 8) | (b / c));
            }
        return out;
    }

    static byte[] jpeg(BufferedImage img) throws Exception {
        ImageWriter w = ImageIO.getImageWritersByFormatName("jpeg").next();
        ImageWriteParam p = w.getDefaultWriteParam();
        p.setCompressionMode(ImageWriteParam.MODE_EXPLICIT);
        p.setCompressionQuality(q);
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        try (ImageOutputStream ios = ImageIO.createImageOutputStream(bos)) {
            w.setOutput(ios);
            w.write(null, new IIOImage(img, null, null), p);
        }
        w.dispose();
        return bos.toByteArray();
    }
}
