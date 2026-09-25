"""
How soft does packet loss make splats? Confetti delivery rests on "a lost packet makes the
unit softer, not broken"; this measures how much softer.

For a level of a prepared image, it drops each CONFETTI packet with some probability (the
packets dealt exactly as shared/units.ts deals them, on every level down to this one, since
the detail levels rest on the ones above), renders the level as the viewer does, and
compares it with the same render without loss and with the original pixels.

  python3 bench/softness.py prototype/out 2 [--loss 0.01,0.05,0.1,0.2,0.3] [--sample 12]
"""

import argparse
import math
import os
import random
import sys

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "prototype"))
from splatpyr import codec  # noqa: E402
from splatpyr.build import Store  # noqa: E402

BLOBS_PER_PACKET = 100          # must match shared/units.ts


def packet_of_each_blob(chunk_ends):
    """For every blob of a unit, in file order, the CONFETTI packet it travels in."""
    out, start, first_packet = [], 0, 0
    for end in chunk_ends:
        count = end - start
        P = max(1, math.ceil(count / BLOBS_PER_PACKET))
        out += [first_packet + j % P for j in range(count)]
        first_packet += P
        start = end
    return np.array(out, dtype=np.int64), first_packet


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("root")
    ap.add_argument("level", type=int)
    ap.add_argument("--loss", default="0.01,0.05,0.1,0.2,0.3")
    ap.add_argument("--sample", type=int, default=12, help="units of the level to render")
    ap.add_argument("--seed", type=int, default=1)
    args = ap.parse_args()

    store = Store(args.root)
    pyr, T = store.pyr, store.pyr.tile
    cols, rows = pyr.grid(args.level)
    units = [(x, y) for y in range(rows) for x in range(cols)]
    random.Random(args.seed).shuffle(units)
    units = units[:args.sample]

    full_unit = store.unit                       # the whole unit, as the loader gives it

    def render(x, y):
        w, h = pyr.unit_size(args.level, x, y)
        return np.clip(store.prediction(args.level, x * T, y * T, x * T + w, y * T + h,
                                        finest=args.level), 0, 1)

    def psnr(a, b):
        m = float(np.mean((a - b) ** 2))
        return 99.0 if m < 1e-12 else 10 * math.log10(1 / m)

    truth = {u: pyr.crop(args.level, u[0] * T, u[1] * T, u[0] * T + pyr.unit_size(args.level, *u)[0],
                         u[1] * T + pyr.unit_size(args.level, *u)[1]) for u in units}
    clean = {u: render(*u) for u in units}
    def pooled(a, b):
        """PSNR of all the units together (averaging per-unit dB would let the units that
        happened to lose nothing, at a capped 99 dB, hide the ones that did)."""
        m = np.mean(np.concatenate([((a[u] - b[u]) ** 2).ravel() for u in units]))
        return 99.0 if m < 1e-12 else 10 * math.log10(1 / m)

    base = pooled(clean, truth)
    print(f"{args.root} level {args.level}, {len(units)} units, no loss: {base:.2f} dB vs the pixels")
    print(f"{'loss':>6} {'vs no-loss render':>18} {'vs pixels':>10} {'drop':>7} {'worst unit drop':>16}")

    for p in [float(v) for v in args.loss.split(",")]:
        rng = np.random.default_rng(args.seed)
        lost_cache = {}

        def lossy_unit(level, x, y, fit_missing=False):
            key = (level, x, y)
            if key not in lost_cache:
                mode, w, h, blobs = full_unit(level, x, y, fit_missing)
                with open(store.path(level, x, y), "rb") as f:
                    _, _, _, _, ends = codec.decode(f.read())
                packet, n_packets = packet_of_each_blob(ends)
                kept_packets = rng.random(n_packets) >= p
                lost_cache[key] = (mode, w, h, blobs.take(np.nonzero(kept_packets[packet])[0]))
            return lost_cache[key]

        store.unit = lossy_unit
        lossy = {u: render(*u) for u in units}
        store.unit = full_unit
        worst = min(psnr(lossy[u], truth[u]) - psnr(clean[u], truth[u]) for u in units)
        vs_truth = pooled(lossy, truth)
        print(f"{p * 100:5.0f}% {pooled(lossy, clean):15.2f} dB {vs_truth:7.2f} dB "
              f"{vs_truth - base:6.2f} dB {worst:13.2f} dB")


if __name__ == "__main__":
    main()
