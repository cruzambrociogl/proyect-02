package p2;

import p2.http.HttpServer;
import p2.http.Routes;
import p2.media.Catalog;
import p2.media.ImageMethod;
import p2.media.LadderTiles;
import p2.media.SplatMethod;
import p2.net.WebSocketLink;
import p2.session.Session;

import java.nio.file.Files;
import java.nio.file.Path;

/**
 * Starts the server: the two pages and their API over HTTP, and (from milestone 3) the image
 * protocol over UDP.
 *
 *   ./run.sh                          serve ./images on port 8080
 *   ./run.sh --images ../ideas/images --port 8080
 */
public final class Main {

    public static void main(String[] args) throws Exception {
        int port = 8080;
        int udpPort = 8081;
        Path images = Path.of("images");
        Path web = Path.of("web");
        String methodId = LadderTiles.ID;
        String python = System.getenv().getOrDefault("P2_PYTHON", "python3");
        Path fitter = Path.of("tools", "fit_splats.py");

        for (int i = 0; i < args.length; i++) {
            switch (args[i]) {
                case "--port" -> port = Integer.parseInt(args[++i]);
                case "--udp-port" -> udpPort = Integer.parseInt(args[++i]);
                case "--images" -> images = Path.of(args[++i]);
                case "--web" -> web = Path.of(args[++i]);
                case "--method" -> methodId = args[++i];
                case "--python" -> python = args[++i];
                case "--fitter" -> fitter = Path.of(args[++i]);
                case "--help" -> {
                    System.out.println("usage: run.sh [--port n] [--udp-port n] [--images dir] "
                            + "[--web dir] [--method ladder-tiles|splats-4000] [--python path]");
                    return;
                }
                default -> {
                    System.err.println("unknown option: " + args[i]);
                    System.exit(2);
                }
            }
        }

        Path imagesDir = images.toAbsolutePath().normalize();
        Path webDir = web.toAbsolutePath().normalize();
        if (!Files.isDirectory(webDir)) {
            System.err.println("no web directory at " + webDir);
            System.exit(2);
        }

        ImageMethod method = method(methodId, python, fitter.toAbsolutePath().normalize());
        Catalog catalog = new Catalog(imagesDir, method);
        Routes routes = new Routes(catalog, webDir, udpPort);

        // The browser reaches the session layer through the WebSocket bridge at /link.
        HttpServer.Upgrade bridge = (request, channel, leftover) ->
                request.path().equals("/link")
                        && WebSocketLink.accept(request, channel, leftover,
                                link -> new Session(catalog, link)) != null;

        new HttpServer(port, routes, routes, bridge).start();

        System.out.printf("images  %s (%d found)%n", imagesDir, catalog.names().size());
        System.out.printf("method  %s%n", method.id());
        System.out.printf("server  http://localhost:%d/          (manage what is served)%n", port);
        System.out.printf("viewer  http://localhost:%d/viewer    (look at an image)%n", port);
        Thread.currentThread().join();
    }

    private static ImageMethod method(String id, String python, Path fitter) {
        if (LadderTiles.ID.equals(id)) return new LadderTiles();
        if (SplatMethod.ID.equals(id)) return new SplatMethod(python, fitter);
        throw new IllegalArgumentException("unknown image method: " + id);
    }
}
