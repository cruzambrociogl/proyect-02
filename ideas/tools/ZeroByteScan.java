// How much of a real image never needs its deepest level sent at all?
//
// The zero-byte rule: when the client zooms in, it already holds the coarser level and can
// upscale it. If that upscaled predictor is already visually indistinguishable from the
// true detail, the correct action is to send NOTHING. This measures how often that happens
// and - the number that actually matters - how many BYTES it saves.
//
// The trap this guards against: regions where the predictor is good are smooth regions,
// and smooth regions are cheap to code anyway. So skipping 60% of regions does NOT save
// 60% of bytes. Both figures are reported; the byte figure is the honest one.
//
// Java 21, no dependencies:
//   java tools/ZeroByteScan.java image.jpg [--region 128] [--q 0.6] [--max 4096]

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
import java.util.Arrays;

public class ZeroByteScan {

    public static void main(String[] args) throws Exception {
        String path = null;
        int region = 128, max = 4096;
        float q = 0.6f;
        for (int i = 0; i < args.length; i++) {
            switch (args[i]) {
                case "--region" -> region = Integer.parseInt(args[++i]);
                case "--q" -> q = Float.parseFloat(args[++i]);
                case "--max" -> max = Integer.parseInt(args[++i]);
                default -> { if (!args[i].startsWith("--")) path = args[i]; }
            }
        }
        if (path == null) { System.err.println("usage: java ZeroByteScan.java <image> [--region --q --max]"); return; }

        BufferedImage src = ImageIO.read(new File(path));
        int w = Math.min(src.getWidth(), max) / region * region;
        int h = Math.min(src.getHeight(), max) / region * region;
        BufferedImage img = src.getSubimage(0, 0, w, h);

        // What the client already has one zoom step out, and what it can display from it.
        BufferedImage predictor = bilinearUp(boxDown(img, 2), w, h);

        int rx = w / region, ry = h / region, n = rx * ry;
        double[] psnr = new double[n];
        int[] bytes = new int[n];
        long totalBytes = 0;

        for (int i = 0; i < n; i++) {
            int ox = (i % rx) * region, oy = (i / rx) * region;
            BufferedImage t = img.getSubimage(ox, oy, region, region);
            psnr[i] = psnrOf(t, predictor.getSubimage(ox, oy, region, region));
            bytes[i] = jpeg(t, q).length;
            totalBytes += bytes[i];
        }

        System.out.printf("%s  %dx%d  regions=%d of %dpx  q=%.2f%n", path, w, h, n, region, q);
        double[] s = psnr.clone();
        Arrays.sort(s);
        System.out.printf("predictor PSNR per region: p10=%.1f  p50=%.1f  p90=%.1f dB%n",
                s[n / 10], s[n / 2], s[n * 9 / 10]);
        System.out.printf("cost to send every region fresh: %.1f KB%n%n", totalBytes / 1024.0);

        System.out.printf("%-12s %-14s %-16s %-14s%n",
                "threshold", "regions saved", "of all regions", "BYTES saved");
        for (double th : new double[]{34, 36, 38, 40, 42}) {
            int cnt = 0;
            long saved = 0;
            for (int i = 0; i < n; i++)
                if (psnr[i] >= th) { cnt++; saved += bytes[i]; }
            System.out.printf("%-12s %-14d %-16s %-14s%n",
                    String.format(">= %.0f dB", th), cnt,
                    String.format("%.1f%%", 100.0 * cnt / n),
                    String.format("%.1f%%  (%.1f KB)", 100.0 * saved / totalBytes, saved / 1024.0));
        }
        System.out.println("\nRegions saved > bytes saved is expected: skippable regions are smooth,");
        System.out.println("and smooth regions were cheap to code in the first place.");
    }

    static double psnrOf(BufferedImage a, BufferedImage b) {
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
