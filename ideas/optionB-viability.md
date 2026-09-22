# Option B viability — measured 2026-09-16

Four experiments, run after splats (#7) were rejected. Tools: `tools/CopyScan.java`,
`tools/ResidualTest.java`, `tools/ChainTest.java`, `tools/ZeroByteScan.java`.
Test image: `face1.jpg` (3127x4691 portrait — real photographic content with genuine
texture: hat weave, skin, bokeh background), plus a dark landscape photo as a second case.

**Verdict: option B is viable, but not for the reason we expected.** Copy references are
dead, residual chaining is worth far less than the single-step test suggested, and the
efficiency story rests on the zero-byte rule, which measures well.

---

## Experiment 1 — copy references: **FAILED**

Question: when the server must send a region, does the client already hold something
similar enough to reference instead of resending pixels? (Idea #1, "client cache as
compression dictionary".)

| Crop | Blocks with real texture (std >= 0.06) | match >= 30 dB | match >= 35 dB |
|---|---|---|---|
| **Control** (synthetic repeating pattern) | 4095 | **99.6%** | 99.6% |
| Portrait, hat + background | 2223 | **0.6%** | **0.0%** |
| Dark landscape photo | 432 | 26.2% | 3.9% |
| Screenshot (UI, best realistic case) | 615 | 22.6% | 19.7% |

The control confirms the scanner detects genuine repetition. Real photographic texture does
not repeat closely enough to reference. Smooth blocks match 60-100% of the time, but JPEG
already codes those for almost nothing, so hits there are not savings.

**Trap avoided:** the landscape crop first reported 80% hits on "textured (top half by
variance)" blocks. Its median block contrast is 0.003 — the crop is nearly featureless, so
"top half of this image" was still flat. Only an **absolute** contrast threshold exposed it.
Same failure mode as the near-black splat crop earlier the same day.

## Experiment 2 — residual refinement, single step: promising

One zoom step, residual coded as biased JPEG against a **pristine** coarse level:

| Crop | Quality | DELTA | FRESH | Saving |
|---|---|---|---|---|
| Hat weave | ~30.5 dB | 8.7 KB | 26.3 KB | 3.0x |
| Face | ~30.3 dB | 7.8 KB | 26.8 KB | 3.4x |
| Blurred background | ~39.3 dB | 4.7 KB | 20.7 KB | 4.4x |

**But see experiment 3 — this number is optimistic**, because a real client predicts from
its own lossy reconstruction, never from pristine data.

## Experiment 3 — chained zoom levels: **the single-step win mostly evaporates**

4 chained levels, each predicting from the client's own reconstruction.
Penalty = (residual vs pristine predictor) − (residual vs client's real predictor).

| Setup | Cumulative bytes | Deepest-level PSNR | vs fresh |
|---|---|---|---|
| Hat, uniform q0.6 | 111 KB | 31.31 dB | fresh: 204 KB @ **34.27 dB** |
| Hat, q0.6 + qcoarse 0.95 | 171 KB | 32.10 dB | 1.19x cheaper, still 2.2 dB worse |
| Hat, uniform q0.8 | 172 KB | 33.98 dB | ~**1.18x** cheaper at matched quality |
| Face, q0.6 + qcoarse 0.95 | 155 KB | 32.05 dB | fresh: 183 KB @ 34.06 dB |
| Background, q0.6 + qcoarse 0.95 | 85 KB | 36.32 dB | fresh: 97 KB @ 37.99 dB |

- **Accumulation penalty is 1.0-3.1 dB per level and does not shrink with depth.**
- Coding the coarse levels at high quality (the obvious fix) **does not fix it**: +1.5x cost
  for +0.8 dB. The penalty is intrinsic — JPEG codes zero-mean high-frequency residuals
  poorly, and bilinear prediction is weak on texture. Level 3 (512^2) at q0.95 alone costs
  82 KB, so "coarse levels are cheap" stops being true above ~256^2.
- **At matched final quality, chaining is only ~1.2x cheaper than re-sending.**

Conclusion: chained residuals are not the efficiency story. Worse, the deepest level's
quality is capped by accumulated error — the same failure mode that killed splats (the user
never sees true pixels) unless the deepest level is sent fresh.

## Experiment 4 — the zero-byte rule: **this is the real win**

For each region, compare what the client's own upscale of the coarser level already
achieves against the truth. If it is already above a visibility threshold, send nothing.

**Portrait** (demanding: in-focus face, hat weave, plus bokeh). Median region predictor
PSNR 38.3 dB. Full cost to send every region fresh: 1639 KB.

| Threshold | Regions skipped | **Bytes saved** |
|---|---|---|
| >= 36 dB | 68.5% | **53.5%** |
| >= 38 dB | 53.3% | **37.3%** |
| >= 40 dB (conservative) | 38.2% | **23.9%** |

**Dark landscape photo** (mostly flat — closer to how much of a real gigapixel panorama
behaves): at >= 38 dB, **98.8% of regions and 98.1% of bytes** skipped.

Region size barely matters: 128px and 256px regions give 37.3% and 36.8% at the 38 dB
threshold, so scheduling granularity is a free choice.

Note the gap between regions skipped and bytes saved (53% vs 37%) — exactly as predicted,
because skippable regions are smooth and smooth regions were cheap anyway. The byte column
is the honest one.

**Figures** (`tools/SkipMap.java`): `out/fig2_skipmap_38.png`, `out/fig2_skipmap_40.png`,
`out/fig2_skipmap_landscape.png` — skipped regions tinted green over the photo. The
portrait figure reads at a glance: the bokeh background, the shirt and smooth skin go
green, while the eyes, the hat weave and the cigarette stay. The landscape figure is almost
entirely green except the LED display.

Two things the figures show that the tables do not:

- Skipped regions are **scattered, not contiguous**, so the scheduler should merge adjacent
  skips into larger rectangles rather than addressing each region separately.
- At 38 dB a few regions on the shoulder and shirt go green even though they carry visible
  fabric structure — PSNR is not tracking visibility there. Concrete evidence for why the
  threshold needs a JND/SSIM study rather than a PSNR guess.

**Honest caveats:** PSNR is a weak proxy for visibility; a proper JND/SSIM study would set
the threshold better and is a strong document section. And this test predicts from a
pristine coarse level, so real-world savings will be somewhat lower.

---

## Experiment 5 — hybrid "splat base + pixel residual": **FAILED, decisively**

Proposal tested: let splats carry the smooth structure and a pixel residual carry the
texture they cannot reproduce, deciding per region at ingest which representation wins.
Tool: `tools/HybridTest.java`, comparing three ways to deliver the same region:

- **HYBRID** — splat base (43 KB, already paid) + JPEG residual against it
- **DELTA** — JPEG residual against the client's **free** predictor (upscale of the coarse
  level it already holds; zero extra bytes)
- **FRESH** — plain JPEG, i.e. what a tile viewer sends

Bytes needed to reach the same quality, 256x256 crops:

| Crop | HYBRID | DELTA | FRESH | Hybrid vs best |
|---|---|---|---|---|
| Hat weave (~30.7 dB) | 49.2 KB | **2.8 KB** | 7.1 KB | **18x worse** |
| Face (~30.3 dB) | 46.9 KB | **2.3 KB** | 6.9 KB | **20x worse** |
| Bokeh (~34.6 dB) — splats' *best* case | 45.9 KB | **1.6 KB** | 3.3 KB | **28x worse** |

**Why it fails, in one line:** the splat base costs 43 KB and is a *worse* predictor than
the free one.

| Crop | Splat base (43 KB) | Free coarse upscale (0 KB) |
|---|---|---|
| Hat weave | 24.69 dB | **28.29 dB** |
| Face | 27.95 dB | **29.77 dB** |
| Bokeh | 32.87 dB | **37.44 dB** |

You pay 43 KB to start from a worse position, then pay again for the larger residual that
results.

**In bits per pixel** (the diagnostic that settles it): the splat base is **5.37 bpp**,
six times the cost of a complete JPEG of the same cell. The residual on top is then
**0.777 bpp** on the hat crop — about 87% of what a fresh encode costs — versus
**0.347 bpp** for a residual against the free predictor. So the splat base does not merely
fail to pay for itself; it makes the residual roughly **2x more expensive**, because splat
error is structured high-frequency junk (blobs, speckle, edge ringing) that DCT coders
handle worst, while upscale error is smooth missing detail that compresses well. The hybrid loses on every content type, including the smooth one chosen to
flatter it. No per-region crossover exists to find — splats never win a region.

Note the DELTA column beats FRESH by 2.5-4x here, but that is the **single-step, pristine
predictor** case again. Experiment 3 already showed this shrinks to ~1.2x once levels are
chained and the client predicts from its own lossy data. Do not quote the 2.5-4x figure.

---

## Experiment 6 — systematic per-region, per-zoom sweep: **0 wins out of 306 regions**

Tool: `tools/RegionSweep.java`. Three images (mixed portrait, dense-text exam page, flat
dark photo), 256x256 regions, zoom 1:1 through 1:8, splat budget fixed at 1 splat per 30 px
(23.5 KB/region) with **no per-region tuning**. Reference quality per region = what plain
JPEG q0.90 achieves there; the hybrid and delta residuals are quality-matched to it.
CSVs: `out/sweep_{mixed,hard,easy}.csv`.

| Image | Regions | Splats win | Hybrid **cannot reach** reference quality |
|---|---|---|---|
| Mixed portrait | 112 | **0** | 42.0% |
| Dense text (exam page) | 84 | **0** | 0% |
| Flat dark photo | 110 | **0** | 52.7% |

### Cost ratio vs plain JPEG, by texture class (lower is better; 1.0 = parity)

| Class | Splat-only dB | hybrid/direct | delta/direct | hybrid resid bpp |
|---|---|---|---|---|
| smooth | 44.2-44.3 | **5.3-9.1x** | 2.4-3.0x | 1.47-1.61 |
| medium | 31.8-40.5 | 4.3-6.2x | 2.3-2.7x | 1.53-1.99 |
| dense | 28.2-34.5 | 3.0-5.4x | 1.7-2.7x | 1.73-2.33 |

**The most counterintuitive result: splats lose *worst* on smooth regions** — the content
they were supposed to be best at. Splat quality there is genuinely high (44 dB), but smooth
regions are so cheap to code directly (4-6 KB) that a fixed 23.5 KB splat budget is
enormous by comparison. Splats look good on sky and still cost 9x what sky costs.

### The hypothesis, checked

Predicted: smooth 40+ dB with sub-1 bpp residual; dense 28-32 dB with 3-4 bpp.
- Smooth reaching 40+ dB: **confirmed** (44.2 dB).
- Dense sitting at 28-32 dB: **confirmed** (28.2-30.5 dB on the photographic images).
- Residual costs: **wrong in both directions.** Smooth residuals cost ~1.5 bpp, not sub-1
  (the reference quality on smooth content is very high, so the residual must carry a lot).
  Dense residuals cost ~1.9-2.3 bpp, not 3-4.

### Zoom sweep: there is no crossover

Ratio of hybrid to direct by zoom — mixed 5.30 / 3.41 / 3.23 / 2.28, hard 4.01 / 4.27 /
3.27 / 2.98, easy 4.54 / 7.12 / 7.57 / 4.91 (1:1, 1:2, 1:4, 1:8). The ratio drifts towards
parity as you zoom out but never crosses it. **Splats are never cheaper, at any zoom level,
in any texture class, on any of the three images.**

### The finding that revises our own earlier conclusion

The `delta/direct` column is **above 1.0 everywhere** (1.5-3.1x): at a q0.90 reference,
residual-against-the-free-predictor is *worse* than just sending the region fresh. Earlier
experiments (2 and 5) measured delta beating fresh by 2.5-4x — but those matched at ~30 dB.

The advantage is quality-dependent and it **reverses**: residual coding wins at low quality
and loses at high quality, because a zero-mean high-frequency residual is exactly what a DCT
coder handles worst, and at high fidelity the residual must carry nearly everything anyway.

Since the project should run near-visually-lossless, **the residual mechanism should be
dropped from the design entirely**, not merely demoted. That simplifies option B: plain
JPEG rectangles, with the zero-byte rule providing the efficiency.

---

## The design that survives measurement

**Payload:** server-chosen rectangles, coded **fresh as JPEG** at the level being viewed.
Reaches true pixel quality, decodes natively in the browser, no codec of ours to write.

**Efficiency mechanism:** the **zero-byte rule** — per region, skip what the client's own
upscale already shows adequately. 24-53% of bytes on a demanding photo, near-total on flat
content, with no quality loss at the chosen threshold.

**Dropped:** copy references (exp. 1); chained residual refinement as the core efficiency
claim (exp. 3). A *single* residual step may still be worth keeping as a progressive
preview mechanism, but not as the bandwidth story.

**Kept from the earlier design:** the control plane — prefix ledger, credits denominated so
flow control and the 50 MB cap are one mechanism, epochs cancelling stale work, and
server-chosen rectangles instead of a fixed tile grid.

### Positioning, stated plainly

The payload is now conventional (JPEG rectangles). We should not pretend otherwise. The
originality lives in the control plane and in the zero-byte policy — and unlike a
"clever-sounding" design, every element here has a measured number behind it, including
the two mechanisms we killed. That is a stronger document than an untested novel idea.

## Open questions

- Visibility threshold: needs a JND/SSIM study rather than a PSNR guess.
- How does the server compute the predictor's quality cheaply at serve time? Precompute a
  per-region "needs detail" flag at ingest — it is static per image.
- Rectangle scheduling as the viewport moves.
- Keep the single-step residual for progressive preview, or drop it for simplicity?
