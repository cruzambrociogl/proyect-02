#!/usr/bin/env python3
"""
Figure: what losing bytes does to a splat tile, against what it does to a JPEG tile.

Reads the CSVs and renders written by tools/splat_loss.py (additive run and --normalized
run) and draws the quality curves next to the pictures at 20% loss.

  python3 tools/fig_loss.py out/loss --out out/fig_splat_loss.png
"""

import argparse
import csv
import os

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from PIL import Image, ImageDraw, ImageFile, ImageFont  # noqa: E402

ImageFile.LOAD_TRUNCATED_IMAGES = True      # a cut-short JPEG will not open otherwise


def font(size, bold=False):
    path = ("/System/Library/Fonts/Supplemental/Arial Bold.ttf" if bold
            else "/System/Library/Fonts/Supplemental/Arial.ttf")
    for p in (path, "/System/Library/Fonts/Helvetica.ttc"):
        try:
            return ImageFont.truetype(p, size)
        except Exception:
            continue
    return ImageFont.load_default()


def read(path):
    with open(path) as f:
        rows = list(csv.DictReader(f))
    return {k: [float(r[k]) for r in rows] for k in rows[0]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("run")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    add = read(os.path.join(args.run, "loss.csv"))
    nor = read(os.path.join(args.run, "loss_norm.csv"))

    fig, ax = plt.subplots(figsize=(8.2, 5.6))
    x = add["loss_pct"]
    ax.plot(x, add["interleaved"], "o-", color="#c0392b", lw=2, label="splats, packet loss (interleaved)")
    ax.plot(x, add["burst"], "o--", color="#e08e7a", lw=1.6, label="splats, packet loss (not interleaved)")
    ax.plot(x, add["cut_short"], "o-", color="#8e44ad", lw=2, label="splats, stream cut short (best blobs first)")
    ax.plot(x, nor["interleaved"], "s-", color="#2e6fd8", lw=2,
            label="weight-normalised splats, packet loss")
    ax.plot(x[1:], add["jpeg"][1:], "^-", color="#1e9e5a", lw=2, label="JPEG, stream cut short")
    ax.annotate("JPEG with nothing lost: exact", xy=(0, 38.5), fontsize=9, color="#1e9e5a")
    ax.set_xlabel("% of the tile's bytes that never arrive")
    ax.set_ylabel("quality of the tile (dB)")
    ax.set_title("Losing bytes: splats vs JPEG\nmean of 3 Holbein tiles, 4000 splats (43 KB) vs JPEG (14 KB)",
                 fontsize=12, fontweight="bold", loc="left")
    ax.grid(alpha=0.3)
    ax.set_ylim(8, 40)
    ax.legend(fontsize=9, loc="upper right")
    fig.tight_layout()
    chart = os.path.join(os.path.dirname(args.out), "_loss_chart.png")
    fig.savefig(chart, dpi=130)
    plt.close(fig)

    panels = [("lost0_splats.png", "splats, nothing lost", add["interleaved"][0]),
              ("lost20_interleaved.png", "splats, 20% lost (interleaved)", add["interleaved"][3]),
              ("lost20_burst.png", "splats, 20% lost (not interleaved)", add["burst"][3]),
              ("lost20_interleaved_norm.png", "normalised splats, 20% lost", nor["interleaved"][3]),
              ("lost20_cutshort.png", "splats, cut short at 80%", add["cut_short"][3]),
              ("lost20_jpeg.jpg", "JPEG, cut short at 80%", add["jpeg"][3])]

    ch = Image.open(chart)
    s, gap, lab = 236, 16, 46
    cols = 3
    grid_w = cols * s + (cols + 1) * gap
    W = ch.width + grid_w
    H = max(ch.height, 2 * (s + lab) + 3 * gap + 40)
    fig_img = Image.new("RGB", (W, H), (255, 255, 255))
    fig_img.paste(ch, (0, 0))
    d = ImageDraw.Draw(fig_img)
    d.text((ch.width + gap, 12), "The same tile, 20% of its bytes gone", fill=(0, 0, 0), font=font(16, True))
    for i, (name, label, db) in enumerate(panels):
        px = ch.width + gap + (i % cols) * (s + gap)
        py = 40 + (i // cols) * (s + lab + gap)
        im = Image.open(os.path.join(args.run, name)).convert("RGB").resize((s, s), Image.NEAREST)
        fig_img.paste(im, (px, py))
        d.rectangle([px, py, px + s, py + s], outline=(70, 70, 70))
        d.text((px, py + s + 6), label, fill=(0, 0, 0), font=font(12, True))
        d.text((px, py + s + 22), f"{db:.1f} dB", fill=(90, 90, 90), font=font(12))
    fig_img.save(args.out)
    os.remove(chart)
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
