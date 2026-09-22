#!/usr/bin/env python3
"""
Figure: greedy vs joint splat fitting, against JPEG both ways.

Five panels, same crop:
  original | greedy splats | joint splats | JPEG at the same bytes | JPEG at the same quality

The last two are the honest framing of where splats stand: give JPEG the same byte budget
and it wins on quality; ask JPEG for the same quality and it wins on bytes. The middle two
show that the earlier rejection was measuring the fitter, not the representation.

  python3 tools/fig_splats.py --orig IMG --x 1450 --y 600 --size 256 \
      --greedy out/hat/recon_04000.png --joint out/torch_hat.png --bytes 44000 \
      --out out/fig4_splats.png
"""

import argparse
import io
import math

import numpy as np
from PIL import Image, ImageDraw, ImageFont


def psnr(a, b):
    a = np.asarray(a, dtype=np.float64) / 255.0
    b = np.asarray(b, dtype=np.float64) / 255.0
    mse = float(np.mean((a - b) ** 2))
    return 10 * math.log10(1.0 / max(mse, 1e-12))


def jpeg_bytes(img, q):
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=int(q))
    return buf.getvalue()


def jpeg_at_bytes(img, target_bytes):
    """Highest quality that fits the budget."""
    best = None
    for q in range(1, 101):
        enc = jpeg_bytes(img, q)
        if len(enc) <= target_bytes:
            best = (q, enc)
        else:
            break
    return best or (1, jpeg_bytes(img, 1))


def jpeg_at_quality(img, target_db):
    """Smallest encode that reaches the target PSNR."""
    for q in range(1, 101):
        enc = jpeg_bytes(img, q)
        got = psnr(Image.open(io.BytesIO(enc)).convert("RGB"), img)
        if got >= target_db:
            return q, enc, got
    enc = jpeg_bytes(img, 100)
    return 100, enc, psnr(Image.open(io.BytesIO(enc)).convert("RGB"), img)


def font(size, bold=False):
    for path in ("/System/Library/Fonts/Supplemental/Arial Bold.ttf" if bold
                 else "/System/Library/Fonts/Supplemental/Arial.ttf",
                 "/System/Library/Fonts/Helvetica.ttc"):
        try:
            return ImageFont.truetype(path, size)
        except Exception:
            continue
    return ImageFont.load_default()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--orig", required=True)
    ap.add_argument("--greedy", required=True)
    ap.add_argument("--joint", required=True)
    ap.add_argument("--x", type=int, default=0)
    ap.add_argument("--y", type=int, default=0)
    ap.add_argument("--size", type=int, default=256)
    ap.add_argument("--bytes", type=int, default=44000, help="splat budget being compared")
    ap.add_argument("--scale", type=int, default=2)
    ap.add_argument("--title", default="Gaussian splats: greedy vs joint optimisation")
    ap.add_argument("--out", default="out/fig4_splats.png")
    args = ap.parse_args()

    target = Image.open(args.orig).convert("RGB").crop(
        (args.x, args.y, args.x + args.size, args.y + args.size))
    greedy = Image.open(args.greedy).convert("RGB")
    joint = Image.open(args.joint).convert("RGB")

    db_greedy, db_joint = psnr(greedy, target), psnr(joint, target)
    qb, enc_b = jpeg_at_bytes(target, args.bytes)
    jpeg_same_bytes = Image.open(io.BytesIO(enc_b)).convert("RGB")
    qq, enc_q, db_q = jpeg_at_quality(target, db_joint)
    jpeg_same_quality = Image.open(io.BytesIO(enc_q)).convert("RGB")

    px = args.size * args.size
    panels = [
        (target, "original", None, None),
        (greedy, "splats, greedy fit", args.bytes, db_greedy),
        (joint, "splats, joint optimisation", args.bytes, db_joint),
        (jpeg_same_bytes, "JPEG, same bytes", len(enc_b), psnr(jpeg_same_bytes, target)),
        (jpeg_same_quality, "JPEG, same quality", len(enc_q), db_q),
    ]

    s = args.size * args.scale
    gap, top, bottom = 18, 62, 84
    W = len(panels) * s + (len(panels) + 1) * gap
    fig = Image.new("RGB", (W, top + s + bottom), (255, 255, 255))
    d = ImageDraw.Draw(fig)
    d.text((gap, 20), args.title, fill=(0, 0, 0), font=font(19, bold=True))

    for i, (img, label, nbytes, db) in enumerate(panels):
        x = gap + i * (s + gap)
        fig.paste(img.resize((s, s), Image.NEAREST), (x, top))
        d.rectangle([x, top, x + s, top + s], outline=(70, 70, 70))
        colour = (170, 30, 30) if "greedy" in label else (0, 0, 0)
        d.text((x, top + s + 8), label, fill=colour, font=font(15))
        if nbytes is not None:
            d.text((x, top + s + 28),
                   f"{nbytes/1024:.1f} KB  ·  {nbytes*8/px:.2f} bpp  ·  {db:.1f} dB",
                   fill=colour, font=font(14))

    d.text((gap, top + s + 58),
           "Same crop throughout. The greedy fitter was the problem, not the representation; "
           "JPEG still wins both ways, but by ~3x in bytes rather than ~10x.",
           fill=(90, 90, 90), font=font(13))

    fig.save(args.out)
    print(f"greedy  {db_greedy:.2f} dB at {args.bytes/1024:.1f} KB")
    print(f"joint   {db_joint:.2f} dB at {args.bytes/1024:.1f} KB")
    print(f"jpeg    q{qb} {len(enc_b)/1024:.1f} KB -> {psnr(jpeg_same_bytes, target):.2f} dB (same bytes)")
    print(f"jpeg    q{qq} {len(enc_q)/1024:.1f} KB -> {db_q:.2f} dB (same quality as joint)")
    print(f"        splats cost {args.bytes/len(enc_q):.2f}x JPEG at equal quality")
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
