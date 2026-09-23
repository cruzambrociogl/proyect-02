// What the viewer holds and where it is looking. Drawing itself belongs to the renderer for
// the current image method (renderers.js), so this file is the same whether units are JPEG
// tiles or Gaussian splats.
//
// Three coordinate systems meet here:
//   source pixels  the original image's own pixels
//   unit pixels    at level L, one unit pixel is ratio^L source pixels
//   screen pixels  what the user sees; `scale` is source pixels per screen pixel
//
// Two rules keep the picture usable while data is still arriving:
//   - draw coarse levels first and finer ones over them, so the screen is never empty,
//     only soft, while the level it wants is loading;
//   - hold at most `budget` bytes of decoded units, dropping the least recently drawn - and
//     remember what was dropped, because the server has to be told or it will never send
//     those units again.

export class Scene {
  constructor(budgetBytes = 50 * 1024 * 1024) {
    this.budget = budgetBytes;
    this.chart = null;
    this.renderer = null;
    this.canvas = null;
    this.camera = { cx: 0, cy: 0, scale: 1 };
    this.units = new Map();          // "level/x_y" -> {level, x, y, handle, bytes, used}
    this.dropped = [];               // evicted since the last report to the server
    this.clock = 0;
    this.heldBytes = 0;
    this.evictions = 0;
    this.lastDrawn = 0;
    this.lastDrawMs = 0;
  }

  /** Start on a new image with the renderer its method needs. */
  start(chart, canvas, renderer) {
    this.clear();
    this.chart = chart;
    this.canvas = canvas;
    this.renderer = renderer;
    this.fit();
  }

  clear() {
    for (const unit of this.units.values()) this.renderer?.free(unit.handle);
    this.units.clear();
    this.dropped.length = 0;
    this.heldBytes = 0;
    this.evictions = 0;
  }

  touch() {
    return ++this.clock;
  }

  fit() {
    if (!this.chart) return;
    const { width, height } = this.chart;
    const scale = Math.max(width / this.canvas.width, height / this.canvas.height);
    this.camera = { cx: width / 2, cy: height / 2, scale };
    this.clamp();
  }

  // ------------------------------------------------------------------ geometry

  get maxScale() {
    if (!this.chart) return 1;
    return Math.max(this.chart.width / this.canvas.width, this.chart.height / this.canvas.height);
  }

  /** The level whose pixels are at least as fine as the screen: the coarsest such level. */
  level() {
    if (!this.chart) return 0;
    const l = Math.floor(Math.log(Math.max(this.camera.scale, 1e-9)) / Math.log(this.chart.ratio) + 1e-9);
    return Math.max(0, Math.min(this.chart.maxLevel, l));
  }

  levelScale(level) {
    return Math.pow(this.chart.ratio, level);
  }

  /** The part of the image on screen, in source pixels. */
  region() {
    const { cx, cy, scale } = this.camera;
    const w = this.canvas.width * scale;
    const h = this.canvas.height * scale;
    return { x: cx - w / 2, y: cy - h / 2, w, h };
  }

  /** Which units the current view needs, as keys. */
  wanted() {
    if (!this.chart) return [];
    const level = this.level();
    const ls = this.levelScale(level);
    const ts = this.chart.unitSize;
    const r = this.region();
    const lastCol = Math.ceil(Math.ceil(this.chart.width / ls) / ts) - 1;
    const lastRow = Math.ceil(Math.ceil(this.chart.height / ls) / ts) - 1;
    const x0 = Math.max(0, Math.floor(r.x / ls / ts));
    const y0 = Math.max(0, Math.floor(r.y / ls / ts));
    const x1 = Math.min(lastCol, Math.ceil((r.x + r.w) / ls / ts) - 1);
    const y1 = Math.min(lastRow, Math.ceil((r.y + r.h) / ls / ts) - 1);
    const keys = [];
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) keys.push(`${level}/${x}_${y}`);
    }
    return keys;
  }

  // ------------------------------------------------------------------ camera moves

  clamp() {
    if (!this.chart) return;
    const c = this.camera;
    c.scale = Math.min(Math.max(c.scale, 0.25), this.maxScale);
    const halfW = (this.canvas.width * c.scale) / 2;
    const halfH = (this.canvas.height * c.scale) / 2;
    c.cx = halfW * 2 >= this.chart.width ? this.chart.width / 2
      : Math.min(Math.max(c.cx, halfW), this.chart.width - halfW);
    c.cy = halfH * 2 >= this.chart.height ? this.chart.height / 2
      : Math.min(Math.max(c.cy, halfH), this.chart.height - halfH);
  }

  /** Zoom by `factor` while keeping the source point under the cursor in place. */
  zoomAt(screenX, screenY, factor) {
    const c = this.camera;
    const before = this.toSource(screenX, screenY);
    c.scale = Math.min(Math.max(c.scale * factor, 0.25), this.maxScale);
    const after = this.toSource(screenX, screenY);
    c.cx += before.x - after.x;
    c.cy += before.y - after.y;
    this.clamp();
  }

  panByScreen(dx, dy) {
    this.camera.cx -= dx * this.camera.scale;
    this.camera.cy -= dy * this.camera.scale;
    this.clamp();
  }

  toSource(screenX, screenY) {
    const r = this.region();
    return { x: r.x + screenX * this.camera.scale, y: r.y + screenY * this.camera.scale };
  }

  // ------------------------------------------------------------------ units

  has(key) {
    return this.units.has(key);
  }

  put(level, x, y, handle) {
    const key = `${level}/${x}_${y}`;
    const existing = this.units.get(key);
    if (existing) {
      this.renderer.free(existing.handle);
      this.heldBytes -= existing.bytes;
    }
    this.units.set(key, { level, x, y, handle, bytes: handle.bytes, used: this.touch() });
    this.heldBytes += handle.bytes;
    this.evict();
  }

  /** Drop least recently drawn units until the budget is met; the overview level stays. */
  evict() {
    if (this.heldBytes <= this.budget) return;
    const candidates = [...this.units.entries()]
      .filter(([, u]) => u.level !== this.chart?.maxLevel)
      .sort((a, b) => a[1].used - b[1].used);
    for (const [key, unit] of candidates) {
      if (this.heldBytes <= this.budget) break;
      this.renderer.free(unit.handle);
      this.units.delete(key);
      this.heldBytes -= unit.bytes;
      this.evictions++;
      this.dropped.push({ level: unit.level, x: unit.x, y: unit.y });
    }
  }

  /**
   * Hold less for a while - while nobody is looking at the tab, say. The budget itself is not
   * changed, so the next thing drawn fills the cache back up to it.
   */
  shrink(bytes) {
    const budget = this.budget;
    this.budget = bytes;
    this.evict();
    this.budget = budget;
  }

  /**
   * What has been evicted since the last call, to ride along with the next view message.
   *
   * Bounded, because a view message has to fit in one datagram: the protocol never splits a
   * message across packets, so a hundred dropped units is about what there is room for beside
   * the rest of the message. Whatever does not fit goes with the next view, a few tens of
   * milliseconds later - they are a stream, not an event.
   */
  takeDropped(limit = 100) {
    const out = this.dropped.slice(0, limit);
    this.dropped = this.dropped.slice(out.length);
    return out;
  }

  // ------------------------------------------------------------------ drawing

  draw() {
    if (!this.chart || !this.renderer) return;
    const started = performance.now();
    const level = this.level();
    const visible = [...this.units.values()]
      .filter((u) => u.level >= level)
      .sort((a, b) => b.level - a.level);      // coarse first, finer over the top
    this.lastDrawn = this.renderer.draw(this, visible);
    this.lastDrawMs = performance.now() - started;
  }
}
