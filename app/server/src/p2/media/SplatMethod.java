package p2.media;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Properties;
import java.util.concurrent.atomic.AtomicLong;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The splat image method: every unit of the image is a few thousand Gaussian blobs instead of
 * a JPEG, and the browser draws them on the GPU.
 *
 * Preparation has two stages. First the image is rasterised into a ladder of tiles, exactly
 * as {@link LadderTiles} does, because the fitter needs pixels to aim at. Then a GPU fitter
 * ({@code tools/fit_splats.py}) turns each tile into a {@code .splat} file: a small header and
 * one 11-byte record per blob. The raster stays on disk as the fitter's input and is not
 * served.
 *
 * Two details keep the seams out of the picture:
 *
 *   - each unit is fitted on a crop padded with its neighbours' pixels, and keeps every blob
 *     of that fit, including those centred outside it, so it can reproduce its own edge;
 *   - drawing is clipped to the unit's own rectangle, so a neighbour's version of the shared
 *     edge never adds on top of this one.
 *
 * Fitting is slow - seconds of GPU time per unit - so levels are fitted coarsest first and
 * the image becomes viewable as soon as the top of the ladder is done: the viewer simply
 * shows the finest level that exists yet.
 */
public final class SplatMethod implements ImageMethod {

    public static final String ID = "splats-4000";
    private static final String META = "meta.properties";
    private static final String RASTER = "raster";
    private static final Pattern UNIT_LINE =
            Pattern.compile("unit (\\d+)/(\\d+) level (\\d+)");
    private static final Pattern LEVEL_DONE = Pattern.compile("level (\\d+) done");
    /** Rounds for a unit that starts from the level above; the top level gets `iterations`. */
    private static final int CHILD_ITERATIONS = 400;

    private final int unitSize;
    private final double ratio;
    private final int splatsPerUnit;
    private final int iterations;
    private final int margin;
    private final String python;
    private final Path fitter;

    public SplatMethod(String python, Path fitter) {
        this(256, 1.25, 4000, 1000, 16, python, fitter);
    }

    public SplatMethod(int unitSize, double ratio, int splatsPerUnit, int iterations, int margin,
                       String python, Path fitter) {
        this.unitSize = unitSize;
        this.ratio = ratio;
        this.splatsPerUnit = splatsPerUnit;
        this.iterations = iterations;
        this.margin = margin;
        this.python = python;
        this.fitter = fitter;
    }

    @Override public String id() { return ID; }

    @Override public boolean isPrepared(Path dir) { return Files.isRegularFile(dir.resolve(META)); }

    // ---------------------------------------------------------------- preparation

    @Override
    public void prepare(Path source, Path dir, Progress progress) throws IOException {
        Files.createDirectories(dir);
        Path raster = dir.resolve(RASTER);
        LadderTiles tiles = new LadderTiles(unitSize, ratio, 0.92f);   // the fitter's target
        if (!tiles.isPrepared(raster)) {
            tiles.prepare(source, raster, (stage, done, total) ->
                    progress.step("rasterising, " + stage, done, total * 2));  // first half of the work
        }
        Files.copy(raster.resolve(LadderTiles.PREVIEW), dir.resolve(LadderTiles.PREVIEW),
                StandardCopyOption.REPLACE_EXISTING);

        Properties rasterMeta = read(raster.resolve(META));
        int maxLevel = Integer.parseInt(rasterMeta.getProperty("maxLevel"));
        int width = Integer.parseInt(rasterMeta.getProperty("width"));
        int height = Integer.parseInt(rasterMeta.getProperty("height"));

        fit(dir, raster, maxLevel, width, height, progress);
        writeMeta(dir, width, height, maxLevel, 0);
        progress.step("done", 1, 1);
    }

    /** Run the GPU fitter, following its progress and publishing each level as it finishes. */
    private void fit(Path dir, Path raster, int maxLevel, int width, int height, Progress progress)
            throws IOException {
        // The settings chosen after comparing them on the portrait (see tools/compare_splats.py):
        // blobs averaged by weight (no speckles), more blobs where there is detail, and each
        // unit started from the fitted level above so it needs 400 rounds instead of 1000 -
        // about half the time for ~1.3 dB less than fitting every unit from scratch.
        List<String> command = List.of(python, "-u", fitter.toString(),
                raster.toString(), dir.toString(),
                "--splats", String.valueOf(splatsPerUnit),
                "--iters", String.valueOf(iterations),
                "--margin", String.valueOf(margin),
                "--normalized", "--adaptive",
                "--parent-init", "--child-iters", String.valueOf(CHILD_ITERATIONS));
        Process process = new ProcessBuilder(command)
                .redirectErrorStream(true)
                .directory(fitter.getParent().getParent().toFile())
                .start();

        AtomicLong done = new AtomicLong();
        try (BufferedReader out = new BufferedReader(new InputStreamReader(process.getInputStream()))) {
            String line;
            while ((line = out.readLine()) != null) {
                Matcher unit = UNIT_LINE.matcher(line);
                if (unit.find()) {
                    long at = Long.parseLong(unit.group(1));
                    long total = Long.parseLong(unit.group(2));
                    done.set(at);
                    progress.step("fitting level " + unit.group(3), total + at, total * 2);
                    continue;
                }
                Matcher level = LEVEL_DONE.matcher(line);
                if (level.find()) {
                    // publish what is finished: the viewer can open the image already
                    writeMeta(dir, width, height, maxLevel, Integer.parseInt(level.group(1)));
                } else if (!line.isBlank()) {
                    System.out.println("fit: " + line);
                }
            }
        }
        int status;
        try {
            status = process.waitFor();
        } catch (InterruptedException e) {
            process.destroy();
            Thread.currentThread().interrupt();
            throw new IOException("fitting interrupted", e);
        }
        if (status != 0) throw new IOException("the splat fitter failed (exit " + status + ")");
    }

    private void writeMeta(Path dir, int width, int height, int maxLevel, int finestLevel)
            throws IOException {
        long[] count = countUnits(dir, maxLevel);
        Properties meta = new Properties();
        meta.setProperty("method", ID);
        meta.setProperty("width", String.valueOf(width));
        meta.setProperty("height", String.valueOf(height));
        meta.setProperty("tileSize", String.valueOf(unitSize));
        meta.setProperty("ratio", String.valueOf(ratio));
        meta.setProperty("maxLevel", String.valueOf(maxLevel));
        meta.setProperty("units", String.valueOf(count[0]));
        meta.setProperty("bytes", String.valueOf(count[1]));
        meta.setProperty("finestLevel", String.valueOf(finestLevel));
        meta.setProperty("splatsPerUnit", String.valueOf(splatsPerUnit));
        try (var out = Files.newOutputStream(dir.resolve(META))) {
            meta.store(out, "fitted by " + ID);
        }
    }

    /** How many .splat files exist, and how much they occupy. */
    private static long[] countUnits(Path dir, int maxLevel) throws IOException {
        long units = 0, bytes = 0;
        for (int level = 0; level <= maxLevel; level++) {
            Path levelDir = dir.resolve(String.valueOf(level));
            if (!Files.isDirectory(levelDir)) continue;
            try (var files = Files.list(levelDir)) {
                for (Path p : files.toList()) {
                    if (!p.getFileName().toString().endsWith(".splat")) continue;
                    units++;
                    bytes += Files.size(p);
                }
            }
        }
        return new long[]{units, bytes};
    }

    private static Properties read(Path path) throws IOException {
        Properties p = new Properties();
        try (var in = Files.newInputStream(path)) {
            p.load(in);
        }
        return p;
    }

    // ---------------------------------------------------------------- serving

    @Override
    public Served open(Path dir) throws IOException {
        Properties p = read(dir.resolve(META));
        Meta meta = new Meta(
                Integer.parseInt(p.getProperty("width")),
                Integer.parseInt(p.getProperty("height")),
                Integer.parseInt(p.getProperty("tileSize")),
                Double.parseDouble(p.getProperty("ratio")),
                Integer.parseInt(p.getProperty("maxLevel")),
                Integer.parseInt(p.getProperty("units")),
                Long.parseLong(p.getProperty("bytes")));
        return new SplatStore(dir, meta);
    }

    /** Serves fitted units; holds nothing but paths. */
    static final class SplatStore implements Served {
        private final Path dir;
        private final Meta meta;
        private volatile int finestLevel;
        private volatile long checkedAt;

        SplatStore(Path dir, Meta meta) {
            this.dir = dir;
            this.meta = meta;
            this.finestLevel = readFinest();
        }

        @Override public Meta meta() { return meta; }

        @Override public String unitContentType() { return "application/x-p2-splat"; }

        /**
         * The finest level fitted so far. While an image is still being fitted this rises, and
         * the viewer is simply given coarser units until the level it wants exists.
         */
        private int finest() {
            long now = System.currentTimeMillis();
            if (now - checkedAt > 2000) {
                checkedAt = now;
                finestLevel = readFinest();
            }
            return finestLevel;
        }

        private int readFinest() {
            try {
                Properties p = read(dir.resolve(META));
                return Integer.parseInt(p.getProperty("finestLevel", String.valueOf(meta.maxLevel())));
            } catch (IOException e) {
                return meta.maxLevel();
            }
        }

        int levelFor(double scale) {
            int wanted = (int) Math.floor(Math.log(Math.max(scale, 1e-9)) / Math.log(meta.ratio()) + 1e-9);
            return Math.max(Math.max(0, finest()), Math.min(meta.maxLevel(), wanted));
        }

        @Override
        public List<UnitId> unitsFor(Viewport v) {
            int level = levelFor(v.scale());
            double ls = Math.pow(meta.ratio(), level);
            int ts = meta.unitSize();
            int levelW = (int) Math.ceil(meta.width() / ls), levelH = (int) Math.ceil(meta.height() / ls);
            double x0 = (v.cx() - v.screenW() * v.scale() / 2) / ls;
            double y0 = (v.cy() - v.screenH() * v.scale() / 2) / ls;
            double x1 = x0 + v.screenW() * v.scale() / ls;
            double y1 = y0 + v.screenH() * v.scale() / ls;
            int cx0 = Math.max(0, (int) Math.floor(x0 / ts));
            int cy0 = Math.max(0, (int) Math.floor(y0 / ts));
            int cx1 = Math.min((levelW + ts - 1) / ts - 1, (int) Math.ceil(x1 / ts) - 1);
            int cy1 = Math.min((levelH + ts - 1) / ts - 1, (int) Math.ceil(y1 / ts) - 1);

            List<UnitId> units = new ArrayList<>();
            for (int row = cy0; row <= cy1; row++) {
                for (int col = cx0; col <= cx1; col++) {
                    UnitId id = new UnitId(level, col, row);
                    if (Files.isRegularFile(path(id))) units.add(id);
                }
            }
            units.sort(Comparator.comparingDouble(u -> {
                double px = (u.x() + 0.5) * ts * ls, py = (u.y() + 0.5) * ts * ls;
                return Math.hypot((px - v.cx()) / v.scale(), (py - v.cy()) / v.scale());
            }));
            return units;
        }

        @Override
        public byte[] bytes(UnitId id) throws IOException {
            return Files.readAllBytes(path(id));
        }

        private Path path(UnitId id) {
            return dir.resolve(String.valueOf(id.level())).resolve(id.x() + "_" + id.y() + ".splat");
        }
    }
}
