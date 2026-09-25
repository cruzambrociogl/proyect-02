# splat-pyramid

Gigapixel images as a pyramid of Gaussian splats for the coarse levels and plain JPEG tiles
for the fine ones, viewed in WebGL.
Standalone: it depends on nothing else in this repository, so the folder can be copied out
as is.

```
brew install vips                          # optional: streaming ingest for images of any size
pip install -r requirements.txt            # numpy, scipy, Pillow; torch, pyvips optional

python -m splatpyr ingest photo.jpg out/   # PNG levels to fit, JPEG tiles for the rest
python -m splatpyr build out/              # splats for the coarse levels, JPEG tiles below
python -m splatpyr serve out/              # http://127.0.0.1:8080/
```

## How it works

**Ingest.** The split is decided at ingest. Levels from the split up are written as lossless
PNG, because they get fitted. Levels below it go straight to the JPEG tiles the viewer
draws, with no PNG. With pyvips installed, the image is streamed through libvips and only a
strip of it is ever in memory. `dzsave` cuts every JPEG level in one pass, and a second pass
shrinks the image straight to the split level, which is small, for the PNG levels. Without
pyvips, Pillow holds a level in memory (about 5 bytes per pixel). Both produce the same tiles
(splat levels within rounding, 52+ dB apart).

**Tile format, per tile.** Each tile below the split is encoded both as JPEG (q85) and as
lossless WebP, and the WebP is kept when it is at most 1.5x the JPEG's size. Text, digits,
line art and flat graphics come out pixel-exact and usually smaller than JPEG (5x smaller on
the digit test pattern). Photographic tiles, where lossless costs about 4x more, stay JPEG.
`--tile-format jpg` skips the WebP pass for photos; it is the slow part of ingest. Past 1:1
the viewer shows the image's own pixels instead of smoothing between them (the *exact pixels*
checkbox).

**Splats on top, JPEG tiles below.** Fitting cost grows with the pixel count, and each level
has 4x the units of the one above, so the finest two levels are about 94% of all fitting.
Levels from `split` up are splats, and levels below it are ordinary JPEG tiles, resized and
encoded but never fitted. By default `split` is chosen so that at most 300 units are fitted
(`--splat-units`), which caps fitting time at roughly 10-15 minutes on an Apple GPU,
whatever the image size. Splats cover the overview and the zoom in between. Near 1:1 the
viewer draws JPEG tiles on top, with the splats underneath as the placeholder while tiles
load.

**Pyramid.** Level 0 is the full image; each level above halves it with a 2x2 box average,
up to the first level that fits in one 256 px tile. Power-of-2 levels only: splats scale
continuously, so the viewer draws any zoom from the nearest level and no in-between rungs
are fitted.

**Each level only adds detail.** The top level is the *base*: its blobs are fitted to the
pixels and drawn *normalised* (each pixel is the weighted average of the blobs over it, so
nothing overshoots). Every level below is fitted to the *residual* (its pixels minus what all
coarser levels already draw) and drawn *additively* as a signed correction. A unit whose
residual is already under the target gets zero blobs and costs a 14-byte header.

**Fitting one unit** (`splatpyr/fit.py`), no training loop:

1. *points*: isolated bright or dark pixels (stars, glints) get a tiny blob each
2. *layout*: a quadtree over the goal, split where the one-blob error is largest; each blob
   sits in its square, stretched along the local edge (structure tensor)
3. *colours*: with shapes fixed the image is linear in the colours, so the colours come from
   one sparse least-squares solve
4. *budget*: if the unit misses the target PSNR, the threshold drops and it is laid out again
5. *holes* (base only): pixels no blob reaches get a blob of their own
6. *polish* (optional, torch): a few hundred Adam steps over position, size, rotation and
   colour, starting from the formula's answer (`splatpyr/polish.py`)
7. *quantise*: shapes are rounded to what the file carries, colours solved again for exactly
   those shapes, then rounded; the reported PSNR is of the decoded blobs

**Seams.** A unit is fitted on a crop padded with 8 px of its neighbours (weighted less),
blobs sit inside the unit, and every unit is drawn clipped to its own rectangle, so each
pixel belongs to one unit per level.

**File format** (`splatpyr/codec.py`): 11 bytes per blob before compression. Blobs are sorted
by importance and cut into chunks at 1/8, 1/4, 1/2 and all, so **any prefix of chunks is a
valid, coarser unit**: a transport can send chunk 1 first and drop the tail under congestion.
Inside a chunk, blobs are Morton-ordered and stored as byte planes, then deflated.

**Viewer** (`viewer/`): WebGL 2. The base is accumulated into one half-float target and the
detail levels into another; a final pass divides and adds. A unit is drawn only if its parent
was, so every pixel sees a complete chain of levels, and the image sharpens as finer units
arrive. The cache holds blobs rather than decoded textures: 32 bytes per blob on the GPU,
capped at 3M blobs (about 92 MB). The *chunks drawn* slider shows what a truncated transfer
looks like. Below the split, JPEG tiles are drawn over the splats (finest loaded tile wins),
with their own texture budget of 96 MB. `#x=4000&y=2700&z=1` in the URL opens on a spot
(centre in image pixels, z in screen pixels per image pixel).

**On demand** (`splatpyr/serve.py`): a unit asked for before it exists is fitted on the spot,
together with any coarser unit it rests on. Only what someone looks at is ever fitted.

## Commands

| command | what it does |
|---|---|
| `ingest IMAGE OUT [--tile 256] [--split S] [--splat-units N] [--tile-format auto\|jpg\|webp] [--engine vips\|pil]` | PNG levels `max..S` in `OUT/pixels` (what gets fitted), JPEG tiles `S-1..0` in `OUT/tiles`, `OUT/pyramid.json` |
| `build OUT [--split S] [--finest L] [--workers N]` | fit splats for levels `max..S` (default: the split chosen at ingest) |
| `serve OUT [--port 8080] [--no-lazy]` | viewer + units, fitting on demand |
| `bench-unit OUT L X Y [--targets 28,32,36]` | one unit at several targets: blobs, KB, seconds, PSNR, against JPEG |
| `bench-hierarchy OUT L X Y [--psnr 32]` | go/no-go: bytes to reach the PSNR as residual vs from scratch |
| `check OUT L [--sample N] [--png F]` | what the viewer shows at level L vs the pixels; border vs interior error |

`--psnr`, `--max-blobs`, `--polish`, `--margin` on `ingest` or `build` are saved to
`OUT/fit.json` and used by every later fit, including the server's.

## Measured so far

bills.jpg, 8256 x 5504 (45 MP), default settings: split = 1, so levels 6..1 are 265 splat
units and level 0 is 726 JPEG tiles.

| step | time |
|---|---|
| ingest | 2 s |
| splats, levels 6..2 (78 units) | 3 min |
| splats, level 1 (187 units) | 8.4 min |
| JPEG tiles, level 0 (726 tiles, 4.6 MB) | 0.4 s |
| viewer at level 1 (mid zoom) | 52 units, 1.6 MB transferred, 5.2 MB of blobs on the GPU |
| viewer at 1:1 | 16 JPEG tiles, 5.3 MB of textures |

`--splat-units 100` would put the split at 2 and skip the 8.4 minutes of level 1.

A unit that still misses its target after polish is laid out again without the polish credit
(before this fix, units the formula left nearly empty finished below target and looked blurry
at full zoom). Stopping polish early, once a unit reaches its target, was tried and reverted:
it saved about a quarter of the fitting time but cost up to 6 dB on the coarse levels (the
top level fell from 41.4 to 35.2 dB), which shows in the whole-image view.

For a 33-gigapixel image the default budget still fits about 300 units, and the rest are
JPEG tiles.

Ingest, eso1242a.tif (25000 x 18832, 470 MP): Pillow 48 s and 2.4 GB of RAM, with 1.9 GB of
PNG written. libvips 9.9 s and 0.58 GB of RAM, with 28 MB of PNG (only the splat levels)
and 352 MB of JPEG tiles.

017-110-000-24650032.png (75471 x 75471, 5.7 gigapixels, 17 GB PNG), libvips:

| step | time / size |
|---|---|
| ingest | 50 s, 1.0 GB peak RAM |
| split chosen | 5: splats for levels 9..5 (139 units), JPEG for 4..0 (116,135 tiles) |
| fitting | 42 s (a test pattern of tiny digits: flat grey at coarse scale, so 81% of units empty) |
| disk | 18 MB PNG, 5.0 GB JPEG tiles, 0.5 MB splats |
| viewer at 1:1 | 20 tiles, 6.7 MB of GPU textures, 0.93 MB transferred |

With per-tile format (the default), ingest of the same image takes 204 s instead of 50 s
(the lossless WebP pass), and the tiles drop from 5.0 GB to 2.1 GB: every level-0 tile is kept
as lossless WebP and matches the source pixel for pixel. Levels 2-4, where the digits blur
together, stay JPEG. On bills.jpg every tile stays JPEG. With `--tile-format jpg`, ingest runs
at about 110 megapixels per second. Fitting is capped by the unit budget (10-30
minutes on an Apple GPU for detailed content, much less for flat content), and JPEG tiles
take roughly 1 GB of disk per gigapixel for dense content like this.

Earlier measurements, portrait 3127 x 4691, all levels as splats:

Portrait, 3127 x 4691, levels 0..5, target 32 dB, Apple GPU (MPS) for the polish step.

| | result |
|---|---|
| fit time per unit | formula only: 0.1-2 s on CPU. With 300 polish steps: 3-15 s |
| formula vs polish | base unit: formula 24.6 dB, polished 34.2 dB with the same 1321 blobs |
| build to level 2 | 29 units in 48 s; level 2 shows 32.5 dB, 7 of its 20 units empty |
| seams (level 2) | border 31.3 dB vs interior 32.6 dB |
| against JPEG | level-2 unit at 33.1 dB: 55.7 KB of splats vs 19.4 KB of JPEG (about 2.9x) |
| on-demand fit | a level-0 unit whose level-1 parents were missing: 94 s (GPU shared with a benchmark) |
| residual hierarchy | see below |

**Residual hierarchy go/no-go** (`bench-hierarchy`, bytes to reach 32 dB, interpolated from a
sweep of six targets per arm):

| unit | residual | from scratch | ratio | verdict |
|---|---|---|---|---|
| 3/0_1 | 16.6 KB | 12.9 KB | 1.29 | NO-GO |
| 2/1_2 | 48.0 KB | 49.8 KB | 0.96 | NO-GO |
| 1/2_4 | 51.6 KB | 57.3 KB | 0.90 | NO-GO |

Fitting the residual does not save the hoped-for 30% of bytes: it is about even at the finer
levels and worse on the one coarse unit. What the hierarchy does still give is units that
cost nothing (7 of 20 at level 2) and a viewer that sharpens in place instead of swapping
tiles. Several sweeps hit the 6000-blob cap near 57 KB, which squeezes both arms together at
the top. The fallback, if the hierarchy goes, is independent normalised levels (every unit
fitted from scratch, `base=True`) with the viewer drawing only the finest loaded level.

## Known limits

- Splats cost several times JPEG's bytes for textured content at the same PSNR. The polish
  step closes much of the gap to the formula; nothing here closes the gap to JPEG.
- The PSNR a polished unit lands on varies around the target (the formula aims
  `polish_credit` dB low and polish adds a varying amount).
- Without pyvips, ingest holds a level in memory through Pillow: fine up to a gigapixel or
  two. Install libvips for anything bigger.
- Lowering `--split` at build time below the split used at ingest fits those levels against
  their JPEG tiles (no PNG exists for them). Re-ingest with the lower `--split` for lossless.
- The first view of a fine area waits for its fit. The viewer shows the coarser levels
  meanwhile, but a cold level-0 unit can take tens of seconds.
