#!/usr/bin/env python3
"""
Figure: how an image is processed with Gaussian splats - the counterpart of fig_pipeline.py.

  1. Ingest (once): the same ladder and tiles as the JPEG pipeline, then every tile of levels
     >= --splat-from is fitted with 4000 splats by gradient descent. One tile is fitted live
     here, so the stages, the blobs and the timing shown are real.
  2. Viewing (live): the same protocol; the server sends splat records instead of JPEGs and
     the browser draws them as blobs. The screen stages use the fitted renders in --splats.

  python3 tools/fig_pipeline_splats.py images/.tiles/holbein_8000.jpg --splats out/session/splats/holbein \
      --name "Holbein painting" --cx 0.55 --cy 0.28 --scale 2.2 --out out/fig_pipeline_splats.png
"""

import argparse
import math
import os
import sys
import time

import numpy as np
import torch
from PIL import Image, ImageDraw

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fig_pipeline import ACCENT, DIM, INK, arrow, assemble, font, view_grid  # noqa: E402
from session_sim import VH, VW, Store, clamp_cam, compose, frame_psnr, inside_mask  # noqa: E402
from splat_fit_torch import BASE_RECORD, device, fit, psnr, quantise, render  # noqa: E402

PURPLE = (120, 70, 190)


def to_img(t):
    return Image.fromarray((t.clamp(0, 1).permute(1, 2, 0).cpu().numpy() * 255).astype(np.uint8))


def blobs_panel(target, q, box, size):
    """Zoom into `box` of the tile and outline every splat centred there at one sigma."""
    xy, log_s, th = q[0].cpu().numpy(), q[1].exp().cpu().numpy(), q[2].cpu().numpy()
    x0, y0, x1, y1 = box
    z = size / (x1 - x0)
    bg = to_img(target).crop(box).resize((size, size), Image.NEAREST)
    bg = Image.blend(bg, Image.new("RGB", bg.size, (0, 0, 0)), 0.55)
    ov = Image.new("RGBA", bg.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(ov)
    tgt = target.permute(1, 2, 0).cpu().numpy()
    shown = 0
    for (cx, cy), (sx, sy), a in zip(xy, log_s, th):
        if not (x0 <= cx < x1 and y0 <= cy < y1):
            continue
        shown += 1
        pts = []
        for i in range(28):
            t = 2 * math.pi * i / 28
            u, v = sx * math.cos(t), sy * math.sin(t)
            pts.append(((cx + u * math.cos(a) - v * math.sin(a) - x0) * z,
                        (cy + u * math.sin(a) + v * math.cos(a) - y0) * z))
        col = tgt[min(int(cy), tgt.shape[0] - 1), min(int(cx), tgt.shape[1] - 1)]
        c = tuple(int(255 * v) for v in col)
        d.polygon(pts, fill=c + (110,), outline=(255, 255, 255, 190))
    return Image.alpha_composite(bg.convert("RGBA"), ov).convert("RGB"), shown


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("store")
    ap.add_argument("--splats", required=True, help="dir of fitted tile renders <level>/<tx>_<ty>.png")
    ap.add_argument("--name", default="")
    ap.add_argument("--cx", type=float, default=0.5)
    ap.add_argument("--cy", type=float, default=0.5)
    ap.add_argument("--scale", type=float, default=2.2)
    ap.add_argument("--splat-from", type=int, default=3)
    ap.add_argument("--density", type=int, default=4000)
    ap.add_argument("--iters", type=int, default=1000)
    ap.add_argument("--patch", type=int, default=33)
    ap.add_argument("--first", type=int, default=8)
    ap.add_argument("--jpeg-ingest", default="seconds", help="measured JPEG ingest time, for the comparison")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    st = Store(args.store)
    cam = clamp_cam(st, args.cx * st.W, args.cy * st.H, args.scale)
    L = st.ideal_level(cam[2])
    vis = sorted(st.visible(L, cam), key=st.priority(cam))
    key0 = vis[0]                                   # the tile at the centre of the view
    counts = [st.ntiles(lv)[0] * st.ntiles(lv)[1] for lv in range(st.maxL + 1)]
    n_splat_tiles = sum(counts[args.splat_from:])

    # ---- fit the centre tile live, keeping snapshots ---------------------------------------
    dev = device()
    tile = st.pixels(key0)
    target = torch.from_numpy(tile.astype(np.float32) / 255.0).permute(2, 0, 1).to(dev)
    _, H, W = target.shape
    n = max(16, round(args.density * W * H / (st.T * st.T)))
    stops = {0: None, 50: None, 250: None}
    t0 = time.time()

    def grab(it, img):
        if it in stops:
            if dev.type == "mps":
                torch.mps.synchronize()      # so the timestamp is when the GPU got there
            stops[it] = (img.clone(), time.time() - t0)
    params = fit(target, n, args.iters, args.patch, log=None, callback=grab)
    with torch.no_grad():
        q = quantise(*params, H, W)
        final = render(*q, H, W, args.patch)
    fit_s = time.time() - t0
    stages = [(to_img(img), f"step {it}", psnr(img, target), s) for it, (img, s) in sorted(stops.items())]
    stages.append((to_img(final), f"step {args.iters}, rounded to 11-byte records",
                   psnr(final, target), fit_s))
    jpeg_kb = st.nbytes(key0) / 1024
    splat_kb = n * BASE_RECORD / 1024

    # ---- canvas -----------------------------------------------------------------------------
    Wf, gap = 2240, 28
    fig = Image.new("RGB", (Wf, 2400), (255, 255, 255))
    d = ImageDraw.Draw(fig)
    d.text((gap, 18), f"How the image is processed with Gaussian splats  -  {args.name}, "
           f"{st.W:,} x {st.H:,} px ({st.W * st.H / 1e6:.0f} MP)", fill=INK, font=font(28, True))

    # ---- 1a. ladder and one tile --------------------------------------------------------------
    y0 = 78
    d.text((gap, y0), "1   INGEST  (once per image, on the server, before anyone views it)", fill=PURPLE,
           font=font(22, True))
    d.text((gap, y0 + 30), f"Same first steps as the JPEG pipeline: the original is shrunk into a ladder of "
           f"{st.maxL + 1} levels and cut into {st.T}x{st.T} tiles. Then every tile of levels {args.splat_from}+ "
           f"({n_splat_tiles:,} of {sum(counts):,} tiles) is turned into {args.density} splats; the deepest "
           f"levels 0-{args.splat_from - 1} stay JPEG.", fill=DIM, font=font(17))
    ph = 300
    ytop = y0 + 70
    x = gap
    base = assemble(st, max(5, L)) if st.maxL >= 5 else assemble(st, 0)
    pw = int(ph * st.W / st.H)
    fig.paste(base.resize((pw, ph), Image.BILINEAR), (x, ytop))
    d.rectangle([x, ytop, x + pw, ytop + ph], outline=INK, width=2)
    d.text((x, ytop + ph + 8), "the original", fill=INK, font=font(17, True))
    x += pw + 16
    arrow(d, x, ytop + ph // 2, x + 44)
    x += 60

    lw, lh = st.dims[L]
    lvl = assemble(st, L).resize((pw, ph), Image.BILINEAR).convert("RGBA")
    ld = ImageDraw.Draw(lvl)
    cell = st.T / lw * pw
    ntx, nty = st.ntiles(L)
    for i in range(1, ntx):
        ld.line([i * cell, 0, i * cell, ph], fill=(255, 255, 255, 150))
    for j in range(1, nty):
        ld.line([0, j * cell, pw, j * cell], fill=(255, 255, 255, 150))
    ld.rectangle([key0[1] * cell, key0[2] * cell, (key0[1] + 1) * cell, (key0[2] + 1) * cell],
                 outline=(255, 60, 60, 255), width=3)
    fig.paste(lvl.convert("RGB"), (x, ytop))
    d.rectangle([x, ytop, x + pw, ytop + ph], outline=INK, width=2)
    d.text((x, ytop + ph + 8), f"level {L} of the ladder ({counts[L]} tiles)", fill=INK, font=font(17, True))
    d.text((x, ytop + ph + 30), "red: the tile followed below", fill=DIM, font=font(15))
    x += pw + 16
    arrow(d, x, ytop + ph // 2, x + 44)
    x += 60

    fig.paste(Image.fromarray(tile).resize((ph, ph), Image.NEAREST), (x, ytop))
    d.rectangle([x, ytop, x + ph, ytop + ph], outline=(255, 60, 60), width=3)
    d.text((x, ytop + ph + 8), f"tile {key0[0]}/{key0[1]}_{key0[2]}, {W}x{H} px", fill=INK, font=font(17, True))
    d.text((x, ytop + ph + 30), f"as JPEG: {jpeg_kb:.1f} KB, made in milliseconds", fill=DIM, font=font(15))
    x += ph + 16
    arrow(d, x, ytop + ph // 2, x + 44)
    x += 64

    # The record layout.
    d.text((x, ytop + 4), "each splat is 11 bytes", fill=INK, font=font(19, True))
    fields = [("x", 2), ("y", 2), ("width", 1), ("height", 1), ("angle", 1), ("red", 1), ("green", 1),
              ("blue", 1), ("strength", 1)]
    bw = (Wf - gap - x) / 11
    bx = x
    by = ytop + 44
    for name, nb in fields:
        d.rectangle([bx, by, bx + nb * bw - 4, by + 50], fill=(238, 230, 250), outline=PURPLE, width=2)
        d.text((bx + 6, by + 15), name, fill=INK, font=font(14, True))
        bx += nb * bw
    lines = [f"{n:,} splats x 11 bytes = {splat_kb:.0f} KB per tile",
             f"(the JPEG of the same tile: {jpeg_kb:.1f} KB)",
             "",
             "A splat is a soft coloured blob, a 2D Gaussian:",
             "position, width and height, angle, colour and how",
             "strongly it adds light. The browser draws the tile by",
             "adding all 4000 blobs together - the image becomes",
             "a sum of functions instead of a grid of pixels."]
    for i, ln in enumerate(lines):
        d.text((x, by + 70 + i * 24), ln, fill=INK if i < 2 else DIM, font=font(17, i == 0))

    # ---- 1b. the fit, live ----------------------------------------------------------------------
    y1 = ytop + ph + 70
    d.text((gap, y1), f"Fitting that one tile  -  the slow part: {args.iters} rounds of \"draw all blobs, compare "
           f"with the tile, nudge every blob\" on the GPU", fill=INK, font=font(19, True))
    sp = 290
    x = gap
    yt = y1 + 36
    for img, label, db, s in stages:
        fig.paste(img.resize((sp, sp), Image.NEAREST), (x, yt))
        d.rectangle([x, yt, x + sp, yt + sp], outline=PURPLE, width=2)
        d.text((x, yt + sp + 8), label, fill=INK, font=font(15, True))
        d.text((x, yt + sp + 28), f"{db:.1f} dB  ·  {s:.1f} s", fill=DIM, font=font(15))
        x += sp + 18
    bs = W // 4
    box = (W // 2 - bs // 2, H // 2 - bs // 2, W // 2 + bs // 2, H // 2 + bs // 2)
    panel, shown = blobs_panel(target, q, box, sp)
    fig.paste(panel, (x, yt))
    d.rectangle([x, yt, x + sp, yt + sp], outline=PURPLE, width=2)
    d.text((x, yt + sp + 8), f"the blobs: centre {bs}x{bs} px, zoomed", fill=INK, font=font(15, True))
    d.text((x, yt + sp + 28), f"{shown} splats outlined at one sigma", fill=DIM, font=font(15))
    x += sp + 30
    total_h = n_splat_tiles * fit_s / 3600
    for i, ln in enumerate([f"This tile: {fit_s:.0f} s on the GPU.",
                            f"The whole image: {n_splat_tiles:,} tiles",
                            f"x {fit_s:.0f} s = about {total_h:.1f} hours.",
                            "",
                            f"The JPEG pipeline ingests the whole",
                            f"image in {args.jpeg_ingest}.",
                            "",
                            "There is no formula from pixels",
                            "to blobs: they have to be",
                            "searched for, tile by tile."]):
        d.text((x, yt + i * 26), ln, fill=INK if i < 3 else DIM, font=font(17, i == 0))

    # ---- 2. viewing -------------------------------------------------------------------------------
    y2 = yt + sp + 80
    d.text((gap, y2), "2   VIEWING  (live, for every pan and zoom)", fill=PURPLE, font=font(22, True))
    d.text((gap, y2 + 30), f"Same protocol as the JPEG version: the browser reports its view, the server picks level {L}, "
           f"finds the {len(vis)} tiles that overlap it and sends them nearest-the-centre first. The difference is what "
           f"travels: {splat_kb:.0f} KB of splat records per tile", fill=DIM, font=font(17))
    d.text((gap, y2 + 52), f"instead of a ~{np.mean([st.nbytes(k) for k in vis]) / 1024:.0f} KB JPEG, and what the "
           "browser does with it: no decoding - the records go straight to the GPU, which draws every blob.",
           fill=DIM, font=font(17))
    yv = y2 + 92
    gh = 560
    grid = view_grid(st, cam, gh)
    fig.paste(grid, (gap, yv))
    d.rectangle([gap, yv, gap + grid.width, yv + gh], outline=INK, width=2)
    d.text((gap, yv + gh + 8), f"level {L} around the view  -  green box = the screen, numbers = send order",
           fill=INK, font=font(16, True))

    missing = set()
    cache = {}

    def spix(k):
        if k[0] < args.splat_from:
            return st.pixels(k)
        if k not in cache:
            p = os.path.join(args.splats, str(k[0]), f"{k[1]}_{k[2]}.png")
            if not os.path.exists(p):
                missing.add(k)
                return st.pixels(k)
            cache[k] = np.asarray(Image.open(p).convert("RGB"))
        return cache[k]

    anchor = st.ideal_level(max(st.W / VW, st.H / VH))
    first = set(vis[:args.first])
    allv = set(vis)
    ideal, _, _, _ = compose(st, cam, lambda k: True, st.pixels)
    inside = inside_mask(st, cam)
    frames = []
    for drawable in (lambda k: k[0] >= anchor, lambda k: k[0] >= anchor or k in first,
                     lambda k: k[0] >= anchor or k in allv):
        f, _, _, _ = compose(st, cam, drawable, spix)
        frames.append((f, frame_psnr(f, ideal, inside)))
    labels = [f"before any tile arrives: the overview splats (level {anchor}), stretched",
              f"after the first {args.first} tiles",
              f"after all {len(vis)} tiles: {frames[2][1]:.1f} dB (the JPEG version: exact)"]
    fx = gap + grid.width + 60
    arrow(d, gap + grid.width + 12, yv + gh // 2, fx - 10)
    sw = (Wf - fx - gap - 20) // 2
    sh = int(sw * VH / VW)
    spots = [(fx, yv), (fx + sw + 20, yv), (fx, yv + sh + 60)]
    for (f, _), label, (sx, sy) in zip(frames, labels, spots):
        fig.paste(Image.fromarray(f).resize((sw, sh), Image.BILINEAR), (sx, sy))
        d.rectangle([sx, sy, sx + sw, sy + sh], outline=PURPLE, width=3)
        d.text((sx, sy + sh + 8), label, fill=INK, font=font(15, True))
    nx, ny = fx + sw + 20, yv + sh + 60
    n_blobs = sum(max(16, round(args.density * st.wh(k)[0] * st.wh(k)[1] / st.T ** 2)) for k in vis)
    jpeg_mb = sum(st.nbytes(k) for k in vis) / 1048576
    view_kb = np.mean([st.nbytes(k) for k in vis]) / 1024
    notes = ["In the browser, each splat tile:",
             f"  arrives as {splat_kb:.0f} KB of records (JPEG: ~{view_kb:.0f} KB)",
             "  goes to the GPU as-is: nothing to decode,",
             f"  and stays {splat_kb:.0f} KB (a JPEG becomes a 256 KB bitmap)",
             "  is drawn by adding its blobs' light together",
             "",
             "This view:",
             f"  {len(vis)} tiles = {n_blobs * BASE_RECORD / 1048576:.1f} MB to download (JPEG: {jpeg_mb:.1f} MB)",
             f"  {n_blobs:,} blobs to draw every frame",
             "  faint seams where neighbouring tiles meet:",
             "  each tile's blobs were fitted on their own"]
    for i, ln in enumerate(notes):
        d.text((nx, ny + i * 24), ln, fill=INK if not ln.startswith("  ") else DIM,
               font=font(17, not ln.startswith("  ") and ln != ""))
    if missing:
        d.text((gap, yv + gh + 34), f"WARNING: {len(missing)} tiles not fitted, JPEG stand-in used",
               fill=(200, 30, 30), font=font(16, True))
        print(f"warning: {len(missing)} splat tiles missing: {sorted(missing)[:5]}...")

    fig = fig.crop((0, 0, Wf, max(yv + gh + 70, ny + len(notes) * 24 + 20, spots[2][1] + sh + 40)))
    fig.save(args.out)
    print(f"wrote {args.out}   (live fit {fit_s:.1f} s, {stages[-1][2]:.2f} dB; view {frames[2][1]:.2f} dB)")


if __name__ == "__main__":
    main()
