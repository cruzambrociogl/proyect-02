// Several users at once against one server, each on its own emulated link: what Apollonius
// saves the server (disk reads, CPU) and what the users see (time until sharp).
//
//   node bench/users.ts [--users 3] [--scenario converge|spread] [--profile home]
//                       [--cache 8] [--apollonius on|off|both] [--repeat 3]
//
// converge  every user starts on the whole image and zooms to 1:1 on the same spot, one
//           after another (0.7 s apart): the later ones walk where the first already went
// spread    every user zooms to a different spot
//
// --cache is the server's packet cache in MB: small, so what it keeps matters.

import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ClientLink } from "../client/link.ts";
import { parseImpairment } from "../shared/emulator.ts";
import { KIND_TILE, unitKey, type View } from "../shared/wire.ts";
import { PreparedImage } from "../server/image.ts";

const { values: args } = parseArgs({
  options: {
    images: { type: "string", default: "data" },
    image: { type: "string", default: "bills" },
    users: { type: "string", default: "3" },
    scenario: { type: "string", default: "converge" },
    profile: { type: "string", default: "home" },
    rate: { type: "string", default: "50" },
    cache: { type: "string", default: "8" },
    apollonius: { type: "string", default: "both" },
    repeat: { type: "string", default: "3" },
    port: { type: "string", default: "9200" },
  },
});

const SCREEN_W = 1920, SCREEN_H = 1080;
const image = new PreparedImage(join(args.images, args.image), args.image);
const { width: W, height: H } = image.chart;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

function dive(px: number, py: number): Omit<View, "dropped">[] {
  const fit = Math.max(W / SCREEN_W, H / SCREEN_H) / 0.95, views = [];
  for (let s = fit; s > 1; s /= 1.1) {
    const t = 1 - (s - 1) / (fit - 1);
    views.push({ cx: W / 2 + (px - W / 2) * t, cy: H / 2 + (py - H / 2) * t, scale: s, screenW: SCREEN_W, screenH: SCREEN_H });
  }
  views.push({ cx: px, cy: py, scale: 1, screenW: SCREEN_W, screenH: SCREEN_H });
  return views;
}

const SPOTS = [[0.62, 0.41], [0.3, 0.7], [0.8, 0.25], [0.45, 0.2], [0.2, 0.3]];

async function startServer(apollonius: boolean): Promise<ChildProcess> {
  const child = spawn(process.execPath, [join(import.meta.dirname, "..", "server", "main.ts"),
    "--images", args.images, "--port", args.port, "--rate", args.rate, "--impair", args.profile,
    "--cache", args.cache, ...(apollonius ? [] : ["--no-apollonius"])], { stdio: ["ignore", "pipe", "inherit"] });
  return new Promise((resolve) => {
    child.stdout!.on("data", (d: Buffer) => { if (d.toString().includes("server on udp")) resolve(child); });
  });
}

async function user(i: number, stats: Record<string, any>[]): Promise<number> {
  const link = new ClientLink(`127.0.0.1:${args.port}`, parseImpairment(args.profile));
  await link.bind();
  let chart = false;
  link.events = { chart: () => { chart = true; }, stats: (s) => { stats[i] = s; } };
  link.hello();
  link.open(args.image);
  while (!chart) await sleep(20);
  await sleep(i * 700);                                    // users arrive one after another
  const [sx, sy] = args.scenario === "converge" ? SPOTS[0] : SPOTS[i % SPOTS.length];
  const views = dive(W * sx, H * sy);
  for (const v of views.slice(0, -1)) {
    link.view(v);
    await sleep(50);
  }
  const final = views[views.length - 1];
  const needed = image.unitsFor({ ...final, dropped: [] });
  const tilesWanted = needed.some((u) => u.kind === KIND_TILE);
  const decisive = needed.filter((u) => !tilesWanted || u.kind === KIND_TILE).map(unitKey);
  link.view(final);
  const t0 = performance.now();
  let sharp = Infinity;
  while (performance.now() - t0 < 8000) {
    await sleep(20);
    const have = new Map(link.completeness().map((c) => [unitKey(c.id), c]));
    if (decisive.every((k) => { const c = have.get(k); return c && c.got === c.total; })) { sharp = performance.now() - t0; break; }
  }
  await sleep(1200);
  link.bye();
  link.close();
  return sharp;
}

async function run(apollonius: boolean) {
  const server = await startServer(apollonius);
  const n = Number(args.users), stats: Record<string, any>[] = [];
  const sharp = await Promise.all(Array.from({ length: n }, (_, i) => user(i, stats)));
  server.kill();
  await sleep(300);
  const last = stats.filter(Boolean).sort((a, b) => b.cpuMs - a.cpuMs)[0] ?? {};
  return {
    sharp,
    reads: last.cache?.misses ?? NaN,
    hits: last.cache?.hits ?? NaN,
    evictedWanted: last.cache?.evictedWanted ?? 0,
    cpuMs: last.cpuMs ?? NaN,
    sentMB: stats.reduce((a, s) => a + (s?.bytesSent ?? 0), 0) / 2 ** 20,
  };
}

console.log(`${args.image}: ${args.users} users, "${args.scenario}", ${args.profile} links, ` +
            `server cache ${args.cache} MB, ${args.repeat} runs each (medians)`);
const rows = [];
const modes = args.apollonius === "both" ? [true, false] : [args.apollonius === "on"];
for (const on of modes) {
  const runs: Awaited<ReturnType<typeof run>>[] = [];
  for (let r = 0; r < Number(args.repeat); r++) runs.push(await run(on));
  const secs = (ms: number) => (Number.isFinite(ms) ? `${(ms / 1000).toFixed(2)} s` : "never");
  const perUser = runs[0].sharp.map((_, i) => secs(median(runs.map((r) => r.sharp[i]))));
  rows.push({
    apollonius: on ? "on" : "off",
    "sharp per user": perUser.join(" / "),
    "disk reads": median(runs.map((r) => r.reads)),
    "cache hits": median(runs.map((r) => r.hits)),
    "evicted while wanted": median(runs.map((r) => r.evictedWanted)),
    "server CPU": `${median(runs.map((r) => r.cpuMs))} ms`,
    sentMB: median(runs.map((r) => r.sentMB)).toFixed(2),
  });
}
console.table(rows);
