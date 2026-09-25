// One viewer's session: what it is looking at, what it already holds, what to send next.

import { readFileSync } from "node:fs";
import {
  Type, KIND_SPLAT, decodeReport, decodeView, encode, unitKey,
  type Message, type UnitId, type View,
} from "../shared/wire.ts";
import { confetti, readSpx, tileParts } from "../shared/units.ts";
import type { PreparedImage } from "./image.ts";

/**
 * Packets of units, prepared once and shared by every session: the second viewer of a unit
 * costs no disk read and no packetising. Least recently used units go first over the budget.
 */
export class PacketCache {
  private units = new Map<string, Buffer[]>();
  private bytes = 0;
  hits = 0;
  misses = 0;
  private budget: number;

  constructor(budget = 128 * 2 ** 20) {
    this.budget = budget;
  }

  packets(image: PreparedImage, u: UnitId): Buffer[] {
    const key = `${image.chart.name}/${unitKey(u)}`;
    const found = this.units.get(key);
    if (found) {
      this.units.delete(key);
      this.units.set(key, found);
      this.hits++;
      return found;
    }
    this.misses++;
    const made = build(image, u);
    this.units.set(key, made);
    this.bytes += made.reduce((s, p) => s + p.length, 0);
    for (const [k, v] of this.units) {
      if (this.bytes <= this.budget) break;
      this.units.delete(k);
      this.bytes -= v.reduce((s, p) => s + p.length, 0);
    }
    return made;
  }
}

function build(image: PreparedImage, u: UnitId): Buffer[] {
  if (u.kind === KIND_SPLAT) return confetti(u.level, u.x, u.y, readSpx(image.splatPath(u.level, u.x, u.y)));
  const file = image.tileFile(u.level, u.x, u.y);
  if (!file) return [];
  return tileParts(u.level, u.x, u.y, file.format, readFileSync(file.path));
}

export interface Peer {
  address: string;
  port: number;
}

export class Session {
  epoch = 0;
  image: PreparedImage | null = null;
  view: View | null = null;
  lastHeard = Date.now();
  private held = new Set<string>();      // units the viewer has (or is being sent) in full
  private queue: UnitId[] = [];
  private current: Buffer[] = [];        // packets of the unit being sent
  private currentAt = 0;
  private currentType: typeof Type.CONFETTI | typeof Type.TILEPART = Type.CONFETTI;
  // counters, for STATS
  packetsSent = 0;
  bytesSent = 0;
  unitsSent = 0;
  viewsSeen = 0;
  cancelled = 0;
  reported = { packets: 0, bytes: 0 };

  readonly peer: Peer;
  readonly send: (msg: Buffer) => void;
  private images: Map<string, PreparedImage>;
  private cache: PacketCache;

  constructor(peer: Peer, images: Map<string, PreparedImage>, cache: PacketCache,
              send: (msg: Buffer) => void) {
    this.peer = peer;
    this.images = images;
    this.cache = cache;
    this.send = send;
  }

  onMessage(m: Message): void {
    this.lastHeard = Date.now();
    switch (m.type) {
      case Type.HELLO:
        this.reset();
        this.send(encode(Type.WELCOME, 0));
        break;
      case Type.OPEN: {
        const name = m.payload.toString("utf8");
        const image = this.images.get(name);
        if (!image) {
          this.send(encode(Type.FAULT, m.epoch, Buffer.from(
            `no image "${name}"; there is: ${[...this.images.keys()].join(", ")}`)));
          return;
        }
        this.reset();
        this.image = image;
        this.send(encode(Type.CHART, m.epoch, Buffer.from(JSON.stringify(image.chart))));
        break;
      }
      case Type.VIEW: {
        if (!this.image) return;
        const v = decodeView(m.payload);
        for (const u of v.dropped) this.held.delete(unitKey(u));
        if (m.epoch < this.epoch) return;          // an older view overtook a newer one
        this.epoch = m.epoch;
        this.view = v;
        this.viewsSeen++;
        const wanted = this.image.unitsFor(v).filter((u) => !this.held.has(unitKey(u)));
        this.cancelled += Math.max(0, this.queue.length);
        this.queue = wanted;
        break;
      }
      case Type.REPORT:
        this.reported = decodeReport(m.payload);
        break;
      case Type.BYE:
        this.reset();
        break;
    }
  }

  private reset(): void {
    this.image = null;
    this.view = null;
    this.held.clear();
    this.queue = [];
    this.current = [];
    this.currentAt = 0;
  }

  /** Send up to `budget` bytes, most important first. Returns the bytes sent. */
  pump(budget: number): number {
    let spent = 0;
    while (spent < budget) {
      if (this.currentAt >= this.current.length) {
        const next = this.queue.shift();
        if (!next || !this.image) break;
        const key = unitKey(next);
        if (this.held.has(key)) continue;
        this.current = this.cache.packets(this.image, next);
        this.currentAt = 0;
        this.currentType = next.kind === KIND_SPLAT ? Type.CONFETTI : Type.TILEPART;
        this.held.add(key);
        this.unitsSent++;
      }
      const payload = this.current[this.currentAt++];
      const msg = encode(this.currentType, this.epoch, payload);
      this.send(msg);
      spent += msg.length;
      this.packetsSent++;
      this.bytesSent += msg.length;
    }
    return spent;
  }

  get idle(): boolean {
    return this.currentAt >= this.current.length && this.queue.length === 0;
  }

  stats(rate: number): Record<string, unknown> {
    return { epoch: this.epoch, views: this.viewsSeen, queued: this.queue.length,
             unitsSent: this.unitsSent, packetsSent: this.packetsSent, bytesSent: this.bytesSent,
             cancelled: this.cancelled, reported: this.reported, rate };
  }
}
