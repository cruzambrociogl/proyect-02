// The viewer's cache policy: an Abelian sandpile (Bak-Tang-Wiesenfeld, with Dhar's result that
// the order of topplings does not matter).
//
// Every unit the viewer holds (a splat unit or an image tile) is a site of a graph. Its
// neighbours are the units next to it on the same level (4), the unit above it (the coarser
// one it rests on) and the units below it (the finer ones resting on it); only held units
// count. A site topples when its pile reaches its number of neighbours: it gives one grain to
// each. Grains that would go to a unit not held fall off the edge (the sink).
//
// Every frame drops grains on the units on screen, in proportion to the screen they cover.
// Topplings then carry that attention outward: to the neighbours a pan would reach next, and
// up to the coarser units every view of the area rests on, which gather grains from all their
// children and so outlast any single fine unit.
//
// What a unit has earned is its activity: how many grains have passed through it, fading with
// a half-life, so an area left long ago is forgotten. Over the memory budget, the units with
// the least activity per byte go first. The base unit (the top level) is never evicted.
//
// The Abelian property is what makes this testable: however the grains of a frame are
// processed, the stable state and the topplings are the same, so the cache after a sequence
// of views does not depend on timing.

export interface Site {
  key: string;
  kind: number;
  level: number;
  x: number;
  y: number;
  bytes: number;
}

interface Pile extends Site {
  grains: number;
  activity: number;      // grains that passed through, fading
  seen: number;          // ms, for the fade
}

const GRAINS_PER_FRAME = 64;      // spread over the units on screen by their coverage
const HALF_LIFE_MS = 8000;
const MAX_TOPPLINGS = 20_000;     // per frame, a guard; a finite graph with a sink always settles

export class SandpileCache {
  budget: number;
  private piles = new Map<string, Pile>();
  private bytes = 0;
  topplings = 0;
  evictions = 0;
  private readonly topLevel: number;

  constructor(budget: number, topLevel: number) {
    this.budget = budget;
    this.topLevel = topLevel;
  }

  get held(): number { return this.bytes; }
  get size(): number { return this.piles.size; }
  has(key: string): boolean { return this.piles.has(key); }

  add(site: Site, now: number): void {
    const old = this.piles.get(site.key);
    if (old) this.bytes -= old.bytes;
    this.piles.set(site.key, { ...site, grains: old?.grains ?? 0, activity: old?.activity ?? 1, seen: now });
    this.bytes += site.bytes;
  }

  /** A unit's size changed (more of its packets arrived). */
  resize(key: string, bytes: number): void {
    const p = this.piles.get(key);
    if (!p) return;
    this.bytes += bytes - p.bytes;
    p.bytes = bytes;
  }

  remove(key: string): void {
    const p = this.piles.get(key);
    if (!p) return;
    this.bytes -= p.bytes;
    this.piles.delete(key);
  }

  /** Neighbours of a site that are held: same level 4-around, the parent, the children. */
  private neighbours(p: Pile): Pile[] {
    const out: Pile[] = [];
    const at = (kind: number, level: number, x: number, y: number) => {
      const n = this.piles.get(`${kind}/${level}/${x}/${y}`);
      if (n) out.push(n);
    };
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) at(p.kind, p.level, p.x + dx, p.y + dy);
    // the parent and children may be of the other kind across the split (tiles rest on splats)
    for (const kind of [0, 1]) {
      at(kind, p.level + 1, p.x >> 1, p.y >> 1);
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) at(kind, p.level - 1, 2 * p.x + dx, 2 * p.y + dy);
    }
    return out;
  }

  private degree(p: Pile): number {
    return 4 + 1 + 4;            // every possible neighbour: missing ones are the sink
  }

  /**
   * One frame: grains dropped on the units on screen (`coverage`: key -> fraction of the
   * screen), topplings until stable, then evictions if over budget. Returns the keys evicted.
   */
  frame(coverage: Map<string, number>, now: number): string[] {
    const unstable: Pile[] = [];
    for (const [key, share] of coverage) {
      const p = this.piles.get(key);
      if (!p) continue;
      p.seen = now;
      p.grains += Math.max(1, Math.round(share * GRAINS_PER_FRAME));
      if (p.grains >= this.degree(p)) unstable.push(p);
    }
    let n = 0;
    while (unstable.length && n < MAX_TOPPLINGS) {
      const p = unstable.pop()!;
      const d = this.degree(p);
      while (p.grains >= d && n < MAX_TOPPLINGS) {
        p.grains -= d;
        p.activity += d;
        n++;
        for (const q of this.neighbours(p)) {
          q.grains += 1;
          if (q.grains === this.degree(q)) unstable.push(q);
        }
      }
    }
    this.topplings += n;
    return this.bytes > this.budget ? this.evict(now, coverage) : [];
  }

  private fade(p: Pile, now: number): number {
    return p.activity * 0.5 ** ((now - p.seen) / HALF_LIFE_MS);
  }

  /** Least activity per byte first; never the base unit, never a unit on screen now. */
  private evict(now: number, onScreen: Map<string, number>): string[] {
    const candidates = [...this.piles.values()]
      .filter((p) => p.level !== this.topLevel && !onScreen.has(p.key))
      .sort((a, b) => this.fade(a, now) / Math.max(1, a.bytes) - this.fade(b, now) / Math.max(1, b.bytes));
    const out: string[] = [];
    for (const p of candidates) {
      if (this.bytes <= this.budget * 0.9) break;
      this.remove(p.key);
      out.push(p.key);
      this.evictions++;
    }
    return out;
  }
}

/** The plain policy, for comparison: least recently on screen first. */
export class LruCache {
  budget: number;
  private items = new Map<string, Site & { seen: number }>();
  private bytes = 0;
  evictions = 0;
  private readonly topLevel: number;

  constructor(budget: number, topLevel: number) {
    this.budget = budget;
    this.topLevel = topLevel;
  }

  get held(): number { return this.bytes; }
  get size(): number { return this.items.size; }
  has(key: string): boolean { return this.items.has(key); }
  add(site: Site, now: number): void {
    const old = this.items.get(site.key);
    if (old) this.bytes -= old.bytes;
    this.items.set(site.key, { ...site, seen: now });
    this.bytes += site.bytes;
  }
  resize(key: string, bytes: number): void {
    const p = this.items.get(key);
    if (!p) return;
    this.bytes += bytes - p.bytes;
    p.bytes = bytes;
  }
  remove(key: string): void {
    const p = this.items.get(key);
    if (!p) return;
    this.bytes -= p.bytes;
    this.items.delete(key);
  }
  frame(coverage: Map<string, number>, now: number): string[] {
    for (const key of coverage.keys()) { const p = this.items.get(key); if (p) p.seen = now; }
    if (this.bytes <= this.budget) return [];
    const out: string[] = [];
    for (const p of [...this.items.values()].sort((a, b) => a.seen - b.seen)) {
      if (this.bytes <= this.budget * 0.9) break;
      if (p.level === this.topLevel || coverage.has(p.key)) continue;
      this.remove(p.key);
      out.push(p.key);
      this.evictions++;
    }
    return out;
  }
}
