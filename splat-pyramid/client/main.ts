// The client half: runs on the viewer's machine, because a browser cannot open a UDP
// socket. It speaks our protocol to the server (client/link.ts) and hands the browser what
// arrives, over a WebSocket on loopback. It serves no pages: the browser loads them from the
// server's site over HTTP, and they connect here.
//
//   node client/main.ts [--server 127.0.0.1:9000] [--port 8090] [--impair SPEC] [--origins A,B]
//   then open the server's site, http://SERVER:8000/ (this port redirects there)
//
// --impair  emulates the path toward the server (views, reports); see shared/emulator.ts.
// --origins hosts whose pages may connect, besides the server's host and this machine
//           (a page from any other site is refused: it could otherwise drive this session)
//
// Two WebSockets:
//   /ws       the viewer's session: one at a time (a new page takes over)
//   /catalog  the image list asks for the catalog (LIST/CATALOG over our protocol); answers
//             {type: "catalog", images, site} or {type: "fault", message}, then closes
//
// Browser -> client half (JSON text):
//   {type: "open", image}                         open an image
//   {type: "view", cx, cy, scale, w, h, dropped}  where the viewer is looking
//   {type: "consumed", bytes}                     binary bytes fully handled so far (drawn,
//                                                 or decoded for a tile): flow control
// Client half -> browser:
//   text   {type: "chart" | "stats" | "fault" | "link", ...}
//   binary [1] + CONFETTI payload                 some blobs of a splat unit, as they land
//   binary [2] + level u8, x u32, y u32, format u8, bytes   a whole image tile

import { createServer } from "node:http";
import { parseArgs } from "node:util";
import { WebSocketServer, type WebSocket } from "ws";
import { describe, parseImpairment } from "../shared/emulator.ts";
import { ClientLink, RECV_BUFFER } from "./link.ts";

const { values: args } = parseArgs({
  options: {
    server: { type: "string", default: "127.0.0.1:9000" },
    port: { type: "string", default: "8090" },
    impair: { type: "string", default: "none" },
    origins: { type: "string", default: "" },
  },
});
const upstream = parseImpairment(args.impair);
const link = new ClientLink(args.server, upstream);
let browser: WebSocket | null = null;

// Flow control: the receive window the server is told is the receive buffer minus what the
// page has not handled yet. That counts both what waits in the WebSocket and what the page
// holds but has not decoded, so a busy browser slows the server down.
let forwarded = 0, consumed = 0;
link.receiveWindow = () => (browser ? Math.max(0, RECV_BUFFER - (forwarded - consumed)) : 0);

function toBrowser(data: string | Buffer): void {
  if (!browser || browser.readyState !== browser.OPEN) return;
  if (typeof data !== "string") forwarded += data.length;
  browser.send(data);
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

// Which pages may connect: the server's site, this machine, and --origins. Browsers send the
// page's origin with a WebSocket handshake; anything else is refused.
const serverHost = args.server.split(":")[0];
let site = 8000;                                   // the server site's port, learned from CATALOG
const allowed = new Set(["127.0.0.1", "localhost", "[::1]", serverHost,
                         ...args.origins.split(",").map((s) => s.trim()).filter(Boolean)]);
function originAllowed(origin: string | undefined): boolean {
  if (!origin) return true;                        // not a browser (a test client)
  try { return allowed.has(new URL(origin).hostname); } catch { return false; }
}

// HTTP here only points the browser at the server's site, where the pages are.
const http = createServer((req, res) => {
  res.writeHead(302, { Location: `http://${serverHost}:${site}/${args.port === "8090" ? "" : `?client=127.0.0.1:${args.port}`}` }).end();
});

const sessions = new WebSocketServer({ noServer: true });
const catalogs = new WebSocketServer({ noServer: true });
http.on("upgrade", (req, socket, head) => {
  const path = new URL(req.url ?? "/", "http://x").pathname;
  if (!originAllowed(req.headers.origin)) {
    console.log(`refused a page from ${req.headers.origin} (allow it with --origins)`);
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    return;
  }
  const wss = path === "/ws" ? sessions : path === "/catalog" ? catalogs : null;
  if (!wss) { socket.end("HTTP/1.1 404 Not Found\r\n\r\n"); return; }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

catalogs.on("connection", async (ws) => {
  try {
    const c = await link.list();
    if (typeof c.site === "number") site = c.site;
    ws.send(JSON.stringify({ type: "catalog", ...c }));
  } catch (e) {
    ws.send(JSON.stringify({ type: "fault", message: String(e instanceof Error ? e.message : e) }));
  }
  ws.close();
});

sessions.on("connection", (ws) => {
  if (browser) browser.close(1000, "another viewer took over this client half");
  browser = ws;
  forwarded = consumed = 0;
  link.hello();          // a fresh page holds nothing: the server must forget what it sent
  ws.on("message", (data, isBinary) => {
    if (isBinary) return;
    const msg = JSON.parse(data.toString());
    if (msg.type === "open") link.open(String(msg.image));
    else if (msg.type === "consumed" && browser === ws) consumed = Math.min(forwarded, Number(msg.bytes) || 0);
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
// learn the server site's port (CATALOG carries it), for the redirect; nothing depends on it
link.list().then((c) => { if (typeof c.site === "number") site = c.site; }, () => {});
http.listen(Number(args.port), "127.0.0.1", () => {
  console.log(`client half: server ${args.server}, path to server: ${describe(upstream)}`);
  console.log(`pages connect on ws://127.0.0.1:${args.port}; open the server's site: http://${serverHost}:${site}/`);
});
