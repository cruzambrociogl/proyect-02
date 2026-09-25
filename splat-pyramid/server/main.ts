// The server: one UDP socket, one session per client half, a shared packet cache, and a
// pacing loop that hands out a fixed sending rate (step 1 of the plan; run-and-tumble
// replaces the fixed rate in step 3).
//
//   node server/main.ts [--images DIR] [--port 9000] [--rate 50] [--impair SPEC]
//
// --images   folder of prepared images (each subfolder with pyramid.json and splats/)
// --rate     sending rate in Mbit/s, shared by all sessions
// --impair   emulate the path toward each client: loss, delay, rate... (shared/emulator.ts)

import { createSocket } from "node:dgram";
import { parseArgs } from "node:util";
import { Type, decode, encode, typeName } from "../shared/wire.ts";
import { EmulatedPath, describe, parseImpairment } from "../shared/emulator.ts";
import { findImages } from "./image.ts";
import { PacketCache, Session } from "./session.ts";

const { values: args } = parseArgs({
  options: {
    images: { type: "string", default: "prototype" },
    port: { type: "string", default: "9000" },
    rate: { type: "string", default: "50" },
    impair: { type: "string", default: "none" },
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
const cache = new PacketCache();
const sessions = new Map<string, Session>();
const paths = new Map<string, EmulatedPath>();
const socket = createSocket("udp4");

socket.on("message", (datagram, rinfo) => {
  const m = decode(datagram);
  if (!m) return;
  const key = `${rinfo.address}:${rinfo.port}`;
  let s = sessions.get(key);
  if (!s) {
    if (m.type !== Type.HELLO) return;           // a session starts with HELLO
    // every client gets its own emulated path
    const path = new EmulatedPath(downstream, (msg) => socket.send(msg, rinfo.port, rinfo.address));
    s = new Session({ address: rinfo.address, port: rinfo.port }, images, cache, (msg) => path.send(msg));
    paths.set(key, path);
    sessions.set(key, s);
    console.log(`session ${key} started (${sessions.size} open)`);
  }
  if (m.type === Type.OPEN) console.log(`session ${key}: ${typeName(m.type)} ${m.payload.toString("utf8")}`);
  s.onMessage(m);
  if (m.type === Type.BYE) {
    sessions.delete(key);
    paths.delete(key);
    console.log(`session ${key} ended (${sessions.size} open)`);
  }
});

// Pacing: a token bucket. Every tick adds the bytes the rate allows (at most 10 ms worth, so
// an idle spell never turns into a burst), and sessions with something to send share them
// round-robin. A packet is sent whole even when it overdraws the bucket; the overdraft is
// paid back on the next ticks, so the average rate holds whatever the packet size.
let last = performance.now();
let tokens = 0;
let turn = 0;
setInterval(() => {
  const now = performance.now();
  tokens = Math.min(tokens + rateBytes * ((now - last) / 1000), rateBytes * 0.01);
  last = now;
  if (tokens <= 0) return;
  const busy = [...sessions.values()].filter((s) => !s.idle);
  if (busy.length === 0) return;
  const share = tokens / busy.length;
  for (let i = 0; i < busy.length && tokens > 0; i++) {
    tokens -= busy[(turn + i) % busy.length].pump(share);
  }
  turn++;
}, TICK_MS);

// STATS to every session twice a second; drop sessions that went quiet
setInterval(() => {
  const now = Date.now();
  for (const [key, s] of sessions) {
    if (now - s.lastHeard > SESSION_TIMEOUT_MS) {
      sessions.delete(key);
      paths.delete(key);
      console.log(`session ${key} timed out (${sessions.size} open)`);
      continue;
    }
    const p = paths.get(key);
    const stats = { ...s.stats(rateBytes * 8), sessions: sessions.size,
                    cache: { hits: cache.hits, misses: cache.misses },
                    path: p ? { sent: p.sent, lost: p.dropped, queueDrops: p.queueDrops } : null };
    s.send(encode(Type.STATS, s.epoch, Buffer.from(JSON.stringify(stats))));
  }
}, 500);

socket.bind(Number(args.port), () => {
  console.log(`server on udp ${args.port}, ${args.rate} Mbit/s, images: ${[...images.keys()].join(", ")}`);
  console.log(`path to clients: ${describe(downstream)}`);
});
