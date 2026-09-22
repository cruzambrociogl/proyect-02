#!/usr/bin/env python3
"""
Decode .splat files the way the browser will, draw them, and compare with the tile they were
fitted to. Run this before trusting a long fitting run, and whenever the record layout
changes: it is the only check that the encoder and the decoder agree.

  python3 tools/verify_splats.py RASTER_DIR SPLAT_DIR --units 5/2_3 5/2_4 --out /tmp/check.png
"""

import argparse
import math
import os
import struct

import numpy as np
import torch
from PIL import Image

from fit_splats import (AMP_MAX, AMP_MIN, MAGIC, MAGIC_NORMALIZED, POS_MARGIN, RECORD,
                        SIGMA_MAX, SIGMA_MIN, device, render)


def is_normalized(path):
    """Whether a .splat file's blobs are averaged by weight (SPLN) or added (SPL1)."""
    with open(path, "rb") as f:
        return f.read(4) == MAGIC_NORMALIZED


def decode(path):
    """The client's side of the record layout: bytes back to splat parameters."""
    raw = open(path, "rb").read()
    assert raw[:4] in (MAGIC, MAGIC_NORMALIZED), f"{path} is not a splat file"
    n, w, h = struct.unpack(">HHH", raw[4:10])
    body = np.frombuffer(raw, dtype=np.uint8, count=n * RECORD, offset=10).reshape(n, RECORD)

    dx = (body[:, 0].astype(np.int32) << 8) | body[:, 1]
    dy = (body[:, 2].astype(np.int32) << 8) | body[:, 3]
    lo_x, hi_x = -POS_MARGIN, (w - 1) + POS_MARGIN
    lo_y, hi_y = -POS_MARGIN, (h - 1) + POS_MARGIN
    x = lo_x + dx * (hi_x - lo_x) / 65535.0
    y = lo_y + dy * (hi_y - lo_y) / 65535.0

    def from_log(code, lo, hi):
        return np.exp(math.log(lo) + code / 255.0 * (math.log(hi) - math.log(lo)))

    sx = from_log(body[:, 4].astype(np.float64), SIGMA_MIN, SIGMA_MAX)
    sy = from_log(body[:, 5].astype(np.float64), SIGMA_MIN, SIGMA_MAX)
    theta = body[:, 6].astype(np.float64) * math.pi / 255.0
    amp = from_log(body[:, 10].astype(np.float64), AMP_MIN, AMP_MAX)
    colour = body[:, 7:10].astype(np.int8).astype(np.float64)   # r, g, b as signed bytes
    colour = colour / 127.0 * amp[:, None]
    return x, y, sx, sy, theta, colour, w, h, n


def block(args):
    """Draw several units into one canvas, the way the viewer does.

    This is the measurement that counts: a unit alone is missing the blobs its neighbours
    contribute across their shared edge, so on its own it always scores low.
    """
    level, x0, y0, cols, rows = (int(v) for v in args.block.split(","))
    dev = device()
    tile = args.tile
    stitched = np.zeros((rows * tile, cols * tile, 3), np.uint8)
    drawn = np.zeros_like(stitched)
    splats = 0
    for row in range(rows):
        for col in range(cols):
            name = f"{x0 + col}_{y0 + row}"
            x, y, sx, sy, theta, colour, w, h, n = decode(
                os.path.join(args.splats, str(level), name + ".splat"))
            splats += n
            xy = torch.tensor(np.stack([x, y], 1), dtype=torch.float32, device=dev)
            log_s = torch.log(torch.tensor(np.stack([sx, sy], 1), dtype=torch.float32, device=dev))
            th = torch.tensor(theta, dtype=torch.float32, device=dev)
            col_t = torch.tensor(colour, dtype=torch.float32, device=dev)
            batch = torch.zeros(len(x), dtype=torch.long, device=dev)
            with torch.no_grad():
                # drawn clipped to this unit's own rectangle, exactly as the viewer will
                image = render(xy, log_s, th, col_t, batch, h, w, args.patch,
                               is_normalized(os.path.join(args.splats, str(level), name + ".splat")))[0]
            piece_drawn = (image.clamp(0, 1).permute(1, 2, 0).cpu().numpy() * 255).astype(np.uint8)
            piece = np.asarray(Image.open(os.path.join(args.raster, str(level), name + ".jpg"))
                               .convert("RGB"), dtype=np.uint8)
            stitched[row * tile:row * tile + piece.shape[0],
                     col * tile:col * tile + piece.shape[1]] = piece
            drawn[row * tile:row * tile + h, col * tile:col * tile + w] = piece_drawn

    H, W = stitched.shape[:2]
    xy = None

    mse = float(np.mean((drawn.astype(np.float64) - stitched.astype(np.float64)) ** 2))
    psnr = 10 * math.log10(255.0 ** 2 / mse) if mse else 99.0
    print(f"level {level}, {cols}x{rows} units drawn together: {splats} splats, {psnr:.2f} dB")

    # How much worse are the pixels near unit borders than the middle? That is the seam.
    edge = np.zeros((H, W), bool)
    for c in range(cols + 1):
        edge[:, max(0, c * tile - 3):c * tile + 3] = True
    for r in range(rows + 1):
        edge[max(0, r * tile - 3):r * tile + 3, :] = True
    err = ((drawn.astype(np.float64) - stitched.astype(np.float64)) ** 2).mean(axis=2)
    print(f"  mean squared error at unit borders {err[edge].mean():.1f}, "
          f"inside {err[~edge].mean():.1f}")

    if args.out:
        sheet = Image.new("RGB", (W * 2 + 10, H), (255, 255, 255))
        sheet.paste(Image.fromarray(stitched), (0, 0))
        sheet.paste(Image.fromarray(drawn), (W + 10, 0))
        sheet.save(args.out)
        print(f"wrote {args.out}  (left: the tiles, right: the splats)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("raster")
    ap.add_argument("splats")
    ap.add_argument("--units", nargs="*", default=[], help="level/x_y, each drawn on its own")
    ap.add_argument("--block", default=None,
                    help="level,x0,y0,cols,rows: draw these units together, as the viewer will")
    ap.add_argument("--patch", type=int, default=33)
    ap.add_argument("--tile", type=int, default=256)
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    if args.block:
        block(args)
        return

    dev = device()
    panels = []
    for unit in args.units:
        level, name = unit.split("/")
        x, y, sx, sy, theta, colour, w, h, n = decode(
            os.path.join(args.splats, level, name + ".splat"))
        xy = torch.tensor(np.stack([x, y], 1), dtype=torch.float32, device=dev)
        log_s = torch.log(torch.tensor(np.stack([sx, sy], 1), dtype=torch.float32, device=dev))
        th = torch.tensor(theta, dtype=torch.float32, device=dev)
        col = torch.tensor(colour, dtype=torch.float32, device=dev)
        batch = torch.zeros(len(x), dtype=torch.long, device=dev)
        with torch.no_grad():
            image = render(xy, log_s, th, col, batch, h, w, args.patch,
                           is_normalized(os.path.join(args.splats, level, name + ".splat")))[0]
        drawn = (image.clamp(0, 1).permute(1, 2, 0).cpu().numpy() * 255).astype(np.uint8)

        tile = np.asarray(Image.open(os.path.join(args.raster, level, name + ".jpg"))
                          .convert("RGB"), dtype=np.uint8)
        mse = float(np.mean((drawn.astype(np.float64) - tile.astype(np.float64)) ** 2))
        psnr = 10 * math.log10(255.0 ** 2 / mse) if mse else 99.0
        print(f"{unit}: {n} splats ({n * RECORD / 1024:.0f} KB), {w}x{h}, {psnr:.2f} dB")
        panels.append((tile, drawn))

    if args.out:
        w = sum(p[0].shape[1] for p in panels) + 10 * (len(panels) - 1)
        h = max(p[0].shape[0] for p in panels) * 2 + 10
        sheet = Image.new("RGB", (w, h), (255, 255, 255))
        at = 0
        for tile, drawn in panels:
            sheet.paste(Image.fromarray(tile), (at, 0))
            sheet.paste(Image.fromarray(drawn), (at, tile.shape[0] + 10))
            at += tile.shape[1] + 10
        sheet.save(args.out)
        print(f"wrote {args.out}  (top: the tile, bottom: the splats)")


if __name__ == "__main__":
    main()
