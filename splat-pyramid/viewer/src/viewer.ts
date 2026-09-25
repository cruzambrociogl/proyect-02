import { SandpileCache } from "./sandpile.js";

// Splat pyramid viewer, v2: units arrive over a WebSocket from the client half instead of
// being fetched. Splat blobs are drawn the moment their packet lands (any subset of a unit's
// packets draws the whole unit, softer); image tiles arrive whole.
//
// Drawing is the prototype's (see prototype/viewer/viewer.js): the base level accumulated
// as a weighted average, detail levels added on top, each unit clipped to its rectangle and
// drawn only under a drawn parent; below the split, image tiles on top of the splats.

// must match the prototype's codec.py and blobs.py
const SIGMA_MIN = 0.4, SIGMA_MAX = 48.0, AMP_MIN = 1e-3, AMP_MAX = 16.0, POS_PAD = 16.0;
const CUTOFF = 3.0, MIN_REACH = 1.5, EPS = 1e-4;
const NORMALIZED = 0;
const KIND_SPLAT = 0, KIND_TILE = 1;
const RECORD = 11, CONFETTI_HEAD = 29;          // must match shared/units.ts

const LEVEL_BIAS = 0.25;                   // must match server/image.ts: which level a view draws
/**
 * Everything the viewer holds, blobs and tiles together: the sandpile cache (sandpile.ts)
 * keeps it under this. Blobs are held as their raw 11-byte records, decoded by the vertex
 * shader; tiles as 4 bytes a pixel, without mipmaps (the level rule never shrinks a tile much).
 */
const MEMORY_BUDGET = 32 * 2 ** 20;
const VIEW_EVERY_MS = 50;

interface Chart { name: string; width: number; height: number; tile: number; maxLevel: number; split: number }
interface SplatUnit {
  L: number; x: number; y: number; mode: number; w: number; h: number;
  n: number; count: number; packets: number; got: Set<number>;
  buf: WebGLBuffer | null; vao: WebGLVertexArrayObject | null; used: number;
}
interface Tile { L: number; x: number; y: number; tex: WebGLTexture; bytes: number; used: number }
type Uniforms = Record<string, WebGLUniformLocation | null>;

const canvas = document.getElementById("view") as HTMLCanvasElement;
const statsEl = document.getElementById("stats") as HTMLElement;

function fail(msg: string): never {
  const el = document.getElementById("error") as HTMLElement;
  el.textContent = msg;
  el.style.display = "flex";
  throw new Error(msg);
}

const gl = canvas.getContext("webgl2", { antialias: false, premultipliedAlpha: false }) ?? fail("This viewer needs WebGL 2.");
if (!gl.getExtension("EXT_color_buffer_float")) fail("This viewer needs EXT_color_buffer_float.");

// ---------------------------------------------------------------------------------------
// GL programs
// ---------------------------------------------------------------------------------------

const BLOB_VS = `#version 300 es
layout(location=0) in vec2 corner;
// one blob's raw 11-byte record, as it came off the wire (see splatpyr/codec.py):
layout(location=1) in uvec4 rec0;     // x hi, x lo, y hi, y lo
layout(location=2) in uvec4 rec1;     // sx, sy, theta, r
layout(location=3) in uvec3 rec2;     // g, b, amp
uniform vec2 u_origin;
uniform float u_scale;
uniform vec2 u_view;
uniform vec2 u_unit;                  // the unit's width and height, which positions are relative to
out vec2 v_d; out vec3 v_col; out vec2 v_sig; out float v_th; out float v_reach; out float v_gain;
float s8(uint v) { return (v > 127u ? float(v) - 256.0 : float(v)) / 127.0; }
void main() {
  vec2 pos = -${POS_PAD.toFixed(1)} + vec2(float(rec0.x * 256u + rec0.y), float(rec0.z * 256u + rec0.w))
             * (u_unit + 2.0 * ${POS_PAD.toFixed(1)}) / 65535.0;
  vec2 sig = ${SIGMA_MIN} * exp(vec2(rec1.xy) / 255.0 * ${Math.log(SIGMA_MAX / SIGMA_MIN).toFixed(6)});
  float th = float(rec1.z) * ${Math.PI.toFixed(6)} / 255.0;
  float amp = ${AMP_MIN} * exp(float(rec2.z) / 255.0 * ${Math.log(AMP_MAX / AMP_MIN).toFixed(6)});
  vec3 col = vec3(s8(rec1.w), s8(rec2.x), s8(rec2.y)) * amp;
  float reach = max(${CUTOFF.toFixed(1)} * max(sig.x, sig.y), ${MIN_REACH.toFixed(1)});
  vec2 s = max(sig, vec2(0.5 / u_scale));
  v_gain = (sig.x * sig.y) / (s.x * s.y);
  v_reach = max(reach, ${CUTOFF.toFixed(1)} * max(s.x, s.y));
  v_d = corner * v_reach;
  vec2 p = u_origin + (pos + v_d) * u_scale;
  gl_Position = vec4(p.x / u_view.x * 2.0 - 1.0, 1.0 - p.y / u_view.y * 2.0, 0.0, 1.0);
  v_col = col; v_sig = s; v_th = th;
}`;

const BLOB_FS = `#version 300 es
precision highp float;
in vec2 v_d; in vec3 v_col; in vec2 v_sig; in float v_th; in float v_reach; in float v_gain;
uniform int u_mode;
out vec4 o;
void main() {
  if (dot(v_d, v_d) > v_reach * v_reach) discard;
  float c = cos(v_th), s = sin(v_th);
  float u = (v_d.x * c + v_d.y * s) / v_sig.x;
  float v = (-v_d.x * s + v_d.y * c) / v_sig.y;
  float w = exp(-0.5 * (u * u + v * v)) * v_gain;
  o = u_mode == ${NORMALIZED} ? vec4(v_col * w, w) : vec4(v_col * w, 0.0);
}`;

const COMPOSE_VS = `#version 300 es
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const COMPOSE_FS = `#version 300 es
precision highp float;
uniform sampler2D u_base, u_detail;
uniform vec3 u_bg;
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 b = texelFetch(u_base, p, 0);
  if (b.a <= 0.0) { o = vec4(u_bg, 1.0); return; }
  vec3 c = b.rgb / max(b.a, ${EPS}) + texelFetch(u_detail, p, 0).rgb;
  o = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

const TILE_VS = `#version 300 es
uniform vec4 u_rect;
uniform vec2 u_view;
out vec2 v_uv;
void main() {
  vec2 c = vec2(gl_VertexID & 1, gl_VertexID >> 1);
  vec2 p = mix(u_rect.xy, u_rect.zw, c);
  v_uv = c;
  gl_Position = vec4(p.x / u_view.x * 2.0 - 1.0, 1.0 - p.y / u_view.y * 2.0, 0.0, 1.0);
}`;

const TILE_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
out vec4 o;
void main() { o = vec4(texture(u_tex, v_uv).rgb, 1.0); }`;

function program(vs: string, fs: string): { p: WebGLProgram; u: Uniforms } {
  const p = gl.createProgram()!;
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]] as const) {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) fail(gl.getShaderInfoLog(s) ?? "shader");
    gl.attachShader(p, s);
  }
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) fail(gl.getProgramInfoLog(p) ?? "link");
  const u: Uniforms = {};
  for (let i = 0; i < gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); i++) {
    const name = gl.getActiveUniform(p, i)!.name;
    u[name] = gl.getUniformLocation(p, name);
  }
  return { p, u };
}

const blobProg = program(BLOB_VS, BLOB_FS);
const composeProg = program(COMPOSE_VS, COMPOSE_FS);
const tileProg = program(TILE_VS, TILE_FS);
const composeVao = gl.createVertexArray();
const cornerBuf = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuf);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

/** A unit's GPU buffer, sized for all its blobs' raw records; packets fill it as they land. */
function unitBuffers(n: number): { vao: WebGLVertexArrayObject; buf: WebGLBuffer } {
  const vao = gl.createVertexArray()!;
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuf);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  const buf = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, n * RECORD, gl.DYNAMIC_DRAW);
  for (const [loc, size, off] of [[1, 4, 0], [2, 4, 4], [3, 3, 8]]) {
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribIPointer(loc, size, gl.UNSIGNED_BYTE, RECORD, off);
    gl.vertexAttribDivisor(loc, 1);
  }
  gl.bindVertexArray(null);
  return { vao, buf };
}

function target(w: number, h: number): { tex: WebGLTexture; fb: WebGLFramebuffer } {
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  const fb = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) fail("half-float framebuffer not supported");
  return { tex, fb };
}

let targets: { tex: WebGLTexture; fb: WebGLFramebuffer }[] = [];
let targetSize = [0, 0];
function ensureTargets(w: number, h: number): void {
  if (targets.length && targetSize[0] === w && targetSize[1] === h) return;
  for (const t of targets) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fb); }
  targets = [target(w, h), target(w, h)];
  targetSize = [w, h];
}

// ---------------------------------------------------------------------------------------
// units arriving
// ---------------------------------------------------------------------------------------

let M: Chart | null = null;
const units = new Map<string, SplatUnit>();
const tiles = new Map<string, Tile>();
const dropped: { kind: number; level: number; x: number; y: number }[] = [];
const net = { packets: 0, bytes: 0, tiles: 0 };
let serverStats: Record<string, any> = {};
let frameNo = 0, dirty = true, needFit = false;
let cache: SandpileCache | null = null;          // made when the chart arrives
const cacheKey = (kind: number, L: number, x: number, y: number) => `${kind}/${L}/${x}/${y}`;
const key = (L: number, x: number, y: number) => `${L}/${x}/${y}`;


function onConfetti(b: DataView, bytes: Uint8Array): void {
  const L = b.getUint8(0), x = b.getUint32(1), y = b.getUint32(5), mode = b.getUint8(9);
  const w = b.getUint16(10), h = b.getUint16(12), n = b.getUint32(14);
  const index = b.getUint16(18), packets = b.getUint16(20), k = b.getUint16(22);
  const id = key(L, x, y);
  let u = units.get(id);
  if (!u) {
    u = { L, x, y, mode, w, h, n, count: 0, packets, got: new Set(), buf: null, vao: null, used: frameNo };
    if (n) Object.assign(u, unitBuffers(n));
    units.set(id, u);
    cache?.add({ key: cacheKey(KIND_SPLAT, L, x, y), kind: KIND_SPLAT, level: L, x, y, bytes: n * RECORD }, performance.now());
  }
  if (u.got.has(index)) return;               // a duplicate
  u.got.add(index);
  if (k === 0 || !u.buf) { dirty = true; return; }
  // the records go to the GPU exactly as they arrived: the vertex shader decodes them
  gl.bindBuffer(gl.ARRAY_BUFFER, u.buf);
  gl.bufferSubData(gl.ARRAY_BUFFER, u.count * RECORD, bytes.subarray(CONFETTI_HEAD, CONFETTI_HEAD + k * RECORD));
  u.count += k;
  dirty = true;
}

async function onTile(b: DataView, data: Uint8Array): Promise<void> {
  const L = b.getUint8(0), x = b.getUint32(1), y = b.getUint32(5), format = b.getUint8(9);
  const blob = new Blob([data.slice(10)], { type: format === 1 ? "image/webp" : "image/jpeg" });
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none" });
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bmp);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const t: Tile = { L, x, y, tex, bytes: bmp.width * bmp.height * 4, used: frameNo };
  bmp.close();
  const old = tiles.get(key(L, x, y));
  if (old) gl.deleteTexture(old.tex);
  tiles.set(key(L, x, y), t);
  cache?.add({ key: cacheKey(KIND_TILE, L, x, y), kind: KIND_TILE, level: L, x, y, bytes: t.bytes }, performance.now());
  net.tiles++;
  dirty = true;
}

// ---------------------------------------------------------------------------------------
// connection
// ---------------------------------------------------------------------------------------

const imageName = new URLSearchParams(location.search).get("image") ?? "";
let linkState = "connecting";
const ws = new WebSocket(`ws://${location.host}/ws`);
ws.binaryType = "arraybuffer";
ws.onopen = () => {
  linkState = "waiting for server";
  if (!imageName) fail("add ?image=NAME to the address");
  ws.send(JSON.stringify({ type: "open", image: imageName }));
};
ws.onclose = () => { linkState = "closed"; dirty = true; };
ws.onmessage = (e) => {
  if (typeof e.data === "string") {
    const m = JSON.parse(e.data);
    if (m.type === "chart") {
      M = m as Chart;
      cache = new SandpileCache(MEMORY_BUDGET, M.maxLevel);
      needFit = true;
      lastSent = "";
      dirty = true;
    }
    else if (m.type === "stats") { serverStats = m; dirty = true; }
    else if (m.type === "fault") fail(m.message);
    else if (m.type === "link") { linkState = m.state; dirty = true; }
    return;
  }
  const all = new Uint8Array(e.data as ArrayBuffer);
  net.packets++;
  net.bytes += all.length;
  const body = all.subarray(1);
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  if (all[0] === 1) onConfetti(view, body);
  else if (all[0] === 2) void onTile(view, body);
};

let lastSent = "", lastSentAt = 0;
function sendView(): void {
  if (!M || ws.readyState !== ws.OPEN) return;
  const now = performance.now();
  const scale = 1 / cam.z;
  const v = { cx: cam.cx, cy: cam.cy, scale, w: canvas.width, h: canvas.height };
  const sig = JSON.stringify(v);
  if (sig === lastSent && dropped.length === 0) return;
  if (now - lastSentAt < VIEW_EVERY_MS) { dirty = true; return; }  // try again next frame
  lastSent = sig;
  lastSentAt = now;
  ws.send(JSON.stringify({ type: "view", ...v, dropped: dropped.splice(0, dropped.length) }));
}

// ---------------------------------------------------------------------------------------
// cache limits: evicted units are reported, or the server would never send them again
// ---------------------------------------------------------------------------------------

/**
 * One frame's worth of the cache: grains on what is on screen (by how much of the screen it
 * covers), topplings, and, over the budget, evictions chosen by the sandpile.
 */
function evict(coverage: Map<string, number>): void {
  if (!cache) return;
  for (const k of cache.frame(coverage, performance.now())) {
    const [kind, L, x, y] = k.split("/").map(Number);
    if (kind === KIND_SPLAT) {
      const u = units.get(key(L, x, y));
      if (u?.vao) gl.deleteVertexArray(u.vao);
      if (u?.buf) gl.deleteBuffer(u.buf);
      units.delete(key(L, x, y));
    } else {
      const t = tiles.get(key(L, x, y));
      if (t) gl.deleteTexture(t.tex);
      tiles.delete(key(L, x, y));
    }
    dropped.push({ kind, level: L, x, y });
  }
}

// ---------------------------------------------------------------------------------------
// camera and drawing
// ---------------------------------------------------------------------------------------

const cam = { cx: 0, cy: 0, z: 1 };        // centre in level-0 px; framebuffer px per level-0 px
const ui = { detail: true, tiles: true, exact: true };

function fit(): void {
  if (!M) return;
  cam.z = 0.95 * Math.min(canvas.width / M.width, canvas.height / M.height);
  cam.cx = M.width / 2;
  cam.cy = M.height / 2;
  const q = new URLSearchParams(location.hash.slice(1));
  if (q.has("z")) cam.z = Number(q.get("z")) * (window.devicePixelRatio || 1);
  if (q.has("x")) cam.cx = Number(q.get("x"));
  if (q.has("y")) cam.cy = Number(q.get("y"));
}

const toScreen = (X: number, Y: number): [number, number] =>
  [(X - cam.cx) * cam.z + canvas.width / 2, (Y - cam.cy) * cam.z + canvas.height / 2];

function unitSize(L: number, x: number, y: number): [number, number] {
  const c = M!, lw = Math.ceil(c.width / 2 ** L), lh = Math.ceil(c.height / 2 ** L);
  return [Math.min(c.tile, lw - x * c.tile), Math.min(c.tile, lh - y * c.tile)];
}

function gridOf(L: number): [number, number] {
  const c = M!;
  return [Math.ceil(Math.ceil(c.width / 2 ** L) / c.tile), Math.ceil(Math.ceil(c.height / 2 ** L) / c.tile)];
}

function frame(): void {
  requestAnimationFrame(frame);
  const dpr = window.devicePixelRatio || 1;
  const cw = Math.round(canvas.clientWidth * dpr), ch = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== cw || canvas.height !== ch) {
    canvas.width = cw;
    canvas.height = ch;
    dirty = true;
  }
  if (!M) { statsEl.textContent = linkState; return; }
  if (needFit) { fit(); needFit = false; }
  sendView();
  if (!dirty) return;
  dirty = false;
  frameNo++;

  const c = M, T = c.tile;
  const finest = Math.max(0, Math.min(c.maxLevel, Math.floor(Math.log2(1 / cam.z) + LEVEL_BIAS)));
  const base: { u: SplatUnit; x0: number; y0: number; x1: number; y1: number; s: number }[] = [];
  const detail: typeof base = [];
  const tileList: { t: Tile; rect: [number, number, number, number] }[] = [];

  const visit = (L: number, x: number, y: number) => {
    const s = 2 ** L;
    const [w, h] = unitSize(L, x, y);
    const [x0, y0] = toScreen(x * T * s, y * T * s);
    const [x1, y1] = toScreen((x * T + w) * s, (y * T + h) * s);
    if (x1 < 0 || y1 < 0 || x0 > cw || y0 > ch) return;
    const u = units.get(key(L, x, y));
    if (!u) return;                         // not here yet: the server is sending it
    u.used = frameNo;
    (u.mode === NORMALIZED ? base : detail).push({ u, x0, y0, x1, y1, s: cam.z * s });
    if (L > Math.max(finest, c.split) && (ui.detail || L === c.maxLevel)) {
      const [gc, gr] = gridOf(L - 1);
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        if (2 * x + dx < gc && 2 * y + dy < gr) visit(L - 1, 2 * x + dx, 2 * y + dy);
      }
    }
  };
  visit(c.maxLevel, 0, 0);

  if (finest < c.split && ui.tiles) {
    const X0 = cam.cx - cw / 2 / cam.z, Y0 = cam.cy - ch / 2 / cam.z;
    const X1 = cam.cx + cw / 2 / cam.z, Y1 = cam.cy + ch / 2 / cam.z;
    for (let L = c.split - 1; L >= finest; L--) {
      const span = T * 2 ** L, [gc, gr] = gridOf(L);
      for (let y = Math.max(0, Math.floor(Y0 / span)); y <= Math.min(gr - 1, Math.floor(Y1 / span)); y++) {
        for (let x = Math.max(0, Math.floor(X0 / span)); x <= Math.min(gc - 1, Math.floor(X1 / span)); x++) {
          const t = tiles.get(key(L, x, y));
          if (!t) continue;
          t.used = frameNo;
          const [w, h] = unitSize(L, x, y);
          const [x0, y0] = toScreen(x * span, y * span);
          const [x1, y1] = toScreen(x * span + w * 2 ** L, y * span + h * 2 ** L);
          tileList.push({ t, rect: [x0, y0, x1, y1] });
        }
      }
    }
  }

  ensureTargets(cw, ch);
  gl.viewport(0, 0, cw, ch);
  gl.useProgram(blobProg.p);
  gl.uniform2f(blobProg.u.u_view, cw, ch);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE);
  let drawnBlobs = 0;
  const pass = (list: typeof base, t: { fb: WebGLFramebuffer }, mode: number) => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.SCISSOR_TEST);
    gl.uniform1i(blobProg.u.u_mode, mode);
    for (const { u, x0, y0, x1, y1, s } of list) {
      if (!u.count || !u.vao) continue;
      const sx0 = Math.round(x0), sx1 = Math.round(x1), sy0 = Math.round(y0), sy1 = Math.round(y1);
      if (sx1 <= sx0 || sy1 <= sy0) continue;
      gl.scissor(sx0, ch - sy1, sx1 - sx0, sy1 - sy0);
      gl.uniform2f(blobProg.u.u_origin, x0, y0);
      gl.uniform1f(blobProg.u.u_scale, s);
      gl.uniform2f(blobProg.u.u_unit, u.w, u.h);
      gl.bindVertexArray(u.vao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, u.count);
      drawnBlobs += u.count;
    }
  };
  pass(base, targets[0], NORMALIZED);
  pass(ui.detail ? detail : [], targets[1], 1);
  gl.disable(gl.SCISSOR_TEST);
  gl.disable(gl.BLEND);

  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.useProgram(composeProg.p);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, targets[0].tex);
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, targets[1].tex);
  gl.uniform1i(composeProg.u.u_base, 0);
  gl.uniform1i(composeProg.u.u_detail, 1);
  gl.uniform3f(composeProg.u.u_bg, 0.067, 0.075, 0.09);
  gl.bindVertexArray(composeVao);
  gl.drawArrays(gl.TRIANGLES, 0, 3);

  if (tileList.length) {
    gl.useProgram(tileProg.p);
    gl.uniform2f(tileProg.u.u_view, cw, ch);
    gl.uniform1i(tileProg.u.u_tex, 0);
    gl.activeTexture(gl.TEXTURE0);
    const mag = ui.exact ? gl.NEAREST : gl.LINEAR;
    for (const { t, rect } of tileList) {
      gl.bindTexture(gl.TEXTURE_2D, t.tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, mag);
      gl.uniform4f(tileProg.u.u_rect, ...rect);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
  }

  // how much of the screen each drawn unit covers: the grains of the cache's sandpile
  const coverage = new Map<string, number>();
  const cover = (k: string, x0: number, y0: number, x1: number, y1: number) => {
    const w = Math.max(0, Math.min(cw, x1) - Math.max(0, x0)), h = Math.max(0, Math.min(ch, y1) - Math.max(0, y0));
    coverage.set(k, (w * h) / (cw * ch));
  };
  for (const d of base.concat(detail)) cover(cacheKey(KIND_SPLAT, d.u.L, d.u.x, d.u.y), d.x0, d.y0, d.x1, d.y1);
  for (const { t, rect } of tileList) cover(cacheKey(KIND_TILE, t.L, t.x, t.y), ...rect);
  evict(coverage);
  const blobBytes = [...units.values()].reduce((a, u) => a + u.n * RECORD, 0);
  const tileBytes = [...tiles.values()].reduce((a, t) => a + t.bytes, 0);
  const partial = [...units.values()].filter((u) => u.got.size < u.packets).length;
  const deepest = Math.min(...base.concat(detail).map((d) => d.u.L), ...tileList.map((d) => d.t.L), c.maxLevel);
  const srv = serverStats.server ?? {};
  statsEl.textContent =
    `image      ${c.name} ${c.width} x ${c.height}\n` +
    `link       ${linkState}\n` +
    `level      ${deepest} drawn / ${finest} wanted (top ${c.maxLevel})\n` +
    `layers     splats ${c.maxLevel}..${c.split}` + (c.split > 0 ? `, tiles ${c.split - 1}..0` : "") + `\n` +
    `units      ${base.length + detail.length} drawn, ${units.size} held, ${partial} partial\n` +
    `blobs      ${(drawnBlobs / 1e3).toFixed(0)}k drawn, ${(blobBytes / RECORD / 1e3).toFixed(0)}k held\n` +
    `tiles      ${tileList.length} drawn, ${tiles.size} held\n` +
    `memory     ${((blobBytes + tileBytes) / 2 ** 20).toFixed(1)} of ${MEMORY_BUDGET / 2 ** 20} MB (blobs ${(blobBytes / 2 ** 20).toFixed(1)}, tiles ${(tileBytes / 2 ** 20).toFixed(1)}), ${cache?.evictions ?? 0} evicted\n` +
    `received   ${net.packets} messages, ${(net.bytes / 2 ** 20).toFixed(2)} MB\n` +
    `server     epoch ${srv.epoch ?? "-"}, ${srv.queued ?? "-"} queued, ${srv.sessions ?? "-"} session(s)`;
}

// ---------------------------------------------------------------------------------------
// input
// ---------------------------------------------------------------------------------------

function zoomAt(px: number, py: number, factor: number): void {
  if (!M) return;
  const dpr = window.devicePixelRatio || 1;
  const sx = px * dpr, sy = py * dpr;
  const X = (sx - canvas.width / 2) / cam.z + cam.cx, Y = (sy - canvas.height / 2) / cam.z + cam.cy;
  const minZ = 0.25 * Math.min(canvas.width / M.width, canvas.height / M.height);
  cam.z = Math.min(16, Math.max(minZ, cam.z * factor));
  cam.cx = X - (sx - canvas.width / 2) / cam.z;
  cam.cy = Y - (sy - canvas.height / 2) / cam.z;
  dirty = true;
}

canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  zoomAt(e.offsetX, e.offsetY, Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.0015)));
}, { passive: false });

const pointers = new Map<number, [number, number]>();
let pinch = 0;
canvas.addEventListener("pointerdown", (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, [e.offsetX, e.offsetY]);
  canvas.classList.add("dragging");
});
canvas.addEventListener("pointermove", (e) => {
  const prev = pointers.get(e.pointerId);
  if (!prev) return;
  pointers.set(e.pointerId, [e.offsetX, e.offsetY]);
  const dpr = window.devicePixelRatio || 1;
  if (pointers.size === 1) {
    cam.cx -= ((e.offsetX - prev[0]) * dpr) / cam.z;
    cam.cy -= ((e.offsetY - prev[1]) * dpr) / cam.z;
    dirty = true;
  } else if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
    if (pinch) zoomAt((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, d / pinch);
    pinch = d;
  }
});
const release = (e: PointerEvent) => {
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinch = 0;
  if (!pointers.size) canvas.classList.remove("dragging");
};
canvas.addEventListener("pointerup", release);
canvas.addEventListener("pointercancel", release);
canvas.addEventListener("dblclick", (e) => zoomAt(e.offsetX, e.offsetY, 2));
window.addEventListener("keydown", (e) => {
  if (e.key === "+" || e.key === "=") zoomAt(canvas.clientWidth / 2, canvas.clientHeight / 2, 1.5);
  if (e.key === "-") zoomAt(canvas.clientWidth / 2, canvas.clientHeight / 2, 1 / 1.5);
  if (e.key === "0") { fit(); dirty = true; }
});

for (const id of ["detail", "tiles", "exact"] as const) {
  const el = document.getElementById(id) as HTMLInputElement;
  el.addEventListener("input", () => { ui[id] = el.checked; dirty = true; });
}

requestAnimationFrame(frame);
