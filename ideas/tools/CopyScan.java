// Viability test for the "copy reference" mechanism of protocol option B.
//
// Question: when the server needs to send a block, how often does the client ALREADY hold
// a block that looks close enough to reference instead of resending pixels?
//
// Method: walk blocks in raster order. The dictionary is every block already walked (a
// stand-in for the client's cache). For each block find the best match via an 4x4-average
// descriptor shortlist + exact MSE check, optionally with DC (brightness) compensation,
// which is what a real "copy + small correction" message would carry.
//
// Two traps this deliberately guards against, after milestone 1 taught us the lesson:
//   - Smooth blocks match everything. JPEG already codes them for almost nothing, so a
//     "hit" there is not a saving. We therefore report hit rates for TEXTURED blocks
//     (top half by variance) separately, and those are the numbers that matter.
//   - Adjacent blocks match trivially in smooth gradients. We report how far away the
//     reference was, so near-matches can be told apart from genuine self-similarity.
//
// Java 21, no dependencies:
//   java tools/CopyScan.java image.jpg --x 1000 --y 400 --size 1024 --block 16
//   java tools/CopyScan.java --synthetic-repeat        (control: should be ~100% hits)

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.File;
import java.util.Arrays;
import java.util.Random;

public class CopyScan {

    static int W, H, B;                 // image size, block size
    static float[][] px;                // [3][W*H], 0..1
    static int bw, bh, nblocks;
    static float[][] desc;              // [nblocks][48] 4x4x3 average descriptor
    static double[] variance;           // per block

    public static void main(String[] args) throws Exception {
        String path = null;
        boolean synthRepeat = false, dc = true;
        int cx = 0, cy = 0, size = 1024, block = 16, topk = 12;

        for (int i = 0; i < args.length; i++) {
            switch (args[i]) {
                case "--synthetic-repeat" -> synthRepeat = true;
                case "--x" -> cx = Integer.parseInt(args[++i]);
                case "--y" -> cy = Integer.parseInt(args[++i]);
                case "--size" -> size = Integer.parseInt(args[++i]);
                case "--block" -> block = Integer.parseInt(args[++i]);
                case "--topk" -> topk = Integer.parseInt(args[++i]);
                case "--no-dc" -> dc = false;
                default -> { if (!args[i].startsWith("--")) path = args[i]; }
            }
        }
        if (path == null && !synthRepeat) { System.err.println("usage: java CopyScan.java <image> [opts]"); return; }

        BufferedImage img = synthRepeat ? syntheticRepeat(size) : crop(ImageIO.read(new File(path)), cx, cy, size);
        load(img, block);

        System.out.printf("%s  %dx%d  block=%d  dictionary=previous blocks in raster order  DC-comp=%s%n",
                synthRepeat ? "[control] synthetic repeating pattern" : path + " @ " + cx + "," + cy,
                W, H, B, dc);

        double[] bestPsnr = new double[nblocks];
        int[] bestRef = new int[nblocks];
        Arrays.fill(bestRef, -1);

        long t0 = System.nanoTime();
        for (int i = 0; i < nblocks; i++) {
            if (i == 0) { bestPsnr[i] = 0; continue; }
            int[] cand = shortlist(i, topk);
            double best = 0; int bref = -1;
            for (int c : cand) {
                double p = matchPsnr(i, c, dc);
                if (p > best) { best = p; bref = c; }
            }
            bestPsnr[i] = best; bestRef[i] = bref;
        }
        double secs = (System.nanoTime() - t0) / 1e9;

        // Textured half of the image: the only place a copy reference can actually save bytes.
        // Absolute texture level matters, not just the ranking within this image: in a dark
        // or flat photo the "top half by variance" can still be featureless, which would
        // manufacture fake hits. Print the distribution so the reader can judge.
        double[] std = new double[nblocks];
        for (int i = 0; i < nblocks; i++) std[i] = Math.sqrt(Math.max(0, variance[i]));
        double[] s = std.clone();
        Arrays.sort(s);
        System.out.printf("block contrast (std of luma): p10=%.4f  p50=%.4f  p90=%.4f%n",
                s[nblocks / 10], s[nblocks / 2], s[nblocks * 9 / 10]);
        if (s[nblocks * 9 / 10] < 0.04)
            System.out.println("  WARNING: this crop is nearly featureless -- results here mean little.");

        boolean[] all = new boolean[nblocks], rel = new boolean[nblocks],
                 smooth = new boolean[nblocks], strong = new boolean[nblocks];
        double median = s[nblocks / 2];
        for (int i = 1; i < nblocks; i++) {
            all[i] = true;
            rel[i] = variance[i] >= median * median;
            smooth[i] = !rel[i];
            strong[i] = std[i] >= 0.06;      // absolute: real visible texture
        }

        report("ALL blocks", bestPsnr, bestRef, all);
        report("TEXTURED, relative (top half of THIS image)", bestPsnr, bestRef, rel);
        report("TEXTURED, absolute (std >= 0.06 -- the honest metric)", bestPsnr, bestRef, strong);
        report("SMOOTH blocks (bottom half)", bestPsnr, bestRef, smooth);

        System.out.printf("%nscanned %d blocks in %.1f s%n", nblocks, secs);
    }

    static void report(String label, double[] psnr, int[] ref, boolean[] mask) {
        int n = 0, h30 = 0, h35 = 0, h40 = 0, farHits = 0;
        for (int i = 1; i < nblocks; i++) {
            if (!mask[i]) continue;
            n++;
            if (psnr[i] >= 30) h30++;
            if (psnr[i] >= 35) {
                h35++;
                // "far" = not one of the 8 blocks touching this one, i.e. genuine self-similarity
                int dx = Math.abs(i % bw - ref[i] % bw), dy = Math.abs(i / bw - ref[i] / bw);
                if (dx > 1 || dy > 1) farHits++;
            }
            if (psnr[i] >= 40) h40++;
        }
        if (n == 0) return;
        System.out.printf("%n%s  (n=%d)%n", label, n);
        System.out.printf("  match >= 30 dB : %5.1f%%%n", 100.0 * h30 / n);
        System.out.printf("  match >= 35 dB : %5.1f%%   of those, %.1f%% from a non-adjacent block%n",
                100.0 * h35 / n, h35 == 0 ? 0 : 100.0 * farHits / h35);
        System.out.printf("  match >= 40 dB : %5.1f%%%n", 100.0 * h40 / n);
    }

    /** Cheap descriptor shortlist over all earlier blocks. */
    static int[] shortlist(int idx, int k) {
        double[] bestD = new double[k];
        int[] bestI = new int[k];
        Arrays.fill(bestD, Double.MAX_VALUE);
        Arrays.fill(bestI, -1);
        float[] d = desc[idx];
        for (int j = 0; j < idx; j++) {
            float[] e = desc[j];
            double s = 0;
            for (int t = 0; t < 48; t++) { double v = d[t] - e[t]; s += v * v; if (s >= bestD[k - 1]) break; }
            if (s < bestD[k - 1]) {
                int p = k - 1;
                while (p > 0 && bestD[p - 1] > s) { bestD[p] = bestD[p - 1]; bestI[p] = bestI[p - 1]; p--; }
                bestD[p] = s; bestI[p] = j;
            }
        }
        int n = 0; while (n < k && bestI[n] >= 0) n++;
        return Arrays.copyOf(bestI, n);
    }

    /** Exact PSNR of referencing block b for block a, optionally after DC compensation. */
    static double matchPsnr(int a, int b, boolean dc) {
        int ax = (a % bw) * B, ay = (a / bw) * B, bx = (b % bw) * B, by = (b / bw) * B;
        double e = 0;
        for (int c = 0; c < 3; c++) {
            double off = 0;
            if (dc) {
                double sa = 0, sb = 0;
                for (int y = 0; y < B; y++)
                    for (int x = 0; x < B; x++) {
                        sa += px[c][(ay + y) * W + ax + x];
                        sb += px[c][(by + y) * W + bx + x];
                    }
                off = (sa - sb) / (B * B);
            }
            for (int y = 0; y < B; y++)
                for (int x = 0; x < B; x++) {
                    double v = px[c][(ay + y) * W + ax + x] - (px[c][(by + y) * W + bx + x] + off);
                    e += v * v;
                }
        }
        return 10 * Math.log10(1.0 / Math.max(1e-12, e / (3.0 * B * B)));
    }

    static void load(BufferedImage img, int block) {
        W = img.getWidth() / block * block;
        H = img.getHeight() / block * block;
        B = block;
        px = new float[3][W * H];
        for (int y = 0; y < H; y++)
            for (int x = 0; x < W; x++) {
                int rgb = img.getRGB(x, y), i = y * W + x;
                px[0][i] = ((rgb >> 16) & 255) / 255f;
                px[1][i] = ((rgb >> 8) & 255) / 255f;
                px[2][i] = (rgb & 255) / 255f;
            }
        bw = W / B; bh = H / B; nblocks = bw * bh;
        desc = new float[nblocks][48];
        variance = new double[nblocks];
        int q = B / 4;
        for (int b = 0; b < nblocks; b++) {
            int ox = (b % bw) * B, oy = (b / bw) * B;
            double sum = 0, sum2 = 0;
            for (int c = 0; c < 3; c++)
                for (int gy = 0; gy < 4; gy++)
                    for (int gx = 0; gx < 4; gx++) {
                        double s = 0;
                        for (int y = 0; y < q; y++)
                            for (int x = 0; x < q; x++)
                                s += px[c][(oy + gy * q + y) * W + ox + gx * q + x];
                        desc[b][c * 16 + gy * 4 + gx] = (float) (s / (q * q));
                    }
            for (int y = 0; y < B; y++)
                for (int x = 0; x < B; x++) {
                    int i = (oy + y) * W + ox + x;
                    double l = 0.299 * px[0][i] + 0.587 * px[1][i] + 0.114 * px[2][i];
                    sum += l; sum2 += l * l;
                }
            double m = sum / (B * B);
            variance[b] = sum2 / (B * B) - m * m;
        }
    }

    static BufferedImage crop(BufferedImage img, int x, int y, int size) {
        return img.getSubimage(x, y, Math.min(size, img.getWidth() - x), Math.min(size, img.getHeight() - y));
    }

    /** Control: a pattern that genuinely repeats, so the scanner must report near-100% hits. */
    static BufferedImage syntheticRepeat(int size) {
        Random rnd = new Random(7);
        int motif = 64;
        int[][] tile = new int[motif][motif];
        for (int y = 0; y < motif; y++)
            for (int x = 0; x < motif; x++) {
                int v = 40 + (int) (200 * Math.abs(Math.sin(x * 0.4) * Math.cos(y * 0.3)));
                int n = (int) (rnd.nextGaussian() * 3);
                tile[y][x] = Math.max(0, Math.min(255, v + n));
            }
        BufferedImage out = new BufferedImage(size, size, BufferedImage.TYPE_INT_RGB);
        for (int y = 0; y < size; y++)
            for (int x = 0; x < size; x++) {
                int v = tile[y % motif][x % motif];
                out.setRGB(x, y, (v << 16) | (v << 8) | v);
            }
        return out;
    }
}
