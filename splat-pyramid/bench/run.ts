// Scripted sessions against a real server over UDP, under emulated links. For each
// configuration it starts a server with that link, runs a headless client (the same
// ClientLink the browser bridge uses) through a scripted session, and reports how fast the
// view filled in and what the loss cost.
//
//   node bench/run.ts [--images data] [--image bills] [--session jump|dive]
//                     [--configs "lan@50,home@50,mobile@50,home@18!"] [--repeat 5]
//
// With --repeat, each config runs that many times and the table shows medians (loss and
// the rate controller's tumbles are random, so single runs are noisy).
//
// A config is PROFILE@RATE: the emulated link (shared/emulator.ts) and the server's upload
// cap in Mbit/s, under which run-and-tumble picks the rate. PROFILE@RATE! sends at exactly
// RATE instead, for comparison. The link is applied both ways: server->client by the
// server, client->server by the client.
//
// For the final view of the session it measures:
//   first   time until every unit the view needs has at least one packet (something drawn
//           everywhere: with confetti, any packet of a unit draws the whole unit, softer)
//   sharp   time until the view is at full quality: every image tile complete when the zoom
//           wants tiles, else every splat unit complete (splat chunks under the tiles are
//           sent last on purpose, as the placeholder for the next move)
//   partial of the units that decide "sharp", those still incomplete when the hold ends

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
    repeat: { type: "string", default: "1" },
    session: { type: "string", default: "jump" },
    configs: { type: "string", default: "lan@50,home@50,mobile@50,home@18!,mobile@1.8!" },
    port: { type: "string", default: "9100" },
    hold: { type: "string", default: "8000" },
  },
});

const SCREEN_W = 1920, SCREEN_H = 1080;
const image = new PreparedImage(join(args.images, args.image), args.image);
const { width: W, height: H } = image.chart;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The views of a session, one every `stepMs`; the last one is held and measured. */
function script(kind: string): { views: Omit<View, "dropped">[]; stepMs: number } {
  const fit = Math.max(W / SCREEN_W, H / SCREEN_H) / 0.95;
  const at = (cx: number, cy: number, scale: number) => ({ cx, cy, scale, screenW: SCREEN_W, screenH: SCREEN_H });
  if (kind === "dive") {
    // wheel zoom from the whole image to 1:1 on a point, 10% per step
    const px = W * 0.62, py = H * 0.41, views = [];
    for (let s = fit; s > 1; s /= 1.1) {
      const t = 1 - (s - 1) / (fit - 1);
      views.push(at(W / 2 + (px - W / 2) * t, H / 2 + (py - H / 2) * t, s));
    }
    views.push(at(px, py, 1));
    return { views, stepMs: 50 };
  }
  // jump: the whole image, then straight to 1:1 on a point
  return { views: [at(W / 2, H / 2, fit), at(W * 0.62, H * 0.41, 1)], stepMs: 3000 };
}

function startServer(profile: string, rate: string, fixed: boolean): Promise<ChildProcess> {
  const child = spawn(process.execPath, [join(import.meta.dirname, "..", "server", "main.ts"),
    "--images", args.images, "--port", args.port, "--rate", rate, "--impair", profile,
    ...(fixed ? ["--fixed"] : [])],
    { stdio: ["ignore", "pipe", "inherit"] });
  return new Promise((resolve) => {
    child.stdout!.on("data", (d: Buffer) => { if (d.toString().includes("server on udp")) resolve(child); });
  });
}

async function run(profile: string, rateSpec: string) {
  const fixed = rateSpec.endsWith("!");
  const rate = rateSpec.replace("!", "");
  const server = await startServer(profile, rate, fixed);
  const link = new ClientLink(`127.0.0.1:${args.port}`, parseImpairment(profile));
  await link.bind();
  let stats: Record<string, any> = {};
  let chart = false;
  link.events = { chart: () => { chart = true; }, stats: (s) => { stats = s; } };
  const t0 = performance.now();
  // HELLO and OPEN ride the emulated path too: repeat until the server answers
  while (!chart) {
    if (!link.welcomed) link.hello();
    else link.open(args.image);
    await sleep(200);
    if (performance.now() - t0 > 10_000) throw new Error("server never answered");
  }

  const { views, stepMs } = script(args.session);
  for (const v of views.slice(0, -1)) {
    link.view(v);
    await sleep(stepMs);
  }
  const final = views[views.length - 1];
  const needed = image.unitsFor({ ...final, dropped: [] });
  const need = needed.map(unitKey);
  const tilesWanted = needed.some((u) => u.kind === KIND_TILE);
  const decisive = needed.filter((u) => !tilesWanted || u.kind === KIND_TILE).map(unitKey);
  const sentAt = performance.now();
  link.view(final);
  let first = NaN, full = NaN;
  while (performance.now() - sentAt < Number(args.hold)) {
    await sleep(20);
    const have = new Map(link.completeness().map((c) => [unitKey(c.id), c]));
    const now = performance.now() - sentAt;
    if (Number.isNaN(first) && need.every((k) => (have.get(k)?.got ?? 0) > 0)) first = now;
    if (Number.isNaN(full) && decisive.every((k) => { const c = have.get(k); return c && c.got === c.total; })) full = now;
    if (!Number.isNaN(full)) break;
  }
  await sleep(600);                                   // one more STATS from the server
  const have = new Map(link.completeness().map((c) => [unitKey(c.id), c]));
  const partial = decisive.map((k) => have.get(k) ?? { got: 0, total: 1 }).filter((c) => c.got < c.total);
  const srv = stats;
  link.bye();
  link.close();
  server.kill();
  await sleep(200);
  const worst = partial.length ? Math.min(...partial.map((c) => c.got / c.total)) : 1;
  return {
    config: `${profile}@${rateSpec}`,
    firstMs: Number.isNaN(first) ? Infinity : first,
    sharpMs: Number.isNaN(full) ? Infinity : full,
    partial: partial.length,
    worstPartial: worst,
    sentMB: (srv.bytesSent ?? 0) / 2 ** 20,
    lost: srv.path?.lost ?? 0,
    queueDrops: srv.path?.queueDrops ?? 0,
    repairMB: (srv.topupBytes ?? 0) / 2 ** 20,
    duplicates: link.received.duplicates,
    rateMbit: srv.control?.rateMbit ?? NaN,
    queueMs: srv.control?.queueMs ?? NaN,
  };
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const secs = (ms: number) => (Number.isFinite(ms) ? `${(ms / 1000).toFixed(2)} s` : "never");

const repeat = Number(args.repeat);
console.log(`${args.image} (${W} x ${H}), session "${args.session}", screen ${SCREEN_W} x ${SCREEN_H}, ` +
            `${repeat} run(s) per config${repeat > 1 ? ", medians" : ""}`);
const rows = [];
for (const c of args.configs.split(",")) {
  const [profile, rate] = c.split("@");
  const runs: Awaited<ReturnType<typeof run>>[] = [];
  for (let i = 0; i < repeat; i++) runs.push(await run(profile, rate ?? "50"));
  const m = (k: "firstMs" | "sharpMs" | "sentMB" | "repairMB" | "lost" | "queueDrops" | "rateMbit" | "queueMs") =>
    median(runs.map((r) => r[k]));
  rows.push({
    config: runs[0].config,
    first: secs(m("firstMs")),
    sharp: secs(m("sharpMs")),
    "sharp worst": secs(Math.max(...runs.map((r) => r.sharpMs))),
    sentMB: m("sentMB").toFixed(2),
    repairMB: m("repairMB").toFixed(2),
    lost: m("lost"),
    queueDrops: m("queueDrops"),
    rateMbit: m("rateMbit"),
    queueMs: m("queueMs"),
  });
  console.log(JSON.stringify(rows[rows.length - 1]));
}
console.table(rows);
