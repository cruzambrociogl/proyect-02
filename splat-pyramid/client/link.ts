// The protocol side of the client half: one UDP session with the server. Used by the
// browser bridge (client/main.ts) and by headless benchmark clients (bench/).
//
// It keeps, per unit, which packets arrived and how many there are, and reports the counts
// (confetti feedback: one number per unit, never which packets were lost). Tiles are put
// back together from their parts; splat packets are handed on as they land.

import { createSocket, type Socket } from "node:dgram";
import {
  Type, KIND_SPLAT, KIND_TILE, clockMs, decode, encode, encodeReport, encodeView, unitKey,
  type TypeCode, type UnitCount, type UnitId, type View,
} from "../shared/wire.ts";
import { TILE_HEAD, TILE_PART, readTilePart } from "../shared/units.ts";
import { EmulatedPath, NONE, type Impairment } from "../shared/emulator.ts";

export const REPORT_MS = 100;
const TILE_ASSEMBLY_TIMEOUT_MS = 30_000;

export interface LinkEvents {
  welcome?: () => void;
  chart?: (chart: Record<string, unknown>) => void;
  stats?: (stats: Record<string, unknown>) => void;
  fault?: (message: string) => void;
  confetti?: (payload: Buffer) => void;
  tile?: (level: number, x: number, y: number, format: number, data: Buffer) => void;
}

interface Tracked { id: UnitId; got: Set<number>; total: number; changed: boolean; data?: Buffer; format?: number }

export class ClientLink {
  readonly received = { packets: 0, bytes: 0, duplicates: 0 };
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

  /** Start (or restart) the session: the server forgets everything it sent. */
  hello(): void {
    this.welcomed = false;
    this.epoch = 0;
    this.units.clear();
    this.pendingDropped.length = 0;
    this.send(Type.HELLO);
  }

  open(image: string): void {
    this.epoch++;
    this.units.clear();
    this.send(Type.OPEN, Buffer.from(image, "utf8"));
  }

  view(v: Omit<View, "dropped">, dropped: UnitId[] = []): void {
    this.epoch++;
    for (const u of dropped) this.units.delete(unitKey(u));   // a resend starts from nothing
    const all = [...this.pendingDropped, ...dropped];
    const payload = encodeView({ ...v, dropped: all });
    this.send(Type.VIEW, payload);
    const sent = payload.readUInt16BE(28);
    this.pendingDropped = all.slice(sent);                    // the rest ride with the next view
  }

  bye(): void {
    this.send(Type.BYE);
  }

  /** How complete each unit is, for measurement. */
  completeness(): { id: UnitId; got: number; total: number; since: number }[] {
    return [...this.units.entries()].map(([k, t]) => ({ id: t.id, got: t.got.size, total: t.total,
                                                        since: this.started.get(k) ?? 0 }));
  }

  private track(id: UnitId, index: number, total: number): Tracked | null {
    const k = unitKey(id);
    let t = this.units.get(k);
    if (!t) {
      t = { id, got: new Set(), total, changed: true };
      this.units.set(k, t);
      if (!this.started.has(k)) this.started.set(k, performance.now());
    }
    if (t.got.has(index)) {
      this.received.duplicates++;
      return null;
    }
    t.got.add(index);
    t.changed = true;
    return t;
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
        this.welcomed = true;
        this.events.welcome?.();
        break;
      case Type.CHART:
        this.events.chart?.(JSON.parse(m.payload.toString("utf8")));
        break;
      case Type.STATS:
        this.events.stats?.(JSON.parse(m.payload.toString("utf8")));
        break;
      case Type.FAULT:
        this.events.fault?.(m.payload.toString("utf8"));
        break;
      case Type.CONFETTI: {
        const p = m.payload;
        const id = { kind: KIND_SPLAT, level: p[0], x: p.readUInt32BE(1), y: p.readUInt32BE(5) };
        if (this.track(id, p.readUInt16BE(18), p.readUInt16BE(20))) this.events.confetti?.(p);
        break;
      }
      case Type.TILEPART: {
        const h = readTilePart(m.payload);
        const id = { kind: KIND_TILE, level: h.level, x: h.x, y: h.y };
        const t = this.track(id, h.index, h.parts);
        if (!t) break;
        if (!t.data) { t.data = Buffer.alloc(h.total); t.format = h.format; }
        m.payload.copy(t.data, h.index * TILE_PART, TILE_HEAD);   // every part but the last is full
        if (t.got.size === t.total) {
          const data = t.data;
          t.data = undefined;                                      // handed on: keep only the count
          this.events.tile?.(h.level, h.x, h.y, t.format!, data);
        }
        break;
      }
    }
  }

  private report(): void {
    if (!this.welcomed) return;
    // units whose count changed first, then incomplete ones, so the server's picture stays fresh
    const changed: UnitCount[] = [], incomplete: UnitCount[] = [];
    const now = performance.now();
    for (const [k, t] of this.units) {
      const c = { ...t.id, got: t.got.size, total: t.total };
      if (t.changed) changed.push(c);
      else if (t.got.size < t.total) incomplete.push(c);
      t.changed = false;
      // a tile that never completed gives its memory back
      if (t.data && t.got.size < t.total && now - (this.started.get(k) ?? now) > TILE_ASSEMBLY_TIMEOUT_MS) {
        this.units.delete(k);
      }
    }
    this.send(Type.REPORT, encodeReport({
      packets: this.received.packets, bytes: this.received.bytes,
      intervalBytes: this.interval.bytes, intervalMs: now - this.interval.since,
      owdMin: this.interval.owdMin, echo: this.echo.sentAt, holdMs: now - this.echo.receivedAt,
      units: [...changed, ...incomplete],
    }));
    this.interval = { bytes: 0, owdMin: null, since: now };
  }
}
