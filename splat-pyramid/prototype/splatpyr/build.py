"""
Building the splat pyramid: coarsest level first, each level only adding detail.

The top level (a single unit) is the base, fitted to its pixels with normalised blobs. Every
level below it is fitted to its residual: the level's pixels minus what all coarser levels
already draw there. The viewer draws the base plus every detail level down to the one it
needs, so coarse information is never sent twice.

Units of one level depend only on coarser levels, so a level is fitted in parallel, and it is
published (added to manifest.json "ready") as soon as it is done. Levels below --finest are
left to the server, which fits a unit the first time it is asked for (Store.ensure).

Splats only for the coarse levels. Fitting cost grows with the pixel count and each level
has four times the units of the one above, so the fine levels are nearly all of it. Levels
below `split` are therefore plain JPEG tiles - resized and encoded, never fitted - and only
levels split..max_level are splats. By default split is chosen so that at most SPLAT_UNITS
units are fitted, which bounds preprocessing whatever the image size. The viewer draws the
splats for the overview and the zoom in between, and the JPEG tiles near 1:1 on top of them.
"""

import json
import os
import threading
import time
from collections import OrderedDict
from dataclasses import asdict
from multiprocessing import get_context

import numpy as np
from PIL import Image

from . import codec
from .blobs import render
from .fit import FitConfig, fit_unit
from .pyramid import JPEG_QUALITY, SPLAT_UNITS, Pyramid, encode_tile, split_for, tile_file


class Store:
    """The pixel pyramid and the splat files under one root, with fitting on demand."""

    def __init__(self, root, cfg=None, cache=512):
        self.root = root
        self.pyr = Pyramid(root)
        self.cfg = cfg or load_config(root)
        self.cfg.tile = self.pyr.tile
        self._units = OrderedDict()
        self._cache_size = cache
        self._locks = {}
        self._guard = threading.Lock()

    # -- files -------------------------------------------------------------------------

    def path(self, level, x, y):
        return os.path.join(self.root, "splats", str(level), f"{x}_{y}.spx")

    def has(self, level, x, y):
        return os.path.exists(self.path(level, x, y))

    def tile_path(self, level, x, y):
        """The unit's image tile (below the split), whichever format it was kept in."""
        return tile_file(self.root, level, x, y)

    def ensure_tile(self, level, x, y, quality=JPEG_QUALITY):
        """The image tile of a unit below the split, encoded from its PNG pixels if missing
        (ingest normally writes it directly). Returns its size in bytes."""
        path = self.tile_path(level, x, y)
        if path is None:
            src = os.path.join(self.root, "pixels", str(level), f"{x}_{y}.png")
            ext, data = encode_tile(Image.open(src).convert("RGB"), self.pyr.tile_format, quality)
            path = os.path.join(self.root, "tiles", str(level), f"{x}_{y}.{ext}")
            os.makedirs(os.path.dirname(path), exist_ok=True)
            tmp = f"{path}.{os.getpid()}.{threading.get_ident()}.tmp"
            with open(tmp, "wb") as f:
                f.write(data)
            os.replace(tmp, path)
        return os.path.getsize(path)

    def unit(self, level, x, y, fit_missing=False):
        """(mode, w, h, Blobs) of a unit, fitting it first if asked and missing."""
        key = (level, x, y)
        with self._guard:
            if key in self._units:
                self._units.move_to_end(key)
                return self._units[key]
        if not self.has(level, x, y):
            if not fit_missing:
                raise FileNotFoundError(self.path(level, x, y))
            self.ensure(level, x, y)
        found = codec.read_unit(self.path(level, x, y))
        with self._guard:
            self._units[key] = found
            if len(self._units) > self._cache_size:
                self._units.popitem(last=False)
        return found

    def _lock(self, key):
        with self._guard:
            return self._locks.setdefault(key, threading.Lock())

    def ensure(self, level, x, y):
        """Fit a unit if its file does not exist yet, fitting any missing coarser unit it
        rests on first. Returns the fit stats, or None if it was already there."""
        if self.has(level, x, y):
            return None
        with self._lock((level, x, y)):          # coarser locks are taken inside: no cycles
            if self.has(level, x, y):
                return None
            return self.fit_and_write(level, x, y, fit_missing=True)

    # -- fitting -------------------------------------------------------------------------

    def prediction(self, level, x0, y0, x1, y1, fit_missing=False, finest=None):
        """What every level coarser than `level` draws over pixels [x0, x1) x [y0, y1) of
        `level`: the normalised base plus every detail level in between. finest=level
        includes the level itself, which is what the viewer shows at that level."""
        H, W = y1 - y0, x1 - x0
        out = np.zeros((H, W, 3))
        T = self.pyr.tile
        finest = level + 1 if finest is None else finest
        for coarse in range(self.pyr.max_level, finest - 1, -1):
            s = 2 ** (coarse - level)
            cols, rows = self.pyr.grid(coarse)
            ax0, ax1 = max(0, x0 // (s * T)), min(cols - 1, (x1 - 1) // (s * T))
            ay0, ay1 = max(0, y0 // (s * T)), min(rows - 1, (y1 - 1) // (s * T))
            for ay in range(ay0, ay1 + 1):
                for ax in range(ax0, ax1 + 1):
                    mode, uw, uh, blobs = self.unit(coarse, ax, ay, fit_missing)
                    ox, oy = ax * T * s - x0, ay * T * s - y0
                    clip = (ox, oy, ox + uw * s, oy + uh * s)
                    img, _ = render(blobs.placed(ox, oy, s), H, W,
                                    mode == codec.NORMALIZED, clip)
                    out += img
        return out

    def fit(self, level, x, y, cfg=None, base=None, fit_missing=False):
        """Fit one unit without writing it. Returns (Blobs, w, h, mode, stats)."""
        cfg = cfg or self.cfg
        pyr = self.pyr
        T, M = pyr.tile, cfg.margin
        w, h = pyr.unit_size(level, x, y)
        x0, y0 = x * T - M, y * T - M
        x1, y1 = x0 + w + 2 * M, y0 + h + 2 * M
        target = pyr.crop(level, x0, y0, x1, y1)
        lw, lh = pyr.level_size(level)
        inside = np.zeros((h + 2 * M, w + 2 * M))
        inside[max(0, -y0):min(h + 2 * M, lh - y0), max(0, -x0):min(w + 2 * M, lw - x0)] = 1
        if base is None:
            base = level == pyr.max_level
        prediction = None if base else self.prediction(level, x0, y0, x1, y1, fit_missing)
        blobs, stats = fit_unit(target, prediction, M, w, h, cfg, base, inside)
        mode = codec.NORMALIZED if base else codec.ADDITIVE
        return blobs, w, h, mode, stats

    def fit_and_write(self, level, x, y, fit_missing=False):
        blobs, w, h, mode, stats = self.fit(level, x, y, fit_missing=fit_missing)
        data = codec.encode(codec.to_codes(blobs, w, h), w, h, mode)
        path = self.path(level, x, y)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = f"{path}.{os.getpid()}.{threading.get_ident()}.tmp"
        with open(tmp, "wb") as f:
            f.write(data)
        os.replace(tmp, path)
        stats["bytes"] = len(data)
        return stats


# ---------------------------------------------------------------------------------------
# manifest and config
# ---------------------------------------------------------------------------------------

def load_config(root):
    path = os.path.join(root, "fit.json")
    if os.path.exists(path):
        with open(path) as f:
            return FitConfig(**json.load(f))
    return FitConfig()


def save_config(root, cfg):
    with open(os.path.join(root, "fit.json"), "w") as f:
        json.dump(asdict(cfg), f, indent=2)


def write_manifest(root, ready, split=None):
    """ready: levels fully prepared. split: first splat level (levels below it are JPEG
    tiles); kept from the existing manifest when not given, 0 (all splats) if none."""
    pyr = Pyramid(root)
    if split is None:
        old = read_manifest(root)
        split = old.get("split", 0) if old else 0
    manifest = {"format": "SPX1", "width": pyr.width, "height": pyr.height, "tile": pyr.tile,
                "max_level": pyr.max_level, "split": split, "tile_format": "jpg",
                "ready": sorted(ready, reverse=True)}
    tmp = os.path.join(root, "manifest.json.tmp")
    with open(tmp, "w") as f:
        json.dump(manifest, f, indent=2)
    os.replace(tmp, os.path.join(root, "manifest.json"))


def read_manifest(root):
    path = os.path.join(root, "manifest.json")
    if not os.path.exists(path):
        return None
    with open(path) as f:
        return json.load(f)


# ---------------------------------------------------------------------------------------
# batch build
# ---------------------------------------------------------------------------------------

_worker_store = None


def _worker_init(root):
    global _worker_store
    _worker_store = Store(root)


def _worker_fit(job):
    level, x, y = job
    if _worker_store.has(level, x, y):
        return job, None
    return job, _worker_store.fit_and_write(level, x, y)


def _worker_tile(job):
    level, x, y = job
    return job, _worker_store.ensure_tile(level, x, y)


def build(root, finest=0, workers=None, split=None, splat_units=SPLAT_UNITS, log=print):
    """Fit splat levels from the top down to the split, then encode JPEG tiles for the
    levels below it, down to `finest`."""
    pyr = Pyramid(root)
    if split is None:
        split = pyr.split if pyr.split is not None else \
            split_for(pyr.width, pyr.height, pyr.tile, splat_units)
    elif pyr.split is not None and split < pyr.split:
        log(f"note: levels {pyr.split - 1}..{split} were ingested as JPEG only; they will be "
            f"fitted against the JPEG pixels (re-ingest with --split {split} for lossless)")
    split = max(0, min(split, pyr.max_level))
    splat_count = sum(pyr.grid(L)[0] * pyr.grid(L)[1] for L in range(split, pyr.max_level + 1))
    tile_count = sum(pyr.grid(L)[0] * pyr.grid(L)[1] for L in range(finest, split))
    log(f"splats for levels {pyr.max_level}..{split} ({splat_count} units), "
        f"image tiles for levels {split - 1}..{finest} ({tile_count} tiles)"
        if split > finest else f"splats for levels {pyr.max_level}..{finest}")
    if not workers:
        # polish shares one GPU, so a few processes are enough to keep it busy
        cpu = max(1, (os.cpu_count() or 2) - 2)
        workers = min(3, cpu) if load_config(root).polish else cpu
    manifest = read_manifest(root)
    ready = set(manifest["ready"]) if manifest else set()
    started = time.time()
    ctx = get_context("spawn")
    with ctx.Pool(workers, initializer=_worker_init, initargs=(root,)) as pool:
        for level in range(pyr.max_level, max(finest, split) - 1, -1):
            cols, rows = pyr.grid(level)
            jobs = [(level, x, y) for y in range(rows) for x in range(cols)]
            t0 = time.time()
            totals = {"blobs": 0, "bytes": 0, "empty": 0, "fitted": 0, "psnr": []}
            for done, (_, stats) in enumerate(pool.imap_unordered(_worker_fit, jobs), 1):
                if stats:
                    totals["fitted"] += 1
                    totals["blobs"] += stats["blobs"]
                    totals["bytes"] += stats["bytes"]
                    totals["empty"] += stats["blobs"] == 0
                    totals["psnr"].append(stats["psnr"])
                if done % max(1, len(jobs) // 10) == 0 and done < len(jobs):
                    log(f"  level {level}: {done}/{len(jobs)} units")
            ready.add(level)
            write_manifest(root, ready, split)
            psnr = f"{np.mean(totals['psnr']):.1f} dB mean" if totals["psnr"] else "-"
            log(f"level {level}: {len(jobs)} units ({totals['fitted']} fitted, "
                f"{totals['empty']} empty), {totals['blobs']} blobs, "
                f"{totals['bytes'] / 1024:.0f} KB, {psnr}, {time.time() - t0:.1f}s")
        for level in range(split - 1, finest - 1, -1):
            cols, rows = pyr.grid(level)
            jobs = [(level, x, y) for y in range(rows) for x in range(cols)]
            t0 = time.time()
            size = sum(b for _, b in pool.imap_unordered(_worker_tile, jobs, chunksize=16))
            ready.add(level)
            write_manifest(root, ready, split)
            log(f"level {level}: {len(jobs)} image tiles, {size / 2 ** 20:.1f} MB, "
                f"{time.time() - t0:.1f}s")
    log(f"built down to level {finest} in {time.time() - started:.0f}s")
