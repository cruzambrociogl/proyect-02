// Figure 3: the hybrid proposal, drawn - five panels at MATCHED QUALITY.
//
// Each method's JPEG quality is binary-searched until all panels land at the same PSNR, so
// the pictures look alike and the only thing that differs is the byte label underneath.
// That is the point: three ways to deliver the same image, costing 49 KB, 2.8 KB and 7.1 KB.
//
// Panels: original | splat base alone | splat base + residual | free predictor + residual | plain JPEG
//
// Java 21, no dependencies:
//   java tools/FigHybrid.java --orig ~/face1.jpg --x 1450 --y 600 --size 256 \
//        --base out/hat/recon_04000.png --basebytes 44000 --target 30.7 --out out/fig3_hat.png

import javax.imageio.IIOImage;
import javax.imageio.ImageIO;
import javax.imageio.ImageWriteParam;
import javax.imageio.ImageWriter;
import javax.imageio.stream.ImageOutputStream;
import java.awt.Color;
import java.awt.Font;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;

public class FigHybrid {

    static int W, H;
    static float[][] t, sb, cp;
    static BufferedImage target;
    static int baseBytes;

    record Res(BufferedImage img, int bytes, int residBytes, double psnr) {}

    public static void main(String[] args) throws Exception {
        String orig = null, base = null, out = "out/fig3.png", title = "";
        int cx = 0, cy = 0, size = 256, scale = 2;
        double targetPsnr = 30.7;

        for (int i = 0; i < args.length; i++) {
            switch (args[i]) {
                case "--orig" -> orig = args[++i];
                case "--base" -> base = args[++i];
                case "--basebytes" -> baseBytes = Integer.parseInt(args[++i]);
                case "--out" -> out = args[++i];
                case "--title" -> title = args[++i];
                case "--x" -> cx = Integer.parseInt(args[++i]);
                case "--y" -> cy = Integer.parseInt(args[++i]);
                case "--size" -> size = Integer.parseInt(args[++i]);
                case "--scale" -> scale = Integer.parseInt(args[++i]);
                case "--target" -> targetPsnr = Double.parseDouble(args[++i]);
            }
        }
        if (orig == null || base == null) { System.err.println("need --orig and --base"); return; }

        BufferedImage src = ImageIO.read(new File(orig));
        target = src.getSubimage(cx, cy, size, size);
        W = target.getWidth(); H = target.getHeight();
        BufferedImage splatBase = ImageIO.read(new File(base));

        t = planar(target);
        sb = planar(splatBase);
        cp = planar(bilinearUp(boxDown(target, 2), W, H));

        Res hyb = search(targetPsnr, 0), del = search(targetPsnr, 1), fresh = search(targetPsnr, 2);
        double basePsnr = psnr(sb, t);

        System.out.printf("matched at ~%.1f dB:  hybrid %.1f KB  |  delta %.1f KB  |  fresh %.1f KB%n",
                targetPsnr, hyb.bytes / 1024.0, del.bytes / 1024.0, fresh.bytes / 1024.0);

        BufferedImage[] panels = {target, splatBase, hyb.img, del.img, fresh.img};
        double px = W * (double) H;
        String[] labels = {
                "original",
                String.format("splat base alone  -  %.1f KB = %.2f bpp  -  %.1f dB",
                        baseBytes / 1024.0, baseBytes * 8 / px, basePsnr),
                String.format("splats + residual  -  %.1f KB total  (residual %.3f bpp)  -  %.1f dB",
                        hyb.bytes / 1024.0, hyb.residBytes * 8 / px, hyb.psnr),
                String.format("free predictor + residual  -  %.1f KB  (residual %.3f bpp)  -  %.1f dB",
                        del.bytes / 1024.0, del.residBytes * 8 / px, del.psnr),
                String.format("plain JPEG  -  %.1f KB = %.3f bpp  -  %.1f dB",
                        fresh.bytes / 1024.0, fresh.bytes * 8 / px, fresh.psnr)
        };

        int s = size * scale, gap = 18, top = title.isEmpty() ? 34 : 62, bottom = 50;
        BufferedImage fig = new BufferedImage(5 * s + 6 * gap, top + s + bottom, BufferedImage.TYPE_INT_RGB);
        Graphics2D g = fig.createGraphics();
        g.setColor(Color.WHITE);
        g.fillRect(0, 0, fig.getWidth(), fig.getHeight());
        g.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_NEAREST_NEIGHBOR);
        g.setRenderingHint(RenderingHints.KEY_TEXT_ANTIALIASING, RenderingHints.VALUE_TEXT_ANTIALIAS_ON);

        if (!title.isEmpty()) {
            g.setColor(Color.BLACK);
            g.setFont(new Font("SansSerif", Font.BOLD, 19));
            g.drawString(title, gap, 28);
        }
        g.setFont(new Font("SansSerif", Font.PLAIN, 14));
        for (int i = 0; i < panels.length; i++) {
            int x = gap + i * (s + gap);
            g.drawImage(panels[i], x, top, s, s, null);
            g.setColor(new Color(70, 70, 70));
            g.drawRect(x, top, s, s);
            g.setColor(i == 1 ? new Color(170, 30, 30) : Color.BLACK);
            g.drawString(labels[i], x, top + s + 22);
        }
        g.setColor(new Color(90, 90, 90));
        g.setFont(new Font("SansSerif", Font.ITALIC, 13));
        g.drawString("Last three panels are the same quality - only the price differs. "
                + "The splat base costs more than the entire image and predicts worse than the free option.",
                gap, top + s + 44);
        g.dispose();

        new File(out).getParentFile().mkdirs();
        ImageIO.write(fig, "png", new File(out));
        System.out.println("wrote " + out);
    }

    /** Binary-search JPEG quality until this method lands on the target PSNR. mode: 0 hybrid, 1 delta, 2 fresh. */
    static Res search(double targetPsnr, int mode) throws Exception {
        float lo = 0.05f, hi = 0.99f;
        Res best = eval(0.5f, mode);
        for (int i = 0; i < 18; i++) {
            float mid = (lo + hi) / 2;
            Res r = eval(mid, mode);
            if (Math.abs(r.psnr - targetPsnr) < Math.abs(best.psnr - targetPsnr)) best = r;
            if (r.psnr > targetPsnr) hi = mid; else lo = mid;
        }
        return best;
    }

    static Res eval(float q, int mode) throws Exception {
        if (mode == 2) {
            byte[] enc = jpeg(target, q);
            BufferedImage img = ImageIO.read(new ByteArrayInputStream(enc));
            return new Res(img, enc.length, enc.length, psnr(planar(img), t));
        }
        float[][] pred = (mode == 0) ? sb : cp;
        byte[] enc = jpeg(residual(t, pred), q);
        float[][] dec = planar(ImageIO.read(new ByteArrayInputStream(enc)));
        float[][] rec = new float[3][W * H];
        BufferedImage img = new BufferedImage(W, H, BufferedImage.TYPE_INT_RGB);
        for (int y = 0; y < H; y++)
            for (int x = 0; x < W; x++) {
                int i = y * W + x, v = 0;
                for (int c = 0; c < 3; c++) {
                    rec[c][i] = clamp01(pred[c][i] + (dec[c][i] - 0.5f) * 2f);
                    v |= Math.round(rec[c][i] * 255) << (16 - 8 * c);
                }
                img.setRGB(x, y, v);
            }
        return new Res(img, (mode == 0 ? baseBytes : 0) + enc.length, enc.length, psnr(rec, t));
    }

    static BufferedImage residual(float[][] a, float[][] p) {
        BufferedImage out = new BufferedImage(W, H, BufferedImage.TYPE_INT_RGB);
        for (int y = 0; y < H; y++)
            for (int x = 0; x < W; x++) {
                int i = y * W + x, v = 0;
                for (int c = 0; c < 3; c++)
                    v |= clamp8(Math.round((a[c][i] - p[c][i]) * 127.5f + 127.5f)) << (16 - 8 * c);
                out.setRGB(x, y, v);
            }
        return out;
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
        p.setCompressionQuality(Math.max(0.05f, Math.min(0.99f, quality)));
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
