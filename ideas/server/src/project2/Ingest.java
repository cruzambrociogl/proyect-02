package project2;

import javax.imageio.IIOImage;
import javax.imageio.ImageIO;
import javax.imageio.ImageReadParam;
import javax.imageio.ImageReader;
import javax.imageio.ImageWriteParam;
import javax.imageio.ImageWriter;
import javax.imageio.stream.ImageInputStream;
import javax.imageio.stream.ImageOutputStream;
import java.awt.Graphics2D;
import java.awt.Rectangle;
import java.awt.RenderingHints;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Iterator;

/**
 * One-time conversion of a source image into a ladder tile store on disk.
 *
 * This is what makes gigapixel images possible. The server never decodes the original:
 * it reads pre-rendered JPEG tiles straight off the filesystem, so its memory is flat no
 * matter how large the source is.
 *
 * The source is read in horizontal strips via {@code setSourceRegion}, one tile row at a
 * time, so peak memory is one strip (tens of MB) rather than the whole image (gigabytes).
 * Coarse levels additionally use {@code setSourceSubsampling} so the decoder skips pixels
 * it would only throw away.
 *
 *   java -cp build project2.Ingest ../images/eso1242a.tif
 *   java -cp build project2.Ingest ../images/eso1242a.tif --tile 256 --ratio 1.25 --q 0.85
 *
 * Output goes to  <images>/.tiles/<name>/  as meta.txt plus  <level>/<tx>_<ty>.jpg
 */
public final class Ingest {

    public static void main(String[] args) throws Exception {
        if (args.length < 1) {
            System.err.println("usage: java -cp build project2.Ingest <image> [--tile n] [--ratio r] [--q q]");
            System.exit(1);
        }
        Path src = Path.of(args[0]).toAbsolutePath().normalize();
        int tileSize = 256;
        double ratio = 1.25;
        float quality = 0.85f;
        for (int i = 1; i < args.length; i++) {
            switch (args[i]) {
                case "--tile" -> tileSize = Integer.parseInt(args[++i]);
                case "--ratio" -> ratio = Double.parseDouble(args[++i]);
                case "--q" -> quality = Float.parseFloat(args[++i]);
            }
        }
        if (!Files.isRegularFile(src)) { System.err.println("no such file: " + src); System.exit(1); }

        Path outDir = src.getParent().resolve(".tiles").resolve(src.getFileName().toString());
        Files.createDirectories(outDir);

        long started = System.nanoTime();
        try (ImageInputStream iis = ImageIO.createImageInputStream(src.toFile())) {
            Iterator<ImageReader> readers = ImageIO.getImageReaders(iis);
            if (!readers.hasNext()) { System.err.println("no reader for " + src); System.exit(1); }
            ImageReader reader = readers.next();
            reader.setInput(iis);

            int W = reader.getWidth(0), H = reader.getHeight(0);
            double maxScale = Math.max(W, H) / (double) tileSize;
            int maxLevel = Math.max(0, (int) Math.ceil(Math.log(maxScale) / Math.log(ratio)));

            System.out.printf("source   %s%n", src.getFileName());
            System.out.printf("size     %dx%d  (%.1f MP)%n", W, H, W * (long) H / 1e6);
            System.out.printf("tiles    %dpx, ladder ratio %.2f, levels 0..%d, jpeg q%.2f%n",
                    tileSize, ratio, maxLevel, quality);
            System.out.printf("output   %s%n%n", outDir);

            long totalTiles = 0, totalBytes = 0;
            for (int level = 0; level <= maxLevel; level++) {
                double ls = Math.pow(ratio, level);
                int levelW = (int) Math.ceil(W / ls), levelH = (int) Math.ceil(H / ls);
                if (levelW < 1 || levelH < 1) break;
                int tilesX = (levelW + tileSize - 1) / tileSize;
                int tilesY = (levelH + tileSize - 1) / tileSize;

                // Integer subsampling does the bulk of the reduction inside the decoder;
                // the leftover fractional factor is handled by scaling the strip.
                int sub = Math.max(1, (int) Math.floor(ls));

                Path levelDir = outDir.resolve(String.valueOf(level));
                Files.createDirectories(levelDir);

                long levelTiles = 0, levelBytes = 0;
                long t0 = System.nanoTime();
                for (int ty = 0; ty < tilesY; ty++) {
                    int rowH = Math.min(tileSize, levelH - ty * tileSize);
                    int y0 = (int) Math.floor(ty * tileSize * ls);
                    int y1 = (int) Math.min(H, Math.ceil((ty * tileSize + rowH) * ls));
                    if (y1 <= y0) continue;

                    ImageReadParam p = reader.getDefaultReadParam();
                    p.setSourceRegion(new Rectangle(0, y0, W, y1 - y0));
                    if (sub > 1) p.setSourceSubsampling(sub, sub, 0, 0);
                    BufferedImage strip = reader.read(0, p);

                    // Bring the strip to exactly this level's resolution.
                    BufferedImage row = (strip.getWidth() == levelW && strip.getHeight() == rowH)
                            ? strip : resize(strip, levelW, rowH);
                    strip = null;

                    for (int tx = 0; tx < tilesX; tx++) {
                        int tw = Math.min(tileSize, levelW - tx * tileSize);
                        if (tw < 1) continue;
                        BufferedImage tile = row.getSubimage(tx * tileSize, 0, tw, rowH);
                        byte[] jpeg = encode(tile, quality);
                        Files.write(levelDir.resolve(tx + "_" + ty + ".jpg"), jpeg);
                        levelTiles++;
                        levelBytes += jpeg.length;
                    }
                }
                double secs = (System.nanoTime() - t0) / 1e9;
                totalTiles += levelTiles;
                totalBytes += levelBytes;
                System.out.printf("level %-2d  %5dx%-5d  %4d tiles  %7.1f MB  %5.1f s%n",
                        level, levelW, levelH, levelTiles, levelBytes / 1048576.0, secs);
            }

            Files.writeString(outDir.resolve("meta.txt"), String.join("\n",
                    "width=" + W,
                    "height=" + H,
                    "tileSize=" + tileSize,
                    "ratio=" + ratio,
                    "maxLevel=" + maxLevel) + "\n");

            reader.dispose();
            System.out.printf("%ndone: %d tiles, %.1f MB, %.1f s%n",
                    totalTiles, totalBytes / 1048576.0, (System.nanoTime() - started) / 1e9);
            System.out.println("the server will now serve this image without decoding the original");
        }
    }

    private static BufferedImage resize(BufferedImage src, int w, int h) {
        BufferedImage out = new BufferedImage(Math.max(1, w), Math.max(1, h), BufferedImage.TYPE_INT_RGB);
        Graphics2D g = out.createGraphics();
        g.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BILINEAR);
        g.setRenderingHint(RenderingHints.KEY_RENDERING, RenderingHints.VALUE_RENDER_QUALITY);
        g.drawImage(src, 0, 0, out.getWidth(), out.getHeight(), null);
        g.dispose();
        return out;
    }

    private static byte[] encode(BufferedImage img, float quality) throws Exception {
        ImageWriter w = ImageIO.getImageWritersByFormatName("jpeg").next();
        ImageWriteParam p = w.getDefaultWriteParam();
        p.setCompressionMode(ImageWriteParam.MODE_EXPLICIT);
        p.setCompressionQuality(quality);
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        try (ImageOutputStream ios = ImageIO.createImageOutputStream(bos)) {
            w.setOutput(ios);
            // TIFF sources can carry alpha or odd colour models; JPEG needs plain RGB.
            w.write(null, new IIOImage(toRgb(img), null, null), p);
        } finally {
            w.dispose();
        }
        return bos.toByteArray();
    }

    private static BufferedImage toRgb(BufferedImage img) {
        if (img.getType() == BufferedImage.TYPE_INT_RGB) return img;
        BufferedImage out = new BufferedImage(img.getWidth(), img.getHeight(), BufferedImage.TYPE_INT_RGB);
        Graphics2D g = out.createGraphics();
        g.drawImage(img, 0, 0, null);
        g.dispose();
        return out;
    }

    private Ingest() {}
}
