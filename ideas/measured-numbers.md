# Measured numbers — quick reference

Every figure below was **measured on this machine on 2026-09-16**, not estimated.
Test image unless stated: `face1.jpg`, a 3127x4691 portrait with three content types —
hat weave (hard texture), face (mid frequency), bokeh background (smooth).
Tools: `tools/{SplatFit,CopyScan,ResidualTest,ChainTest,ZeroByteScan}.java`.

Design *estimates* (browser memory budget, first-paint timings, ingest hours) are collected
at the bottom and clearly marked — do not quote those as measurements.

---

## Session simulation (2026-09-18): memory, requests and smoothness — the real criteria

Everything above measured **bytes per tile at equal quality**. The viewer is judged on
something else: memory that stays flat, few requests, smooth zooming, fast loading
(reference: EarthCam's panorama, whose image cache peaks near 900 MB with a flood of
requests). `tools/session_sim.py` measures exactly that over a scripted 24 s session
(start at full view, zoom in, pan, zoom out, two more dives, revisit the first spot) on the
real ingested tile stores, 1280x720 viewport, one bottleneck link, 60 ms RTT, measured JPEG
decode time (0.45 ms/tile Holbein, 0.87 ms ESO). Every frame is composited the way a viewer
draws (coarser held level underneath, finer on top) and scored against the ideal frame.
Figures: `out/session/fig_session_<run>.png`, `out/session/fig_snaps_<run>.png`.

Strategies: **A** naive tiles (one HTTP GET per tile for every level the zoom passes, no
cancel, no eviction); **B** our protocol (viewport message, server pushes centre-first and
drops queued tiles a newer viewport no longer needs) with a 50 MB decoded-bitmap LRU;
**C** same protocol, cache held as compressed JPEG, only on-screen tiles decoded; **D**
same protocol, levels >= 3 sent and cached as splats (4000 x 11 B per tile). B/C/D never
evict the overview level (a few MB).

| run | | A naive | B decoded | **C compressed** | D splats |
|---|---|---|---|---|---|
| Holbein 56 MP, 20 Mbit/s | peak memory | 184 MB, rising | 50 MB | **50 MB peak, 15 at rest** | 50 MB |
| | client->server msgs | 763 | 197 | **197** | 197 |
| | downloaded | 9.3 MB | 12.9 MB | **8.9 MB** | 15.0 MB |
| | seconds < 35 dB | 2.5 | 3.4 | **2.7** | 11.4 (est.) |
| Holbein, 5 Mbit/s | peak memory | 184 MB | 50 | **35** | 50 |
| | downloaded | 9.3 MB | 5.7 | **5.4** | 6.2 |
| | seconds < 35 dB | 10.0 | 5.9 | **5.5** | 14.0 (est.) |
| | holds never completed | 4 of 9 | 0 | **0** | 0 |
| ESO 471 MP, 20 Mbit/s | peak memory | 287 MB, rising | 50 | **50** | 50 |
| | client->server msgs | 1158 | 197 | **197** | 197 |
| | downloaded | 40.6 MB | 23.1 | **21.1** | 22.8 |
| | seconds < 35 dB | 13.1 | 10.6 | **10.1** | 16.2 (est.) |
| | holds never completed | 4 of 9 | 0 | **0** | 0 |
| ESO, 5 Mbit/s | downloaded | 14.0 MB (398 of 1158 requested tiles ever arrived) | 10.5 | **9.6** | 9.8 |
| | holds never completed | 5 of 9 | 3 | **3** | 4 |

What it shows:

- **Memory stability is a policy, not a representation.** A's memory is a staircase that
  only goes up (184-287 MB in 24 s; at that rate EarthCam's 900 MB is 1.5-2 minutes of
  browsing). A hard budget with eviction keeps B/C/D flat by construction; the only
  question is what the budget costs.
- **A compressed cache is the best answer to that cost.** C holds tiles as JPEG (~12-35 KB)
  instead of bitmaps (256 KB), so the same 50 MB keeps 7-20x more tiles, sits at 10-30 MB
  between gestures, and re-downloads least (8.9 MB vs B's 12.9 on Holbein; on the final
  revisit B had evicted the spot and refetched, C had not). Price: ~1000 re-decodes per
  session at 0.45 ms = under 0.5 s of CPU in 24 s.
- **Requests: 4-6x fewer** (197 viewport messages vs 763-1158 GETs), independent of image.
- **Cancellation is what keeps slow links usable.** A never cancels, so every level it flew
  past stays queued ahead of the one on screen: after landing, its view stays blocky for
  seconds (4-5 of 9 holds never complete; ESO snapshot 0.3 s after landing: A 10.9 dB, ours
  36.8 dB) and it spends ~2x the bytes on ESO. On a fast link with small tiles (Holbein
  20 Mbit/s) A is as smooth as ours — by holding 184 MB.
- **Mid-zoom blur happens to everyone** (~30 dB painting, ~16 dB star field while passing
  through levels): tiles for a level you are flying through cannot arrive in time. No
  representation fixes that; only predictive sending (the zoom's destination first) or a
  coarse-first schedule could — both are protocol features, not yet tested.
- **CORRECTION (measured with real splat renders, below): splats do win on peak memory.**
  The bullet that follows said they help no criterion; that was based on D, which cached deep
  tiles as decoded bitmaps, and on quality estimated from face tiles only. See "Splat video".
- **Splats (D) do not help any criterion.** More bytes than C (15.0 vs 8.9 MB on the
  painting, since a splat tile is 43 KB vs an 11.5 KB JPEG), blurrier (splats cap at 30-35 dB
  on the painting, **16-23 dB on the star field**), and no memory advantage over a
  compressed cache (a splat tile is larger than the JPEG it replaces). Fitting is also
  impractical at gigapixel scale: 55-107 s per tile on the M-series GPU = 13-25 days for
  ESO's 20,375 tiles. D's quality curve is an estimate from real per-level fits at 1000
  iterations; 2000 iterations adds ~1.5 dB on the painting, ~0.2 dB on stars.

### Fixing the mid-zoom blur (2026-09-18): prediction works, coarse-first does not

Same simulator and sessions, variants built on C. **E** coarse-first: each viewport update
first asks for a cover 3 levels coarser (~1/4 of the tiles). **F** predictive: the client
knows where its own zoom animation will be 0.3 s ahead (true for wheel/button zoom, which
animates toward a known target) and the server sends that view first. **G** = E + F.
**H** = E + prediction by velocity extrapolation. **I** = velocity prediction alone (what a
pinch gesture allows). Figures: `out/session/fig_session_*_predict.png`,
`out/fig_midzoom_holbein.png`, `out/fig_midzoom_eso.png`.

Seconds of the 24 s session below 35 dB (downloaded MB in brackets):

| run | A naive | C | E cover | **F predict** | G both | H cover+vel | I velocity |
|---|---|---|---|---|---|---|---|
| Holbein 20 Mbit/s | 2.5 (9.3) | 2.7 (8.9) | 2.4 (9.1) | **1.4 (9.1)** | 1.5 (9.3) | 1.6 (10.1) | 1.5 (10.0) |
| Holbein 5 Mbit/s | 10.0 (9.3) | 5.5 (5.4) | 4.7 (5.9) | **3.9 (5.9)** | 3.8 (6.6) | 4.1 (6.5) | 4.4 (5.8) |
| ESO 20 Mbit/s | 13.1 (40.6) | 10.1 (21.1) | 10.4 (22.4) | **7.4 (22.4)** | 8.2 (24.8) | 8.4 (24.0) | 7.9 (22.5) |
| ESO 5 Mbit/s | 17.4 (14.0) | 15.7 (9.6) | 16.9 (10.3) | **14.1 (9.7)** | 17.0 (10.9) | 16.8 (10.7) | 14.5 (9.7) |

Mean on-screen PSNR while moving: Holbein 20 Mbit/s C 47.5 → F 53.5 dB (A 51.4, holding
184 MB); ESO 20 Mbit/s C 30.6 → F 37.6 dB. Received-but-never-drawn tiles: 176 → 39
(Holbein), 171 → 44 (ESO). Holds that never completed on ESO 5 Mbit/s: C 3, E 4, **F 0**, I 1.

- **Prediction is the fix.** It sends tiles for where the view will be when they arrive,
  not where it was when requested: 20-48% less blurry time for +2-6% bytes, and far fewer
  wasted tiles. Mid-zoom, the centre of the screen is already exact (fig_midzoom).
- **Velocity extrapolation (I) gets most of it** without a known target, at the price of
  overshoot at the end of a gesture (~10% more bytes on Holbein, 130 vs 39 wasted tiles).
- **Coarse-first does not pay** once the overview level is pinned: small gain on a fast
  link, a loss on a slow one (covers take bandwidth the real tiles needed), and it makes G/H
  worse than F/I alone.
- Prediction does not help the worst frame (the first frames of a gesture, before the first
  update reaches the server) and cannot beat bandwidth: ESO at 5 Mbit/s is still blurry for
  most of every gesture — a screenful of star-field tiles is 0.8 MB.

### Splat video (2026-09-18): real renders, like-for-like

**S** = F (compressed cache + prediction) with zoom levels >= 3 sent and cached as splats
(4000 per tile, 11 B each; JPEG only at levels 0-2). Holbein, 40 s session with six dives,
5 Mbit/s. Every splat tile drawn in the session (180) was actually fitted (1000 iterations;
patch 33, which matches patch 49 within 0.2 dB at 2.3x the speed), so these numbers are
measured on real renders, not estimated. Video: `out/video_holbein_splats.mp4`.

| | F JPEG tiles | S splats |
|---|---|---|
| peak memory | 49.9 MB | **27.5 MB** |
| end memory | 15.7 MB | 17.5 MB |
| downloaded | **9.5 MB** | 11.3 MB (+19%) |
| seconds < 35 dB (of 40) | **6.4** | 10.1 |
| mean PSNR moving / still | **47.1 / 58.9** | 39.6 / 51.3 |
| worst frame | 22.8 dB | **25.1 dB** |

- Splats' real advantage is **peak memory**: no decoded bitmaps for the upper levels, so a
  fast zoom does not spike the way F's on-screen bitmaps do (both stay under budget).
- Everything else favours JPEG: softer picture everywhere above level 3 (the full view is
  39 dB instead of exact), visible **seams at tile borders** (each tile's splats are fitted
  independently), 19% more bytes, and ingest cost ~4.6 h for this image vs 32 s: its 697
  tiles at levels 3+ at 24 s each (levels 0-2 stay JPEG). ESO: 5,438 such tiles, ~36 h.
  (An earlier "~17 h" counted every level as splats; that is the cost only if levels 0-2
  were splats too — 16.7 h Holbein, 5.7 days ESO.)
- The per-level estimate used for D earlier was pessimistic (face tiles only); across the
  real session the fitted tiles average 35.6 dB because smooth areas fit at 40-46 dB.

Same comparison on the ESO gigapixel, 20 Mbit/s, 527 tiles fitted at 300 iterations (star
fields gain only ~0.2-0.7 dB from more), mean 19.6 dB per tile; video
`out/video_eso_splats.mp4`:

| | F JPEG tiles | S splats |
|---|---|---|
| peak / end memory | 50.0 / 41.3 MB | 49.9 / 44.8 MB |
| downloaded | **37.2 MB** | 38.6 MB |
| seconds < 35 dB (of 40) | **13.2** | 24.3 |
| mean PSNR moving / still | **36.8 / 59.2** | 29.9 / 47.2 |
| full view | exact | 26 dB (stars smeared) |

On the star field even the memory advantage disappears: the session spends most of its time
at the deep JPEG levels, whose 35 KB tiles fill the budget for both.

### Loss tolerance (2026-09-19): splats are NOT loss-tolerant — prediction wrong

I claimed a splat tile degrades gracefully under packet loss (4000 independent records,
order-free), and that this would justify partial reliability for splat data in the protocol.
**Measured, it is false.** `tools/splat_loss.py`, 3 Holbein tiles, 4000 splats (43 KB) vs the
same tile as JPEG (14 KB), dropping whole 1400-byte packets (127 records each), figure
`out/fig_splat_loss.png`:

| bytes lost | splats, interleaved | splats, not interleaved | splats, cut short (best first) | normalised splats | JPEG cut short |
|---|---|---|---|---|---|
| 0% | 33.07 | 33.07 | 33.07 | **35.31** | exact |
| 5% | 25.07 | 22.40 | **31.46** | 27.53 | 27.27 |
| 10% | 23.15 | 20.52 | 29.36 | 25.86 | 22.80 |
| 20% | 19.94 | 16.51 | 25.56 | 22.82 | 19.40 |
| 40% | 15.35 | 13.52 | 19.89 | 19.08 | 16.05 |

- **5% packet loss costs 8 dB.** Rendering is additive, so every missing blob is a hole of
  missing light: speckles when records are interleaved across packets, black patches when
  they are not (interleaving is worth ~3 dB and is still not enough).
- **Cutting the stream short, best blobs first, is the gentle case** (−1.6 dB at 5%,
  −7.5 dB at 20%) — cancellation mid-tile is survivable, random loss is not.
- **Weight-normalised rendering** (divide by accumulated weight instead of adding) gives
  **+2.2 dB at the same bytes with nothing lost** — a free quality win for the splat method —
  and ~+3 dB under loss, but the artefacts become bright streaks instead of holes. Still not
  loss-tolerant.
- **JPEG loses a similar number of dB but in a usable shape**: the bytes that arrived decode
  exactly and the missing part is one clean band, which the viewer fills from the coarser
  level. Splat damage is spread over the whole tile and cannot be hidden.

**Consequences for the protocol:** splat records need the same full reliability as JPEG
tiles — Selective Repeat + SACK, no per-packet partial reliability. Partial reliability
belongs at tile granularity instead (do not retransmit a tile the viewport no longer needs,
which is the cancellation the session simulator already models). If "any prefix is usable"
is wanted, the way to get it is progressive JPEG, not splats.

Caveats: A models the behaviour observed on EarthCam (every level requested, nothing
cancelled or evicted) — not its code. A is served FIFO, which is kinder to it than HTTP/2
bandwidth sharing would be. Viewport is 1280x720 CSS px; on a DPR-2 screen every decoded
figure is 4x. PSNR is harsh on star fields (a sub-pixel shift of a star costs a lot of dB).

---

## CORRECTION (2026-09-17): the splat rejection was measuring a bad fitter

Everything below about splats was produced by `tools/SplatFit.java`, which uses **greedy
matching pursuit** — place a splat against the residual, freeze it, repeat. Replacing it
with **joint optimisation** (all parameters by gradient descent, `tools/splat_fit_torch.py`,
PyTorch/MPS) changes the result completely, at identical splat counts and identical bytes:

| Crop (256x256, 4000 splats, 43.0 KB, 11-byte record) | Greedy | **Joint** | Gain |
|---|---|---|---|
| Hat weave (hard texture) | 24.69 dB | **35.75 dB** | +11.1 |
| Face (mid frequency) | 27.95 dB | **35.46 dB** | +7.5 |
| Bokeh (smooth) | 32.88 dB | **40.59 dB** | +7.7 |
| Hat weave, 8000 splats (86 KB) | — | **39.43 dB** | — |

So "splats saturate at 26.26 dB" was a property of greedy pursuit, not of splats.

**A second bug was worth more than every tuning knob.** The wire format clamped splat
centres to the tile, but joint optimisation legitimately parks ~3-5% of centres *outside*
it (range measured: x ∈ [−7.1, 258.6]) with only their tails visible. Clamping relocated
them and cost **8.5 dB**. Extending the encoded position range to ±64 px recovered it:
quantisation now costs 0.27–0.66 dB instead of 8.65. Per-field ablation, hat crop:

| field quantised | dB lost |
|---|---|
| position (clamped) | **8.54** |
| position (extended range) | **0.00** |
| sigma (8 bit) | 0.24 |
| amplitude (8 bit) | 0.42 |
| theta, colour (8 bit) | 0.01 each |

Colour precision is irrelevant here — a sweep from 8 to 16 bits moved nothing.

**Still behind JPEG, but by 3x rather than 10x.** At equal quality on the hat crop, JPEG
q74 needs **13.7 KB for 35.77 dB** where splats need 43.0 KB (**3.13x**, `tools/fig_splats.py`,
figure `out/fig4_splats.png`); bokeh is ~3.7x. At equal bytes JPEG q98 reaches 45.91 dB.

**Entropy coding measured — far smaller than I claimed.** I predicted 2–3x from Morton-sorted
delta coding. Measured on the hat crop:

| parameter coding | bytes | per splat | vs raw |
|---|---|---|---|
| raw 11-byte records | 44,000 | 11.00 | 1.00x |
| deflate, interleaved | 41,652 | 10.41 | 1.06x |
| Morton sort + delta + deflate | 38,340 | 9.59 | **1.15x** |

After joint optimisation the parameters are close to uniformly distributed across their
ranges, and with 4000 splats densely filling a tile the Morton deltas are still ~10 bits.
Deflate finds almost nothing. The 2–3x in the literature comes from *quantisation-aware
training* and vector quantisation plus context-modelled arithmetic coding, not from generic
compression of a raw record. Best measured result: **37.4 KB, 2.73x JPEG at equal quality.**

**Densification measured — also far smaller than I predicted.** I called it the
largest expected payoff. After fixing it so it actually fires (rank by amplitude x footprint
area, move the weakest 5% every 250 steps onto the highest-error pixels, seeded with the
residual, Adam state reset), hat crop, 11-byte record, figure `out/fig5_densify.png`:

| splats | bytes | no densify | densified | gain |
|---|---|---|---|---|
| 2000 | 21.5 KB | 31.61 dB | 31.97 dB | +0.36 |
| 3000 | 32.2 KB | — | 34.23 dB | — |
| 4000 | 43.0 KB | 35.75 dB | 35.85 dB | +0.10 |

So ~4000 splats are still needed for ~35.8 dB; the curve is roughly +3.9 dB per doubling
of splat count. Why it barely helps here: in 2D with free positions, Adam already migrates
splats to where the error is (position learning rate 0.35 px/step), and initialisation is
already gradient-weighted. 3DGS densification matters because 3D scenes start from sparse
point clouds that splats cannot travel far from — that problem does not exist in this setup.

Remaining levers, re-ranked by what the evidence now suggests: fewer bits per splat via
quantisation-aware training, vector-quantised shape/colour codebooks, and a richer
primitive (per-splat colour gradient) that buys more dB per splat.

**Per-splat colour gradient measured — loses at equal bytes.** Colour becomes
c + g_u·(u/σx) + g_v·(v/σy) in the splat's rotated frame, 3 bytes per axis. Hat crop,
densify on, figure `out/fig6_gradient.png`:

| mode | splats | raw bytes | coded | quantised PSNR |
|---|---|---|---|---|
| flat | 4000 | 43.0 KB | 36.9 KB | **35.92 dB** |
| ramp on u | 3143 | 43.0 KB | 37.5 KB | 34.94 dB |
| ramp on u+v | 2588 | 43.0 KB | 38.1 KB | 34.17 dB |
| ramp on u+v | 4000 | 66.4 KB | 56.8 KB | 36.67 dB |

It does make each splat better (+0.75 dB at 4000), but for 55% more bytes per splat. Spent
on plain splats instead, the rate curve (~+3.9 dB per doubling) predicts about +2.5 dB for
that same 55% — roughly three times what the ramp buys. **Flat splats remain the better
use of bytes.**

**Another encoder bug, same class as the position clamp.** Angles were folded into [0, π)
because a Gaussian is symmetric under a half-turn — but a colour ramp is not: a half-turn
maps (u, v) → (−u, −v) and inverts it. Before negating the gradient on odd folds, the
ramped splats lost **16–20 dB** to quantisation; after, 0.5–1.0 dB. Lesson for the wire
format: every symmetry the encoder exploits must hold for *every* field, not just the
envelope.

Three predicted wins in a row came in far below expectation — entropy coding (1.15x, not
2–3x), densification (+0.1–0.4 dB), colour gradient (loses at equal bytes). The part that
genuinely moved the result was replacing the greedy fitter, plus fixing two encoder bugs.

**Hybrid re-measured on the corrected fitter (2026-09-17): still loses, but by 2–4x, not
18–28x.** Old magnitude was inflated by the greedy base; the conclusion survives.

*Lossy, matched at 40 dB, hat crop* (`out/fig7_hybrid.png`):

| method | total | residual |
|---|---|---|
| splat base (4000) + JPEG residual | 55.2 KB | 1.53 bpp |
| free predictor + JPEG residual | **13.2 KB** | 1.65 bpp |
| plain JPEG | 22.6 KB | — |

The residual on top of splats is now cheap — but barely cheaper than the residual on top of
the *free* predictor (1.53 vs 1.65 bpp). The whole difference is the 43 KB base, which alone
costs more than plain JPEG does for the entire job. A 2000-splat base (22 KB) narrows it to
~2x at 38 dB but still loses; bokeh loses ~4x.

*Lossless, exact pixels verified bit-for-bit* (`tools/lossless_hybrid.py`):

| crop | plain PNG | free pred + resid | splats + resid (total) | resid alone |
|---|---|---|---|---|
| hat (4000) | 107.6 KB | 100.0 KB (1.08x) | 138.2 KB (0.78x) | 95.2 KB (1.13x) |
| hat (2000) | 107.6 KB | 100.0 KB | 125.5 KB (0.86x) | 104.0 KB (1.03x) |
| face (4000) | 110.4 KB | 98.1 KB (1.13x) | 141.6 KB (0.78x) | 98.7 KB (1.12x) |
| bokeh (4000) | 73.9 KB | 69.5 KB (1.06x) | 117.7 KB (0.63x) | 74.8 KB (0.99x) |

Splats halve the prediction error (mean |e| 6.27 → 3.03 on hat) yet the exact residual
shrinks only 5%. `out/fig8_residuals.png` shows why: splats remove the edge structure, but
edges were cheap to encode; the fine grain both residuals share (sensor noise plus the
source JPEG's own artefacts — `face1.jpg` is itself a JPEG) is what lossless coding pays for.
Even treating the splats as already paid for, they save 0–13% on the exact tile.

**Design consequence:** no residual layer. Splats for the zoomed-out / progressive view;
at the deepest zoom send plain tiles — lossless PNG if exact pixels are truly required,
otherwise JPEG q95+ (≥42 dB, visually indistinguishable) at roughly a quarter of the cost.

---

## The three numbers worth memorising

1. **Splats at equal bytes: 24.69 dB vs JPEG's 46.56 dB** (44.0 KB each, hat crop).
2. **Splats saturate at 26.26 dB** — 24k, 32k and 40k splats give an identical result.
3. **Zero-byte rule saves 37.3% of bytes** at a 38 dB threshold on a demanding photo
   (53.3% of regions — the byte figure is the honest one).

---

## Splats

**Record size: 11 bytes** (dx16 + dy16 + logSx8 + logSy8 + theta8 + r8 + g8 + b8 + logAmp8
= 88 bits). Earlier notes said 12 B — that was wrong and overstated splat cost by 9%.

4000 splats on a 256x256 cell = 44.0 KB = **0.67 bytes/pixel**. JPEG at comparable quality
is ~0.06 bytes/pixel.

### Equal bytes (the headline comparison)

| Crop | Splats | JPEG, same bytes |
|---|---|---|
| Hat weave | 44.0 KB → **24.69 dB** | 44.0 KB → **46.56 dB** |
| Face | 44.0 KB → **27.95 dB** | 44.0 KB → **46.61 dB** |

### Equal quality

Hat crop: splats need 44.0 KB for 24.69 dB. JPEG q30 costs **7.1 KB** and already delivers
**30.70 dB** — better quality at a sixth of the bytes. Interpolated to equal quality,
splats cost roughly **10x** more.

### Saturation (why more splats do not help)

| splats | quantized | unquantized (`--noquant`) |
|---|---|---|
| 4,000 | 24.69 dB | 25.16 dB |
| 8,000 | 25.69 | 25.76 |
| 16,000 | 26.25 | 26.00 |
| 24,000 / 32,000 / 40,000 | **26.262** (identical) | **26.001** (identical) |

Full-precision fitting is *worse*, so quantization was never the constraint.

### Fitting speed

2,700–4,900 splats/s per 256x256 cell. Ingest was never the blocker.

### JPEG baseline, hat crop 256x256

| quality | bytes | PSNR |
|---|---|---|
| q30 | 7.1 KB | 30.70 dB |
| q50 | 9.6 KB | 32.85 dB |
| q70 | 12.7 KB | 35.13 dB |
| q90 | 21.7 KB | 39.59 dB |

---

## Hybrid: splat base + pixel residual — rejected

Bytes to reach equal quality on 256x256 crops (`tools/HybridTest.java`):

| Crop | Hybrid (splats + residual) | Residual vs free predictor | Plain JPEG |
|---|---|---|---|
| Hat weave (~30.7 dB) | 49.2 KB | **2.8 KB** | 7.1 KB |
| Face (~30.3 dB) | 46.9 KB | **2.3 KB** | 6.9 KB |
| Bokeh (~34.6 dB) | 45.9 KB | **1.6 KB** | 3.3 KB |

The splat base costs 43 KB **and predicts worse** than the client's zero-cost upscale of
the coarse level: 24.69 vs 28.29 dB (hat), 27.95 vs 29.77 (face), 32.87 vs 37.44 (bokeh).

### Bits per pixel (256x256 cells = 65,536 px)

**Splat base alone: 5.37 bpp** — six times what a complete JPEG of the region costs.

Residual cost on top, at matched output quality:

| Crop | Residual on splats | Residual on free predictor | Complete JPEG |
|---|---|---|---|
| Hat weave (~30.7 dB) | **0.777 bpp** | **0.347 bpp** | 0.888 bpp |
| *(same, matched exactly to 30.7 dB — as printed on fig3)* | *0.786 bpp* | *0.333 bpp* | *0.887 bpp* |
| Face (~30.9 dB) | 0.583 bpp | 0.284 bpp | 0.86 bpp |
| Bokeh (~34.6 dB) | 0.365 bpp | 0.202 bpp | 0.43 bpp |

Two readings, both damning:

- The residual alone costs **~87% of a complete fresh encode** (hat), *after* 5.37 bpp of
  splats have already been spent.
- Predicting from splats makes the residual **~2x more expensive** than predicting from the
  free upscale, because splat error is structured high-frequency junk (blobs, speckle,
  edge ringing) — exactly what a DCT coder handles worst — while upscale error is smooth
  missing detail, which compresses well.

Calibration warning: "under 1 bpp is great" is the wrong yardstick. A *complete* JPEG of
these cells is 0.43-0.89 bpp. The benchmark for any residual is what sending the whole
region would have cost, not an abstract 1 bpp.

### At the high-quality end (where the system would actually run)

Sweeping to q0.99 — the interesting operating point, since we want maximum quality, not a
fixed dB target. Hat crop:

| | residual bpp | total | PSNR |
|---|---|---|---|
| Splats + residual | 4.639 | 80.1 KB | **41.25 dB** |
| Free predictor + residual | 3.470 | 27.8 KB | **44.98 dB** |
| Plain JPEG | — | 48.4 KB | **47.87 dB** |

**The hybrid has the lowest ceiling, not just the highest price.** Even at maximum quality
it tops out ~6.6 dB below plain JPEG while costing 1.7x more, because splat error is
high-frequency junk the residual coder cannot fully remove at any practical rate.

Max quality reached at q0.99, all three crops:

| Crop | Splats+resid | Free pred+resid | Plain JPEG |
|---|---|---|---|
| Hat weave | 41.25 dB | 44.98 dB | **47.87 dB** |
| Face | 42.27 dB | 45.29 dB | **49.42 dB** |
| Bokeh | 43.35 dB | 46.40 dB | **51.22 dB** |

### The lossless anchor — what "maximum quality" actually costs

Exact pixels, PNG-encoded, same 256x256 crops:

| Crop | Lossless | vs JPEG q0.99 |
|---|---|---|
| Hat weave | 154.6 KB = **18.88 bpp** | 48.4 KB = 6.05 bpp @ 47.87 dB |
| Face | 156.5 KB = **19.10 bpp** | 50.3 KB = 6.29 bpp @ 49.42 dB |
| Bokeh | 115.7 KB = **14.13 bpp** | 35.3 KB = 4.41 bpp @ 51.22 dB |

So true "send the exact pixels" costs ~3x what near-visually-lossless JPEG costs. The
practical operating point for the project is q0.95-0.98 — roughly **30-41 KB per 256x256
cell on the hardest content**, 42-46 dB — and far less on ordinary content.

Also note the free-predictor advantage *narrows* as quality rises — 2.5x cheaper than plain
JPEG at ~30 dB, but only ~1.4x at ~45 dB, because at high fidelity the residual has to
carry nearly everything anyway. Chaining then erodes that further (Experiment 3: ~1.2x).
Any efficiency claim must state the quality it was measured at.

---

## Gigapixel ingest and serving — `eso1242a.tif`, 25000×18832 (470.8 MP), 1.57 GB TIFF

**Without ingest** (decoding at request time): server pinned one core at 98.9% CPU, RSS
reached 2.2 GB and climbing, and no client ever received `CHART`. Unusable.

**Ingest** (`project2.Ingest`, strips via `setSourceRegion`):

| | |
|---|---|
| Total time | **844.9 s** (≈14 min, one-time) |
| Tiles | 20,375 across 22 ladder levels |
| Tile store | 679.8 MB — 43% of the 1.57 GB source |
| Level 0 alone | 7,252 tiles, 257.1 MB, 160 s |

Per-level time: levels 0–3 each took ~155–160 s; level 4 dropped to 56 s and it falls off
from there. **Levels 1–3 cost as much as level 0** because their ladder scales (1.25, 1.56,
1.95) give `floor(ls) = 1`, so no integer subsampling applies — each re-reads the whole
image at full resolution and then resizes. ~620 of the 845 s went to four full-resolution
passes over the source.

Obvious improvement, not yet done: build each level from the *previous level's tiles*
rather than re-reading the source. Would cut total time to roughly level-0 cost, at the price
of compounding resampling error over 21 steps (mitigation: rebuild from a pow2 checkpoint).

Ladder storage overhead, measured: total 679.8 MB / level 0 257.1 MB = **2.64x**, against the
theoretical 1/(1 − 1/1.25²) = 2.78x. Confirms the earlier storage estimate.

**Serving after ingest** (`TiledStore`, nothing decoded):

| | |
|---|---|
| Server RSS before opening | 98 MB |
| Server RSS after streaming tiles | **108 MB** |
| Opening view | 20 tiles, 456.4 KB, 22.8 KB/tile |

**Server memory is flat regardless of source size** — a 470 MP image adds ~10 MB.
Astronomical tiles average 22.8 KB versus ~7 KB for photographic ones: dense star fields
compress poorly.

---

## Screen-space delivery vs tiles (`tools/ViewportSim.java`)

Scripted browsing path (explore, then retrace exactly), 512x288 viewport, q0.85, 256px
tiles, 30 MB client tile cache. Every strip, frame and tile is really JPEG-encoded and its
length counted. Ratios > 1 favour screen-space.

**With pow2-aligned zoom factors ({4, 2, 1}) — the case that flatters pow2 tiles:**

| Image | Total | **Fresh territory** | **Revisited** |
|---|---|---|---|
| Mixed portrait | 1.02x (tie) | **1.87x** | tiles free |
| Dense text | 1.07x | **2.02x** | tiles free |
| Portrait, 20% halo | 0.88x | 1.62x | tiles free |

A path of {4, 2, 1} gives a power-of-two pyramid **zero** resolution waste by construction.
Real users pinch and scroll to arbitrary factors, so see the ladder results below, measured
on {5.5, 3.1, 1.7, 1.0}.

**The result is a wash overall, and which side wins is decided entirely by browsing
behaviour.** On ground the user has not seen before, screen-space costs about half what
tiles cost — exactly the predicted saving from zero alignment waste plus exact-scale
delivery (a pyramid at 1:3 ships 1:2 data, 2.25x the pixels the screen shows). On ground
the user returns to, tiles are free from cache and screen-space pays full price again.

**The halo does not pay.** Composing 20% beyond the viewport cost 40% more on fresh
territory and did not earn it back; it only helps for small jittery pans, which this path
does not contain.

Caveats, all favouring tiles slightly: the 30 MB cache never evicted at these image sizes,
so revisits were best-case free; on a real gigapixel image with heavy panning they would
not be. And the path generator pins into a corner at fine scales, producing 4-6 zero-byte
steps per run (flagged NO MOVEMENT) — they bias neither strategy but do under-sample.

## The scale ladder: the synthesis, and the current best option

Exactly-exact per-request scaling cannot be cached (no two requests share a key), so the
realistic version is a **finer geometric ladder**: tiles at scales r^k with r = 1.25 instead
of 2.0, capping area waste at r^2 = 1.56x instead of 4x while keeping cache keys stable.

Measured on realistic zoom factors {5.5, 3.1, 1.7, 1.0}, KB for the whole path:

| | screen-space | pow2 tiles | **ladder r=1.25** |
|---|---|---|---|
| Portrait — fresh | 139.9 | 407.9 | **259.8** |
| Portrait — revisited | 119.2 | **0.0** | **0.0** |
| Portrait — TOTAL | 259.1 | 407.9 | **259.8** |
| Dense text — TOTAL | **188.0** | 313.4 | 204.0 |

- **The ladder cuts pow2 tiles by 1.54-1.57x on fresh territory** — the resolution waste is
  real and it is the single biggest effect measured in this comparison.
- **The ladder ties screen-space on total bytes while keeping revisits free.** On any path
  with more backtracking than this one, the ladder pulls ahead; screen-space pays 119 KB
  for revisits where both tile strategies pay nothing.
- **Finer ladder is better:** r=1.25 beats r=1.5 by 1.27x (259.8 vs 330.8 KB), as the
  r^2 waste bound predicts.
- **Control, pow2-aligned zooms {4,2,1}:** the ladder *loses*, 289.1 vs 243.2 KB. Its whole
  benefit comes from users landing off the pow2 grid — which is what pinch and scroll zoom
  actually do, but it is an assumption the document must state.

Cost of the ladder: ~12 levels instead of 5, so roughly 2x the precomputed storage
(sum of r^-2k), or generate-on-demand with a server-side cache.

**Design implication:** ladder tiles get most of screen-space's advantage (little resolution
waste) while keeping the client cache and needing no per-client server composition — which
also removes screen-space's worst problem, that nothing is shareable between clients.

---

## Systematic sweep: 306 regions, 3 images, 5 zoom levels

`tools/RegionSweep.java`, 256x256 regions, splat budget fixed at 23.5 KB/region, reference
quality = plain JPEG q0.90, residuals quality-matched to it.

**Splats win 0 of 306 regions.** Cost vs plain JPEG: 3.0-9.1x (hybrid), 1.5-3.1x (residual
against the free predictor). Worst ratios are on **smooth** regions, not textured ones —
smooth content is so cheap directly (4-6 KB) that a fixed splat budget dwarfs it.

Hybrid cannot reach the reference quality at all in 42% (mixed) and 53% (flat) of regions.

**Quality-dependence of residual coding (important):** at a ~30 dB target, residual-against-
free-predictor beat plain JPEG 2.5-4x; at a q0.90 target it *loses* 1.5-3.1x. Residual
coding wins at low quality and loses at high quality. Since the project runs near-visually-
lossless, residual refinement was dropped from the design.

---

## Copy references (cache as dictionary) — rejected

Blocks with real texture (absolute contrast std >= 0.06), share finding a usable match:

| Source | >= 30 dB | >= 35 dB |
|---|---|---|
| **Control** (synthetic repeating pattern) | **99.6%** | 99.6% |
| Portrait | **0.6%** | **0.0%** |
| Screenshot (UI — best realistic case) | 22.6% | 19.7% |
| Dark landscape photo | 26.2% | 3.9% |

Smooth blocks matched 60–100% of the time, but those were cheap to code anyway.

---

## Residual refinement

### Single step, against a pristine coarse level (512x512 crops)

| Crop | Matched quality | Delta | Fresh | Saving |
|---|---|---|---|---|
| Hat weave | ~30.5 dB | 8.7 KB | 26.3 KB | 3.0x |
| Face | ~30.3 dB | 7.8 KB | 26.8 KB | 3.4x |
| Bokeh | ~39.3 dB | 4.7 KB | 20.7 KB | 4.4x |

**Predictor alone** (bilinear upscale of the coarse level, costs zero bytes):
hat **28.73 dB**, face **29.19 dB**, bokeh **39.44 dB**.
Note this beats a 44 KB splat base on every crop — which is why splats-as-base was dropped.

### Chained across 4 zoom levels (1024x1024 crop) — the honest case

| Setup | Cumulative | Deepest level | vs fresh |
|---|---|---|---|
| Hat, uniform q0.6 | 111 KB | 31.31 dB | fresh 204 KB @ 34.27 dB |
| Hat, q0.6 + qcoarse 0.95 | 171 KB | 32.10 dB | 1.19x, still 2.2 dB worse |
| Hat, uniform q0.8 | 172 KB | 33.98 dB | **~1.18x at matched quality** |

Accumulation penalty **1.0–3.1 dB per level**, and it does not shrink with depth.
Raising coarse-level quality cost 1.5x more for +0.8 dB — it does not fix it.

---

## Zero-byte rule (the surviving mechanism)

Portrait, 3072x4096, 128px regions, q0.6. Sending every region fresh costs **1639 KB**.

| Threshold | Regions skipped | **Bytes saved** |
|---|---|---|
| >= 36 dB | 68.5% | **53.5%** |
| >= 38 dB | 53.3% | **37.3%** (611 KB) |
| >= 40 dB (conservative) | 38.2% | **23.9%** |

Dark landscape photo at >= 38 dB: **98.8% of regions, 98.1% of bytes**.
Region size barely matters: 128px vs 256px gives 37.3% vs 36.8% at the 38 dB threshold.

Regions skipped always exceeds bytes saved, because skipped regions are smooth and smooth
regions were cheap to code in the first place.

---

## Estimates, NOT measurements

Quote these as design targets only:

- Browser budget ~46 MB (16 MB render target + 30 MB cache), first paint ~0.3 s,
  ~1.7 MB for a sharp 1080p view — all arithmetic from the splat design, never measured.
- Ingest 30–90 min for the full 9-gigapixel ESO image — extrapolated from cell timings.
- Splat file ~4.4 GB for the 24.6 GB source — extrapolated, never built.
- Joint gradient-descent optimization gaining "a few dB" — from the literature, untested.

## Figures

- `out/fig1_hat.png`, `out/fig1_face.png` — splats vs JPEG at equal bytes.
- `out/fig2_skipmap_38.png`, `_40.png`, `_landscape.png` — zero-byte rule drawn.
