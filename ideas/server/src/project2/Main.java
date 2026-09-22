package project2;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

/**
 * Project 2 - async image server.
 *
 * Serves ultra-high-resolution images to browser clients. Static files go over plain HTTP;
 * the image itself travels over our own binary protocol inside a hand-implemented
 * WebSocket (RFC 6455).
 *
 * The tile ladder uses a geometric scale ratio (default 1.25) rather than powers of two.
 * Measured on realistic zoom factors, that cuts bytes ~1.55x versus a pow2 pyramid, because
 * a pow2 pyramid forces the client to take the next finer level and downscale - up to 4x
 * the pixels the screen can actually show. See ../measured-numbers.md.
 *
 *   ./run.sh                    # serves everything in ./images
 *   ./run.sh ../images 8080
 *   ./run.sh some/photo.jpg     # serves that file's directory, with it in the catalog
 */
public final class Main {

    public static void main(String[] args) throws Exception {
        Path target = Path.of("../images");
        int port = 8080;
        double ratio = 1.25;
        int tile = 256;
        float quality = 0.85f;

        boolean targetGiven = false;
        for (int i = 0; i < args.length; i++) {
            switch (args[i]) {
                case "--ratio" -> ratio = Double.parseDouble(args[++i]);
                case "--tile" -> tile = Integer.parseInt(args[++i]);
                case "--q" -> quality = Float.parseFloat(args[++i]);
                default -> {
                    if (args[i].matches("\\d+")) port = Integer.parseInt(args[i]);
                    else { target = Path.of(args[i]); targetGiven = true; }
                }
            }
        }

        // A file argument means "serve the directory it lives in", so the catalog still works.
        Path imagesDir = (targetGiven && Files.isRegularFile(target)
                ? target.toAbsolutePath().getParent()
                : target.toAbsolutePath()).normalize();

        ImageRegistry registry = new ImageRegistry(imagesDir, tile, ratio, quality);
        List<ImageRegistry.Entry> catalog = registry.list();

        System.out.printf("images dir : %s%n", imagesDir);
        System.out.printf("catalog    : %d image(s)%n", catalog.size());
        for (ImageRegistry.Entry e : catalog)
            System.out.printf("             %-40s %6dx%-6d  %6.1f MP  %7.1f MB%n",
                    e.name(), e.width(), e.height(), e.pixels() / 1e6, e.bytes() / 1048576.0);
        if (catalog.isEmpty())
            System.out.println("             (none yet - drop files in, or upload from the picker page)");
        System.out.printf("tiles      : %dpx, ladder ratio %.2f, jpeg q%.2f%n", tile, ratio, quality);

        HttpServer server = new HttpServer(port, Path.of("web").toAbsolutePath(), registry);
        server.start();
        System.out.printf("%nProject 2 listening on http://localhost:%d%n", port);
        System.out.println("press ctrl-c to stop");
        Thread.currentThread().join();
    }

    private Main() {}
}
