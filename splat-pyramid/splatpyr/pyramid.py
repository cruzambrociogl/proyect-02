"""
The pixel pyramid: what the fitter aims at, and the JPEG tiles the viewer shows near 1:1.

Level 0 is the image at full size and every level above it is the one below halved with a
2x2 box average, so level L pixel i covers level-0 pixels [i * 2**L, (i + 1) * 2**L). The top
level, max_level, is the first that fits in a single tile: it is the base the whole splat
pyramid is built on.

Every level is cut into the image tiles the viewer shows at rest, tiles/L/x_y.jpg or .webp.
Levels from `split` up are also fitted as splats, the layer that arrives first and fills the
screen while tiles load, so they are kept lossless too, as PNG in pixels/L/x_y.png. The split is decided
here (at most SPLAT_UNITS fitted units by default) and recorded in pyramid.json.

Tile format, per tile ("auto"): each tile is encoded as JPEG and as lossless WebP, and the
lossless one is kept unless it is more than LOSSLESS_MAX_RATIO times the JPEG. Text, digits,
line art and flat graphics come out exact and usually smaller than JPEG; photographic tiles,
where lossless costs several times more, stay JPEG. "jpg" or "webp" forces one format.

With pyvips installed, ingest streams the image through libvips and never holds more than a
strip of it in memory: dzsave cuts every JPEG level in one pass, and a second pass shrinks
the image straight to the split level, which is small, for the PNG levels. Without it,
Pillow holds each level in memory (about 5 bytes per pixel), fine up to a gigapixel or two.
"""

import json
import math
import os
import shutil
import threading
import time
from collections import OrderedDict

import numpy as np
from PIL import Image

try:
    import pyvips
except (ImportError, OSError):      # OSError: the binding is there but libvips is not
    pyvips = None

Image.MAX_IMAGE_PIXELS = None

SPLAT_UNITS = 300           # default budget of fitted units, which sets the split level
JPEG_QUALITY = 85
LOSSLESS_MAX_RATIO = 1.5    # auto keeps lossless WebP up to this many times the JPEG's bytes
TILE_FORMATS = ("auto", "jpg", "webp")
TILE_TYPES = {"jpg": "image/jpeg", "webp": "image/webp"}


def tile_file(root, level, x, y):
    """The image tile of a unit below the split, whichever format it was kept in, or None."""
    for ext in TILE_TYPES:
        path = os.path.join(root, "tiles", str(level), f"{x}_{y}.{ext}")
        if os.path.exists(path):
            return path
    return None


def encode_tile(im, fmt="auto", quality=JPEG_QUALITY):
    """A PIL tile to (extension, bytes) in the given tile format."""
    import io
    out = {}
    if fmt in ("auto", "jpg"):
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=quality)
        out["jpg"] = buf.getvalue()
    if fmt in ("auto", "webp"):
        buf = io.BytesIO()
        im.save(buf, "WEBP", lossless=True, method=1)
        out["webp"] = buf.getvalue()
    ext = _choose(len(out["jpg"]), len(out["webp"])) if fmt == "auto" else fmt
    return ext, out[ext]


def _choose(jpg_bytes, webp_bytes):
    return "webp" if webp_bytes <= LOSSLESS_MAX_RATIO * jpg_bytes else "jpg"


def levels_for(width, height, tile):
    level = 0
    while math.ceil(width / 2 ** level) > tile or math.ceil(height / 2 ** level) > tile:
        level += 1
    return level


def grid_for(width, height, tile, level):
    w, h = math.ceil(width / 2 ** level), math.ceil(height / 2 ** level)
    return math.ceil(w / tile), math.ceil(h / tile)


def split_for(width, height, tile, budget=SPLAT_UNITS):
    """The finest level such that the splat levels from it up hold at most `budget` units
    (never below the top level: the base is always splats)."""
    top = levels_for(width, height, tile)
    total, split = 0, top
    for level in range(top, -1, -1):
        cols, rows = grid_for(width, height, tile, level)
        total += cols * rows
        if total > budget:
            break
        split = level
    return split


def ingest(image_path, root, tile=256, split=None, splat_units=SPLAT_UNITS,
           quality=JPEG_QUALITY, engine=None, tile_format="auto", log=print):
    """Cut an image into PNG levels (split and up) and image tiles (below the split) under
    root, and write root/pyramid.json. engine: "vips", "pil", or None for vips if present."""
    if tile_format not in TILE_FORMATS:
        raise SystemExit(f"tile format must be one of {TILE_FORMATS}")
    started = time.time()
    engine = engine or ("vips" if pyvips else "pil")
    if engine == "vips" and not pyvips:
        raise SystemExit("pyvips is not installed (brew install vips; pip install pyvips)")
    if engine == "vips":
        width, height = _vips_open(image_path).width, _vips_open(image_path).height
    else:
        with Image.open(image_path) as probe:
            width, height = probe.size
    top = levels_for(width, height, tile)
    if split is None:
        split = split_for(width, height, tile, splat_units)
    split = max(0, min(split, top))
    log(f"{os.path.basename(image_path)}: {width}x{height}, levels 0..{top}, tile {tile}, "
        f"splats {top}..{split}, tiles at every level ({tile_format})"
        + f" ({engine})")
    os.makedirs(root, exist_ok=True)
    if engine == "vips":
        _ingest_vips(image_path, root, tile, top, split, quality, tile_format, log)
    else:
        _ingest_pil(image_path, root, tile, top, split, quality, tile_format, log)
    meta = {"source": os.path.basename(image_path), "width": width, "height": height,
            "tile": tile, "max_level": top, "split": split, "tile_format": tile_format}
    with open(os.path.join(root, "pyramid.json"), "w") as f:
        json.dump(meta, f, indent=2)
    log(f"ingest done in {time.time() - started:.0f}s")
    return meta


def _write_levels(im, root, tile, first, last, split, quality, tile_format, log, tiles_below=10**9):
    """Write levels first..last (inclusive, upwards) starting from `im` at level `first`: image
    tiles for every level (what the viewer shows at rest), and PNG too for the levels at or
    above the split (what the splats are fitted to). `tiles_below` limits the tiles to the
    levels below it, when another pass already cut the others."""
    for level in range(first, last + 1):
        w, h = im.size
        lossless = level >= split
        tiles_too = level < tiles_below
        pixels = os.path.join(root, "pixels", str(level))
        folder = os.path.join(root, "tiles", str(level))
        if lossless:
            os.makedirs(pixels, exist_ok=True)
        if tiles_too:
            os.makedirs(folder, exist_ok=True)
        cols, rows = math.ceil(w / tile), math.ceil(h / tile)
        kept = {}
        for y in range(rows):
            for x in range(cols):
                box = (x * tile, y * tile, min(w, (x + 1) * tile), min(h, (y + 1) * tile))
                part = im.crop(box)
                if lossless:
                    part.save(os.path.join(pixels, f"{x}_{y}.png"), compress_level=1)
                if tiles_too:
                    ext, data = encode_tile(part, tile_format, quality)
                    with open(os.path.join(folder, f"{x}_{y}.{ext}"), "wb") as f:
                        f.write(data)
                    kept[ext] = kept.get(ext, 0) + 1
        kinds = ", ".join(([f"PNG"] if lossless else []) + [f"{n} {e}" for e, n in sorted(kept.items())])
        log(f"  level {level}: {w}x{h}, {cols * rows} tiles ({kinds})")
        if level < last:
            im = _halve(im)


def _ingest_pil(image_path, root, tile, top, split, quality, tile_format, log):
    im = Image.open(image_path).convert("RGB")
    _write_levels(im, root, tile, 0, top, split, quality, tile_format, log)


def _vips_open(path):
    img = pyvips.Image.new_from_file(path, access="sequential")
    if img.hasalpha():
        img = img.flatten()
    if img.bands < 3 or img.interpretation not in ("srgb", "rgb") or img.format != "uchar":
        img = img.colourspace("srgb")
    if img.format != "uchar":
        img = img.cast("uchar")
    return img[:3] if img.bands > 3 else img


def _ingest_vips(image_path, root, tile, top, split, quality, tile_format, log):
    if split > 0:
        # every level in one streaming pass per format (dzsave writes one format at a
        # time); only the levels below the split are kept, and for "auto" the smaller
        # acceptable format of each tile
        t0 = time.time()
        suffixes = {"jpg": f".jpg[Q={quality},keep=none]",
                    "webp": ".webp[lossless=true,effort=1,keep=none]"}
        formats = ["jpg", "webp"] if tile_format == "auto" else [tile_format]
        runs = {}
        for ext in formats:
            work = os.path.join(root, f"_dz_{ext}")
            shutil.rmtree(work + "_files", ignore_errors=True)
            _vips_open(image_path).dzsave(work, layout="dz", tile_size=tile, overlap=0,
                                          depth="onepixel", suffix=suffixes[ext])
            levels = sorted(int(d) for d in os.listdir(work + "_files") if d.isdigit())
            runs[ext] = (work, levels[-1])     # DeepZoom counts up from 1 px to full size
            log(f"  {ext} pass in {time.time() - t0:.0f}s")
        for level in range(top + 1):              # every level: tiles are the view at rest
            dest = os.path.join(root, "tiles", str(level))
            shutil.rmtree(dest, ignore_errors=True)
            os.makedirs(dest)
            kept = {}
            src = {ext: os.path.join(work + "_files", str(full - level))
                   for ext, (work, full) in runs.items()}
            for name in os.listdir(src[formats[0]]):
                stem = name.rsplit(".", 1)[0]
                paths = {ext: os.path.join(src[ext], f"{stem}.{ext}") for ext in formats}
                ext = (_choose(os.path.getsize(paths["jpg"]), os.path.getsize(paths["webp"]))
                       if tile_format == "auto" else tile_format)
                os.replace(paths[ext], os.path.join(dest, f"{stem}.{ext}"))
                kept[ext] = kept.get(ext, 0) + 1
            log(f"  level {level}: " + ", ".join(f"{n} {e}" for e, n in sorted(kept.items())) + " tiles")
        for work, _ in runs.values():
            shutil.rmtree(work + "_files", ignore_errors=True)
            if os.path.exists(work + ".dzi"):
                os.remove(work + ".dzi")
        log(f"  tile levels in {time.time() - t0:.0f}s")

    # second pass: straight down to the split level, which is small, then halve upwards
    t0 = time.time()
    img = _vips_open(image_path)
    f = 2 ** split
    if f > 1:
        W, H = img.width, img.height
        # repeat the edge out to a whole block, as halving level by level would
        img = img.embed(0, 0, math.ceil(W / f) * f, math.ceil(H / f) * f, extend="copy")
        img = img.shrink(f, f)
    arr = np.ndarray(buffer=img.write_to_memory(), dtype=np.uint8,
                     shape=(img.height, img.width, img.bands))
    # the tiles of every level came from the first pass: only the PNGs here
    _write_levels(Image.fromarray(arr), root, tile, split, top, split, quality, tile_format, log,
                  tiles_below=0 if split > 0 else 10**9)
    log(f"  PNG levels in {time.time() - t0:.0f}s")


def _halve(im):
    """2x2 box average. An odd edge is padded with a copy of itself first, so that level L+1
    pixel i always covers exactly level L pixels 2i and 2i+1."""
    w, h = im.size
    if w % 2 or h % 2:
        padded = Image.new("RGB", (w + w % 2, h + h % 2))
        padded.paste(im, (0, 0))
        if w % 2:
            padded.paste(im.crop((w - 1, 0, w, h)), (w, 0))
        if h % 2:
            padded.paste(padded.crop((0, h - 1, w + w % 2, h)), (0, h))
        im = padded
    return im.reduce(2)


class Pyramid:
    """Reads the pixel pyramid back as float arrays in [0, 1]."""

    def __init__(self, root, cache=96):
        with open(os.path.join(root, "pyramid.json")) as f:
            meta = json.load(f)
        self.root = root
        self.width = meta["width"]
        self.height = meta["height"]
        self.tile = meta["tile"]
        self.max_level = meta["max_level"]
        self.split = meta.get("split")          # None: ingested before splits existed
        self.tile_format = meta.get("tile_format", "jpg")
        self._cache = OrderedDict()
        self._cache_size = cache
        self._lock = threading.Lock()

    def level_size(self, level):
        return math.ceil(self.width / 2 ** level), math.ceil(self.height / 2 ** level)

    def grid(self, level):
        w, h = self.level_size(level)
        return math.ceil(w / self.tile), math.ceil(h / self.tile)

    def unit_size(self, level, x, y):
        w, h = self.level_size(level)
        return min(self.tile, w - x * self.tile), min(self.tile, h - y * self.tile)

    def exists(self, level, x, y):
        cols, rows = self.grid(level)
        return 0 <= level <= self.max_level and 0 <= x < cols and 0 <= y < rows

    def tile_pixels(self, level, x, y):
        key = (level, x, y)
        with self._lock:
            if key in self._cache:
                self._cache.move_to_end(key)
                return self._cache[key]
        path = os.path.join(self.root, "pixels", str(level), f"{x}_{y}.png")
        if not os.path.exists(path):
            # a level ingested as image tiles only (below the split it was ingested with)
            path = tile_file(self.root, level, x, y) or path
        a = np.asarray(Image.open(path).convert("RGB"), dtype=np.float64) / 255.0
        with self._lock:
            self._cache[key] = a
            if len(self._cache) > self._cache_size:
                self._cache.popitem(last=False)
        return a

    def crop(self, level, x0, y0, x1, y1):
        """Pixels [x0, x1) x [y0, y1) of a level. Outside the image the edge is repeated."""
        lw, lh = self.level_size(level)
        T = self.tile
        xs = np.clip(np.arange(x0, x1), 0, lw - 1)
        ys = np.clip(np.arange(y0, y1), 0, lh - 1)
        tx0, tx1 = xs.min() // T, xs.max() // T
        ty0, ty1 = ys.min() // T, ys.max() // T
        region = np.concatenate([
            np.concatenate([self.tile_pixels(level, tx, ty) for tx in range(tx0, tx1 + 1)], 1)
            for ty in range(ty0, ty1 + 1)], 0)
        return region[np.ix_(ys - ty0 * T, xs - tx0 * T)]
