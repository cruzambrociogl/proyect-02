// A prepared image (the output of splatpyr ingest + build) and what a view of it needs.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { KIND_SPLAT, KIND_TILE, type UnitId, type View } from "../shared/wire.ts";
import { FORMAT_JPEG, FORMAT_WEBP } from "../shared/units.ts";

export interface Chart {
  name: string;
  width: number;
  height: number;
  tile: number;
  maxLevel: number;
  split: number;       // levels split..maxLevel are splats, below are image tiles
}

export class PreparedImage {
  readonly chart: Chart;
  readonly dir: string;

  constructor(dir: string, name: string) {
    this.dir = dir;
    const meta = JSON.parse(readFileSync(join(dir, "pyramid.json"), "utf8"));
    // images ingested before splits existed keep theirs in manifest.json
    let split = meta.split;
    if (split === undefined && existsSync(join(dir, "manifest.json"))) {
      split = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")).split;
    }
    this.chart = { name, width: meta.width, height: meta.height, tile: meta.tile,
                   maxLevel: meta.max_level, split: split ?? 0 };
  }

  levelSize(level: number): [number, number] {
    return [Math.ceil(this.chart.width / 2 ** level), Math.ceil(this.chart.height / 2 ** level)];
  }

  grid(level: number): [number, number] {
    const [w, h] = this.levelSize(level);
    return [Math.ceil(w / this.chart.tile), Math.ceil(h / this.chart.tile)];
  }

  unitSize(level: number, x: number, y: number): [number, number] {
    const [w, h] = this.levelSize(level), T = this.chart.tile;
    return [Math.min(T, w - x * T), Math.min(T, h - y * T)];
  }

  splatPath(level: number, x: number, y: number): string {
    return join(this.dir, "splats", String(level), `${x}_${y}.spx`);
  }

  /** The tile's file and format, whichever format ingest kept it in. */
  tileFile(level: number, x: number, y: number): { path: string; format: number } | null {
    for (const [ext, format] of [["webp", FORMAT_WEBP], ["jpg", FORMAT_JPEG]] as const) {
      const path = join(this.dir, "tiles", String(level), `${x}_${y}.${ext}`);
      if (existsSync(path)) return { path, format };
    }
    return null;
  }

  /**
   * The units a view needs, most important first. The same rule the viewer draws by:
   * splat units from the top level down to the level the zoom wants (never below the
   * split), each only under a unit of the level above; then, if the zoom wants a level
   * below the split, that level's image tiles. Splats come first (coarse to fine) because
   * they are the placeholder the tiles land on; within a level, nearest the centre first.
   */
  unitsFor(v: View): UnitId[] {
    const c = this.chart, T = c.tile;
    const finest = Math.max(0, Math.min(c.maxLevel, Math.floor(Math.log2(Math.max(v.scale, 1e-9)))));
    const X0 = v.cx - (v.screenW * v.scale) / 2, X1 = v.cx + (v.screenW * v.scale) / 2;
    const Y0 = v.cy - (v.screenH * v.scale) / 2, Y1 = v.cy + (v.screenH * v.scale) / 2;
    const distance = (level: number, x: number, y: number) => {
      const span = T * 2 ** level;
      return Math.hypot((x + 0.5) * span - v.cx, (y + 0.5) * span - v.cy);
    };
    const byLevel = new Map<number, UnitId[]>();

    const visit = (level: number, x: number, y: number) => {
      const s = 2 ** level;
      const [w, h] = this.unitSize(level, x, y);
      if ((x * T + w) * s < X0 || (y * T + h) * s < Y0 || x * T * s > X1 || y * T * s > Y1) return;
      if (!byLevel.has(level)) byLevel.set(level, []);
      byLevel.get(level)!.push({ kind: KIND_SPLAT, level, x, y });
      if (level > Math.max(finest, c.split)) {
        const [cols, rows] = this.grid(level - 1);
        for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
          if (2 * x + dx < cols && 2 * y + dy < rows) visit(level - 1, 2 * x + dx, 2 * y + dy);
        }
      }
    };
    visit(c.maxLevel, 0, 0);

    const out: UnitId[] = [];
    for (const level of [...byLevel.keys()].sort((a, b) => b - a)) {
      out.push(...byLevel.get(level)!.sort((a, b) => distance(level, a.x, a.y) - distance(level, b.x, b.y)));
    }
    if (finest < c.split) {
      const span = T * 2 ** finest, [cols, rows] = this.grid(finest);
      const tiles: UnitId[] = [];
      for (let y = Math.max(0, Math.floor(Y0 / span)); y <= Math.min(rows - 1, Math.floor(Y1 / span)); y++) {
        for (let x = Math.max(0, Math.floor(X0 / span)); x <= Math.min(cols - 1, Math.floor(X1 / span)); x++) {
          tiles.push({ kind: KIND_TILE, level: finest, x, y });
        }
      }
      out.push(...tiles.sort((a, b) => distance(finest, a.x, a.y) - distance(finest, b.x, b.y)));
    }
    return out;
  }
}

/** Every prepared image under a folder: each subfolder with a pyramid.json. */
export function findImages(root: string): Map<string, PreparedImage> {
  const found = new Map<string, PreparedImage>();
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    if (existsSync(join(dir, "pyramid.json")) && existsSync(join(dir, "splats"))) {
      found.set(name, new PreparedImage(dir, name));
    }
  }
  return found;
}
