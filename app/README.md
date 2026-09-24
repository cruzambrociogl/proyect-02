# Gigapixel image server

Java 21 and plain HTML/JS. No dependencies, no build tools, no external requests.

```sh
./run.sh                             # builds, then serves ./images on http://localhost:8080
./run.sh --images ../ideas/images    # or any other folder of images
```

- `http://localhost:8080/` — **server site**: what is served, add images, prepare them.
- `http://localhost:8080/viewer` — **client site**: look at an image.
- `http://localhost:8080/viewer?image=NAME&budget=24` — straight to an image, holding 24 MB.

The image travels over our own protocol on UDP (port 8081 by default). The browser cannot
speak that, so what it connects to is the client half of the protocol, which holds a socket of
its own; see **The protocol** below.

### Make the path misbehave

On a loopback nothing is lost, delayed or reordered, which is the one condition under which
none of the protocol's hard parts can be seen working. So the emulator is built in:

```sh
./run.sh --impair "loss=2%,delay=25ms,jitter=5ms,rate=30mbit,reorder=1%,duplicate=0.5%"
```

The viewer's panel then shows what it costs: the rate the sender settles on, the queue it
leaves behind, the loss it measures and the repair symbols it spends.

### Test it

Each of these runs on its own and says what it measured:

```sh
java -cp server/build p2.fec.FecSelfTest        # the erasure code, on its own
java -cp server/build p2.net.udp.UdpSelfTest    # one unit across a real socket, six paths
java -cp server/build p2.net.udp.TransferSelfTest   # 200 units, cancellation, speculation
java -cp server/build p2.net.udp.TransferSelfTest --trace   # and what the rate control did
```

### The figures

```sh
python3 tools/fig_pipeline.py --screen /tmp/viewer.png --out ../docs/pipeline.png
python3 tools/fig_protocol.py --out ../docs/protocol.png
python3 tools/fig_pipeline.py --lang es --out ../docs/pipeline-es.png   # and --lang es
```

Both are drawn from the real store and from numbers the code printed, so they go stale if the
code changes and are meant to be regenerated rather than edited.

## The five parts

| Part | Where | What it does |
|---|---|---|
| Client site | `web/viewer/` | canvas viewer, image picker, live information panel |
| Server site | `web/admin/` | previews, details, upload, prepare with progress |
| Server | `server/src/p2/http`, `server/src/p2/session` | async HTTP, one session per viewer, decides what to send |
| Image method | `server/src/p2/media` | turns an image into sendable units, and serves them |
| Protocol | `server/src/p2/net` | carries the messages |

## The two swap points

Everything above them deals in opaque *units*, so either side can be replaced without
touching the other.

**`ImageMethod`** (`media/ImageMethod.java`) — how an image becomes sendable.
`prepare()` runs once per image; `open()` returns something that answers "what units does
this viewport need, most important first" and "give me the bytes of unit X".
To add one: implement the interface, register it in `Main.method()`, and add a matching
renderer in `web/viewer/renderers.js`.

| Method | Unit | Drawn with | Prepare cost |
|---|---|---|---|
| `ladder-tiles` | a 256 px JPEG, ~12 KB | 2D canvas | seconds to minutes |
| `splats-4000` | ~5,000 Gaussian blobs, 11 bytes each | WebGL, additive | **seconds of GPU time per unit** |

```sh
./run.sh --method splats-4000 --python /path/to/python3   # needs torch + numpy + Pillow
```

Splat preparation runs in two stages: the image is rasterised into tiles (the fitter needs
pixels to aim at), then `tools/fit_splats.py` fits every unit on the GPU. Levels are fitted
coarsest first and each finished level is published, so the image is viewable while the finer
levels are still being fitted — the viewer just shows the finest level that exists.

Two rules keep splat units from showing seams: each unit is fitted on a crop padded with its
neighbours' pixels and keeps **every** blob of that fit, including those centred outside it;
and drawing is clipped to the unit's own rectangle, so neighbours never double-count the
shared edge. `tools/verify_splats.py --block` measures this: error at unit borders should be
no worse than inside them.

**`Link`** (`net/Link.java`) — how bytes travel. It answers "can I send more", "take this
message" and "we are done", and reports what arrives. Two implementations:
`WebSocketLink` (TCP, what the browser connects to) and `SenderLink`, which hands each
message to our own protocol on UDP with a deadline and a class. The session layer above does
not know which one is underneath.

## The protocol

`net/udp/` — no TCP, no HTTP, no library. Loss is repaired by a systematic rateless erasure
code over GF(256) instead of by asking for anything again; the receiver reports a *count* of
symbols it is short of, never a list of what went missing; there is no acknowledgement
anywhere, and a unit is finished when the receiver stops naming it. The rate is set by how
long packets are waiting rather than by whether they are lost - the repair symbols absorb
loss, which is exactly why loss is no longer a usable congestion signal.

`docs/protocol.png` walks through all of it, with a worked example taken from running the
codec on a real tile.

### The messages

A 12-byte header (`'P' '2' version type epoch length`) then a payload. The epoch is what
makes cancelling cheap: the viewer raises it on every change of view, and the server drops
anything still queued for an older one.

| Type | Direction | Payload |
|---|---|---|
| `HELLO` / `WELCOME` | both ways | version and method |
| `OPEN` | client → server | image name |
| `CHART` | server → client | the image's shape, as JSON |
| `VIEW` | client → server | centre, scale, screen size, and units the client has dropped |
| `UNIT` | server → client | level, x, y, then the method's bytes |
| `STATS` | server → client | what this session is doing, for the panel |
| `FAULT` | server → client | a message that explains itself |

The client must report what it evicts: the server assumes the client keeps everything it
has been sent, and will not resend a unit it believes is already there.

## Development

```sh
python3 tools/browse.py "http://localhost:8080/viewer?image=NAME" --wait 5 --shot /tmp/v.png
```

Loads a page in headless Chrome in real time (Chrome's own `--screenshot` freezes the clock
and WebSockets never connect), runs JavaScript in it and saves a screenshot.

## Milestones

- [x] **1** — server skeleton, catalog, preparation with progress, server site
- [x] **2** — viewer over the WebSocket bridge: streaming, drawing, memory budget, panel
- [x] **3** — the protocol over UDP: framing, the erasure code, reports by count, deadline
      scheduling, delay-based rate control, the impairment layer, and the viewer running on it
- [ ] **4** — a bench client with CSV traces, and the protocol document
