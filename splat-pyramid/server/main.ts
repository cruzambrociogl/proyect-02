// The server: one UDP socket, one session per client half, a shared packet cache, and a
// pacing loop. Each session sends at the rate its run-and-tumble controller chooses
// (server/tumble.ts), and all of them together stay under the server's own cap.
//
//   node server/main.ts [--images DIR] [--port 9000] [--rate 50] [--impair SPEC]
//
// --images   folder of prepared images (each subfolder with pyramid.json and splats/)
// --rate     the server's upload cap in Mbit/s, shared by all sessions (each session's own
//            rate is chosen by run-and-tumble, up to this)
// --fixed    send every session at exactly --rate, no rate control (for comparison)
// --no-apollonius   no multi-user model: the packet cache evicts plain LRU
// --cache    MB of prepared packets the server keeps for all sessions (default 128)
// --impair   emulate the path toward each client: loss, delay, rate... (shared/emulator.ts)

import { createSocket } from "node:dgram";
import { parseArgs } from "node:util";
import { Type, decode, encode, typeName } from "../shared/wire.ts";
import { EmulatedPath, describe, parseImpairment } from "../shared/emulator.ts";
import { findImages } from "./image.ts";
import { PacketCache, Session } from "./session.ts";
import { Apollonius } from "./apollonius.ts";

const { values: args } = parseArgs({
  options: {
    images: { type: "string", default: "prototype" },
    port: { type: "string", default: "9000" },
    rate: { type: "string", default: "50" },
    impair: { type: "string", default: "none" },
    fixed: { type: "boolean", default: false },
    "no-apollonius": { type: "boolean", default: false },
    cache: { type: "string", default: "128" },
  },
});

const images = findImages(args.images);
if (images.size === 0) {
  console.error(`no prepared images in ${args.images} (each needs pyramid.json and splats/)`);
  process.exit(1);
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
let last = performance.now();
let serverTokens = 0;
let turn = 0;
setInterval(() => {
  const now = performance.now();
  const dt = (now - last) / 1000;
  last = now;
  serverTokens = Math.min(serverTokens + rateBytes * dt, rateBytes * 0.01);
  const all = [...sessions.values()];
  for (let i = 0; i < all.length; i++) {
    const s = all[(turn + i) % all.length];
    if (args.fixed) s.rc.rate = rateBytes;
    s.tokens = Math.min(s.tokens + s.rc.rate * dt, s.rc.rate * 0.01);
    const busy = !s.idle;
    s.rc.tick(busy);
    if (!busy || s.tokens <= 0 || serverTokens <= 0) continue;
    const spent = s.pump(Math.min(s.tokens, serverTokens));
    s.tokens -= spent;
    serverTokens -= spent;
  }
  turn++;
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
