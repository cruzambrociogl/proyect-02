// The viewer: pick an image the server has prepared, then pan and zoom it while the panel on
// the left shows what is being asked for, what is arriving and what is held.
//
// The image method decides how units are drawn, so the canvas is rebuilt when an image is
// opened: a 2D context for tiles, a WebGL one for splats.

import { Connection } from './net.js';
import { Scene } from './scene.js';
import { Panel, count, human, zoomLabel } from './panel.js';
import { rendererFor } from './renderers.js';

const VIEW_INTERVAL_MS = 60;        // at most this often while the view keeps changing

// How much decoded image to hold. Adjustable from the address bar - ?budget=24 - because the
// interesting question about a viewer is what it gives up when it is given less.
const BUDGET_BYTES = Math.max(8, Number(new URLSearchParams(location.search).get('budget')) || 50)
  * 1024 * 1024;

// What to keep while the tab is in the background: enough to draw something at once when it
// comes back, not a screenful of detail nobody is looking at.
const HIDDEN_BYTES = 4 * 1024 * 1024;

// A canvas this big already has more pixels than any image detail the eye will find, and each
// one costs four bytes several times over - the browser keeps more than one buffer. On a large
// screen at twice the pixel ratio the canvas alone can cost forty megabytes.
const MAX_CANVAS_PIXELS = 4.5e6;

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
let pathStats = {};
let frames = 0, fps = 0, fpsSince = performance.now();
const rateWindow = [];
let lastUnitAt = 0;        // when a tile last arrived, so a stall can be named as one
let tilesIn = 0;           // tiles, not messages: the session's own chatter is not a tile

// ----------------------------------------------------------------- picking an image

async function showPicker() {
  const list = $('pickerList');
  list.textContent = 'loading…';
  const data = await (await fetch('/api/images')).json();
  const ready = (data.images ?? []).filter((i) => i.status === 'ready');
  list.replaceChildren();
  if (!ready.length) {
    list.innerHTML = '<p class="empty">No prepared images yet. '
      + '<a href="/" target="_blank" rel="noopener">Open the server page</a> to add or prepare one.</p>';
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
    onClose: () => panel.set('link', 'disconnected', 'bad'),
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
      // The epoch is not reset here. It counts views for the life of the connection, not of
      // the image: the bridge and the server both take a lower epoch to mean an older view and
      // throw its units away, so starting again at zero made every tile of the new image look
      // stale and the canvas stayed black.
      sendView(true);
      fillImageFacts();
      dirty = true;
    },
    onUnit: async (unit) => {
      if (!chart || !scene.renderer) return;
      tilesIn++;
      lastUnitAt = performance.now();
      rateWindow.push({ at: lastUnitAt, bytes: unit.wireBytes });
      try {
        scene.put(unit.level, unit.x, unit.y, await scene.renderer.decode(unit.bytes));
        dirty = true;
      } catch (e) {
        showError(`could not draw a unit: ${e.message ?? e}`);
      }
    },
    onStats: (s) => { serverStats = s; },
    onPath: (p) => { pathStats = p; },
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

/**
 * Give the canvas as many real pixels as the screen has, and pin its displayed size to what
 * was actually measured.
 *
 * Two sizes exist and they must be kept in step: the backing store (canvas.width, the pixels
 * drawn into) and the box on the page (CSS pixels, what the mouse is reported in). The
 * stylesheet stretches the canvas to fill the stage, so if the backing store is sized from a
 * stale or rounded measurement the browser quietly scales the drawing to fit - the picture
 * lands in the wrong place and at the wrong size, and clicks no longer point at what they
 * appear to point at. Writing both sizes together, from one measurement, is what stops that.
 *
 * The pixel ratio is capped at 2: beyond that a screenful costs more tiles than it is worth.
 */
function sizeCanvas() {
  const box = stage.getBoundingClientRect();
  let ratio = Math.min(devicePixelRatio || 1, 2);
  const pixels = box.width * box.height * ratio * ratio;
  if (pixels > MAX_CANVAS_PIXELS) ratio *= Math.sqrt(MAX_CANVAS_PIXELS / pixels);
  const width = Math.max(320, Math.round(box.width * ratio));
  const height = Math.max(240, Math.round(box.height * ratio));
  canvas.style.width = `${box.width}px`;
  canvas.style.height = `${box.height}px`;
  if (canvas.width === width && canvas.height === height) return false;
  canvas.width = width;
  canvas.height = height;
  return true;
}

/**
 * Where an event happened, in the pixels the scene draws in.
 *
 * Measured from the box on the page rather than assumed, so it stays right even if the two
 * sizes have drifted apart for a moment - during a resize, a change of screen, or a zoom of
 * the page itself.
 */
function atCanvas(event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) * (canvas.width / rect.width),
    y: (event.clientY - rect.top) * (canvas.height / rect.height),
  };
}

/** How many canvas pixels one CSS pixel of movement is worth. */
function pointerScale() {
  const rect = canvas.getBoundingClientRect();
  return { x: canvas.width / rect.width, y: canvas.height / rect.height };
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
  const at = atCanvas(e);
  scene.zoomAt(at.x, at.y, Math.exp(e.deltaY * 0.0015));
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
  const step = pointerScale();
  scene.panByScreen((e.clientX - dragging.x) * step.x, (e.clientY - dragging.y) * step.y);
  dragging = { x: e.clientX, y: e.clientY };
  dirty = true;
  sendView();
});
const endDrag = () => { dragging = null; };
stage.addEventListener('pointerup', endDrag);
stage.addEventListener('pointercancel', endDrag);

stage.addEventListener('dblclick', (e) => {
  if (!chart) return;
  const at = atCanvas(e);
  scene.zoomAt(at.x, at.y, 0.5);
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
  panel.set('file', chart.image);
  panel.set('size', `${chart.width.toLocaleString()} × ${chart.height.toLocaleString()} px`
    + `  ·  ${(chart.width * chart.height / 1e6).toFixed(0)} Mpx`);
  panel.set('method', chart.method === 'ladder-tiles'
    ? `tiles of ${chart.unitSize} px, each level ${chart.ratio}× smaller`
    : chart.method);
  panel.set('prepared', `${count(chart.units)} units  ·  ${human(chart.bytes)} on the server`);
}

/**
 * What the panel says, once every tenth of a second.
 *
 * The order is the order the questions come in: am I waiting, what is arriving, what is the
 * path doing, what is this costing me. Rates are worked out over the last two seconds rather
 * than reported as running totals, because "28 tiles a second" answers a question and
 * "885 tiles" does not.
 */
function updatePanel() {
  if (!chart) return;
  const now = performance.now();
  const region = scene.region();
  const wanted = scene.wanted();
  const here = wanted.filter((key) => scene.has(key)).length;
  const missing = wanted.length - here;

  while (rateWindow.length && now - rateWindow[0].at > 2000) rateWindow.shift();
  const seconds = 2;
  const bytesPerSecond = rateWindow.reduce((sum, e) => sum + e.bytes, 0) / seconds;
  const tilesPerSecond = rateWindow.length / seconds;
  const quiet = now - lastUnitAt;

  // ---------------------------------------------------------------- this view
  panel.fill('tiles', wanted.length ? here / wanted.length : 1,
    missing === 0 ? `all ${count(wanted.length)} tiles of this view are here`
      : `${count(here)} of ${count(wanted.length)} tiles`,
    missing === 0);

  if (missing === 0) {
    panel.set('status', 'complete', 'settled');
  } else if (tilesPerSecond > 0) {
    panel.set('status', `${count(missing)} still coming`, 'waiting');
  } else if (quiet > 2500) {
    panel.set('status', `${count(missing)} missing, nothing arriving for `
      + `${(quiet / 1000).toFixed(0)} s`, 'bad');
  } else {
    panel.set('status', `${count(missing)} still coming`, 'waiting');
  }

  panel.set('zoom', zoomLabel(scene.camera.scale));
  panel.set('detail', `${scene.level()} of ${chart.maxLevel}`
    + (scene.level() === 0 ? ' (finest)' : ''));
  // Clamped to the image: zoomed right out the view is wider than the picture, and saying so
  // in pixels of image would be saying something untrue.
  const seenW = Math.min(region.w, chart.width);
  const seenH = Math.min(region.h, chart.height);
  const share = (seenW * seenH) / (chart.width * chart.height) * 100;
  panel.set('on screen', share >= 99.5 ? 'the whole image'
    : `${count(seenW)} × ${count(seenH)} px, `
      + `${share < 0.01 ? share.toFixed(4) : share.toFixed(2)}%`);

  // ---------------------------------------------------------------- arriving
  panel.set('now', tilesPerSecond
    ? `${human(bytesPerSecond)}/s  ·  ${tilesPerSecond.toFixed(0)} tiles/s`
    : 'nothing right now');
  panel.set('this session', `${human(connection?.bytesReceived ?? 0)}  ·  ${count(tilesIn)} tiles`);
  const sent = serverStats.unitsSent ?? 0;
  panel.set('average tile', sent ? human((serverStats.bytesSent ?? 0) / sent) : '–');

  // ---------------------------------------------------------------- the path
  const mbit = (bits) => (bits == null ? '–' : `${(bits / 1e6).toFixed(1)} mbit/s`);
  const ms = (micros) => (micros == null ? '–' : `${(micros / 1000).toFixed(1)} ms`);
  panel.set('sending at', mbit(serverStats.rate));
  panel.set('round trip', serverStats.rttMicros == null ? '–'
    : `${ms(serverStats.rttMicros)} (floor ${ms(serverStats.floorMicros)})`);
  const queueMs = (serverStats.queueMicros ?? 0) / 1000;
  panel.set('queue', ms(serverStats.queueMicros), queueMs > 100 ? 'bad'
    : queueMs > 25 ? 'waiting' : null);
  const loss = serverStats.loss ?? 0;
  panel.set('loss', `${(loss * 100).toFixed(1)}%`, loss > 0.15 ? 'bad' : null);

  // What the repair actually cost, against what the same messages would have needed on a
  // path that lost nothing - the server counts both, so padding and the session's own
  // messages are on the same side of the comparison instead of inflating it.
  const symbols = serverStats.deliveredSymbols ?? 0;
  const needed = serverStats.deliveredNeeded ?? 0;
  panel.set('repair', needed > 0
    ? `${Math.max(0, (symbols / needed - 1) * 100).toFixed(0)}% extra symbols` : '–');
  panel.set('cancelled', `${count(serverStats.unitsCancelled ?? 0)} tiles`);

  // ---------------------------------------------------------------- memory here
  panel.fill('cache', scene.heldBytes / scene.budget,
    `${human(scene.heldBytes)} of ${human(scene.budget)} held`,
    scene.heldBytes < scene.budget * 0.9);
  panel.set('holding', `${count(scene.units.size)} tiles  ·  ${human(scene.heldBytes)}`);
  panel.set('dropped', `${count(scene.evictions)} tiles`
    + (scene.dropped.length ? `  ·  ${count(scene.dropped.length)} not yet reported` : ''));
  panel.set('drawing', `${count(scene.lastDrawn)} tiles, `
    + `${scene.lastDrawMs.toFixed(1)} ms, ${fps} fps`);

  // ---------------------------------------------------------------- the fold
  panel.set('link', connection?.ready ? 'connected' : 'disconnected',
    connection?.ready ? null : 'bad');
  panel.set('epoch', count(epoch));
  panel.set('views sent', count(viewsSent));
  panel.set('server queue', count(serverStats.queued ?? 0));
  panel.set('symbols out', count(serverStats.symbols ?? 0));
  panel.set('packets in', count(pathStats.packetsIn ?? 0));
  panel.set('tiles rebuilt', count(pathStats.unitsRebuilt ?? 0));
  panel.set('part built', count(pathStats.unitsPartial ?? 0));
  panel.set('wasted', count(pathStats.symbolsWasted ?? 0));
  panel.set('discarded', count(pathStats.unitsStale ?? 0));
  panel.set('splats drawn', scene.renderer?.splatsDrawn == null ? '–'
    : count(scene.renderer.splatsDrawn));
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

// A window resize is not the only way the stage changes size - a different screen, the page
// zoomed, the window moved to another monitor - so watch the box itself as well.
addEventListener('resize', resize);
new ResizeObserver(resize).observe(stage);

// Nobody is looking: hold almost nothing. What is dropped is reported to the server the usual
// way, so it will be sent again when it is wanted.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) scene.shrink(HIDDEN_BYTES);
  else { dirty = true; sendView(true); }
});
sizeCanvas();
connect();
setInterval(updatePanel, 100);
requestAnimationFrame(frame);

// A handle for measuring from outside: what is held, and a way to drop it all. The bench and
// the memory traces use this; nothing in the viewer itself does.
globalThis.p2 = {
  scene,
  held: () => ({ units: scene.units.size, bytes: scene.heldBytes, budget: scene.budget,
                 evicted: scene.evictions }),
  budget: (bytes) => { scene.budget = bytes; scene.evict(); dirty = true; },
  drop: () => { scene.clear(); dirty = true; },
};

const requested = new URLSearchParams(location.search).get('image');
if (requested) open(requested);
else { $('picker').hidden = false; showPicker(); }
