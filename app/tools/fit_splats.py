#!/usr/bin/env python3
"""
Fit Gaussian splats to every unit of a prepared raster ladder, for the splat image method.

The server calls this once per image, from SplatMethod.prepare. It reads the rasterised
levels (the tiles the ladder method writes) and produces one .splat file per unit: a small
header and then one 11-byte record per blob.

Two things matter beyond the fitting itself:

  seams      each unit is fitted on a crop padded by --margin pixels taken from its
             neighbours, and keeps every blob of that fit, including those centred outside
             it, so it can reproduce its own edge. Drawing is clipped to the unit's own
             rectangle, so a neighbour's version of the shared edge never adds on top.
  order      units are fitted coarsest level first, and each finished level is announced on
             stdout, so the server can serve an image while the finer levels are still being
             fitted - the viewer simply shows the coarsest data it has.

Record layout, 11 bytes, matching web/viewer/splats.js:

  0  dx      uint16   x of the centre, from -MARGIN to (w-1)+MARGIN
  2  dy      uint16   y of the centre
  4  sx      uint8    log-quantised radius across, SIGMA_MIN..SIGMA_MAX
  5  sy      uint8    log-quantised radius along
  6  theta   uint8    rotation, 0..pi
  7  r,g,b   uint8x3  colour, signed around 128, scaled by amp
  10 amp     uint8    log-quantised amplitude, AMP_MIN..AMP_MAX

  python3 tools/fit_splats.py RASTER_DIR OUT_DIR --splats 4000 --iters 1000
"""

import argparse
import math
import os
import struct
import sys
import time

import numpy as np
import torch
from PIL import Image

SIGMA_MIN, SIGMA_MAX = 0.6, 64.0
AMP_MIN, AMP_MAX = 1e-4, 4.0
POS_MARGIN = 64.0            # encoded centres may sit this far outside the unit
CUTOFF = 3.0                 # a blob reaches CUTOFF sigma ...
MIN_REACH = 8.0              # ... but never less than this many unit pixels - both must match
                             # web/viewer/renderers.js
RECORD = 11
MAGIC = b"SPL1"              # additive blobs
MAGIC_NORMALIZED = b"SPLN"   # blobs averaged by their weight


def device():
    if torch.backends.mps.is_available():
        return torch.device("mps")
    if torch.cuda.is_available():
        return torch.device("cuda")
    return torch.device("cpu")


def sigma_limit(K):
    """The widest a blob may be so that, cut off at CUTOFF sigma, it still fits a KxK patch.
    The encoder clamps to the same value, so the browser never draws a blob wider than the
    one that was fitted."""
    return (K // 2 - 0.5) / CUTOFF


def render(xy, log_s, theta, color, batch, H, W, K, normalized=False):
    """Rasteriser for a batch of units: every splat writes a square patch around its centre.

    xy, log_s, theta, color describe all the splats of the whole batch at once; `batch` says
    which unit each belongs to, so one pass over the GPU covers many units.

    Additive by default: a pixel is the sum of the blobs' light, so overlapping blobs in a
    bright area can overshoot white. normalized=True divides by the summed blob weight
    instead - each pixel is a weighted average of the blobs covering it - which cannot
    overshoot and measured +2.2 dB at the same bytes.

    A blob reaches CUTOFF sigma or MIN_REACH pixels, whichever is further; K is the patch it
    is written into, and bounds how wide a blob may grow. Every blob uses the same K: grouping
    blobs by size into smaller patches was tried and on Apple's GPU backend it made fitting
    6x slower and ran out of memory, because the group sizes change every step and the
    backend keeps a buffer for every shape it has seen.
    """
    N = xy.shape[0]
    dev = xy.device
    B = int(batch.max().item()) + 1 if N else 1
    sigma = log_s.exp().clamp(SIGMA_MIN, sigma_limit(K))
    c, w = _splat(xy, sigma, theta, color, batch, H, W, K)
    canvas = torch.zeros(3, B * H * W, device=dev).index_add(1, c[0], c[1])
    if normalized:
        total = torch.zeros(1, B * H * W, device=dev).index_add(1, w[0], w[1])
        canvas = canvas / total.clamp(min=1e-4)
    return canvas.view(3, B, H, W).permute(1, 0, 2, 3)


def _splat(xy, sigma, theta, color, batch, H, W, K):
    """One group of blobs, each written into a KxK patch. Returns (indices, colour) and
    (indices, weight) ready to be added into the batch canvas."""
    N = xy.shape[0]
    R = K // 2
    dev = xy.device
    base = xy.detach().round().long()
    offs = torch.arange(-R, R + 1, device=dev)
    gy, gx = torch.meshgrid(offs, offs, indexing="ij")
    px = base[:, 0].view(N, 1, 1) + gx.view(1, K, K)
    py = base[:, 1].view(N, 1, 1) + gy.view(1, K, K)
    dx = px.float() - xy[:, 0].view(N, 1, 1)
    dy = py.float() - xy[:, 1].view(N, 1, 1)

    sx = sigma[:, 0].view(N, 1, 1)
    sy = sigma[:, 1].view(N, 1, 1)
    cos, sin = torch.cos(theta).view(N, 1, 1), torch.sin(theta).view(N, 1, 1)
    u = (dx * cos + dy * sin) / sx
    v = (-dx * sin + dy * cos) / sy
    r2 = u * u + v * v
    # A blob reaches CUTOFF sigma or MIN_REACH pixels, whichever is further, and the browser
    # stops at exactly the same place. Both halves matter. Drawing less than the fitter
    # fitted leaves holes on screen; and a cutoff so tight that some pixel is reached by no
    # blob at all gives that pixel no gradient, so the fit can never repair it. The minimum
    # reach keeps every pixel within the faint tail of some blob.
    reach = torch.clamp(CUTOFF * torch.maximum(sx, sy), min=MIN_REACH)
    weight = torch.exp(-0.5 * r2) * ((dx * dx + dy * dy) <= reach * reach).float()

    inside = ((px >= 0) & (px < W) & (py >= 0) & (py < H)).float()
    weight = weight * inside
    contribution = weight.unsqueeze(1) * color.view(N, 3, 1, 1)

    flat = (batch.view(N, 1, 1) * (H * W)
            + py.clamp(0, H - 1) * W + px.clamp(0, W - 1)).reshape(-1)
    return ((flat, contribution.permute(1, 0, 2, 3).reshape(3, -1)),
            (flat, weight.reshape(1, -1)))


HOLE = 1e-3          # total blob weight below this counts as uncovered (a pixel renders wrong below 1e-4)
REPAIR_ROUNDS = 2
REPAIR_ITERS = 150


def fit_batch(targets, n_splats, iters, K, log_every=0, normalized=False, init=None):
    """Fit `n_splats` splats to each unit in `targets` (B, 3, H, W).

    init, if given, is one entry per unit: blobs to start from (from the level above),
    as a dict of xy, log_s, theta, color tensors in this unit's crop coordinates, or None.
    They replace the first of the unit's randomly placed blobs.

    Normalised fits finish with repair rounds: any pixel no blob covers well gets a small
    blob of its own colour, then everything is fine-tuned briefly. Without this a pixel that
    no blob reaches has no gradient, can never be fixed by the optimiser, and shows as a
    black speck in the viewer.

    Returns xy, log_s, theta, color, batch and how many repair blobs were added.
    """
    dev = targets.device
    B, _, H, W = targets.shape
    N = B * n_splats

    grey = targets.mean(1)
    edges = torch.zeros_like(grey)
    edges[:, :, :-1] += (grey[:, :, 1:] - grey[:, :, :-1]).abs()
    edges[:, :-1, :] += (grey[:, 1:, :] - grey[:, :-1, :]).abs()
    weights = (edges + edges.mean() * 0.25 + 1e-8).reshape(B, -1)
    picks = torch.multinomial((weights / weights.sum(1, keepdim=True)).cpu(),
                              n_splats, replacement=True).to(dev)      # (B, n) pixel indices

    batch = torch.arange(B, device=dev).repeat_interleave(n_splats)
    flat_picks = picks.reshape(-1)
    xy = torch.stack([(flat_picks % W).float(), (flat_picks // W).float()], 1)
    xy = xy + torch.rand(N, 2, device=dev) - 0.5

    coverage = 1.5
    sigma0 = min(max(math.sqrt(W * H * coverage / (n_splats * 2 * math.pi)), 0.8), K / 6.0)
    if normalized:
        coverage = 1.0              # an average needs the true colour, not a share of it
    log_s = torch.log(torch.full((N, 2), sigma0, device=dev))
    theta = torch.zeros(N, device=dev)
    flat_targets = targets.permute(1, 0, 2, 3).reshape(3, -1)
    sample_index = batch * (H * W) + flat_picks
    color = flat_targets[:, sample_index].t().contiguous() / coverage

    # Start from the level above where we have it: those blobs already describe this area.
    for b, start in enumerate(init or []):
        if not start:
            continue
        k = min(n_splats, start["xy"].shape[0])
        pick = torch.randperm(start["xy"].shape[0], device=dev)[:k]
        rows = slice(b * n_splats, b * n_splats + k)
        xy[rows] = start["xy"][pick]
        log_s[rows] = start["log_s"][pick]
        theta[rows] = start["theta"][pick]
        color[rows] = start["color"][pick]

    params = [xy, log_s, theta, color]
    _optimise(params, batch, targets, iters, K, normalized, 1.0, log_every)
    return _repair(params, batch, targets, K, normalized)


def _repair(params, batch, targets, K, normalized):
    """Give every pixel no blob covers well a small blob of its own colour, then fine-tune.
    Returns xy, log_s, theta, color, batch and how many blobs were added."""
    dev = targets.device
    repaired = 0
    if normalized:
        for _ in range(REPAIR_ROUNDS):
            seeds = _holes(params, batch, targets, K)
            if seeds is None:
                break
            b, y, x = seeds
            repaired += len(b)
            new_xy = torch.stack([x.float(), y.float()], 1)
            params = [torch.cat([params[0].detach(), new_xy]),
                      torch.cat([params[1].detach(), torch.full((len(b), 2), math.log(1.5), device=dev)]),
                      torch.cat([params[2].detach(), torch.zeros(len(b), device=dev)]),
                      torch.cat([params[3].detach(), targets[b, :, y, x]])]
            batch = torch.cat([batch, b])
            _optimise(params, batch, targets, REPAIR_ITERS, K, normalized, 0.3, 0)

    xy, log_s, theta, color = (p.detach() for p in params)
    return xy, log_s, theta, color, batch, repaired


# ---------------------------------------------------------------------------------------
# Blobs by formula instead of by trial and error
# ---------------------------------------------------------------------------------------

def fit_formula(target, n_splats, polish, K, normalized):
    """Place and shape blobs by formula, solve their colours exactly, optionally polish.

    Placement: the unit starts as a grid of GRID-pixel squares and the square whose colours
    vary most is split in four, again and again, until there is one square per blob - so
    busy areas end up with many small blobs and flat areas with a few large ones. Each blob
    sits in its square, stretched along the local edge (the structure tensor of the pixel
    gradients says which way that is and how strongly).

    Colours: with positions and shapes fixed, every pixel is a known weighted average of the
    blobs' colours, so the best colours are the solution of a linear least-squares problem,
    solved by conjugate gradients - no guessing.

    `polish` rounds of the ordinary optimiser can follow, starting from this answer.
    """
    dev = target.device
    _, H, W = target.shape
    xy, log_s, theta = _formula_layout(target, n_splats, K)
    color = _solve_colours(target, xy, log_s.exp(), theta, K, normalized)
    batch = torch.zeros(xy.shape[0], dtype=torch.long, device=dev)
    params = [xy, log_s, theta, color]
    targets = target.unsqueeze(0)
    if polish:
        _optimise(params, batch, targets, polish, K, normalized, 0.5, 0)
    return _repair(params, batch, targets, K, normalized)


GRID = 9            # the quadtree starts from squares this big
SPREAD = 0.45       # a blob's radius, as a fraction of its square's side


def _formula_layout(target, n, K):
    img = target.permute(1, 2, 0).cpu().numpy().astype(np.float64)
    H, W = img.shape[:2]
    table = np.zeros((H + 1, W + 1, 3))
    table[1:, 1:] = img.cumsum(0).cumsum(1)
    squares = np.zeros((H + 1, W + 1, 3))
    squares[1:, 1:] = (img ** 2).cumsum(0).cumsum(1)

    def box(t, x0, y0, x1, y1):
        return t[y1, x1] - t[y0, x1] - t[y1, x0] + t[y0, x0]

    def variation(x0, y0, x1, y1):
        area = (x1 - x0) * (y1 - y0)
        s = box(table, x0, y0, x1, y1)
        return float((box(squares, x0, y0, x1, y1) - s * s / area).sum())

    import heapq
    heap, final, serial = [], [], 0
    for y0 in range(0, H, GRID):
        for x0 in range(0, W, GRID):
            x1, y1 = min(W, x0 + GRID), min(H, y0 + GRID)
            heap.append((-variation(x0, y0, x1, y1), serial, x0, y0, x1, y1))
            serial += 1
    heapq.heapify(heap)
    while heap and len(heap) + len(final) < n:
        _, _, x0, y0, x1, y1 = heapq.heappop(heap)
        if x1 - x0 < 2 and y1 - y0 < 2:
            final.append((x0, y0, x1, y1))            # a single pixel: cannot split further
            continue
        xs = [x0, (x0 + x1) // 2, x1] if x1 - x0 >= 2 else [x0, x1]
        ys = [y0, (y0 + y1) // 2, y1] if y1 - y0 >= 2 else [y0, y1]
        for i in range(len(ys) - 1):
            for j in range(len(xs) - 1):
                heapq.heappush(heap, (-variation(xs[j], ys[i], xs[j + 1], ys[i + 1]), serial,
                                      xs[j], ys[i], xs[j + 1], ys[i + 1]))
                serial += 1
    final += [(x0, y0, x1, y1) for _, _, x0, y0, x1, y1 in heap]

    # Structure tensor: which way the edges run inside each square, and how clearly.
    grey = img.mean(axis=2)
    gy, gx = np.gradient(grey)
    tensors = []
    for field in (gx * gx, gy * gy, gx * gy):
        t = np.zeros((H + 1, W + 1))
        t[1:, 1:] = field.cumsum(0).cumsum(1)
        tensors.append(t)

    def sum2(t, x0, y0, x1, y1):
        return t[y1, x1] - t[y0, x1] - t[y1, x0] + t[y0, x0]

    xy, sig, ang = [], [], []
    limit = sigma_limit(K)
    for x0, y0, x1, y1 in final:
        jxx, jyy, jxy = (sum2(t, x0, y0, x1, y1) for t in tensors)
        across = 0.5 * math.atan2(2 * jxy, jxx - jyy)        # direction the colour changes most
        coherence = math.sqrt((jxx - jyy) ** 2 + 4 * jxy * jxy) / (jxx + jyy + 1e-9)
        stretch = 1.0 + 1.5 * coherence
        size = SPREAD * math.sqrt((x1 - x0) * (y1 - y0))
        xy.append(((x0 + x1 - 1) / 2.0, (y0 + y1 - 1) / 2.0))
        # the blob's first axis points across the edge (thin), its second along it (long)
        sig.append((min(limit, max(SIGMA_MIN, size / stretch)), min(limit, max(SIGMA_MIN, size * stretch))))
        ang.append(across % math.pi)

    dev = target.device
    as_tensor = lambda a: torch.tensor(a, dtype=torch.float32, device=dev)  # noqa: E731
    return as_tensor(xy), torch.log(as_tensor(sig)), as_tensor(ang)


def _solve_colours(target, xy, sigma, theta, K, normalized, steps=60, damping=1e-4):
    """Least-squares blob colours for fixed blobs, by conjugate gradients on A^T A c = A^T t,
    where A maps blob colours to pixels (a weighted average when normalised, a sum if not)."""
    _, H, W = target.shape
    N = xy.shape[0]
    batch = torch.zeros(N, dtype=torch.long, device=xy.device)
    with torch.no_grad():
        (flat, _), (_, w) = _splat(xy, sigma, theta, torch.zeros(N, 3, device=xy.device), batch, H, W, K)
        w = w.reshape(-1)
        if normalized:
            total = torch.zeros(H * W, device=xy.device).index_add(0, flat, w)
            w = w / total.clamp(min=1e-4)[flat]
        t = target.reshape(3, -1)

        def forward(c):                       # blob colours (N,3) -> image (3, H*W)
            spread = (w.view(N, -1).unsqueeze(1) * c.view(N, 3, 1)).permute(1, 0, 2).reshape(3, -1)
            return torch.zeros(3, H * W, device=xy.device).index_add(1, flat, spread)

        def backward(r):                      # image residual (3, H*W) -> per-blob (N,3)
            return (r[:, flat].view(3, N, -1) * w.view(1, N, -1)).sum(-1).t()

        def normal(c):
            return backward(forward(c)) + damping * c

        # start from each blob's local colour, then conjugate gradients
        centre = xy.round().long()
        c = t[:, (centre[:, 1].clamp(0, H - 1) * W + centre[:, 0].clamp(0, W - 1))].t().clone()
        r = backward(t) - normal(c)
        p = r.clone()
        rs = (r * r).sum(0)
        for _ in range(steps):
            q = normal(p)
            alpha = rs / (p * q).sum(0).clamp(min=1e-12)
            c = c + alpha * p
            r = r - alpha * q
            rs_new = (r * r).sum(0)
            if float(rs_new.max()) < 1e-10:
                break
            p = r + (rs_new / rs.clamp(min=1e-12)) * p
            rs = rs_new
    return c


def _optimise(params, batch, targets, iters, K, normalized, lr_scale, log_every):
    """Adam over every blob parameter, with a cosine schedule."""
    _, _, H, W = targets.shape
    for t in params:
        t.requires_grad_(True)
    xy, log_s, theta, color = params
    opt = torch.optim.Adam([
        {"params": [xy], "lr": 0.35 * lr_scale},
        {"params": [log_s], "lr": 0.012 * lr_scale},
        {"params": [theta], "lr": 0.012 * lr_scale},
        {"params": [color], "lr": 0.012 * lr_scale},
    ])
    schedule = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=max(1, iters))
    for step in range(iters):
        opt.zero_grad(set_to_none=True)
        image = render(xy, log_s, theta, color, batch, H, W, K, normalized)
        loss = torch.mean((image.clamp(0, 1) - targets) ** 2)
        loss.backward()
        opt.step()
        schedule.step()
        if log_every and step % log_every == 0:
            print(f"    step {step} mse {loss.item():.5f}", flush=True)


def _holes(params, batch, targets, K, cell=3):
    """Pixels no blob covers well, one per cell x cell block: where repair blobs go."""
    B, _, H, W = targets.shape
    with torch.no_grad():
        xy, log_s, theta, _ = params
        sigma = log_s.exp().clamp(SIGMA_MIN, sigma_limit(K))
        _, w = _splat(xy, sigma, theta, torch.zeros_like(xy[:, :1]).expand(-1, 3), batch, H, W, K)
        total = torch.zeros(B * H * W, device=xy.device).index_add(0, w[0], w[1].reshape(-1))
        found = torch.nonzero(total.view(B, H, W) < HOLE).cpu()
    if len(found) == 0:
        return None
    seen, keep = set(), []
    for b, y, x in found.tolist():
        key = (b, y // cell, x // cell)
        if key not in seen:
            seen.add(key)
            keep.append((b, y, x))
    t = torch.tensor(keep, device=xy.device)
    return t[:, 0], t[:, 1], t[:, 2]


def quantise(xy, log_s, theta, color, W, H, sigma_max=SIGMA_MAX):
    """Round every field to what the wire carries, and return both codes and values."""
    lo_x, hi_x = -POS_MARGIN, (W - 1) + POS_MARGIN
    lo_y, hi_y = -POS_MARGIN, (H - 1) + POS_MARGIN
    qx = torch.round((xy[:, 0].clamp(lo_x, hi_x) - lo_x) * 65535 / (hi_x - lo_x))
    qy = torch.round((xy[:, 1].clamp(lo_y, hi_y) - lo_y) * 65535 / (hi_y - lo_y))

    def log_code(v, lo, hi):
        v = v.clamp(lo, hi)
        return torch.round(255 * (torch.log(v) - math.log(lo)) / (math.log(hi) - math.log(lo)))

    qsx = log_code(log_s[:, 0].exp().clamp(max=sigma_max), SIGMA_MIN, SIGMA_MAX)
    qsy = log_code(log_s[:, 1].exp().clamp(max=sigma_max), SIGMA_MIN, SIGMA_MAX)
    turns = torch.floor(theta / math.pi)
    qtheta = torch.round((theta - turns * math.pi) * 255 / math.pi).clamp(0, 255)
    amp = color.abs().max(dim=1).values.clamp(min=AMP_MIN)
    qamp = log_code(amp, AMP_MIN, AMP_MAX)
    decoded_amp = torch.exp(math.log(AMP_MIN) + qamp / 255 * (math.log(AMP_MAX) - math.log(AMP_MIN)))
    qcolor = torch.round(127 * color / amp.view(-1, 1)).clamp(-127, 127)
    return torch.stack([qx, qy, qsx, qsy, qtheta,
                        qcolor[:, 0], qcolor[:, 1], qcolor[:, 2], qamp], 1), decoded_amp


def read_splats(path):
    """A .splat file back into blob parameters: the inverse of quantise() and encode()."""
    raw = open(path, "rb").read()
    if raw[:4] not in (MAGIC, MAGIC_NORMALIZED):
        raise ValueError(f"{path} is not a splat file")
    n, w, h = struct.unpack(">HHH", raw[4:10])
    body = np.frombuffer(raw, dtype=np.uint8, count=n * RECORD, offset=10).reshape(n, RECORD)
    lo_x, hi_x = -POS_MARGIN, (w - 1) + POS_MARGIN
    lo_y, hi_y = -POS_MARGIN, (h - 1) + POS_MARGIN

    def from_log(code, lo, hi):
        return np.exp(math.log(lo) + code / 255.0 * (math.log(hi) - math.log(lo)))

    amp = from_log(body[:, 10].astype(np.float64), AMP_MIN, AMP_MAX)
    return {
        "x": lo_x + (((body[:, 0].astype(np.int32) << 8) | body[:, 1]) * (hi_x - lo_x) / 65535.0),
        "y": lo_y + (((body[:, 2].astype(np.int32) << 8) | body[:, 3]) * (hi_y - lo_y) / 65535.0),
        "sx": from_log(body[:, 4].astype(np.float64), SIGMA_MIN, SIGMA_MAX),
        "sy": from_log(body[:, 5].astype(np.float64), SIGMA_MIN, SIGMA_MAX),
        "theta": body[:, 6].astype(np.float64) * math.pi / 255.0,
        "colour": body[:, 7:10].astype(np.int8).astype(np.float64) / 127.0 * amp[:, None],
        "w": w, "h": h, "normalized": raw[:4] == MAGIC_NORMALIZED,
    }


def parent_blobs(args, raster, level, x, y, w, h, dev):
    """The already-fitted blobs of the level above that cover this unit's padded crop,
    scaled into this unit's coordinates - a far better start than random placement.

    Level L+1 is `ratio` times smaller, so its pixel i (sampled at i) sits where level L
    samples (i + 0.5) * ratio - 0.5, and its blobs are `ratio` times wider here.
    """
    parent = level + 1
    if not args.parent_init or parent > raster.max_level:
        return None
    r, T, m = raster.ratio, raster.tile, args.margin
    x0, y0 = x * T - m, y * T - m                      # crop origin, in this level's pixels
    x1, y1 = x * T + w + m, y * T + h + m
    cols, rows = raster.grid(parent)
    found = []
    for py in range(max(0, int(y0 / r // T)), min(rows - 1, int(y1 / r // T)) + 1):
        for px in range(max(0, int(x0 / r // T)), min(cols - 1, int(x1 / r // T)) + 1):
            path = os.path.join(args.out, str(parent), f"{px}_{py}.splat")
            if not os.path.exists(path):
                continue
            s = read_splats(path)
            if not s["normalized"]:
                return None                              # a different kind of blob; start fresh
            cx = (px * T + s["x"] + 0.5) * r - 0.5 - x0
            cy = (py * T + s["y"] + 0.5) * r - 0.5 - y0
            inside = (cx >= 0) & (cx < x1 - x0) & (cy >= 0) & (cy < y1 - y0)
            found.append((cx[inside], cy[inside], s["sx"][inside] * r, s["sy"][inside] * r,
                          s["theta"][inside], s["colour"][inside]))
    if not found:
        return None
    cx, cy, sx, sy, theta, colour = (np.concatenate(parts) for parts in zip(*found))
    as_tensor = lambda a: torch.tensor(a, dtype=torch.float32, device=dev)  # noqa: E731
    return {"xy": as_tensor(np.stack([cx, cy], 1)),
            "log_s": torch.log(as_tensor(np.stack([sx, sy], 1))),
            "theta": as_tensor(theta), "color": as_tensor(colour)}


def encode(codes, w, h, normalized=False):
    """Pack quantised splats into the .splat file the client decodes. The magic says how to
    draw them: SPL1 additive, SPLN normalised."""
    n = codes.shape[0]
    out = bytearray((MAGIC_NORMALIZED if normalized else MAGIC) + struct.pack(">HHH", n, w, h))
    c = codes.cpu().numpy().astype(np.int32)
    body = bytearray(n * RECORD)
    for i in range(n):
        at = i * RECORD
        body[at] = (c[i, 0] >> 8) & 0xFF
        body[at + 1] = c[i, 0] & 0xFF
        body[at + 2] = (c[i, 1] >> 8) & 0xFF
        body[at + 3] = c[i, 1] & 0xFF
        body[at + 4] = c[i, 2] & 0xFF
        body[at + 5] = c[i, 3] & 0xFF
        body[at + 6] = c[i, 4] & 0xFF
        body[at + 7] = c[i, 5] & 0xFF          # signed colours ride as two's complement
        body[at + 8] = c[i, 6] & 0xFF
        body[at + 9] = c[i, 7] & 0xFF
        body[at + 10] = c[i, 8] & 0xFF
    out += body
    return bytes(out)


class Raster:
    """The prepared ladder on disk, read as padded crops."""

    def __init__(self, path):
        meta = {}
        with open(os.path.join(path, "meta.properties")) as f:
            for line in f:
                if "=" in line and not line.startswith("#"):
                    k, v = line.strip().split("=", 1)
                    meta[k] = v
        self.path = path
        self.width = int(meta["width"])
        self.height = int(meta["height"])
        self.tile = int(meta["tileSize"])
        self.ratio = float(meta["ratio"])
        self.max_level = int(meta["maxLevel"])
        self._cache = {}

    def level_size(self, level):
        s = self.ratio ** level
        return math.ceil(self.width / s), math.ceil(self.height / s)

    def grid(self, level):
        w, h = self.level_size(level)
        return (w + self.tile - 1) // self.tile, (h + self.tile - 1) // self.tile

    def tile_pixels(self, level, x, y):
        key = (level, x, y)
        if key not in self._cache:
            p = os.path.join(self.path, str(level), f"{x}_{y}.jpg")
            if not os.path.exists(p):
                return None
            if len(self._cache) > 64:
                self._cache.clear()
            self._cache[key] = np.asarray(Image.open(p).convert("RGB"), dtype=np.uint8)
        return self._cache[key]

    def padded(self, level, x, y, margin):
        """The unit's pixels with `margin` pixels of its neighbours around it."""
        own = self.tile_pixels(level, x, y)
        if own is None:
            return None, 0, 0
        h, w = own.shape[:2]
        out = np.zeros((h + 2 * margin, w + 2 * margin, 3), np.uint8)
        out[margin:margin + h, margin:margin + w] = own
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                if dx == 0 and dy == 0:
                    continue
                neighbour = self.tile_pixels(level, x + dx, y + dy)
                if neighbour is None:
                    continue
                nh, nw = neighbour.shape[:2]
                sx0 = 0 if dx <= 0 else 0
                # place the neighbour's nearest strip into the padding
                if dx == -1:
                    src_x, dst_x, take_w = max(0, nw - margin), 0, min(margin, nw)
                elif dx == 1:
                    src_x, dst_x, take_w = 0, margin + w, min(margin, nw)
                else:
                    src_x, dst_x, take_w = 0, margin, min(w, nw)
                if dy == -1:
                    src_y, dst_y, take_h = max(0, nh - margin), 0, min(margin, nh)
                elif dy == 1:
                    src_y, dst_y, take_h = 0, margin + h, min(margin, nh)
                else:
                    src_y, dst_y, take_h = 0, margin, min(h, nh)
                del sx0
                out[dst_y:dst_y + take_h, dst_x:dst_x + take_w] = \
                    neighbour[src_y:src_y + take_h, src_x:src_x + take_w]
        # edges of the image have no neighbour: repeat the unit's own border outward
        if margin:
            out[:margin, margin:margin + w] = np.where(
                out[:margin, margin:margin + w].any(axis=2, keepdims=True), out[:margin, margin:margin + w], own[:1])
            out[margin + h:, margin:margin + w] = np.where(
                out[margin + h:, margin:margin + w].any(axis=2, keepdims=True),
                out[margin + h:, margin:margin + w], own[-1:])
        return out, w, h


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("raster")
    ap.add_argument("out")
    ap.add_argument("--splats", type=int, default=4000, help="per full unit, before padding")
    ap.add_argument("--iters", type=int, default=1000)
    ap.add_argument("--patch", type=int, default=33)
    ap.add_argument("--margin", type=int, default=16)
    ap.add_argument("--batch", type=int, default=8, help="units fitted together on the GPU")
    ap.add_argument("--levels", default=None, help="only these levels, e.g. 14,13,12")
    ap.add_argument("--units", default=None,
                    help="only these units, e.g. 7/0_0,3/2_3 (for trying settings on a sample)")
    ap.add_argument("--normalized", action="store_true",
                    help="blobs are averaged by weight instead of added (no overshoot, +2.2 dB)")
    ap.add_argument("--adaptive", action="store_true",
                    help="give busy units more blobs and flat ones fewer, same average")
    ap.add_argument("--parent-init", action="store_true",
                    help="start each unit from the fitted blobs of the level above")
    ap.add_argument("--child-iters", type=int, default=None,
                    help="iterations for a unit that started from the level above")
    ap.add_argument("--formula", action="store_true",
                    help="place blobs by quadtree and solve colours exactly instead of fitting")
    ap.add_argument("--polish", type=int, default=0,
                    help="with --formula: rounds of the optimiser afterwards (0 = formula only)")
    args = ap.parse_args()

    raster = Raster(args.raster)
    os.makedirs(args.out, exist_ok=True)
    dev = device()
    only = None
    if args.units:
        only = set()
        for spec in args.units.split(","):
            level, name = spec.split("/")
            x, y = name.split("_")
            only.add((int(level), int(x), int(y)))
        levels = sorted({u[0] for u in only}, reverse=True)
    else:
        levels = ([int(v) for v in args.levels.split(",")] if args.levels
                  else list(range(raster.max_level, -1, -1)))      # coarsest first: viewable early
    if args.adaptive or args.formula:
        args.batch = 1          # every unit gets its own blob count

    def wanted(level, x, y):
        return only is None or (level, x, y) in only

    total = sum(1 for level in levels for y in range(raster.grid(level)[1])
                for x in range(raster.grid(level)[0]) if wanted(level, x, y))
    print(f"device {dev}, {total} units over levels {levels[0]}..{levels[-1]}, "
          f"{args.splats} splats per unit on average, {args.iters} iterations, "
          f"{'normalised' if args.normalized else 'additive'}, "
          f"{'adaptive' if args.adaptive else 'uniform'} budget", flush=True)

    done = 0
    started = time.time()
    for level in levels:
        cols, rows = raster.grid(level)
        budget = detail_budget(raster, level) if args.adaptive else {}
        os.makedirs(os.path.join(args.out, str(level)), exist_ok=True)
        pending = []      # (x, y, padded pixels, w, h)
        for y in range(rows):
            for x in range(cols):
                if not wanted(level, x, y):
                    continue
                target_path = os.path.join(args.out, str(level), f"{x}_{y}.splat")
                if os.path.exists(target_path):
                    done += 1
                    continue
                pixels, w, h = raster.padded(level, x, y, args.margin)
                if pixels is None:
                    raise SystemExit(f"missing raster tile {level}/{x}_{y}.jpg in {raster.path}")
                pending.append((x, y, pixels, w, h))
                # fit units of the same size together
                same = [p for p in pending if p[2].shape == pending[0][2].shape]
                if len(same) >= args.batch:
                    done += flush(same, level, raster, args, dev, done, total, started, budget)
                    pending = [p for p in pending if p not in same]
        while pending:
            same = [p for p in pending if p[2].shape == pending[0][2].shape]
            done += flush(same, level, raster, args, dev, done, total, started, budget)
            pending = [p for p in pending if p not in same]
        print(f"level {level} done", flush=True)
    print(f"all done in {time.time() - started:.0f}s", flush=True)


def detail_budget(raster, level):
    """How many blobs each unit of a level deserves, relative to the level's average.

    A unit's JPEG size per pixel is a free measure of how much detail it holds. Blobs are
    shared out in proportion to that detail (softened by a power below one, so a flat unit
    still gets enough to be smooth), with the average held at 1 so the total bytes match a
    uniform budget.
    """
    cols, rows = raster.grid(level)
    density = {}
    for y in range(rows):
        for x in range(cols):
            p = os.path.join(raster.path, str(level), f"{x}_{y}.jpg")
            pixels = raster.tile_pixels(level, x, y)
            if pixels is None:
                continue
            density[(x, y)] = os.path.getsize(p) / (pixels.shape[0] * pixels.shape[1])
    weights = {k: d ** 0.7 for k, d in density.items()}
    mean = sum(weights.values()) / max(1, len(weights))
    return {k: min(3.0, max(0.25, w / mean)) for k, w in weights.items()}


def flush(units, level, raster, args, dev, done, total, started, budget=None):
    """Fit one batch of same-sized units and write their files."""
    stack = np.stack([u[2] for u in units])
    targets = torch.from_numpy(stack.astype(np.float32) / 255.0).permute(0, 3, 1, 2).to(dev)
    B, _, H, W = targets.shape
    # keep the density inside the unit at --splats by fitting the padded area proportionally
    share = budget.get((units[0][0], units[0][1]), 1.0) if budget else 1.0
    n = max(16, round(args.splats * share * (H * W) / (raster.tile * raster.tile)))
    unit_started = time.time()
    if args.formula:
        started_from_parent = False
        iters = args.polish
        xy, log_s, theta, color, batch, repaired = fit_formula(
            targets[0], n, args.polish, args.patch, args.normalized)
    else:
        init = [parent_blobs(args, raster, level, x, y, w, h, dev) for x, y, _, w, h in units]
        started_from_parent = any(i is not None for i in init)
        iters = args.child_iters if started_from_parent and args.child_iters else args.iters
        xy, log_s, theta, color, batch, repaired = fit_batch(
            targets, n, iters, args.patch, normalized=args.normalized, init=init)

    margin = args.margin
    for i, (x, y, _, w, h) in enumerate(units):
        mine = batch == i
        # Keep every blob of the padded fit, including those centred outside the unit: they
        # are what reproduces the unit's own edge. Drawing is clipped to the unit's rectangle,
        # so a neighbour's version of the same edge never adds on top of this one.
        sel_xy = xy[mine].clone()
        sel_xy[:, 0] -= margin
        sel_xy[:, 1] -= margin
        codes, _ = quantise(sel_xy, log_s[mine], theta[mine], color[mine], w, h,
                            sigma_limit(args.patch))
        with open(os.path.join(args.out, str(level), f"{x}_{y}.splat"), "wb") as f:
            f.write(encode(codes, w, h, args.normalized))

    if dev.type == "mps":
        torch.mps.empty_cache()
    elapsed = time.time() - started
    finished = done + len(units)
    rate = finished / elapsed if elapsed else 0
    detail = (f"{time.time() - unit_started:.0f}s, {iters} steps"
              f"{' from the level above' if started_from_parent else ''}"
              f"{f', {repaired} holes repaired' if repaired else ''}")
    print(f"unit {finished}/{total} level {level} ({rate:.2f}/s, "
          f"{(total - finished) / rate / 60:.0f} min left; {detail})" if rate
          else f"unit {finished}/{total}", flush=True)
    return len(units)


if __name__ == "__main__":
    sys.exit(main())
