package p2.media;

import javax.imageio.ImageIO;
import javax.imageio.ImageReader;
import javax.imageio.stream.ImageInputStream;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.stream.Stream;

/**
 * The images this server offers, and their state: raw, being prepared, or ready to serve.
 *
 * Source files live directly in the images directory; each preparation goes to
 * {@code images/.prepared/<file name>/}. Preparations run one at a time on a background
 * thread, so the server site can show progress while the HTTP threads stay free.
 */
public final class Catalog {

    /** Extensions we will try to prepare; anything else in the folder is ignored. */
    private static final List<String> EXTENSIONS = List.of(".jpg", ".jpeg", ".png", ".tif", ".tiff", ".bmp");

    private final Path root;
    private final ImageMethod method;
    private final ExecutorService preparer = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "prepare");
        t.setDaemon(true);
        return t;
    });
    private final Map<String, State> states = new ConcurrentHashMap<>();
    private final Map<String, ImageMethod.Served> open = new ConcurrentHashMap<>();

    public Catalog(Path root, ImageMethod method) throws IOException {
        this.root = root;
        this.method = method;
        Files.createDirectories(root);
    }

    public Path root() { return root; }

    public ImageMethod method() { return method; }

    /** Each method keeps its own preparation, so switching methods does not destroy the other. */
    public Path preparedDir(String name) {
        return root.resolve(".prepared").resolve(method.id()).resolve(name);
    }

    public Path sourceFile(String name) { return root.resolve(name); }

    /** Names of everything the folder offers, prepared or not. */
    public List<String> names() {
        try (Stream<Path> files = Files.list(root)) {
            return files.filter(Files::isRegularFile)
                    .map(p -> p.getFileName().toString())
                    .filter(Catalog::supported)
                    .sorted(Comparator.naturalOrder())
                    .toList();
        } catch (IOException e) {
            return List.of();
        }
    }

    private static boolean supported(String name) {
        String lower = name.toLowerCase(Locale.ROOT);
        return EXTENSIONS.stream().anyMatch(lower::endsWith);
    }

    public boolean has(String name) {
        return !name.contains("/") && !name.contains("\\") && supported(name)
                && Files.isRegularFile(sourceFile(name));
    }

    /** Everything the server site shows about one image. */
    public Map<String, Object> describe(String name) {
        Map<String, Object> m = new LinkedHashMap<>();
        Path src = sourceFile(name);
        m.put("name", name);
        m.put("sourceBytes", size(src));
        int[] wh = dimensions(src);
        m.put("width", wh[0]);
        m.put("height", wh[1]);
        m.put("megapixels", wh[0] > 0 ? wh[0] * (double) wh[1] / 1e6 : 0.0);

        State state = states.get(name);
        boolean ready = method.isPrepared(preparedDir(name));
        String status = ready ? "ready" : state == null ? "raw" : state.status;
        m.put("status", status);
        m.put("method", method.id());
        if (state != null) {
            m.put("stage", state.stage);
            m.put("done", state.done);
            m.put("total", state.total);
            if (state.error != null) m.put("error", state.error);
        }
        if (ready) {
            try {
                ImageMethod.Meta meta = served(name).meta();
                m.put("unitSize", meta.unitSize());
                m.put("ratio", meta.ratio());
                m.put("maxLevel", meta.maxLevel());
                m.put("units", meta.units());
                m.put("preparedBytes", meta.bytes());
            } catch (IOException e) {
                m.put("status", "error");
                m.put("error", e.getMessage());
            }
        }
        return m;
    }

    public List<Map<String, Object>> describeAll() {
        List<Map<String, Object>> all = new ArrayList<>();
        for (String name : names()) all.add(describe(name));
        return all;
    }

    /** The prepared image, opened once and shared. */
    public ImageMethod.Served served(String name) throws IOException {
        ImageMethod.Served s = open.get(name);
        if (s != null) return s;
        if (!method.isPrepared(preparedDir(name))) throw new IOException(name + " is not prepared yet");
        s = method.open(preparedDir(name));
        ImageMethod.Served existing = open.putIfAbsent(name, s);
        return existing != null ? existing : s;
    }

    public Optional<Path> preview(String name) {
        Path p = preparedDir(name).resolve(LadderTiles.PREVIEW);
        return Files.isRegularFile(p) ? Optional.of(p) : Optional.empty();
    }

    /** Start preparing, unless it is already running or done. Returns false if nothing started. */
    public boolean prepare(String name) {
        if (!has(name)) return false;
        State state = states.compute(name, (k, old) ->
                old != null && old.status.equals("preparing") ? old : new State());
        if (!state.claim()) return false;
        open.remove(name);
        preparer.submit(() -> {
            try {
                method.prepare(sourceFile(name), preparedDir(name), (stage, done, total) -> {
                    state.stage = stage;
                    state.done = done;
                    state.total = total;
                });
                state.status = "ready";
            } catch (Exception e) {
                state.status = "error";
                state.error = String.valueOf(e.getMessage());
                System.err.println("prepare " + name + " failed: " + e);
            }
        });
        return true;
    }

    private static long size(Path p) {
        try {
            return Files.size(p);
        } catch (IOException e) {
            return 0;
        }
    }

    /** Width and height straight from the file header - no pixels are decoded. */
    private static int[] dimensions(Path p) {
        try (ImageInputStream in = ImageIO.createImageInputStream(p.toFile())) {
            if (in == null) return new int[]{0, 0};
            Iterator<ImageReader> readers = ImageIO.getImageReaders(in);
            if (!readers.hasNext()) return new int[]{0, 0};
            ImageReader reader = readers.next();
            reader.setInput(in);
            try {
                return new int[]{reader.getWidth(0), reader.getHeight(0)};
            } finally {
                reader.dispose();
            }
        } catch (IOException e) {
            return new int[]{0, 0};
        }
    }

    /** Mutable progress of one preparation. */
    private static final class State {
        volatile String status = "preparing";
        volatile String stage = "starting";
        volatile long done, total;
        volatile String error;
        private volatile boolean claimed;

        synchronized boolean claim() {
            if (claimed) return false;
            claimed = true;
            return true;
        }
    }
}
