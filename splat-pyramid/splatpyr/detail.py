"""
How much real detail an image's finest level holds, for how far the viewer lets you zoom in.

An image's pixel count is not its resolution: a scan can be softer than its pixels, a photo
can have been enlarged before it reached us, and text drawn one pixel wide uses every pixel.
So the finest level's tiles are shrunk by 2, 4 and 8 and enlarged back, and compared with the
originals. If a tile comes back nearly the same (PSNR at least DETAIL_PSNR), the level that
much coarser already held its detail.

The detail scale is where the median PSNR of a sample of tiles (blank ones skipped) crosses
DETAIL_PSNR, interpolated between the factors measured on a log scale: how many image pixels
make one unit of real detail. 1 when every pixel matters, about 4 when the real detail is 4
pixels across. Whole levels would be too coarse: a 0.3 dB difference moved the Holbein from
one to the next. It goes into pyramid.json, the server passes it on in CHART, and the viewer
stops zooming when one unit of real detail covers MAX_MAGNIFY screen pixels
(viewer/src/viewer.ts), instead of one image pixel.

Measured (64 tiles): bigbig.png, digits drawn 1 px wide, 9.5 dB already at 2x: scale 1. The
Holbein scan, 32.0 dB at 2x and 29.7 dB at 4x: scale 3.6. bills.jpg, 42.8 dB at 2x, 34.9 at
4x, 27.2 at 8x: scale 6.2.
"""

import json
import os
import random

import numpy as np
from PIL import Image

DETAIL_PSNR = 30.0       # dB: a tile this close after shrinking held no detail beyond it
SAMPLE = 64              # tiles of the finest level to measure
FLAT = 8.0               # tiles with less spread than this are background, not measured
FACTORS = (2, 4, 8)      # shrinking by more than 8x is not tried


def _psnr(a, b):
    mse = np.mean((a.astype(np.float64) - b.astype(np.float64)) ** 2)
    return 99.0 if mse == 0 else 10 * np.log10(255.0 ** 2 / mse)


def measure(root, log=print):
    """Measure root's detail scale, store it in root/pyramid.json and return it."""
    with open(os.path.join(root, "pyramid.json")) as f:
        meta = json.load(f)
    tile = meta["tile"]
    level0 = os.path.join(root, "tiles", "0")
    names = sorted(os.listdir(level0)) if os.path.isdir(level0) else []
    random.Random(1).shuffle(names)
    # what the finest tiles were kept as: lossless WebP is text and line art (drawn as exact
    # pixels when magnified), JPEG is a photograph (smoothed, and zoomed less far)
    kinds = [n.rsplit(".", 1)[-1] for n in names[:1000]]
    lossless = round(kinds.count("webp") / len(kinds), 3) if kinds else None
    scores = {k: [] for k in FACTORS}
    used = 0
    for name in names:
        if used >= SAMPLE:
            break
        with Image.open(os.path.join(level0, name)) as im:
            im = im.convert("RGB")
            if im.size != (tile, tile):
                continue                      # edge tiles: partial, skip
            a = np.asarray(im)
            if a.std() < FLAT:
                continue
            for k in scores:
                small = im.resize((tile // k, tile // k), Image.LANCZOS)
                scores[k].append(_psnr(a, np.asarray(small.resize((tile, tile), Image.BICUBIC))))
        used += 1
    medians = {k: float(np.median(v)) for k, v in scores.items() if v}
    scale = 1.0
    if medians:
        # walk up the factors while the tiles still come back close; between the last that does
        # and the first that does not, interpolate where DETAIL_PSNR is crossed (log2 scale)
        last_k, last_p = 1, None
        for k in FACTORS:
            p = medians[k]
            if p >= DETAIL_PSNR:
                last_k, last_p = k, p
                scale = float(k)
                continue
            if last_p is not None:
                frac = (last_p - DETAIL_PSNR) / (last_p - p)
                scale = 2 ** (np.log2(last_k) + frac * (np.log2(k) - np.log2(last_k)))
            break
    meta["detail_scale"] = round(scale, 2)
    meta["lossless_share"] = lossless
    meta["detail_psnr"] = {str(k): round(v, 1) for k, v in medians.items()}
    meta.pop("detail_level", None)
    with open(os.path.join(root, "pyramid.json"), "w") as f:
        json.dump(meta, f, indent=2)
    shown = ", ".join(f"{k}x {v:.1f} dB" for k, v in medians.items())
    log(f"detail: scale {scale:.2f} image px per unit of real detail ({used} tiles; shrunk and "
        f"enlarged back: {shown or 'nothing to measure'}); lossless tiles: "
        f"{'?' if lossless is None else f'{lossless:.0%}'}")
    return scale
