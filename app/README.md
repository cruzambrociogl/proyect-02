# Gigapixel image server

Java 21 and plain HTML/JS. No dependencies, no build tools, no external requests.

```sh
./run.sh                             # serves ./images on http://localhost:8080
./run.sh --images ../ideas/images    # or any other folder of images
```

- `http://localhost:8080/` — **server site**: what is served, add images, prepare them.
- `http://localhost:8080/viewer` — **client site**: look at an image.

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
message" and "we are done", and reports what arrives.
Today: `WebSocketLink` (the browser bridge, over TCP).
Next: our own protocol over UDP, with Selective Repeat, SACK and pluggable congestion
control, which is the part the course is about.

## The protocol messages

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
- [ ] **3** — the protocol over UDP: framing, Selective Repeat, SACK, RTO, NewReno,
      an impairment layer, a Java bench client, CSV traces
- [ ] **4** — CUBIC and Vegas behind a flag, compared on the same scripted session
