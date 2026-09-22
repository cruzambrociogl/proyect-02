// Does refinement-by-residual beat sending fresh pixels?
//
// This is the mechanism the brief's "transferencia y eliminacion de informacion" language
// points at: when the user zooms in, the client already holds the coarser level, so the
// server could send only the DIFFERENCE needed to double the resolution, instead of
// re-sending the region at the finer level.
//
// Experiment, per crop:
//   have      = the crop downsampled 2x            (what the client already holds)
//   predictor = bilinear upscale of `have`         (what the client can already display)
//   residual  = target - predictor                 (the missing detail)
//   DELTA cost = bytes to code `residual` as JPEG (biased to 0..255, which is what we would
//                actually ship, since the browser must be able to decode it natively)
//   FRESH cost = bytes to code `target` as JPEG directly (what a tile viewer sends)
// Both are compared at matched reconstruction PSNR. If DELTA is not clearly cheaper than
// FRESH, incremental refinement buys nothing and zoom-in should just re-send the region.
//
// Java 21, no dependencies:
//   java tools/ResidualTest.java image.jpg --x 1450 --y 600 --size 512

import javax.imageio.IIOImage;
import javax.imageio.ImageIO;
import javax.imageio.ImageWriteParam;
import javax.imageio.ImageWriter;
import javax.imageio.stream.ImageOutputStream;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;

public class ResidualTest {

    static int W, H;
    static float[][] target, predictor;

    public static void main(String[] args) throws Exception {
        String path = null;
        int cx = 0, cy = 0, size = 512;
        for (int i = 0; i < args.length; i++) {
            switch (args[i]) {
                case "--x" -> cx = Integer.parseInt(args[++i]);
                case "--y" -> cy = Integer.parseInt(args[++i]);
                case "--size" -> size = Integer.parseInt(args[++i]);
                default -> { if (!args[i].startsWith("--")) path = args[i]; }
            }
        }
        if (path == null) { System.err.println("usage: java ResidualTest.java <image> [--x --y --size]"); return; }

        BufferedImage img = ImageIO.read(new File(path));
        BufferedImage cell = img.getSubimage(cx, cy,
                Math.min(size, img.getWidth() - cx), Math.min(size, img.getHeight() - cy));
        W = cell.getWidth(); H = cell.getHeight();
        target = toPlanar(cell);

        BufferedImage have = boxDown(cell, 2);
        BufferedImage up = bilinearUp(have, W, H);
        predictor = toPlanar(up);

        double predPsnr = psnr(predictor, target);
        System.out.printf("%s @ %d,%d  %dx%d%n", path, cx, cy, W, H);
        System.out.printf("contrast (std of luma): %.4f%n", contrast());
        System.out.printf("predictor alone (upscaled coarse level): %.2f dB%n%n", predPsnr);

        // Residual image, biased so it survives an 8-bit unsigned codec.
        BufferedImage residImg = new BufferedImage(W, H, BufferedImage.TYPE_INT_RGB);
        for (int y = 0; y < H; y++)
            for (int x = 0; x < W; x++) {
                int i = y * W + x, v = 0;
                for (int c = 0; c < 3; c++) {
                    int q = clamp8(Math.round((target[c][i] - predictor[c][i]) * 127.5f + 127.5f));
                    v |= q << (16 - 8 * c);
                }
                residImg.setRGB(x, y, v);
            }

        System.out.printf("%-6s | %-22s | %-22s%n", "q", "DELTA (residual)", "FRESH (direct)");
        System.out.printf("%-6s | %-10s %-11s | %-10s %-11s%n", "", "bytes", "PSNR", "bytes", "PSNR");
        for (float q = 0.30f; q <= 0.96f; q += 0.10f) {
            byte[] dEnc = jpeg(residImg, q);
            float[][] dec = toPlanar(ImageIO.read(new ByteArrayInputStream(dEnc)));
            float[][] recon = new float[3][W * H];
            for (int c = 0; c < 3; c++)
                for (int i = 0; i < W * H; i++)
                    recon[c][i] = clamp01(predictor[c][i] + (dec[c][i] - 0.5f) * 2f);
            double dPsnr = psnr(recon, target);

            byte[] fEnc = jpeg(cell, q);
            double fPsnr = psnr(toPlanar(ImageIO.read(new ByteArrayInputStream(fEnc))), target);

            System.out.printf("%-6.2f | %-10d %-11.2f | %-10d %-11.2f%n",
                    q, dEnc.length, dPsnr, fEnc.length, fPsnr);
        }
        System.out.println("\nDELTA is worth building only if it needs clearly fewer bytes than FRESH");
        System.out.println("at the same PSNR. Equal or worse means zoom-in should just re-send.");
    }

    static double contrast() {
        double s = 0, s2 = 0;
        for (int i = 0; i < W * H; i++) {
            double l = 0.299 * target[0][i] + 0.587 * target[1][i] + 0.114 * target[2][i];
            s += l; s2 += l * l;
        }
        double m = s / (W * H);
        return Math.sqrt(Math.max(0, s2 / (W * H) - m * m));
    }

    static double psnr(float[][] a, float[][] b) {
        double e = 0;
        for (int c = 0; c < 3; c++)
            for (int i = 0; i < W * H; i++) { double d = a[c][i] - b[c][i]; e += d * d; }
        return 10 * Math.log10(1.0 / Math.max(1e-12, e / (3.0 * W * H)));
    }

    static float[][] toPlanar(BufferedImage img) {
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
        java.awt.Graphics2D g = out.createGraphics();
        g.setRenderingHint(java.awt.RenderingHints.KEY_INTERPOLATION,
                java.awt.RenderingHints.VALUE_INTERPOLATION_BILINEAR);
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
