// Figure 2: the zero-byte rule, drawn.
//
// Tints every region whose deepest level never needs to be sent - because the client's own
// upscale of the coarser level is already above the visibility threshold. The caption
// carries both numbers that matter: regions skipped, and (the honest one) bytes saved.
//
// Java 21, no dependencies:
//   java tools/SkipMap.java image.jpg --region 128 --threshold 38 --out out/fig2_skipmap.png

import javax.imageio.IIOImage;
import javax.imageio.ImageIO;
import javax.imageio.ImageWriteParam;
import javax.imageio.ImageWriter;
import javax.imageio.stream.ImageOutputStream;
import java.awt.AlphaComposite;
import java.awt.Color;
import java.awt.Font;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.io.File;

public class SkipMap {

    public static void main(String[] args) throws Exception {
        String path = null, out = "out/fig2_skipmap.png";
        int region = 128, max = 4096, viewH = 1000;
        double threshold = 38;
        float q = 0.6f;

        for (int i = 0; i < args.length; i++) {
            switch (args[i]) {
                case "--region" -> region = Integer.parseInt(args[++i]);
                case "--threshold" -> threshold = Double.parseDouble(args[++i]);
                case "--q" -> q = Float.parseFloat(args[++i]);
                case "--max" -> max = Integer.parseInt(args[++i]);
                case "--view" -> viewH = Integer.parseInt(args[++i]);
                case "--out" -> out = args[++i];
                default -> { if (!args[i].startsWith("--")) path = args[i]; }
            }
        }
        if (path == null) { System.err.println("usage: java SkipMap.java <image> [opts]"); return; }

        BufferedImage src = ImageIO.read(new File(path));
        int w = Math.min(src.getWidth(), max) / region * region;
        int h = Math.min(src.getHeight(), max) / region * region;
        BufferedImage img = src.getSubimage(0, 0, w, h);
        BufferedImage predictor = bilinearUp(boxDown(img, 2), w, h);

        int rx = w / region, ry = h / region, n = rx * ry;
        boolean[] skip = new boolean[n];
        long total = 0, saved = 0;
        int skipped = 0;
        for (int i = 0; i < n; i++) {
            int ox = (i % rx) * region, oy = (i / rx) * region;
            BufferedImage t = img.getSubimage(ox, oy, region, region);
            double p = psnr(t, predictor.getSubimage(ox, oy, region, region));
            int bytes = jpeg(t, q).length;
            total += bytes;
            if (p >= threshold) { skip[i] = true; skipped++; saved += bytes; }
        }

        // Draw: tint skipped regions, grid the rest.
        BufferedImage canvas = new BufferedImage(w, h, BufferedImage.TYPE_INT_RGB);
        Graphics2D g = canvas.createGraphics();
        g.drawImage(img, 0, 0, null);
        for (int i = 0; i < n; i++) {
            int ox = (i % rx) * region, oy = (i / rx) * region;
            if (skip[i]) {
                g.setComposite(AlphaComposite.getInstance(AlphaComposite.SRC_OVER, 0.45f));
                g.setColor(new Color(0, 190, 120));
                g.fillRect(ox, oy, region, region);
                g.setComposite(AlphaComposite.SrcOver);
            }
            g.setColor(new Color(255, 255, 255, 60));
            g.drawRect(ox, oy, region, region);
        }
        g.dispose();

        // Scale down to something viewable, then add a caption bar.
        int viewW = (int) Math.round(w * (viewH / (double) h));
        int capH = 74;
        BufferedImage fig = new BufferedImage(viewW, viewH + capH, BufferedImage.TYPE_INT_RGB);
        Graphics2D f = fig.createGraphics();
        f.setColor(Color.WHITE);
        f.fillRect(0, 0, fig.getWidth(), fig.getHeight());
        f.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BILINEAR);
        f.setRenderingHint(RenderingHints.KEY_TEXT_ANTIALIASING, RenderingHints.VALUE_TEXT_ANTIALIAS_ON);
        f.drawImage(canvas, 0, 0, viewW, viewH, null);

        f.setColor(Color.BLACK);
        f.setFont(new Font("SansSerif", Font.BOLD, 16));
        f.drawString(String.format("Green = never sent at full resolution (predictor already >= %.0f dB)", threshold),
                12, viewH + 24);
        f.setFont(new Font("SansSerif", Font.PLAIN, 15));
        f.drawString(String.format("%d of %d regions skipped (%.1f%%)   |   bytes saved: %.1f%%  (%.0f KB of %.0f KB)",
                        skipped, n, 100.0 * skipped / n, 100.0 * saved / total, saved / 1024.0, total / 1024.0),
                12, viewH + 46);
        f.setColor(new Color(90, 90, 90));
        f.setFont(new Font("SansSerif", Font.ITALIC, 13));
        f.drawString("Fewer bytes saved than regions skipped: skipped regions are smooth, and smooth regions were cheap anyway.",
                12, viewH + 66);
        f.dispose();

        new File(out).getParentFile().mkdirs();
        ImageIO.write(fig, "png", new File(out));
        System.out.printf("%d/%d regions (%.1f%%), %.1f%% of bytes -> %s%n",
                skipped, n, 100.0 * skipped / n, 100.0 * saved / total, out);
    }

    static double psnr(BufferedImage a, BufferedImage b) {
        int w = a.getWidth(), h = a.getHeight();
        double e = 0;
        for (int y = 0; y < h; y++)
            for (int x = 0; x < w; x++) {
                int p = a.getRGB(x, y), r = b.getRGB(x, y);
                for (int c = 0; c < 3; c++) {
                    double d = (((p >> (16 - 8 * c)) & 255) - ((r >> (16 - 8 * c)) & 255)) / 255.0;
                    e += d * d;
                }
            }
        return 10 * Math.log10(1.0 / Math.max(1e-12, e / (3.0 * w * h)));
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
}
