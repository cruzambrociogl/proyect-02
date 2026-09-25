"""
Blobs and the one rule for drawing them.

Everything that draws blobs - the fitter, the checker and viewer/viewer.js - follows the rule
written here, so what the fitter aims at is exactly what the viewer shows:

  coordinates  continuous pixel coordinates of the blob's own level; pixel i covers [i, i+1)
               and is sampled at its centre, i + 0.5. Level L+1 is level L halved, so a blob
               at level A drawn at level L is scaled by s = 2 ** (A - L), position and size.
  weight       exp(-0.5 * r2), r2 the squared distance in the blob's rotated, scaled frame,
               and zero beyond `reach`: CUTOFF sigmas along the long axis or MIN_REACH of its
               own level's pixels, whichever is further.
  normalised   (the base level) a pixel is sum(colour * weight) / max(sum(weight), EPS):
               an average of the blobs covering it, which cannot overshoot.
  additive     (every detail level) a pixel is sum(colour * weight): a signed correction.
  clipping     each unit's blobs are drawn only inside that unit's own rectangle, so a pixel
               belongs to exactly one unit per level and neighbours never add up.
"""

import numpy as np

CUTOFF = 3.0
MIN_REACH = 1.5
SIGMA_MIN = 0.4
SIGMA_MAX = 48.0
EPS = 1e-4

_CHUNK = 2_000_000          # pixel evaluations per vectorised batch, to bound memory


class Blobs:
    """A set of blobs as parallel arrays. `reach` scales with the blob, so it is kept rather
    than recomputed: a blob drawn s times larger reaches s times further, MIN_REACH included."""

    __slots__ = ("x", "y", "sx", "sy", "th", "c", "reach")

    def __init__(self, x, y, sx, sy, th, c, reach=None):
        self.x = np.asarray(x, np.float64).reshape(-1)
        self.y = np.asarray(y, np.float64).reshape(-1)
        self.sx = np.asarray(sx, np.float64).reshape(-1)
        self.sy = np.asarray(sy, np.float64).reshape(-1)
        self.th = np.asarray(th, np.float64).reshape(-1)
        self.c = np.asarray(c, np.float64).reshape(-1, 3)
        self.reach = (np.maximum(CUTOFF * np.maximum(self.sx, self.sy), MIN_REACH)
                      if reach is None else np.asarray(reach, np.float64).reshape(-1))

    def __len__(self):
        return self.x.shape[0]

    @staticmethod
    def empty():
        z = np.zeros(0)
        return Blobs(z, z, z, z, z, np.zeros((0, 3)))

    @staticmethod
    def concat(*parts):
        parts = [p for p in parts if len(p)]
        if not parts:
            return Blobs.empty()
        return Blobs(*(np.concatenate([getattr(p, f) for p in parts])
                       for f in ("x", "y", "sx", "sy", "th", "c", "reach")))

    def take(self, idx):
        return Blobs(self.x[idx], self.y[idx], self.sx[idx], self.sy[idx], self.th[idx],
                     self.c[idx], self.reach[idx])

    def with_colours(self, c):
        return Blobs(self.x, self.y, self.sx, self.sy, self.th, c, self.reach)

    def placed(self, dx, dy, s):
        """These blobs s times larger and shifted by (dx, dy): a coarser level's blobs as they
        land on a finer level's grid."""
        return Blobs(self.x * s + dx, self.y * s + dy, self.sx * s, self.sy * s, self.th,
                     self.c, self.reach * s)


def _bucket(n):
    """Round a patch side up so that blobs share a few patch shapes."""
    if n <= 64:
        return int(-(-n // 4) * 4)
    return int(-(-n // 32) * 32)


def footprint(b, H, W, clip=None):
    """Every blob's weight on an H x W grid, as sparse triples (pixel, blob, weight).

    clip is (x0, y0, x1, y1) in pixels, the rectangle the blobs may draw in; by default the
    whole grid. Pixels are numbered y * W + x.
    """
    n = len(b)
    empty = (np.zeros(0, np.int64), np.zeros(0, np.int64), np.zeros(0))
    if n == 0:
        return empty
    cx0, cy0, cx1, cy1 = clip if clip is not None else (0, 0, W, H)
    cx0, cy0 = max(0, int(cx0)), max(0, int(cy0))
    cx1, cy1 = min(W, int(cx1)), min(H, int(cy1))
    if cx0 >= cx1 or cy0 >= cy1:
        return empty

    # pixel i is reached when |i + 0.5 - x| <= reach
    i0 = np.maximum(np.ceil(b.x - b.reach - 0.5), cx0).astype(np.int64)
    i1 = np.minimum(np.floor(b.x + b.reach - 0.5), cx1 - 1).astype(np.int64)
    j0 = np.maximum(np.ceil(b.y - b.reach - 0.5), cy0).astype(np.int64)
    j1 = np.minimum(np.floor(b.y + b.reach - 0.5), cy1 - 1).astype(np.int64)
    live = (i1 >= i0) & (j1 >= j0)
    side = np.where(live, np.maximum(i1 - i0, j1 - j0) + 1, 0)
    buckets = np.array([_bucket(v) for v in side]) if n else side

    cos, sin = np.cos(b.th), np.sin(b.th)
    out_p, out_b, out_w = [], [], []
    for k in np.unique(buckets[live]):
        members = np.nonzero(live & (buckets == k))[0]
        per = max(1, _CHUNK // (k * k))
        g = np.arange(k)
        for start in range(0, len(members), per):
            m = members[start:start + per]
            px = i0[m, None, None] + g[None, None, :]
            py = j0[m, None, None] + g[None, :, None]
            dx = px + 0.5 - b.x[m, None, None]
            dy = py + 0.5 - b.y[m, None, None]
            u = (dx * cos[m, None, None] + dy * sin[m, None, None]) / b.sx[m, None, None]
            v = (-dx * sin[m, None, None] + dy * cos[m, None, None]) / b.sy[m, None, None]
            r = b.reach[m, None, None]
            keep = ((px <= i1[m, None, None]) & (py <= j1[m, None, None])
                    & (dx * dx + dy * dy <= r * r))
            w = np.exp(-0.5 * (u * u + v * v))
            keep &= w > 1e-8
            out_p.append((py * W + px)[keep])
            out_b.append(np.broadcast_to(m[:, None, None], keep.shape)[keep])
            out_w.append(w[keep])
    if not out_p:
        return empty
    return np.concatenate(out_p), np.concatenate(out_b), np.concatenate(out_w)


def render(b, H, W, normalized, clip=None):
    """Draw blobs on an H x W grid. Returns the image (H, W, 3) and the total blob weight at
    every pixel (H, W); outside `clip` both are zero."""
    pix, bi, w = footprint(b, H, W, clip)
    size = H * W
    total = np.bincount(pix, weights=w, minlength=size)
    img = np.stack([np.bincount(pix, weights=w * b.c[bi, ch], minlength=size)
                    for ch in range(3)], 1)
    if normalized:
        img = img / np.maximum(total, EPS)[:, None]
    return img.reshape(H, W, 3), total.reshape(H, W)
