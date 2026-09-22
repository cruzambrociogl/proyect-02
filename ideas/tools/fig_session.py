#!/usr/bin/env python3
"""
Figures for tools/session_sim.py output.

  fig_session_<name>.png    memory, on-screen quality, requests and bytes over the session,
                            one line per strategy, gestures shaded
  fig_snaps_<name>.png      what each strategy's screen shows at the snapshot moments,
                            next to the ideal frame, with PSNR and memory at that instant

  python3 tools/fig_session.py out/session/holbein --title "Holbein, 56 MP"
"""

import argparse
import csv
import json
import math
import os

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
from PIL import Image, ImageDraw, ImageFont  # noqa: E402

LABEL = {"A": "A  naive tiles (EarthCam-like)", "B": "B  ours, decoded cache",
         "C": "C  ours, compressed cache", "D": "D  ours, splats + deep tiles",
         "E": "E  C + coarse-first", "F": "F  C + predictive (animation lead)",
         "G": "G  C + coarse-first + predictive", "H": "H  C + coarse-first + velocity guess",
         "I": "I  C + velocity guess (pinch)"}
COLOUR = {"A": "#c0392b", "B": "#2e6fd8", "C": "#1e9e5a", "D": "#8e44ad",
          "E": "#e67e22", "F": "#17a2b8", "G": "#111111", "H": "#8d6e63", "I": "#d63384"}


def font(size, bold=False):
    path = ("/System/Library/Fonts/Supplemental/Arial Bold.ttf" if bold
            else "/System/Library/Fonts/Supplemental/Arial.ttf")
    for p in (path, "/System/Library/Fonts/Helvetica.ttc"):
        try:
            return ImageFont.truetype(p, size)
        except Exception:
            continue
    return ImageFont.load_default()


def load(run):
    with open(os.path.join(run, "summary.json")) as f:
        summary = json.load(f)
    series = {}
    with open(os.path.join(run, "timeline.csv")) as f:
        for row in csv.DictReader(f):
            series.setdefault(row["strategy"], []).append(row)
    return summary, series


def timelines(run, summary, series, title, out):
    kinds = list(series)
    t = {k: np.array([float(r["t"]) for r in series[k]]) for k in kinds}
    col = lambda k, name: np.array([float(r[name]) for r in series[k]])  # noqa: E731

    fig, axes = plt.subplots(4, 1, figsize=(13, 12.5), sharex=True,
                             gridspec_kw={"height_ratios": [1.3, 1.3, 0.9, 0.9]})
    first = series[kinds[0]]
    for ax in axes:
        start = None
        for i, r in enumerate(first):
            moving = r["phase"] != "hold"
            if moving and start is None:
                start = float(r["t"])
            if start is not None and (not moving or i == len(first) - 1):
                ax.axvspan(start, float(r["t"]), color="#000000", alpha=0.06, lw=0)
                start = None
        ax.grid(alpha=0.25)

    ax = axes[0]
    for k in kinds:
        ax.plot(t[k], col(k, "mem_mb"), color=COLOUR[k], lw=2, label=LABEL[k])
    ax.axhline(summary["budget_mb"], color="#555", ls=":", lw=1.2)
    ax.text(0.2, summary["budget_mb"] * 1.03, f"{summary['budget_mb']:.0f} MB budget", color="#555", fontsize=9)
    ax.set_ylabel("image data held (MB)")
    ax.set_title("Client memory - does it stay flat?", loc="left", fontsize=11, fontweight="bold")
    ax.legend(loc="upper left", fontsize=9, framealpha=0.9)

    ax = axes[1]
    for k in kinds:
        est = k == "D" and summary["splat_levels_fitted"]
        ax.plot(t[k], col(k, "psnr"), color=COLOUR[k], lw=1.4, ls="--" if est else "-",
                label=LABEL[k] + (" (estimated)" if est else ""))
    ax.axhline(40, color="#555", ls=":", lw=1)
    ax.text(0.2, 40.6, "40 dB: hard to tell from ideal", color="#555", fontsize=9)
    low = min(float(r["psnr"]) for k in kinds for r in series[k])
    ax.set_ylim(max(5, math.floor(low) - 2), 61)
    ax.set_ylabel("on-screen PSNR vs ideal (dB)")
    ax.set_title("What the screen shows - 60 = exactly the ideal frame; dips are blur while "
                 "tiles are missing", loc="left", fontsize=11, fontweight="bold")
    ax.legend(loc="lower left", fontsize=9, framealpha=0.9)

    ax = axes[2]
    for k in kinds:
        ax.plot(t[k], col(k, "up_msgs"), color=COLOUR[k], lw=2)
    ax.set_ylabel("client -> server\nmessages")
    ax.set_title("Requests (HTTP GETs for A, viewport updates for ours)", loc="left",
                 fontsize=11, fontweight="bold")

    ax = axes[3]
    for k in kinds:
        ax.plot(t[k], col(k, "down_mb"), color=COLOUR[k], lw=2)
    ax.set_ylabel("downloaded (MB)")
    ax.set_xlabel("session time (s)   -   shaded = zooming or panning")
    ax.set_title("Bandwidth", loc="left", fontsize=11, fontweight="bold")

    fig.suptitle(f"{title}   ·   {summary['mbps']:g} Mbit/s, RTT {summary['rtt_ms']:g} ms, "
                 f"viewport 1280x720", fontsize=13, fontweight="bold", x=0.01, ha="left")
    fig.tight_layout(rect=(0, 0, 1, 0.97))
    fig.savefig(out, dpi=110)
    plt.close(fig)
    print(f"wrote {out}")


def psnr(a, b):
    d = a.astype(np.float64) - b.astype(np.float64)
    mse = float(np.mean(d * d))
    return 60.0 if mse < 1e-6 else min(60.0, 10 * math.log10(255.0 ** 2 / mse))


def snapshots(run, summary, series, title, out):
    kinds = list(series)
    names = [n for n in ("dive_mid", "dive_landed", "revisit_landed")
             if os.path.exists(os.path.join(run, f"snap_{n}_ideal.png"))]
    what = {"dive_mid": "halfway through the first zoom-in",
            "dive_landed": "0.3 s after the first zoom-in stops",
            "revisit_landed": "0.3 s after zooming back into the first spot (cache test)"}
    stand_in = os.path.exists(os.path.join(run, "need_splats.txt"))
    # Centre crop at 1:1 - shrinking the whole frame would hide exactly the blur we look for.
    w, h = 480, 270
    cx0, cy0 = (1280 - w) // 2, (720 - h) // 2
    gap, head, lab = 14, 78, 44
    cols = ["ideal"] + kinds
    W = len(cols) * w + (len(cols) + 1) * gap
    H = head + len(names) * (h + lab + 30)
    fig = Image.new("RGB", (W, H), (255, 255, 255))
    d = ImageDraw.Draw(fig)
    d.text((gap, 16), f"{title}: what the screen shows", fill=(0, 0, 0), font=font(20, True))
    d.text((gap, 44), "Centre of the 1280x720 screen at 1:1. PSNR is for the whole frame against the "
           "ideal; memory is what the page holds at that instant."
           + ("  D: some splat tiles not fitted - JPEG stand-in!" if stand_in else ""),
           fill=(90, 90, 90), font=font(13))

    y = head
    for n in names:
        tsnap = summary["snapshots"][n]
        d.text((gap, y), f"t = {tsnap:.2f} s, {what[n]}", fill=(60, 60, 60), font=font(15, True))
        y += 22
        ideal = np.asarray(Image.open(os.path.join(run, f"snap_{n}_ideal.png")).convert("RGB"))
        for i, c in enumerate(cols):
            x = gap + i * (w + gap)
            img = ideal if c == "ideal" else np.asarray(
                Image.open(os.path.join(run, f"snap_{n}_{c}.png")).convert("RGB"))
            fig.paste(Image.fromarray(img[cy0:cy0 + h, cx0:cx0 + w]), (x, y))
            d.rectangle([x, y, x + w, y + h], outline=(80, 80, 80))
            if c == "ideal":
                d.text((x, y + h + 6), "ideal frame", fill=(0, 0, 0), font=font(14))
                continue
            row = min(series[c], key=lambda r: abs(float(r["t"]) - tsnap))
            colour = (170, 30, 30) if c == "A" else (0, 0, 0)
            d.text((x, y + h + 6), LABEL[c], fill=colour, font=font(14))
            d.text((x, y + h + 24), f"{psnr(img, ideal):.1f} dB   ·   {float(row['mem_mb']):.1f} MB held",
                   fill=colour, font=font(13))
        y += h + lab + 8
    fig.save(out)
    print(f"wrote {out}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("run")
    ap.add_argument("--title", default="")
    ap.add_argument("--out", default="out")
    args = ap.parse_args()
    summary, series = load(args.run)
    name = summary["name"]
    title = args.title or name
    timelines(args.run, summary, series, title, os.path.join(args.out, f"fig_session_{name}.png"))
    snapshots(args.run, summary, series, title, os.path.join(args.out, f"fig_snaps_{name}.png"))


if __name__ == "__main__":
    main()
