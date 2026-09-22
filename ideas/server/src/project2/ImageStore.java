package project2;

import javax.imageio.IIOImage;
import javax.imageio.ImageIO;
import javax.imageio.ImageWriteParam;
import javax.imageio.ImageWriter;
import javax.imageio.stream.ImageOutputStream;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Holds the image and renders ladder tiles on demand.
 *
 * Levels follow a geometric ladder: level L has scale ratio^L source pixels per tile pixel.
 * With ratio 1.25 the client downscales by at most 1.25 (1.56x area waste) instead of the
 * up-to-4x waste a power-of-two pyramid forces. Internally we still keep power-of-two mips
 * to sample from cheaply, then resize to the exact ladder scale.
 */
public final class ImageStore implements Source {

    private final BufferedImage[] mips;       // mips[i] = source downscaled by 2^i
    private final int tileSize;
    private final double ratio;
    private final float quality;
    private final int maxLevel;

    /** Encoded tiles, shared by every client. LRU-bounded. */
    private final Map<String, byte[]> cache = new LinkedHashMap<>(256, 0.75f, true) {
        @Override protected boolean removeEldestEntry(Map.Entry<String, byte[]> eldest) {
            return size() > 2048;
        }
    };

    public ImageStore(Path file, int tileSize, double ratio, float quality) throws Exception {
        BufferedImage src = ImageIO.read(file.toFile());
        if (src == null) throw new IllegalArgumentException("cannot read image: " + file);
        this.tileSize = tileSize;
        this.ratio = ratio;
        this.quality = quality;

        List<BufferedImage> list = new ArrayList<>();
        list.add(src);
        while (list.get(list.size() - 1).getWidth() > 2 * tileSize
                && list.get(list.size() - 1).getHeight() > 2 * tileSize) {
            list.add(halve(list.get(list.size() - 1)));
        }
        this.mips = list.toArray(new BufferedImage[0]);

        // Coarsest useful ladder level: the whole image fits in roughly one tile.
        double maxScale = Math.max(src.getWidth(), src.getHeight()) / (double) tileSize;
        this.maxLevel = Math.max(0, (int) Math.ceil(Math.log(maxScale) / Math.log(ratio)));
    }

    public int width() { return mips[0].getWidth(); }
    public int height() { return mips[0].getHeight(); }
    public int tileSize() { return tileSize; }
    public double ratio() { return ratio; }
    public int maxLevel() { return maxLevel; }

    /** Source pixels per tile pixel at this ladder level. */
    public double ladderScale(int level) { return Math.pow(ratio, level); }

    public int levelWidth(int level) { return (int) Math.ceil(width() / ladderScale(level)); }
    public int levelHeight(int level) { return (int) Math.ceil(height() / ladderScale(level)); }

    /** JPEG bytes for one tile, rendering and caching on first request. */
    public byte[] tile(int level, int tx, int ty) throws Exception {
        String key = level + ":" + tx + ":" + ty;
        synchronized (cache) {
            byte[] hit = cache.get(key);
            if (hit != null) return hit;
        }

        double ls = ladderScale(level);
        int lw = levelWidth(level), lh = levelHeight(level);
        int lx = tx * tileSize, ly = ty * tileSize;
        if (lx >= lw || ly >= lh) return null;
        int outW = Math.min(tileSize, lw - lx), outH = Math.min(tileSize, lh - ly);

        BufferedImage img = sample(lx * ls, ly * ls, outW * ls, outH * ls, outW, outH);
        byte[] jpeg = encode(img);

        synchronized (cache) { cache.put(key, jpeg); }
        return jpeg;
    }

    /** Crop from the cheapest mip that still has enough detail, then resize to exact size. */
    private BufferedImage sample(double x, double y, double w, double h, int outW, int outH) {
        double scale = w / Math.max(1, outW);
        int m = Math.max(0, Math.min(mips.length - 1, (int) Math.floor(log2(Math.max(1, scale)))));
        BufferedImage level = mips[m];
        double f = 1.0 / (1 << m);

        int sx = clamp((int) Math.round(x * f), 0, level.getWidth() - 1);
        int sy = clamp((int) Math.round(y * f), 0, level.getHeight() - 1);
        int sw = clamp((int) Math.round(w * f), 1, level.getWidth() - sx);
        int sh = clamp((int) Math.round(h * f), 1, level.getHeight() - sy);

        BufferedImage crop = level.getSubimage(sx, sy, sw, sh);
        if (sw == outW && sh == outH) return crop;

        BufferedImage out = new BufferedImage(outW, outH, BufferedImage.TYPE_INT_RGB);
        Graphics2D g = out.createGraphics();
        g.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BILINEAR);
        g.setRenderingHint(RenderingHints.KEY_RENDERING, RenderingHints.VALUE_RENDER_QUALITY);
        g.drawImage(crop, 0, 0, outW, outH, null);
        g.dispose();
        return out;
    }

    private byte[] encode(BufferedImage img) throws Exception {
        ImageWriter w = ImageIO.getImageWritersByFormatName("jpeg").next();
        ImageWriteParam p = w.getDefaultWriteParam();
        p.setCompressionMode(ImageWriteParam.MODE_EXPLICIT);
        p.setCompressionQuality(quality);
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        try (ImageOutputStream ios = ImageIO.createImageOutputStream(bos)) {
            w.setOutput(ios);
            w.write(null, new IIOImage(img, null, null), p);
        } finally {
            w.dispose();
        }
        return bos.toByteArray();
    }

    private static BufferedImage halve(BufferedImage src) {
        int w = src.getWidth() / 2, h = src.getHeight() / 2;
        BufferedImage out = new BufferedImage(w, h, BufferedImage.TYPE_INT_RGB);
        for (int y = 0; y < h; y++)
            for (int x = 0; x < w; x++) {
                int a = src.getRGB(x * 2, y * 2), b = src.getRGB(x * 2 + 1, y * 2);
                int c = src.getRGB(x * 2, y * 2 + 1), d = src.getRGB(x * 2 + 1, y * 2 + 1);
                int r = (((a >> 16) & 255) + ((b >> 16) & 255) + ((c >> 16) & 255) + ((d >> 16) & 255)) / 4;
                int g = (((a >> 8) & 255) + ((b >> 8) & 255) + ((c >> 8) & 255) + ((d >> 8) & 255)) / 4;
                int bl = ((a & 255) + (b & 255) + (c & 255) + (d & 255)) / 4;
                out.setRGB(x, y, (r << 16) | (g << 8) | bl);
            }
        return out;
    }

    private static double log2(double v) { return Math.log(v) / Math.log(2); }
    private static int clamp(int v, int lo, int hi) { return Math.max(lo, Math.min(hi, v)); }
}
