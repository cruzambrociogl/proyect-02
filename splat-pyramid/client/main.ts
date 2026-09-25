// The client half: runs on the viewer's machine, because a browser cannot open a UDP
// socket. It speaks our protocol over UDP to the server and hands the browser what arrives,
// over a WebSocket on loopback. It also serves the viewer page.
//
//   node client/main.ts [--server 127.0.0.1:9000] [--port 8090]
//   then open http://127.0.0.1:8090/?image=NAME
//
// Browser -> client half (JSON text):
//   {type: "open", image}                       open an image
//   {type: "view", cx, cy, scale, w, h, dropped}  where the viewer is looking
// Client half -> browser:
//   text   {type: "chart" | "stats" | "fault" | "link", ...}
//   binary [1] + CONFETTI payload               some blobs of a splat unit, as they land
//   binary [2] + level u8, x u32, y u32, format u8, bytes   a whole image tile

import { createSocket } from "node:dgram";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { WebSocketServer, type WebSocket } from "ws";
import {
  Type, decode, encode, encodeReport, encodeView,
  type UnitId,
} from "../shared/wire.ts";
import { TILE_HEAD, TILE_PART, readTilePart } from "../shared/units.ts";

const { values: args } = parseArgs({
  options: {
    server: { type: "string", default: "127.0.0.1:9000" },
    port: { type: "string", default: "8090" },
  },
});
const [serverHost, serverPort] = [args.server.split(":")[0], Number(args.server.split(":")[1] ?? 9000)];
const VIEWER = join(import.meta.dirname, "..", "viewer");
const REPORT_MS = 100;
const TILE_ASSEMBLY_TIMEOUT_MS = 10_000;

const udp = createSocket("udp4");
let browser: WebSocket | null = null;
let epoch = 0;
let welcomed = false;
const received = { packets: 0, bytes: 0 };
const pendingDropped: UnitId[] = [];

// tiles being put back together from their parts
interface Assembly { data: Buffer; have: Set<number>; parts: number; format: number; started: number }
const assemblies = new Map<string, Assembly>();

function toServer(type: Parameters<typeof encode>[0], payload?: Uint8Array): void {
  udp.send(encode(type, epoch, payload), serverPort, serverHost);
}

function toBrowser(data: string | Buffer): void {
  if (browser && browser.readyState === browser.OPEN) browser.send(data);
}

udp.on("message", (datagram) => {
  const m = decode(datagram);
  if (!m) return;
  received.packets++;
  received.bytes += datagram.length;
  switch (m.type) {
    case Type.WELCOME:
      welcomed = true;
      toBrowser(JSON.stringify({ type: "link", state: "connected", server: args.server }));
      break;
    case Type.CHART:
      toBrowser(JSON.stringify({ type: "chart", ...JSON.parse(m.payload.toString("utf8")) }));
      break;
    case Type.STATS:
      toBrowser(JSON.stringify({ type: "stats", server: JSON.parse(m.payload.toString("utf8")),
                                 client: { ...received } }));
      break;
    case Type.FAULT:
      toBrowser(JSON.stringify({ type: "fault", message: m.payload.toString("utf8") }));
      break;
    case Type.CONFETTI:
      // blobs are useful on their own: straight through, no waiting for the rest of the unit
      toBrowser(Buffer.concat([Buffer.from([1]), m.payload]));
      break;
    case Type.TILEPART: {
      const h = readTilePart(m.payload);
      const key = `${h.level}/${h.x}/${h.y}`;
      let a = assemblies.get(key);
      if (!a) {
        a = { data: Buffer.alloc(h.total), have: new Set(), parts: h.parts, format: h.format, started: Date.now() };
        assemblies.set(key, a);
      }
      if (a.have.has(h.index)) break;
      const piece = m.payload.subarray(TILE_HEAD);
      piece.copy(a.data, h.index * TILE_PART);     // every part but the last is full
      a.have.add(h.index);
      if (a.have.size === a.parts) {
        assemblies.delete(key);
        const head = Buffer.alloc(10);
        head[0] = 2;
        head[1] = h.level;
        head.writeUInt32BE(h.x, 2);
        head.writeUInt32BE(h.y, 6);
        toBrowser(Buffer.concat([head, Buffer.from([a.format]), a.data]));
      }
      break;
    }
  }
});

// reports: what arrived so far; also keeps the session alive
setInterval(() => {
  if (!welcomed) return;
  toServer(Type.REPORT, encodeReport(received));
  const now = Date.now();
  for (const [key, a] of assemblies) if (now - a.started > TILE_ASSEMBLY_TIMEOUT_MS) assemblies.delete(key);
}, REPORT_MS);

// the page and the WebSocket share one port
const http = createServer((req, res) => {
  const path = (req.url ?? "/").split("?")[0];
  const files: Record<string, [string, string]> = {
    "/": ["index.html", "text/html; charset=utf-8"],
    "/index.html": ["index.html", "text/html; charset=utf-8"],
    "/viewer.js": [join("dist", "viewer.js"), "text/javascript; charset=utf-8"],
  };
  const file = files[path];
  if (!file) {
    res.writeHead(404).end("not found");
    return;
  }
  try {
    res.writeHead(200, { "Content-Type": file[1], "Cache-Control": "no-cache" })
       .end(readFileSync(join(VIEWER, file[0])));
  } catch {
    res.writeHead(500).end(`missing ${file[0]}: run "npm run build" first`);
  }
});

const wss = new WebSocketServer({ server: http, path: "/ws" });
wss.on("connection", (ws) => {
  if (browser) browser.close(1000, "another viewer took over this client half");
  browser = ws;
  // a fresh page holds nothing: start the session over so the server forgets what it sent
  welcomed = false;
  epoch = 0;
  pendingDropped.length = 0;
  assemblies.clear();
  toServer(Type.HELLO);
  ws.on("message", (data, isBinary) => {
    if (isBinary) return;
    const msg = JSON.parse(data.toString());
    if (msg.type === "open") {
      epoch++;
      toServer(Type.OPEN, Buffer.from(String(msg.image), "utf8"));
    } else if (msg.type === "view") {
      epoch++;
      pendingDropped.push(...(msg.dropped as UnitId[]));
      const dropped = pendingDropped.splice(0, pendingDropped.length);
      const payload = encodeView({ cx: msg.cx, cy: msg.cy, scale: msg.scale, screenW: msg.w,
                                   screenH: msg.h, dropped });
      toServer(Type.VIEW, payload);
      // what did not fit rides along with the next view
      const sent = payload.readUInt16BE(28);
      if (sent < dropped.length) pendingDropped.unshift(...dropped.slice(sent));
    }
  });
  ws.on("close", () => {
    if (browser === ws) {
      browser = null;
      toServer(Type.BYE);
      welcomed = false;
    }
  });
});

udp.bind(0, () => {
  http.listen(Number(args.port), "127.0.0.1", () => {
    console.log(`client half: server ${args.server}, viewer on http://127.0.0.1:${args.port}/?image=NAME`);
  });
});
