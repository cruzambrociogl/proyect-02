#!/usr/bin/env python3
"""
Joint-optimisation 2D Gaussian splat fitter (PyTorch, Apple GPU via MPS).

History worth knowing, because each point cost a wrong conclusion first:
  * The Java fitter (tools/SplatFit.java) used greedy matching pursuit - place a splat,
    freeze it, repeat - and saturated at 26.26 dB. Optimising every parameter jointly
    reaches 35.8 dB at the same 4000 splats and bytes. The fitter was the problem.
  * Clamping splat centres to the tile cost 8.5 dB: optimisation legitimately parks
    ~3-5% of centres outside it. The position encoding covers +-POS_MARGIN px.
  * Densification only buys +0.1-0.4 dB in 2D: Adam already moves splats freely.

--gradient adds a per-splat colour ramp, so one splat can represent shading:
    colour(p) = c + g_u * (u / sx) + g_v * (v / sy)
where (u, v) are coordinates in the splat's own rotated frame. Normalising by sigma makes
the coefficients scale-free, so they quantise with a fixed range. The question is whether
the extra 3 or 6 bytes per splat pay for themselves - so compare at equal BYTES.

  python3 tools/splat_fit_torch.py IMAGE --x 1450 --y 600 --size 256 --splats 2588 --gradient uv
"""

import argparse
import math
import time
import zlib

import numpy as np
import torch
from PIL import Image

SIGMA_MIN, SIGMA_MAX = 0.6, 64.0
AMP_MIN, AMP_MAX = 1e-4, 4.0
POS_MARGIN = 64.0          # encoded position range extends this far beyond the tile
GRAD_RANGE = 2.0           # gradient coefficients encoded as +-GRAD_RANGE x amplitude
BASE_RECORD = 11           # dx16 dy16 | sx8 sy8 | theta8 | r8 g8 b8 | amp8
AXES = {"none": 0, "u": 1, "uv": 2}


def record_bytes(axes):
    return BASE_RECORD + 3 * axes      # one signed byte per channel per gradient axis


def device():
    if torch.backends.mps.is_available():
        return torch.device("mps")
    if torch.cuda.is_available():
        return torch.device("cuda")
    return torch.device("cpu")


def render(xy, log_s, theta, color, grad, H, W, K, normalized=False):
    """Splat rasteriser: each splat writes a KxK patch around its centre.

    Additive by default: pixels are the sum of the blobs' light, so a missing blob leaves a
    hole. normalized=True divides by the accumulated weight instead (a weighted average of
    the blobs covering each pixel), so a missing blob leaves a smoother area, not a hole.
    """
    N = xy.shape[0]
    R = K // 2
    dev = xy.device

    # Integer anchor detached; the sub-pixel offset stays differentiable.
    base = xy.detach().round().long()
    off = torch.arange(-R, R + 1, device=dev)
    gy, gx = torch.meshgrid(off, off, indexing="ij")
    px = base[:, 0].view(N, 1, 1) + gx.view(1, K, K)
    py = base[:, 1].view(N, 1, 1) + gy.view(1, K, K)
    dx = px.float() - xy[:, 0].view(N, 1, 1)
    dy = py.float() - xy[:, 1].view(N, 1, 1)

    sx = log_s[:, 0].exp().clamp(0.5, K / 6.0).view(N, 1, 1)
    sy = log_s[:, 1].exp().clamp(0.5, K / 6.0).view(N, 1, 1)
    cos, sin = torch.cos(theta).view(N, 1, 1), torch.sin(theta).view(N, 1, 1)
    un = (dx * cos + dy * sin) / sx
    vn = (-dx * sin + dy * cos) / sy
    g = torch.exp(-0.5 * (un ** 2 + vn ** 2))

    col = (color.view(N, 3, 1, 1)
           + grad[:, :, 0].view(N, 3, 1, 1) * un.unsqueeze(1)
           + grad[:, :, 1].view(N, 3, 1, 1) * vn.unsqueeze(1))

    inside = ((px >= 0) & (px < W) & (py >= 0) & (py < H)).float()
    contrib = (g * inside).unsqueeze(1) * col

    idx = (py.clamp(0, H - 1) * W + px.clamp(0, W - 1)).reshape(-1)
    src = contrib.permute(1, 0, 2, 3).reshape(3, -1)
    acc = torch.zeros(3, H * W, device=dev).index_add(1, idx, src)
    if normalized:
        w = torch.zeros(1, H * W, device=dev).index_add(1, idx, (g * inside).reshape(1, -1))
        acc = acc / w.clamp(min=1e-4)
    return acc.view(3, H, W)


def psnr(a, b):
    mse = torch.mean((a.clamp(0, 1) - b) ** 2).item()
    return 10 * math.log10(1.0 / max(mse, 1e-12))


def log_q(v, lo, hi, bits=8):
    n = 2 ** bits - 1
    v = v.clamp(lo, hi)
    q = torch.round(n * (torch.log(v) - math.log(lo)) / (math.log(hi) - math.log(lo)))
    return torch.exp(math.log(lo) + q / n * (math.log(hi) - math.log(lo)))


def amplitude(color, grad):
    """Shared per-splat scale: colour lands in [-1, 1] and gradients in +-GRAD_RANGE."""
    return torch.maximum(color.abs().max(dim=1).values,
                         grad.abs().amax(dim=(1, 2)) / GRAD_RANGE).clamp(min=AMP_MIN)


def quantise(xy, log_s, theta, color, grad, H, W):
    """Round-trip every field through the wire record."""
    lo_x, hi_x = -POS_MARGIN, (W - 1) + POS_MARGIN
    lo_y, hi_y = -POS_MARGIN, (H - 1) + POS_MARGIN
    x = torch.round((xy[:, 0].clamp(lo_x, hi_x) - lo_x) * 65535 / (hi_x - lo_x))
    y = torch.round((xy[:, 1].clamp(lo_y, hi_y) - lo_y) * 65535 / (hi_y - lo_y))
    qxy = torch.stack([x * (hi_x - lo_x) / 65535 + lo_x, y * (hi_y - lo_y) / 65535 + lo_y], 1)

    sx = log_q(log_s[:, 0].exp(), SIGMA_MIN, SIGMA_MAX)
    sy = log_q(log_s[:, 1].exp(), SIGMA_MIN, SIGMA_MAX)
    qlog_s = torch.log(torch.stack([sx, sy], 1))

    # Fold theta into [0, pi). The Gaussian envelope survives a half-turn unchanged, but a
    # colour ramp does not: rotating by pi maps (u, v) -> (-u, -v) and reverses it. Every
    # splat folded by an odd number of half-turns needs its gradient negated, otherwise it
    # comes back with its shading inverted (this cost 16-20 dB before it was caught).
    turns = torch.floor(theta / math.pi)
    grad = grad * (1 - 2 * turns.remainder(2)).view(-1, 1, 1)
    qth = torch.round((theta - turns * math.pi) * 255 / math.pi) * math.pi / 255

    amp = amplitude(color, grad)
    qamp = log_q(amp, AMP_MIN, AMP_MAX)
    qcol = torch.round(127 * color / amp.view(-1, 1)).clamp(-127, 127) / 127 * qamp.view(-1, 1)
    gscale = 127 / GRAD_RANGE
    qgrad = (torch.round(gscale * grad / amp.view(-1, 1, 1)).clamp(-127, 127)
             / gscale * qamp.view(-1, 1, 1))
    return qxy, qlog_s, qth, qcol, qgrad


def _zigzag(a):
    return ((a << 1) ^ (a >> 31)).astype(np.uint32)


def _morton(x, y):
    def spread(v):
        v = v.astype(np.uint64) & 0xFFFF
        v = (v | (v << 16)) & 0x0000FFFF0000FFFF
        v = (v | (v << 8)) & 0x00FF00FF00FF00FF
        v = (v | (v << 4)) & 0x0F0F0F0F0F0F0F0F
        v = (v | (v << 2)) & 0x3333333333333333
        v = (v | (v << 1)) & 0x5555555555555555
        return v
    return spread(x) | (spread(y) << 1)


def coded_bytes(xy, log_s, theta, color, grad, axes, H, W):
    """Bytes after Morton sort + delta + deflate, including the gradient planes."""
    lo_x, hi_x = -POS_MARGIN, (W - 1) + POS_MARGIN
    lo_y, hi_y = -POS_MARGIN, (H - 1) + POS_MARGIN
    x16 = np.round((xy[:, 0].clamp(lo_x, hi_x).cpu().numpy() - lo_x) * 65535 / (hi_x - lo_x)).astype(np.uint16)
    y16 = np.round((xy[:, 1].clamp(lo_y, hi_y).cpu().numpy() - lo_y) * 65535 / (hi_y - lo_y)).astype(np.uint16)

    def u8log(v, lo, hi):
        v = np.clip(v, lo, hi)
        return np.round(255 * (np.log(v) - math.log(lo)) / (math.log(hi) - math.log(lo))).astype(np.uint8)

    s = log_s.exp().cpu().numpy()
    # Same half-turn fold as quantise(): the stored gradient must match the stored angle.
    turns = torch.floor(theta / math.pi)
    grad = grad * (1 - 2 * turns.remainder(2)).view(-1, 1, 1)
    amp = amplitude(color, grad).cpu().numpy()
    planes_u8 = [u8log(s[:, 0], SIGMA_MIN, SIGMA_MAX), u8log(s[:, 1], SIGMA_MIN, SIGMA_MAX),
                 np.round((theta.cpu().numpy() % math.pi) * 255 / math.pi).astype(np.uint8),
                 u8log(amp, AMP_MIN, AMP_MAX)]
    col = np.clip(np.round(127 * color.cpu().numpy() / amp[:, None]), -127, 127).astype(np.int8)
    gr = np.clip(np.round(127 / GRAD_RANGE * grad.cpu().numpy() / amp[:, None, None]),
                 -127, 127).astype(np.int8)

    order = np.argsort(_morton(x16, y16))
    xs, ys = x16[order].astype(np.int64), y16[order].astype(np.int64)
    planes = [_zigzag(np.diff(np.concatenate([[0], xs])).astype(np.int32)).tobytes(),
              _zigzag(np.diff(np.concatenate([[0], ys])).astype(np.int32)).tobytes()]
    planes += [p[order].tobytes() for p in planes_u8]
    planes.append(col[order].tobytes())
    for a in range(axes):
        planes.append(gr[order][:, :, a].tobytes())
    coded = sum(len(zlib.compress(p, 9)) for p in planes)
    return xy.shape[0] * record_bytes(axes), coded


def fit(target, N, iters, K=49, axes=0, densify=False, densify_every=250, densify_frac=0.05,
        log=print, callback=None, normalized=False):
    """Jointly optimise N splats against target (3, H, W, values in [0, 1]).

    Returns the raw (unquantised) parameters xy, log_s, theta, color, grad; pass them
    through quantise() to get what the wire would carry. callback(it, img), if given, sees
    every iteration's render (for figures of the fit in progress).
    """
    dev = target.device
    _, H, W = target.shape

    gray = target.mean(0)
    grad_img = torch.zeros_like(gray)
    grad_img[:, :-1] += (gray[:, 1:] - gray[:, :-1]).abs()
    grad_img[:-1, :] += (gray[1:, :] - gray[:-1, :]).abs()
    p = grad_img.flatten() + grad_img.mean() * 0.25 + 1e-8
    # multinomial on CPU: the MPS implementation segfaults at this size.
    pick = torch.multinomial((p / p.sum()).cpu(), N, replacement=True).to(dev)
    xy = torch.stack([(pick % W).float(), (pick // W).float()], 1) + torch.rand(N, 2, device=dev) - 0.5

    coverage = 1.0 if normalized else 1.5      # normalized rendering averages, so no division
    sigma0 = min(max(math.sqrt(W * H * coverage / (N * 2 * math.pi)), 0.8), K / 6.0)
    log_s = torch.log(torch.full((N, 2), sigma0, device=dev))
    theta = torch.zeros(N, device=dev)
    color = (target.view(3, -1)[:, pick].t().contiguous() / coverage)
    grad = torch.zeros(N, 3, 2, device=dev)
    gmask = torch.tensor([1.0 if axes >= 1 else 0.0, 1.0 if axes >= 2 else 0.0], device=dev)

    params = [xy, log_s, theta, color] + ([grad] if axes else [])
    for t in params:
        t.requires_grad_(True)
    groups = [{"params": [xy], "lr": 0.35}, {"params": [log_s], "lr": 0.012},
              {"params": [theta], "lr": 0.012}, {"params": [color], "lr": 0.012}]
    if axes:
        groups.append({"params": [grad], "lr": 0.012})
    opt = torch.optim.Adam(groups)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=iters)

    def G():
        return grad * gmask

    t0 = time.time()
    moved = 0
    for it in range(iters):
        opt.zero_grad(set_to_none=True)
        img = render(xy, log_s, theta, color, G(), H, W, K, normalized)
        if callback:
            callback(it, img.detach())
        loss = torch.mean((img.clamp(0, 1) - target) ** 2)
        loss.backward()
        opt.step()
        sched.step()

        if (densify and it and it % densify_every == 0
                and it < iters - 2 * densify_every):
            with torch.no_grad():
                s = log_s.exp()
                energy = amplitude(color, G()) * s[:, 0] * s[:, 1]
                k = max(1, int(N * densify_frac))
                weak = torch.topk(energy, k, largest=False).indices
                resid = target - img.clamp(0, 1)
                err = (resid ** 2).mean(0).flatten()
                hot = torch.multinomial((err / err.sum()).cpu(), k, replacement=False).to(dev)
                xy[weak] = torch.stack([(hot % W).float(), (hot // W).float()], 1)
                log_s[weak] = math.log(max(0.8, sigma0 * 0.6))
                theta[weak] = 0.0
                color[weak] = resid.view(3, -1)[:, hot].t()
                grad[weak] = 0.0
                for prm in params:
                    st = opt.state.get(prm, {})
                    for key in ("exp_avg", "exp_avg_sq"):
                        if key in st:
                            st[key][weak] = 0
            moved += k

        if log and (it % 500 == 0 or it == iters - 1):
            extra = f"  moved {moved}" if densify else ""
            log(f"  iter {it:5d}  psnr {psnr(img, target):6.2f} dB  ({time.time()-t0:5.1f}s){extra}")

    return xy.detach(), log_s.detach(), theta.detach(), color.detach(), G().detach()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("image")
    ap.add_argument("--x", type=int, default=0)
    ap.add_argument("--y", type=int, default=0)
    ap.add_argument("--size", type=int, default=256)
    ap.add_argument("--splats", type=int, default=4000)
    ap.add_argument("--iters", type=int, default=2000)
    ap.add_argument("--patch", type=int, default=49)
    ap.add_argument("--gradient", choices=list(AXES), default="none",
                    help="per-splat colour ramp: none, along u, or along u and v")
    ap.add_argument("--densify", action="store_true")
    ap.add_argument("--densify-every", type=int, default=250)
    ap.add_argument("--densify-frac", type=float, default=0.05)
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    dev = device()
    im = Image.open(args.image).convert("RGB")
    crop = im.crop((args.x, args.y, args.x + args.size, args.y + args.size))
    target = torch.from_numpy(np.asarray(crop, dtype=np.float32) / 255.0).permute(2, 0, 1).to(dev)
    _, H, W = target.shape
    N, K = args.splats, args.patch
    axes = AXES[args.gradient]

    print(f"{args.image} @ {args.x},{args.y}  {W}x{H}  device={dev}")
    print(f"{N} splats, gradient={args.gradient} ({record_bytes(axes)} bytes/splat), "
          f"{args.iters} iterations, densify={'on' if args.densify else 'off'}")

    t0 = time.time()
    xy, log_s, theta, color, grad = fit(target, N, args.iters, K, axes, args.densify,
                                        args.densify_every, args.densify_frac)

    with torch.no_grad():
        raw_db = psnr(render(xy, log_s, theta, color, grad, H, W, K), target)
        q = quantise(xy, log_s, theta, color, grad, H, W)
        qimg = render(*q, H, W, K)
        q_db = psnr(qimg, target)
        raw, coded = coded_bytes(xy, log_s, theta, color, grad, axes, H, W)

    px = W * H
    print(f"\nsplats            {N}  ({record_bytes(axes)} bytes each, gradient={args.gradient})")
    print(f"PSNR unquantised  {raw_db:.2f} dB")
    print(f"PSNR quantised    {q_db:.2f} dB   (wire record)")
    print(f"bytes raw         {raw} ({raw/1024:.1f} KB, {raw*8/px:.2f} bpp)")
    print(f"bytes coded       {coded} ({coded/1024:.1f} KB, {coded*8/px:.2f} bpp)  Morton+delta+deflate")
    print(f"time              {time.time()-t0:.1f} s")

    if args.out:
        arr = (qimg.clamp(0, 1).permute(1, 2, 0).cpu().numpy() * 255).astype(np.uint8)
        Image.fromarray(arr).save(args.out)
        print(f"wrote             {args.out}")


if __name__ == "__main__":
    main()
