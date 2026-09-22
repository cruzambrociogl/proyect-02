#!/usr/bin/env python3
"""
Does a splat base make *exact* delivery cheaper?

At the deepest zoom the brief wants the true pixels. Three ways to get them exactly:

  PLAIN     lossless PNG of the region
  FREE      the client's upscale of the coarse level it already holds, plus a lossless
            residual (the base costs nothing extra - it was sent while zoomed out)
  SPLATS    the splat render, plus a lossless residual (the splats are charged here)

The residual is stored as (target - prediction + 128) mod 256. That is exact for every
value, and unlike a plain mod 256 it keeps small errors clustered around 128 rather than
splitting negatives to the top of the range, which is what a PNG row filter compresses well.
Every reconstruction is checked bit-for-bit, so "lossless" here is verified, not assumed.

  python3 tools/lossless_hybrid.py --orig IMG --x 1450 --y 600 --size 256 \
      --base out/grad_none_4000.png --basebytes 44000 --label hat
"""

import argparse
import io
import zlib

import numpy as np
from PIL import Image


def png_bytes(arr):
    buf = io.BytesIO()
    Image.fromarray(arr).save(buf, format="PNG", optimize=True)
    return len(buf.getvalue())


def residual_cost(target, pred):
    """Bytes for an exact residual, checked by reconstructing the target."""
    t = target.astype(np.int16)
    p = pred.astype(np.int16)
    r = ((t - p + 128) % 256).astype(np.uint8)
    back = ((p + r.astype(np.int16) - 128) % 256).astype(np.uint8)
    assert np.array_equal(back, target), "residual is not lossless"
    return min(png_bytes(r), len(zlib.compress(r.tobytes(), 9))), float(np.abs(t - p).mean())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--orig", required=True)
    ap.add_argument("--x", type=int, default=0)
    ap.add_argument("--y", type=int, default=0)
    ap.add_argument("--size", type=int, default=256)
    ap.add_argument("--base", required=True, help="splat render (already quantised)")
    ap.add_argument("--basebytes", type=int, required=True)
    ap.add_argument("--label", default="")
    args = ap.parse_args()

    crop = Image.open(args.orig).convert("RGB").crop(
        (args.x, args.y, args.x + args.size, args.y + args.size))
    target = np.asarray(crop, dtype=np.uint8)
    splats = np.asarray(Image.open(args.base).convert("RGB"), dtype=np.uint8)

    coarse = crop.reduce(2)                                  # box-filtered half resolution
    free = np.asarray(coarse.resize(crop.size, Image.BILINEAR), dtype=np.uint8)

    plain = png_bytes(target)
    free_r, free_err = residual_cost(target, free)
    spl_r, spl_err = residual_cost(target, splats)
    spl_total = args.basebytes + spl_r

    print(f"=== {args.label}  (exact pixels, verified bit-for-bit) ===")
    print(f"{'method':<34} {'bytes':>9} {'KB':>8} {'vs plain':>9}   mean |error| before residual")
    print(f"{'plain lossless PNG':<34} {plain:>9} {plain/1024:>8.1f} {'1.00x':>9}")
    print(f"{'free predictor + residual':<34} {free_r:>9} {free_r/1024:>8.1f} "
          f"{plain/free_r:>8.2f}x   {free_err:.2f}")
    print(f"{'splat base + residual (total)':<34} {spl_total:>9} {spl_total/1024:>8.1f} "
          f"{plain/spl_total:>8.2f}x   {spl_err:.2f}")
    print(f"{'  of which the residual alone':<34} {spl_r:>9} {spl_r/1024:>8.1f} "
          f"{plain/spl_r:>8.2f}x")


if __name__ == "__main__":
    main()
