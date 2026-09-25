// v1 against v2 in the same browser, with the same input, over the same emulated link.
//
// Both viewers run in a fresh headless Chrome driven over the DevTools protocol with identical
// synthetic input: open the image, wheel-zoom to about 1:1 on a point, zig-zag with drags,
// wheel back out. Both zoom by exp(deltaY x 0.0015) per wheel event and pan 1:1 with a drag;
// v2's window is the size of v1's canvas (v1 keeps a panel and a header around it), input goes
// to the same point of the canvas, and v2 opens on v1's starting view, so both show the same
// part of the image at every moment.
//
// What the user sees is measured by screenshots of the canvas at fixed times after each phase
// (0.5, 2 and 5 s) together with the camera the viewer reports; bench/versus_quality.py later
// compares each with the original image cropped to that camera. Also measured, from the page:
//
//   received      bytes the page received from its client half over the WebSocket
//   sent          messages the page sent (views and the like: its requests)
//   peak held     decoded image the viewer holds by its own account (v1 p2.held(),
//                 v2 splat.held()), sampled every 200 ms
//   JS heap       the page's JavaScript heap at the end
//
// The link is emulated on the server's side only, as v1 does it.
//
//   node bench/versus.ts [--profiles lan,home,mobile] [--repeat 3] [--out bench/out/versus]

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    profiles: { type: "string", default: "lan,home,mobile" },
    repeat: { type: "string", default: "3" },
    image: { type: "string", default: "holbein_8000.jpg" },
    out: { type: "string", default: join(import.meta.dirname, "out", "versus") },
  },
});

// only what both emulators understand (v1 has no bursts and no queue limit)
const PROFILES: Record<string, string> = {
  lan: "rate=100mbit,delay=1ms",
  home: "rate=20mbit,delay=30ms,jitter=3ms,loss=0.5%",
  mobile: "rate=2mbit,delay=120ms,jitter=20ms,loss=1%",
};
const ROOT = join(import.meta.dirname, "..");
const APP = join(ROOT, "..", "app");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
// v1's canvas inside a 1600 x 900 window: right of a 340 px panel, under a 66 px header
const CW = 1260, CH = 834;
const LAYOUT = {
  v1: { window: [1600, 900], canvas: [340, 66] },
  v2: { window: [CW, CH], canvas: [0, 0] },
} as const;
const IMAGE_W = 7011, IMAGE_H = 8000;
const SHOTS_S = [0.5, 2, 5];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function start(cmd: string, argv: string[], cwd: string, ready: string): Promise<ChildProcess> {
  const child = spawn(cmd, argv, { cwd, stdio: ["ignore", "pipe", "pipe"] });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${cmd} did not start`)), 20_000);
    const look = (d: Buffer) => { if (d.toString().includes(ready)) { clearTimeout(timer); resolve(child); } };
    child.stdout!.on("data", look);
    child.stderr!.on("data", look);
  });
}

/** Wait until a page answers: a server's startup lines can come before it is listening. */
async function answering(url: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(url)).ok) return; } catch { /* not yet */ }
    await sleep(100);
  }
  throw new Error(`${url} never answered`);
}

async function servers(version: "v1" | "v2", spec: string): Promise<{ procs: ChildProcess[]; url: string }> {
  if (version === "v1") {
    const p = await start("java", ["-cp", "server/build", "p2.Main", "--web", "web", "--images", "images",
      "--port", "8080", "--udp-port", "8081", "--impair", spec], APP, "protocol  udp");
    const url = `http://127.0.0.1:8080/viewer?image=${encodeURIComponent(args.image)}&budget=50`;
    await answering(url);
    return { procs: [p], url };
  }
  const s = await start(process.execPath, ["server/main.ts", "--images", "data", "--impair", spec], ROOT, "server on udp");
  const c = await start(process.execPath, ["client/main.ts"], ROOT, "viewer on");
  await answering("http://127.0.0.1:8090/");
  const fit = Math.max(IMAGE_W / CW, IMAGE_H / CH);          // v1's starting view
  return { procs: [s, c], url: `http://127.0.0.1:8090/?image=${encodeURIComponent(args.image)}#x=${IMAGE_W / 2}&y=${IMAGE_H / 2}&z=${1 / fit}` };
}

class Cdp {
  private ws: WebSocket;
  private id = 0;
  private pending = new Map<number, (r: any) => void>();
  onEvent: (method: string, params: any) => void = () => {};
  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)!(m.result); this.pending.delete(m.id); }
      else if (m.method) this.onEvent(m.method, m.params);
    };
  }
  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    return new Promise((r) => { this.pending.set(++this.id, r); this.ws.send(JSON.stringify({ id: this.id, method, params })); });
  }
}

async function browser(): Promise<{ proc: ChildProcess; cdp: Cdp; profile: string }> {
  const profile = mkdtempSync(join(tmpdir(), "versus-"));
  const proc = spawn(CHROME, ["--headless=new", "--use-angle=metal", "--remote-debugging-port=9350",
    `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
  for (let i = 0; i < 50; i++) {
    try { await fetch("http://127.0.0.1:9350/json/version"); break; } catch { await sleep(200); }
  }
  const tabs = await (await fetch("http://127.0.0.1:9350/json/list")).json();
  const ws = new WebSocket(tabs.find((t: any) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  return { proc, cdp: new Cdp(ws), profile };
}

async function session(version: "v1" | "v2", profile: string, run: number) {
  const L = LAYOUT[version];
  const dir = join(args.out, `${profile}-${version}-${run}`);
  mkdirSync(dir, { recursive: true });
  const { procs, url } = await servers(version, PROFILES[profile]);
  const { proc, cdp, profile: chromeDir } = await browser();
  let bytes = 0, sent = 0, peakHeld = 0;
  cdp.onEvent = (method, p) => {
    if (method === "Network.webSocketFrameSent") sent++;
    if (method !== "Network.webSocketFrameReceived") return;
    const r = p.response;
    bytes += r.opcode === 2 ? Math.floor((r.payloadData.length * 3) / 4) : r.payloadData.length;
  };
  await cdp.send("Network.enable");
  await cdp.send("Performance.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: L.window[0], height: L.window[1], deviceScaleFactor: 1, mobile: false });
  const probe = async (what: "held" | "camera") => {
    const expr = what === "held"
      ? "JSON.stringify((globalThis.p2 ?? globalThis.splat)?.held?.() ?? null)"
      : "JSON.stringify(globalThis.p2 ? globalThis.p2.scene.camera : globalThis.splat?.camera?.() ?? null)";
    const r = await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true });
    return JSON.parse(r.result.value ?? "null");
  };
  const sampler = setInterval(async () => {
    const h = await probe("held");
    if (h) peakHeld = Math.max(peakHeld, h.bytes);
  }, 200);
  const shots: { phase: string; after: number; file: string; camera: unknown }[] = [];
  const shoot = async (phase: string, inputEnded: number) => {
    for (const after of SHOTS_S) {
      await sleep(Math.max(0, inputEnded + after * 1000 - performance.now()));
      const camera = await probe("camera");
      const img = await cdp.send("Page.captureScreenshot", { format: "png",
        clip: { x: L.canvas[0], y: L.canvas[1], width: CW, height: CH, scale: 1 } });
      const file = `${phase}-${after}s.png`;
      writeFileSync(join(dir, file), Buffer.from(img.data, "base64"));
      shots.push({ phase, after, file, camera });
    }
  };
  // input, at a point given relative to the canvas
  const at = (x: number, y: number) => ({ x: L.canvas[0] + x, y: L.canvas[1] + y });
  const wheel = async (x: number, y: number, deltaY: number, n: number) => {
    for (let i = 0; i < n; i++) {
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", ...at(x, y), deltaX: 0, deltaY });
      await sleep(50);
    }
  };
  const drag = async (dx: number, dy: number) => {
    const o = at(CW / 2, CH / 2);
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...o, button: "left", clickCount: 1 });
    for (let i = 1; i <= 5; i++) {
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: o.x + (dx * i) / 5, y: o.y + (dy * i) / 5, button: "left", buttons: 1 });
    }
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: o.x + dx, y: o.y + dy, button: "left", clickCount: 1 });
  };

  const opened = performance.now();
  await cdp.send("Page.navigate", { url });
  await shoot("open", opened);
  // zoom to about 1:1 on a point left of centre (the fit is 9.6 image px per canvas px)
  await wheel(CW * 0.4, CH * 0.45, -100, 15);
  await shoot("zoom-in", performance.now());
  // zig-zag inside the image
  for (const [dx, dy] of [[-400, 0], [-400, 0], [-400, 0], [0, -350], [400, 0], [400, 0], [400, 0], [0, -350]]) {
    await drag(dx, dy);
    await sleep(300);
  }
  await shoot("pan", performance.now());
  await wheel(CW / 2, CH / 2, 100, 15);
  await shoot("zoom-out", performance.now());

  clearInterval(sampler);
  const metrics = await cdp.send("Performance.getMetrics");
  const heap = metrics.metrics.find((m: any) => m.name === "JSHeapUsedSize")?.value ?? NaN;
  proc.kill();
  for (const p of procs) p.kill();
  await sleep(500);
  rmSync(chromeDir, { recursive: true, force: true });
  const result = { version, profile, run, bytes, sent, peakHeld, heap, shots };
  writeFileSync(join(dir, "result.json"), JSON.stringify(result, null, 2));
  return result;
}

rmSync(args.out, { recursive: true, force: true });
for (const profile of args.profiles.split(",")) {
  for (const version of ["v1", "v2"] as const) {
    for (let i = 0; i < Number(args.repeat); i++) {
      const r = await session(version, profile, i);
      console.log(`${profile} ${version} run ${i}: received ${(r.bytes / 2 ** 20).toFixed(2)} MB, ` +
                  `sent ${r.sent}, peak held ${(r.peakHeld / 2 ** 20).toFixed(1)} MB`);
    }
  }
}
console.log(`screenshots and results in ${args.out}; score them with bench/versus_quality.py`);
