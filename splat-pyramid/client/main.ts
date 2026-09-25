// The client half: runs on the viewer's machine, because a browser cannot open a UDP
// socket. It speaks our protocol to the server (client/link.ts) and hands the browser what
// arrives, over a WebSocket on loopback. It also serves the viewer page.
//
//   node client/main.ts [--server 127.0.0.1:9000] [--port 8090] [--impair SPEC]
//   then open http://127.0.0.1:8090/?image=NAME
//
// --impair emulates the path toward the server (views, reports); see shared/emulator.ts.
//
// Browser -> client half (JSON text):
//   {type: "open", image}                         open an image
//   {type: "view", cx, cy, scale, w, h, dropped}  where the viewer is looking
// Client half -> browser:
//   text   {type: "chart" | "stats" | "fault" | "link", ...}
//   binary [1] + CONFETTI payload                 some blobs of a splat unit, as they land
//   binary [2] + level u8, x u32, y u32, format u8, bytes   a whole image tile

import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { WebSocketServer, type WebSocket } from "ws";
import { describe, parseImpairment } from "../shared/emulator.ts";
import { ClientLink } from "./link.ts";

const { values: args } = parseArgs({
  options: {
    server: { type: "string", default: "127.0.0.1:9000" },
    port: { type: "string", default: "8090" },
    impair: { type: "string", default: "none" },
  },
});
const VIEWER = join(import.meta.dirname, "..", "viewer");
const upstream = parseImpairment(args.impair);
const link = new ClientLink(args.server, upstream);
let browser: WebSocket | null = null;

function toBrowser(data: string | Buffer): void {
  if (browser && browser.readyState === browser.OPEN) browser.send(data);
}

link.events = {
  welcome: () => toBrowser(JSON.stringify({ type: "link", state: "connected", server: args.server })),
  chart: (chart) => toBrowser(JSON.stringify({ type: "chart", ...chart })),
  stats: (server) => toBrowser(JSON.stringify({ type: "stats", server, client: link.received })),
  fault: (message) => toBrowser(JSON.stringify({ type: "fault", message })),
  // blobs are useful on their own: straight through, no waiting for the rest of the unit
  confetti: (payload) => toBrowser(Buffer.concat([Buffer.from([1]), payload])),
  tile: (level, x, y, format, data) => {
    const head = Buffer.alloc(11);
    head[0] = 2;
    head[1] = level;
    head.writeUInt32BE(x, 2);
    head.writeUInt32BE(y, 6);
    head[10] = format;
    toBrowser(Buffer.concat([head, data]));
  },
};

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
  link.hello();          // a fresh page holds nothing: the server must forget what it sent
  ws.on("message", (data, isBinary) => {
    if (isBinary) return;
    const msg = JSON.parse(data.toString());
    if (msg.type === "open") link.open(String(msg.image));
    else if (msg.type === "view") {
      link.view({ cx: msg.cx, cy: msg.cy, scale: msg.scale, screenW: msg.w, screenH: msg.h }, msg.dropped);
    }
  });
  ws.on("close", () => {
    if (browser === ws) {
      browser = null;
      link.bye();
    }
  });
});

await link.bind();
http.listen(Number(args.port), "127.0.0.1", () => {
  console.log(`client half: server ${args.server}, path to server: ${describe(upstream)}`);
  console.log(`viewer on http://127.0.0.1:${args.port}/?image=NAME`);
});
