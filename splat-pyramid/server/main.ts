// The server: one UDP socket, one session per client half, a shared packet cache, and a
// pacing loop that hands out a fixed sending rate (step 1 of the plan; run-and-tumble
// replaces the fixed rate in step 3).
//
//   node server/main.ts [--images DIR] [--port 9000] [--rate 50]
//
// --images   folder of prepared images (each subfolder with pyramid.json and splats/)
// --rate     sending rate in Mbit/s, shared by all sessions

import { createSocket } from "node:dgram";
import { parseArgs } from "node:util";
import { Type, decode, encode, typeName } from "../shared/wire.ts";
import { findImages } from "./image.ts";
import { PacketCache, Session } from "./session.ts";

const { values: args } = parseArgs({
  options: {
    images: { type: "string", default: "prototype" },
    port: { type: "string", default: "9000" },
    rate: { type: "string", default: "50" },
  },
});

const images = findImages(args.images);
if (images.size === 0) {
  console.error(`no prepared images in ${args.images} (each needs pyramid.json and splats/)`);
  process.exit(1);
}
const rateBytes = (Number(args.rate) * 1e6) / 8;
const TICK_MS = 2;
const SESSION_TIMEOUT_MS = 30_000;
const cache = new PacketCache();
const sessions = new Map<string, Session>();
const socket = createSocket("udp4");

socket.on("message", (datagram, rinfo) => {
  const m = decode(datagram);
  if (!m) return;
  const key = `${rinfo.address}:${rinfo.port}`;
  let s = sessions.get(key);
  if (!s) {
    if (m.type !== Type.HELLO) return;           // a session starts with HELLO
    s = new Session({ address: rinfo.address, port: rinfo.port }, images, cache,
      (msg) => socket.send(msg, rinfo.port, rinfo.address));
    sessions.set(key, s);
    console.log(`session ${key} started (${sessions.size} open)`);
  }
  if (m.type === Type.OPEN) console.log(`session ${key}: ${typeName(m.type)} ${m.payload.toString("utf8")}`);
  s.onMessage(m);
  if (m.type === Type.BYE) {
    sessions.delete(key);
    console.log(`session ${key} ended (${sessions.size} open)`);
  }
});

// Pacing: every tick, the bytes the rate allows are shared round-robin between sessions
// with something to send. Unused allowance is not banked beyond one tick, so there are no
// bursts after an idle spell.
let last = performance.now();
let turn = 0;
setInterval(() => {
  const now = performance.now();
  let allowance = Math.min(rateBytes * ((now - last) / 1000), rateBytes * 0.01);
  last = now;
  const busy = [...sessions.values()].filter((s) => !s.idle);
  if (busy.length === 0) return;
  const share = allowance / busy.length;
  for (let i = 0; i < busy.length && allowance > 0; i++) {
    const s = busy[(turn + i) % busy.length];
    allowance -= s.pump(share);
  }
  turn++;
}, TICK_MS);

// STATS to every session twice a second; drop sessions that went quiet
setInterval(() => {
  const now = Date.now();
  for (const [key, s] of sessions) {
    if (now - s.lastHeard > SESSION_TIMEOUT_MS) {
      sessions.delete(key);
      console.log(`session ${key} timed out (${sessions.size} open)`);
      continue;
    }
    const stats = { ...s.stats(rateBytes * 8), sessions: sessions.size,
                    cache: { hits: cache.hits, misses: cache.misses } };
    s.send(encode(Type.STATS, s.epoch, Buffer.from(JSON.stringify(stats))));
  }
}, 500);

socket.bind(Number(args.port), () => {
  console.log(`server on udp ${args.port}, ${args.rate} Mbit/s, images: ${[...images.keys()].join(", ")}`);
});
