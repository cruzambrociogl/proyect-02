package p2.media;

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
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Properties;

/**
 * The default image method: a ladder of downscaled levels, each cut into square JPEG tiles.
 *
 * Levels step by {@code ratio} (1.25) rather than the usual 2. A finer ladder means the level
 * the viewer picks is closer to what the screen actually shows, so less resolution is
 * downloaded and thrown away; the cost is more levels to store.
 *
 * Preparation reads the source in horizontal strips ({@code setSourceRegion}), so peak memory
 * is one strip rather than the whole image, and asks the decoder to subsample by the integer
 * part of the reduction ({@code setSourceSubsampling}) so it never decodes pixels that are
 * about to be thrown away. Serving then touches only small files: the server never decodes
 * the source again, and its memory does not grow with image size.
 */
public final class LadderTiles implements ImageMethod {

    public static final String ID = "ladder-tiles";
    private static final String META = "meta.properties";
    static final String PREVIEW = "preview.jpg";

    private final int tileSize;
    private final double ratio;
    private final float quality;

    public LadderTiles() { this(256, 1.25, 0.85f); }

    public LadderTiles(int tileSize, double ratio, float quality) {
        this.tileSize = tileSize;
        this.ratio = ratio;
        this.quality = quality;
    }

    @Override public String id() { return ID; }

    @Override public boolean isPrepared(Path dir) { return Files.isRegularFile(dir.resolve(META)); }

    // ---------------------------------------------------------------- preparation

    @Override
    public void prepare(Path source, Path dir, Progress progress) throws IOException {
        Files.createDirectories(dir);
        Files.deleteIfExists(dir.resolve(META));          // half-finished until the meta lands

        try (ImageInputStream in = ImageIO.createImageInputStream(source.toFile())) {
            if (in == null) throw new IOException("cannot read " + source.getFileName());
            Iterator<ImageReader> readers = ImageIO.getImageReaders(in);
            if (!readers.hasNext()) throw new IOException("no decoder for " + source.getFileName());
            ImageReader reader = readers.next();
            reader.setInput(in);
            try {
                int w = reader.getWidth(0), h = reader.getHeight(0);
                int maxLevel = maxLevel(w, h);
                long totalTiles = countTiles(w, h, maxLevel), done = 0;
                int units = 0;
                long bytes = 0;

                for (int level = 0; level <= maxLevel; level++) {
                    double ls = Math.pow(ratio, level);
                    int lw = (int) Math.ceil(w / ls), lh = (int) Math.ceil(h / ls);
                    int cols = cols(lw), rows = cols(lh);
                    Path levelDir = dir.resolve(String.valueOf(level));
                    Files.createDirectories(levelDir);
                    int sub = Math.max(1, (int) Math.floor(ls));

                    for (int row = 0; row < rows; row++) {
                        int stripH = Math.min(tileSize, lh - row * tileSize);
                        int y0 = (int) Math.floor(row * tileSize * ls);
                        int y1 = (int) Math.min(h, Math.ceil((row * tileSize + stripH) * ls));
                        if (y1 <= y0) continue;

                        ImageReadParam param = reader.getDefaultReadParam();
                        param.setSourceRegion(new Rectangle(0, y0, w, y1 - y0));
                        if (sub > 1) param.setSourceSubsampling(sub, sub, 0, 0);
                        BufferedImage strip = reader.read(0, param);
                        if (strip.getWidth() != lw || strip.getHeight() != stripH) {
                            strip = scale(strip, lw, stripH);
                        }
                        for (int col = 0; col < cols; col++) {
                            int tw = Math.min(tileSize, lw - col * tileSize);
                            if (tw < 1) continue;
                            byte[] jpeg = encode(strip.getSubimage(col * tileSize, 0, tw, stripH));
                            Files.write(levelDir.resolve(col + "_" + row + ".jpg"), jpeg);
                            units++;
                            bytes += jpeg.length;
                            done++;
                        }
                        progress.step("level " + level, done, totalTiles);
                    }
                    if (level == previewLevel(w, h, maxLevel)) {
                        writePreview(dir, levelDir, cols, rows, lw, lh);
                    }
                }

                Properties meta = new Properties();
                meta.setProperty("method", ID);
                meta.setProperty("width", String.valueOf(w));
                meta.setProperty("height", String.valueOf(h));
                meta.setProperty("tileSize", String.valueOf(tileSize));
                meta.setProperty("ratio", String.valueOf(ratio));
                meta.setProperty("maxLevel", String.valueOf(maxLevel));
                meta.setProperty("units", String.valueOf(units));
                meta.setProperty("bytes", String.valueOf(bytes));
                try (var out = Files.newOutputStream(dir.resolve(META))) {
                    meta.store(out, "prepared by " + ID);
                }
                progress.step("done", totalTiles, totalTiles);
            } finally {
                reader.dispose();
            }
        }
    }

    /** The coarsest level, where the whole image fits in a single tile. */
    private int maxLevel(int w, int h) {
        double needed = Math.max(w, h) / (double) tileSize;
        return Math.max(0, (int) Math.ceil(Math.log(needed) / Math.log(ratio)));
    }

    private int cols(int px) { return (px + tileSize - 1) / tileSize; }

    private long countTiles(int w, int h, int maxLevel) {
        long n = 0;
        for (int level = 0; level <= maxLevel; level++) {
            double ls = Math.pow(ratio, level);
            n += (long) cols((int) Math.ceil(w / ls)) * cols((int) Math.ceil(h / ls));
        }
        return n;
    }

    /** A level small enough to stitch into one preview image without much work. */
    private int previewLevel(int w, int h, int maxLevel) {
        for (int level = 0; level <= maxLevel; level++) {
            double ls = Math.pow(ratio, level);
            if (Math.max(w / ls, h / ls) <= 1024) return level;
        }
        return maxLevel;
    }

    private void writePreview(Path dir, Path levelDir, int cols, int rows, int lw, int lh) throws IOException {
        BufferedImage canvas = new BufferedImage(lw, lh, BufferedImage.TYPE_INT_RGB);
        Graphics2D g = canvas.createGraphics();
        for (int row = 0; row < rows; row++) {
            for (int col = 0; col < cols; col++) {
                Path p = levelDir.resolve(col + "_" + row + ".jpg");
                if (Files.exists(p)) g.drawImage(ImageIO.read(p.toFile()), col * tileSize, row * tileSize, null);
            }
        }
        g.dispose();
        Files.write(dir.resolve(PREVIEW), encode(canvas));
    }

    private BufferedImage scale(BufferedImage src, int w, int h) {
        BufferedImage out = new BufferedImage(Math.max(1, w), Math.max(1, h), BufferedImage.TYPE_INT_RGB);
        Graphics2D g = out.createGraphics();
        g.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BILINEAR);
        g.setRenderingHint(RenderingHints.KEY_RENDERING, RenderingHints.VALUE_RENDER_QUALITY);
        g.drawImage(src, 0, 0, out.getWidth(), out.getHeight(), null);
        g.dispose();
        return out;
    }

    private byte[] encode(BufferedImage img) throws IOException {
        if (img.getType() != BufferedImage.TYPE_INT_RGB) {      // TIFF sources carry odd colour models
            BufferedImage rgb = new BufferedImage(img.getWidth(), img.getHeight(), BufferedImage.TYPE_INT_RGB);
            Graphics2D g = rgb.createGraphics();
            g.drawImage(img, 0, 0, null);
            g.dispose();
            img = rgb;
        }
        ImageWriter writer = ImageIO.getImageWritersByFormatName("jpeg").next();
        ImageWriteParam param = writer.getDefaultWriteParam();
        param.setCompressionMode(ImageWriteParam.MODE_EXPLICIT);
        param.setCompressionQuality(quality);
        ByteArrayOutputStream bos = new ByteArrayOutputStream(64 * 1024);
        try (ImageOutputStream out = ImageIO.createImageOutputStream(bos)) {
            writer.setOutput(out);
            writer.write(null, new IIOImage(img, null, null), param);
        } finally {
            writer.dispose();
        }
        return bos.toByteArray();
    }

    // ---------------------------------------------------------------- serving

    @Override
    public Served open(Path dir) throws IOException {
        Properties p = new Properties();
        try (var in = Files.newInputStream(dir.resolve(META))) {
            p.load(in);
        }
        return new TileStore(dir, new Meta(
                Integer.parseInt(p.getProperty("width")),
                Integer.parseInt(p.getProperty("height")),
                Integer.parseInt(p.getProperty("tileSize")),
                Double.parseDouble(p.getProperty("ratio")),
                Integer.parseInt(p.getProperty("maxLevel")),
                Integer.parseInt(p.getProperty("units")),
                Long.parseLong(p.getProperty("bytes"))));
    }

    /** Serves prepared tiles straight off the filesystem; holds no pixels of its own. */
    record TileStore(Path dir, Meta meta) implements Served {

        @Override public String unitContentType() { return "image/jpeg"; }

        /** Level whose pixels are at least as fine as the screen: the coarsest such level. */
        int levelFor(double scale) {
            int level = (int) Math.floor(Math.log(Math.max(scale, 1e-9)) / Math.log(meta.ratio()) + 1e-9);
            return Math.max(0, Math.min(meta.maxLevel(), level));
        }

        int levelWidth(int level) { return (int) Math.ceil(meta.width() / Math.pow(meta.ratio(), level)); }

        int levelHeight(int level) { return (int) Math.ceil(meta.height() / Math.pow(meta.ratio(), level)); }

        @Override
        public List<UnitId> unitsFor(Viewport v) {
            int level = levelFor(v.scale());
            double ls = Math.pow(meta.ratio(), level);
            int ts = meta.unitSize();
            double x0 = (v.cx() - v.screenW() * v.scale() / 2) / ls;
            double y0 = (v.cy() - v.screenH() * v.scale() / 2) / ls;
            double x1 = x0 + v.screenW() * v.scale() / ls;
            double y1 = y0 + v.screenH() * v.scale() / ls;

            int lastCol = (levelWidth(level) + ts - 1) / ts - 1;
            int lastRow = (levelHeight(level) + ts - 1) / ts - 1;
            int cx0 = Math.max(0, (int) Math.floor(x0 / ts));
            int cy0 = Math.max(0, (int) Math.floor(y0 / ts));
            int cx1 = Math.min(lastCol, (int) Math.ceil(x1 / ts) - 1);
            int cy1 = Math.min(lastRow, (int) Math.ceil(y1 / ts) - 1);

            List<UnitId> units = new ArrayList<>();
            for (int row = cy0; row <= cy1; row++) {
                for (int col = cx0; col <= cx1; col++) units.add(new UnitId(level, col, row));
            }
            // Nearest the centre of the screen first: that is what the viewer is looking at.
            units.sort(Comparator.comparingDouble(u -> {
                double px = (u.x() + 0.5) * ts * ls, py = (u.y() + 0.5) * ts * ls;
                return Math.hypot((px - v.cx()) / v.scale(), (py - v.cy()) / v.scale());
            }));
            return units;
        }

        @Override
        public byte[] bytes(UnitId id) throws IOException {
            return Files.readAllBytes(dir.resolve(String.valueOf(id.level())).resolve(id.x() + "_" + id.y() + ".jpg"));
        }

        /** Level sizes, for the viewer's information panel. */
        Map<String, Object> levelTable() {
            List<Object> levels = new ArrayList<>();
            for (int level = 0; level <= meta.maxLevel(); level++) {
                int lw = levelWidth(level), lh = levelHeight(level);
                levels.add(Map.of("level", level, "width", lw, "height", lh,
                        "tiles", ((lw + meta.unitSize() - 1) / meta.unitSize())
                                * ((lh + meta.unitSize() - 1) / meta.unitSize())));
            }
            return Map.of("levels", levels);
        }
    }
}
