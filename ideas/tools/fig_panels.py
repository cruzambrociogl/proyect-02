#!/usr/bin/env python3
"""
Generic side-by-side figure: the original crop, then any number of reconstructions, each
labelled with its size and PSNR measured against the crop.

  python3 tools/fig_panels.py --orig IMG --x 1450 --y 600 --size 256 \
      --panel "out/a.png|2000 splats, no densify|22000" \
      --panel "out/b.png|2000 splats, densified|22000" \
      --title "..." --out out/fig5.png

Each --panel is  path|label|bytes  (bytes may be omitted for panels that are not encodings).
Panels whose label contains "old" or "greedy" are drawn in red, so the baseline stands out.
"""

import argparse
import math

import numpy as np
from PIL import Image, ImageDraw, ImageFont


def psnr(a, b):
    a = np.asarray(a, dtype=np.float64) / 255.0
    b = np.asarray(b, dtype=np.float64) / 255.0
    return 10 * math.log10(1.0 / max(float(np.mean((a - b) ** 2)), 1e-12))


def font(size, bold=False):
    path = ("/System/Library/Fonts/Supplemental/Arial Bold.ttf" if bold
            else "/System/Library/Fonts/Supplemental/Arial.ttf")
    for p in (path, "/System/Library/Fonts/Helvetica.ttc"):
        try:
            return ImageFont.truetype(p, size)
        except Exception:
            continue
    return ImageFont.load_default()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--orig", required=True)
    ap.add_argument("--x", type=int, default=0)
    ap.add_argument("--y", type=int, default=0)
    ap.add_argument("--size", type=int, default=256)
    ap.add_argument("--panel", action="append", default=[])
    ap.add_argument("--scale", type=int, default=2)
    ap.add_argument("--title", default="")
    ap.add_argument("--caption", default="")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    target = Image.open(args.orig).convert("RGB").crop(
        (args.x, args.y, args.x + args.size, args.y + args.size))
    px = args.size * args.size

    panels = [(target, "original", None, None)]
    for spec in args.panel:
        parts = spec.split("|")
        img = Image.open(parts[0]).convert("RGB")
        nbytes = int(parts[2]) if len(parts) > 2 and parts[2] else None
        # "nometrics" for panels that are not reconstructions (e.g. an amplified residual),
        # where a PSNR against the original would be meaningless.
        metrics = not (len(parts) > 3 and parts[3] == "nometrics")
        panels.append((img, parts[1], nbytes, psnr(img, target) if metrics else None))

    s = args.size * args.scale
    gap, top, bottom = 18, 62 if args.title else 26, 84
    W = len(panels) * s + (len(panels) + 1) * gap
    fig = Image.new("RGB", (W, top + s + bottom), (255, 255, 255))
    d = ImageDraw.Draw(fig)
    if args.title:
        d.text((gap, 20), args.title, fill=(0, 0, 0), font=font(19, bold=True))

    for i, (img, label, nbytes, db) in enumerate(panels):
        x = gap + i * (s + gap)
        fig.paste(img.resize((s, s), Image.NEAREST), (x, top))
        d.rectangle([x, top, x + s, top + s], outline=(70, 70, 70))
        low = label.lower()
        colour = (170, 30, 30) if ("old" in low or "greedy" in low) else (0, 0, 0)
        d.text((x, top + s + 8), label, fill=colour, font=font(15))
        if db is not None:
            size = f"{nbytes/1024:.1f} KB  ·  {nbytes*8/px:.2f} bpp  ·  " if nbytes else ""
            quality = "identical to original" if db >= 100 else f"{db:.1f} dB"
            d.text((x, top + s + 28), f"{size}{quality}", fill=colour, font=font(14))
        if db is not None:
            print(f"{label:<34} {db:6.2f} dB" + (f"   {nbytes/1024:.1f} KB" if nbytes else ""))

    if args.caption:
        d.text((gap, top + s + 58), args.caption, fill=(90, 90, 90), font=font(13))
    fig.save(args.out)
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
