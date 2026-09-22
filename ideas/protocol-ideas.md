# PROJECT02 — Protocol ideas (working notes)

Async Java server for ultra-high-resolution images. Notes for choosing our own
image-transfer protocol. Nothing here is decided yet.

## Constraints we are designing against

- Java 20/21, asynchronous, multiple simultaneous clients.
- HTTP only for bootstrap (page, JS, CSS, libs). Image travels over **our own protocol**.
  In a browser that means WebSocket (RFC 6455), hand-implemented.
- Browser memory: **50 MB hard ceiling** for image data.
  - 1920x1080 RGBA canvas = 8.3 MB; 2560x1440 = 14.7 MB. Budget accordingly.
- Congestion must be handled *inside* the protocol, not as an afterthought.
- Graded **offline**: no CDNs, no external requests, no libraries we cannot ship.
- Not a plain zoom: information must be **transferred AND deleted** when resolution changes.
- Grading: backend 35% / frontend 30% / **protocol document 35%**.
- Ruled out by us: classic tile pyramid. Taken by someone else: "convert image, put it in a DB".

---

## Why originality is a problem here

Four models (Grok, Gemini, Claude, ChatGPT) were asked the same question and converged
on the same five families. Expect most of the class to submit one of these:

| Family | Proposed by |
|---|---|
| Adaptive / content-aware regions (quadtree) | Grok #1, Gemini #1, Claude C, ChatGPT #1/#10 |
| Wavelets / frequency layers (JPEG2000-ish) | Grok #2, Gemini #3, Claude A, ChatGPT #3 |
| Memory budget / leases / evictions | Grok #5, Claude (credits), ChatGPT #5/#8 |
| Predictive viewport (velocity, prefetch) | Grok #3, Claude F, ChatGPT #4 |
| Viewport-as-query / differential updates | ChatGPT #6/#9, Grok #1 |

Rarer in that set: content-addressed hashing (Grok #4), VQ codebook (Claude E).

**Conclusion:** the differentiator is not the idea family, it is the specific mechanism,
our own naming, and our own measurements. Avoid the five rows above as the *core* idea;
they are fine as secondary layers.

---

## The eight candidate ideas

Each = representation (how pixels are decomposed) or control (how transfer is governed).
A real design picks **one representation + one control mechanism**.

### 1. Client cache as compression dictionary (2D LZ77)  — *representation*

Server keeps an exact mirror of what the client holds. Before sending a new block, it
searches the client's existing blocks for a **visually similar** one and sends
`COPY from (x, y, scale) + residual` instead of pixels.

- Exploits *similarity between different regions*, not identity. Big images repeat a lot:
  sky, sea, vegetation, façades, crowd texture.
- Everyone else's "don't resend what the client has" is hash/identity based. This is not.
- Cost: block matching at ingest (index perceptual hashes of blocks, e.g. dHash 64-bit).
- Metric for the document: **dictionary hit rate** on eso1242a.
- Cites: RFC 3229 (delta encoding in HTTP), RFC 8478 (Brotli shared dictionary), LZ77,
  fractal / self-similarity compression literature.

### 2. Navigation as video — motion compensation  — *representation*

Pan and zoom *are* camera motion. Client keeps **one reference frame**; server sends
P-frames: global motion vector + quantized residual only where prediction fails.

- Client memory is **constant** (~16 MB: reference + work frame), forever, regardless of
  how long the user browses. Strongest answer to the 50 MB constraint.
- Different from RFB/COPYRECT (which just copies pixels): this *predicts* them, zoom
  included, with a residual on top.
- Cost: our own mini inter-frame codec; residual encoding must be cheap in JS.
- Cites: H.264/VP8 motion compensation concepts (RFC 6386), RFC 6143 (RFB) for the
  framebuffer model.

### 3. Rateless / fountain codes + interest aggregation  — *control*

Server does not send "block 42". It emits **random linear combinations** of a region's
symbols. Any client collecting *k* symbols reconstructs, regardless of which ones.
Clients watching overlapping regions are served by **the same symbol stream**.

- Best answer to the multi-client requirement; symbols are not addressed to anyone.
- Congestion control becomes trivial: emit fewer symbols/second. No retransmissions,
  no per-client send queues.
- Cost: LT decoder in JS (a simple LT code is a few hundred lines); only pays off with
  several concurrent clients — which is exactly the demo.
- Cites: RFC 5053 (Raptor), RFC 6330 (RaptorQ), RFC 3453 (FEC / reliable multicast).

### 4. Closed-loop feedback: client reports its own error  — *control*

Invert the control flow. Client computes locally **where its reconstruction looks worst**
(Laplacian energy, or expected vs actual sharpness) and returns a tiny
**dissatisfaction map** (8x8 values = 64 bytes). Server spends its byte budget there.

- Everyone else has the server *guessing* client needs from a rectangle. Here the client
  measures perceived error and closes the loop, like a control system.
- Document angle: a genuine feedback loop — convergence, stability, oscillation.
- Cheap to implement, stacks on any representation.

### 5. Perceptual budget (JND / contrast sensitivity)  — *policy layer*

Server models the human contrast sensitivity function at the current scale and device DPR
(reported by the client) and never transmits information below the just-noticeable
difference. "We never send what the eye cannot distinguish at this zoom."

- Document angle: bytes-vs-SSIM curve; show ~40% byte reduction with no visible change.
- Pure policy: stacks on top of any of 1, 2, 7.

### 6. Implicit scheduling (zero-request protocol)  — *control*

Client and server run **the same deterministic scheduler** from a shared seed. Both know
which block comes next, so the client **never requests anything** — it only sends
*changes of intent* (viewport moved, budget changed). Coordinates never go on the wire.

- Reframes the protocol as two synchronized state machines instead of request/response.
- Great document section. Painful to debug when the two sides desynchronize.

### 7. Image as a set of 2D Gaussians (splatting)  — *representation*

Each region is a set of 2D Gaussians (position, covariance, color), fitted greedily
against the residual. Stream **splats ordered by visual contribution**. Zoom in = more
splats; zoom out = drop splats.

- Client stores no pixels at all — a **parametric representation** rendered at any scale
  (canvas / WebGL). A region costs kilobytes.
- Highest risk, highest impact. Fitting is expensive (do it lazily per region) and
  photographic fidelity is limited.

### 8. Set reconciliation (Bloom / IBLT)  — *auxiliary mechanism*

Client sends an **invertible Bloom filter** of its held set; server subtracts it from the
target set and derives the difference in a couple hundred bytes, even for thousands of
blocks. Pairs naturally with #1.

- Cites: IBLT / minisketch literature, Bloom filters.

---

## Candidate stacks

**A. "Sender-side prediction"** — #2 motion compensation + #1 cache dictionary + #5 perceptual budget.
Best effort-to-impact ratio. Constant client memory, strong numbers for the document,
zero overlap with the class's five families. All plain arithmetic, implementable by hand.

**B. "Distributed systems"** — #3 fountain codes + #8 reconciliation + #4 feedback.
Strongest on the concurrency requirement (35% backend). Most impressive live demo:
several browsers served by one symbol stream.

**C. "Moonshot"** — #7 splats + #4 feedback.
Best project in the class if it works; very little to show if it does not.

---

## Earlier non-pyramid options (kept for reference)

Discussed before the four-model comparison; several overlap with what the class will submit.

1. **RFB / VNC style** — client holds one screen-sized canvas; server sends changed rects +
   COPYRECT on pan. Constant ~8 MB. Latency on pan, server CPU per client. RFC 6143.
   (Superseded by #2, which predicts instead of only copying.)
2. **Adaptive quadtree SPLIT/MERGE** — MERGE literally deletes information on zoom out.
   Clean story, but this is the class's most crowded family.
3. **Haar wavelets in a DB** — no redundancy (a pyramid stores ~33% extra). Strong
   academically; also crowded, and "that's JPEG2000" is an easy attack.
4. **Z-order (Morton) storage** — any square region becomes a contiguous byte range;
   good *storage layer* under any representation, not a protocol by itself.
5. **Seeded progressive sampling** — shared Halton/Sobol sequence, only colors on the wire,
   coordinates implied. Folded into #6.

---

## Cross-cutting decisions still open

- **Transport framing:** binary WebSocket frames. Draft header:
  `magic(2) | ver(1) | type(1) | epoch(4) | len(4) | payload`, big endian.
  (Rename everything — message names are the easiest thing for a classmate to duplicate.)
- **Congestion:** credit window in *decoded* bytes + epochs (every VIEW bumps the epoch;
  server drops queued work from stale epochs). Cites: RFC 9113 §5.2 WINDOW_UPDATE, BBR.
- **Concurrency model:** `AsynchronousServerSocketChannel` (fits the "asynchronous server"
  title) vs Java 21 virtual threads (simpler). Keep CPU-bound codec work off the I/O path.
- **Large file access:** `MemorySegment` + `Arena` (no 2 GB mapping limit, unlike
  `MappedByteBuffer`).
- **Numbers must be ours:** block size, credit window, memory split — all from benchmarks
  on our machine and our image, not from defaults suggested by a model.

**All measured figures are collected in [measured-numbers.md](measured-numbers.md)** —
quote from there rather than from memory, and note which figures are estimates.

## Status

**#7 (2D Gaussian splats) was tried and REJECTED on measured data, 2026-09-16.**
The fitter (`tools/SplatFit.java`) showed splats cost ~7-14x more bytes than JPEG and
still look worse, on every class of real photographic content. Full numbers and the
reasoning in [idea7-gaussian-splats.md](idea7-gaussian-splats.md) §12 — that file stays as
the record of a measured negative result, which is worth a section in the document.

**Now pursuing option B**, four experiments run 2026-09-16 — see
[optionB-viability.md](optionB-viability.md):
- #1 copy references / cache-as-dictionary: **failed** (0.6% usable matches on real texture).
- Residual refinement: promising in one step (1.6x-3.4x), but **only ~1.2x once chained**
  across real zoom levels, with 1-3 dB of accumulated error per level. Demoted from the
  core claim.
- **The zero-byte rule is the real win**: skip regions where the client's own upscale is
  already good enough — 24-53% of bytes on a demanding portrait, ~98% on flat content,
  with no quality loss. This is the perceptual budget (#5) with a measured rule.
- Payload settled: server-chosen rectangles coded fresh as JPEG (true pixel quality,
  browser-native decode, no codec to write). Originality lives in the control plane.

Whatever we pick, reuse the measurement harness from milestone 1: fit/encode a 256x256
cell, plot PSNR vs bytes, compare against the JPEG baseline at equal quality. And pick
test crops **by looking at the image** — both false positives in milestone 1 came from
accidentally easy content (a near-black crop, and a synthetic image literally made of
Gaussians).
