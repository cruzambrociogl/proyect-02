"""
Score the screenshots bench/versus.ts took: what the user saw, against the original image.

Each screenshot comes with the camera the viewer reported (centre in image pixels, image
pixels per canvas pixel). The original is cropped to that camera and resized to the canvas
(box filter when shrinking), and the two are compared as PSNR over the pixels that show image,
leaving out the top-left corner where v2 draws its overlay (the same corner for both).

A run whose page received almost nothing (v1 sometimes shows a black page until reloaded)
counts as a failed load: it is left out of the scores and counted on its own.

  python3 bench/versus_quality.py [bench/out/versus] [--image ../app/images/holbein_8000.jpg]
"""

import argparse
import glob
import json
import math
import os
from collections import defaultdict

import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None
CW, CH = 1260, 834
FAILED_LOAD_BYTES = 100_000
OVERLAY = (470, 310)        # v2's overlay, masked out of both


def truth(src, camera):
    """The original as a canvas showing `camera`, and a mask of where the canvas shows image."""
    W, H = src.size
    s = camera["scale"]
    X0, Y0 = camera["cx"] - CW * s / 2, camera["cy"] - CH * s / 2
    x0, y0 = max(0.0, X0), max(0.0, Y0)
    x1, y1 = min(W, X0 + CW * s), min(H, Y0 + CH * s)
    canvas = np.zeros((CH, CW, 3))
    mask = np.zeros((CH, CW), bool)
    if x1 <= x0 or y1 <= y0:
        return canvas, mask
    dx0, dy0 = round((x0 - X0) / s), round((y0 - Y0) / s)
    dx1, dy1 = round((x1 - X0) / s), round((y1 - Y0) / s)
    dw, dh = max(1, dx1 - dx0), max(1, dy1 - dy0)
    crop = src.crop((int(x0), int(y0), int(math.ceil(x1)), int(math.ceil(y1))))
    part = crop.resize((dw, dh), Image.BOX if s > 1 else Image.NEAREST)
    canvas[dy0:dy0 + dh, dx0:dx0 + dw] = np.asarray(part, np.float64)[:CH - dy0, :CW - dx0] / 255
    mask[dy0:dy0 + dh, dx0:dx0 + dw] = True
    mask[:OVERLAY[1], :OVERLAY[0]] = False
    return canvas, mask


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out", nargs="?", default=os.path.join(os.path.dirname(__file__), "out", "versus"))
    ap.add_argument("--image", default=os.path.join(os.path.dirname(__file__), "..", "..", "app", "images", "holbein_8000.jpg"))
    args = ap.parse_args()
    src = Image.open(args.image).convert("RGB")

    scores = defaultdict(list)       # (link, version, phase, after) -> [psnr]
    totals = defaultdict(list)       # (link, version) -> [result]
    failed = defaultdict(int)        # (link, version) -> runs that never loaded
    for path in sorted(glob.glob(os.path.join(args.out, "*", "result.json"))):
        r = json.load(open(path))
        if r["bytes"] < FAILED_LOAD_BYTES:
            failed[(r["profile"], r["version"])] += 1
            continue
        totals[(r["profile"], r["version"])].append(r)
        for shot in r["shots"]:
            if not shot["camera"]:
                continue
            seen = np.asarray(Image.open(os.path.join(os.path.dirname(path), shot["file"])).convert("RGB"), np.float64) / 255
            want, mask = truth(src, shot["camera"])
            if not mask.any():
                continue
            mse = float(np.mean((seen[mask] - want[mask]) ** 2))
            scores[(r["profile"], r["version"], shot["phase"], shot["after"])].append(10 * math.log10(1 / max(mse, 1e-10)))

    phases = ["open", "zoom-in", "pan", "zoom-out"]
    afters = sorted({k[3] for k in scores})
    links = sorted({k[0] for k in totals}, key=lambda l: ["lan", "home", "mobile"].index(l) if l in ["lan", "home", "mobile"] else 9)
    print(f"PSNR of the canvas against the original (median of runs), dB; columns: phase @ seconds after its input")
    header = "link    ver " + " ".join(f"{p[:7]:>7}@{a:<3}" for p in phases for a in afters)
    print(header)
    for link in links:
        for ver in ["v1", "v2"]:
            cells = []
            for p in phases:
                for a in afters:
                    v = scores.get((link, ver, p, a))
                    cells.append(f"{np.median(v):11.1f}" if v else f"{'-':>11}")
            print(f"{link:7} {ver}  " + " ".join(cells))
    print()
    print(f"{'link':7} {'ver':4} {'received MB':>12} {'sent':>6} {'peak held MB':>13} {'JS heap MB':>11} {'failed loads':>13}")
    for link in links:
        for ver in ["v1", "v2"]:
            rs = totals.get((link, ver), [])
            if not rs:
                continue
            med = lambda k: float(np.median([x[k] for x in rs]))  # noqa: E731
            print(f"{link:7} {ver:4} {med('bytes') / 2**20:12.2f} {med('sent'):6.0f} {med('peakHeld') / 2**20:13.1f} "
                  f"{med('heap') / 2**20:11.1f} {failed[(link, ver)]:>6} of {len(rs) + failed[(link, ver)]}")


if __name__ == "__main__":
    main()
