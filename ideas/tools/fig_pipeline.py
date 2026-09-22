#!/usr/bin/env python3
"""
Figure: how an image is processed, drawn from a real ingested tile store.

  1. Ingest (once): the original is cut into a ladder of levels, each 1.25x smaller than the
     last, each level cut into 256x256 JPEG tiles.
  2. Viewing (live): the browser reports where it is looking; the server works out the level
     and the tiles that cover the view, and sends them nearest-the-centre first. The screen
     fills in from a coarse overview to full detail.

  python3 tools/fig_pipeline.py images/.tiles/holbein_8000.jpg --name "Holbein painting" \
      --cx 0.55 --cy 0.28 --scale 2.2 --out out/fig_pipeline.png
"""

import argparse
import math
import os
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from session_sim import VH, VW, Store, clamp_cam, compose  # noqa: E402

INK, DIM, ACCENT, GRID = (20, 20, 20), (100, 100, 100), (30, 150, 80), (255, 255, 255)


def font(size, bold=False):
    path = ("/System/Library/Fonts/Supplemental/Arial Bold.ttf" if bold
            else "/System/Library/Fonts/Supplemental/Arial.ttf")
    for p in (path, "/System/Library/Fonts/Helvetica.ttc"):
        try:
            return ImageFont.truetype(p, size)
        except Exception:
            continue
    return ImageFont.load_default()


def assemble(st, L, tx0=0, ty0=0, tx1=None, ty1=None):
    ntx, nty = st.ntiles(L)
    tx1 = ntx - 1 if tx1 is None else tx1
    ty1 = nty - 1 if ty1 is None else ty1
    lw, lh = st.dims[L]
    w = min(lw, (tx1 + 1) * st.T) - tx0 * st.T
    h = min(lh, (ty1 + 1) * st.T) - ty0 * st.T
    out = np.zeros((h, w, 3), np.uint8)
    for ty in range(ty0, ty1 + 1):
        for tx in range(tx0, tx1 + 1):
            p = st.pixels((L, tx, ty))
            y, x = (ty - ty0) * st.T, (tx - tx0) * st.T
            out[y:y + p.shape[0], x:x + p.shape[1]] = p
    return Image.fromarray(out)


def view_grid(st, cam, gh):
    """The ideal level's tiles around a view, gh pixels tall: the screen as a green box, the
    tiles that overlap it numbered in the order the server sends them (nearest the centre
    first), the tiles outside it faded."""
    L = st.ideal_level(cam[2])
    vis = sorted(st.visible(L, cam), key=st.priority(cam))
    txs = [k[1] for k in vis]
    tys = [k[2] for k in vis]
    ntx, nty = st.ntiles(L)
    bx0, bx1 = max(0, min(txs) - 1), min(ntx - 1, max(txs) + 1)
    by0, by1 = max(0, min(tys) - 1), min(nty - 1, max(tys) + 1)
    region = assemble(st, L, bx0, by0, bx1, by1)
    gw = int(region.width * gh / region.height)
    k = gh / region.height
    grid = region.resize((gw, gh), Image.BILINEAR).convert("RGBA")
    mask = Image.new("L", grid.size, 255)
    md = ImageDraw.Draw(mask)
    for key in vis:
        md.rectangle([(key[1] - bx0) * st.T * k, (key[2] - by0) * st.T * k,
                      (key[1] - bx0 + 1) * st.T * k, (key[2] - by0 + 1) * st.T * k], fill=0)
    shade = Image.new("RGBA", grid.size, (255, 255, 255, 0))
    shade.paste((255, 255, 255, 170), mask=mask)
    grid = Image.alpha_composite(grid, shade)
    gd = ImageDraw.Draw(grid)
    for i in range(bx1 - bx0 + 2):
        gd.line([i * st.T * k, 0, i * st.T * k, gh], fill=(255, 255, 255, 200), width=1)
    for j in range(by1 - by0 + 2):
        gd.line([0, j * st.T * k, gw, j * st.T * k], fill=(255, 255, 255, 200), width=1)
    ls = st.ls(L)
    vx0 = ((cam[0] - VW * cam[2] / 2) / ls - bx0 * st.T) * k
    vy0 = ((cam[1] - VH * cam[2] / 2) / ls - by0 * st.T) * k
    gd.rectangle([vx0, vy0, vx0 + VW * cam[2] / ls * k, vy0 + VH * cam[2] / ls * k],
                 outline=ACCENT + (255,), width=5)
    f = font(15, True)
    for n, key in enumerate(vis, 1):
        cxp = ((key[1] - bx0) + 0.5) * st.T * k
        cyp = ((key[2] - by0) + 0.5) * st.T * k
        gd.ellipse([cxp - 15, cyp - 15, cxp + 15, cyp + 15], fill=(255, 255, 255, 230), outline=INK)
        gd.text((cxp - gd.textlength(str(n), font=f) / 2, cyp - 9), str(n), fill=INK, font=f)
    return grid.convert("RGB")


def arrow(d, x0, y, x1):
    d.line([x0, y, x1, y], fill=DIM, width=4)
    d.polygon([(x1, y), (x1 - 14, y - 9), (x1 - 14, y + 9)], fill=DIM)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("store")
    ap.add_argument("--name", default="")
    ap.add_argument("--file", default="", help="original file name, for the label")
    ap.add_argument("--cx", type=float, default=0.5)
    ap.add_argument("--cy", type=float, default=0.5)
    ap.add_argument("--scale", type=float, default=2.2)
    ap.add_argument("--levels", default="", help="levels to show in the ladder, e.g. 16,13,10,5,0")
    ap.add_argument("--first", type=int, default=8, help="tiles arrived in the middle frame")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    st = Store(args.store)
    total_tiles = sum(st.ntiles(L)[0] * st.ntiles(L)[1] for L in range(st.maxL + 1))
    total_mb = sum(os.path.getsize(os.path.join(dp, f)) for dp, _, fs in os.walk(st.path)
                   for f in fs if f.endswith(".jpg")) / 1048576
    levels = ([int(v) for v in args.levels.split(",")] if args.levels
              else sorted({st.maxL, st.maxL - 3, st.maxL - 6, max(0, st.maxL - 11), 0}, reverse=True))

    W, gap = 2240, 28
    fig = Image.new("RGB", (W, 2000), (255, 255, 255))
    d = ImageDraw.Draw(fig)
    d.text((gap, 18), f"How the image is processed  -  {args.name}, {st.W:,} x {st.H:,} px "
           f"({st.W * st.H / 1e6:.0f} MP)", fill=INK, font=font(28, True))

    # ---- 1. ingest ------------------------------------------------------------------------
    y0 = 78
    d.text((gap, y0), "1   INGEST  (once per image, on the server, before anyone views it)", fill=ACCENT,
           font=font(22, True))
    d.text((gap, y0 + 30), f"The original is read in strips, shrunk into a ladder of {st.maxL + 1} levels "
           f"(each 1.25x smaller than the one below), and every level is cut into {st.T}x{st.T} JPEG tiles. "
           f"Result: {total_tiles:,} small files, {total_mb:.0f} MB. The original is never opened again.",
           fill=DIM, font=font(17))

    ph = 360
    base = assemble(st, max(min(levels), 5) if st.maxL >= 5 else 0)
    aspect = st.W / st.H
    pw = int(ph * aspect)
    x = gap
    ytop = y0 + 72
    thumb = base.resize((pw, ph), Image.BILINEAR)
    fig.paste(thumb, (x, ytop))
    d.rectangle([x, ytop, x + pw, ytop + ph], outline=INK, width=2)
    d.text((x, ytop + ph + 8), "the original file", fill=INK, font=font(17, True))
    d.text((x, ytop + ph + 30), args.file or f"{st.W}x{st.H}", fill=DIM, font=font(15))
    d.text((x, ytop + ph + 50), "never sent, never loaded whole", fill=DIM, font=font(15))
    x += pw + 20
    arrow(d, x, ytop + ph // 2, x + 50)
    x += 70

    for L in levels:
        lw, lh = st.dims[L]
        src = assemble(st, L) if L >= 5 or st.maxL < 5 else base
        img = src.resize((pw, ph), Image.BILINEAR if (lw >= pw) else Image.NEAREST)
        ov = img.convert("RGBA")
        od = ImageDraw.Draw(ov)
        cell = st.T / lw * pw
        ntx, nty = st.ntiles(L)
        for i in range(1, ntx):
            od.line([i * cell, 0, i * cell, ph], fill=GRID + (170,), width=1)
        for j in range(1, nty):
            od.line([0, j * cell, pw, j * cell], fill=GRID + (170,), width=1)
        fig.paste(ov.convert("RGB"), (x, ytop))
        d.rectangle([x, ytop, x + pw, ytop + ph], outline=INK, width=2)
        kb = np.mean([st.nbytes((L, tx, ty)) for tx in range(ntx) for ty in range(nty)]) / 1024
        d.text((x, ytop + ph + 8), f"level {L}", fill=INK, font=font(17, True))
        d.text((x, ytop + ph + 30), f"{lw:,} x {lh:,} px", fill=DIM, font=font(15))
        d.text((x, ytop + ph + 50), f"{ntx * nty:,} tile{'s' if ntx * nty > 1 else ''}, ~{kb:.0f} KB each",
               fill=DIM, font=font(15))
        x += pw + 22

    # ---- 2. viewing -------------------------------------------------------------------------
    y1 = ytop + ph + 100
    d.text((gap, y1), "2   VIEWING  (live, for every pan and zoom)", fill=ACCENT, font=font(22, True))
    cam = clamp_cam(st, args.cx * st.W, args.cy * st.H, args.scale)
    L = st.ideal_level(cam[2])
    vis = sorted(st.visible(L, cam), key=st.priority(cam))
    order = {k: i + 1 for i, k in enumerate(vis)}
    d.text((gap, y1 + 30),
           f"The browser sends one small message: \"I am looking at centre ({cam[0]:,.0f}, {cam[1]:,.0f}), "
           f"{cam[2]:.1f} source pixels per screen pixel, on a {VW}x{VH} screen\".  The server picks level {L} "
           f"(the coarsest with at least screen resolution), finds the {len(vis)} tiles that overlap the view, "
           f"skips any the browser already has,", fill=DIM, font=font(17))
    d.text((gap, y1 + 52), "and sends the rest nearest-the-centre first. If the view changes before it is "
           "done, the unsent ones are dropped.", fill=DIM, font=font(17))

    ytop2 = y1 + 92
    gh = 560
    grid = view_grid(st, cam, gh)
    gw = grid.width
    fig.paste(grid, (gap, ytop2))
    d.rectangle([gap, ytop2, gap + gw, ytop2 + gh], outline=INK, width=2)
    d.text((gap, ytop2 + gh + 8), f"level {L} around the view  -  green box = the screen, "
           f"numbers = the order the server sends tiles", fill=INK, font=font(16, True))
    d.text((gap, ytop2 + gh + 30), "faded tiles are outside the view and are not sent", fill=DIM, font=font(15))

    # The screen filling in: overview only -> first tiles -> all.
    anchor = st.ideal_level(max(st.W / VW, st.H / VH))
    first = set(vis[:args.first])
    stages = [(lambda key: key[0] >= anchor, "before any tile arrives: the overview it always keeps, stretched"),
              (lambda key: key[0] >= anchor or key in first, f"after the first {args.first} tiles: the centre is sharp"),
              (lambda key: key[0] >= anchor or key in order, f"after all {len(vis)} tiles: exact")]
    fx = gap + gw + 60
    arrow(d, gap + gw + 12, ytop2 + gh // 2, fx - 10)
    sw2 = (W - fx - gap - 20) // 2
    sh2 = int(sw2 * VH / VW)
    spots = [(fx, ytop2), (fx + sw2 + 20, ytop2), (fx, ytop2 + sh2 + 60)]
    for (drawable, label), (sx, sy) in zip(stages, spots):
        frame, _, _, _ = compose(st, cam, drawable, st.pixels)
        fig.paste(Image.fromarray(frame).resize((sw2, sh2), Image.BILINEAR), (sx, sy))
        d.rectangle([sx, sy, sx + sw2, sy + sh2], outline=ACCENT, width=3)
        d.text((sx, sy + sh2 + 8), label, fill=INK, font=font(15, True))
    nx, ny = fx + sw2 + 20, ytop2 + sh2 + 60
    notes = ["In the browser, each tile:",
             f"  arrives as a ~{np.mean([st.nbytes(kk) for kk in vis]) / 1024:.0f} KB JPEG",
             "  is decoded to a 256 KB bitmap to be drawn",
             "  is drawn coarse levels first, finer on top,",
             "  so there are never holes, only soft areas",
             "  is evicted when the memory budget is full",
             "",
             "Nothing is sent that the screen cannot show:",
             f"  this view needs {len(vis)} tiles, about "
             f"{sum(st.nbytes(kk) for kk in vis) / 1048576:.1f} MB,",
             f"  out of {total_tiles:,} tiles ({total_mb:.0f} MB) in the store."]
    for i, ln in enumerate(notes):
        d.text((nx, ny + i * 24), ln, fill=INK if not ln.startswith("  ") else DIM,
               font=font(17, not ln.startswith("  ") and ln != ""))

    fig = fig.crop((0, 0, W, max(ytop2 + gh + 60, ny + len(notes) * 24 + 20, spots[2][1] + sh2 + 40)))
    fig.save(args.out)
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
