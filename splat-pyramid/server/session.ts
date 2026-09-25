// One viewer's session: what it is looking at, what it already has, what to send next.

import { readFileSync } from "node:fs";
import {
  Type, KIND_SPLAT, KIND_TILE, decodeReport, decodeView, encode, encodeRepair, unitKey,
  type Message, type UnitId, type View,
} from "../shared/wire.ts";
import { WIDTH_SPLAT, WIDTH_TILE, confetti, readSpx, tileParts, type Packets } from "../shared/units.ts";
import { frame, repairSymbol } from "../shared/fec.ts";
import type { PreparedImage } from "./image.ts";
import { RunAndTumble } from "./tumble.ts";
import type { Apollonius } from "./apollonius.ts";

/** How long after its last packet a unit waits for the client's count, beyond a round trip. */
const REPAIR_SLACK_MS = 250;
/** Repair rounds of one unit, at most, while it stays on screen (the base unit has no limit). */
const MAX_TOPUPS = 6;
/** Repair symbols sent beyond what a block is short, so one lost repair costs no round trip. */
const REPAIR_SPARE = 1;

/**
 * Packets of units, prepared once and shared by every session: the second viewer of a unit
 * costs no disk read and no packetising.
 *
 * Over the budget, it evicts by demand when it knows it (Apollonius, server/apollonius.ts):
 * first the units no connected user can reach within the horizon, least recently used first,
 * and only then the rest. Without demand, least recently used first.
 */
export class PacketCache {
  private units = new Map<string, Packets>();
  private ids = new Map<string, { image: PreparedImage; unit: UnitId }>();
  /** How many users can reach a unit soon; null = plain LRU. */
  demand: ((image: PreparedImage, u: UnitId) => number) | null = null;
  evictions = 0;
  evictedWanted = 0;         // evictions of units someone could reach soon (only when forced)
  private framed = new WeakMap<Packets, Map<number, Uint8Array[]>>();
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
    this.units.set(key, made);
    this.ids.set(key, { image, unit: u });
    this.bytes += size(made);
    if (this.bytes > this.budget) this.evict(key);
    return made;
  }

  /** Whether a unit is ready without touching the disk. */
  has(image: PreparedImage, u: UnitId): boolean {
    return this.units.has(`${image.chart.name}/${unitKey(u)}`);
  }

  get held(): { units: number; bytes: number } {
    return { units: this.units.size, bytes: this.bytes };
  }

  private evict(keep: string): void {
    const drop = (k: string) => {
      this.bytes -= size(this.units.get(k)!);
      this.units.delete(k);
      this.ids.delete(k);
      this.evictions++;
    };
    // first pass: nobody is heading for it; second pass (only if still over): anything
    for (const pass of this.demand ? [0, 1] : [1]) {
      for (const k of [...this.units.keys()]) {
        if (this.bytes <= this.budget) return;
        if (k === keep) continue;
        const id = this.ids.get(k)!;
        const wanted = pass === 0 ? this.demand!(id.image, id.unit) : 0;
        if (pass === 0 && wanted > 0) continue;
        if (pass === 1 && this.demand && this.demand(id.image, id.unit) > 0) this.evictedWanted++;
        drop(k);
      }
    }
  }

  /** A block's packets framed as erasure-code symbols, made once per unit and block. */
  symbols(p: Packets, block: number, isTile: boolean): Uint8Array[] {
    let byBlock = this.framed.get(p);
    if (!byBlock) this.framed.set(p, (byBlock = new Map()));
    let out = byBlock.get(block);
    if (!out) {
      const b = p.blocks[block], width = isTile ? WIDTH_TILE : WIDTH_SPLAT;
      out = p.packets.slice(b.start, b.start + b.k).map((q) => frame(q, width));
      byBlock.set(block, out);
    }
    return out;
  }
}

const size = (p: Packets) => p.packets.reduce((s, b) => s + b.length, 0);

function build(image: PreparedImage, u: UnitId): Packets {
  if (u.kind === KIND_SPLAT) return confetti(u.level, u.x, u.y, readSpx(image.splatPath(u.level, u.x, u.y)));
  const file = image.tileFile(u.level, u.x, u.y);
  if (!file) return { packets: [], ends: [0], blocks: [] };
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

/** What a unit has been sent, and what the client says it holds of it. */
interface UnitState {
  id: UnitId;
  sentUpTo: number;      // packets [0, sentUpTo) have been sent at least once
  chunksSent: number;
  held: Map<number, number>;   // per block of the erasure code: independent symbols held
  nextSymbol: Map<number, number>;   // per block: the next repair symbol's number
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
  private currentType: typeof Type.CONFETTI | typeof Type.TILEPART | typeof Type.REPAIR = Type.CONFETTI;
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
  /** Apollonius, if the server uses it: this user as a pursuer. */
  private apollo: Apollonius | null = null;
  private user = "";
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

  /** Take part in Apollonius as `user`: report every view. */
  attach(apollo: Apollonius, user: string): void {
    this.apollo = apollo;
    this.user = user;
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
        this.apollo?.see(this.user, this.image, v);
        break;
      }
      case Type.REPORT: {
        const r = decodeReport(m.payload);
        this.reported = { packets: r.packets, bytes: r.bytes };
        this.rc.onReport(r);
        for (const c of r.blocks) {
          const s = this.units.get(unitKey(c));
          if (s) s.held.set(c.block, Math.max(s.held.get(c.block) ?? 0, c.got));
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
      this.rc.sent(msg.length);
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
   *
   * (Prefetching the user's predicted path on idle capacity was tried with Apollonius and
   * dropped: on the 75k image it sent 3 MB more per session and made views sharp later.)
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
        s = { id: job.id, sentUpTo: 0, chunksSent: 0, held: new Map(), nextSymbol: new Map(), lastSend: now, topups: 0 };
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

  /** How many symbols the unit's sent blocks are short, by the client's last count. */
  private deficit(s: UnitState): number {
    const p = this.cache.packets(this.image!, s.id);
    let short = 0;
    p.blocks.forEach((b, i) => {
      if (b.start + b.k <= s.sentUpTo) short += Math.max(0, b.k - (s.held.get(i) ?? 0));
    });
    return short;
  }

  /**
   * Repair a unit: for every block the client is short of, that many fresh repair symbols
   * (plus REPAIR_SPARE). Each is a new mixture of the whole block, useful whichever packets
   * were lost, so nothing is ever sent twice and nothing is wasted on what already arrived.
   */
  private repair(s: UnitState): boolean {
    s.topups++;
    const p = this.cache.packets(this.image!, s.id);
    const isTile = s.id.kind === KIND_TILE;
    const out: Buffer[] = [];
    p.blocks.forEach((b, i) => {
      if (b.start + b.k > s.sentUpTo) return;
      const short = b.k - (s.held.get(i) ?? 0);
      if (short <= 0) return;
      const framed = this.cache.symbols(p, i, isTile);
      let next = s.nextSymbol.get(i) ?? b.k;
      for (let j = 0; j < short + REPAIR_SPARE; j++, next++) {
        out.push(encodeRepair({ ...s.id, block: i, k: b.k, width: framed[0].length, index: next },
                              repairSymbol(framed, next)));
      }
      s.nextSymbol.set(i, next);
    });
    this.start(s.id, out, s, true);
    return out.length > 0;
  }

  private start(id: UnitId, packets: Buffer[], s: UnitState, repairing: boolean): void {
    this.current = packets;
    this.currentAt = 0;
    this.currentType = repairing ? Type.REPAIR : id.kind === KIND_SPLAT ? Type.CONFETTI : Type.TILEPART;
    this.currentState = s;
    this.repairing = repairing;
  }

  private isBase(id: UnitId): boolean {
    return id.kind === KIND_SPLAT && id.level === this.image?.chart.maxLevel;
  }

  private repairDue(key: string, s: UnitState, now: number): boolean {
    return now - s.lastSend > this.rc.srtt + REPAIR_SLACK_MS
      && (this.isBase(s.id) || (s.topups < MAX_TOPUPS && this.wanted.has(key)))
      && this.deficit(s) > 0;
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
