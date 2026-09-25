// Splat pyramid viewer.
//
// Draws what the fitter aimed at (splatpyr/blobs.py): the base level as a weighted average of
// its blobs, plus every detail level down to the one the zoom needs, added on top. Each
// unit's blobs are clipped to the unit's own rectangle (scissor), and a unit is drawn only if
// the unit above it was, so every pixel sees one complete chain of levels.
//
// Levels below the manifest's `split` are plain JPEG tiles, not splats: near 1:1 the viewer
// draws them on top of the splats, finest loaded tile wins, and the splats underneath fill
// any tile not loaded yet - so the view never goes blank while tiles arrive.
//
// Memory: a splat unit costs 32 bytes per blob on the GPU (cache held to BLOB_BUDGET blobs);
// a JPEG tile costs its decoded texture (cache held to TILE_BUDGET bytes).
"use strict";

// must match splatpyr/codec.py and splatpyr/blobs.py
const SIGMA_MIN = 0.4, SIGMA_MAX = 48.0, AMP_MIN = 1e-3, AMP_MAX = 16.0, POS_PAD = 16.0;
const CUTOFF = 3.0, MIN_REACH = 1.5, EPS = 1e-4;
const NORMALIZED = 0;

const BLOB_BUDGET = 3_000_000;
const TILE_BUDGET = 96 * 2 ** 20;         // bytes of decoded tile textures, mipmaps included
const MAX_INFLIGHT = 6;
const FLOATS = 8;                        // x, y, sx, sy, theta, r, g, b

const canvas = document.getElementById("view");
const statsEl = document.getElementById("stats");
const gl = canvas.getContext("webgl2", { antialias: false, premultipliedAlpha: false });

function fail(msg) {
  const el = document.getElementById("error");
  el.textContent = msg;
  el.style.display = "flex";
  throw new Error(msg);
}
if (!gl) fail("This viewer needs WebGL 2.");
if (!gl.getExtension("EXT_color_buffer_float")) fail("This viewer needs EXT_color_buffer_float (half-float render targets).");

// ---------------------------------------------------------------------------------------
// .spx decoding
// ---------------------------------------------------------------------------------------

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function decodeSpx(buf) {
  const view = new DataView(buf);
  const magic = String.fromCharCode(...new Uint8Array(buf, 0, 4));
  if (magic !== "SPX1") throw new Error("not a .spx file");
  const mode = view.getUint8(4), nchunks = view.getUint8(5);
  const w = view.getUint16(6), h = view.getUint16(8), n = view.getUint32(10);
  const out = new Float32Array(n * FLOATS);
  const chunkEnds = [];
  const lsig = Math.log(SIGMA_MAX / SIGMA_MIN), lamp = Math.log(AMP_MAX / AMP_MIN);
  let at = 14 + 8 * nchunks, row = 0;
  for (let c = 0; c < nchunks; c++) {
    const count = view.getUint32(14 + 8 * c), size = view.getUint32(18 + 8 * c);
    const p = await inflate(new Uint8Array(buf, at, size));
    at += size;
    const plane = k => p.subarray(k * count, (k + 1) * count);
    const [xh, xl, yh, yl, qsx, qsy, qth, qr, qg, qb, qa] = Array.from({ length: 11 }, (_, k) => plane(k));
    for (let i = 0; i < count; i++, row++) {
      const o = row * FLOATS;
      const amp = AMP_MIN * Math.exp(qa[i] / 255 * lamp);
      const s8 = v => (v > 127 ? v - 256 : v) / 127 * amp;
      out[o] = -POS_PAD + ((xh[i] << 8) | xl[i]) * (w + 2 * POS_PAD) / 65535;
      out[o + 1] = -POS_PAD + ((yh[i] << 8) | yl[i]) * (h + 2 * POS_PAD) / 65535;
      out[o + 2] = SIGMA_MIN * Math.exp(qsx[i] / 255 * lsig);
      out[o + 3] = SIGMA_MIN * Math.exp(qsy[i] / 255 * lsig);
      out[o + 4] = qth[i] * Math.PI / 255;
      out[o + 5] = s8(qr[i]);
      out[o + 6] = s8(qg[i]);
      out[o + 7] = s8(qb[i]);
    }
    chunkEnds.push(row);
  }
  return { mode, w, h, n, chunkEnds, data: out };
}

// ---------------------------------------------------------------------------------------
// GL programs
// ---------------------------------------------------------------------------------------

const BLOB_VS = `#version 300 es
layout(location=0) in vec2 corner;
layout(location=1) in vec2 pos;
layout(location=2) in vec2 sig;
layout(location=3) in float th;
layout(location=4) in vec3 col;
uniform vec2 u_origin;    // unit origin, framebuffer px, y down
uniform float u_scale;    // framebuffer px per px of the blob's level
uniform vec2 u_view;
out vec2 v_d; out vec3 v_col; out vec2 v_sig; out float v_th; out float v_reach; out float v_gain;
void main() {
  // the fitter's reach rule, on the blob's own sigma
  float reach = max(${CUTOFF.toFixed(1)} * max(sig.x, sig.y), ${MIN_REACH.toFixed(1)});
  // a blob thinner than half a screen pixel is widened to it, with its total weight kept,
  // so zoomed-out detail averages instead of sparkling
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
uniform vec4 u_rect;      // x0, y0, x1, y1 in framebuffer px, y down
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

function program(vs, fs) {
  const p = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) fail(gl.getShaderInfoLog(s));
    gl.attachShader(p, s);
  }
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) fail(gl.getProgramInfoLog(p));
  const u = {};
  for (let i = 0; i < gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); i++) {
    const name = gl.getActiveUniform(p, i).name;
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

function unitVao(data) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuf);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  const stride = FLOATS * 4;
  const attrs = [[1, 2, 0], [2, 2, 8], [3, 1, 16], [4, 3, 20]];
  for (const [loc, size, off] of attrs) {
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, off);
    gl.vertexAttribDivisor(loc, 1);
  }
  gl.bindVertexArray(null);
  return { vao, buf };
}

function target(w, h) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) fail("half-float framebuffer not supported");
  return { tex, fb };
}

let targets = null, targetSize = [0, 0];

function ensureTargets(w, h) {
  if (targets && targetSize[0] === w && targetSize[1] === h) return;
  if (targets) for (const t of targets) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fb); }
  targets = [target(w, h), target(w, h)];
  targetSize = [w, h];
}

// ---------------------------------------------------------------------------------------
// units: loading, cache
// ---------------------------------------------------------------------------------------

let M = null;                           // manifest
const units = new Map();                // "L/x/y" -> splat unit
const tiles = new Map();                // "L/x/y" -> JPEG tile
const net = { requests: 0, bytes: 0, fitted: 0, fitSeconds: 0, failed: 0 };
let inflight = 0, frameNo = 0, cachedBlobs = 0, tileBytes = 0, dirty = true;
let wanted = [];

const key = (L, x, y) => `${L}/${x}/${y}`;

function unitSize(L, x, y) {
  const lw = Math.ceil(M.width / 2 ** L), lh = Math.ceil(M.height / 2 ** L);
  return [Math.min(M.tile, lw - x * M.tile), Math.min(M.tile, lh - y * M.tile)];
}

function gridOf(L) {
  return [Math.ceil(Math.ceil(M.width / 2 ** L) / M.tile), Math.ceil(Math.ceil(M.height / 2 ** L) / M.tile)];
}

async function load(L, x, y) {
  const k = key(L, x, y);
  const u = { state: "loading", L, x, y, used: frameNo };
  units.set(k, u);
  inflight++;
  net.requests++;
  try {
    const res = await fetch(`splats/${L}/${x}_${y}.spx`);
    if (!res.ok) throw new Error(`${res.status}`);
    const fit = res.headers.get("X-Fit-Seconds");
    if (fit) { net.fitted++; net.fitSeconds += parseFloat(fit); }
    const buf = await res.arrayBuffer();
    net.bytes += buf.byteLength;
    const d = await decodeSpx(buf);
    Object.assign(u, { mode: d.mode, w: d.w, h: d.h, n: d.n, chunkEnds: d.chunkEnds, bytes: buf.byteLength });
    if (d.n) Object.assign(u, unitVao(d.data));
    u.state = "ready";
    cachedBlobs += d.n;
  } catch (e) {
    u.state = "error";
    net.failed++;
    console.warn("unit", k, e);
  } finally {
    inflight--;
    dirty = true;
    pump();
  }
}

async function loadTile(L, x, y) {
  const k = key(L, x, y);
  const t = { state: "loading", L, x, y, used: frameNo };
  tiles.set(k, t);
  inflight++;
  net.requests++;
  try {
    const res = await fetch(`tiles/${L}/${x}_${y}`);   // JPEG or lossless WebP
    if (!res.ok) throw new Error(`${res.status}`);
    const blob = await res.blob();
    net.bytes += blob.size;
    // raw pixel values, as the splats were fitted to them
    const bmp = await createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none" });
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bmp);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);

    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    Object.assign(t, { tex, bytes: Math.round(bmp.width * bmp.height * 4 * 4 / 3), state: "ready" });
    bmp.close();
    tileBytes += t.bytes;
  } catch (e) {
    t.state = "error";
    net.failed++;
    console.warn("tile", k, e);
  } finally {
    inflight--;
    dirty = true;
    pump();
  }
}

function pump() {
  while (inflight < MAX_INFLIGHT && wanted.length) {
    const [kind, L, x, y] = wanted.shift();
    if (kind === "tile") { if (!tiles.has(key(L, x, y))) loadTile(L, x, y); }
    else if (!units.has(key(L, x, y))) load(L, x, y);
  }
}

function evictTiles() {
  if (tileBytes <= TILE_BUDGET) return;
  const old = [...tiles.values()].filter(t => t.state === "ready" && t.used < frameNo)
    .sort((a, b) => a.used - b.used);
  for (const t of old) {
    if (tileBytes <= TILE_BUDGET * 0.85) break;
    gl.deleteTexture(t.tex);
    tileBytes -= t.bytes;
    tiles.delete(key(t.L, t.x, t.y));
  }
}

function evict() {
  if (cachedBlobs <= BLOB_BUDGET) return;
  const old = [...units.values()]
    .filter(u => u.state === "ready" && u.used < frameNo && u.L !== M.max_level)
    .sort((a, b) => a.used - b.used);
  for (const u of old) {
    if (cachedBlobs <= BLOB_BUDGET * 0.85) break;
    if (u.vao) { gl.deleteVertexArray(u.vao); gl.deleteBuffer(u.buf); }
    cachedBlobs -= u.n;
    units.delete(key(u.L, u.x, u.y));
  }
}

// ---------------------------------------------------------------------------------------
// camera and drawing
// ---------------------------------------------------------------------------------------

const cam = { cx: 0, cy: 0, z: 1 };     // centre in level-0 px; framebuffer px per level-0 px
const ui = { chunks: 4, bias: 0, detail: true, tiles: true, exact: true };

function fit() {
  const w = canvas.width, h = canvas.height;
  cam.z = 0.95 * Math.min(w / M.width, h / M.height);
  cam.cx = M.width / 2;
  cam.cy = M.height / 2;
  // #x=..&y=..&z=.. opens on a spot: centre in image px, z in CSS px per image px
  const q = new URLSearchParams(location.hash.slice(1));
  if (q.has("z")) cam.z = +q.get("z") * (window.devicePixelRatio || 1);
  if (q.has("x")) cam.cx = +q.get("x");
  if (q.has("y")) cam.cy = +q.get("y");
}

function toScreen(X, Y) {
  return [(X - cam.cx) * cam.z + canvas.width / 2, (Y - cam.cy) * cam.z + canvas.height / 2];
}

function frame() {
  requestAnimationFrame(frame);
  const dpr = window.devicePixelRatio || 1;
  const cw = Math.round(canvas.clientWidth * dpr), ch = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== cw || canvas.height !== ch) {
    const wasFit = !M || canvas.width === 0;
    canvas.width = cw; canvas.height = ch;
    if (M && wasFit) fit();
    dirty = true;
  }
  if (!M || !dirty) return;
  dirty = false;
  frameNo++;

  // finest level to draw: its pixels about one screen pixel, nudged by the sharpness slider
  const finest = Math.max(0, Math.min(M.max_level, Math.floor(Math.log2(1 / cam.z) - ui.bias)));
  const split = M.split || 0;
  const base = [], detail = [], need = [], tileList = [];

  // walk down from the base; a unit is drawn only if its parent was
  const visit = (L, x, y) => {
    const s = 2 ** L, T = M.tile;
    const [w, h] = unitSize(L, x, y);
    const [x0, y0] = toScreen(x * T * s, y * T * s);
    const [x1, y1] = toScreen((x * T + w) * s, (y * T + h) * s);
    if (x1 < 0 || y1 < 0 || x0 > canvas.width || y0 > canvas.height) return;
    const u = units.get(key(L, x, y));
    if (!u) { need.push(["unit", L, x, y, Math.hypot((x0 + x1) / 2 - cw / 2, (y0 + y1) / 2 - ch / 2)]); return; }
    u.used = frameNo;
    if (u.state !== "ready") return;
    (u.mode === NORMALIZED ? base : detail).push({ u, x0, y0, x1, y1, scale: cam.z * s });
    if (L > Math.max(finest, split) && (ui.detail || L === M.max_level)) {
      const [gc, gr] = gridOf(L - 1);
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const cx = 2 * x + dx, cy = 2 * y + dy;
        if (cx < gc && cy < gr) visit(L - 1, cx, cy);
      }
    }
  };
  visit(M.max_level, 0, 0);

  // below the split: JPEG tiles, coarsest loaded first so finer ones land on top; only the
  // level the zoom wants is requested, coarser tiles already cached serve as fallback
  if (finest < split && ui.tiles) {
    const [X0, Y0] = [cam.cx - cw / 2 / cam.z, cam.cy - ch / 2 / cam.z];
    const [X1, Y1] = [cam.cx + cw / 2 / cam.z, cam.cy + ch / 2 / cam.z];
    for (let L = split - 1; L >= finest; L--) {
      const span = M.tile * 2 ** L, [gc, gr] = gridOf(L);
      for (let y = Math.max(0, Math.floor(Y0 / span)); y <= Math.min(gr - 1, Math.floor(Y1 / span)); y++) {
        for (let x = Math.max(0, Math.floor(X0 / span)); x <= Math.min(gc - 1, Math.floor(X1 / span)); x++) {
          const t = tiles.get(key(L, x, y));
          const [w, h] = unitSize(L, x, y);
          const [x0, y0] = toScreen(x * span, y * span);
          const [x1, y1] = toScreen(x * span + w * 2 ** L, y * span + h * 2 ** L);
          if (t) {
            t.used = frameNo;
            if (t.state === "ready") tileList.push({ t, rect: [x0, y0, x1, y1] });
          } else if (L === finest) {
            need.push(["tile", L, x, y, Math.hypot((x0 + x1) / 2 - cw / 2, (y0 + y1) / 2 - ch / 2)]);
          }
        }
      }
    }
  }

  // splats before tiles (they are the fallback), coarse first, then nearest the centre
  const rank = n => (n[0] === "unit" ? 1000 : 0) + n[1];
  need.sort((a, b) => rank(b) - rank(a) || a[4] - b[4]);
  wanted = need.map(n => n.slice(0, 4));
  pump();
  if (inflight > 0) dirty = true;

  ensureTargets(cw, ch);
  gl.viewport(0, 0, cw, ch);
  gl.useProgram(blobProg.p);
  gl.uniform2f(blobProg.u.u_view, cw, ch);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE);
  gl.enable(gl.SCISSOR_TEST);
  let drawnBlobs = 0;
  const pass = (list, t, mode) => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.SCISSOR_TEST);
    gl.uniform1i(blobProg.u.u_mode, mode);
    for (const { u, x0, y0, x1, y1, scale } of list) {
      if (!u.n) continue;
      // scissor edges rounded the same way on both sides of a border: every pixel has one owner
      const sx0 = Math.round(x0), sx1 = Math.round(x1), sy0 = Math.round(y0), sy1 = Math.round(y1);
      if (sx1 <= sx0 || sy1 <= sy0) continue;
      gl.scissor(sx0, ch - sy1, sx1 - sx0, sy1 - sy0);
      gl.uniform2f(blobProg.u.u_origin, x0, y0);
      gl.uniform1f(blobProg.u.u_scale, scale);
      const count = u.chunkEnds[Math.min(ui.chunks, u.chunkEnds.length) - 1];
      gl.bindVertexArray(u.vao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
      drawnBlobs += count;
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
    // past 1:1, show the image's own pixels instead of smoothing between them
    const mag = ui.exact ? gl.NEAREST : gl.LINEAR;
    for (const { t, rect } of tileList) {
      gl.bindTexture(gl.TEXTURE_2D, t.tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, mag);
      gl.uniform4f(tileProg.u.u_rect, ...rect);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
  }

  evict();
  evictTiles();
  const deepest = Math.min(...base.concat(detail).map(d => d.u.L), ...tileList.map(d => d.t.L), M.max_level);
  statsEl.textContent =
    `image      ${M.width} x ${M.height}\n` +
    `level      ${deepest} drawn / ${finest} wanted (top ${M.max_level})\n` +
    `layers     splats ${M.max_level}..${split}` + (split > 0 ? `, tiles ${split - 1}..0` : "") + `\n` +
    `units      ${base.length + detail.length} drawn, ${units.size} cached\n` +
    `blobs      ${(drawnBlobs / 1e3).toFixed(0)}k drawn, ${(cachedBlobs / 1e3).toFixed(0)}k cached\n` +
    `tiles      ${tileList.length} drawn, ${tiles.size} cached\n` +
    `gpu        ${(cachedBlobs * FLOATS * 4 / 2 ** 20).toFixed(1)} MB blobs + ${(tileBytes / 2 ** 20).toFixed(1)} MB tiles\n` +
    `network    ${net.requests} requests, ${(net.bytes / 2 ** 20).toFixed(2)} MB\n` +
    `loading    ${inflight} in flight, ${wanted.length} queued` +
    (net.fitted ? `\non demand  ${net.fitted} fitted, ${(net.fitSeconds / net.fitted).toFixed(1)} s avg` : "") +
    (net.failed ? `\nfailed     ${net.failed}` : "");
}

// ---------------------------------------------------------------------------------------
// input
// ---------------------------------------------------------------------------------------

function zoomAt(px, py, factor) {
  const dpr = window.devicePixelRatio || 1;
  const sx = px * dpr, sy = py * dpr;
  const X = (sx - canvas.width / 2) / cam.z + cam.cx, Y = (sy - canvas.height / 2) / cam.z + cam.cy;
  const minZ = 0.25 * Math.min(canvas.width / M.width, canvas.height / M.height);
  cam.z = Math.min(16, Math.max(minZ, cam.z * factor));
  cam.cx = X - (sx - canvas.width / 2) / cam.z;
  cam.cy = Y - (sy - canvas.height / 2) / cam.z;
  dirty = true;
}

canvas.addEventListener("wheel", e => {
  e.preventDefault();
  zoomAt(e.offsetX, e.offsetY, Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.0015)));
}, { passive: false });

const pointers = new Map();
let pinch = 0;
canvas.addEventListener("pointerdown", e => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, [e.offsetX, e.offsetY]);
  canvas.classList.add("dragging");
});
canvas.addEventListener("pointermove", e => {
  if (!pointers.has(e.pointerId)) return;
  const [px, py] = pointers.get(e.pointerId);
  pointers.set(e.pointerId, [e.offsetX, e.offsetY]);
  const dpr = window.devicePixelRatio || 1;
  if (pointers.size === 1) {
    cam.cx -= (e.offsetX - px) * dpr / cam.z;
    cam.cy -= (e.offsetY - py) * dpr / cam.z;
    dirty = true;
  } else if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
    if (pinch) zoomAt((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, d / pinch);
    pinch = d;
  }
});
const release = e => {
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinch = 0;
  if (!pointers.size) canvas.classList.remove("dragging");
};
canvas.addEventListener("pointerup", release);
canvas.addEventListener("pointercancel", release);
canvas.addEventListener("dblclick", e => zoomAt(e.offsetX, e.offsetY, 2));
window.addEventListener("keydown", e => {
  if (!M) return;
  if (e.key === "+" || e.key === "=") zoomAt(canvas.clientWidth / 2, canvas.clientHeight / 2, 1.5);
  if (e.key === "-") zoomAt(canvas.clientWidth / 2, canvas.clientHeight / 2, 1 / 1.5);
  if (e.key === "0") { fit(); dirty = true; }
});

const bindRange = (id, apply) => {
  const el = document.getElementById(id), out = document.getElementById(id + "v");
  el.addEventListener("input", () => { apply(el); if (out) out.textContent = el.value; dirty = true; });
};
bindRange("chunks", el => { ui.chunks = +el.value; });
bindRange("bias", el => { ui.bias = +el.value; });
bindRange("detail", el => { ui.detail = el.checked; });
bindRange("tiles", el => { ui.tiles = el.checked; });
bindRange("exact", el => { ui.exact = el.checked; });

fetch("manifest.json")
  .then(r => r.json())
  .then(m => {
    M = m;
    if (canvas.width) fit();
    dirty = true;
  })
  .catch(e => fail(`could not load manifest.json: ${e}`));
requestAnimationFrame(frame);
