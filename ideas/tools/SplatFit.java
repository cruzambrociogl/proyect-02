// ASTRA milestone 1 — splat fitter (go/no-go experiment).
//
// Fits one cell of an image with additive 2D Gaussian splats by greedy matching
// pursuit, in sRGB space, using the SAME 12-byte quantization the wire format uses,
// so the reported PSNR is what the protocol would actually deliver.
//
// Also encodes the same cell as JPEG across a range of qualities, so we can compare
// bytes-at-equal-PSNR against the obvious approach instead of guessing.
//
// Java 21, no dependencies. Run directly (single-file source launch):
//
//   java tools/SplatFit.java --synthetic
//   java tools/SplatFit.java eso_crop.png --x 4096 --y 2048 --size 512
//   java tools/SplatFit.java eso_crop.png --size 512 --down 4     (simulates a coarser level)
//
// Options:
//   --synthetic        generate a star field instead of reading a file
//   --x --y --size     cell to fit (default 0,0,512)
//   --down N           box-downsample the cell by N first (level simulation)
//   --max N            stop after N splats (default 8000)
//   --target-psnr D    stop early at this PSNR in dB (default 38)
//   --out DIR          output directory (default out/)
//   --seed N           synthetic seed

import javax.imageio.IIOImage;
import javax.imageio.ImageIO;
import javax.imageio.ImageWriteParam;
import javax.imageio.ImageWriter;
import javax.imageio.stream.ImageOutputStream;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.PrintWriter;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Random;

public class SplatFit {

    // ---- wire format constants (must match the protocol spec) ----
    // dx16 + dy16 + logSx8 + logSy8 + theta8 + r8 + g8 + b8 + logAmp8 = 88 bits = 11 bytes.
    // (Earlier notes claimed 12 B; encode() writes 11, so splat cost was overstated by 9%.)
    static final int RECORD_BYTES = 11;
    static final double SIGMA_MIN = 0.6, SIGMA_MAX = 64.0;   // px, log-quantized to 8 bits
    static final double AMP_MIN = 1e-4, AMP_MAX = 4.0;       // log-quantized to 8 bits

    // ---- fitter tuning ----
    static final int BS = 16;                                 // energy map block size
    static final float[] SIGMA_CANDIDATES = {1.2f, 2f, 3.5f, 6f, 10f, 18f, 32f};

    // ---- image state, channels planar, values in [0,1] sRGB ----
    static int W, H;
    static float[][] target, recon, resid;
    static double[] energy;      // residual energy per block
    static int gw, gh;
    static double sse;           // running sum of squared error over all channels
    // Fit with full-precision splats, to test whether the quality plateau comes from the
    // 11-byte quantization or from the greedy algorithm itself. Byte counts are meaningless
    // in this mode - it answers "could a bigger record help?", nothing else.
    static boolean noquant = false;

    record Splat(float x, float y, float sx, float sy, float th, float[] v) {}

    public static void main(String[] args) throws Exception {
        String path = null;
        boolean synthetic = false;
        int cx = 0, cy = 0, size = 512, down = 1, maxSplats = 8000;
        double targetPsnr = 38.0;
        long seed = 1;
        Path outDir = Path.of("out");

        for (int i = 0; i < args.length; i++) {
            switch (args[i]) {
                case "--synthetic" -> synthetic = true;
                case "--noquant" -> noquant = true;
                case "--x" -> cx = Integer.parseInt(args[++i]);
                case "--y" -> cy = Integer.parseInt(args[++i]);
                case "--size" -> size = Integer.parseInt(args[++i]);
                case "--down" -> down = Integer.parseInt(args[++i]);
                case "--max" -> maxSplats = Integer.parseInt(args[++i]);
                case "--target-psnr" -> targetPsnr = Double.parseDouble(args[++i]);
                case "--out" -> outDir = Path.of(args[++i]);
                case "--seed" -> seed = Long.parseLong(args[++i]);
                default -> {
                    if (args[i].startsWith("--")) { System.err.println("unknown option " + args[i]); return; }
                    path = args[i];
                }
            }
        }
        if (path == null && !synthetic) {
            System.err.println("usage: java SplatFit.java <image> [options]   (or --synthetic)");
            return;
        }
        Files.createDirectories(outDir);

        BufferedImage cell = synthetic
                ? syntheticStarField(size, seed)
                : cropOf(ImageIO.read(new File(path)), cx, cy, size);
        if (down > 1) cell = boxDown(cell, down);
        loadTarget(cell);

        System.out.printf("cell %dx%d  (%s)%n", W, H,
                synthetic ? "synthetic star field" : path + " @ " + cx + "," + cy + (down > 1 ? " /" + down : ""));
        ImageIO.write(cell, "png", outDir.resolve("target.png").toFile());

        // Checkpoints for reconstruction snapshots, as fractions of the splat budget.
        int[] snapAt = {maxSplats / 100, maxSplats / 20, maxSplats / 10, maxSplats / 4, maxSplats / 2, maxSplats};

        List<Splat> splats = new ArrayList<>();
        ByteBuffer wire = ByteBuffer.allocate(maxSplats * RECORD_BYTES).order(ByteOrder.BIG_ENDIAN);
        StringBuilder curve = new StringBuilder("splats,bytes,splats_per_px,psnr_db\n");

        long t0 = System.nanoTime();
        int n = 0;
        double psnr = psnr();
        while (n < maxSplats && psnr < targetPsnr) {
            Splat s = fitOne();
            if (s == null) break;                 // residual exhausted, or quantization floor hit
            splats.add(s);
            encode(wire, s);
            n++;
            psnr = psnr();
            if (n % 100 == 0 || n == 1) curve.append(row(n, psnr));
            for (int snap : snapAt) {
                if (n == snap) ImageIO.write(reconImage(), "png",
                        outDir.resolve(String.format("recon_%05d.png", n)).toFile());
            }
        }
        double secs = (System.nanoTime() - t0) / 1e9;
        curve.append(row(n, psnr));

        Files.writeString(outDir.resolve("curve.csv"), curve.toString());
        Files.write(outDir.resolve("splats.bin"), java.util.Arrays.copyOf(wire.array(), n * RECORD_BYTES));
        ImageIO.write(reconImage(), "png", outDir.resolve("recon_final.png").toFile());

        // ---- the go/no-go gate: PSNR at 1 splat per 30 pixels ----
        int gateN = (W * H) / 30;
        double gatePsnr = psnrAt(splats, gateN);

        System.out.printf("%nfitted %d splats in %.1f s (%.0f splats/s)%n", n, secs, n / secs);
        System.out.printf("final PSNR        %.2f dB  (%d splats, %d bytes, %.1f KB)%n",
                psnr, n, n * RECORD_BYTES, n * RECORD_BYTES / 1024.0);
        System.out.printf("gate  1 splat/30px = %d splats -> %.2f dB   %s%n",
                gateN, gatePsnr, gatePsnr >= 35.0 ? "GO" : "NO-GO (target 35 dB)");

        // ---- JPEG baseline, so the comparison is measured rather than assumed ----
        StringBuilder jc = new StringBuilder("quality,bytes,psnr_db\n");
        System.out.printf("%nJPEG baseline on the same cell:%n");
        for (float q = 0.30f; q <= 0.96f; q += 0.10f) {
            byte[] enc = jpeg(cell, q);
            double jp = psnrOf(ImageIO.read(new java.io.ByteArrayInputStream(enc)));
            jc.append(String.format("%.2f,%d,%.3f%n", q, enc.length, jp));
            System.out.printf("  q=%.2f  %6.1f KB  %.2f dB%n", q, enc.length / 1024.0, jp);
        }
        Files.writeString(outDir.resolve("jpeg_curve.csv"), jc.toString());
        System.out.printf("%nwrote %s/{curve.csv,jpeg_curve.csv,splats.bin,recon_*.png}%n", outDir);
    }

    static String row(int n, double psnr) {
        return String.format("%d,%d,%.5f,%.3f%n", n, n * RECORD_BYTES, n / (double) (W * H), psnr);
    }

    // ---------------------------------------------------------------- fitting

    /** One step of matching pursuit: find the worst area, fit the best splat there, subtract it. */
    static Splat fitOne() {
        int b = argmaxEnergy();
        if (b < 0 || energy[b] <= 1e-9) return null;

        // Peak residual pixel inside the worst block.
        int bx = (b % gw) * BS, by = (b / gw) * BS;
        int px = bx, py = by;
        float best = -1;
        for (int y = by; y < Math.min(by + BS, H); y++)
            for (int x = bx; x < Math.min(bx + BS, W); x++) {
                float m = Math.abs(lumResid(x, y));
                if (m > best) { best = m; px = x; py = y; }
            }

        // Pick the scale that removes the most error (isotropic dictionary search).
        float bestSigma = SIGMA_CANDIDATES[0];
        double bestGain = -1;
        float[] bestV = null;
        for (float s : SIGMA_CANDIDATES) {
            float[] v = new float[3];
            double gain = project(px, py, s, s, 0, v);
            if (gain > bestGain) { bestGain = gain; bestSigma = s; bestV = v; }
        }
        if (bestV == null || bestGain < 1e-9) return null;   // nothing left worth fitting

        // Try an anisotropic refinement from the local residual moments; keep it only if it helps.
        float sx = bestSigma, sy = bestSigma, th = 0;
        float[] mom = moments(px, py, bestSigma);
        if (mom != null) {
            float asx = clamp(mom[0], bestSigma * 0.5f, bestSigma * 2f);
            float asy = clamp(mom[1], bestSigma * 0.5f, bestSigma * 2f);
            float ath = mom[2];
            float[] v2 = new float[3];
            double gain2 = project(px, py, asx, asy, ath, v2);
            if (gain2 > bestGain) { sx = asx; sy = asy; th = ath; bestV = v2; }
        }

        // Quantize exactly as the wire format does, then subtract the DEQUANTIZED splat,
        // so the error we report includes quantization loss.
        Splat raw = new Splat(px, py, sx, sy, th, bestV);
        Splat s = noquant ? raw : dequantize(quantize(raw));
        // A splat whose quantized contribution rounds to nothing modifies no pixels, so the
        // residual and the energy map never change and the fitter re-picks the same block
        // forever, emitting null records. (This bug silently padded a 40k-splat run with
        // ~23k dead records before it was caught.) Stop at the quantization floor instead.
        if (Math.abs(s.v[0]) + Math.abs(s.v[1]) + Math.abs(s.v[2]) < 1e-6) return null;
        subtract(s);
        return s;
    }

    /** Optimal per-channel coefficient for this kernel (least squares), returns the error reduction. */
    static double project(int cxp, int cyp, float sx, float sy, float th, float[] vOut) {
        int r = (int) Math.ceil(3 * Math.max(sx, sy));
        int x0 = Math.max(0, cxp - r), x1 = Math.min(W - 1, cxp + r);
        int y0 = Math.max(0, cyp - r), y1 = Math.min(H - 1, cyp + r);
        double cos = Math.cos(th), sin = Math.sin(th);
        double den = 0;
        double[] num = new double[3];
        for (int y = y0; y <= y1; y++) {
            for (int x = x0; x <= x1; x++) {
                double g = kernel(x - cxp, y - cyp, sx, sy, cos, sin);
                if (g < 1e-4) continue;
                den += g * g;
                int i = y * W + x;
                num[0] += resid[0][i] * g;
                num[1] += resid[1][i] * g;
                num[2] += resid[2][i] * g;
            }
        }
        if (den < 1e-9) return -1;
        double gain = 0;
        for (int c = 0; c < 3; c++) { vOut[c] = (float) (num[c] / den); gain += num[c] * num[c] / den; }
        return gain;
    }

    /** Residual-weighted second moments around a point, as (sx, sy, theta). */
    static float[] moments(int cxp, int cyp, float sigma) {
        int r = (int) Math.ceil(2 * sigma);
        double w = 0, mxx = 0, myy = 0, mxy = 0;
        for (int y = Math.max(0, cyp - r); y <= Math.min(H - 1, cyp + r); y++)
            for (int x = Math.max(0, cxp - r); x <= Math.min(W - 1, cxp + r); x++) {
                double dx = x - cxp, dy = y - cyp;
                double g = Math.exp(-0.5 * (dx * dx + dy * dy) / (sigma * sigma));
                double a = Math.abs(lumResid(x, y)) * g;
                w += a; mxx += a * dx * dx; myy += a * dy * dy; mxy += a * dx * dy;
            }
        if (w < 1e-6) return null;
        mxx /= w; myy /= w; mxy /= w;
        double tr = mxx + myy, det = mxx * myy - mxy * mxy;
        double disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
        double l1 = tr / 2 + disc, l2 = tr / 2 - disc;
        if (l1 <= 1e-6 || l2 <= 1e-6) return null;
        double th = 0.5 * Math.atan2(2 * mxy, mxx - myy);
        return new float[]{(float) Math.sqrt(l1), (float) Math.sqrt(l2), (float) th};
    }

    /** Subtract a splat from the residual, updating the running SSE and the energy map locally. */
    static void subtract(Splat s) {
        int r = (int) Math.ceil(3 * Math.max(s.sx, s.sy));
        int cxp = Math.round(s.x), cyp = Math.round(s.y);
        int x0 = Math.max(0, cxp - r), x1 = Math.min(W - 1, cxp + r);
        int y0 = Math.max(0, cyp - r), y1 = Math.min(H - 1, cyp + r);
        double cos = Math.cos(s.th), sin = Math.sin(s.th);
        for (int y = y0; y <= y1; y++) {
            for (int x = x0; x <= x1; x++) {
                double g = kernel(x - s.x, y - s.y, s.sx, s.sy, cos, sin);
                if (g < 1e-4) continue;
                int i = y * W + x;
                for (int c = 0; c < 3; c++) {
                    float old = resid[c][i];
                    float nw = (float) (old - s.v[c] * g);
                    sse += (double) nw * nw - (double) old * old;
                    resid[c][i] = nw;
                    recon[c][i] = target[c][i] - nw;
                }
            }
        }
        // Refresh only the blocks the footprint touched.
        for (int by = y0 / BS; by <= y1 / BS; by++)
            for (int bx = x0 / BS; bx <= x1 / BS; bx++) recomputeBlock(bx, by);
    }

    static double kernel(double dx, double dy, float sx, float sy, double cos, double sin) {
        double u = dx * cos + dy * sin, v = -dx * sin + dy * cos;
        return Math.exp(-0.5 * (u * u / (sx * sx) + v * v / (sy * sy)));
    }

    static void recomputeBlock(int bx, int by) {
        double e = 0;
        for (int y = by * BS; y < Math.min((by + 1) * BS, H); y++)
            for (int x = bx * BS; x < Math.min((bx + 1) * BS, W); x++) {
                int i = y * W + x;
                e += (double) resid[0][i] * resid[0][i]
                   + (double) resid[1][i] * resid[1][i]
                   + (double) resid[2][i] * resid[2][i];
            }
        energy[by * gw + bx] = e;
    }

    static int argmaxEnergy() {
        int best = -1; double bv = -1;
        for (int i = 0; i < energy.length; i++) if (energy[i] > bv) { bv = energy[i]; best = i; }
        return best;
    }

    static float lumResid(int x, int y) {
        int i = y * W + x;
        return 0.299f * resid[0][i] + 0.587f * resid[1][i] + 0.114f * resid[2][i];
    }

    // ---------------------------------------------------------- quantization

    /** Pack to the 12-byte record; returns the quantized fields for round-tripping. */
    static int[] quantize(Splat s) {
        int dx = clampI(Math.round(s.x * 65535f / Math.max(1, W - 1)), 0, 65535);
        int dy = clampI(Math.round(s.y * 65535f / Math.max(1, H - 1)), 0, 65535);
        int qsx = logQ(s.sx, SIGMA_MIN, SIGMA_MAX);
        int qsy = logQ(s.sy, SIGMA_MIN, SIGMA_MAX);
        double th = s.th % Math.PI; if (th < 0) th += Math.PI;
        int qth = clampI((int) Math.round(th * 255 / Math.PI), 0, 255);
        float m = Math.max(Math.abs(s.v[0]), Math.max(Math.abs(s.v[1]), Math.abs(s.v[2])));
        int qamp = logQ(m, AMP_MIN, AMP_MAX);
        int[] col = new int[3];
        for (int c = 0; c < 3; c++) col[c] = m < 1e-9 ? 0 : clampI(Math.round(127 * s.v[c] / m), -127, 127);
        return new int[]{dx, dy, qsx, qsy, qth, col[0], col[1], col[2], qamp};
    }

    static Splat dequantize(int[] q) {
        float x = q[0] * Math.max(1, W - 1) / 65535f;
        float y = q[1] * Math.max(1, H - 1) / 65535f;
        float sx = (float) logDQ(q[2], SIGMA_MIN, SIGMA_MAX);
        float sy = (float) logDQ(q[3], SIGMA_MIN, SIGMA_MAX);
        float th = (float) (q[4] * Math.PI / 255);
        float amp = (float) logDQ(q[8], AMP_MIN, AMP_MAX);
        float[] v = new float[3];
        for (int c = 0; c < 3; c++) v[c] = amp * q[5 + c] / 127f;
        return new Splat(x, y, sx, sy, th, v);
    }

    static void encode(ByteBuffer b, Splat s) {
        int[] q = quantize(s);
        b.putShort((short) q[0]); b.putShort((short) q[1]);
        b.put((byte) q[2]); b.put((byte) q[3]); b.put((byte) q[4]);
        b.put((byte) q[5]); b.put((byte) q[6]); b.put((byte) q[7]);
        b.put((byte) q[8]);
    }

    static int logQ(double v, double lo, double hi) {
        v = Math.max(lo, Math.min(hi, v));
        return clampI((int) Math.round(255 * (Math.log(v) - Math.log(lo)) / (Math.log(hi) - Math.log(lo))), 0, 255);
    }

    static double logDQ(int q, double lo, double hi) {
        return Math.exp(Math.log(lo) + (q & 255) / 255.0 * (Math.log(hi) - Math.log(lo)));
    }

    // ------------------------------------------------------------- image i/o

    static void loadTarget(BufferedImage img) {
        W = img.getWidth(); H = img.getHeight();
        target = new float[3][W * H];
        recon = new float[3][W * H];
        resid = new float[3][W * H];
        sse = 0;
        for (int y = 0; y < H; y++)
            for (int x = 0; x < W; x++) {
                int rgb = img.getRGB(x, y), i = y * W + x;
                target[0][i] = ((rgb >> 16) & 255) / 255f;
                target[1][i] = ((rgb >> 8) & 255) / 255f;
                target[2][i] = (rgb & 255) / 255f;
                for (int c = 0; c < 3; c++) { resid[c][i] = target[c][i]; sse += (double) target[c][i] * target[c][i]; }
            }
        gw = (W + BS - 1) / BS; gh = (H + BS - 1) / BS;
        energy = new double[gw * gh];
        for (int by = 0; by < gh; by++) for (int bx = 0; bx < gw; bx++) recomputeBlock(bx, by);
    }

    static double psnr() { return 10 * Math.log10(1.0 / Math.max(1e-12, sse / (3.0 * W * H))); }

    /** PSNR after replaying the first n splats (used for the gate, without refitting). */
    static double psnrAt(List<Splat> splats, int n) {
        if (n >= splats.size()) return psnr();
        float[][] r = new float[3][W * H];
        for (int c = 0; c < 3; c++) System.arraycopy(target[c], 0, r[c], 0, W * H);
        for (int k = 0; k < n; k++) {
            Splat s = splats.get(k);
            int rad = (int) Math.ceil(3 * Math.max(s.sx, s.sy));
            int cxp = Math.round(s.x), cyp = Math.round(s.y);
            double cos = Math.cos(s.th), sin = Math.sin(s.th);
            for (int y = Math.max(0, cyp - rad); y <= Math.min(H - 1, cyp + rad); y++)
                for (int x = Math.max(0, cxp - rad); x <= Math.min(W - 1, cxp + rad); x++) {
                    double g = kernel(x - s.x, y - s.y, s.sx, s.sy, cos, sin);
                    if (g < 1e-4) continue;
                    int i = y * W + x;
                    for (int c = 0; c < 3; c++) r[c][i] -= (float) (s.v[c] * g);
                }
        }
        double e = 0;
        for (int c = 0; c < 3; c++) for (int i = 0; i < W * H; i++) e += (double) r[c][i] * r[c][i];
        return 10 * Math.log10(1.0 / Math.max(1e-12, e / (3.0 * W * H)));
    }

    static double psnrOf(BufferedImage img) {
        double e = 0;
        for (int y = 0; y < H; y++)
            for (int x = 0; x < W; x++) {
                int rgb = img.getRGB(x, y), i = y * W + x;
                double dr = ((rgb >> 16) & 255) / 255.0 - target[0][i];
                double dg = ((rgb >> 8) & 255) / 255.0 - target[1][i];
                double db = (rgb & 255) / 255.0 - target[2][i];
                e += dr * dr + dg * dg + db * db;
            }
        return 10 * Math.log10(1.0 / Math.max(1e-12, e / (3.0 * W * H)));
    }

    static BufferedImage reconImage() {
        BufferedImage out = new BufferedImage(W, H, BufferedImage.TYPE_INT_RGB);
        for (int y = 0; y < H; y++)
            for (int x = 0; x < W; x++) {
                int i = y * W + x;
                int r = to8(recon[0][i]), g = to8(recon[1][i]), b = to8(recon[2][i]);
                out.setRGB(x, y, (r << 16) | (g << 8) | b);
            }
        return out;
    }

    static byte[] jpeg(BufferedImage img, float quality) throws Exception {
        ImageWriter w = ImageIO.getImageWritersByFormatName("jpeg").next();
        ImageWriteParam p = w.getDefaultWriteParam();
        p.setCompressionMode(ImageWriteParam.MODE_EXPLICIT);
        p.setCompressionQuality(quality);
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        try (ImageOutputStream ios = ImageIO.createImageOutputStream(bos)) {
            w.setOutput(ios);
            w.write(null, new IIOImage(img, null, null), p);
        }
        w.dispose();
        return bos.toByteArray();
    }

    static BufferedImage cropOf(BufferedImage img, int x, int y, int size) {
        int w = Math.min(size, img.getWidth() - x), h = Math.min(size, img.getHeight() - y);
        return img.getSubimage(x, y, w, h);
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

    /** Stand-in for the ESO image: PSF stars over a smooth nebula gradient, plus sensor noise. */
    static BufferedImage syntheticStarField(int size, long seed) {
        Random rnd = new Random(seed);
        float[][] img = new float[3][size * size];
        for (int y = 0; y < size; y++)
            for (int x = 0; x < size; x++) {
                double nx = x / (double) size, ny = y / (double) size;
                double neb = 0.06 + 0.10 * Math.exp(-((nx - .35) * (nx - .35) + (ny - .6) * (ny - .6)) / 0.05)
                                  + 0.05 * Math.exp(-((nx - .7) * (nx - .7) + (ny - .3) * (ny - .3)) / 0.03);
                int i = y * size + x;
                img[0][i] = (float) (neb * 1.1); img[1][i] = (float) (neb * 0.95); img[2][i] = (float) (neb * 1.3);
            }
        int stars = size * size / 900;
        for (int s = 0; s < stars; s++) {
            double sx = rnd.nextDouble() * size, sy = rnd.nextDouble() * size;
            double sigma = 0.8 + Math.abs(rnd.nextGaussian()) * 1.6;
            double amp = 0.05 + Math.pow(rnd.nextDouble(), 3) * 1.6;
            float tint = (float) (0.8 + rnd.nextDouble() * 0.4);
            int r = (int) Math.ceil(3 * sigma);
            for (int y = (int) Math.max(0, sy - r); y <= Math.min(size - 1, sy + r); y++)
                for (int x = (int) Math.max(0, sx - r); x <= Math.min(size - 1, sx + r); x++) {
                    double dx = x - sx, dy = y - sy;
                    double g = amp * Math.exp(-0.5 * (dx * dx + dy * dy) / (sigma * sigma));
                    int i = y * size + x;
                    img[0][i] += (float) (g * tint); img[1][i] += (float) g; img[2][i] += (float) (g / tint);
                }
        }
        BufferedImage out = new BufferedImage(size, size, BufferedImage.TYPE_INT_RGB);
        for (int y = 0; y < size; y++)
            for (int x = 0; x < size; x++) {
                int i = y * size + x;
                int r = to8((float) (img[0][i] + rnd.nextGaussian() * 0.004));
                int g = to8((float) (img[1][i] + rnd.nextGaussian() * 0.004));
                int b = to8((float) (img[2][i] + rnd.nextGaussian() * 0.004));
                out.setRGB(x, y, (r << 16) | (g << 8) | b);
            }
        return out;
    }

    static int to8(float v) { return Math.max(0, Math.min(255, Math.round(v * 255))); }
    static int clampI(int v, int lo, int hi) { return Math.max(lo, Math.min(hi, v)); }
    static float clamp(float v, float lo, float hi) { return Math.max(lo, Math.min(hi, v)); }
}
