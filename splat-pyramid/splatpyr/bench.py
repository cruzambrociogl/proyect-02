"""
Measurements that decide whether the design holds.

  bench-unit       one unit at several PSNR targets: blobs, bytes, seconds, PSNR, next to
                   JPEG of the same pixels at the same bytes and at the same PSNR.
  bench-hierarchy  the go/no-go for the residual pyramid: one unit fitted as detail on top of
                   its coarser levels, against the same unit fitted from scratch.
  check            what the viewer would show at a level, against the level's pixels: PSNR,
                   and error at unit borders against unit interiors (seams). Can write a PNG.

Pick positive controls on purpose - a star field unit, a bright unit, a flat unit - rather
than whatever unit 0_0 happens to be.
"""

import io
import math
import random
from dataclasses import replace

import numpy as np
from PIL import Image

from . import codec
from .blobs import render
from .build import Store


def psnr(a, b):
    mse = float(np.mean((np.clip(a, 0, 1) - b) ** 2))
    return 99.0 if mse <= 1e-10 else 10 * math.log10(1 / mse)


def _jpeg(pixels, quality):
    buf = io.BytesIO()
    Image.fromarray(np.round(pixels * 255).astype(np.uint8)).save(buf, "JPEG", quality=quality)
    data = buf.getvalue()
    back = np.asarray(Image.open(io.BytesIO(data)).convert("RGB"), np.float64) / 255
    return len(data), psnr(back, pixels)


def jpeg_curve(pixels):
    return [(q,) + _jpeg(pixels, q) for q in range(5, 100, 5)]


def _unit_pixels(store, level, x, y):
    T = store.pyr.tile
    w, h = store.pyr.unit_size(level, x, y)
    return store.pyr.crop(level, x * T, y * T, x * T + w, y * T + h)


def _shown(store, level, x, y, blobs, mode):
    """What the viewer shows on the unit: coarser levels plus these blobs."""
    T = store.pyr.tile
    w, h = store.pyr.unit_size(level, x, y)
    img = np.zeros((h, w, 3))
    if mode == codec.ADDITIVE:
        img += store.prediction(level, x * T, y * T, x * T + w, y * T + h, fit_missing=True)

    drawn, _ = render(blobs, h, w, mode == codec.NORMALIZED)
    return img + drawn


def bench_unit(root, level, x, y, targets, log=print):
    store = Store(root)
    pixels = _unit_pixels(store, level, x, y)
    curve = jpeg_curve(pixels)
    log(f"unit {level}/{x}_{y} ({pixels.shape[1]}x{pixels.shape[0]})")
    log(f"{'target':>7} {'blobs':>6} {'KB':>7} {'sec':>6} {'PSNR':>6} | "
        f"{'JPEG same KB':>13} {'JPEG KB same dB':>16}")
    for t in targets:
        cfg = replace(store.cfg, psnr=t)
        blobs, w, h, mode, stats = store.fit(level, x, y, cfg, fit_missing=True)
        size = len(codec.encode(codec.to_codes(blobs, w, h), w, h, mode))
        got = psnr(_shown(store, level, x, y, blobs, mode), pixels)
        same_bytes = max((p for _, b, p in curve if b <= size), default=float("nan"))
        same_db = min((b for _, b, p in curve if p >= got), default=float("nan"))
        log(f"{t:7.1f} {len(blobs):6d} {size / 1024:7.1f} {stats['seconds']:6.2f} {got:6.2f} | "
            f"{same_bytes:10.2f} dB {same_db / 1024:13.1f} KB")
    if level < store.pyr.max_level:
        log("note: splat bytes are this unit's detail only; its coarser levels are shared with "
            "its neighbours and sent once. JPEG bytes are a whole tile.")


def bench_hierarchy(root, level, x, y, target, log=print):
    store = Store(root)
    if level >= store.pyr.max_level:
        raise SystemExit("the base level has nothing coarser to rest on: pick a lower level")
    pixels = _unit_pixels(store, level, x, y)
    # The PSNR a fit lands on is not exactly its target (polish overshoots by a varying
    # amount), so each arm is swept over targets and compared on bytes at the same PSNR.
    sweep = [target + d for d in (-6, -4, -2, 0, 2, 4)]
    log(f"unit {level}/{x}_{y}: bytes to reach {target} dB, sweeping targets {sweep[0]}..{sweep[-1]}")
    at_target = {}
    for name, base in (("residual", False), ("from scratch", True)):
        curve = []
        for t in sweep:
            cfg = replace(store.cfg, psnr=t)
            blobs, w, h, mode, stats = store.fit(level, x, y, cfg, base=base, fit_missing=True)
            size = len(codec.encode(codec.to_codes(blobs, w, h), w, h, mode))
            got = psnr(_shown(store, level, x, y, blobs, mode), pixels)
            curve.append((got, size, stats["seconds"]))
        curve.sort()
        at_target[name] = _bytes_at(curve, target)
        points = ", ".join(f"{p:.1f} dB {b / 1024:.1f} KB" for p, b, _ in curve)
        log(f"  {name:13s} {points}")
    b_r, b_s = at_target["residual"], at_target["from scratch"]
    if math.isnan(b_r) or math.isnan(b_s):
        log("  one arm never reached the target: widen the sweep or lower --psnr")
        return "UNDECIDED"
    ratio = b_r / b_s
    verdict = "GO" if ratio <= 0.7 else "NO-GO"
    log(f"  at {target} dB: residual {b_r / 1024:.1f} KB, from scratch {b_s / 1024:.1f} KB, "
        f"ratio {ratio:.2f} -> {verdict} (GO needs <= 0.70)")
    return verdict


def _bytes_at(curve, target):
    """Bytes at `target` dB, interpolated along a (psnr, bytes, ...) curve sorted by psnr;
    nan if the curve never reaches it."""
    for (p0, b0, *_), (p1, b1, *_) in zip(curve, curve[1:]):
        if p0 <= target <= p1:
            return b0 + (b1 - b0) * (target - p0) / max(1e-9, p1 - p0)
    return curve[0][1] if curve and curve[0][0] >= target else float("nan")


def check(root, level, sample=16, band=3, png=None, seed=1, log=print):
    """Render units of a level as the viewer would and compare them with the pixels."""
    store = Store(root)
    pyr = store.pyr
    T = pyr.tile
    cols, rows = pyr.grid(level)
    units = [(x, y) for y in range(rows) for x in range(cols)]
    if sample and len(units) > sample:
        units = random.Random(seed).sample(units, sample)
    err_all, err_border, err_inner = [], [], []
    for x, y in units:
        w, h = pyr.unit_size(level, x, y)
        pixels = _unit_pixels(store, level, x, y)
        shown = store.prediction(level, x * T, y * T, x * T + w, y * T + h,
                                 fit_missing=True, finest=level)
        e = (np.clip(shown, 0, 1) - pixels) ** 2
        border = np.zeros((h, w), bool)
        border[:band], border[-band:], border[:, :band], border[:, -band:] = True, True, True, True
        err_all.append(e.mean())
        err_border.append(e[border].mean())
        err_inner.append(e[~border].mean() if (~border).any() else e.mean())
    to_db = lambda m: 10 * math.log10(1 / max(m, 1e-10))  # noqa: E731
    log(f"level {level}: {len(units)} units, {to_db(np.mean(err_all)):.2f} dB overall, "
        f"border {to_db(np.mean(err_border)):.2f} dB vs interior {to_db(np.mean(err_inner)):.2f} dB")
    if png:
        lw, lh = pyr.level_size(level)
        if lw * lh > 4096 * 4096:
            log("level too large for a PNG; pick a coarser one")
        else:
            shown = store.prediction(level, 0, 0, lw, lh, fit_missing=True, finest=level)
            truth = pyr.crop(level, 0, 0, lw, lh)
            both = np.concatenate([np.clip(shown, 0, 1), truth], 1)
            Image.fromarray(np.round(both * 255).astype(np.uint8)).save(png)
            log(f"wrote {png} (splats left, pixels right)")
    return to_db(np.mean(err_all)), to_db(np.mean(err_border)), to_db(np.mean(err_inner))
