package project2;

import javax.imageio.ImageIO;
import javax.imageio.ImageReader;
import javax.imageio.stream.ImageInputStream;
import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * The catalog of servable images.
 *
 * Requirement #6 of the brief: new images can be added to the server and served to any
 * client that asks for them. Adding one means dropping a file into the images directory
 * (or uploading it through the picker page) - no restart, no configuration.
 *
 * Dimensions are read from the file header only, never by decoding the image, so listing a
 * directory of gigapixel files costs milliseconds. Decoded ImageStores are built lazily on
 * first request and kept in a small LRU, because each one holds mip levels in memory.
 */
public final class ImageRegistry {

    /** What the picker page needs to show an entry. `ready` means it can be opened now. */
    public record Entry(String name, int width, int height, long bytes, boolean ready) {
        public long pixels() { return (long) width * height; }
    }

    private static final int MAX_LOADED = 2;

    /**
     * Above this, decoding the whole image into memory is not viable, so the image must be
     * ingested into a tile store first. Without this guard the server simply hangs on the
     * I/O thread chewing through hundreds of megapixels.
     */
    private static final long MAX_LIVE_PIXELS = 80_000_000L;

    private final Path dir;
    private final int tileSize;
    private final double ratio;
    private final float quality;

    private final Map<String, Source> loaded = new LinkedHashMap<>(4, 0.75f, true) {
        @Override protected boolean removeEldestEntry(Map.Entry<String, Source> eldest) {
            return size() > MAX_LOADED;          // free mip levels for images nobody is viewing
        }
    };

    public ImageRegistry(Path dir, int tileSize, double ratio, float quality) throws Exception {
        // Must be normalised: a path like "server/../images" is absolute but still contains
        // the ".." segment, so startsWith() against a normalised file path would fail and
        // every open would be rejected as "no such image".
        this.dir = dir.toAbsolutePath().normalize();
        this.tileSize = tileSize;
        this.ratio = ratio;
        this.quality = quality;
        Files.createDirectories(dir);
    }

    public Path directory() { return dir; }

    /**
     * TIFF is included because that is what large scans actually ship as - the ESO and
     * Google Art Project originals are TIFFs. Java's bundled ImageIO has read support for
     * it since Java 9, so no extra dependency is needed.
     */
    public static boolean isImage(String name) {
        String n = name.toLowerCase(Locale.ROOT);
        return n.endsWith(".jpg") || n.endsWith(".jpeg") || n.endsWith(".png")
                || n.endsWith(".tif") || n.endsWith(".tiff");
    }

    /** Lists the directory, reading only file headers for dimensions. */
    public List<Entry> list() {
        List<Entry> out = new ArrayList<>();
        File[] files = dir.toFile().listFiles();
        if (files == null) return out;
        for (File f : files) {
            if (!f.isFile() || !isImage(f.getName())) continue;
            int[] wh = dimensions(f);
            if (wh == null) continue;
            long pixels = (long) wh[0] * wh[1];
            boolean ready = isIngested(f.getName()) || pixels <= MAX_LIVE_PIXELS;
            out.add(new Entry(f.getName(), wh[0], wh[1], f.length(), ready));
        }
        out.sort(Comparator.comparing(Entry::name));
        return out;
    }

    /** Width and height from the header, without decoding pixels. */
    private static int[] dimensions(File f) {
        try (ImageInputStream iis = ImageIO.createImageInputStream(f)) {
            Iterator<ImageReader> it = ImageIO.getImageReaders(iis);
            if (!it.hasNext()) return null;
            ImageReader r = it.next();
            try {
                r.setInput(iis);
                return new int[]{r.getWidth(0), r.getHeight(0)};
            } finally {
                r.dispose();
            }
        } catch (Exception e) {
            return null;
        }
    }

    /** Where Ingest writes a given image's tile store. */
    public Path tileDir(String name) {
        return dir.resolve(".tiles").resolve(name);
    }

    public boolean isIngested(String name) {
        return Files.isRegularFile(tileDir(name).resolve("meta.txt"));
    }

    /**
     * Resolves a name safely and returns something that can serve its tiles: the on-disk
     * tile store if one exists, otherwise an in-memory store - but only if the image is
     * small enough to decode without stalling the server.
     */
    public synchronized Source open(String name) throws Exception {
        if (name == null || name.isBlank()) throw new IllegalArgumentException("no image name");
        String safe = sanitize(name);
        Source hit = loaded.get(safe);
        if (hit != null) return hit;

        Path file = dir.resolve(safe).normalize();
        if (!file.startsWith(dir) || !Files.isRegularFile(file))
            throw new IllegalArgumentException("no such image: " + safe);

        Source store;
        if (isIngested(safe)) {
            store = new TiledStore(tileDir(safe));       // nothing decoded, memory flat
        } else {
            int[] wh = dimensions(file.toFile());
            long pixels = wh == null ? 0 : (long) wh[0] * wh[1];
            if (pixels > MAX_LIVE_PIXELS)
                throw new IllegalArgumentException(String.format(
                        "%.0f MP is too large to open directly - run:  ./ingest.sh images/%s",
                        pixels / 1e6, safe));
            store = new ImageStore(file, tileSize, ratio, quality);
        }
        loaded.put(safe, store);
        return store;
    }

    /** Rejects path separators outright rather than trying to clean them. */
    public static String sanitize(String name) {
        if (name.contains("/") || name.contains("\\") || name.contains("..") || name.isBlank())
            throw new IllegalArgumentException("bad image name");
        if (!isImage(name)) throw new IllegalArgumentException("unsupported file type");
        return name;
    }
}
