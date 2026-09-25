// One viewer's session: what it is looking at, what it already holds, what to send next.

import { readFileSync } from "node:fs";
import {
  Type, KIND_SPLAT, decodeReport, decodeView, encode, unitKey,
  type Message, type UnitId, type View,
} from "../shared/wire.ts";
import { confetti, readSpx, tileParts } from "../shared/units.ts";
import type { PreparedImage } from "./image.ts";

/** How long a unit waits after its last packet before an idle link may send it again. */
export const TOPUP_WAIT_MS = 400;
/** Resends of one unit, at most, while it stays on screen. */
const MAX_TOPUPS = 4;

interface Sent { id: UnitId; total: number; got: number; lastSend: number; topups: number }

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
  private held = new Set<string>();      // units the viewer has, or has been sent
  private sent = new Map<string, Sent>(); // what was sent and how much of it arrived
  private wanted = new Set<string>();    // every unit the current view needs, held or not
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
  topupPackets = 0;
  topupBytes = 0;
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
        for (const u of v.dropped) {
          this.held.delete(unitKey(u));
          this.sent.delete(unitKey(u));
        }
        if (m.epoch < this.epoch) return;          // an older view overtook a newer one
        this.epoch = m.epoch;
        this.view = v;
        this.viewsSeen++;
        const all = this.image.unitsFor(v);
        this.wanted = new Set(all.map(unitKey));
        this.cancelled += Math.max(0, this.queue.length);
        this.queue = all.filter((u) => !this.held.has(unitKey(u)));
        break;
      }
      case Type.REPORT: {
        const r = decodeReport(m.payload);
        this.reported = { packets: r.packets, bytes: r.bytes };
        for (const c of r.units) {
          const s = this.sent.get(unitKey(c));
          if (s) s.got = Math.max(s.got, c.got);
        }
        break;
      }
      case Type.BYE:
        this.reset();
        break;
    }
  }

  private reset(): void {
    this.image = null;
    this.view = null;
    this.held.clear();
    this.sent.clear();
    this.wanted.clear();
    this.queue = [];
    this.current = [];
    this.currentAt = 0;
  }

  /**
   * Send up to `budget` bytes, most important first. Returns the bytes sent.
   *
   * Lost confetti packets are not resent straight away: the next unit (or the next chunk of
   * detail) is worth more than a repeat. Only when nothing new is waiting does the link go
   * back to units still on screen whose reported count is short, and send them again; the
   * client drops the packets it already has. Repair only ever uses capacity nothing else
   * wanted.
   */
  pump(budget: number): number {
    let spent = 0;
    while (spent < budget) {
      if (this.currentAt >= this.current.length && !this.nextUnit()) break;
      const payload = this.current[this.currentAt++];
      const msg = encode(this.currentType, this.epoch, payload);
      this.send(msg);
      spent += msg.length;
      this.packetsSent++;
      this.bytesSent += msg.length;
      if (this.topup) {
        this.topupPackets++;
        this.topupBytes += msg.length;
      }
      if (this.currentAt >= this.current.length && this.currentSent) this.currentSent.lastSend = performance.now();
    }
    return spent;
  }

  private topup = false;
  private currentSent: Sent | null = null;

  /** Load the next unit's packets: something new if anything is waiting, else a repair. */
  private nextUnit(): boolean {
    if (!this.image) return false;
    for (let next = this.queue.shift(); next; next = this.queue.shift()) {
      const key = unitKey(next);
      if (this.held.has(key)) continue;
      this.load(next, false);
      this.held.add(key);
      this.unitsSent++;
      return true;
    }
    const now = performance.now();
    for (const [key, s] of this.sent) {
      if (s.got < s.total && s.topups < MAX_TOPUPS && this.wanted.has(key) && now - s.lastSend > TOPUP_WAIT_MS) {
        s.topups++;
        this.load(s.id, true);
        return true;
      }
    }
    return false;
  }

  private load(id: UnitId, topup: boolean): void {
    this.current = this.cache.packets(this.image!, id);
    this.currentAt = 0;
    this.currentType = id.kind === KIND_SPLAT ? Type.CONFETTI : Type.TILEPART;
    this.topup = topup;
    const key = unitKey(id);
    let s = this.sent.get(key);
    if (!s) {
      s = { id, total: this.current.length, got: 0, lastSend: performance.now(), topups: 0 };
      this.sent.set(key, s);
    }
    this.currentSent = s;
  }

  /** Nothing to send now: no packets left, nothing queued, nothing due for repair. */
  get idle(): boolean {
    if (this.currentAt < this.current.length || this.queue.length > 0) return false;
    const now = performance.now();
    for (const [key, s] of this.sent) {
      if (s.got < s.total && s.topups < MAX_TOPUPS && this.wanted.has(key) && now - s.lastSend > TOPUP_WAIT_MS) return false;
    }
    return true;
  }

  stats(rate: number): Record<string, unknown> {
    return { epoch: this.epoch, views: this.viewsSeen, queued: this.queue.length,
             unitsSent: this.unitsSent, packetsSent: this.packetsSent, bytesSent: this.bytesSent,
             cancelled: this.cancelled, topupPackets: this.topupPackets, topupBytes: this.topupBytes,
             reported: this.reported, rate };
  }
}
