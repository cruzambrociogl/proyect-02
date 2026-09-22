package project2;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Serves tiles that {@link Ingest} already wrote to disk.
 *
 * Nothing is decoded at request time and the original file is never opened, so server
 * memory is flat regardless of source size - a 470 MP TIFF costs exactly as much as a
 * small JPEG. This is what makes gigapixel images work.
 */
public final class TiledStore implements Source {

    private final Path dir;
    private final int width, height, tileSize, maxLevel;
    private final double ratio;

    /** Small LRU of tile bytes, shared by every client, to skip the filesystem on hot tiles. */
    private final Map<String, byte[]> cache = new LinkedHashMap<>(256, 0.75f, true) {
        @Override protected boolean removeEldestEntry(Map.Entry<String, byte[]> eldest) {
            return size() > 1024;
        }
    };

    public TiledStore(Path dir) throws Exception {
        this.dir = dir;
        Map<String, String> meta = new java.util.HashMap<>();
        for (String line : Files.readAllLines(dir.resolve("meta.txt"))) {
            int eq = line.indexOf('=');
            if (eq > 0) meta.put(line.substring(0, eq).trim(), line.substring(eq + 1).trim());
        }
        width = Integer.parseInt(meta.get("width"));
        height = Integer.parseInt(meta.get("height"));
        tileSize = Integer.parseInt(meta.get("tileSize"));
        ratio = Double.parseDouble(meta.get("ratio"));
        maxLevel = Integer.parseInt(meta.get("maxLevel"));
    }

    @Override public int width() { return width; }
    @Override public int height() { return height; }
    @Override public int tileSize() { return tileSize; }
    @Override public double ratio() { return ratio; }
    @Override public int maxLevel() { return maxLevel; }

    @Override public double ladderScale(int level) { return Math.pow(ratio, level); }
    @Override public int levelWidth(int level) { return (int) Math.ceil(width / ladderScale(level)); }
    @Override public int levelHeight(int level) { return (int) Math.ceil(height / ladderScale(level)); }

    @Override public byte[] tile(int level, int tx, int ty) throws Exception {
        String key = level + ":" + tx + ":" + ty;
        synchronized (cache) {
            byte[] hit = cache.get(key);
            if (hit != null) return hit;
        }
        Path file = dir.resolve(String.valueOf(level)).resolve(tx + "_" + ty + ".jpg");
        if (!Files.isRegularFile(file)) return null;
        byte[] bytes = Files.readAllBytes(file);
        synchronized (cache) { cache.put(key, bytes); }
        return bytes;
    }
}
