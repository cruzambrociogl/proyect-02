// The protocol side of the client half: one UDP session with the server. Used by the
// browser bridge (client/main.ts) and by headless benchmark clients (bench/).
//
// It keeps, per unit, which packets it has, and per block of the erasure code (shared/fec.ts)
// a decoder fed with every packet and repair symbol of that block. It reports one count per
// block, how many independent symbols it holds, never which packets were lost. When repair
// symbols complete a block, the packets rebuilt from them are handed on exactly as if they
// had arrived. Splat packets are handed on as they land; tiles once whole.

import { createSocket, type Socket } from "node:dgram";
import {
  Type, KIND_SPLAT, KIND_TILE, clockMs, decode, encode, encodeReport, encodeView, unitKey,
  MAX_COUNTS, decodeCatalogPart, decodeRepair, type BlockCount, type TypeCode, type UnitId, type View,
} from "../shared/wire.ts";
import { TILE_HEAD, TILE_PART, WIDTH_SPLAT, WIDTH_TILE, blockOfPacket, readTilePart } from "../shared/units.ts";
import { BlockDecoder, frame, unframe } from "../shared/fec.ts";
import { EmulatedPath, NONE, type Impairment } from "../shared/emulator.ts";

export const REPORT_MS = 100;
/** Control messages (HELLO, OPEN, the latest VIEW) are sent again until answered, this often. */
const RETRY_MS = 300;
const TILE_ASSEMBLY_TIMEOUT_MS = 30_000;

export interface LinkEvents {
  welcome?: () => void;
  chart?: (chart: Record<string, unknown>) => void;
  stats?: (stats: Record<string, unknown>) => void;
  fault?: (message: string) => void;
  confetti?: (payload: Buffer) => void;
  tile?: (level: number, x: number, y: number, format: number, data: Buffer) => void;
}

/** One block of the erasure code: a decoder while incomplete, freed once complete. */
interface BlockState { k: number; start: number; rank: number; dec: BlockDecoder | null; changed: boolean }
interface Tracked {
  id: UnitId;
  got: Set<number>;        // packets we have, received or rebuilt
  total: number;           // packets in the whole unit (0 until one is seen)
  blocks: Map<number, BlockState>;
  data?: Buffer;
  format?: number;
}

export class ClientLink {
  readonly received = { packets: 0, bytes: 0, duplicates: 0, repairs: 0, rebuilt: 0 };
  events: LinkEvents = {};
  epoch = 0;
  welcomed = false;
  private socket: Socket;
  private up: EmulatedPath;
  private host: string;
  private port: number;
  private units = new Map<string, Tracked>();
  private pendingDropped: UnitId[] = [];
  private timer: NodeJS.Timeout;
  private started = new Map<string, number>();
  private closed = false;
  // since the last report: for the server's rate controller
  private interval = { bytes: 0, owdMin: null as number | null, since: performance.now() };
  private echo = { sentAt: 0, receivedAt: 0 };

  constructor(server: string, upstream: Impairment = NONE) {
    const [host, port] = server.split(":");
    this.host = host;
    this.port = Number(port ?? 9000);
    this.socket = createSocket("udp4");
    this.up = new EmulatedPath(upstream, (msg) => {
      if (!this.closed) this.socket.send(msg, this.port, this.host);   // delayed packets outlive close()
    });
    this.socket.on("message", (d) => this.onDatagram(d));
    this.timer = setInterval(() => this.report(), REPORT_MS);
  }

  bind(): Promise<void> {
    return new Promise((resolve) => this.socket.bind(0, resolve));
  }

  close(): void {
    this.closed = true;
    clearInterval(this.timer);
    this.socket.close();
  }

  private send(type: TypeCode, payload?: Uint8Array): void {
    this.up.send(encode(type, this.epoch, payload));
  }

  // Control messages travel the same lossy, reordering path as everything else, so each is
  // sent again every RETRY_MS until its answer shows it arrived: HELLO until WELCOME, OPEN
  // until CHART (and only after WELCOME: an OPEN overtaking its HELLO would be ignored), the
  // latest VIEW until the server's STATS carry its epoch. Older views are never resent; a
  // newer one replaces them.
  private helloAt = 0;
  private pendingOpen: { payload: Buffer; at: number } | null = null;
  private lastView: { payload: Buffer; epoch: number; at: number } | null = null;
  private serverEpoch = 0;

  /** Start (or restart) the session: the server forgets everything it sent. */
  hello(): void {
    this.welcomed = false;
    this.epoch = 0;
    this.units.clear();
    this.pendingDropped.length = 0;
    this.pendingOpen = null;
    this.lastView = null;
    this.serverEpoch = 0;
    this.helloAt = performance.now();
    this.send(Type.HELLO);
  }

  open(image: string): void {
    this.epoch++;
    this.units.clear();
    this.lastView = null;
    this.pendingOpen = { payload: Buffer.from(image, "utf8"), at: performance.now() };
    if (this.welcomed) this.send(Type.OPEN, this.pendingOpen.payload);
  }

  view(v: Omit<View, "dropped">, dropped: UnitId[] = []): void {
    this.epoch++;
    for (const u of dropped) this.units.delete(unitKey(u));   // a resend starts from nothing
    const all = [...this.pendingDropped, ...dropped];
    const payload = encodeView({ ...v, dropped: all });
    this.lastView = { payload, epoch: this.epoch, at: performance.now() };
    this.send(Type.VIEW, payload);
    const sent = payload.readUInt16BE(28);
    this.pendingDropped = all.slice(sent);                    // the rest ride with the next view
  }

  private retry(now: number): void {
    if (!this.welcomed) {
      if (this.helloAt && now - this.helloAt > RETRY_MS) {
        this.helloAt = now;
        this.send(Type.HELLO);
      }
      return;
    }
    if (this.pendingOpen) {
      if (now - this.pendingOpen.at > RETRY_MS) {
        this.pendingOpen.at = now;
        this.send(Type.OPEN, this.pendingOpen.payload);
      }
      return;
    }
    const v = this.lastView;
    if (v && this.serverEpoch < v.epoch && v.epoch === this.epoch && now - v.at > RETRY_MS) {
      v.at = now;
      this.send(Type.VIEW, v.payload);
    }
  }

  /**
   * The images the server has ready, as its CATALOG says (needs no session). LIST is sent
   * again every RETRY_MS until every part of the answer is in.
   */
  list(timeoutMs = 5000): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const parts = new Map<number, Buffer>();
      let expected = 0;
      const ask = () => this.up.send(encode(Type.LIST, 0));
      const retry = setInterval(ask, RETRY_MS);
      const give = setTimeout(() => done(new Error("the server did not answer")), timeoutMs);
      const done = (err: Error | null, value?: Record<string, unknown>) => {
        clearInterval(retry);
        clearTimeout(give);
        this.catalogWaiters.delete(take);
        if (err) reject(err);
        else resolve(value!);
      };
      const take = (payload: Buffer) => {
        const p = decodeCatalogPart(payload);
        expected = p.parts;
        parts.set(p.part, Buffer.from(p.text));
        if (parts.size === expected) {
          const text = Buffer.concat(Array.from({ length: expected }, (_, i) => parts.get(i)!)).toString("utf8");
          done(null, JSON.parse(text));
        }
      };
      this.catalogWaiters.add(take);
      ask();
    });
  }

  private catalogWaiters = new Set<(payload: Buffer) => void>();

  bye(): void {
    this.send(Type.BYE);
  }

  /** How complete each unit is, for measurement. */
  completeness(): { id: UnitId; got: number; total: number; since: number }[] {
    return [...this.units.entries()].map(([k, t]) => ({ id: t.id, got: t.got.size, total: t.total,
                                                        since: this.started.get(k) ?? 0 }));
  }

  private unit(id: UnitId): Tracked {
    const k = unitKey(id);
    let t = this.units.get(k);
    if (!t) {
      t = { id, got: new Set(), total: 0, blocks: new Map() };
      this.units.set(k, t);
      if (!this.started.has(k)) this.started.set(k, performance.now());
    }
    return t;
  }

  /** The block a packet or repair belongs to, made on first sight. */
  private block(t: Tracked, index: number, start: number, k: number): BlockState {
    let b = t.blocks.get(index);
    if (!b) {
      b = { k, start, rank: 0, dec: null, changed: true };
      t.blocks.set(index, b);
    }
    return b;
  }

  /**
   * A CONFETTI or TILEPART payload, arrived or rebuilt. Returns false if we already had it.
   * Arrived packets also go into their block's decoder, in case repairs are needed later.
   */
  private onPacket(isTile: boolean, p: Buffer, rebuilt: boolean): boolean {
    const id = isTile ? { kind: KIND_TILE, level: p[0], x: p.readUInt32BE(1), y: p.readUInt32BE(5) }
                      : { kind: KIND_SPLAT, level: p[0], x: p.readUInt32BE(1), y: p.readUInt32BE(5) };
    const index = isTile ? p.readUInt16BE(14) : p.readUInt16BE(18);
    const t = this.unit(id);
    t.total = isTile ? p.readUInt16BE(16) : p.readUInt16BE(20);
    if (t.got.has(index)) {
      this.received.duplicates++;
      return false;
    }
    t.got.add(index);
    if (rebuilt) {
      this.received.rebuilt++;
    } else {
      const bi = blockOfPacket(p, isTile);
      const b = this.block(t, bi.block, bi.start, bi.k);
      b.start = bi.start;                    // a block first seen through a repair did not know it
      if (b.rank < b.k) {
        b.dec ??= new BlockDecoder(b.k, isTile ? WIDTH_TILE : WIDTH_SPLAT);
        b.dec.accept(index - b.start, frame(p, b.dec.width));
        this.settle(b, isTile);
      }
    }
    if (isTile) {
      const h = readTilePart(p);
      if (!t.data) { t.data = Buffer.alloc(h.total); t.format = h.format; }
      p.copy(t.data, h.index * TILE_PART, TILE_HEAD);              // every part but the last is full
      if (t.got.size === t.total) {
        const data = t.data;
        t.data = undefined;                                        // handed on: keep only the count
        this.events.tile?.(h.level, h.x, h.y, t.format!, data);
      }
    } else {
      this.events.confetti?.(p);
    }
    return true;
  }

  /** After a symbol went into a block: note its rank; if complete, hand on what was rebuilt. */
  private settle(b: BlockState, isTile: boolean): void {
    const dec = b.dec!;
    if (dec.rank !== b.rank) b.changed = true;
    b.rank = dec.rank;
    if (!dec.complete) return;
    b.dec = null;                                                  // done: free its memory
    for (const [, symbol] of dec.recovered()) this.onPacket(isTile, Buffer.from(unframe(symbol)), true);
  }

  private onRepair(payload: Buffer): void {
    const { head, symbol } = decodeRepair(payload);
    this.received.repairs++;
    const isTile = head.kind === KIND_TILE;
    const t = this.unit({ kind: head.kind, level: head.level, x: head.x, y: head.y });
    const b = this.block(t, head.block, 0, head.k);
    if (b.rank >= b.k) return;                                     // already complete
    b.dec ??= new BlockDecoder(b.k, head.width);
    b.dec.accept(head.index, symbol);
    this.settle(b, isTile);
  }

  private onDatagram(datagram: Buffer): void {
    const m = decode(datagram);
    if (!m) return;
    this.received.packets++;
    this.received.bytes += datagram.length;
    this.interval.bytes += datagram.length;
    // one-way delay on our clock minus theirs: its absolute value is meaningless, its rise is
    // the queue building up somewhere on the path
    const owd = (clockMs() - m.sentAt) | 0;
    if (this.interval.owdMin === null || owd < this.interval.owdMin) this.interval.owdMin = owd;
    this.echo = { sentAt: m.sentAt, receivedAt: performance.now() };
    switch (m.type) {
      case Type.WELCOME:
        if (this.welcomed) break;                             // a duplicate
        this.welcomed = true;
        if (this.pendingOpen) this.send(Type.OPEN, this.pendingOpen.payload);
        this.events.welcome?.();
        break;
      case Type.CHART: {
        if (!this.pendingOpen) break;                         // a duplicate
        const chart = JSON.parse(m.payload.toString("utf8"));
        // a late answer to the page before's OPEN is not ours: epochs restart with every
        // page, so only the name tells them apart
        if (String(chart.name).normalize("NFC") !== this.pendingOpen.payload.toString("utf8").normalize("NFC")) break;
        this.pendingOpen = null;
        this.events.chart?.(chart);
        break;
      }
      case Type.STATS: {
        const stats = JSON.parse(m.payload.toString("utf8"));
        // a late STATS from the page before (its epoch ahead of ours) must not count as the
        // server having seen our views, or a lost first VIEW would never be sent again
        if ((stats.epoch ?? 0) <= this.epoch) this.serverEpoch = Math.max(this.serverEpoch, stats.epoch ?? 0);
        this.events.stats?.(stats);
        break;
      }
      case Type.FAULT:
        this.pendingOpen = null;                              // an answer too: stop asking
        this.events.fault?.(m.payload.toString("utf8"));
        break;
      case Type.CONFETTI:
        this.onPacket(false, m.payload, false);
        break;
      case Type.TILEPART:
        this.onPacket(true, m.payload, false);
        break;
      case Type.REPAIR:
        this.onRepair(m.payload);
        break;
      case Type.CATALOG:
        for (const take of this.catalogWaiters) take(m.payload);
        break;
    }
  }

  private report(): void {
    this.retry(performance.now());
    if (!this.welcomed) return;
    // blocks whose count changed first, then incomplete ones, so the server's picture stays fresh
    const changed: [BlockCount, BlockState][] = [], incomplete: [BlockCount, BlockState][] = [];
    const now = performance.now();
    for (const [k, t] of this.units) {
      for (const [index, b] of t.blocks) {
        const c = { ...t.id, block: index, got: b.rank, k: b.k };
        if (b.changed) changed.push([c, b]);
        else if (b.rank < b.k) incomplete.push([c, b]);
      }
      // a tile that never completed gives its memory back
      if (t.data && t.got.size < t.total && now - (this.started.get(k) ?? now) > TILE_ASSEMBLY_TIMEOUT_MS) {
        this.units.delete(k);
      }
    }
    this.send(Type.REPORT, encodeReport({
      packets: this.received.packets, bytes: this.received.bytes,
      intervalBytes: this.interval.bytes, intervalMs: now - this.interval.since,
      owdMin: this.interval.owdMin, echo: this.echo.sentAt, holdMs: now - this.echo.receivedAt,
      blocks: [...changed, ...incomplete].slice(0, MAX_COUNTS).map(([c]) => c),
    }));
    // a count that did not fit stays "changed" for the next report: the server must hear that
    // a block completed, or it would repair it for nothing
    for (const [, b] of changed.slice(0, MAX_COUNTS)) b.changed = false;
    this.interval = { bytes: 0, owdMin: null, since: now };
  }
}
