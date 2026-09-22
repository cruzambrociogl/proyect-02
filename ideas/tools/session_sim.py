#!/usr/bin/env python3
"""
Session simulator: what one browsing session costs the client, under four loading
strategies, on a real ingested tile store.

It measures what the viewer is judged on - not bytes per tile:
  memory      image data the page holds, every frame (decoded bitmaps, compressed bytes,
              splats); the canvas itself is the same for everyone and not counted
  requests    client->server messages, items received, bytes downloaded, items wasted
  smoothness  what the screen actually shows each frame, as PSNR against the ideal frame
              (every visible tile present at the right level), and how long after each
              gesture the view is complete

Strategies
  A  naive tiles       one HTTP request per tile, for every level the zoom passes through;
                       nothing cancelled, nothing evicted - the behaviour observed on EarthCam
  B  ours, decoded     one connection; the client sends its viewport (GAZE), the server pushes
                       visible tiles centre-first and drops queued ones a newer viewport no
                       longer needs; decoded-bitmap LRU capped at --budget MB
  C  ours, compressed  as B, but cached tiles are kept as JPEG bytes and only on-screen tiles
                       stay decoded; showing a cached tile again costs a decode
  D  ours, splats      as B, but levels >= --splat-from travel and are cached as splats
                       (11 bytes each, 4000 per full tile); JPEG tiles only below that

Mid-zoom blur experiments, all built on C:
  E  coarse-first      every viewport update first asks for a cover --cover-k levels coarser
                       (~1/4 of the tiles), so a complete fallback is never far behind
  F  predictive        the client knows where its own zoom animation will be --lookahead s
                       from now and the server sends that view's tiles first
  G  E + F
  H  E + prediction by extrapolating the current velocity (what a pinch gesture allows,
                       since it has no known target)
  I  C + velocity prediction only
  S  F with splats instead of JPEG for levels >= --splat-from (the splat version of our
                       final design, for a like-for-like comparison)

Every strategy composites its frame the way a viewer draws: the coarsest level that fully
covers the view first, finer held tiles on top, up to the ideal level. For D, the splat
error is not in the tile pixels, so it is added per level from real fits of this image
(--splats DIR/fits.csv) - D's quality curve is an estimate, and is labelled as one.
Snapshot frames for D use actual splat renders where DIR/<level>/<tx>_<ty>.png exists.

  python3 tools/session_sim.py images/.tiles/holbein_8000.jpg --name holbein \
      --poi 0.55,0.28,1.0 --poi 0.24,0.63,1.4 --poi 0.72,0.80,0.7 \
      --splats out/session/splats/holbein
"""

import argparse
import csv
import heapq
import json
import math
import os
import time
from collections import OrderedDict, deque

import numpy as np
from PIL import Image

VW, VH = 1280, 720
FPS = 30
MB = 1 << 20
TILE_HDR = 16                  # our 12-byte header + 4-byte WebSocket frame header
HTTP_REQ, HTTP_RESP = 450, 300 # typical request / response header bytes
GAZE_BYTES, EVICT_BYTES = 32, 8
GAZE_INTERVAL = 0.05           # at most one viewport update per 50 ms
SNDBUF = 64 * 1024             # bytes the server commits to the socket ahead of the wire
HOT_TTL = 0.5                  # C: a decoded bitmap not drawn for this long is released
PSNR_CAP = 60.0
SPLAT_RECORD = 11
SPLATS_PER_TILE = 4000

STRATEGIES = {
    "A": {"naive": True},
    "B": {},
    "C": {"compressed": True},
    "D": {"splats": True},
    "E": {"compressed": True, "cover": True},
    "F": {"compressed": True, "predict": "lead"},
    "G": {"compressed": True, "cover": True, "predict": "lead"},
    "H": {"compressed": True, "cover": True, "predict": "velocity"},
    "I": {"compressed": True, "predict": "velocity"},
    "S": {"compressed": True, "splats": True, "predict": "lead"},
}


class Store:
    def __init__(self, path):
        meta = {}
        with open(os.path.join(path, "meta.txt")) as f:
            for ln in f:
                if "=" in ln:
                    k, v = ln.strip().split("=", 1)
                    meta[k] = v
        self.path = path
        self.W, self.H = int(meta["width"]), int(meta["height"])
        self.T, self.r = int(meta["tileSize"]), float(meta["ratio"])
        self.maxL = int(meta["maxLevel"])
        self.dims = [(math.ceil(self.W / self.r ** L), math.ceil(self.H / self.r ** L))
                     for L in range(self.maxL + 1)]
        self._size = {}
        self._pix = OrderedDict()

    def ls(self, L):
        return self.r ** L

    def ntiles(self, L):
        lw, lh = self.dims[L]
        return (lw + self.T - 1) // self.T, (lh + self.T - 1) // self.T

    def wh(self, key):
        L, tx, ty = key
        lw, lh = self.dims[L]
        return min(self.T, lw - tx * self.T), min(self.T, lh - ty * self.T)

    def file(self, key):
        return os.path.join(self.path, str(key[0]), f"{key[1]}_{key[2]}.jpg")

    def nbytes(self, key):
        if key not in self._size:
            self._size[key] = os.path.getsize(self.file(key))
        return self._size[key]

    def pixels(self, key):
        p = self._pix.get(key)
        if p is None:
            p = np.asarray(Image.open(self.file(key)).convert("RGB"))
            self._pix[key] = p
            if len(self._pix) > 2500:
                self._pix.popitem(last=False)
        else:
            self._pix.move_to_end(key)
        return p

    def ideal_level(self, s):
        L = int(math.floor(math.log(max(s, 1e-9)) / math.log(self.r) + 1e-9))
        return max(0, min(self.maxL, L))

    def visible(self, L, cam):
        cx, cy, s = cam
        ls = self.ls(L)
        x0, x1 = (cx - VW * s / 2) / ls, (cx + VW * s / 2) / ls
        y0, y1 = (cy - VH * s / 2) / ls, (cy + VH * s / 2) / ls
        ntx, nty = self.ntiles(L)
        tx0, tx1 = max(0, int(x0 // self.T)), min(ntx - 1, math.ceil(x1 / self.T) - 1)
        ty0, ty1 = max(0, int(y0 // self.T)), min(nty - 1, math.ceil(y1 / self.T) - 1)
        return [(L, tx, ty) for ty in range(ty0, ty1 + 1) for tx in range(tx0, tx1 + 1)]

    def priority(self, cam):
        """Distance of a tile's centre from the viewport centre, in screen pixels."""
        cx, cy, s = cam

        def key(k):
            ls = self.ls(k[0])
            return math.hypot(((k[1] + 0.5) * self.T * ls - cx) / s,
                              ((k[2] + 0.5) * self.T * ls - cy) / s)
        return key


# ---------------------------------------------------------------------------------------
# The scripted session
# ---------------------------------------------------------------------------------------

def clamp_cam(st, cx, cy, s):
    vw, vh = VW * s, VH * s
    cx = st.W / 2 if vw >= st.W else min(max(cx, vw / 2), st.W - vw / 2)
    cy = st.H / 2 if vh >= st.H else min(max(cy, vh / 2), st.H - vh / 2)
    return (cx, cy, s)


def build_path(st, pois):
    """Frames of (t, cam, phase, segment). Dive into each point, returning to the full view
    between dives; pan after the first; finish by revisiting the first (tests the cache)."""
    full = clamp_cam(st, st.W / 2, st.H / 2, max(st.W / VW, st.H / VH))
    P = [clamp_cam(st, fx * st.W, fy * st.H, z) for fx, fy, z in pois]
    pan_to = clamp_cam(st, P[0][0] + 2 * VW * P[0][2], P[0][1], P[0][2])
    segs = [("hold", 1.0, None), ("zoom", 1.5, P[0]), ("hold", 1.5, None),
            ("pan", 2.0, pan_to), ("hold", 1.0, None), ("zoom", 1.5, full), ("hold", 1.0, None)]
    for p in P[1:]:
        segs += [("zoom", 1.5, p), ("hold", 1.5, None), ("zoom", 1.5, full), ("hold", 1.0, None)]
    segs += [("zoom", 1.5, P[0]), ("hold", 2.0, None)]

    frames = [(0.0, full, "hold", 0)]
    cur = full
    for si, (kind, dur, target) in enumerate(segs):
        n = round(dur * FPS)
        a, b = cur, (cur if target is None else target)
        for k in range(n):
            e = (k + 1) / n
            e = e * e * (3 - 2 * e)
            if kind == "hold":
                c = a
            elif kind == "pan":
                c = clamp_cam(st, a[0] + (b[0] - a[0]) * e, a[1] + (b[1] - a[1]) * e, a[2])
            else:
                s = math.exp(math.log(a[2]) + (math.log(b[2]) - math.log(a[2])) * e)
                # Centre moves in proportion to the scale change: zooming toward a point
                # keeps it put on screen instead of sliding sideways at deep zoom.
                cf = (s - a[2]) / (b[2] - a[2]) if b[2] != a[2] else e
                c = clamp_cam(st, a[0] + (b[0] - a[0]) * cf, a[1] + (b[1] - a[1]) * cf, s)
            frames.append((len(frames) / FPS, c, kind, si))
        cur = b
    return frames, segs


# ---------------------------------------------------------------------------------------
# Compositing
# ---------------------------------------------------------------------------------------

def render_level(st, cam, L, keys, pixels):
    cx, cy, s = cam
    ls = st.ls(L)
    fx0, fy0 = (cx - VW * s / 2) / ls, (cy - VH * s / 2) / ls
    fx1, fy1 = fx0 + VW * s / ls, fy0 + VH * s / ls
    ix0, iy0 = math.floor(fx0), math.floor(fy0)
    cw, ch = math.ceil(fx1) - ix0, math.ceil(fy1) - iy0
    canvas = np.zeros((ch, cw, 3), np.uint8)
    mask = np.zeros((ch, cw), np.uint8)
    for k in keys:
        p = pixels(k)
        h, w = p.shape[:2]
        px, py = k[1] * st.T - ix0, k[2] * st.T - iy0
        x0, y0, x1, y1 = max(px, 0), max(py, 0), min(px + w, cw), min(py + h, ch)
        if x1 <= x0 or y1 <= y0:
            continue
        canvas[y0:y1, x0:x1] = p[y0 - py:y1 - py, x0 - px:x1 - px]
        mask[y0:y1, x0:x1] = 255
    box = (fx0 - ix0, fy0 - iy0, fx1 - ix0, fy1 - iy0)
    layer = np.asarray(Image.fromarray(canvas).resize((VW, VH), Image.BILINEAR, box=box))
    m = np.asarray(Image.fromarray(mask).resize((VW, VH), Image.NEAREST, box=box)) > 127
    return layer, m


def compose(st, cam, drawable, pixels):
    """Painter's order: coarsest level that fully covers the view, then finer held tiles."""
    L0 = st.ideal_level(cam[2])
    layers = []
    for L in range(L0, st.maxL + 1):
        vis = st.visible(L, cam)
        have = [k for k in vis if drawable(k)]
        if have:
            layers.append((L, have))
        if len(have) == len(vis):
            break
    frame = np.zeros((VH, VW, 3), np.uint8)
    owner = np.full((VH, VW), -1, np.int16)
    drawn = []
    for L, have in reversed(layers):
        layer, m = render_level(st, cam, L, have, pixels)
        frame[m] = layer[m]
        owner[m] = L
        drawn += have
    complete = bool(layers) and layers[0][0] == L0 and len(layers) == 1
    return frame, owner, drawn, complete


def inside_mask(st, cam):
    cx, cy, s = cam
    xs = (np.arange(VW) + 0.5 - VW / 2) * s + cx
    ys = (np.arange(VH) + 0.5 - VH / 2) * s + cy
    return ((ys >= 0) & (ys < st.H))[:, None] & ((xs >= 0) & (xs < st.W))[None, :]


def frame_psnr(a, b, inside, extra_mse=0.0):
    d = a[inside].astype(np.int32) - b[inside].astype(np.int32)
    mse = float(np.mean(d * d)) + extra_mse
    return PSNR_CAP if mse < 1e-6 else min(PSNR_CAP, 10 * math.log10(255.0 ** 2 / mse))


# ---------------------------------------------------------------------------------------
# One client + its server, per strategy
# ---------------------------------------------------------------------------------------

class Client:
    def __init__(self, kind, st, args, decode_ms):
        self.kind, self.st = kind, st
        cfg = STRATEGIES[kind]
        self.naive = cfg.get("naive", False)
        self.compressed = cfg.get("compressed", False)
        self.cover = args.cover_k if cfg.get("cover") else 0
        self.predict = cfg.get("predict")
        self.bw = args.mbps * 1e6 / 8
        self.half_rtt = args.rtt / 2000.0
        self.budget = None if self.naive else args.budget * MB
        self.splat_from = args.splat_from if cfg.get("splats") else None
        self.decode_ms = decode_ms

        self.held = OrderedDict()      # key -> bytes it occupies; order = least recently drawn first
        self.hot = {}                  # C: key -> last drawn time (decoded bitmap alongside)
        self.decode_q = deque()        # (enqueue time, key, is_redecode)
        self.decoding = set()
        self.decoder_free = 0.0
        self.arrivals = []             # heap of (arrival time, seq, key, wire bytes)
        self.seq = 0
        self.link_free = 0.0

        self.requested = set()         # A: every tile ever asked for
        self.gazes = deque()           # (arrival at server, cam, predicted cam, evicted keys)
        self.pending = []
        self.ledger = set()            # server's view of what the client holds or has in flight
        self.server_t = 0.0
        self.last_gaze_t, self.last_gaze_key = -1e9, None
        self.evicted = []

        self.received, self.drawn_ever = set(), set()
        self.up_msgs = self.up_bytes = self.items = self.down_bytes = 0
        self.decodes = self.redecodes = self.cancelled = 0

        top = (st.maxL, 0, 0)          # the whole image in one tile: every strategy starts with it
        self.top = top
        # Ours never evicts the overview level (the one the full view uses) or anything
        # coarser: a few MB that guarantee a decent fallback for every zoom-out.
        self.anchor = None if self.naive else st.ideal_level(max(st.W / VW, st.H / VH))
        self._hold(top, 0.0)
        if self.compressed:
            self.hot[top] = 0.0
        self.requested.add(top)
        self.ledger.add(top)

    # --- representation ---------------------------------------------------------------
    def is_splat(self, key):
        return self.splat_from is not None and key[0] >= self.splat_from

    def splat_count(self, key):
        w, h = self.st.wh(key)
        return max(16, round(SPLATS_PER_TILE * w * h / (self.st.T * self.st.T)))

    def item_bytes(self, key):
        return self.splat_count(key) * SPLAT_RECORD if self.is_splat(key) else self.st.nbytes(key)

    def wire_bytes(self, key):
        return self.item_bytes(key) + (HTTP_RESP if self.naive else TILE_HDR)

    def bitmap_bytes(self, key):
        w, h = self.st.wh(key)
        return w * h * 4

    def _hold(self, key, t):
        if self.is_splat(key):
            self.held[key] = self.item_bytes(key)
        elif self.compressed:
            self.held[key] = self.st.nbytes(key)
        else:
            self.held[key] = self.bitmap_bytes(key)
        self.held.move_to_end(key)

    def pinned(self, key):
        return key == self.top or (self.anchor is not None and key[0] >= self.anchor)

    def drawable(self, key):
        return key in self.hot if (self.compressed and not self.is_splat(key)) else key in self.held

    def memory(self):
        m = sum(self.held.values())
        if self.compressed:
            m += sum(self.bitmap_bytes(k) for k in self.hot)
        m += sum(self.st.nbytes(k) for _, k, re in self.decode_q if not re)
        return m

    # --- network ------------------------------------------------------------------------
    def _send(self, key, t_server):
        wb = self.wire_bytes(key)
        start = max(self.link_free, t_server)
        self.link_free = start + wb / self.bw
        self.seq += 1
        heapq.heappush(self.arrivals, (self.link_free + self.half_rtt, self.seq, key, wb))

    def need(self, cam, future):
        """What the server queues for one viewport update, in sending order: the coarse
        cover (E, G, H), then the predicted view (F, G, H), then the current view."""
        st = self.st
        L = st.ideal_level(cam[2])
        order = []
        if self.cover:
            order += sorted(st.visible(min(st.maxL, L + self.cover), cam), key=st.priority(cam))
        if future is not None and future != cam:
            order += sorted(st.visible(st.ideal_level(future[2]), future), key=st.priority(future))
        order += sorted(st.visible(L, cam), key=st.priority(cam))
        out, seen = [], set()
        for k in order:
            if k not in seen and k not in self.ledger:
                seen.add(k)
                out.append(k)
        return out

    def advance_server(self, until):
        """Our server: apply viewport updates as they arrive, commit tiles in priority order
        while the socket buffer has room, drop queued tiles a newer viewport does not need."""
        while True:
            ng = self.gazes[0][0] if self.gazes else math.inf
            tc = max(self.server_t, self.link_free - SNDBUF / self.bw) if self.pending else math.inf
            if ng <= until and ng <= tc:
                at, cam, future, ev = self.gazes.popleft()
                self.server_t = at
                self.ledger.difference_update(ev)
                new = self.need(cam, future)
                keep = set(new)
                self.cancelled += sum(1 for k in self.pending if k not in keep)
                self.pending = new
            elif tc <= until:
                key = self.pending.pop(0)
                self.server_t = tc
                self._send(key, tc)
                self.ledger.add(key)
            else:
                break

    # --- one frame ----------------------------------------------------------------------
    def receive(self, t):
        while self.arrivals and self.arrivals[0][0] <= t:
            at, _, key, wb = heapq.heappop(self.arrivals)
            self.items += 1
            self.down_bytes += wb
            self.received.add(key)
            if self.is_splat(key):
                self._hold(key, at)            # uploaded to the GPU as-is, nothing to decode
            else:
                self.decode_q.append((at, key, False))
                self.decoding.add(key)
        while self.decode_q:
            at, key, re = self.decode_q[0]
            w, h = self.st.wh(key)
            done = max(self.decoder_free, at) + self.decode_ms / 1000.0 * w * h / (self.st.T ** 2)
            if done > t:
                break
            self.decode_q.popleft()
            self.decoder_free = done
            self.decoding.discard(key)
            self.decodes += 1
            if re:
                self.redecodes += 1
                if key in self.held:
                    self.hot[key] = done
            else:
                self._hold(key, done)
                if self.compressed:
                    self.hot[key] = done

    def after_draw(self, t, cam, drawn):
        drawn_set = set(drawn)
        for k in drawn:
            if k in self.held:
                self.held.move_to_end(k)
            if self.compressed and k in self.hot:
                self.hot[k] = t
        self.drawn_ever |= drawn_set

        if self.compressed:
            # Cached tiles on screen need decoding again before they can be drawn.
            L0 = self.st.ideal_level(cam[2])
            for L in range(L0, self.st.maxL + 1):
                vis = self.st.visible(L, cam)
                for k in vis:
                    if (k in self.held and k not in self.hot and k not in self.decoding
                            and not self.is_splat(k)):
                        self.decode_q.append((t, k, True))
                        self.decoding.add(k)
                if all(k in self.held for k in vis):
                    break
            for k in [k for k, last in self.hot.items() if t - last > HOT_TTL and k != self.top]:
                del self.hot[k]

        if self.budget is not None:
            total = self.memory()
            if self.compressed:
                # Off-screen bitmaps first: they cost a 0.4 ms decode to rebuild, whereas
                # dropping a compressed tile costs a download.
                for k in sorted(self.hot, key=self.hot.get):
                    if total <= self.budget:
                        break
                    if k not in drawn_set and k != self.top:
                        total -= self.bitmap_bytes(k)
                        del self.hot[k]
            for k in list(self.held.keys()):
                if total <= self.budget:
                    break
                if k in drawn_set or self.pinned(k) or k in self.decoding:
                    continue
                total -= self.held.pop(k)
                if self.compressed and k in self.hot:
                    total -= self.bitmap_bytes(k)
                    del self.hot[k]
                self.evicted.append(k)

    def request(self, t, cam, futures):
        if self.naive:
            L = self.st.ideal_level(cam[2])
            for k in sorted(self.st.visible(L, cam), key=self.st.priority(cam)):
                if k not in self.requested:
                    self.requested.add(k)
                    self.up_msgs += 1
                    self.up_bytes += HTTP_REQ
                    self._send(k, t + self.half_rtt)
            return
        future = futures.get(self.predict)
        if (cam, future) != self.last_gaze_key and t - self.last_gaze_t >= GAZE_INTERVAL - 1e-9:
            self.up_msgs += 1
            self.up_bytes += GAZE_BYTES + (24 if future else 0) + EVICT_BYTES * len(self.evicted)
            self.gazes.append((t + self.half_rtt, cam, future, self.evicted))
            self.evicted = []
            self.last_gaze_t, self.last_gaze_key = t, (cam, future)


# ---------------------------------------------------------------------------------------

def measure_decode_ms(st, n=120):
    L = 0
    ntx, nty = st.ntiles(L)
    rng = np.random.default_rng(1)
    keys = [(L, int(rng.integers(0, ntx - 1)), int(rng.integers(0, nty - 1))) for _ in range(n)]
    times = []
    for k in keys:
        t0 = time.perf_counter()
        np.asarray(Image.open(st.file(k)).convert("RGB"))
        times.append((time.perf_counter() - t0) * 1000)
    return float(np.median(times))


def splat_quality(path):
    """Per-level mean squared error (0..255 scale) of the splat fits, nearest level fills gaps."""
    if not path or not os.path.exists(os.path.join(path, "fits.csv")):
        return {}
    per = {}
    with open(os.path.join(path, "fits.csv")) as f:
        for row in csv.DictReader(f):
            mse = 255.0 ** 2 * 10 ** (-float(row["psnr_db"]) / 10)
            per.setdefault(int(row["level"]), []).append(mse)
    return {L: float(np.mean(v)) for L, v in per.items()}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("store")
    ap.add_argument("--name", required=True)
    ap.add_argument("--poi", action="append", required=True, help="fx,fy,scale")
    ap.add_argument("--strategies", default="ABCD")
    ap.add_argument("--mbps", type=float, default=20.0)
    ap.add_argument("--rtt", type=float, default=60.0, help="ms")
    ap.add_argument("--budget", type=float, default=50.0, help="MB, ours only")
    ap.add_argument("--splat-from", type=int, default=3)
    ap.add_argument("--splats", default=None, help="dir with fits.csv and fitted renders")
    ap.add_argument("--cover-k", type=int, default=3, help="E/G/H: cover this many levels coarser")
    ap.add_argument("--lookahead", type=float, default=0.3, help="F/G/H: seconds of prediction")
    ap.add_argument("--frames", action="store_true",
                    help="save every strategy's screen, every frame (960x540 JPEG), for video")
    ap.add_argument("--out", default="out/session")
    args = ap.parse_args()

    st = Store(args.store)
    pois = [tuple(float(v) for v in p.split(",")) for p in args.poi]
    frames, segs = build_path(st, pois)
    seg_last = {}
    for fi, fr in enumerate(frames):
        seg_last[fr[3]] = fi
    ahead = round(args.lookahead * FPS)

    def futures(fi):
        """Where the view will be --lookahead s from now, as each predictor sees it.
        lead: the client's own animation, known up to the end of the current gesture.
        velocity: the last frame's motion continued - all a pinch gesture can offer."""
        cam, seg = frames[fi][1], frames[fi][3]
        lead = frames[min(fi + ahead, seg_last[seg])][1]
        prev = frames[fi - 1][1] if fi else cam
        if prev == cam:
            vel = cam
        else:
            s = math.exp(math.log(cam[2]) + (math.log(cam[2]) - math.log(prev[2])) * ahead)
            vel = clamp_cam(st, cam[0] + (cam[0] - prev[0]) * ahead,
                            cam[1] + (cam[1] - prev[1]) * ahead, s)
        return {None: None, "lead": lead, "velocity": vel}
    out = os.path.join(args.out, args.name)
    os.makedirs(out, exist_ok=True)

    decode_ms = measure_decode_ms(st)
    smse = splat_quality(args.splats)

    def splat_mse(L):
        if not smse:
            return 0.0
        return smse[min(smse, key=lambda k: abs(k - L))]

    splat_cache = OrderedDict()

    def splat_pixels(key, missing):
        """The quantised splat render of a tile, from --splats; records it if not fitted."""
        arr = splat_cache.get(key)
        if arr is None:
            p = os.path.join(args.splats or "", str(key[0]), f"{key[1]}_{key[2]}.png")
            if not os.path.exists(p):
                missing.add(key)
                return st.pixels(key)
            arr = np.asarray(Image.open(p).convert("RGB"))
            splat_cache[key] = arr
            if len(splat_cache) > 2500:
                splat_cache.popitem(last=False)
        return arr

    # Snapshot moments: mid first dive, just after it lands, just after the revisit lands.
    seg_end, t_acc = [], 0.0
    for kind, dur, _ in segs:
        t_acc += dur
        seg_end.append(t_acc)
    zooms = [i for i, (kind, _, _) in enumerate(segs) if kind == "zoom"]
    snaps = {"dive_mid": seg_end[zooms[0]] - 0.75, "dive_landed": seg_end[zooms[0]] + 0.3,
             "revisit_landed": seg_end[zooms[-1]] + 0.3}
    snap_frames = {round(t * FPS): name for name, t in snaps.items()}

    print(f"{args.name}: {st.W}x{st.H}, levels 0..{st.maxL}, {len(frames)} frames "
          f"({len(frames) / FPS:.1f} s), viewport {VW}x{VH}")
    print(f"network {args.mbps} Mbit/s, RTT {args.rtt} ms; decode {decode_ms:.2f} ms/tile (measured); "
          f"budget {args.budget} MB; splats from level {args.splat_from}"
          + (f"; splat quality from {len(smse)} fitted levels" if smse else "; NO splat fits"))

    clients = {k: Client(k, st, args, decode_ms) for k in args.strategies}
    rows = []
    need_splats = set()
    t_start = time.time()

    for fi, (t, cam, phase, seg) in enumerate(frames):
        ideal, _, _, _ = compose(st, cam, lambda k: True, st.pixels)
        inside = inside_mask(st, cam)
        n_in = max(1, int(inside.sum()))
        fut = futures(fi)
        for kind, c in clients.items():
            if not c.naive:
                c.advance_server(t)
            c.receive(t)
            extra = 0.0
            splats_drawn = 0
            if c.splat_from is not None and args.frames:
                # Video mode: draw the real splat renders every frame, so the picture and its
                # PSNR are measured, not estimated. Unfitted tiles fall back to the estimate.
                missing = set()
                frame, owner, drawn, complete = compose(
                    st, cam, c.drawable,
                    lambda k, c=c: splat_pixels(k, missing) if c.is_splat(k) else st.pixels(k))
                need_splats |= {f"{k[0]}/{k[1]}_{k[2]}" for k in missing}
            else:
                missing = None
                frame, owner, drawn, complete = compose(st, cam, c.drawable, st.pixels)
            if c.splat_from is not None:
                if missing is None or missing:
                    for L in np.unique(owner[inside]):
                        if L >= args.splat_from:
                            extra += splat_mse(int(L)) * float(np.sum(owner[inside] == L)) / n_in
                splats_drawn = sum(c.splat_count(k) for k in drawn if c.is_splat(k))
            db = frame_psnr(frame, ideal, inside, extra)

            if args.frames:
                fdir = os.path.join(out, "frames", kind)
                os.makedirs(fdir, exist_ok=True)
                Image.fromarray(frame).resize((VW * 3 // 4, VH * 3 // 4), Image.BILINEAR).save(
                    os.path.join(fdir, f"{fi:05d}.jpg"), quality=90)

            if fi in snap_frames:
                name = snap_frames[fi]
                if c.splat_from is not None and not args.frames:
                    missing = set()
                    frame, _, _, _ = compose(
                        st, cam, c.drawable,
                        lambda k, c=c: splat_pixels(k, missing) if c.is_splat(k) else st.pixels(k))
                    need_splats |= {f"{k[0]}/{k[1]}_{k[2]}" for k in missing}
                Image.fromarray(frame).save(os.path.join(out, f"snap_{name}_{kind}.png"))
                if kind == list(clients)[0]:
                    Image.fromarray(ideal).save(os.path.join(out, f"snap_{name}_ideal.png"))

            c.after_draw(t, cam, drawn)
            c.request(t, cam, fut)
            rows.append({"t": round(t, 4), "strategy": kind, "phase": phase, "segment": seg,
                         "level": st.ideal_level(cam[2]), "scale": round(cam[2], 4),
                         "mem_mb": c.memory() / MB, "psnr": db, "complete": int(complete),
                         "up_msgs": c.up_msgs, "items": c.items, "down_mb": c.down_bytes / MB,
                         "decodes": c.decodes, "splats_drawn": splats_drawn})
        if fi % 60 == 0:
            print(f"  t={t:5.1f}s  L*={st.ideal_level(cam[2]):2d}  "
                  + "  ".join(f"{k}: {clients[k].memory() / MB:6.1f} MB" for k in clients)
                  + f"   ({time.time() - t_start:.0f}s)", flush=True)

    with open(os.path.join(out, "timeline.csv"), "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)

    # Time from the end of each gesture until the view is complete, looking only inside the
    # hold that follows it (the first window is the initial load).
    windows = [(0.0, seg_end[0])] + [(seg_end[i], seg_end[i + 1])
                                     for i, (kind, _, _) in enumerate(segs[:-1]) if kind != "hold"]
    gesture_ends = [w[0] for w in windows[1:]]
    summary = {"name": args.name, "image": [st.W, st.H], "frames": len(frames),
               "mbps": args.mbps, "rtt_ms": args.rtt, "budget_mb": args.budget,
               "decode_ms": decode_ms, "splat_from": args.splat_from,
               "cover_k": args.cover_k, "lookahead": args.lookahead,
               "splat_levels_fitted": sorted(smse), "snapshots": snaps,
               "gesture_ends": gesture_ends, "strategies": {}}
    for kind, c in clients.items():
        r = [x for x in rows if x["strategy"] == kind]
        motion = [x["psnr"] for x in r if x["phase"] != "hold"]
        holds = [x["psnr"] for x in r if x["phase"] == "hold"]
        ttc = []
        for te, limit in windows:
            hit = next((x["t"] for x in r if te - 1e-9 <= x["t"] < limit + 1e-9 and x["complete"]), None)
            ttc.append(None if hit is None else round(hit - te, 3))
        summary["strategies"][kind] = {
            "peak_mem_mb": max(x["mem_mb"] for x in r), "end_mem_mb": r[-1]["mem_mb"],
            "up_msgs": c.up_msgs, "up_kb": c.up_bytes / 1024, "items": c.items,
            "down_mb": c.down_bytes / MB, "wasted_items": len(c.received - c.drawn_ever),
            "cancelled": c.cancelled, "decodes": c.decodes, "redecodes": c.redecodes,
            "psnr_motion": float(np.mean(motion)), "psnr_hold": float(np.mean(holds)),
            "blurry_s": sum(1 for x in r if x["psnr"] < 35.0) / FPS,
            "worst_db": min(x["psnr"] for x in r),
            "time_to_complete": ttc,
            "max_splats_drawn": max(x["splats_drawn"] for x in r)}
    with open(os.path.join(out, "summary.json"), "w") as f:
        json.dump(summary, f, indent=1)
    need_file = os.path.join(out, "need_splats.txt")
    if need_splats:
        with open(need_file, "w") as f:
            f.write("\n".join(sorted(need_splats)) + "\n")
    elif os.path.exists(need_file):
        os.remove(need_file)          # stale list from an earlier run

    print(f"\n{'':<22}" + "".join(f"{k:>12}" for k in clients))
    for label, key, fmt in [("peak memory MB", "peak_mem_mb", "{:.1f}"),
                            ("end memory MB", "end_mem_mb", "{:.1f}"),
                            ("client->server msgs", "up_msgs", "{}"),
                            ("items received", "items", "{}"),
                            ("downloaded MB", "down_mb", "{:.1f}"),
                            ("received, never drawn", "wasted_items", "{}"),
                            ("cancelled in queue", "cancelled", "{}"),
                            ("decodes (re-decodes)", None, None),
                            ("PSNR while moving", "psnr_motion", "{:.1f}"),
                            ("PSNR while still", "psnr_hold", "{:.1f}"),
                            ("seconds < 35 dB", "blurry_s", "{:.1f}"),
                            ("worst frame dB", "worst_db", "{:.1f}")]:
        vals = []
        for k in clients:
            s = summary["strategies"][k]
            vals.append(f"{s['decodes']} ({s['redecodes']})" if key is None else fmt.format(s[key]))
        print(f"{label:<22}" + "".join(f"{v:>12}" for v in vals))
    for k in clients:
        ttc = summary["strategies"][k]["time_to_complete"]
        print(f"time to complete {k}: " + " ".join("never" if v is None else f"{v:.2f}s" for v in ttc))
    if need_splats:
        print(f"\n{len(need_splats)} splat tiles needed for D's snapshots -> {out}/need_splats.txt")
    print(f"wrote {out}/timeline.csv, summary.json, snap_*.png   ({time.time() - t_start:.0f}s)")


if __name__ == "__main__":
    main()
