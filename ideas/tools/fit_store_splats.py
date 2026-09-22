#!/usr/bin/env python3
"""
Fit splats to tiles of an ingested ladder store, for the session simulator's splat strategy.

Each tile gets the measured operating point, 4000 splats per full 256x256 tile (edge tiles
get the same density), jointly optimised and then round-tripped through the 11-byte wire
record, so the saved render is what a client would actually draw. Results go to

    OUT/<level>/<tx>_<ty>.png      the quantised render
    OUT/fits.csv                    level,tx,ty,w,h,splats,bytes,psnr_db,seconds

Already-fitted tiles are skipped, so an interrupted run resumes where it stopped.

  python3 tools/fit_store_splats.py images/.tiles/eso1242a.tif --out out/session/splats/eso \
      --tiles 10/5_3 14/2_1            (or --list FILE with one level/tx_ty per line)
"""

import argparse
import os
import sys
import time

import numpy as np
import torch
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from splat_fit_torch import BASE_RECORD, device, fit, psnr, quantise, render  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("store")
    ap.add_argument("--out", required=True)
    ap.add_argument("--tiles", nargs="*", default=[])
    ap.add_argument("--list", default=None)
    ap.add_argument("--density", type=int, default=4000, help="splats per full tile")
    ap.add_argument("--iters", type=int, default=1000)
    ap.add_argument("--patch", type=int, default=49)
    args = ap.parse_args()

    tiles = list(args.tiles)
    if args.list:
        with open(args.list) as f:
            tiles += [ln.strip() for ln in f if ln.strip()]

    tile_size = 256
    with open(os.path.join(args.store, "meta.txt")) as f:
        for ln in f:
            if ln.startswith("tileSize="):
                tile_size = int(ln.split("=")[1])

    os.makedirs(args.out, exist_ok=True)
    csv = os.path.join(args.out, "fits.csv")
    if not os.path.exists(csv):
        with open(csv, "w") as f:
            f.write("level,tx,ty,w,h,splats,bytes,psnr_db,seconds\n")

    dev = device()
    todo = [t for t in dict.fromkeys(tiles)
            if not os.path.exists(os.path.join(args.out, t + ".png"))]
    print(f"{len(tiles)} tiles requested, {len(todo)} to fit, {args.iters} iterations, device={dev}")

    for i, spec in enumerate(todo):
        level, name = spec.split("/")
        tx, ty = (int(v) for v in name.split("_"))
        im = Image.open(os.path.join(args.store, level, name + ".jpg")).convert("RGB")
        target = torch.from_numpy(np.asarray(im, dtype=np.float32) / 255.0).permute(2, 0, 1).to(dev)
        _, H, W = target.shape
        n = max(16, round(args.density * W * H / (tile_size * tile_size)))

        t0 = time.time()
        params = fit(target, n, args.iters, args.patch, log=None)
        with torch.no_grad():
            qimg = render(*quantise(*params, H, W), H, W, args.patch)
            db = psnr(qimg, target)
        secs = time.time() - t0

        os.makedirs(os.path.join(args.out, level), exist_ok=True)
        arr = (qimg.clamp(0, 1).permute(1, 2, 0).cpu().numpy() * 255).astype(np.uint8)
        Image.fromarray(arr).save(os.path.join(args.out, spec + ".png"))
        with open(csv, "a") as f:
            f.write(f"{level},{tx},{ty},{W},{H},{n},{n * BASE_RECORD},{db:.3f},{secs:.1f}\n")
        print(f"[{i + 1}/{len(todo)}] {spec:>10}  {W}x{H}  {n} splats  {db:6.2f} dB  {secs:5.1f}s",
              flush=True)


if __name__ == "__main__":
    main()
