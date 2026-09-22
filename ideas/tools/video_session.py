#!/usr/bin/env python3
"""
Side-by-side video of one simulated session: what two viewers put on screen, frame by
frame, with their memory, requests and downloads counting live underneath and the memory
curve drawn as it happens. Real time, 30 fps, 1920x1080 H.264.

Frames come from tools/session_sim.py --frames (real tiles, composited the way a viewer
draws them); the counters come from the same run's timeline.csv.

  python3 tools/video_session.py out/session/eso_video --left A --right F \
      --title "ESO Milky Way, 471 MP" --out out/video_eso.mp4
"""

import argparse
import csv
import json
import os
import subprocess

from PIL import Image, ImageDraw, ImageFont

W, H = 1920, 1080
FPS = 30
PW, PH = 928, 522                        # each screen panel
XL, XR, PY = 24, 968, 150

NAME = {"A": "EarthCam-style viewer", "C": "Our protocol, no prediction", "F": "Our protocol, JPEG tiles",
        "S": "Our protocol, Gaussian splats"}
HOW = {"A": "one request per tile, for every zoom level passed; nothing cancelled, nothing freed",
       "C": "viewport messages, stale tiles cancelled, 50 MB compressed cache",
       "F": "viewport messages, stale tiles cancelled, 50 MB compressed cache, zoom prediction",
       "S": "same protocol; zoom levels 3+ sent as 4000 splats per tile (11 B each), JPEG only deepest"}
TINT = {"A": (255, 107, 91), "C": (120, 200, 255), "F": (80, 220, 130), "S": (190, 140, 255)}
BG, FG, DIM, PANEL = (18, 20, 24), (236, 238, 240), (150, 156, 164), (40, 44, 50)


def font(size, bold=False):
    path = ("/System/Library/Fonts/Supplemental/Arial Bold.ttf" if bold
            else "/System/Library/Fonts/Supplemental/Arial.ttf")
    for p in (path, "/System/Library/Fonts/Helvetica.ttc"):
        try:
            return ImageFont.truetype(p, size)
        except Exception:
            continue
    return ImageFont.load_default()


def quality(db):
    if db >= 59.9:
        return "exact", (80, 220, 130)
    if db >= 40:
        return f"sharp ({db:.0f} dB)", (80, 220, 130)
    if db >= 30:
        return f"soft ({db:.0f} dB)", (240, 190, 70)
    return f"blurry ({db:.0f} dB)", (255, 107, 91)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("run")
    ap.add_argument("--left", default="A")
    ap.add_argument("--right", default="F")
    ap.add_argument("--title", default="")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    with open(os.path.join(args.run, "summary.json")) as f:
        summary = json.load(f)
    rows = {}
    with open(os.path.join(args.run, "timeline.csv")) as f:
        for r in csv.DictReader(f):
            rows.setdefault(r["strategy"], []).append(r)
    L, R = rows[args.left], rows[args.right]
    n = min(len(L), len(R))
    T = float(L[n - 1]["t"])
    mem = {k: [float(r["mem_mb"]) for r in rows[k][:n]] for k in (args.left, args.right)}
    mem_max = max(max(v) for v in mem.values())
    scale_top = max(100, int(mem_max / 100 + 1) * 100)

    # Static layer: titles, chart frame, gesture shading.
    base = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(base)
    d.text((XL, 16), f"{args.title}   ·   same session, same network "
           f"({summary['mbps']:g} Mbit/s, {summary['rtt_ms']:g} ms RTT)", fill=FG, font=font(30, True))
    for k, x in ((args.left, XL), (args.right, XR)):
        d.text((x, 96), NAME.get(k, k), fill=TINT.get(k, FG), font=font(26, True))
        d.text((x, 126), HOW.get(k, ""), fill=DIM, font=font(15))

    cx0, cx1, cy0, cy1 = 90, W - 30, 870, 1050
    d.text((XL, 842), "Memory held over the session", fill=DIM, font=font(18, True))
    start = None
    for i in range(n):
        moving = L[i]["phase"] != "hold"
        if moving and start is None:
            start = i
        if start is not None and (not moving or i == n - 1):
            xa = cx0 + (cx1 - cx0) * float(L[start]["t"]) / T
            xb = cx0 + (cx1 - cx0) * float(L[i]["t"]) / T
            d.rectangle([xa, cy0, xb, cy1], fill=(30, 33, 38))
            start = None
    d.rectangle([cx0, cy0, cx1, cy1], outline=PANEL)
    for v in range(0, scale_top + 1, max(50, scale_top // 4)):
        y = cy1 - (cy1 - cy0) * v / scale_top
        d.line([cx0, y, cx1, y], fill=(38, 42, 48))
        d.text((24, y - 9), f"{v} MB", fill=DIM, font=font(14))
    yb = cy1 - (cy1 - cy0) * summary["budget_mb"] / scale_top
    for x in range(cx0, cx1, 14):
        d.line([x, yb, x + 6, yb], fill=(110, 116, 124))
    for s in range(0, int(T) + 1, 5):
        x = cx0 + (cx1 - cx0) * s / T
        d.text((x - 8, cy1 + 6), f"{s}s", fill=DIM, font=font(13))

    def cx(i):
        return cx0 + (cx1 - cx0) * float(L[i]["t"]) / T

    def cy(v):
        return cy1 - (cy1 - cy0) * min(v, scale_top) / scale_top

    ff = subprocess.Popen(["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24",
                           "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-", "-c:v", "libx264",
                           "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p",
                           "-movflags", "+faststart", args.out], stdin=subprocess.PIPE)

    def frame(i, final=False):
        img = base.copy()
        d = ImageDraw.Draw(img)
        t = float(L[i]["t"])
        ph = L[i]["phase"]
        if ph == "zoom":
            prev = float(L[i - 1]["scale"]) if i else float(L[i]["scale"])
            ph_txt, ph_col = ("zooming in" if float(L[i]["scale"]) < prev else "zooming out"), (240, 190, 70)
        elif ph == "pan":
            ph_txt, ph_col = "panning", (240, 190, 70)
        else:
            ph_txt, ph_col = "still", DIM
        d.text((XL, 56), f"t = {t:4.1f} s", fill=FG, font=font(24, True))
        d.text((XL + 150, 56), ph_txt, fill=ph_col, font=font(24, True))

        for k, rs, x in ((args.left, L, XL), (args.right, R, XR)):
            r = rs[i]
            shot = Image.open(os.path.join(args.run, "frames", k, f"{i:05d}.jpg")).convert("RGB")
            img.paste(shot.resize((PW, PH), Image.BILINEAR), (x, PY))
            d.rectangle([x - 1, PY - 1, x + PW, PY + PH], outline=TINT.get(k, FG), width=2)

            y = PY + PH + 12
            m = float(r["mem_mb"])
            d.text((x, y), f"{m:,.0f} MB", fill=TINT.get(k, FG), font=font(40, True))
            d.text((x + 190, y + 16), "memory held", fill=DIM, font=font(17))
            q, qc = quality(float(r["psnr"]))
            d.text((x + 560, y + 4), "screen:", fill=DIM, font=font(20))
            d.text((x + 640, y + 2), q, fill=qc, font=font(24, True))
            by = y + 54
            d.rectangle([x, by, x + PW, by + 14], fill=PANEL)
            d.rectangle([x, by, x + PW * min(m, scale_top) / scale_top, by + 14], fill=TINT.get(k, FG))
            xb = x + PW * summary["budget_mb"] / scale_top
            d.line([xb, by - 4, xb, by + 18], fill=FG, width=2)
            d.text((x, by + 24), f"requests sent  {int(r['up_msgs']):,}", fill=FG, font=font(22))
            d.text((x + 330, by + 24), f"downloaded  {float(r['down_mb']):.1f} MB", fill=FG, font=font(22))
            d.text((x + 660, by + 24), f"tiles received  {int(r['items']):,}", fill=DIM, font=font(20))

        for k in (args.left, args.right):
            pts = [(cx(j), cy(mem[k][j])) for j in range(0, i + 1)]
            if len(pts) > 1:
                d.line(pts, fill=TINT.get(k, FG), width=3)
        d.line([cx(i), cy0, cx(i), cy1], fill=(90, 96, 104), width=1)
        d.text((cx0 + 8, yb - 20), f"{summary['budget_mb']:.0f} MB budget", fill=DIM, font=font(13))

        if final:
            ov = Image.new("RGBA", (W, H), (0, 0, 0, 0))
            od = ImageDraw.Draw(ov)
            od.rectangle([360, 230, 1560, 620], fill=(12, 14, 17, 235), outline=(90, 96, 104))
            img = Image.alpha_composite(img.convert("RGBA"), ov).convert("RGB")
            d = ImageDraw.Draw(img)
            d.text((400, 260), f"After {T:.0f} seconds of browsing", fill=FG, font=font(34, True))
            for j, (k, rs) in enumerate(((args.left, L), (args.right, R))):
                r = rs[n - 1]
                peak = max(mem[k])
                y = 330 + j * 130
                d.text((400, y), NAME.get(k, k), fill=TINT.get(k, FG), font=font(28, True))
                d.text((400, y + 42), f"peak memory {peak:,.0f} MB   ·   {int(r['up_msgs']):,} requests   ·   "
                       f"{float(r['down_mb']):.1f} MB downloaded", fill=FG, font=font(26))
        return img

    for i in range(n):
        ff.stdin.write(frame(i).tobytes())
        if i % 150 == 0:
            print(f"  frame {i}/{n}", flush=True)
    card = frame(n - 1, final=True).tobytes()
    for _ in range(FPS * 5):
        ff.stdin.write(card)
    ff.stdin.close()
    ff.wait()
    print(f"wrote {args.out}  ({n / FPS:.0f} s + 5 s summary)")


if __name__ == "__main__":
    main()
