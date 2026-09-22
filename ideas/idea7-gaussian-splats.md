# Idea #7 deep dive — the image as a set of 2D Gaussians

Deep dive on option #7 from [protocol-ideas.md](protocol-ideas.md).
Nothing decided; this is the design we would have to defend and build.

Sections 0 and A are the plain-language version (good raw material for the document's
introduction). Sections 1-10 are the technical design.

---

## 0. Plain-language overview

### The mental model

The server owns a giant **bag of brushstrokes** per image. A brushstroke is a soft
coloured ellipse described by about a dozen numbers: position, size, shape, colour.
The client never receives pixels — it receives brushstrokes and repaints them itself at
whatever size the screen needs. The client is a painter holding a limited palette; the
server decides which strokes are worth having right now.

### Server side

**One-time work per image (ingest).** When a new image is added, the server studies it and
works out which brushstrokes reproduce it, coarse to fine: a few thousand big strokes for
the overall look, then progressively smaller ones where the image is actually complex.
Empty sky terminates early with very few strokes; a dense star cluster gets many. The
result is saved next to the image. After that the original is never read again.

**While clients are connected.** Almost no expensive work. Per client the server keeps:

- where that client is looking, and at what zoom;
- a counter per region: *how many* brushstrokes of that region the client already holds.

On movement it computes which strokes are now worth having, reads those byte ranges from
the file, and sends them. No decoding, resizing or compression at request time — which is
why it scales to many clients. It also tells the client explicitly what to discard, which
satisfies requirement #2 of the brief literally.

### Client side

The client holds a list of brushstrokes in GPU memory and redraws them every frame.
150k soft ellipses per frame is routine GPU work (the same thing games do with particles).
New strokes are appended and the picture sharpens; retired strokes are removed and the
memory is genuinely freed. Client memory is `list length x cost per stroke` — a number we
control exactly, not something we hope the garbage collector handles.

### Mechanics, step by step

| Moment | What happens | What the user sees |
|---|---|---|
| Page load | HTTP delivers HTML/JS/CSS (~100 KB), WebSocket opens, client reports screen size + budget | blank → UI |
| First paint (~0.3 s) | ~20k coarse strokes (~250 KB) for the **whole** image | the complete image, soft but whole — no grey squares, no loading grid |
| Next 1-2 s | finer strokes stream in, centre-out | image sharpens smoothly |
| Pan | client reports viewport ~10x/s; server sends strokes for newly exposed area, retires far ones | usually nothing (prefetch ring); on fast pans, momentary softness |
| Zoom **in** | existing strokes are simply drawn bigger, finer ones stream in (~100k strokes, ~1.2 MB per 2x step) | smooth and correct immediately, then detail resolves — never blocky upscaling |
| Zoom **out** | client deletes now-subpixel strokes; **nothing is transferred** | instantaneous, and memory *drops* |
| Bad network | fewer strokes per second | image stays softer — never holes, never missing tiles |

### Approximate numbers — client

| | |
|---|---|
| Brushstroke on the wire | 11 bytes |
| Brushstroke in GPU memory | ~40 bytes |
| Full-detail 1080p view | 70k-140k strokes (~1.7 MB transferred) |
| Memory ceiling | 750k strokes ~30 MB + 16 MB canvas = **~46 MB, flat forever** |
| First complete image | ~250 KB, **~0.3 s** @ 10 Mbps |
| Sharp view | ~1.5 s @ 10 Mbps; ~0.2 s on LAN |
| Pan half a screen | ~800 KB (usually pre-loaded) |
| Zoom in, one step | ~1.2 MB |
| Zoom out | **0 bytes**, instant |
| 10-minute session, total | ~30-80 MB transferred |
| Frame time | 5-10 ms discrete GPU; ~16 ms integrated |

The headline is that the memory line is **flat**. A tile cache grows the longer you browse
and has to be fought with eviction policy; here the cap is a list length.

### Approximate numbers — server

| | |
|---|---|
| RAM per connected client | few KB state + buffers ≈ **~70 KB** |
| 1,000 simultaneous clients | ~70 MB RAM |
| CPU per active client | very low — file reads, no image processing |
| In-RAM index for 9 Gpx image | < 1 MB |
| Brushstroke file on disk | ~4.4 GB for the 24.6 GB ESO image |
| Work per request | read byte ranges + arithmetic |

Honest tradeoff: a JPEG tile pyramid would probably be **smaller** than 5 GB on disk. We do
not win on storage. We win on client memory, progressive behaviour, and the server doing
no per-request image work.

### Approximate numbers — ingest (one-time per image)

| | |
|---|---|
| Full 9-gigapixel ESO image | ~30-90 min, modern multicore laptop |
| A 2 GB test image | a few minutes |
| Lazy mode (fit on first request, then cache) | usable immediately |

### What the demo actually shows

- A gigapixel image **complete in under half a second**, sharpening smoothly.
- A memory counter that **sits still** at ~46 MB however long you browse.
- A bandwidth throttle: the image softens instead of falling apart.
- Zoom out instant and memory-freeing; zoom in smooth with **no tile seams anywhere**,
  because there are no tiles.
- Several browsers at once, server barely using CPU.
- A debug toggle drawing the ellipse outlines, so the grader sees the mechanism directly.
  Worth a lot in the defence: it makes it obvious we are not shipping images.

**The catch, plainly:** at 1:1 zoom (one image pixel per screen pixel), brushstrokes
struggle to match JPEG's efficiency on fine texture. Either cap maximum zoom where it still
looks great, or let the deepest level fall back to pixel patches. Measure the crossover
and document it — "we measured our approach against the obvious one, here is where each
wins" reads as rigour, not weakness.

---

## A. Background: what browsers normally do with images

Useful for the document's problem statement, and the reason this project exists.

With a plain `<img src="huge.jpg">`:

1. **Download** — the browser GETs the **entire** file. There is no partial mode. HTTP
   `Range` exists (RFC 9110 §14) but browsers do not use it for images, and a JPEG is a
   serial entropy-coded stream: byte 5,000,000,000 is not "the middle of the picture".
2. **Decode** — the file is *compressed*; drawing needs **4 bytes per pixel** (RGBA).
   A 10 GB JPEG at ~10:1 is ~25 gigapixels → **~100 GB of RAM** decoded.
3. **Fail** — browsers cap decoded images at a few hundred megapixels, and canvas/GPU
   textures at ~16k-32k px per side.

So you never see "the real 10 GB image". A 1920x1080 screen is 2 million pixels — a
25-gigapixel image has **~12,000x more pixels than the screen can display**. Everything
downloaded beyond that is averaged away into pixels nobody ever sees.

Three separate copies explain where memory goes:

| Copy | 10 GB image | Lives in |
|---|---|---|
| Compressed file | 10 GB | HTTP disk cache |
| Decoded bitmap | ~100 GB | RAM |
| GPU texture | another copy of what is drawn | VRAM |

**Memory is dominated by decoded pixels held, not by bytes in flight.** That is the
distinction the whole project turns on: we control memory by choosing what to keep
decoded, not by how we download.

How real viewers (Google Maps, OpenSeadragon, GigaPan) handle it: pre-cut into small
independent pieces; the client fetches only the 20-60 pieces the viewport needs (a few
hundred KB), decodes them, and **discards what scrolls off** so decoded memory stays flat.
The key fact: **you only ever need about as many pixels as the screen has** — ~8 MB
decoded for 1080p, whether the source is 1 GB or 700 GB. The entire problem is choosing
*which* pixels, at *what* scale.

This is also why "multiple resolutions" must exist: zoomed out, one screen pixel
summarises thousands of source pixels, and that averaging cannot be done by the browser —
doing it would require having all the pixels.

Prior art worth one paragraph in the document: **progressive JPEG** is the one natively
progressive mechanism browsers have, but it still downloads the whole file and has no
spatial selectivity, so it does not help at gigapixel scale.

---

## 1. The core idea

The client never stores pixels. It stores a **list of 2D Gaussian splats** and renders
them at whatever scale the viewport requires.

One splat:

```
position   (x, y)          in source-image coordinates
covariance (sx, sy, theta) ellipse: two radii + rotation
color      (r, g, b)       signed contribution
amplitude  a
```

Reconstruction is **additive**:

```
I(p) = clamp( SUM_i  a_i * c_i * exp( -0.5 * (p - x_i)^T  S_i^-1  (p - x_i) ) )
```

Three consequences fall straight out of that sum, and they are what make this a good
*protocol* rather than just a cute representation:

1. **Order independence.** Addition commutes. Splats can arrive in any order, over any
   path, and the render is identical. No head-of-line blocking, no sequencing, no
   reassembly buffer.
2. **Any subset is a valid image.** Drop 90% of the splats and you get a softer version
   of the same picture — never a hole, never a missing tile. Congestion degrades
   *quality*, never *completeness*.
3. **Resolution independence.** The same splats render at any zoom. There is no "level"
   to re-fetch when the user scales by 1.3x.

### Why this fits the ESO image specifically

`eso1242a` is the galactic centre: a star field. A star on a telescope sensor **is**
a Gaussian — that is the point spread function of the instrument. We are not approximating
the image with an arbitrary basis; we are encoding it in the basis its own physics used to
create it. That argument alone is worth a section in the document, and no classmate
running a generic tiler will have it.

Photographic / structured regions (nebula gradients, dust lanes) also fit well, since
smooth gradients are cheap for Gaussians. The weak case is high-frequency texture at 1:1
(see §8 Risks).

---

## 2. Multi-scale: how "levels" work without a pyramid

Fitting is **matching pursuit across scales** (like a Laplacian decomposition, but in
splat space instead of pixel space):

- Level 0: fit the image downsampled by `2^Lmax` with N splats (large sigma).
- Level L: fit the *residual* of what levels `< L` already reconstruct, at resolution
  `2^(Lmax-L)`. Splats at level L have sigma roughly half of level L-1.
- Deepest level: sigma on the order of a few source pixels.

Because each level fits a residual whose local mean is ~0, **dropping fine splats is
approximately lossless at coarse scale**. That is what makes zoom-out safe: the client
deletes the fine splats and the coarse reconstruction stays correct.

### The selection predicate (the heart of the protocol)

With `s` = source pixels per screen pixel at the current zoom, a splat is worth sending
if and only if its footprint on screen is neither invisible nor flat:

```
1 screen px   <=   sigma_i / s   <=   ~100 screen px
```

- Below 1: sub-pixel, contributes nothing visible → do not send / drop it.
- Above ~100: already covered by coarser splats the client has → redundant.

Zoom in → the band slides down → new fine splats are **transferred**.
Zoom out → the band slides up → fine splats are **deleted**.

That is literally the professor's requirement ("transferencia y eliminación de información
para aumentar o disminuir la resolución") expressed as a single inequality. Good line
for the document and for the defense.

---

## 3. Storage layout (server side)

Splats are grouped by `(level, cell)`, where cells partition each level's resolution
(e.g. 512x512 at that level). **The cell grid is an index, not a transmission unit** —
we never send a cell, we send splats from it. This distinction must be explicit in the
document, otherwise a grader reads "grid" and thinks "tiles".

Inside each `(level, cell)`, splats are stored **sorted by error reduction** — the splat
that removed the most squared error first. This gives a property we exploit everywhere:

> Any **prefix** of the list is the best possible reconstruction with that many splats.

### Packed record — 12 bytes

| field | bits | encoding |
|---|---|---|
| dx, dy | 16 + 16 | position inside the cell, fixed point |
| log sigma_x, log sigma_y | 8 + 8 | log-quantized |
| theta | 8 | 0..pi |
| r, g, b | 8 + 8 + 8 | signed residual colour |
| amplitude | 8 | log-quantized |
| | **88 bits = 11 B** | |

Estimated total for the 9-gigapixel ESO image at ~1 splat per 30 px, summed over levels:
roughly **400M splats ≈ 4.4 GB** versus 24.6 GB of source. Honest caveat: a JPEG pyramid
would probably be *smaller* on disk. We do not win on storage; we win on client memory,
progressiveness, and order independence. Say so in the document rather than letting the
grader find it.

Container: one packed file per image — header, level/cell index (offset + count per
`(level, cell)`), then the splat arrays. Positional `FileChannel` reads, no DB needed.

---

## 4. The protocol

Transport: our own WebSocket (RFC 6455) after the HTTP bootstrap. Binary frames.
**Rename every message below before writing the document** — names are the easiest thing
for two projects to accidentally share.

### Messages

| Direction | Message | Payload |
|---|---|---|
| C→S | `HELLO` | version, screen w/h, DPR, WebGL float support, splat budget |
| S→C | `WELCOME` | session id, catalog of images |
| C→S | `OPEN` | image id |
| S→C | `META` | dimensions, level count, cell size, sigma range per level |
| C→S | `VIEW` | **epoch**, centre x/y, scale s, viewport w/h, optional velocity |
| C→S | `CREDIT` | **n splats** the client can still accept |
| S→C | `SPLATS` | epoch, level, cellId, startIndex, count, packed records |
| S→C | `RETIRE` | level, cellId, newCount (client truncates to this prefix) |
| C→S | `DROPPED` | level, cellId, newCount (client evicted on its own; resync ledger) |
| C↔S | `PING` / `PONG` | timestamp, for RTT and rate estimation |
| S→C | `ERROR` | code, message |

### Two properties worth highlighting in the document

**(a) The per-client ledger is a prefix count, not a set.**
Because splats are importance-ordered, everything the server needs to know about a client
is one integer per `(level, cell)`:

```
held[(level, cell)] = number of splats the client holds
```

An upgrade is "send `[held, held+k)`". A downgrade is "`RETIRE` to a smaller count".
No bitsets, no hashes, no Bloom filters, no digests to resync. Per-client state is a few
KB even for thousands of cells, which is what makes thousands of concurrent clients
cheap — directly answering requirement #2 of the brief.

**(b) Credits are denominated in splats, so one number governs both problems.**
A splat has a fixed client-side cost. Therefore the credit window *is* the memory cap:
flow control and the 50 MB ceiling are the same mechanism, not two mechanisms that have
to agree. Cite HTTP/2 `WINDOW_UPDATE` (RFC 9113 §5.2) as prior art for credits, then point
out that denominating them in *objects with fixed cost* is what collapses the two.

### Scheduling on the server

For the current epoch, walk cells intersecting the viewport, nearest-to-centre first,
coarse levels first, emitting splats from each cell's prefix while credits last.
A new `VIEW` bumps the epoch and **discards queued work from older epochs** — otherwise a
user panning three times pays for three dead viewports, which is where congestion actually
comes from.

### Congestion behaviour

- Credits bound in-flight data. No credits, no send. Nothing queues on the socket.
- EWMA of goodput from `PING`/`PONG`; if queueing delay rises while delivery rate stays
  flat (the bufferbloat signature), reduce the target splat density multiplicatively.
- Degradation is **graceful and complete**: fewer splats = softer image, never a hole.

---

## 5. Client side

Render with **WebGL2**, instanced quads, additive blending (`blendFunc(ONE, ONE)`),
into a float16 render target (`EXT_color_buffer_float`), then tone-map to the canvas.
Signed colours need the float target; the 8-bit fallback is two passes
(positive and negative) or a +0.5 bias.

Each splat becomes one instanced quad sized `6*sigma` with the Gaussian evaluated in the
fragment shader. Splat attributes live in a GPU buffer; eviction is a compaction of that
buffer, so "deleting information" is real and measurable, not a JS object dropped for the
GC to maybe collect later.

### Memory budget (the 50 MB rule)

| item | cost |
|---|---|
| float16 render target @ 1920x1080 | ~16 MB |
| splat GPU buffer @ ~40 B/splat | 750k splats ≈ 30 MB |
| JS-side staging / decode | ~4 MB |
| **total** | **~50 MB** |

A sharp 1920x1080 screen needs roughly **70k–140k splats** (1 per 15–30 px). So a 750k
budget is 5–10x what is on screen: plenty of room for a prefetch ring, and the cap is
never actually the binding constraint. Put this arithmetic in the document — it shows the
50 MB limit was designed for, not hoped for.

Render cost: ~150k quads with ~20x20 px footprints ≈ 60M fragments/frame. Comfortable on
a discrete GPU, acceptable on integrated; cap the budget if `frameTime > 16 ms`.

---

## 6. Ingest pipeline (Java)

The expensive part. Greedy matching pursuit per `(level, cell)`:

1. Keep a coarse **residual energy map** (e.g. 16x16 blocks) for the cell.
2. Pick the peak block, then the peak pixel inside it.
3. Fit a local Gaussian by moment matching on a small window, plus 2–3 Gauss–Newton
   refinement steps.
4. Subtract it from the residual — **only inside its 3-sigma footprint** — and update the
   affected blocks of the energy map.
5. Repeat until the target PSNR or the splat budget for that cell is reached.

Cost per splat is proportional to its footprint (a few thousand operations), *not* to the
cell size, because step 4 is local. That is what makes this tractable at all.

Rough estimate: ~50–100 ms per 512x512 cell → the full 9 Gpx image is hours across all
levels, parallelised over cores. Mitigations:

- **Lazy fitting**: fit a cell on first request, cache the result to the packed file.
  Effectively a server-side "generate once, serve many" cache, and a nice metric to
  report (`GENERATED` vs `CACHED`).
- Precompute only the levels needed for the demo; deeper cells fit on demand.

**Reading the source:** the ESO file is a 24.6 GB TIFF. `ImageIO` with
`setSourceRegion` + subsampling can read regions of tiled TIFFs, but is fragile at this
size. Budget time for a minimal TIFF strip/tile reader of our own — it is maybe 200 lines
for uncompressed or LZW strips, and it becomes the "how we store and process the image"
section of the document. Map with `MemorySegment` + `Arena` (no 2 GB limit, unlike
`MappedByteBuffer`).

---

## 7. What we measure (for the 35% document)

- **Splats vs PSNR/SSIM** curve per level — the progressive-quality curve.
- **Bytes on the wire vs SSIM**, compared against a naive JPEG-tile baseline.
  Build the baseline; being able to say "we measured against the obvious approach and here
  is where we win and where we lose" is worth more than claiming we win everywhere.
- **Client memory over a 10-minute browsing session** — flat line at the cap, which is the
  whole point versus a tile cache that grows.
- **Bytes wasted on stale epochs** with and without cancellation.
- Splats/second, cells fitted/second, concurrent clients sustained.

---

## 8. Risks, honestly

| Risk | Severity | Mitigation |
|---|---|---|
| Rate–distortion worse than JPEG at 1:1 zoom | **high** | Cap the deepest level; allow a hybrid "pixel patch" mode for the last octave. Document the crossover point instead of hiding it. |
| Ingest time for the full 24.6 GB | high | Lazy per-cell fitting + cache; demo on a 2 GB image plus a fitted region of the ESO one. |
| Fitting quality on high-frequency texture | medium | More, smaller splats (costly) or the hybrid pixel mode. Star fields are the good case; foliage/crowds are the bad one. |
| WebGL float target unsupported | medium | Two-pass 8-bit fallback; negotiate in `HELLO`. |
| Hard to debug visually | medium | Debug overlay drawing splat ellipses; a "splat inspector" showing which splat contributes where. Build this early — it pays for itself. |
| Graded offline | low | Everything is ours; no libraries. Ship a pre-fitted image in the repo. |

**Fallback plan:** if fitting quality disappoints at depth, the protocol survives unchanged
with a hybrid representation (splats for levels 0..L-1, pixel patches for the deepest).
The ledger, credits, epochs and selection predicate are all independent of what a "splat"
actually contains. Design the message format so the payload type is a field, not an
assumption — then a bad fitting result costs us quality, not the architecture.

---

## 9. Build order

1. Fitter for a single cell, offline, with a PSNR report. **Decide go/no-go here** — if the
   quality curve is bad on a real crop of the ESO image, switch to a stack from
   [protocol-ideas.md](protocol-ideas.md) before writing any server code.
2. WebGL2 renderer fed by a static `.splat` file. Confirms the visual result and the
   frame budget.
3. Multi-level fitter + packed file + index.
4. Java HTTP server (static files) + our WebSocket upgrade.
5. Protocol: HELLO/META/VIEW/SPLATS + ledger. No credits yet.
6. Credits, epochs, RETIRE/DROPPED, prefetch ring.
7. Instrumentation, HUD, measurement runs, JPEG baseline.
8. Document.

Steps 1 and 2 are the whole gamble. They are also two evenings of work, which is a cheap
way to find out whether the moonshot flies.

---

## 10. Open questions

All resolved — see §11.

---

## 11. Decisions (locked 2026-09-16)

### Settled by us

| Question | Decision | Reason to give in the defence |
|---|---|---|
| Additive vs normalized | **Additive, greedy matching pursuit** | The prefix property is what the ledger, `FADE`, and credit-bounded quality all rest on. Normalization destroys it. Also what makes zoom-out free: fine splats are corrections with ~zero local mean, so deleting them leaves the coarse image correct. |
| Colour space | **sRGB** (the space the file is stored in) | We approximate a stored image, not simulate light. Fit and render in the same space; 8-bit residuals stay perceptually even. |
| Deepest level | **Capped at s = 1** (1 source px per screen px). No pixel fallback for now | Measure the crossover first. The payload type is a field in the frame, so a hybrid can be added later without touching the protocol. |
| Velocity / prediction | **Skipped.** Field reserved in `GAZE`, unused | Prefetch ring covers normal panning, and predictive viewport is one of the five crowded families the class will submit. Listed as future work. |

### Chosen defaults (mine — change any of these if you disagree)

**Naming.** Protocol **ASTRA** (Adaptive Splat Transfer & Retirement Architecture),
version tag `ASTRA/1`. The transmission unit is a **splat** — the standard term for this
primitive, and the honest one: the representation really is Gaussian splatting, adapted to
2D and to streaming. Never "tile" or "patch" in our own writing, since those imply a grid
of pixels and that is precisely what we do not send. Container file: `.splat`, magic `ASTR`.

**Message set** (replaces the generic names in §4 — rename everywhere):

| Dir | Message | Purpose |
|---|---|---|
| C→S | `GREET` | version, screen w/h, DPR, float-target support, splat budget |
| S→C | `ALMANAC` | session id + image catalogue |
| C→S | `FOCUS` | open image by id |
| S→C | `CHART` | dimensions, level count, cell size, sigma band per level |
| C→S | `GAZE` | epoch, centre x/y, scale s, viewport w/h, *(reserved: velocity)* |
| C→S | `ALLOW` | credit, in splats |
| S→C | `SPLATS` | epoch, level, cell, startIndex, count, packed records |
| S→C | `FADE` | level, cell, newCount — client truncates to this prefix |
| C→S | `SHED` | level, cell, newCount — client evicted on its own, resync ledger |
| C↔S | `ECHO` | timestamp, for RTT / rate estimation |
| S→C | `FAULT` | code, message |
| C→S | `PART` | close session |

**Frame header (12 B, big endian):** `magic 'A''S' (2) | ver (1) | type (1) | epoch (4) | length (4)`

**Geometry.** Cells 512x512 at each level. Level count =
`ceil(log2(maxDim / 2048)) + 1` → **7 levels** for the 108200x81500 ESO image
(level 0 ≈ 1690 px on the long side). Sigma band per level as in §2.

**Fitter stopping rule.** Per cell, stop at **PSNR ≥ 38 dB** or **8k splats**, whichever
comes first. Record both numbers per cell — they become the document's quality tables.

**Client defaults.** Budget **700k splats** (~28 MB) + 16 MB render target ≈ **44 MB**,
leaving headroom under the 50 MB ceiling. `GAZE` throttled to **10 Hz**. Prefetch ring =
**0.5 screen** beyond the viewport.

**Credit policy.** Initial `ALLOW` 50k splats; top up when the window falls below 25%.
Server sends at most **4k splats per `SPLATS` frame** (~48 KB), so cancellation on a new
epoch is fine-grained.

**Server runtime.** `AsynchronousServerSocketChannel` + completion handlers for the socket
and protocol path — it matches the project title and is the defensible reading of
"servidor asíncrono". Virtual threads only for the ingest/fitting worker pool, so CPU-bound
fitting never blocks the I/O path.

**Build.** Java 21, **zero third-party jars** (graded offline). Plain `javac` over a single
`src/` tree plus a shell script; no Maven/Gradle so it builds anywhere. Frontend: vanilla
JS + WebGL2, no libraries, served by our own Java HTTP handler.

**Test data.** Milestone 1 runs on an **8192x8192 crop of the ESO image** plus one 2 GB
Wikimedia image. No need to touch the full 24.6 GB until the fitter is proven.

**Go/no-go for milestone 1:** on the ESO crop, **PSNR ≥ 35 dB at ≤ 1 splat per 30 px**.
If we miss it, stop and switch to a stack from [protocol-ideas.md](protocol-ideas.md)
before any server code exists.

---

## 12. Milestone 1 result — measured 2026-09-16: **NO-GO — SUPERSEDED 2026-09-17**

> **This verdict was wrong, and the fault was in the fitter.** Joint optimisation
> (`tools/splat_fit_torch.py`) reaches **35.75 dB where the greedy fitter below reached
> 24.69 dB**, at the same 4000 splats and the same 43 KB — and a clamping bug in the
> position encoding was costing a further 8.5 dB. See the correction at the top of
> `measured-numbers.md`. The section below is kept as the record of how the greedy fitter
> behaved, not as a judgement on Gaussian splats.

Fitter: `tools/SplatFit.java` (greedy matching pursuit, 7-scale dictionary + moment-based
anisotropy, quantized to the real 12-byte record, so the numbers include quantization loss).
Test image: `face1.jpg` (3127x4691 portrait), 256x256 cells, plus controls.

| Cell | Splats | Splat bytes | Splat PSNR | JPEG q30 bytes | JPEG q30 PSNR |
|---|---|---|---|---|---|
| Hat weave (hard texture) | 4000 | 46.9 KB | **24.69 dB** | 7.1 KB | **30.70 dB** |
| Face (mid frequency) | 4000 | 46.9 KB | **27.95 dB** | 6.9 KB | **30.69 dB** |
| Blurred background (easy) | 4000 | 46.9 KB | **32.88 dB** | 3.3 KB | **34.56 dB** |

**Splats cost ~7-14x more bytes and still deliver visibly worse quality, on every class of
real content — including the easiest one.** Visual check confirms PSNR is not misleading
here: at 47 KB the hat weave is destroyed (structure replaced by disconnected blobs) while
JPEG at 7 KB preserves it. The face shows characteristic speckle artifacts.

**Figure:** `out/fig1_hat.png` (and `out/fig1_face.png`) — original / splats / JPEG at the
**same byte budget**, generated by `tools/FigCompare.java`. Given the identical **44.0 KB**
that 4000 splats consume, JPEG reaches **46.6 dB** — visually indistinguishable from the
original — against the splats' 24.7 dB. This is the single clearest figure for the
document: same bytes, one panel perfect, one panel destroyed.

### Controls that initially looked like passes, and why they were not

- **Synthetic star field**: 267 splats (3.1 KB) → 38.1 dB. Circular — the test image is
  literally a sum of Gaussians. Proves the fitter works, nothing about real content.
- **Dark flat photo crop**: 100 splats → 42.7 dB. A flat region is trivial for any
  representation. My first "GO" came from an accidentally near-black crop.

Lesson for the document: **choose test crops by inspecting the image**, and always include
a hard-texture cell. Both false positives came from easy content.

### What was not the problem (all measured)

- **Speed**: 2,700-4,900 splats/s per 256x256 cell. Ingest was never the blocker.
- **Quantization**: fitting at full precision (`--noquant`) plateaus at **26.00 dB** against
  **26.26 dB** quantized — *worse*, not better. A larger record would buy nothing.
- **Splat count**: the greedy fitter **saturates**. Hat crop: 24.69 dB at 4k splats, 26.25
  at 16k, then 26.262 at 24k, 32k and 40k — identical to three decimals. 10x the bytes
  buys +1.6 dB and then nothing at all.

| splats | quantized dB | unquantized dB |
|---|---|---|
| 4,000 | 24.69 | 25.16 |
| 8,000 | 25.69 | 25.76 |
| 16,000 | 26.25 | 26.00 |
| 24,000-40,000 | 26.262 (flat) | 26.001 (flat) |

Why it saturates: each splat is fitted to the current residual peak and never revisited, so
overlapping splats interfere and the residual decays into high-frequency noise that no
single smooth Gaussian can reduce. The projection gain per new splat falls to nothing.

### The one untested lever

**Joint gradient-descent optimization** over all splat parameters at once — moving and
re-colouring earlier splats instead of freezing each on placement — is what real image-GS
work does, and it is the only remaining path to higher quality. Literature suggests a few
dB, against a measured ~22 dB gap at equal bytes. Not attempted, and not worth attempting
for this project.

### Two corrections to earlier numbers in this file

1. The record is **11 bytes**, not 12 — the fields sum to 88 bits. Splat costs quoted in
   the sections above are ~9% too high, and the storage estimate becomes ~4.4 GB, not 5 GB.
2. `encode()` wrote 11 bytes into 12-byte slots, so `splats.bin` ended with a tail of zero
   padding, and `xxd -c 12` framing turned the misalignment into apparent duplicate records.
   First diagnosed as "the fitter emits degenerate null splats" — **that diagnosis was
   wrong**; it was an encoder framing bug. Fitting results were never affected, and the
   saturation above is real and independent of it.

### Why this is a genuine finding, not a wasted week

Requirement #6 of the brief says new images can be added to the server. A representation
that only works on star fields is a liability: the grader can drop in a photograph.
The measurement harness (`SplatFit.java` + JPEG baseline + PSNR curves) is reusable for
whichever representation we pick next, and "we implemented it, measured it against the
obvious baseline, and rejected it on the data" is a document section no classmate will have.

### Options from here

1. **Switch to stack A** (motion compensation + cache dictionary + perceptual budget).
   Recommended. Cost so far: one evening.
2. **Keep splats only for the coarse overview layer** (instant complete image in ~250 KB)
   on top of a different mechanism for detail. Preserves the distinctive first-paint demo;
   the deep levels, which carry the bytes, would be someone else's mechanism.
3. Improve the fitter and retest — expected to narrow the gap by a few dB, not to close it.
4. Test on real astronomical data before deciding — blocked on not having the ESO image
   locally, and argues against the content-type bet anyway (see requirement #6).
