// The viewer: pick an image the server has prepared, then pan and zoom it while the panel on
// the left shows what is being asked for, what is arriving and what is held.
//
// The image method decides how units are drawn, so the canvas is rebuilt when an image is
// opened: a 2D context for tiles, a WebGL one for splats.

import { Connection } from './net.js';
import { Scene } from './scene.js';
import { Panel, human, zoomLabel } from './panel.js';
import { rendererFor } from './renderers.js';

const VIEW_INTERVAL_MS = 60;        // at most this often while the view keeps changing
const BUDGET_BYTES = 50 * 1024 * 1024;

const $ = (id) => document.getElementById(id);
const stage = document.querySelector('.stage');
const scene = new Scene(BUDGET_BYTES);
const panel = new Panel($('panel'));

let canvas = $('canvas');
let connection = null;
let chart = null;
let epoch = 0;
let dirty = true;
let lastViewSent = 0;
let viewPending = false;
let viewsSent = 0;
let serverStats = {};
let frames = 0, fps = 0, fpsSince = performance.now();
const rateWindow = [];

// ----------------------------------------------------------------- picking an image

async function showPicker() {
  const list = $('pickerList');
  list.textContent = 'loading…';
  const data = await (await fetch('/api/images')).json();
  const ready = (data.images ?? []).filter((i) => i.status === 'ready');
  list.replaceChildren();
  if (!ready.length) {
    list.innerHTML = '<p class="empty">No prepared images yet. '
      + '<a href="/">Open the server page</a> to add or prepare one.</p>';
    return;
  }
  for (const image of ready) {
    const card = document.createElement('button');
    card.className = 'pick';
    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    thumb.style.backgroundImage = `url(/api/images/${encodeURIComponent(image.name)}/preview.jpg)`;
    const label = document.createElement('div');
    label.innerHTML = `<strong>${image.name}</strong><br><span class="dim">`
      + `${image.width.toLocaleString()} × ${image.height.toLocaleString()} · `
      + `${image.megapixels.toFixed(1)} MP · ${image.units.toLocaleString()} units</span>`;
    card.append(thumb, label);
    card.onclick = () => choose(image.name);
    list.append(card);
  }
}

function choose(name) {
  const url = new URL(location.href);
  url.searchParams.set('image', name);
  history.replaceState(null, '', url);
  $('picker').hidden = true;
  open(name);
}

// ----------------------------------------------------------------- connection

function connect() {
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/link`;
  connection = new Connection(url, {
    onOpen: () => panel.set('link', 'connected'),
    onClose: () => panel.set('link', 'disconnected'),
    onWelcome: (w) => panel.set('method', w.method),
    onFault: (text) => showError(text),
    onChart: (c) => {
      chart = c;
      $('title').textContent = `${c.image}  ·  ${c.method}`;
      try {
        scene.start(c, freshCanvas(), rendererFor(c.method, canvas, c));
      } catch (e) {
        showError(String(e.message ?? e));
        return;
      }
      epoch = 0;
      sendView(true);
      fillImageFacts();
      dirty = true;
    },
    onUnit: async (unit) => {
      if (!chart || !scene.renderer) return;
      rateWindow.push({ at: performance.now(), bytes: unit.wireBytes });
      try {
        scene.put(unit.level, unit.x, unit.y, await scene.renderer.decode(unit.bytes));
        dirty = true;
      } catch (e) {
        showError(`could not draw a unit: ${e.message ?? e}`);
      }
    },
    onStats: (s) => { serverStats = s; },
  });
}

/** A canvas can hold only one kind of context, so each image gets a new one. */
function freshCanvas() {
  const replacement = document.createElement('canvas');
  replacement.id = 'canvas';
  canvas.replaceWith(replacement);
  canvas = replacement;
  sizeCanvas();
  return canvas;
}

function showError(text) {
  const box = $('error');
  box.textContent = text;
  box.hidden = false;
  setTimeout(() => { box.hidden = true; }, 6000);
}

function open(name) {
  if (connection?.ready) connection.open(name);
  else setTimeout(() => open(name), 120);
}

// ----------------------------------------------------------------- view reporting

function sendView(force = false) {
  if (!chart || !connection?.ready) return;
  const now = performance.now();
  if (!force && now - lastViewSent < VIEW_INTERVAL_MS) {
    if (!viewPending) {
      viewPending = true;
      setTimeout(() => { viewPending = false; sendView(true); }, VIEW_INTERVAL_MS);
    }
    return;
  }
  lastViewSent = now;
  epoch++;
  connection.view(epoch, {
    cx: scene.camera.cx,
    cy: scene.camera.cy,
    scale: scene.camera.scale,
    width: canvas.width,
    height: canvas.height,
  }, scene.takeDropped());
  viewsSent++;
}

// ----------------------------------------------------------------- input

function sizeCanvas() {
  const box = stage.getBoundingClientRect();
  canvas.width = Math.max(320, Math.floor(box.width));
  canvas.height = Math.max(240, Math.floor(box.height));
}

function resize() {
  sizeCanvas();
  if (chart) {
    scene.clamp();
    sendView(true);
  }
  dirty = true;
}

// Listeners live on the stage, not the canvas, so swapping the canvas keeps them.
stage.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (!chart) return;
  const rect = canvas.getBoundingClientRect();
  scene.zoomAt(e.clientX - rect.left, e.clientY - rect.top, Math.exp(e.deltaY * 0.0015));
  dirty = true;
  sendView();
}, { passive: false });

let dragging = null;
stage.addEventListener('pointerdown', (e) => {
  if (e.target.closest('#picker')) return;
  dragging = { x: e.clientX, y: e.clientY };
  stage.setPointerCapture(e.pointerId);
});
stage.addEventListener('pointermove', (e) => {
  if (!dragging || !chart) return;
  scene.panByScreen(e.clientX - dragging.x, e.clientY - dragging.y);
  dragging = { x: e.clientX, y: e.clientY };
  dirty = true;
  sendView();
});
const endDrag = () => { dragging = null; };
stage.addEventListener('pointerup', endDrag);
stage.addEventListener('pointercancel', endDrag);

stage.addEventListener('dblclick', (e) => {
  if (!chart) return;
  const rect = canvas.getBoundingClientRect();
  scene.zoomAt(e.clientX - rect.left, e.clientY - rect.top, 0.5);
  dirty = true;
  sendView(true);
});

addEventListener('keydown', (e) => {
  if (!chart) return;
  const step = 80;
  if (e.key === '+' || e.key === '=') scene.zoomAt(canvas.width / 2, canvas.height / 2, 0.8);
  else if (e.key === '-') scene.zoomAt(canvas.width / 2, canvas.height / 2, 1.25);
  else if (e.key === 'ArrowLeft') scene.panByScreen(step, 0);
  else if (e.key === 'ArrowRight') scene.panByScreen(-step, 0);
  else if (e.key === 'ArrowUp') scene.panByScreen(0, step);
  else if (e.key === 'ArrowDown') scene.panByScreen(0, -step);
  else if (e.key === '0') scene.fit();
  else return;
  e.preventDefault();
  dirty = true;
  sendView();
});

$('fit').onclick = () => { scene.fit(); dirty = true; sendView(true); };
$('change').onclick = () => { $('picker').hidden = false; showPicker(); };

// ----------------------------------------------------------------- the loop

function fillImageFacts() {
  panel.set('name', chart.image);
  panel.set('pixels', `${chart.width.toLocaleString()} × ${chart.height.toLocaleString()}`);
  panel.set('megapixels', (chart.width * chart.height / 1e6).toFixed(1));
  panel.set('method', chart.method);
  panel.set('levels', `0 … ${chart.maxLevel}`);
  panel.set('unit size', `${chart.unitSize} px, ratio ${chart.ratio}`);
  panel.set('prepared', human(chart.bytes));
  panel.set('units total', chart.units.toLocaleString());
}

function updatePanel() {
  if (!chart) return;
  const r = scene.region();
  const wanted = scene.wanted();
  const held = wanted.filter((k) => scene.has(k)).length;

  panel.set('zoom', zoomLabel(scene.camera.scale));
  panel.set('level', `${scene.level()} / ${chart.maxLevel}`);
  panel.set('scale', `${scene.camera.scale.toFixed(3)} src px per screen px`);
  panel.set('centre', `${Math.round(scene.camera.cx).toLocaleString()}, ${Math.round(scene.camera.cy).toLocaleString()}`);
  panel.set('region', `${Math.round(r.w).toLocaleString()} × ${Math.round(r.h).toLocaleString()} px`);
  const pct = (r.w * r.h) / (chart.width * chart.height) * 100;
  panel.set('visible', pct >= 100 ? '100%' : pct < 0.01 ? `${pct.toFixed(4)}%` : `${pct.toFixed(2)}%`);
  panel.set('units wanted', String(wanted.length));
  panel.set('held', String(held));
  panel.set('missing', String(wanted.length - held));

  const now = performance.now();
  while (rateWindow.length && now - rateWindow[0].at > 2000) rateWindow.shift();
  const rate = rateWindow.reduce((sum, e) => sum + e.bytes, 0) / 2;
  panel.set('views sent', viewsSent.toLocaleString());
  panel.set('units in', String(connection?.messagesReceived ?? 0));
  panel.set('bytes in', human(connection?.bytesReceived ?? 0));
  panel.set('rate', `${human(rate)}/s`);
  const units = serverStats.unitsSent ?? 0;
  panel.set('average unit', units ? human((serverStats.bytesSent ?? 0) / units) : '–');
  panel.set('server queue', String(serverStats.queued ?? 0));
  panel.set('cancelled', String(serverStats.unitsCancelled ?? 0));
  panel.set('epoch', String(epoch));

  panel.set('units held', String(scene.units.size));
  panel.set('held bytes', human(scene.heldBytes));
  panel.set('budget', human(scene.budget));
  panel.set('evicted', String(scene.evictions));
  panel.set('unreported drops', String(scene.dropped.length));

  panel.set('units drawn', String(scene.lastDrawn));
  panel.set('splats drawn', scene.renderer?.splatsDrawn != null
    ? scene.renderer.splatsDrawn.toLocaleString() : '–');
  panel.set('draw time', `${scene.lastDrawMs.toFixed(1)} ms`);
  panel.set('frames', `${fps} fps`);
}

function frame() {
  if (dirty) {
    scene.draw();
    dirty = false;
  }
  frames++;
  const now = performance.now();
  if (now - fpsSince >= 1000) {
    fps = Math.round((frames * 1000) / (now - fpsSince));
    frames = 0;
    fpsSince = now;
  }
  requestAnimationFrame(frame);
}

addEventListener('resize', resize);
sizeCanvas();
connect();
setInterval(updatePanel, 100);
requestAnimationFrame(frame);

const requested = new URLSearchParams(location.search).get('image');
if (requested) open(requested);
else { $('picker').hidden = false; showPicker(); }
