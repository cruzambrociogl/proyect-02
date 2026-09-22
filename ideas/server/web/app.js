// Project 2 viewer. Speaks the binary protocol over a WebSocket and paints ladder tiles onto a
// canvas. No libraries - everything the page needs is served by the Java server.
//
// Three coordinate systems meet here:
//   source px  - pixels of the original image
//   ladder px  - pixels at ladder level L, where 1 ladder px = ratio^L source px
//   screen px  - what the user sees; `scale` is source px per screen px

const MAGIC_0 = 80, MAGIC_1 = 50, VERSION = 1, HEADER = 12;
const GREET = 1, CHART = 2, GAZE = 3, TILE = 4, FAULT = 5, OPEN = 6;

const TILE_BUDGET = 420;          // 420 tiles of 256px RGBA ~= 110 MB decoded worst case
const BYTES_PER_TILE = 256 * 256 * 4;
const GAZE_HZ = 10;

const imageName = new URLSearchParams(location.search).get('image');

const canvas = document.getElementById('view');
const ctx = canvas.getContext('2d', { alpha: false });
const $ = (id) => document.getElementById(id);

let img = null;                   // {width, height, tileSize, ratio, maxLevel, bytes}
let view = { cx: 0, cy: 0, scale: 1 };
let epoch = 0, gazeCount = 0;
let rxTiles = 0, rxBytes = 0, evicted = 0;
let rateWindow = [];
let lastReq = { needed: 0, reused: 0, asked: 0 };
let dirty = true;

const tiles = new Map();          // "level:tx:ty" -> {bitmap, level, tx, ty, ls, used}
let useCounter = 0;

// --------------------------------------------------------------- connection

if (!imageName) {
  $('status').textContent = 'no image selected';
  $('status').className = 'pill bad';
} else {
  $('imgName').textContent = imageName;
  fetch('/api/images').then(r => r.json()).then(list => {
    const meta = list.find(e => e.name === imageName);
    if (meta) $('imgBytes').textContent = human(meta.bytes);
  }).catch(() => { });
}

const ws = new WebSocket(`ws://${location.host}/project2`);
ws.binaryType = 'arraybuffer';

ws.onopen = () => {
  setStatus('connected', 'ok');
  resize();
  const g = message(GREET, 0, 6);
  g.view.setUint16(HEADER, canvas.width);
  g.view.setUint16(HEADER + 2, canvas.height);
  g.view.setUint16(HEADER + 4, TILE_BUDGET);
  ws.send(g.buffer);

  const nameBytes = new TextEncoder().encode(imageName || '');
  const o = message(OPEN, 0, nameBytes.length);
  new Uint8Array(o.buffer, HEADER).set(nameBytes);
  ws.send(o.buffer);
};

ws.onclose = () => setStatus('disconnected', 'bad');
ws.onerror = () => setStatus('error', 'bad');

ws.onmessage = async (ev) => {
  const buf = ev.data;
  const v = new DataView(buf);
  if (v.getUint8(0) !== MAGIC_0 || v.getUint8(1) !== MAGIC_1) return;
  const type = v.getUint8(3);

  if (type === CHART) {
    img = {
      width: v.getInt32(HEADER),
      height: v.getInt32(HEADER + 4),
      tileSize: v.getUint16(HEADER + 8),
      ratio: v.getFloat32(HEADER + 10),
      maxLevel: v.getUint16(HEADER + 14),
    };
    $('imgDims').textContent = img.width.toLocaleString() + ' × ' + img.height.toLocaleString();
    $('imgMP').textContent = megapixels(img.width, img.height);
    $('imgTile').textContent = img.tileSize + 'px / ' + img.ratio.toFixed(2);
    $('imgLevels').textContent = '0 … ' + img.maxLevel;
    setStatus('streaming', 'ok');
    fitWholeImage();
    sendGaze();
    return;
  }

  if (type === TILE) {
    rxBytes += buf.byteLength;
    rxTiles++;
    rateWindow.push({ t: performance.now(), b: buf.byteLength });
    const level = v.getUint16(HEADER);
    const tx = v.getInt32(HEADER + 2);
    const ty = v.getInt32(HEADER + 6);
    const jpeg = buf.slice(HEADER + 10);
    const bitmap = await createImageBitmap(new Blob([jpeg], { type: 'image/jpeg' }));
    tiles.set(`${level}:${tx}:${ty}`,
        { bitmap, level, tx, ty, ls: Math.pow(img.ratio, level), used: ++useCounter });
    evict();
    dirty = true;
    return;
  }

  if (type === FAULT) {
    const len = v.getInt32(8);
    setStatus(new TextDecoder().decode(new Uint8Array(buf, HEADER, len)), 'bad');
  }
};

function setStatus(text, kind) {
  const el = $('status');
  el.textContent = text;
  el.className = 'pill ' + (kind || '');
}

function message(type, ep, payloadLength) {
  const buffer = new ArrayBuffer(HEADER + payloadLength);
  const view = new DataView(buffer);
  view.setUint8(0, MAGIC_0);
  view.setUint8(1, MAGIC_1);
  view.setUint8(2, VERSION);
  view.setUint8(3, type);
  view.setInt32(4, ep);
  view.setInt32(8, payloadLength);
  return { buffer, view };
}

let gazePending = false;
function sendGaze() {
  if (!img || ws.readyState !== WebSocket.OPEN || gazePending) return;
  gazePending = true;
  setTimeout(() => {
    gazePending = false;
    const m = message(GAZE, ++epoch, 16);
    m.view.setFloat32(HEADER, view.cx);
    m.view.setFloat32(HEADER + 4, view.cy);
    m.view.setFloat32(HEADER + 8, view.scale);
    m.view.setUint16(HEADER + 12, canvas.width);
    m.view.setUint16(HEADER + 14, canvas.height);
    ws.send(m.buffer);
    gazeCount++;
    lastReq = tileDemand();       // what this GAZE implies, for the HUD
    dirty = true;
  }, 1000 / GAZE_HZ);
}

// -------------------------------------------------------------------- view

function currentLevel() {
  const l = Math.floor(Math.log(Math.max(1e-6, view.scale)) / Math.log(img.ratio));
  return Math.max(0, Math.min(img.maxLevel, l));
}

function visibleRegion() {
  return {
    x: view.cx - canvas.width * view.scale / 2,
    y: view.cy - canvas.height * view.scale / 2,
    w: canvas.width * view.scale,
    h: canvas.height * view.scale,
  };
}

/** Which tiles this viewport needs, and how many the client already holds. */
function tileDemand() {
  const level = currentLevel();
  const ls = Math.pow(img.ratio, level);
  const ts = img.tileSize;
  const r = visibleRegion();
  const tx0 = Math.floor(r.x / ls / ts), tx1 = Math.floor((r.x + r.w) / ls / ts);
  const ty0 = Math.floor(r.y / ls / ts), ty1 = Math.floor((r.y + r.h) / ls / ts);
  const lw = Math.ceil(img.width / ls), lh = Math.ceil(img.height / ls);

  let needed = 0, reused = 0;
  for (let ty = ty0; ty <= ty1; ty++)
    for (let tx = tx0; tx <= tx1; tx++) {
      if (tx < 0 || ty < 0 || tx * ts >= lw || ty * ts >= lh) continue;
      needed++;
      if (tiles.has(`${level}:${tx}:${ty}`)) reused++;
    }
  return { needed, reused, asked: needed - reused, level, ls, tx0, tx1, ty0, ty1 };
}

function fitWholeImage() {
  view.cx = img.width / 2;
  view.cy = img.height / 2;
  view.scale = maxScale();
}

function maxScale() {
  return Math.max(img.width / canvas.width, img.height / canvas.height);
}

function clampView() {
  view.scale = Math.min(maxScale(), Math.max(0.25, view.scale));
  const halfW = canvas.width * view.scale / 2, halfH = canvas.height * view.scale / 2;
  view.cx = Math.max(Math.min(view.cx, img.width - halfW), halfW);
  view.cy = Math.max(Math.min(view.cy, img.height - halfH), halfH);
  if (halfW * 2 >= img.width) view.cx = img.width / 2;
  if (halfH * 2 >= img.height) view.cy = img.height / 2;
}

// ----------------------------------------------------------------- painting

function render() {
  requestAnimationFrame(render);
  if (!img || !dirty) return;
  dirty = false;

  ctx.fillStyle = '#0d0e11';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const r = visibleRegion();

  // Coarse levels first so finer tiles paint over them: while detail is still arriving the
  // user sees a complete, slightly soft image rather than holes.
  const ordered = [...tiles.values()].sort((a, b) => b.level - a.level);
  for (const t of ordered) {
    const w = t.bitmap.width * t.ls / view.scale;
    const h = t.bitmap.height * t.ls / view.scale;
    const x = (t.tx * img.tileSize * t.ls - r.x) / view.scale;
    const y = (t.ty * img.tileSize * t.ls - r.y) / view.scale;
    if (x + w < 0 || y + h < 0 || x > canvas.width || y > canvas.height) continue;
    ctx.drawImage(t.bitmap, x, y, w, h);
    t.used = ++useCounter;
  }

  updateHud(r);
}

function updateHud(r) {
  const d = tileDemand();
  $('zoom').textContent = view.scale >= 1
      ? '1:' + view.scale.toFixed(2) : (1 / view.scale).toFixed(2) + ':1';
  $('level').textContent = d.level + ' / ' + img.maxLevel;
  $('ladderScale').textContent = d.ls.toFixed(2);
  $('regionXY').textContent = Math.round(r.x).toLocaleString() + ', ' + Math.round(r.y).toLocaleString();
  $('regionWH').textContent = Math.round(r.w).toLocaleString() + ' × ' + Math.round(r.h).toLocaleString();
  const pct = 100 * (r.w * r.h) / (img.width * img.height);
  $('regionPct').textContent = pct >= 100 ? '100%' : pct < 0.01 ? pct.toFixed(4) + '%' : pct.toFixed(2) + '%';
  $('tileRange').textContent = `${d.tx0}…${d.tx1} × ${d.ty0}…${d.ty1}`;

  $('epoch').textContent = epoch;
  $('gazeCount').textContent = gazeCount;
  $('needed').textContent = d.needed;
  $('reused').textContent = d.reused;
  $('asked').textContent = lastReq.asked;

  $('rxTiles').textContent = rxTiles;
  $('rxBytes').textContent = human(rxBytes);
  $('rxAvg').textContent = rxTiles ? human(rxBytes / rxTiles) : '–';

  const now = performance.now();
  rateWindow = rateWindow.filter(e => now - e.t < 2000);
  const rate = rateWindow.reduce((s, e) => s + e.b, 0) / 2;
  $('rxRate').textContent = human(rate) + '/s';

  $('memTiles').textContent = tiles.size + ' / ' + TILE_BUDGET;
  $('memMB').textContent = human(tiles.size * BYTES_PER_TILE);
  $('memEvicted').textContent = evicted;
}

/** Hard cap on client memory: drop the least recently drawn tiles and free the bitmaps. */
function evict() {
  if (tiles.size <= TILE_BUDGET) return;
  const all = [...tiles.entries()].sort((a, b) => a[1].used - b[1].used);
  for (let i = 0; i < all.length - TILE_BUDGET; i++) {
    all[i][1].bitmap.close();
    tiles.delete(all[i][0]);
    evicted++;
  }
}

function human(bytes) {
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return Math.round(bytes) + ' B';
}

function megapixels(w, h) {
  const mp = (w * h) / 1e6;
  return mp >= 1000 ? (mp / 1000).toFixed(2) + ' GP' : mp.toFixed(1) + ' MP';
}

// ------------------------------------------------------------------- input

let dragging = false, lastX = 0, lastY = 0;

canvas.addEventListener('pointerdown', (e) => {
  dragging = true; lastX = e.clientX; lastY = e.clientY;
  canvas.classList.add('dragging');
  canvas.setPointerCapture(e.pointerId);
});

canvas.addEventListener('pointermove', (e) => {
  if (!dragging || !img) return;
  const dpr = window.devicePixelRatio || 1;
  view.cx -= (e.clientX - lastX) * dpr * view.scale;
  view.cy -= (e.clientY - lastY) * dpr * view.scale;
  lastX = e.clientX; lastY = e.clientY;
  clampView();
  dirty = true;
  sendGaze();
});

canvas.addEventListener('pointerup', (e) => {
  dragging = false;
  canvas.classList.remove('dragging');
  canvas.releasePointerCapture(e.pointerId);
});

canvas.addEventListener('wheel', (e) => {
  if (!img) return;
  e.preventDefault();
  const dpr = window.devicePixelRatio || 1;
  const px = e.clientX * dpr, py = e.clientY * dpr;

  // Keep the point under the cursor fixed while zooming.
  const beforeX = view.cx + (px - canvas.width / 2) * view.scale;
  const beforeY = view.cy + (py - canvas.height / 2) * view.scale;
  view.scale *= Math.exp(e.deltaY * 0.0012);
  view.scale = Math.min(maxScale(), Math.max(0.25, view.scale));
  view.cx = beforeX - (px - canvas.width / 2) * view.scale;
  view.cy = beforeY - (py - canvas.height / 2) * view.scale;

  clampView();
  dirty = true;
  sendGaze();
}, { passive: false });

// ------------------------------------------------------------------ layout

function resize() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(canvas.clientWidth * dpr);
  canvas.height = Math.round(canvas.clientHeight * dpr);
  if (img) { clampView(); sendGaze(); }
  dirty = true;
}

window.addEventListener('resize', resize);
resize();
requestAnimationFrame(render);
