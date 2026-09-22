// Three-way comparison: is a splat base worth paying for?
//
//   HYBRID  = splat base (already paid for, in bytes) + JPEG-coded residual against it
//   DELTA   = JPEG-coded residual against the client's FREE predictor
//             (bilinear upscale of the coarse level it already holds - zero extra bytes)
//   FRESH   = plain JPEG of the region, i.e. what a tile viewer sends
//
// All three are measured at the same reconstruction PSNR, so the only question is bytes.
// If HYBRID does not beat both others, the splat layer is dead weight.
//
// Java 21, no dependencies:
//   java tools/HybridTest.java --orig ~/face1.jpg --x 1450 --y 600 --size 256 \
//        --base out/hat/recon_04000.png --basebytes 44000

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

public class HybridTest {

    static int W, H;

    public static void main(String[] args) throws Exception {
        String orig = null, base = null;
        int cx = 0, cy = 0, size = 256, baseBytes = 0;

        for (int i = 0; i < args.length; i++) {
            switch (args[i]) {
                case "--orig" -> orig = args[++i];
                case "--base" -> base = args[++i];
                case "--basebytes" -> baseBytes = Integer.parseInt(args[++i]);
                case "--x" -> cx = Integer.parseInt(args[++i]);
                case "--y" -> cy = Integer.parseInt(args[++i]);
                case "--size" -> size = Integer.parseInt(args[++i]);
            }
        }
        if (orig == null || base == null) { System.err.println("need --orig and --base"); return; }

        BufferedImage src = ImageIO.read(new File(orig));
        BufferedImage target = src.getSubimage(cx, cy, size, size);
        W = target.getWidth(); H = target.getHeight();

        BufferedImage splatBase = ImageIO.read(new File(base));
        BufferedImage coarsePred = bilinearUp(boxDown(target, 2), W, H);

        float[][] t = planar(target), sb = planar(splatBase), cp = planar(coarsePred);

        System.out.printf("%s @ %d,%d  %dx%d%n", orig, cx, cy, W, H);
        System.out.printf("splat base:        %.2f dB  (costs %.1f KB before any residual)%n",
                psnr(sb, t), baseBytes / 1024.0);
        System.out.printf("free coarse pred:  %.2f dB  (costs 0 KB - client already holds it)%n%n",
                psnr(cp, t));

        System.out.printf("splat base alone: %.2f bpp   (the residual is charged on top of this)%n%n",
                baseBytes * 8.0 / (W * H));
        System.out.printf("%-5s | %-30s | %-30s | %-18s%n",
                "q", "HYBRID splat+residual", "DELTA free pred+resid", "FRESH plain JPEG");
        System.out.printf("%-5s | %-9s %-9s %-10s | %-9s %-9s %-10s | %-8s %-9s%n",
                "", "resid bpp", "total KB", "PSNR", "resid bpp", "total KB", "PSNR", "KB", "PSNR");

        // Weighted towards the top of the range: the system would run near-visually-lossless,
        // so that is where the residual cost actually matters.
        for (float q : new float[]{0.30f, 0.50f, 0.70f, 0.85f, 0.92f, 0.95f, 0.97f, 0.98f, 0.99f}) {
            byte[] hEnc = jpeg(residual(t, sb), q);
            double hPsnr = psnr(reconstruct(sb, decode(hEnc)), t);
            double hKB = (baseBytes + hEnc.length) / 1024.0;

            byte[] dEnc = jpeg(residual(t, cp), q);
            double dPsnr = psnr(reconstruct(cp, decode(dEnc)), t);
            double dKB = dEnc.length / 1024.0;

            byte[] fEnc = jpeg(target, q);
            double fPsnr = psnr(planar(ImageIO.read(new ByteArrayInputStream(fEnc))), t);

            System.out.printf("%-5.2f | %-9.3f %-9.1f %-10.2f | %-9.3f %-9.1f %-10.2f | %-8.1f %-9.2f%n",
                    q, hEnc.length * 8.0 / (W * H), hKB, hPsnr,
                    dEnc.length * 8.0 / (W * H), dKB, dPsnr,
                    fEnc.length / 1024.0, fPsnr);
        }
        System.out.println("\nCompare rows at equal PSNR. The splat base earns its place only if");
        System.out.println("HYBRID total bytes beat both DELTA and FRESH at the same quality.");
    }

    static BufferedImage residual(float[][] t, float[][] p) {
        BufferedImage out = new BufferedImage(W, H, BufferedImage.TYPE_INT_RGB);
        for (int y = 0; y < H; y++)
            for (int x = 0; x < W; x++) {
                int i = y * W + x, v = 0;
                for (int c = 0; c < 3; c++)
                    v |= clamp8(Math.round((t[c][i] - p[c][i]) * 127.5f + 127.5f)) << (16 - 8 * c);
                out.setRGB(x, y, v);
            }
        return out;
    }

    static float[][] reconstruct(float[][] pred, float[][] resid) {
        float[][] r = new float[3][W * H];
        for (int c = 0; c < 3; c++)
            for (int i = 0; i < W * H; i++)
                r[c][i] = clamp01(pred[c][i] + (resid[c][i] - 0.5f) * 2f);
        return r;
    }

    static float[][] decode(byte[] jpg) throws Exception {
        return planar(ImageIO.read(new ByteArrayInputStream(jpg)));
    }

    static double psnr(float[][] a, float[][] b) {
        double e = 0;
        for (int c = 0; c < 3; c++)
            for (int i = 0; i < W * H; i++) { double d = a[c][i] - b[c][i]; e += d * d; }
        return 10 * Math.log10(1.0 / Math.max(1e-12, e / (3.0 * W * H)));
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
