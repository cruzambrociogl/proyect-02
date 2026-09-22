#!/usr/bin/env python3
"""
Side-by-side check of splat settings against the JPEG tiles, at the views a person looks at.

Each view is a block of units at one level. Every version is drawn the way the viewer draws
it - unit by unit, each clipped to its own rectangle - and scored against the JPEG tiles,
which are exactly what the tile viewer shows.

  python3 tools/compare_splats.py RASTER --version "before=DIR" --version "after=DIR" \
      --view "whole picture=7,0,0,3,4" --view "the face=3,2,3,3,2" --out /tmp/compare.png
"""

import argparse
import math
import os

import numpy as np
import torch
from PIL import Image, ImageDraw, ImageFont

from fit_splats import device, render
from verify_splats import decode, is_normalized


def font(size, bold=False):
    path = ("/System/Library/Fonts/Supplemental/Arial Bold.ttf" if bold
            else "/System/Library/Fonts/Supplemental/Arial.ttf")
    for p in (path, "/System/Library/Fonts/Helvetica.ttc"):
        try:
            return ImageFont.truetype(p, size)
        except Exception:
            continue
    return ImageFont.load_default()


def psnr(a, b):
    mse = float(np.mean((a.astype(np.float64) - b.astype(np.float64)) ** 2))
    return 10 * math.log10(255.0 ** 2 / mse) if mse else 99.0


def draw_block(raster, splat_dir, level, x0, y0, cols, rows, tile, patch, dev):
    """JPEG tiles and (optionally) splats for a block of units; returns images and bytes."""
    jpeg = None
    drawn = None
    jpeg_bytes = splat_bytes = 0
    for r in range(rows):
        for c in range(cols):
            name = f"{x0 + c}_{y0 + r}"
            jpath = os.path.join(raster, str(level), name + ".jpg")
            piece = np.asarray(Image.open(jpath).convert("RGB"), dtype=np.uint8)
            if jpeg is None:
                jpeg = np.zeros((rows * tile, cols * tile, 3), np.uint8)
                drawn = np.zeros_like(jpeg)
            h, w = piece.shape[:2]
            jpeg[r * tile:r * tile + h, c * tile:c * tile + w] = piece
            jpeg_bytes += os.path.getsize(jpath)
            if splat_dir is None:
                continue
            spath = os.path.join(splat_dir, str(level), name + ".splat")
            splat_bytes += os.path.getsize(spath)
            x, y, sx, sy, theta, colour, uw, uh, n = decode(spath)
            with torch.no_grad():
                image = render(
                    torch.tensor(np.stack([x, y], 1), dtype=torch.float32, device=dev),
                    torch.log(torch.tensor(np.stack([sx, sy], 1), dtype=torch.float32, device=dev)),
                    torch.tensor(theta, dtype=torch.float32, device=dev),
                    torch.tensor(colour, dtype=torch.float32, device=dev),
                    torch.zeros(len(x), dtype=torch.long, device=dev),
                    uh, uw, patch, is_normalized(spath))[0]
            drawn[r * tile:r * tile + uh, c * tile:c * tile + uw] = \
                (image.clamp(0, 1).permute(1, 2, 0).cpu().numpy() * 255).astype(np.uint8)
    # trim the unused edge of partial units
    ys, xs = np.nonzero(jpeg.any(axis=2))
    box = (slice(0, ys.max() + 1), slice(0, xs.max() + 1))
    return jpeg[box], (drawn[box] if splat_dir else None), jpeg_bytes, splat_bytes


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("raster")
    ap.add_argument("--version", action="append", required=True, help="label=splat dir")
    ap.add_argument("--view", action="append", required=True, help="label=level,x0,y0,cols,rows")
    ap.add_argument("--tile", type=int, default=256)
    ap.add_argument("--patch", type=int, default=33)
    ap.add_argument("--panel", type=int, default=720, help="panel width")
    ap.add_argument("--max-height", type=int, default=640)
    ap.add_argument("--title", default="")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    dev = device()
    versions = [v.split("=", 1) for v in args.version]
    views = [(v.split("=", 1)[0], [int(n) for n in v.split("=", 1)[1].split(",")]) for v in args.view]

    sections = []
    for label, (level, x0, y0, cols, rows) in views:
        jpeg, _, jbytes, _ = draw_block(args.raster, None, level, x0, y0, cols, rows,
                                        args.tile, args.patch, dev)
        row = [("JPEG tiles (what the tile viewer shows)", jpeg, f"{jbytes / 1024:.0f} KB, reference")]
        for name, directory in versions:
            _, drawn, _, sbytes = draw_block(args.raster, directory, level, x0, y0, cols, rows,
                                             args.tile, args.patch, dev)
            score = psnr(drawn, jpeg)
            row.append((f"splats, {name}", drawn,
                        f"{sbytes / 1024:.0f} KB  ·  {score:.1f} dB vs the tiles"))
            print(f"{label:<16} {name:<10} {score:6.2f} dB  {sbytes / 1024:6.0f} KB")
        sections.append((label, level, row))

    gap, head, label_h = 20, 60, 50
    widths = []
    heights = []
    for _, _, row in sections:
        h, w = row[0][1].shape[:2]
        s = min(args.panel / w, args.max_height / h)
        widths.append(s)
        heights.append(int(h * s))
    W = len(sections[0][2]) * args.panel + (len(sections[0][2]) + 1) * gap
    H = head + sum(h + label_h + 46 for h in heights) + gap
    sheet = Image.new("RGB", (W, H), (255, 255, 255))
    d = ImageDraw.Draw(sheet)
    d.text((gap, 18), args.title, fill=(0, 0, 0), font=font(22, True))
    y = head
    for (label, level, row), s, h in zip(sections, widths, heights):
        d.text((gap, y), f"{label}  (level {level})", fill=(40, 40, 40), font=font(17, True))
        y += 28
        for i, (name, image, note) in enumerate(row):
            x = gap + i * (args.panel + gap)
            w = int(image.shape[1] * s)
            resample = Image.NEAREST if s > 1 else Image.LANCZOS
            sheet.paste(Image.fromarray(image).resize((w, h), resample), (x, y))
            d.rectangle([x, y, x + w, y + h], outline=(90, 90, 90))
            d.text((x, y + h + 6), name, fill=(0, 0, 0), font=font(15, True))
            d.text((x, y + h + 26), note, fill=(90, 90, 90), font=font(14))
        y += h + label_h + 18
    sheet.save(args.out)
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
