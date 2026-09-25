"""
Optional polish: a short run of Adam over the formula's blobs, on the GPU when there is one.

The formula places blobs by rule and only solves their colours exactly; moving, resizing and
turning them as well is what gradient descent adds. Starting from the formula's answer, a
few hundred steps do what a thousand random-start steps used to.

Every blob is drawn into a square patch. Apple's GPU backend keeps a buffer for every tensor
shape it meets, so shapes must not change between steps: blobs go into two groups fixed at
the start - small ones in a 15x15 patch, large ones in one patch big enough for the largest -
and each blob's size is capped at what its patch can hold. Needs torch; without it the
fitter skips this step.
"""

import math
import threading

import numpy as np

from .blobs import CUTOFF, EPS, MIN_REACH, SIGMA_MIN, Blobs

try:
    import torch
except ImportError:          # polish is optional
    torch = None

SMALL_R = 7
_gpu = threading.Lock()     # one polish at a time on the GPU (the server fits from threads)
LARGE_R_MAX = 40


def available():
    return torch is not None


def _device():
    if torch.backends.mps.is_available():
        return torch.device("mps")
    if torch.cuda.is_available():
        return torch.device("cuda")
    return torch.device("cpu")


def _group_draw(xy, log_s, theta, color, R, H, W):
    """Weights and colour contributions of one group of blobs, each in a (2R+1)^2 patch.
    Returns (pixel index, weight, weighted colour), flattened."""
    dev = xy.device
    K = 2 * R + 1
    n = xy.shape[0]
    base = xy.detach().floor().long()
    offs = torch.arange(-R, R + 1, device=dev)
    gy, gx = torch.meshgrid(offs, offs, indexing="ij")
    px = base[:, 0].view(n, 1, 1) + gx.view(1, K, K)
    py = base[:, 1].view(n, 1, 1) + gy.view(1, K, K)
    dx = px.float() + 0.5 - xy[:, 0].view(n, 1, 1)
    dy = py.float() + 0.5 - xy[:, 1].view(n, 1, 1)
    limit = (R + 0.5) / CUTOFF
    sigma = log_s.exp().clamp(SIGMA_MIN, limit)
    sx, sy = sigma[:, 0].view(n, 1, 1), sigma[:, 1].view(n, 1, 1)
    cos, sin = torch.cos(theta).view(n, 1, 1), torch.sin(theta).view(n, 1, 1)
    u = (dx * cos + dy * sin) / sx
    v = (-dx * sin + dy * cos) / sy
    reach = torch.clamp(CUTOFF * torch.maximum(sx, sy), min=MIN_REACH).detach()
    keep = ((dx * dx + dy * dy) <= reach * reach) & (px >= 0) & (px < W) & (py >= 0) & (py < H)
    w = torch.exp(-0.5 * (u * u + v * v)) * keep.float()
    flat = (py.clamp(0, H - 1) * W + px.clamp(0, W - 1)).reshape(-1)
    return flat, w.reshape(-1), (w.unsqueeze(1) * color.view(n, 3, 1, 1)).permute(1, 0, 2, 3).reshape(3, -1)


def polish(blobs, goal, row_w, normalized, steps, lr=1.0):
    """Adam over position, size, rotation and colour. goal, row_w as in fit.solve_colours.

    Always runs every step. Stopping once the unit reaches its target was tried and cost
    visible quality: the blob count is fixed by then, so steps past the target are quality
    for free (the top level fell from 41 to 35 dB).

    Returns float Blobs. Quantisation and the final colour solve come after."""
    if torch is None or steps <= 0 or len(blobs) == 0:
        return blobs
    with _gpu:
        return _polish(blobs, goal, row_w, normalized, steps, lr)


def _polish(blobs, goal, row_w, normalized, steps, lr):
    dev = _device()
    H, W = goal.shape[:2]
    reach = np.maximum(CUTOFF * np.maximum(blobs.sx, blobs.sy), MIN_REACH)
    small = reach <= SMALL_R + 0.5
    large_r = int(min(LARGE_R_MAX, math.ceil(reach[~small].max()) if (~small).any() else SMALL_R))
    groups = [(np.nonzero(small)[0], SMALL_R), (np.nonzero(~small)[0], large_r)]
    groups = [(idx, R) for idx, R in groups if len(idx)]

    target = torch.tensor(goal.reshape(-1, 3).T, dtype=torch.float32, device=dev)
    weight = torch.tensor(row_w.reshape(-1), dtype=torch.float32, device=dev)
    weight = weight / weight.sum()
    params = []
    for idx, R in groups:
        b = blobs.take(idx)
        t = lambda a: torch.tensor(a, dtype=torch.float32, device=dev, requires_grad=True)  # noqa: E731
        params.append((t(np.stack([b.x, b.y], 1)), t(np.log(np.stack([b.sx, b.sy], 1))),
                       t(b.th), t(b.c), R))
    opt = torch.optim.Adam([
        {"params": [p[0] for p in params], "lr": 0.05 * lr},
        {"params": [p[1] for p in params], "lr": 0.01 * lr},
        {"params": [p[2] for p in params], "lr": 0.01 * lr},
        {"params": [p[3] for p in params], "lr": 0.005 * lr},
    ])
    schedule = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=steps)
    for _ in range(steps):
        opt.zero_grad(set_to_none=True)
        num = torch.zeros(3, H * W, device=dev)
        den = torch.zeros(H * W, device=dev)
        for xy, log_s, theta, color, R in params:
            flat, w, cw = _group_draw(xy, log_s, theta, color, R, H, W)
            num = num.index_add(1, flat, cw)
            if normalized:
                den = den.index_add(0, flat, w)
        img = num / den.clamp(min=EPS) if normalized else num
        loss = (((img - target) ** 2).sum(0) * weight).sum()
        loss.backward()
        opt.step()
        schedule.step()

    out = []
    for (idx, _), (xy, log_s, theta, color, R) in zip(groups, params):
        limit = (R + 0.5) / CUTOFF
        s = log_s.detach().exp().clamp(SIGMA_MIN, limit).cpu().numpy()
        p = xy.detach().cpu().numpy()
        out.append(Blobs(p[:, 0], p[:, 1], s[:, 0], s[:, 1], theta.detach().cpu().numpy(),
                         color.detach().cpu().numpy()))
    return Blobs.concat(*out)
