// Does residual error accumulate across chained zoom levels?
//
// ResidualTest measured ONE zoom step, against a pristine coarse level. Real browsing
// chains 4-6 steps, and each step's predictor is built from the client's LOSSY
// reconstruction of the previous level, not from pristine data. If error compounds, the
// deepest zoom - the whole point of the project - ends up soft, and the protocol would
// need to periodically re-anchor with a fresh (non-residual) send.
//
// Per level k the client does:
//     predictor = bilinear upscale of ITS OWN reconstruction of level k-1
//     recon     = predictor + decoded residual
//
// Three numbers per level make the answer readable:
//   CHAIN  - what the client actually ends up with (accumulated error)
//   IDEAL  - same residual step but predicted from the PRISTINE coarse level
//            (CHAIN - IDEAL = the accumulation penalty, the thing we are testing for)
//   FRESH  - coding that level directly, i.e. what a tile viewer sends
//
// Java 21, no dependencies:
//   java tools/ChainTest.java image.jpg --x 1450 --y 600 --size 1024 --levels 4 --q 0.6

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

public class ChainTest {

    public static void main(String[] args) throws Exception {
        String path = null;
        int cx = 0, cy = 0, size = 1024, levels = 4;
        float q = 0.6f, qCoarse = -1f;
        for (int i = 0; i < args.length; i++) {
            switch (args[i]) {
                case "--x" -> cx = Integer.parseInt(args[++i]);
                case "--y" -> cy = Integer.parseInt(args[++i]);
                case "--size" -> size = Integer.parseInt(args[++i]);
                case "--levels" -> levels = Integer.parseInt(args[++i]);
                case "--q" -> q = Float.parseFloat(args[++i]);
                // Coarse levels are tiny in absolute bytes, so coding them at high quality
                // may stop error compounding into the deepest level for almost nothing.
                case "--qcoarse" -> qCoarse = Float.parseFloat(args[++i]);
                default -> { if (!args[i].startsWith("--")) path = args[i]; }
            }
        }
        if (path == null) {
            System.err.println("usage: java ChainTest.java <image> [--x --y --size --levels --q --qcoarse]");
            return;
        }
        if (qCoarse < 0) qCoarse = q;

        BufferedImage img = ImageIO.read(new File(path));
        BufferedImage crop = img.getSubimage(cx, cy,
                Math.min(size, img.getWidth() - cx), Math.min(size, img.getHeight() - cy));

        // Ground truth pyramid: truth[0] is coarsest, truth[levels] is the full-res crop.
        BufferedImage[] truth = new BufferedImage[levels + 1];
        truth[levels] = crop;
        for (int k = levels - 1; k >= 0; k--) truth[k] = boxDown(truth[k + 1], 2);

        System.out.printf("%s @ %d,%d  %dx%d  levels=%d  q=%.2f  qcoarse=%.2f%n",
                path, cx, cy, crop.getWidth(), crop.getHeight(), levels, q, qCoarse);
        System.out.printf("contrast (std of luma): %.4f%n%n", contrast(planar(crop)));

        // Level 0: the initial coarse send, coded fresh.
        byte[] base = jpeg(truth[0], qCoarse);
        BufferedImage recon = ImageIO.read(new ByteArrayInputStream(base));
        long cum = base.length;
        long cumFresh = jpeg(truth[0], q).length;   // a tile viewer uses one quality everywhere
        System.out.printf("%-6s %-9s %-10s %-10s %-11s %-10s %-10s %-10s%n",
                "level", "size", "delta B", "cum B", "cumFRESH B", "CHAIN dB", "IDEAL dB", "FRESH dB");
        System.out.printf("%-6d %-9s %-10d %-10d %-11d %-10.2f %-10s %-10s%n",
                0, truth[0].getWidth() + "^2", base.length, cum, cumFresh,
                psnr(planar(recon), planar(truth[0])), "-", "-");

        for (int k = 1; k <= levels; k++) {
            int w = truth[k].getWidth(), h = truth[k].getHeight();

            float qk = (k == levels) ? q : qCoarse;   // only the deepest level is the expensive one

            // CHAIN: predict from the client's own (lossy) reconstruction.
            BufferedImage pred = bilinearUp(recon, w, h);
            byte[] enc = jpeg(residualImage(planar(truth[k]), planar(pred), w, h), qk);
            BufferedImage next = addResidual(pred, ImageIO.read(new ByteArrayInputStream(enc)), w, h);
            double chain = psnr(planar(next), planar(truth[k]));
            cum += enc.length;

            // IDEAL: same step, but predicted from pristine data - isolates accumulation.
            BufferedImage predIdeal = bilinearUp(truth[k - 1], w, h);
            byte[] encIdeal = jpeg(residualImage(planar(truth[k]), planar(predIdeal), w, h), qk);
            BufferedImage idealRecon = addResidual(predIdeal, ImageIO.read(new ByteArrayInputStream(encIdeal)), w, h);
            double ideal = psnr(planar(idealRecon), planar(truth[k]));

            // FRESH: code this level directly, at the display quality throughout.
            byte[] fresh = jpeg(truth[k], q);
            double freshPsnr = psnr(planar(ImageIO.read(new ByteArrayInputStream(fresh))), planar(truth[k]));
            cumFresh += fresh.length;

            System.out.printf("%-6d %-9s %-10d %-10d %-11d %-10.2f %-10.2f %-10.2f%n",
                    k, w + "^2", enc.length, cum, cumFresh, chain, ideal, freshPsnr);
            System.out.printf("       %-9s %-10s %-10s %-11s (penalty %.2f dB)   fresh this level %d B%n",
                    "", "", "", "", ideal - chain, fresh.length);

            recon = next;
        }
        System.out.printf("%nat the deepest level: chain %d B total vs fresh %d B total (%.2fx)%n",
                cum, cumFresh, cumFresh / (double) cum);
        System.out.println("Penalty = IDEAL - CHAIN, i.e. the cost of predicting from lossy data.");
        System.out.println("Chaining only wins if it is cheaper AND lands at comparable deepest-level dB.");
    }

    static BufferedImage residualImage(float[][] t, float[][] p, int w, int h) {
        BufferedImage out = new BufferedImage(w, h, BufferedImage.TYPE_INT_RGB);
        for (int y = 0; y < h; y++)
            for (int x = 0; x < w; x++) {
                int i = y * w + x, v = 0;
                for (int c = 0; c < 3; c++)
                    v |= clamp8(Math.round((t[c][i] - p[c][i]) * 127.5f + 127.5f)) << (16 - 8 * c);
                out.setRGB(x, y, v);
            }
        return out;
    }

    static BufferedImage addResidual(BufferedImage pred, BufferedImage resid, int w, int h) {
        float[][] p = planar(pred), r = planar(resid);
        BufferedImage out = new BufferedImage(w, h, BufferedImage.TYPE_INT_RGB);
        for (int y = 0; y < h; y++)
            for (int x = 0; x < w; x++) {
                int i = y * w + x, v = 0;
                for (int c = 0; c < 3; c++) {
                    float val = p[c][i] + (r[c][i] - 0.5f) * 2f;
                    v |= clamp8(Math.round(clamp01(val) * 255)) << (16 - 8 * c);
                }
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

    static int clamp8(int v) { return Math.max(0, Math.min(255, v)); }
    static float clamp01(float v) { return Math.max(0, Math.min(1, v)); }
}
