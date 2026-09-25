"""
Fitting one unit by formula: no training loop.

The goal is the unit's pixels at the base level, and the residual (pixels minus what every
coarser level already draws) at every detail level. For a goal:

  1. points    isolated bright or dark pixels (stars, specular glints) get a tiny blob each;
               a quadtree would spend a whole branch of splits on every one of them
  2. layout    a quadtree over the goal: the square whose one-blob error is largest is split
               in four until every square's error is under the target. Busy areas end with
               many small blobs, flat ones with a few large ones, and at detail levels a
               square with nothing left to correct gets no blob at all. Each blob sits in its
               square, stretched along the local edge (from the structure tensor).
  3. colours   with positions and shapes fixed, every pixel is linear in the blobs' colours,
               so the best colours are one sparse least-squares solve.
  4. budget    if the unit misses the target PSNR, the split threshold drops and it is laid
               out again, up to `rounds` times or the blob cap.
  5. holes     (base only) a pixel no blob reaches well gets a blob of its own; averaging
               blobs cannot repair a pixel with no weight.
  6. polish    (optional, needs torch) a few hundred Adam steps over position, size, rotation
               and colour, starting from the formula's answer; the formula then only has to
               get within polish_credit dB of the target. See polish.py.
  7. quantise  geometry is rounded to what the file carries, colours are solved again for
               exactly those shapes, then rounded too. The PSNR reported is of the decoded
               blobs, so it is what the viewer will show.

Units are fitted on a crop padded by `margin` pixels of their neighbours, weighted less, so
edge blobs agree with what lies across the border; blobs themselves sit inside the unit and
are drawn clipped to it.
"""

import heapq
import math
import time
from dataclasses import dataclass

import numpy as np
import scipy.sparse as sp
from scipy.sparse.linalg import factorized

from . import codec, polish
from .blobs import EPS, SIGMA_MIN, Blobs, footprint, render


@dataclass
class FitConfig:
    psnr: float = 32.0          # target, on the unit's own pixels, of the final drawn result
    max_blobs: int = 6000       # per full tile; smaller edge units get a share by area
    tile: int = 256
    start_loose: float = 8.0    # first layout threshold, in multiples of the target error
    tighten: float = 0.5        # threshold factor per round that misses the target
    rounds: int = 7
    margin: int = 8             # neighbour pixels around the unit that the fit also looks at
    margin_weight: float = 0.5
    grid: int = 16              # the quadtree starts from squares this big
    spread: float = 0.45        # blob radius as a fraction of its square's side
    sigma_cap: float = 24.0
    point_sigma: float = 0.6
    points: bool = True
    damping: float = 1e-4       # pulls weakly constrained colours to their local pixel
    polish: int = 300           # Adam steps after the formula (needs torch); 0 = formula only
    polish_credit: float = 4.0  # dB the formula may fall short of the target when polishing


HOLE = 1e-2
REPAIR_ROUNDS = 2


def fit_unit(target, prediction, margin, w, h, cfg, base, inside=None):
    """Fit one unit. target and prediction are the padded crop (h + 2m, w + 2m, 3); prediction
    is what the coarser levels draw there (None at the base level). inside is an (h+2m, w+2m)
    mask of pixels that are really in the image (edge-repeated padding counts for nothing).

    Returns (Blobs in unit coordinates, quantised; stats dict).
    """
    started = time.time()
    M = margin
    Hp, Wp = target.shape[:2]
    goal = target if base else target - prediction
    inner = (slice(M, M + h), slice(M, M + w))
    row_w = np.full((Hp, Wp), cfg.margin_weight)
    row_w[inner] = 1.0
    if inside is not None:
        row_w = row_w * inside
    target_mse = 10 ** (-cfg.psnr / 10)
    stats = {"rounds": 0, "repaired": 0}

    cap = max(16, round(cfg.max_blobs * w * h / cfg.tile ** 2))
    if not base and np.mean(goal[inner] ** 2) <= target_mse:
        blobs = Blobs.empty()                       # nothing worth correcting: zero bytes
    else:
        polishing = cfg.polish > 0 and polish.available()
        points = _points(goal[inner], cfg, cap) if cfg.points else Blobs.empty()

        def attempt(layout_mse):
            """Formula down to layout_mse, then polish (if on), then quantise."""
            # A square's variance overstates what its blob leaves behind (neighbours blend
            # into smooth ramps), so start loose and tighten until the unit meets the target.
            threshold = 3 * layout_mse * cfg.start_loose
            for round_ in range(cfg.rounds):
                stats["rounds"] += 1
                layout = _layout(goal[inner], threshold, cap - len(points), cfg, base)
                b = Blobs.concat(points, layout).placed(M, M, 1.0)
                b = solve_colours(b, goal, row_w, base, cfg.damping)
                if base:
                    b, added = _repair(b, goal, row_w, M, w, h, cfg)
                    stats["repaired"] = added
                err = _mse(b, goal, base, inner)
                # the quadtree stops a split short of the cap (a split adds 3 blobs)
                stats["capped"] = len(b) + 3 > cap
                if err <= layout_mse or stats["capped"]:
                    break
                threshold *= cfg.tighten
            stats["formula_psnr"] = _psnr(err)
            if polishing:
                b = polish.polish(b, goal, row_w, base, cfg.polish)
            # quantise: shapes first, colours solved again for those shapes, then colours
            shaped = codec.quantise_geometry(b.placed(-M, -M, 1.0), w, h).placed(M, M, 1.0)
            shaped = solve_colours(shaped, goal, row_w, base, cfg.damping)
            return codec.from_codes(codec.to_codes(shaped.placed(-M, -M, 1.0), w, h), w, h)

        # With polish the formula only has to get within polish_credit dB - but polish cannot
        # add much to a unit the formula left nearly empty, so a unit that still misses the
        # target is laid out again at the full target.
        credit = 10 ** (cfg.polish_credit / 10) if polishing else 1.0
        blobs = attempt(target_mse * credit)
        if (credit > 1 and not stats["capped"]
                and _mse(blobs.placed(M, M, 1.0), goal, base, inner) > target_mse):
            stats["retried"] = True
            blobs = attempt(target_mse)

    drawn = blobs.placed(M, M, 1.0)
    stats["psnr"] = _psnr(_mse(drawn, goal, base, inner))
    stats["blobs"] = len(blobs)
    stats["seconds"] = time.time() - started
    return blobs, stats


def _mse(blobs, goal, normalized, inner):
    if not len(blobs):
        return float(np.mean(goal[inner] ** 2))
    Hp, Wp = goal.shape[:2]
    img, _ = render(blobs, Hp, Wp, normalized)
    return float(np.mean((img[inner] - goal[inner]) ** 2))


def _psnr(mse):
    return 99.0 if mse <= 1e-10 else 10 * math.log10(1 / mse)


# ---------------------------------------------------------------------------------------
# colours
# ---------------------------------------------------------------------------------------

def solve_colours(blobs, goal, row_w, normalized, damping):
    """Least-squares colours for fixed blobs: minimise sum(row_w * (A c - goal)^2) plus a
    small pull of every colour towards the pixel under its centre."""
    Hp, Wp = goal.shape[:2]
    n = len(blobs)
    if n == 0:
        return blobs
    pix, bi, w = footprint(blobs, Hp, Wp)
    if normalized:
        total = np.bincount(pix, weights=w, minlength=Hp * Wp)
        w = w / np.maximum(total, EPS)[pix]
    root = np.sqrt(row_w.reshape(-1))
    A = sp.csr_matrix((w * root[pix], (pix, bi)), shape=(Hp * Wp, n))
    t = goal.reshape(-1, 3) * root[:, None]
    cx = np.clip(blobs.x.astype(np.int64), 0, Wp - 1)
    cy = np.clip(blobs.y.astype(np.int64), 0, Hp - 1)
    prior = goal[cy, cx]
    AtA = (A.T @ A).tocsc()
    lam = damping * max(1e-12, float(AtA.diagonal().mean()))
    solve = factorized((AtA + lam * sp.identity(n, format="csc")).tocsc())
    rhs = A.T @ t + lam * prior
    return blobs.with_colours(np.stack([solve(np.ascontiguousarray(rhs[:, k]))
                                        for k in range(3)], 1))


def _repair(blobs, goal, row_w, M, w, h, cfg, cell=3):
    """Give every pixel of the unit that no blob covers well a small blob, then solve again."""
    Hp, Wp = goal.shape[:2]
    added = 0
    for _ in range(REPAIR_ROUNDS):
        _, total = render(blobs, Hp, Wp, True)
        ys, xs = np.nonzero(total[M:M + h, M:M + w] < HOLE)
        if len(ys) == 0:
            break
        _, first = np.unique((ys // cell) * (w // cell + 1) + xs // cell, return_index=True)
        ys, xs = ys[first] + M, xs[first] + M
        added += len(ys)
        extra = Blobs(xs + 0.5, ys + 0.5, np.full(len(xs), 1.2), np.full(len(xs), 1.2),
                      np.zeros(len(xs)), goal[ys, xs])
        blobs = solve_colours(Blobs.concat(blobs, extra), goal, row_w, True, cfg.damping)
    return blobs, added


# ---------------------------------------------------------------------------------------
# placement
# ---------------------------------------------------------------------------------------

def _box_sum(table, x0, y0, x1, y1):
    return table[y1, x1] - table[y0, x1] - table[y1, x0] + table[y0, x0]


def _integral(a):
    t = np.zeros((a.shape[0] + 1, a.shape[1] + 1) + a.shape[2:])
    t[1:, 1:] = a.cumsum(0).cumsum(1)
    return t


def _points(g, cfg, cap):
    """Pixels that stand out from their 7x7 neighbourhood and are a 3x3 extreme: a tiny blob
    each. Capped at a quarter of the blob budget."""
    grey = g.mean(2)
    H, W = grey.shape
    if H < 7 or W < 7:
        return Blobs.empty()

    def box_mean(r):
        """Mean over the (2r+1)^2 window around every pixel, edges repeated."""
        t = _integral(np.pad(grey, r, mode="edge"))
        k = 2 * r + 1
        return (t[k:k + H, k:k + W] - t[:H, k:k + W] - t[k:k + H, :W] + t[:H, :W]) / (k * k)

    a = np.abs(grey - box_mean(3))
    level = max(0.04, 6 * 1.4826 * np.median(a))
    padded = np.pad(a, 1, mode="constant")
    is_max = np.ones_like(a, bool)
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            if dx or dy:
                is_max &= a >= padded[1 + dy:1 + dy + H, 1 + dx:1 + dx + W]
    # an isolated point, not a line: its 8 neighbours sit well away from it
    ring = (box_mean(1) * 9 - grey) / 8
    ys, xs = np.nonzero(is_max & (a > level) & (np.abs(grey - ring) > 0.5 * a))
    if len(ys) == 0:
        return Blobs.empty()
    order = np.argsort(-a[ys, xs])[:cap // 4]
    ys, xs = ys[order], xs[order]
    s = np.full(len(xs), cfg.point_sigma)
    return Blobs(xs + 0.5, ys + 0.5, s, s, np.zeros(len(xs)), g[ys, xs])


def _layout(g, threshold, budget, cfg, base):
    """Quadtree over the goal: split the square with the largest excess error until every
    square's one-blob error (its variance, summed) is under threshold * area, or the budget
    is spent. At detail levels squares whose whole energy is under half the threshold are
    dropped: no blob beats zero there."""
    H, W = g.shape[:2]
    if budget <= 0:
        return Blobs.empty()
    s1, s2 = _integral(g), _integral(g * g)

    def sse(x0, y0, x1, y1):
        area = (x1 - x0) * (y1 - y0)
        s = _box_sum(s1, x0, y0, x1, y1)
        return float((_box_sum(s2, x0, y0, x1, y1) - s * s / area).sum()), area

    heap, final, serial = [], [], 0

    def push(x0, y0, x1, y1):
        nonlocal serial
        e, area = sse(x0, y0, x1, y1)
        heapq.heappush(heap, (-(e - threshold * area), serial, x0, y0, x1, y1))
        serial += 1

    G = cfg.grid
    for y0 in range(0, H, G):
        for x0 in range(0, W, G):
            push(x0, y0, min(W, x0 + G), min(H, y0 + G))
    while heap and heap[0][0] < 0 and len(heap) + len(final) + 3 <= budget:
        _, _, x0, y0, x1, y1 = heapq.heappop(heap)
        if x1 - x0 < 2 and y1 - y0 < 2:
            final.append((x0, y0, x1, y1))
            continue
        xs = [x0, (x0 + x1) // 2, x1] if x1 - x0 >= 2 else [x0, x1]
        ys = [y0, (y0 + y1) // 2, y1] if y1 - y0 >= 2 else [y0, y1]
        for i in range(len(ys) - 1):
            for j in range(len(xs) - 1):
                push(xs[j], ys[i], xs[j + 1], ys[i + 1])
    squares = final + [(x0, y0, x1, y1) for _, _, x0, y0, x1, y1 in heap]
    squares = np.array(squares, np.float64).reshape(-1, 4)
    x0, y0, x1, y1 = squares.T.astype(np.int64)

    if not base:
        energy = (_box_sum(s2, x0, y0, x1, y1)).sum(-1)
        keep = energy > 0.5 * threshold * (x1 - x0) * (y1 - y0)
        x0, y0, x1, y1 = x0[keep], y0[keep], x1[keep], y1[keep]
    if len(x0) == 0:
        return Blobs.empty()

    # structure tensor per square: which way the colour changes, and how clearly
    grey = g.mean(2)
    gy, gx = np.gradient(grey) if min(H, W) > 1 else (np.zeros_like(grey), np.zeros_like(grey))
    jxx, jyy, jxy = (_box_sum(_integral(f), x0, y0, x1, y1) for f in (gx * gx, gy * gy, gx * gy))
    across = 0.5 * np.arctan2(2 * jxy, jxx - jyy)
    coherence = np.sqrt((jxx - jyy) ** 2 + 4 * jxy * jxy) / (jxx + jyy + 1e-9)
    stretch = 1.0 + 1.5 * coherence
    size = cfg.spread * np.sqrt((x1 - x0) * (y1 - y0))
    # first axis across the edge (thin), second along it (long)
    sx = np.clip(size / stretch, SIGMA_MIN, cfg.sigma_cap)
    sy = np.clip(size * stretch, SIGMA_MIN, cfg.sigma_cap)
    return Blobs((x0 + x1) / 2.0, (y0 + y1) / 2.0, sx, sy, np.mod(across, math.pi),
                 np.zeros((len(x0), 3)))
