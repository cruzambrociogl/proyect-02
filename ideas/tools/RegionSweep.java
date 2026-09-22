// Measurement harness: per-region, per-zoom crossover test.
//
// For every region of an image, at several downsample factors, this answers one question:
// to deliver a given quality, is it cheaper to send
//
//   (A) HYBRID  - splat parameters + a JPEG residual against the splat render
//   (B) DELTA   - a JPEG residual against the client's FREE predictor
//                 (bilinear upscale of the coarse level it already holds, 0 bytes)
//   (C) DIRECT  - the region's pixels as plain JPEG
//
// The reference quality per region is what DIRECT achieves at --refq, and (A) and (B) have
// their residual quality binary-searched to match it. Comparing at matched PSNR is the only
// way the byte figures mean anything.
//
// No parameter tuning happens here by design: the splat budget is fixed by --splatsper
// (pixels per splat) so that every region gets the same deal, and the output is a table.
//
// Java 21, no dependencies:
//   java tools/RegionSweep.java img.jpg --region 256 --refq 0.90 --maxregions 40 --csv out/sweep.csv

import javax.imageio.IIOImage;
import javax.imageio.ImageIO;
import javax.imageio.ImageWriteParam;
import javax.imageio.ImageWriter;
import javax.imageio.stream.ImageOutputStream;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

public class RegionSweep {

    static final int RECORD_BYTES = 11;          // 88-bit splat record
    static final double SIGMA_MIN = 0.6, SIGMA_MAX = 64.0, AMP_MIN = 1e-4, AMP_MAX = 4.0;
    static final float[] SIGMAS = {1.2f, 2f, 3.5f, 6f, 10f, 18f, 32f};
    static final int BS = 16;

    // Absolute texture classes (luma std). Absolute, not per-image percentile: a dark flat
    // photo must not have its flattest half relabelled "textured".
    static String textureClass(double std) {
        if (std < 0.04) return "smooth";
        if (std < 0.10) return "medium";
        return "dense";
    }

    record Row(String img, int zoom, int rx, int ry, double std, String cls,
               double splatPsnr, int splatBytes, double refPsnr, int directBytes,
               int hybResidBytes, double hybBpp, boolean hybReached,
               int delResidBytes, double delBpp, boolean delReached) {
        int hybTotal() { return splatBytes + hybResidBytes; }
        int delTotal() { return delResidBytes; }
        String verdict() {
            if (!hybReached) return "SPLATS-LOSE(cap)";
            return hybTotal() < directBytes && hybTotal() < delTotal() ? "SPLATS-WIN" : "SPLATS-LOSE";
        }
    }

    public static void main(String[] args) throws Exception {
        List<String> images = new ArrayList<>();
        int region = 256, maxRegions = 40, splatsPer = 30;
        float refq = 0.90f;
        String csv = null;
        int[] zooms = {1, 2, 4, 8, 16};

        for (int i = 0; i < args.length; i++) {
            switch (args[i]) {
                case "--region" -> region = Integer.parseInt(args[++i]);
                case "--maxregions" -> maxRegions = Integer.parseInt(args[++i]);
                case "--splatsper" -> splatsPer = Integer.parseInt(args[++i]);
                case "--refq" -> refq = Float.parseFloat(args[++i]);
                case "--csv" -> csv = args[++i];
                default -> { if (!args[i].startsWith("--")) images.add(args[i]); }
            }
        }
        if (images.isEmpty()) { System.err.println("usage: java RegionSweep.java <img...> [opts]"); return; }

        List<Row> all = new ArrayList<>();
        for (String path : images) {
            BufferedImage full = ImageIO.read(new File(path));
            String name = new File(path).getName();
            System.out.printf("%n=== %s  (%dx%d) ===%n", name, full.getWidth(), full.getHeight());

            for (int zoom : zooms) {
                BufferedImage img = zoom == 1 ? full : boxDown(full, zoom);
                int rx = img.getWidth() / region, ry = img.getHeight() / region;
                if (rx == 0 || ry == 0) continue;
                int n = rx * ry;
                int step = Math.max(1, n / maxRegions);

                // The client's free predictor at this zoom: upscale of one level coarser.
                BufferedImage pred = bilinearUp(boxDown(img, 2), rx * region, ry * region);

                int done = 0;
                for (int idx = 0; idx < n; idx += step) {
                    int cx = (idx % rx) * region, cy = (idx / rx) * region;
                    BufferedImage cell = img.getSubimage(cx, cy, region, region);
                    BufferedImage cellPred = pred.getSubimage(cx, cy, region, region);
                    all.add(evaluate(name, zoom, cx, cy, cell, cellPred, region, splatsPer, refq));
                    done++;
                }
                System.out.printf("  zoom 1:%-2d  %3d regions evaluated (%dx%d grid)%n", zoom, done, rx, ry);
            }
        }

        printTable(all);
        printSummary(all);
        if (csv != null) { writeCsv(all, Path.of(csv)); System.out.println("\nwrote " + csv); }
    }

    static Row evaluate(String name, int zoom, int cx, int cy, BufferedImage cell,
                        BufferedImage cellPred, int region, int splatsPer, float refq) throws Exception {
        float[][] t = planar(cell);
        double std = contrast(t);

        // (C) DIRECT sets the reference quality every method must match.
        byte[] direct = jpeg(cell, refq);
        double refPsnr = psnr(planar(ImageIO.read(new ByteArrayInputStream(direct))), t);

        // (A) splat base, fixed budget - no tuning.
        int budget = (region * region) / splatsPer;
        Fitter f = new Fitter(t, region, region);
        int nSplats = f.fit(budget);
        float[][] sb = f.recon;
        double splatPsnr = psnr(sb, t);
        int splatBytes = nSplats * RECORD_BYTES;

        Match hyb = matchQuality(t, sb, refPsnr, region);
        Match del = matchQuality(t, planar(cellPred), refPsnr, region);

        double px = region * (double) region;
        return new Row(name, zoom, cx, cy, std, textureClass(std), splatPsnr, splatBytes,
                refPsnr, direct.length,
                hyb.bytes, hyb.bytes * 8 / px, hyb.reached,
                del.bytes, del.bytes * 8 / px, del.reached);
    }

    record Match(int bytes, double psnr, boolean reached) {}

    /** Binary-search residual JPEG quality until predictor+residual reaches targetPsnr. */
    static Match matchQuality(float[][] t, float[][] pred, double targetPsnr, int region) throws Exception {
        float lo = 0.05f, hi = 0.99f;
        int bestBytes = 0;
        double bestPsnr = -1;
        boolean reached = false;
        for (int it = 0; it < 16; it++) {
            float mid = (lo + hi) / 2;
            byte[] enc = jpeg(residualImage(t, pred, region), mid);
            float[][] dec = planar(ImageIO.read(new ByteArrayInputStream(enc)));
            float[][] rec = new float[3][region * region];
            for (int c = 0; c < 3; c++)
                for (int i = 0; i < region * region; i++)
                    rec[c][i] = clamp01(pred[c][i] + (dec[c][i] - 0.5f) * 2f);
            double p = psnr(rec, t);
            if (p >= targetPsnr) { hi = mid; bestBytes = enc.length; bestPsnr = p; reached = true; }
            else lo = mid;
            if (it == 15 && !reached) { bestBytes = enc.length; bestPsnr = p; }
        }
        return new Match(bestBytes, bestPsnr, reached);
    }

    // ------------------------------------------------------------------ output

    static void printTable(List<Row> rows) {
        System.out.printf("%n%-14s %-5s %-9s %-7s %-8s %-9s %-9s %-9s %-8s %-9s %s%n",
                "image", "zoom", "region", "class", "splat dB", "splat KB", "direct KB",
                "hybrid KB", "hyb bpp", "delta KB", "verdict");
        for (Row r : rows)
            System.out.printf("%-14s 1:%-3d %4d,%-4d %-7s %-8.1f %-9.1f %-9.1f %-9.1f %-8.2f %-9.1f %s%n",
                    r.img.length() > 13 ? r.img.substring(0, 13) : r.img, r.zoom, r.rx, r.ry, r.cls,
                    r.splatPsnr, r.splatBytes / 1024.0, r.directBytes / 1024.0,
                    r.hybTotal() / 1024.0, r.hybBpp, r.delTotal() / 1024.0, r.verdict());
    }

    static void printSummary(List<Row> rows) {
        System.out.printf("%n=== SUMMARY by texture class ===%n");
        System.out.printf("%-8s %-7s %-10s %-11s %-12s %-12s %-12s %s%n",
                "class", "n", "splat dB", "ref dB", "hybrid/direct", "delta/direct", "hyb resid bpp", "splats win");
        for (String cls : new String[]{"smooth", "medium", "dense"}) summarise(rows, cls, null);

        System.out.printf("%n=== SUMMARY by zoom level ===%n");
        System.out.printf("%-8s %-7s %-10s %-11s %-12s %-12s %-12s %s%n",
                "zoom", "n", "splat dB", "ref dB", "hybrid/direct", "delta/direct", "hyb resid bpp", "splats win");
        for (int z : new int[]{1, 2, 4, 8, 16}) summarise(rows, null, z);

        long wins = rows.stream().filter(r -> r.verdict().equals("SPLATS-WIN")).count();
        long caps = rows.stream().filter(r -> !r.hybReached).count();
        System.out.printf("%n=== VERDICT ===%n");
        System.out.printf("regions where splats win: %d of %d (%.1f%%)%n",
                wins, rows.size(), 100.0 * wins / rows.size());
        System.out.printf("regions where the hybrid CANNOT reach the reference quality at all: %d (%.1f%%)%n",
                caps, 100.0 * caps / rows.size());
    }

    static void summarise(List<Row> rows, String cls, Integer zoom) {
        List<Row> sel = rows.stream()
                .filter(r -> cls == null || r.cls.equals(cls))
                .filter(r -> zoom == null || r.zoom == zoom).toList();
        if (sel.isEmpty()) return;
        double sp = sel.stream().mapToDouble(Row::splatPsnr).average().orElse(0);
        double rp = sel.stream().mapToDouble(Row::refPsnr).average().orElse(0);
        double hd = sel.stream().mapToDouble(r -> r.hybTotal() / (double) r.directBytes).average().orElse(0);
        double dd = sel.stream().mapToDouble(r -> r.delTotal() / (double) r.directBytes).average().orElse(0);
        double bpp = sel.stream().mapToDouble(Row::hybBpp).average().orElse(0);
        long w = sel.stream().filter(r -> r.verdict().equals("SPLATS-WIN")).count();
        System.out.printf("%-8s %-7d %-10.1f %-11.1f %-12.2f %-12.2f %-12.2f %d/%d%n",
                cls != null ? cls : "1:" + zoom, sel.size(), sp, rp, hd, dd, bpp, w, sel.size());
    }

    static void writeCsv(List<Row> rows, Path p) throws Exception {
        StringBuilder sb = new StringBuilder("image,zoom,x,y,std,class,splat_psnr,splat_bytes,ref_psnr,"
                + "direct_bytes,hybrid_resid_bytes,hybrid_resid_bpp,hybrid_total,hybrid_reached,"
                + "delta_resid_bytes,delta_resid_bpp,delta_total,verdict\n");
        for (Row r : rows)
            sb.append(String.format("%s,%d,%d,%d,%.4f,%s,%.2f,%d,%.2f,%d,%d,%.3f,%d,%b,%d,%.3f,%d,%s%n",
                    r.img, r.zoom, r.rx, r.ry, r.std, r.cls, r.splatPsnr, r.splatBytes, r.refPsnr,
                    r.directBytes, r.hybResidBytes, r.hybBpp, r.hybTotal(), r.hybReached,
                    r.delResidBytes, r.delBpp, r.delTotal(), r.verdict()));
        Files.createDirectories(p.getParent());
        Files.writeString(p, sb.toString());
    }

    // ------------------------------------------------------------- splat fitter

    static class Fitter {
        final float[][] target, recon, resid;
        final int W, H, gw, gh;
        final double[] energy;

        Fitter(float[][] t, int w, int h) {
            W = w; H = h;
            target = t;
            recon = new float[3][w * h];
            resid = new float[3][w * h];
            for (int c = 0; c < 3; c++) System.arraycopy(t[c], 0, resid[c], 0, w * h);
            gw = (w + BS - 1) / BS; gh = (h + BS - 1) / BS;
            energy = new double[gw * gh];
            for (int by = 0; by < gh; by++) for (int bx = 0; bx < gw; bx++) block(bx, by);
        }

        int fit(int budget) {
            int n = 0;
            while (n < budget) {
                if (!step()) break;
                n++;
            }
            return n;
        }

        boolean step() {
            int b = -1; double bv = -1;
            for (int i = 0; i < energy.length; i++) if (energy[i] > bv) { bv = energy[i]; b = i; }
            if (b < 0 || energy[b] <= 1e-9) return false;

            int bx = (b % gw) * BS, by = (b / gw) * BS, px = bx, py = by;
            float best = -1;
            for (int y = by; y < Math.min(by + BS, H); y++)
                for (int x = bx; x < Math.min(bx + BS, W); x++) {
                    float m = Math.abs(lum(x, y));
                    if (m > best) { best = m; px = x; py = y; }
                }

            float bestSigma = SIGMAS[0]; double bestGain = -1; float[] bestV = null;
            for (float s : SIGMAS) {
                float[] v = new float[3];
                double g = project(px, py, s, s, 0, v);
                if (g > bestGain) { bestGain = g; bestSigma = s; bestV = v; }
            }
            if (bestV == null || bestGain < 1e-9) return false;

            float sx = bestSigma, sy = bestSigma, th = 0;
            float[] mom = moments(px, py, bestSigma);
            if (mom != null) {
                float asx = clamp(mom[0], bestSigma * .5f, bestSigma * 2), asy = clamp(mom[1], bestSigma * .5f, bestSigma * 2);
                float[] v2 = new float[3];
                if (project(px, py, asx, asy, mom[2], v2) > bestGain) { sx = asx; sy = asy; th = mom[2]; bestV = v2; }
            }

            float[] v = requantize(px, py, sx, sy, th, bestV);
            if (Math.abs(v[0]) + Math.abs(v[1]) + Math.abs(v[2]) < 1e-6) return false;
            subtract(px, py, sx, sy, th, v);
            return true;
        }

        /** Round-trip through the 11-byte record so reported quality includes quantization. */
        float[] requantize(int px, int py, float sx, float sy, float th, float[] vIn) {
            float m = Math.max(Math.abs(vIn[0]), Math.max(Math.abs(vIn[1]), Math.abs(vIn[2])));
            int qamp = logQ(m);
            float amp = (float) logDQ(qamp);
            float[] v = new float[3];
            for (int c = 0; c < 3; c++) {
                int q = m < 1e-9 ? 0 : Math.max(-127, Math.min(127, Math.round(127 * vIn[c] / m)));
                v[c] = amp * q / 127f;
            }
            return v;
        }

        double project(int cx, int cy, float sx, float sy, float th, float[] out) {
            int r = (int) Math.ceil(3 * Math.max(sx, sy));
            double cos = Math.cos(th), sin = Math.sin(th), den = 0;
            double[] num = new double[3];
            for (int y = Math.max(0, cy - r); y <= Math.min(H - 1, cy + r); y++)
                for (int x = Math.max(0, cx - r); x <= Math.min(W - 1, cx + r); x++) {
                    double g = kern(x - cx, y - cy, sx, sy, cos, sin);
                    if (g < 1e-4) continue;
                    den += g * g;
                    int i = y * W + x;
                    for (int c = 0; c < 3; c++) num[c] += resid[c][i] * g;
                }
            if (den < 1e-9) return -1;
            double gain = 0;
            for (int c = 0; c < 3; c++) { out[c] = (float) (num[c] / den); gain += num[c] * num[c] / den; }
            return gain;
        }

        float[] moments(int cx, int cy, float sigma) {
            int r = (int) Math.ceil(2 * sigma);
            double w = 0, mxx = 0, myy = 0, mxy = 0;
            for (int y = Math.max(0, cy - r); y <= Math.min(H - 1, cy + r); y++)
                for (int x = Math.max(0, cx - r); x <= Math.min(W - 1, cx + r); x++) {
                    double dx = x - cx, dy = y - cy;
                    double a = Math.abs(lum(x, y)) * Math.exp(-0.5 * (dx * dx + dy * dy) / (sigma * sigma));
                    w += a; mxx += a * dx * dx; myy += a * dy * dy; mxy += a * dx * dy;
                }
            if (w < 1e-6) return null;
            mxx /= w; myy /= w; mxy /= w;
            double tr = mxx + myy, det = mxx * myy - mxy * mxy;
            double disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
            double l1 = tr / 2 + disc, l2 = tr / 2 - disc;
            if (l1 <= 1e-6 || l2 <= 1e-6) return null;
            return new float[]{(float) Math.sqrt(l1), (float) Math.sqrt(l2),
                    (float) (0.5 * Math.atan2(2 * mxy, mxx - myy))};
        }

        void subtract(int cx, int cy, float sx, float sy, float th, float[] v) {
            int r = (int) Math.ceil(3 * Math.max(sx, sy));
            double cos = Math.cos(th), sin = Math.sin(th);
            int x0 = Math.max(0, cx - r), x1 = Math.min(W - 1, cx + r);
            int y0 = Math.max(0, cy - r), y1 = Math.min(H - 1, cy + r);
            for (int y = y0; y <= y1; y++)
                for (int x = x0; x <= x1; x++) {
                    double g = kern(x - cx, y - cy, sx, sy, cos, sin);
                    if (g < 1e-4) continue;
                    int i = y * W + x;
                    for (int c = 0; c < 3; c++) {
                        resid[c][i] -= (float) (v[c] * g);
                        recon[c][i] = target[c][i] - resid[c][i];
                    }
                }
            for (int by = y0 / BS; by <= y1 / BS; by++)
                for (int bx = x0 / BS; bx <= x1 / BS; bx++) block(bx, by);
        }

        void block(int bx, int by) {
            double e = 0;
            for (int y = by * BS; y < Math.min((by + 1) * BS, H); y++)
                for (int x = bx * BS; x < Math.min((bx + 1) * BS, W); x++) {
                    int i = y * W + x;
                    for (int c = 0; c < 3; c++) e += (double) resid[c][i] * resid[c][i];
                }
            energy[by * gw + bx] = e;
        }

        float lum(int x, int y) {
            int i = y * W + x;
            return 0.299f * resid[0][i] + 0.587f * resid[1][i] + 0.114f * resid[2][i];
        }
    }

    static double kern(double dx, double dy, float sx, float sy, double cos, double sin) {
        double u = dx * cos + dy * sin, v = -dx * sin + dy * cos;
        return Math.exp(-0.5 * (u * u / (sx * sx) + v * v / (sy * sy)));
    }

    static int logQ(double v) {
        v = Math.max(AMP_MIN, Math.min(AMP_MAX, v));
        return (int) Math.round(255 * (Math.log(v) - Math.log(AMP_MIN)) / (Math.log(AMP_MAX) - Math.log(AMP_MIN)));
    }

    static double logDQ(int q) {
        return Math.exp(Math.log(AMP_MIN) + q / 255.0 * (Math.log(AMP_MAX) - Math.log(AMP_MIN)));
    }

    // ----------------------------------------------------------------- helpers

    static BufferedImage residualImage(float[][] t, float[][] p, int n) {
        BufferedImage out = new BufferedImage(n, n, BufferedImage.TYPE_INT_RGB);
        for (int y = 0; y < n; y++)
            for (int x = 0; x < n; x++) {
                int i = y * n + x, v = 0;
                for (int c = 0; c < 3; c++)
                    v |= Math.max(0, Math.min(255, Math.round((t[c][i] - p[c][i]) * 127.5f + 127.5f))) << (16 - 8 * c);
                out.setRGB(x, y, v);
            }
        return out;
    }

    static double contrast(float[][] p) {
        int n = p[0].length;
        double s = 0, s2 = 0;
        for (int i = 0; i < n; i++) {
            double l = 0.299 * p[0][i] + 0.587 * p[1][i] + 0.114 * p[2][i];
            s += l; s2 += l * l;
        }
        double m = s / n;
        return Math.sqrt(Math.max(0, s2 / n - m * m));
    }

    static double psnr(float[][] a, float[][] b) {
        int n = a[0].length;
        double e = 0;
        for (int c = 0; c < 3; c++)
            for (int i = 0; i < n; i++) { double d = a[c][i] - b[c][i]; e += d * d; }
        return 10 * Math.log10(1.0 / Math.max(1e-12, e / (3.0 * n)));
    }

    static float[][] planar(BufferedImage img) {
        int w = img.getWidth(), h = img.getHeight();
        float[][] p = new float[3][w * h];
        for (int y = 0; y < h; y++)
            for (int x = 0; x < w; x++) {
                int rgb = img.getRGB(x, y), i = y * w + x;
                p[0][i] = ((rgb >> 16) & 255) / 255f;
                p[1][i] = ((rgb >> 8) & 255) / 255f;
                p[2][i] = (rgb & 255) / 255f;
            }
        return p;
    }

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

    static BufferedImage bilinearUp(BufferedImage src, int w, int h) {
        BufferedImage out = new BufferedImage(w, h, BufferedImage.TYPE_INT_RGB);
        Graphics2D g = out.createGraphics();
        g.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BILINEAR);
        g.drawImage(src, 0, 0, w, h, null);
        g.dispose();
        return out;
    }

    static byte[] jpeg(BufferedImage img, float q) throws Exception {
        ImageWriter w = ImageIO.getImageWritersByFormatName("jpeg").next();
        ImageWriteParam p = w.getDefaultWriteParam();
        p.setCompressionMode(ImageWriteParam.MODE_EXPLICIT);
        p.setCompressionQuality(Math.max(0.05f, Math.min(0.99f, q)));
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        try (ImageOutputStream ios = ImageIO.createImageOutputStream(bos)) {
            w.setOutput(ios);
            w.write(null, new IIOImage(img, null, null), p);
        }
        w.dispose();
        return bos.toByteArray();
    }

    static float clamp(float v, float lo, float hi) { return Math.max(lo, Math.min(hi, v)); }
    static float clamp01(float v) { return Math.max(0, Math.min(1, v)); }
}
