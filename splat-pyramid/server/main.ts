// The server: one UDP socket, one session per client half, a shared packet cache, and a
// pacing loop. Each session sends at the rate its run-and-tumble controller chooses
// (server/tumble.ts), and all of them together stay under the server's own cap.
//
//   node server/main.ts [--images data] [--originals originals] [--http 8000] [--port 9000]
//                       [--rate 50] [--impair SPEC] [--python python3]
//
// --images     folder of prepared images (each subfolder made by splatpyr ingest + build)
// --originals  folder of source images, where the server site uploads to
// --http       port of the server site (upload, prepare, see what is served)
// --python     the Python with splatpyr's requirements, for preparing images
// --rate     the server's upload cap in Mbit/s, shared by all sessions (each session's own
//            rate is chosen by run-and-tumble, up to this)
// --fixed    send every session at exactly --rate, no rate control (for comparison)
// --no-apollonius   no multi-user model: the packet cache evicts plain LRU, and the server's
//                   upload is shared equally when it is what binds
// --cache    MB of prepared packets the server keeps for all sessions (default 128)
// --impair   emulate the path toward each client: loss, delay, rate... (shared/emulator.ts)

import { createSocket } from "node:dgram";
import { parseArgs } from "node:util";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Type, decode, encode, encodeCatalog, typeName } from "../shared/wire.ts";
import { EmulatedPath, describe, parseImpairment } from "../shared/emulator.ts";
import { findImages } from "./image.ts";
import { PacketCache, Session } from "./session.ts";
import { Apollonius } from "./apollonius.ts";
import { startAdmin } from "./admin.ts";

const { values: args } = parseArgs({
  options: {
    images: { type: "string", default: "data" },
    originals: { type: "string", default: "originals" },
    http: { type: "string", default: "8000" },
    python: { type: "string", default: "python3" },
    port: { type: "string", default: "9000" },
    rate: { type: "string", default: "50" },
    impair: { type: "string", default: "none" },
    fixed: { type: "boolean", default: false },
    "no-apollonius": { type: "boolean", default: false },
    cache: { type: "string", default: "128" },
  },
});

mkdirSync(args.images, { recursive: true });
mkdirSync(args.originals, { recursive: true });
// the images being served; sessions hold this map, so it is updated in place
const images = findImages(args.images);
const refresh = () => findImages(args.images, images);
setInterval(refresh, 2000);
startAdmin({ port: Number(args.http), data: args.images, originals: args.originals, python: args.python,
             root: join(import.meta.dirname, ".."), onReady: refresh });

/** The catalog: the images ready to be viewed, for LIST. */
function catalog(): Buffer[] {
  refresh();
  const list = [...images.values()].map((i) => i.chart).sort((a, b) => a.name.localeCompare(b.name));
  return encodeCatalog(JSON.stringify({ images: list, site: Number(args.http) }));
}
const rateBytes = (Number(args.rate) * 1e6) / 8;
const downstream = parseImpairment(args.impair);
const TICK_MS = 2;
const SESSION_TIMEOUT_MS = 30_000;
const cache = new PacketCache(Number(args.cache) * 2 ** 20);
const apollo = args["no-apollonius"] ? null : new Apollonius();
if (apollo) cache.demand = (image, u) => apollo.demand(image, u).interest;

// Incoming messages per client: a client sends one view per change and a report every 100 ms,
// so anything far beyond that is not a viewer. Excess is dropped, never processed.
const INCOMING_PER_S = 60, INCOMING_BURST = 120;
const incoming = new Map<string, { tokens: number; at: number }>();
let refused = 0;
function admit(key: string): boolean {
  const now = performance.now();
  const b = incoming.get(key) ?? { tokens: INCOMING_BURST, at: now };
  b.tokens = Math.min(INCOMING_BURST, b.tokens + ((now - b.at) / 1000) * INCOMING_PER_S);
  b.at = now;
  incoming.set(key, b);
  if (b.tokens < 1) { refused++; return false; }
  b.tokens -= 1;
  return true;
}
const sessions = new Map<string, Session>();
const paths = new Map<string, EmulatedPath>();
const socket = createSocket("udp4");

socket.on("message", (datagram, rinfo) => {
  const m = decode(datagram);
  if (!m) return;
  const key = `${rinfo.address}:${rinfo.port}`;
  if (!admit(key)) return;
  if (m.type === Type.LIST) {                    // needs no session: the gallery asks before opening
    for (const part of catalog()) socket.send(encode(Type.CATALOG, m.epoch, part), rinfo.port, rinfo.address);
    return;
  }
  let s = sessions.get(key);
  if (!s) {
    if (m.type !== Type.HELLO) return;           // a session starts with HELLO
    // every client gets its own emulated path
    const path = new EmulatedPath(downstream, (msg) => socket.send(msg, rinfo.port, rinfo.address));
    s = new Session({ address: rinfo.address, port: rinfo.port }, images, cache, (msg) => path.send(msg), rateBytes);
    if (args.fixed) s.rc.rate = rateBytes;
    paths.set(key, path);
    if (apollo) s.attach(apollo, key);
    sessions.set(key, s);
    console.log(`session ${key} started (${sessions.size} open)`);
  }
  if (m.type === Type.OPEN) console.log(`session ${key}: ${typeName(m.type)} ${m.payload.toString("utf8")}`);
  s.onMessage(m);
  if (m.type === Type.BYE) {
    sessions.delete(key);
    paths.delete(key);
    apollo?.forget(key);
    incoming.delete(key);
    console.log(`session ${key} ended (${sessions.size} open)`);
  }
});

// Pacing: token buckets. Every tick each session earns the bytes its own rate allows, and the
// server as a whole earns what its cap allows; a session sends what both let it. A packet is
// sent whole even when it overdraws a bucket; the overdraft is paid back on the next ticks,
// so the average rate holds whatever the packet size. At most 10 ms of allowance is kept, so
// an idle spell never turns into a burst.
//
// When the server's cap is what binds, its allowance is shared out: with Apollonius, in
// proportion to 1 / (1 + speed) of each user (server/apollonius.ts), so the users who will
// still be looking when the data lands get most of it; without, equally. What a session
// cannot use goes to the others in a second pass.
let last = performance.now();
let serverTokens = 0;
let turn = 0;
setInterval(() => {
  const now = performance.now();
  const dt = (now - last) / 1000;
  last = now;
  serverTokens = Math.min(serverTokens + rateBytes * dt, rateBytes * 0.01);
  const all = [...sessions.entries()];
  const busy: [string, Session][] = [];
  for (let i = 0; i < all.length; i++) {
    const [key, s] = all[(turn + i) % all.length];
    if (args.fixed) s.rc.rate = rateBytes;
    s.tokens = Math.min(s.tokens + s.rc.rate * dt, s.rc.rate * 0.01);
    const b = !s.idle;
    s.rc.tick(b);
    if (b && s.tokens > 0) busy.push([key, s]);
  }
  turn++;
  if (!busy.length || serverTokens <= 0) return;
  const weight = (key: string) => (apollo ? 1 / (1 + apollo.speed(key)) : 1);
  for (let pass = 0; pass < 2 && serverTokens > 0; pass++) {
    const wanting = busy.filter(([, s]) => s.tokens > 0 && !s.idle);
    const total = wanting.reduce((a, [k]) => a + weight(k), 0);
    const pool = serverTokens;
    for (const [key, s] of wanting) {
      const share = pass === 0 ? (pool * weight(key)) / total : serverTokens;
      if (share <= 0 || serverTokens <= 0) continue;
      const spent = s.pump(Math.min(s.tokens, share));
      s.tokens -= spent;
      serverTokens -= spent;
    }
  }
}, TICK_MS);

// (Warming - preparing ahead of time the units several users were converging on - was tried
// and dropped: during a zoom views change every 50 ms, and most of what it prepared belonged
// to views replaced before anything was sent. It read more from disk, not less.)

// STATS to every session twice a second; drop sessions that went quiet
setInterval(() => {
  const now = Date.now();
  for (const [key, s] of sessions) {
    if (now - s.lastHeard > SESSION_TIMEOUT_MS) {
      sessions.delete(key);
      paths.delete(key);
      apollo?.forget(key);
      incoming.delete(key);
      console.log(`session ${key} timed out (${sessions.size} open)`);
      continue;
    }
    const p = paths.get(key);
    const stats = { ...s.stats(rateBytes * 8), sessions: sessions.size,
                    cache: { hits: cache.hits, misses: cache.misses, ...cache.held, evictions: cache.evictions,
                             evictedWanted: cache.evictedWanted },
                    apollonius: apollo ? { users: apollo.users } : null, refused,
                    cpuMs: Math.round((process.cpuUsage().user + process.cpuUsage().system) / 1000),
                    path: p ? { sent: p.sent, lost: p.dropped, queueDrops: p.queueDrops } : null };
    s.send(encode(Type.STATS, s.epoch, Buffer.from(JSON.stringify(stats))));
  }
}, 500);

socket.bind(Number(args.port), () => {
  console.log(`server on udp ${args.port}, ${args.rate} Mbit/s, images: ${[...images.keys()].join(", ")}`);
  console.log(`path to clients: ${describe(downstream)}`);
});
