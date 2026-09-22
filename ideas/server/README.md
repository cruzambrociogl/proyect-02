# Project 2 server — walking skeleton

Asynchronous Java image server that streams ultra-high-resolution images to a browser over
its own binary protocol. **No third-party dependencies, no build tool** — the project is
graded offline, so it must compile anywhere with a JDK.

## Run

```sh
./run.sh                               # serves every image in ../images
./run.sh 9000                          # another port
./run.sh ../images 8080 --ratio 1.25 --tile 256 --q 0.85
./run.sh some/photo.jpg                # serves that file's directory
```

Then open <http://localhost:8080> — the catalog page. Pick an image to open the viewer;
drag to pan, wheel to zoom.

**Adding images (requirement #6).** Either drop files into `../images/`, or drag them onto
the catalog page to upload. No restart: the catalog is read from disk on every request, and
for ordinary images the tile ladder is built lazily the first time a client opens one.

## Large images: ingest first

Anything above ~80 MP cannot be decoded into memory at request time — attempting it pins a
CPU core and stalls the session before `CHART` is ever sent. Those images are listed in the
catalog but not clickable until they have been ingested:

```sh
./ingest.sh ../images/eso1242a.tif
```

Ingest reads the source **in horizontal strips** (`setSourceRegion`, plus
`setSourceSubsampling` for coarse levels), so peak memory is one strip — tens of MB — rather
than the whole image. It writes every ladder level as JPEG tiles to
`../images/.tiles/<name>/` (`meta.txt` plus `<level>/<tx>_<ty>.jpg`).

After that the server never opens the original file again: `TiledStore` reads tiles straight
off disk, so **server memory is flat regardless of source size**. A 470 MP TIFF costs the
same as a small JPEG.

Why strips work here: TIFF keeps a table of strip offsets, so the reader seeks to the rows
it needs. Measured on a 470 MP TIFF, one full-width 25000×256 strip reads in **0.28 s using
180 MB**. (Baseline JPEG has no such index — the same probe cost 2.6 s per tile because the
decoder rescans from the start of the file, which is why JPEG sources are slower to ingest.)

Delete `../images/.tiles/<name>/` to force a re-ingest.

### Pages and endpoints

| Path | Purpose |
|---|---|
| `/` | catalog: lists images, accepts uploads |
| `/viewer.html?image=NAME` | the viewer |
| `GET /api/images` | JSON catalog — name, width, height, bytes (read from file headers, never decoded) |
| `POST /api/upload?name=NAME` | raw file bytes as the body (no multipart), streamed to disk as they arrive — bounded by the filesystem, not by heap |
| `/project2` | WebSocket upgrade — the image protocol |

Build only:

```sh
javac -d build $(find src -name '*.java')
java -cp build project2.Main <image> [port]
```

## Headless protocol test

Proves the whole path without a browser — handshake, GREET → CHART, GAZE → TILE, and that
zooming selects a finer ladder level:

```sh
java -cp build project2.TestClient localhost 8080
```

The handshake check uses the test vector from RFC 6455 §1.3 (key `dGhlIHNhbXBsZSBub25jZQ==`
must yield accept `s3pPLMBiTxaQ9kYGzzhZRbK+xOo=`), so it validates our SHA-1 + base64
against the specification rather than against our own implementation.

## Architecture

| File | Role |
|---|---|
| `Main.java` | entry point, argument parsing |
| `HttpServer.java` | async accept loop (`AsynchronousServerSocketChannel`), static files, WebSocket upgrade |
| `WebSocketCodec.java` | RFC 6455 handshake + frame codec, written by hand |
| `Protocol.java` | 12-byte message header, message types |
| `ImageStore.java` | ladder levels, on-demand tile rendering, shared LRU tile cache |
| `Session.java` | per-client state: viewport, epoch, ledger of tiles the client holds |
| `TestClient.java` | headless end-to-end protocol test |
| `web/` | canvas viewer, no libraries |

## The protocol

Every message: `magic 'P''2' (2) | version (1) | type (1) | epoch (4) | payload length (4)`,
big-endian, inside a binary WebSocket frame.

| Type | Dir | Payload |
|---|---|---|
| `GREET` 1 | C→S | screen w, h, tile budget |
| `CHART` 2 | S→C | image w, h, tile size, ladder ratio, max level |
| `GAZE` 3 | C→S | centre x, y, scale, viewport w, h |
| `TILE` 4 | S→C | level, tx, ty, JPEG bytes |
| `FAULT` 5 | S→C | error text |
| `PART` 9 | C→S | goodbye |

`scale` is **source pixels per screen pixel**. The server picks ladder level
`floor(log_ratio(scale))` — the finest step that is not finer than the screen can display.

**Why a ladder instead of a pyramid.** Levels are `ratio^L` (default 1.25) rather than
powers of two. A pow2 pyramid forces the client to take the next finer level and downscale,
wasting up to 4x in area; a 1.25 ladder caps that at 1.56x. Measured over a scripted
browsing path with realistic zoom factors, this cut bytes ~1.55x versus pow2 tiles — see
`../measured-numbers.md`. The cost is ~14 levels instead of 5 (roughly 2x precomputed
storage, or generate-on-demand as done here).

The **epoch** in the header is how stale work is cancelled: every `GAZE` increments it, and
the server abandons a tile burst as soon as a newer viewport arrives.

The **ledger** (`Session.held`) is how the server keeps control of each client's resolution,
as the brief requires: it tracks what each client already holds and only ever sends the
difference.

## Implemented / not yet

Working: async HTTP, WebSocket upgrade and framing, the message set above, image catalog
with browser upload, lazily-built ladder tiles with a shared server-side cache, centre-out
tile ordering, epoch cancellation, per-client ledger, canvas viewer with pan/zoom,
client-side LRU eviction with a tile budget, live HUD.

Not yet:

- **Credit-based flow control** — currently a fixed 48-tile cap per `GAZE`.
- **`FADE`** (server-driven eviction) — `Session.held` grows unbounded, so a long session
  costs server memory forever.
- **The zero-byte rule** — skipping regions the client's own upscale already renders
  adequately. The one mechanism with measured savings behind it (24–53% of bytes).
- **Non-blocking image open** — `registry.open()` decodes the image and builds mip levels
  on the I/O thread, so the first `OPEN` of a large image stalls that session before `CHART`
  is sent (~4 s for the 56 MP test image, measured). Acceptable now, fatal at gigapixel
  scale — the real fix is offline ingest into a tile store, after which nothing is decoded
  at request time.
- **`ECHO`** round-trip timing.
