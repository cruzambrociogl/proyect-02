// One viewer's session: what it is looking at, what it already has, what to send next.

import { readFileSync } from "node:fs";
import {
  Type, KIND_SPLAT, KIND_TILE, decodeReport, decodeView, encode, unitKey,
  type Message, type UnitId, type View,
} from "../shared/wire.ts";
import { confetti, readSpx, tileParts, type Packets } from "../shared/units.ts";
import type { PreparedImage } from "./image.ts";
import { RunAndTumble } from "./tumble.ts";

/** How long a unit waits after its last packet before an idle link may send it again. */
export const TOPUP_WAIT_MS = 400;
/** Resends of one unit, at most, while it stays on screen (the base unit has no limit). */
const MAX_TOPUPS = 4;

/**
 * Packets of units, prepared once and shared by every session: the second viewer of a unit
 * costs no disk read and no packetising. Least recently used units go first over the budget.
 */
export class PacketCache {
  private units = new Map<string, Packets>();
  private bytes = 0;
  hits = 0;
  misses = 0;
  private budget: number;

  constructor(budget = 128 * 2 ** 20) {
    this.budget = budget;
  }

  packets(image: PreparedImage, u: UnitId): Packets {
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
    const size = (p: Packets) => p.packets.reduce((s, b) => s + b.length, 0);
    this.units.set(key, made);
    this.bytes += size(made);
    for (const [k, v] of this.units) {
      if (this.bytes <= this.budget) break;
      this.units.delete(k);
      this.bytes -= size(v);
    }
    return made;
  }
}

function build(image: PreparedImage, u: UnitId): Packets {
  if (u.kind === KIND_SPLAT) return confetti(u.level, u.x, u.y, readSpx(image.splatPath(u.level, u.x, u.y)));
  const file = image.tileFile(u.level, u.x, u.y);
  if (!file) return { packets: [], ends: [0] };
  return tileParts(u.level, u.x, u.y, file.format, readFileSync(file.path));
}

export interface Peer {
  address: string;
  port: number;
}

/** A piece of work: chunk `chunk` of a unit (an image tile has one chunk). */
interface Job {
  id: UnitId;
  chunk: number;
}

/** What a unit has been sent, and how much of that arrived. */
interface UnitState {
  id: UnitId;
  sentUpTo: number;      // packets [0, sentUpTo) have been sent at least once
  chunksSent: number;
  got: number;           // the client's count
  lastSend: number;
  topups: number;
}

export class Session {
  epoch = 0;
  image: PreparedImage | null = null;
  view: View | null = null;
  lastHeard = Date.now();
  private units = new Map<string, UnitState>();
  private wanted = new Set<string>();    // every unit the current view needs
  private queue: Job[] = [];
  private current: Buffer[] = [];        // packets being sent
  private currentAt = 0;
  private currentType: typeof Type.CONFETTI | typeof Type.TILEPART = Type.CONFETTI;
  private currentState: UnitState | null = null;
  private repairing = false;
  // counters, for STATS
  packetsSent = 0;
  bytesSent = 0;
  unitsSent = 0;
  viewsSeen = 0;
  cancelled = 0;
  topupPackets = 0;
  topupBytes = 0;
  reported = { packets: 0, bytes: 0 };
  /** How fast to send to this client; the server's pacing gives it `rate` bytes per second. */
  readonly rc: RunAndTumble;
  tokens = 0;

  readonly peer: Peer;
  readonly send: (msg: Buffer) => void;
  private images: Map<string, PreparedImage>;
  private cache: PacketCache;

  constructor(peer: Peer, images: Map<string, PreparedImage>, cache: PacketCache,
              send: (msg: Buffer) => void, maxRate: number) {
    this.rc = new RunAndTumble(maxRate);
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
        for (const u of v.dropped) this.units.delete(unitKey(u));
        if (m.epoch < this.epoch) return;          // an older view overtook a newer one
        this.epoch = m.epoch;
        this.view = v;
        this.viewsSeen++;
        const all = this.image.unitsFor(v);
        this.wanted = new Set(all.map(unitKey));
        this.cancelled += this.queue.length;
        this.queue = this.plan(all);
        break;
      }
      case Type.REPORT: {
        const r = decodeReport(m.payload);
        this.reported = { packets: r.packets, bytes: r.bytes };
        this.rc.onReport(r);
        for (const c of r.units) {
          const s = this.units.get(unitKey(c));
          if (s) s.got = Math.max(s.got, c.got);
        }
        break;
      }
      case Type.BYE:
        this.reset();
        break;
    }
  }

  /**
   * The order of work for a view: the most important chunk of every splat unit on screen
   * first (coarse levels first), so something is drawn everywhere as early as possible; then
   * the image tiles, if the zoom wants them; then the rest of the splats' chunks, round by
   * round. When tiles are wanted they cover the splats, so the splats' later chunks only
   * matter as the placeholder for the next move, and wait behind the tiles.
   */
  private plan(all: UnitId[]): Job[] {
    const done = (u: UnitId) => this.units.get(unitKey(u))?.chunksSent ?? 0;
    const splats = all.filter((u) => u.kind === KIND_SPLAT);
    const tiles = all.filter((u) => u.kind === KIND_TILE && done(u) === 0);
    const first = splats.filter((u) => done(u) === 0).map((id) => ({ id, chunk: 0 }));
    const rest: Job[] = [];
    for (let chunk = 1; chunk < 4; chunk++) {
      for (const id of splats) if (done(id) <= chunk) rest.push({ id, chunk });
    }
    return [...first, ...tiles.map((id) => ({ id, chunk: 0 })), ...rest];
  }

  private reset(): void {
    this.image = null;
    this.view = null;
    this.units.clear();
    this.wanted.clear();
    this.queue = [];
    this.current = [];
    this.currentAt = 0;
    this.currentState = null;
  }

  /**
   * Send up to `budget` bytes, most important first. Returns the bytes sent.
   *
   * Lost confetti packets are not resent straight away: the next unit (or the next chunk of
   * detail) is worth more than a repeat. Only when nothing new is waiting does the link go
   * back to units still on screen whose reported count is short, and send them again; the
   * client drops the packets it already has. Repair only ever uses capacity nothing else
   * wanted, except for the base unit (see nextWork).
   */
  pump(budget: number): number {
    let spent = 0;
    while (spent < budget) {
      if (this.currentAt >= this.current.length && !this.nextWork()) break;
      const payload = this.current[this.currentAt++];
      const msg = encode(this.currentType, this.epoch, payload);
      this.send(msg);
      spent += msg.length;
      this.rc.sent();
      this.packetsSent++;
      this.bytesSent += msg.length;
      if (this.repairing) {
        this.topupPackets++;
        this.topupBytes += msg.length;
      }
      if (this.currentAt >= this.current.length && this.currentState) this.currentState.lastSend = performance.now();
    }
    return spent;
  }

  /**
   * Load the next packets to send, in this order:
   *   1. a repair of the base unit, if it is short: every other level is drawn on top of
   *      it, and unlike the detail levels it is not fitted to shrug off missing blobs (see
   *      splatpyr/fit.py, loss_aware)
   *   2. new work: the first chunk of every splat unit, then the image tiles
   *   3. a repair of an image tile: a tile missing one part cannot be decoded at all, so it
   *      comes before the splats' later chunks, which the tiles cover anyway
   *   4. the splats' later chunks
   *   5. a repair of any other unit still on screen
   */
  private nextWork(): boolean {
    if (!this.image) return false;
    const now = performance.now();
    for (const [key, s] of this.units) {
      if (this.isBase(s.id) && this.repairDue(key, s, now)) return this.repair(s);
    }
    for (let job = this.queue.shift(); job; job = this.queue.shift()) {
      if (job.chunk >= 1) {
        for (const [key, s] of this.units) {
          if (s.id.kind === KIND_TILE && this.repairDue(key, s, now)) {
            this.queue.unshift(job);
            return this.repair(s);
          }
        }
      }
      const p = this.cache.packets(this.image, job.id);
      if (job.chunk >= p.ends.length) continue;          // a small unit has fewer chunks
      const key = unitKey(job.id);
      let s = this.units.get(key);
      if (!s) {
        s = { id: job.id, sentUpTo: 0, chunksSent: 0, got: 0, lastSend: now, topups: 0 };
        this.units.set(key, s);
      }
      if (s.chunksSent > job.chunk) continue;
      // everything up to the end of this chunk that has not gone yet
      const to = p.ends[job.chunk];
      if (s.sentUpTo === 0) this.unitsSent++;
      this.start(job.id, p.packets.slice(s.sentUpTo, to), s, false);
      s.sentUpTo = to;
      s.chunksSent = job.chunk + 1;
      return true;
    }
    for (const [key, s] of this.units) if (this.repairDue(key, s, now)) return this.repair(s);
    return false;
  }

  /** Send again everything the unit was sent; the client drops what it already has. */
  private repair(s: UnitState): boolean {
    s.topups++;
    const p = this.cache.packets(this.image!, s.id);
    this.start(s.id, p.packets.slice(0, s.sentUpTo), s, true);
    return true;
  }

  private start(id: UnitId, packets: Buffer[], s: UnitState, repairing: boolean): void {
    this.current = packets;
    this.currentAt = 0;
    this.currentType = id.kind === KIND_SPLAT ? Type.CONFETTI : Type.TILEPART;
    this.currentState = s;
    this.repairing = repairing;
  }

  private isBase(id: UnitId): boolean {
    return id.kind === KIND_SPLAT && id.level === this.image?.chart.maxLevel;
  }

  private repairDue(key: string, s: UnitState, now: number): boolean {
    return s.got < s.sentUpTo && now - s.lastSend > TOPUP_WAIT_MS
      && (this.isBase(s.id) || (s.topups < MAX_TOPUPS && this.wanted.has(key)));
  }

  /** Nothing to send now: no packets left, no work queued, nothing due for repair. */
  get idle(): boolean {
    if (this.currentAt < this.current.length || this.queue.length > 0) return false;
    const now = performance.now();
    for (const [key, s] of this.units) if (this.repairDue(key, s, now)) return false;
    return true;
  }

  stats(rate: number): Record<string, unknown> {
    return { epoch: this.epoch, views: this.viewsSeen, queued: this.queue.length,
             unitsSent: this.unitsSent, packetsSent: this.packetsSent, bytesSent: this.bytesSent,
             cancelled: this.cancelled, topupPackets: this.topupPackets, topupBytes: this.topupBytes,
             reported: this.reported, rate, control: this.rc.stats() };
  }
}
