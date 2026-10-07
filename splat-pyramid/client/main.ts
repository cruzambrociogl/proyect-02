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
//           (a page from any other site is refused: it could otherwise drive this session).
//           "*.devtunnels.ms" accepts every subdomain: a tunnel whose address changes
// --proxy   also pass the server site's pages through this port, so a browser on another
//           device reaches everything through one forwarded port (testing through a tunnel).
//           The pages are still the server's; uploads are not passed through. Off: this
//           port only redirects to the server site
//
// Two WebSockets:
//   /ws       a viewer's session: every page gets its own (its own UDP socket, so the server
//             sees each page as a separate user), closed with the page
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
    proxy: { type: "boolean", default: false },
  },
});
const upstream = parseImpairment(args.impair);
// the catalog needs no session: one link answers every list page
const link = new ClientLink(args.server, upstream);

/**
 * One viewer page: its own session with the server over its own UDP socket, the data handed
 * to that page as it lands. Flow control: the receive window the server is told is the
 * receive buffer minus what the page has not handled yet, counting both what waits in the
 * WebSocket and what the page holds but has not decoded, so a busy browser slows the server.
 */
async function session(ws: WebSocket): Promise<void> {
  const own = new ClientLink(args.server, upstream);
  let forwarded = 0, consumed = 0, open = true;
  own.receiveWindow = () => (open ? Math.max(0, RECV_BUFFER - (forwarded - consumed)) : 0);
  const toBrowser = (data: string | Buffer): void => {
    if (ws.readyState !== ws.OPEN) return;
    if (typeof data !== "string") forwarded += data.length;
    ws.send(data);
  };
  own.events = {
    welcome: () => toBrowser(JSON.stringify({ type: "link", state: "connected", server: args.server })),
    chart: (chart) => toBrowser(JSON.stringify({ type: "chart", ...chart })),
    stats: (server) => toBrowser(JSON.stringify({ type: "stats", server, client: own.received })),
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
  // messages that arrive before the socket is bound wait for it
  const early: Buffer[] = [];
  ws.on("message", (data, isBinary) => { if (!isBinary) early.push(data as Buffer); });
  ws.on("close", () => {
    open = false;
    own.bye();
    setTimeout(() => own.close(), 200);            // let BYE leave first
    pages.delete(ws);
  });
  await own.bind();
  if (!open) return;
  own.hello();
  const handle = (data: Buffer): void => {
    const msg = JSON.parse(data.toString());
    if (msg.type === "open") own.open(String(msg.image));
    else if (msg.type === "consumed") consumed = Math.min(forwarded, Number(msg.bytes) || 0);
    else if (msg.type === "view") {
      own.view({ cx: msg.cx, cy: msg.cy, scale: msg.scale, screenW: msg.w, screenH: msg.h }, msg.dropped);
    }
  };
  ws.removeAllListeners("message");
  ws.on("message", (data, isBinary) => { if (!isBinary) handle(data as Buffer); });
  for (const data of early) handle(data);
}
const pages = new Set<WebSocket>();

// Which pages may connect: the server's site, this machine, and --origins. Browsers send the
// page's origin with a WebSocket handshake; anything else is refused.
const serverHost = args.server.split(":")[0];
let site = 8000;                                   // the server site's port, learned from CATALOG
const allowed = new Set(["127.0.0.1", "localhost", "[::1]", serverHost,
                         ...args.origins.split(",").map((s) => s.trim()).filter(Boolean)]);
function originAllowed(origin: string | undefined, reqHost: string | undefined): boolean {
  if (!origin) return true;                        // not a browser (a test client)
  let host: string, originHost: string;
  try { const u = new URL(origin); host = u.hostname; originHost = u.host; } catch { return false; }
  if (allowed.has(host)) return true;
  if (args.proxy && reqHost && originHost === reqHost) return true;   // a page this port served
  // "*.example.com" in --origins: any subdomain of it (never example.com's lookalikes)
  for (const a of allowed) if (a.startsWith("*.") && host.endsWith(a.slice(1))) return true;
  return false;
}

// HTTP here only points the browser at the server's site, where the pages are; with --proxy
// it passes them through instead, telling each page that its client half is at this address.
const http = createServer(async (req, res) => {
  if (!args.proxy) {
    res.writeHead(302, { Location: `http://${serverHost}:${site}/${args.port === "8090" ? "" : `?client=127.0.0.1:${args.port}`}` }).end();
    return;
  }
  if (req.method !== "GET") {
    res.writeHead(405, { "Content-Type": "text/plain" }).end(`only pages pass through here: add and prepare images at http://${serverHost}:${site}/admin`);
    return;
  }
  try {
    const r = await fetch(`http://${serverHost}:${site}${req.url ?? "/"}`, { redirect: "manual" });
    const type = r.headers.get("content-type") ?? "application/octet-stream";
    let body = Buffer.from(await r.arrayBuffer());
    if (type.startsWith("text/html")) {
      body = Buffer.from(body.toString("utf8").replace("<head>", "<head><script>window.CLIENT_HALF = location.host;</script>"));
    }
    res.writeHead(r.status, { "Content-Type": type, "Cache-Control": r.headers.get("cache-control") ?? "no-cache" }).end(body);
  } catch (e) {
    res.writeHead(502, { "Content-Type": "text/plain" }).end(`cannot reach the server site at http://${serverHost}:${site}: ${e}`);
  }
});

const sessions = new WebSocketServer({ noServer: true });
const catalogs = new WebSocketServer({ noServer: true });
http.on("upgrade", (req, socket, head) => {
  const path = new URL(req.url ?? "/", "http://x").pathname;
  if (!originAllowed(req.headers.origin, req.headers["x-forwarded-host"] as string ?? req.headers.host)) {
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
  pages.add(ws);
  console.log(`page connected (${pages.size} open)`);
  void session(ws);
});

await link.bind();
// learn the server site's port (CATALOG carries it), for the redirect; nothing depends on it
link.list().then((c) => { if (typeof c.site === "number") site = c.site; }, () => {});
http.listen(Number(args.port), "127.0.0.1", () => {
  console.log(`client half: server ${args.server}, path to server: ${describe(upstream)}`);
  console.log(`pages connect on ws://127.0.0.1:${args.port}; open the server's site: http://${serverHost}:${site}/`);
});
