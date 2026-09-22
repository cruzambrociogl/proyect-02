#!/usr/bin/env python3
"""
Does a splat tile degrade gracefully when packets are lost or the stream is cut short?

That is the claim the protocol's partial reliability would rest on: a splat tile is 4000
independent 11-byte records added together, so losing some costs quality, not correctness,
while a JPEG cut short or punched with a hole is broken.

Four ways of losing the same fraction of a tile's bytes, all dropping whole 1400-byte
packets (127 records each):

  splats, interleaved     records spread across packets, so a lost packet takes blobs from
                          all over the tile
  splats, not interleaved packets carry neighbouring blobs (Morton order), so a lost packet
                          leaves a hole
  splats, cut short       the stream is sent most-important-blob-first and stops early -
                          what cancelling a tile mid-send actually does
  JPEG, cut short         the same fraction of the JPEG's bytes never arrives

  python3 tools/splat_loss.py images/.tiles/holbein_8000.jpg --tiles 3/7_4 5/4_2 10/1_0 \
      --out out/loss
"""

import argparse
import io
import os
import sys

import numpy as np
import torch
from PIL import Image, ImageFile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from splat_fit_torch import (BASE_RECORD, amplitude, device, fit, psnr,  # noqa: E402
                             quantise, render, _morton)

RECORDS_PER_PACKET = 1400 // BASE_RECORD          # a 1400-byte payload holds 127 records


def load_params(store, spec, out, n, iters, patch, dev, normalized=False):
    """Fit the tile once and cache the quantised (wire) parameters."""
    cache = os.path.join(out, spec.replace("/", "_") + ("_norm" if normalized else "") + ".npz")
    im = Image.open(os.path.join(store, spec.split("/")[0], spec.split("/")[1] + ".jpg")).convert("RGB")
    target = torch.from_numpy(np.asarray(im, dtype=np.float32) / 255.0).permute(2, 0, 1).to(dev)
    if os.path.exists(cache):
        z = np.load(cache)
        q = tuple(torch.from_numpy(z[k]).to(dev) for k in ("xy", "log_s", "theta", "color", "grad"))
        return target, q
    _, H, W = target.shape
    params = fit(target, n, iters, patch, log=None, normalized=normalized)
    with torch.no_grad():
        q = quantise(*params, H, W)
    np.savez(cache, xy=q[0].cpu().numpy(), log_s=q[1].cpu().numpy(), theta=q[2].cpu().numpy(),
             color=q[3].cpu().numpy(), grad=q[4].cpu().numpy())
    return target, q


def keep_masks(q, frac, rng):
    """Which records survive, for each loss pattern, when `frac` of the bytes is lost."""
    n = q[0].shape[0]
    npk = int(np.ceil(n / RECORDS_PER_PACKET))
    lost = rng.choice(npk, size=int(round(npk * frac)), replace=False)
    lost_set = np.zeros(npk, bool)
    lost_set[lost] = True

    x16 = q[0][:, 0].clamp(min=0).cpu().numpy().astype(np.uint16)
    y16 = q[0][:, 1].clamp(min=0).cpu().numpy().astype(np.uint16)
    morton = np.argsort(_morton(x16, y16))

    packet_of = np.empty(n, int)
    packet_of[morton] = np.arange(n) % npk                    # interleaved: round-robin
    interleaved = ~lost_set[packet_of]

    packet_of[morton] = np.arange(n) // RECORDS_PER_PACKET    # contiguous: neighbours together
    burst = ~lost_set[packet_of]

    energy = (amplitude(q[3], q[4]) * q[1][:, 0].exp() * q[1][:, 1].exp()).cpu().numpy()
    order = np.argsort(-energy)                               # most important first
    cut = np.zeros(n, bool)
    cut[order[:n - int(round(n * frac))]] = True
    return {"interleaved": interleaved, "burst": burst, "cut short": cut}


def jpeg_cut(raw, frac, target):
    """Decode a JPEG whose last `frac` of bytes never arrived."""
    ImageFile.LOAD_TRUNCATED_IMAGES = True
    keep = max(1, int(len(raw) * (1 - frac)))
    try:
        im = Image.open(io.BytesIO(raw[:keep]))
        im.load()
        arr = np.asarray(im.convert("RGB"), dtype=np.float32) / 255.0
    except Exception:
        return float("nan")
    t = torch.from_numpy(arr).permute(2, 0, 1).to(target.device)
    return psnr(t, target)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("store")
    ap.add_argument("--tiles", nargs="+", required=True)
    ap.add_argument("--splats", type=int, default=4000)
    ap.add_argument("--iters", type=int, default=1000)
    ap.add_argument("--patch", type=int, default=33)
    ap.add_argument("--losses", default="0,5,10,20,30,40,50,60")
    ap.add_argument("--show", type=float, default=20, help="loss %% to render as images")
    ap.add_argument("--normalized", action="store_true",
                    help="fit and draw with weight-normalised splats instead of additive")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    dev = device()
    rng = np.random.default_rng(7)
    losses = [float(v) / 100 for v in args.losses.split(",")]
    rows = {}

    for spec in args.tiles:
        target, q = load_params(args.store, spec, args.out, args.splats, args.iters, args.patch, dev,
                                args.normalized)
        _, H, W = target.shape
        raw = open(os.path.join(args.store, spec.split("/")[0], spec.split("/")[1] + ".jpg"), "rb").read()
        print(f"\n{spec}  {W}x{H}  {q[0].shape[0]} splats "
              f"({q[0].shape[0] * BASE_RECORD / 1024:.0f} KB)  JPEG {len(raw) / 1024:.1f} KB")
        print(f"{'bytes lost':>11} {'interleaved':>12} {'burst':>9} {'cut short':>11} {'JPEG cut':>10}")
        for frac in losses:
            masks = keep_masks(q, frac, rng)
            out = {}
            for name, m in masks.items():
                sel = torch.from_numpy(np.where(m)[0]).to(dev)
                with torch.no_grad():
                    img = render(q[0][sel], q[1][sel], q[2][sel], q[3][sel], q[4][sel], H, W, args.patch,
                                 args.normalized)
                out[name] = psnr(img, target)
                if abs(frac * 100 - args.show) < 1e-6 and spec == args.tiles[0]:
                    arr = (img.clamp(0, 1).permute(1, 2, 0).cpu().numpy() * 255).astype(np.uint8)
                    Image.fromarray(arr).save(os.path.join(args.out, f"lost{int(frac*100)}_{name.replace(' ', '')}{'_norm' if args.normalized else ''}.png"))
                if frac == 0 and spec == args.tiles[0] and name == "interleaved":
                    arr = (img.clamp(0, 1).permute(1, 2, 0).cpu().numpy() * 255).astype(np.uint8)
                    Image.fromarray(arr).save(os.path.join(args.out, "lost0_splats_norm.png" if args.normalized else "lost0_splats.png"))
            out["jpeg"] = jpeg_cut(raw, frac, target)
            rows.setdefault(frac, []).append(out)
            print(f"{frac * 100:10.0f}% {out['interleaved']:11.2f} {out['burst']:9.2f} "
                  f"{out['cut short']:11.2f} {out['jpeg']:10.2f}")
            if abs(frac * 100 - args.show) < 1e-6 and spec == args.tiles[0]:
                keep = max(1, int(len(raw) * (1 - frac)))
                open(os.path.join(args.out, f"lost{int(frac*100)}_jpeg.jpg"), "wb").write(raw[:keep])

    print(f"\nmean over {len(args.tiles)} tiles")
    print(f"{'bytes lost':>11} {'interleaved':>12} {'burst':>9} {'cut short':>11} {'JPEG cut':>10}")
    with open(os.path.join(args.out, "loss_norm.csv" if args.normalized else "loss.csv"), "w") as f:
        f.write("loss_pct,interleaved,burst,cut_short,jpeg\n")
        for frac in losses:
            m = {k: float(np.nanmean([r[k] for r in rows[frac]])) for k in rows[frac][0]}
            print(f"{frac * 100:10.0f}% {m['interleaved']:11.2f} {m['burst']:9.2f} "
                  f"{m['cut short']:11.2f} {m['jpeg']:10.2f}")
            f.write(f"{frac * 100:.0f},{m['interleaved']:.3f},{m['burst']:.3f},"
                    f"{m['cut short']:.3f},{m['jpeg']:.3f}\n")
    print(f"wrote {args.out}/loss.csv and images")


if __name__ == "__main__":
    main()
