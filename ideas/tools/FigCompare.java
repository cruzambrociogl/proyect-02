// Figure 1: splats vs JPEG at EQUAL BYTES, side by side.
//
// The fairest single picture of why splats lost: give JPEG the same byte budget the splat
// reconstruction used, and compare what each delivers. Quality is binary-searched so the
// JPEG lands as close to the splat byte count as the encoder allows.
//
// Panels are upscaled with NEAREST neighbour on purpose - bilinear would smooth away the
// very artifacts the figure exists to show.
//
// Java 21, no dependencies:
//   java tools/FigCompare.java --orig ~/img.jpg --x 1450 --y 600 --size 256 \
//        --recon out/hat/recon_04000.png --bin out/hat/splats.bin --out out/fig1_hat.png

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

public class FigCompare {

    public static void main(String[] args) throws Exception {
        String orig = null, recon = null, bin = null, out = "out/fig1.png", title = "";
        int cx = 0, cy = 0, size = 256, scale = 2, targetBytes = -1;

        for (int i = 0; i < args.length; i++) {
            switch (args[i]) {
                case "--orig" -> orig = args[++i];
                case "--recon" -> recon = args[++i];
                case "--bin" -> bin = args[++i];
                case "--out" -> out = args[++i];
                case "--title" -> title = args[++i];
                case "--x" -> cx = Integer.parseInt(args[++i]);
                case "--y" -> cy = Integer.parseInt(args[++i]);
                case "--size" -> size = Integer.parseInt(args[++i]);
                case "--scale" -> scale = Integer.parseInt(args[++i]);
                case "--bytes" -> targetBytes = Integer.parseInt(args[++i]);
            }
        }
        if (orig == null || recon == null) { System.err.println("need --orig and --recon"); return; }
        if (targetBytes < 0 && bin != null) targetBytes = (int) new File(bin).length();

        BufferedImage src = ImageIO.read(new File(orig));
        BufferedImage target = src.getSubimage(cx, cy, size, size);
        BufferedImage splat = ImageIO.read(new File(recon));

        // Binary search JPEG quality for the same byte budget.
        float lo = 0.05f, hi = 1.0f, bestQ = 0.5f;
        byte[] best = jpeg(target, bestQ);
        for (int it = 0; it < 20; it++) {
            float mid = (lo + hi) / 2;
            byte[] enc = jpeg(target, mid);
            if (Math.abs(enc.length - targetBytes) < Math.abs(best.length - targetBytes)) { best = enc; bestQ = mid; }
            if (enc.length > targetBytes) hi = mid; else lo = mid;
        }
        BufferedImage jpg = ImageIO.read(new ByteArrayInputStream(best));

        double psnrSplat = psnr(splat, target), psnrJpeg = psnr(jpg, target);
        System.out.printf("splat: %d B -> %.2f dB   |   jpeg q=%.2f: %d B -> %.2f dB%n",
                targetBytes, psnrSplat, bestQ, best.length, psnrJpeg);

        // Compose the figure.
        int s = size * scale, gap = 20, top = title.isEmpty() ? 34 : 60, bottom = 46;
        BufferedImage fig = new BufferedImage(3 * s + 4 * gap, top + s + bottom, BufferedImage.TYPE_INT_RGB);
        Graphics2D g = fig.createGraphics();
        g.setColor(Color.WHITE);
        g.fillRect(0, 0, fig.getWidth(), fig.getHeight());
        g.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_NEAREST_NEIGHBOR);
        g.setRenderingHint(RenderingHints.KEY_TEXT_ANTIALIASING, RenderingHints.VALUE_TEXT_ANTIALIAS_ON);

        if (!title.isEmpty()) {
            g.setColor(Color.BLACK);
            g.setFont(new Font("SansSerif", Font.BOLD, 18));
            g.drawString(title, gap, 26);
        }

        double px = size * (double) size;
        String[] labels = {
                "original",
                String.format("splats  -  %.1f KB = %.2f bpp  -  %.1f dB",
                        targetBytes / 1024.0, targetBytes * 8 / px, psnrSplat),
                String.format("JPEG (same bytes)  -  %.1f KB = %.2f bpp  -  %.1f dB",
                        best.length / 1024.0, best.length * 8 / px, psnrJpeg)
        };
        BufferedImage[] panels = {target, splat, jpg};
        g.setFont(new Font("SansSerif", Font.PLAIN, 15));
        for (int i = 0; i < 3; i++) {
            int x = gap + i * (s + gap);
            g.drawImage(panels[i], x, top, s, s, null);
            g.setColor(new Color(60, 60, 60));
            g.drawRect(x, top, s, s);
            g.setColor(Color.BLACK);
            g.drawString(labels[i], x, top + s + 22);
        }
        g.setColor(new Color(90, 90, 90));
        g.setFont(new Font("SansSerif", Font.ITALIC, 13));
        g.drawString("Same byte budget for both. Panels magnified " + scale + "x (nearest neighbour).",
                gap, top + s + 40);
        g.dispose();

        new File(out).getParentFile().mkdirs();
        ImageIO.write(fig, "png", new File(out));
        System.out.println("wrote " + out);
    }

    static double psnr(BufferedImage a, BufferedImage b) {
        int w = Math.min(a.getWidth(), b.getWidth()), h = Math.min(a.getHeight(), b.getHeight());
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

    static byte[] jpeg(BufferedImage img, float quality) throws Exception {
        ImageWriter w = ImageIO.getImageWritersByFormatName("jpeg").next();
        ImageWriteParam p = w.getDefaultWriteParam();
        p.setCompressionMode(ImageWriteParam.MODE_EXPLICIT);
        p.setCompressionQuality(Math.max(0.05f, Math.min(1f, quality)));
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        try (ImageOutputStream ios = ImageIO.createImageOutputStream(bos)) {
            w.setOutput(ios);
            w.write(null, new IIOImage(img, null, null), p);
        }
        w.dispose();
        return bos.toByteArray();
    }
}
