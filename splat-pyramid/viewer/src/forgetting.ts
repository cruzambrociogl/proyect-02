// The viewer's cache policy: Ebbinghaus's forgetting curve, as spaced-repetition software
// uses it.
//
// Every unit the viewer holds (a splat unit or an image tile) is a memory. Its retention
// fades with time since it was last on screen, R = exp(-t / S), where S is its stability.
// Being on screen is a review. Continuous viewing just keeps R at 1; coming back after being
// away is a spaced review, and it makes the memory more stable. The more had been forgotten
// by then (the lower R), the larger the gain: this is the spacing effect. So a unit the user
// keeps coming back to outlasts one seen once, even if that one was seen more recently.
//
// A first sight starts at a stability that doubles with each level up: a coarse unit sits
// under every view of its area, so it is the one most likely to be needed again.
//
// Over the memory budget, the units with the least retention per byte go first: a big fine
// tile that is half forgotten is worth less than a small splat unit in the same state. The
// base unit (the top level) and what is on screen now are never evicted.
//
// (Tried and left out: associative recall, where a review also partly reviews the coarser
// unit and the neighbours. It measured neutral in bench/cache.ts.)

import type { Site } from "./sandpile.js";

interface Memory extends Site {
  stability: number;     // ms: retention falls to 1/e after this long unseen
  seen: number;          // ms, last on screen
  reviews: number;
}

const FIRST_MS = 4000;            // stability of a finest-level unit seen once
const LEVEL_GAIN = 2;             // each level coarser starts this much more stable
const REVIEW_GAP_MS = 300;        // off screen longer than this, then back: a review
const SPACING_GAIN = 3;           // stability grows by up to 1 + this, the more was forgotten

export class ForgettingCache {
  budget: number;
  private memories = new Map<string, Memory>();
  private bytes = 0;
  evictions = 0;
  reviews = 0;
  private readonly topLevel: number;

  constructor(budget: number, topLevel: number) {
    this.budget = budget;
    this.topLevel = topLevel;
  }

  get held(): number { return this.bytes; }
  get size(): number { return this.memories.size; }
  has(key: string): boolean { return this.memories.has(key); }

  add(site: Site, now: number): void {
    const old = this.memories.get(site.key);
    if (old) this.bytes -= old.bytes;
    this.memories.set(site.key, { ...site, stability: old?.stability ?? FIRST_MS * LEVEL_GAIN ** site.level,
                                  seen: now, reviews: old?.reviews ?? 0 });
    this.bytes += site.bytes;
  }

  /** A unit's size changed (more of its packets arrived). */
  resize(key: string, bytes: number): void {
    const m = this.memories.get(key);
    if (!m) return;
    this.bytes += bytes - m.bytes;
    m.bytes = bytes;
  }

  remove(key: string): void {
    const m = this.memories.get(key);
    if (!m) return;
    this.bytes -= m.bytes;
    this.memories.delete(key);
  }

  private retention(m: Memory, now: number): number {
    return Math.exp(-(now - m.seen) / m.stability);
  }

  /**
   * One frame: the units on screen (`coverage`: key -> fraction of the screen) are reviewed,
   * then evictions if over budget. Returns the keys evicted.
   */
  frame(coverage: Map<string, number>, now: number): string[] {
    for (const key of coverage.keys()) {
      const m = this.memories.get(key);
      if (!m) continue;
      if (now - m.seen > REVIEW_GAP_MS) {
        m.stability *= 1 + SPACING_GAIN * (1 - this.retention(m, now));
        m.reviews++;
        this.reviews++;
      }
      m.seen = now;
    }
    return this.bytes > this.budget ? this.evict(now, coverage) : [];
  }

  /** Least retention per byte first; never the base unit, never a unit on screen now. */
  private evict(now: number, onScreen: Map<string, number>): string[] {
    const candidates = [...this.memories.values()]
      .filter((m) => m.level !== this.topLevel && !onScreen.has(m.key))
      .map((m) => ({ m, worth: this.retention(m, now) / Math.max(1, m.bytes) }))
      .sort((a, b) => a.worth - b.worth);
    const out: string[] = [];
    for (const { m } of candidates) {
      if (this.bytes <= this.budget * 0.9) break;
      this.remove(m.key);
      out.push(m.key);
      this.evictions++;
    }
    return out;
  }
}
