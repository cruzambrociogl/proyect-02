// The viewer's cache policies side by side, without a browser: scripted sessions replayed
// through the viewer's drawing rule on a prepared image, every frame's units handed to the
// policy, and what it costs: peak memory, and bytes downloaded again after an eviction.
//
//   node bench/cache.ts [--images data] [--image bills] [--budget 24,48]
//
// Unit sizes are what the viewer holds: 11 bytes per blob (raw records on the GPU) and 4
// bytes per tile pixel (no mipmaps). Refetched bytes are what the unit costs on
// the wire (its packets, or its tile file).

import { statSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { PreparedImage } from "../server/image.ts";
import { KIND_SPLAT, KIND_TILE, unitKey, type UnitId, type View } from "../shared/wire.ts";
import { LruCache, SandpileCache, type Site } from "../viewer/src/sandpile.ts";
import { ForgettingCache } from "../viewer/src/forgetting.ts";

const { values: args } = parseArgs({
  options: {
    images: { type: "string", default: "data" },
    image: { type: "string", default: "bills" },
    budget: { type: "string", default: "16,32,48" },
  },
});

const SW = 1920, SH = 1080, RECORD = 11;
const image = new PreparedImage(join(args.images, args.image), args.image);
const { width: W, height: H, maxLevel } = image.chart;

const sizes = new Map<string, { held: number; wire: number }>();
function sizeOf(u: UnitId): { held: number; wire: number } {
  const k = unitKey(u);
  let s = sizes.get(k);
  if (s) return s;
  if (u.kind === KIND_SPLAT) {
    const path = image.splatPath(u.level, u.x, u.y);
    const fd = openSync(path, "r"), head = Buffer.alloc(14);
    readSync(fd, head, 0, 14, 0);
    closeSync(fd);
    const n = head.readUInt32BE(10);
    s = { held: n * RECORD, wire: n * RECORD + Math.max(1, Math.ceil(n / 100)) * 45 };
  } else {
    const [w, h] = image.unitSize(u.level, u.x, u.y);
    const f = image.tileFile(u.level, u.x, u.y);
    s = { held: w * h * 4, wire: f ? statSync(f.path).size : 0 };   // no mipmaps
  }
  sizes.set(k, s);
  return s;
}

/** What the viewer draws for a view, with how much of the screen each unit covers. */
function frameUnits(v: Omit<View, "dropped">): Map<string, { u: UnitId; share: number }> {
  const out = new Map<string, { u: UnitId; share: number }>();
  const X0 = v.cx - (v.screenW * v.scale) / 2, X1 = v.cx + (v.screenW * v.scale) / 2;
  const Y0 = v.cy - (v.screenH * v.scale) / 2, Y1 = v.cy + (v.screenH * v.scale) / 2;
  const area = (X1 - X0) * (Y1 - Y0);
  for (const u of image.unitsFor({ ...v, dropped: [] })) {
    const span = image.chart.tile * 2 ** u.level, [w, h] = image.unitSize(u.level, u.x, u.y);
    const ux0 = u.x * span, uy0 = u.y * span, ux1 = ux0 + w * 2 ** u.level, uy1 = uy0 + h * 2 ** u.level;
    const ix = Math.max(0, Math.min(X1, ux1) - Math.max(X0, ux0)), iy = Math.max(0, Math.min(Y1, uy1) - Math.max(Y0, uy0));
    out.set(unitKey(u), { u, share: (ix * iy) / area });
  }
  return out;
}

// sessions: lists of views, one per frame (60 frames a second)
const fit = Math.max(W / SW, H / SH) / 0.95;
const view = (cx: number, cy: number, scale: number) => ({ cx, cy, scale, screenW: SW, screenH: SH });
function zoom(from: [number, number, number], to: [number, number, number], frames: number) {
  const out = [];
  for (let i = 1; i <= frames; i++) {
    const t = i / frames, ls = Math.log(from[2]) + (Math.log(to[2]) - Math.log(from[2])) * t;
    out.push(view(from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t, Math.exp(ls)));
  }
  return out;
}
const hold = (v: ReturnType<typeof view>, frames: number) => Array(frames).fill(v);
// spots inside the image (bills.jpg is about 4.3 screens wide at 1:1)
const A: [number, number, number] = [W * 0.25, H * 0.4, 1], B: [number, number, number] = [W * 0.75, H * 0.65, 1];
const O: [number, number, number] = [W / 2, H / 2, fit];
const Aright: [number, number, number] = [W * 0.75, H * 0.4, 1];
const row = (y: number, x0: number, x1: number): [number, number, number][] => [[W * x0, H * y, 1], [W * x1, H * y, 1]];
const sessions: Record<string, ReturnType<typeof view>[]> = {
  "pan away from A, come back": [
    ...hold(view(...O), 30), ...zoom(O, A, 90), ...hold(view(...A), 60),
    ...zoom(A, Aright, 180), ...zoom(Aright, A, 180), ...hold(view(...A), 60),
  ],
  "A, B, then A again": [
    ...hold(view(...O), 30), ...zoom(O, A, 90), ...hold(view(...A), 60), ...zoom(A, O, 90),
    ...zoom(O, B, 90), ...hold(view(...B), 60), ...zoom(B, O, 90), ...zoom(O, A, 90), ...hold(view(...A), 60),
  ],
  "zig-zag over the image at 1:1": [
    ...hold(view(...O), 30), ...zoom(O, row(0.25, 0.12, 0.88)[0], 90),
    ...zoom(...row(0.25, 0.12, 0.88) as [[number, number, number], [number, number, number]], 240),
    ...zoom(row(0.25, 0.12, 0.88)[1], row(0.6, 0.88, 0.12)[0], 60),
    ...zoom(...row(0.6, 0.88, 0.12) as [[number, number, number], [number, number, number]], 240),
    ...zoom(row(0.6, 0.88, 0.12)[1], row(0.25, 0.12, 0.88)[0], 60),
    ...zoom(...row(0.25, 0.12, 0.88) as [[number, number, number], [number, number, number]], 240),
  ],
};

type Policy = "sandpile" | "forgetting" | "lru";
function run(policy: Policy, budget: number, frames: ReturnType<typeof view>[]) {
  const cache = policy === "sandpile" ? new SandpileCache(budget, maxLevel)
    : policy === "forgetting" ? new ForgettingCache(budget, maxLevel) : new LruCache(budget, maxLevel);
  const everHad = new Set<string>();
  let wire = 0, refetch = 0, peak = 0;
  frames.forEach((v, i) => {
    const now = i * (1000 / 60);
    const units = frameUnits(v);
    for (const [k, { u }] of units) {
      if (cache.has(k)) continue;
      const s = sizeOf(u);
      wire += s.wire;
      if (everHad.has(k)) refetch += s.wire;
      everHad.add(k);
      cache.add({ key: k, kind: u.kind, level: u.level, x: u.x, y: u.y, bytes: s.held } as Site, now);
    }
    peak = Math.max(peak, cache.held);
    cache.frame(new Map([...units].map(([k, x]) => [k, x.share])), now);
  });
  return { wire, refetch, peak, end: cache.held };
}

const MB = 2 ** 20, f = (b: number) => (b / MB).toFixed(1);
console.log(`${args.image} (${W} x ${H}), screen ${SW} x ${SH}`);
const rows = [];
for (const [name, frames] of Object.entries(sessions)) {
  for (const b of args.budget.split(",").map(Number)) {
    const s = run("sandpile", b * MB, frames), e = run("forgetting", b * MB, frames), l = run("lru", b * MB, frames);
    rows.push({ session: name, "budget MB": b,
                "refetched MB: sandpile / forgetting / LRU": `${f(s.refetch)} / ${f(e.refetch)} / ${f(l.refetch)}`,
                "downloaded MB": `${f(s.wire)} / ${f(e.wire)} / ${f(l.wire)}`,
                "peak MB": `${f(s.peak)} / ${f(e.peak)} / ${f(l.peak)}` });
  }
}
console.table(rows);
