// The protocol's messages. Every UDP datagram is one message:
//
//   0  'S' 'P'   magic
//   2  u8        version
//   3  u8        type
//   4  u32       epoch: raised by the viewer on every change of view, so the server can drop
//                anything still queued for an older one
//   8  u32       payload length
//  12  u32       sent at: the sender's clock in ms (wraps). The receiver compares it with its
//                own clock: the absolute value means nothing (the clocks differ), but how it
//                changes is how long packets are waiting in queues along the way
//  16  payload
//
// All integers are big-endian. Datagrams stay under MAX_DATAGRAM so they never fragment.

export const VERSION = 1;
export const HEADER = 16;

/** This process's clock for "sent at", in ms. */
const clockZero = performance.now();
export const clockMs = (): number => Math.floor(performance.now() - clockZero) >>> 0;
export const MAX_DATAGRAM = 1200;

export const Type = {
  HELLO: 1,      // client -> server: let's talk
  WELCOME: 2,    // server -> client
  OPEN: 3,       // client -> server: image name
  CHART: 4,      // server -> client: the image's shape, JSON
  VIEW: 5,       // client -> server: where the viewer is looking, and what its cache dropped
  REPORT: 6,     // client -> server: what arrived
  CONFETTI: 7,   // server -> client: some blobs of a splat unit
  TILEPART: 8,   // server -> client: a piece of an image tile
  STATS: 9,      // server -> client: what the session is doing, JSON
  FAULT: 10,     // server -> client: an error, text
  BYE: 11,       // either way: the session is over
  REPAIR: 12,    // server -> client: a mixture of one block's packets (fec.ts)
} as const;
export type TypeCode = (typeof Type)[keyof typeof Type];

export const typeName = (t: number): string =>
  Object.entries(Type).find(([, v]) => v === t)?.[0] ?? `type ${t}`;

export function encode(type: TypeCode, epoch: number, payload: Uint8Array = new Uint8Array(0)): Buffer {
  const out = Buffer.allocUnsafe(HEADER + payload.length);
  out[0] = 0x53; // 'S'
  out[1] = 0x50; // 'P'
  out[2] = VERSION;
  out[3] = type;
  out.writeUInt32BE(epoch >>> 0, 4);
  out.writeUInt32BE(payload.length, 8);
  out.writeUInt32BE(clockMs(), 12);
  out.set(payload, HEADER);
  return out;
}

export interface Message {
  type: number;
  epoch: number;
  sentAt: number;
  payload: Buffer;
}

/** A datagram to a message, or null if it is not one of ours. */
export function decode(datagram: Buffer): Message | null {
  if (datagram.length < HEADER || datagram[0] !== 0x53 || datagram[1] !== 0x50) return null;
  if (datagram[2] !== VERSION) return null;
  const length = datagram.readUInt32BE(8);
  if (HEADER + length > datagram.length) return null;
  return { type: datagram[3], epoch: datagram.readUInt32BE(4), sentAt: datagram.readUInt32BE(12),
           payload: datagram.subarray(HEADER, HEADER + length) };
}

// ---------------------------------------------------------------------------------------
// payloads
// ---------------------------------------------------------------------------------------

/** A unit of the pyramid: a splat unit (levels split and up) or an image tile (below). */
export interface UnitId {
  kind: number;  // KIND_SPLAT or KIND_TILE
  level: number;
  x: number;
  y: number;
}
export const KIND_SPLAT = 0;
export const KIND_TILE = 1;
export const unitKey = (u: UnitId): string => `${u.kind}/${u.level}/${u.x}/${u.y}`;

/** VIEW: centre (level-0 px), scale (level-0 px per screen px), screen size, dropped units. */
export interface View {
  cx: number;
  cy: number;
  scale: number;
  screenW: number;
  screenH: number;
  dropped: UnitId[];
}

const VIEW_FIXED = 8 * 3 + 2 * 2 + 2;
const DROPPED_BYTES = 10;
/** How many dropped units fit in one VIEW datagram; the rest ride along with the next. */
export const MAX_DROPPED = Math.floor((MAX_DATAGRAM - HEADER - VIEW_FIXED) / DROPPED_BYTES);

export function encodeView(v: View): Buffer {
  const dropped = v.dropped.slice(0, MAX_DROPPED);
  const b = Buffer.alloc(VIEW_FIXED + dropped.length * DROPPED_BYTES);
  b.writeDoubleBE(v.cx, 0);
  b.writeDoubleBE(v.cy, 8);
  b.writeDoubleBE(v.scale, 16);
  b.writeUInt16BE(Math.min(65535, v.screenW), 24);
  b.writeUInt16BE(Math.min(65535, v.screenH), 26);
  b.writeUInt16BE(dropped.length, 28);
  dropped.forEach((u, i) => {
    const at = VIEW_FIXED + i * DROPPED_BYTES;
    b[at] = u.kind;
    b[at + 1] = u.level;
    b.writeUInt32BE(u.x, at + 2);
    b.writeUInt32BE(u.y, at + 6);
  });
  return b;
}

export function decodeView(b: Buffer): View {
  const n = b.readUInt16BE(28);
  const dropped: UnitId[] = [];
  for (let i = 0; i < n; i++) {
    const at = VIEW_FIXED + i * DROPPED_BYTES;
    dropped.push({ kind: b[at], level: b[at + 1], x: b.readUInt32BE(at + 2), y: b.readUInt32BE(at + 6) });
  }
  return { cx: b.readDoubleBE(0), cy: b.readDoubleBE(8), scale: b.readDoubleBE(16),
           screenW: b.readUInt16BE(24), screenH: b.readUInt16BE(26), dropped };
}

/**
 * REPORT: what arrived. Also the session's keepalive, and the rate controller's senses.
 *
 * Loss feedback is one number per block of a unit (see fec.ts): how many independent symbols
 * of it the client holds. Never a list of which were lost, never a per-packet
 * acknowledgement; the server sends as many repair symbols as the count is short.
 *
 *   0  u32  packets received so far     4  u32  bytes received so far
 *   8  u32  bytes received since the last report
 *  12  u16  ms since the last report
 *  14  i32  smallest one-way delay seen since the last report, ms (receive clock minus the
 *           sender's "sent at": only its changes mean anything); INT32_MIN if none
 *  18  u32  the newest "sent at" received      22  u16  ms held before this report (for RTT)
 *  24  u16  block entries, then per block: kind u8, level u8, x u32, y u32, block u8,
 *           got u16 (independent symbols held), k u16 (symbols the block needs)
 */
export interface BlockCount extends UnitId {
  block: number;
  got: number;
  k: number;
}

export interface Report {
  packets: number;
  bytes: number;
  intervalBytes: number;
  intervalMs: number;
  owdMin: number | null;
  echo: number;
  holdMs: number;
  blocks: BlockCount[];
}

const REPORT_FIXED = 26;
const NO_DELAY = -0x80000000;
const COUNT_BYTES = 15;
/** How many block counts fit in one REPORT datagram. */
export const MAX_COUNTS = Math.floor((MAX_DATAGRAM - HEADER - REPORT_FIXED) / COUNT_BYTES);

export function encodeReport(r: Report): Buffer {
  const units = r.blocks.slice(0, MAX_COUNTS);
  const b = Buffer.alloc(REPORT_FIXED + units.length * COUNT_BYTES);
  b.writeUInt32BE(r.packets >>> 0, 0);
  b.writeUInt32BE(r.bytes >>> 0, 4);
  b.writeUInt32BE(r.intervalBytes >>> 0, 8);
  b.writeUInt16BE(Math.min(65535, Math.round(r.intervalMs)), 12);
  b.writeInt32BE(r.owdMin === null ? NO_DELAY : Math.max(NO_DELAY + 1, Math.min(0x7fffffff, Math.round(r.owdMin))), 14);
  b.writeUInt32BE(r.echo >>> 0, 18);
  b.writeUInt16BE(Math.min(65535, Math.round(r.holdMs)), 22);
  b.writeUInt16BE(units.length, 24);
  units.forEach((u, i) => {
    const at = REPORT_FIXED + i * COUNT_BYTES;
    b[at] = u.kind;
    b[at + 1] = u.level;
    b.writeUInt32BE(u.x, at + 2);
    b.writeUInt32BE(u.y, at + 6);
    b[at + 10] = u.block;
    b.writeUInt16BE(Math.min(65535, u.got), at + 11);
    b.writeUInt16BE(Math.min(65535, u.k), at + 13);
  });
  return b;
}

export function decodeReport(b: Buffer): Report {
  const n = b.length >= REPORT_FIXED ? b.readUInt16BE(24) : 0;
  const blocks: BlockCount[] = [];
  for (let i = 0; i < n; i++) {
    const at = REPORT_FIXED + i * COUNT_BYTES;
    blocks.push({ kind: b[at], level: b[at + 1], x: b.readUInt32BE(at + 2), y: b.readUInt32BE(at + 6),
                  block: b[at + 10], got: b.readUInt16BE(at + 11), k: b.readUInt16BE(at + 13) });
  }
  const owd = b.readInt32BE(14);
  return { packets: b.readUInt32BE(0), bytes: b.readUInt32BE(4), intervalBytes: b.readUInt32BE(8),
           intervalMs: b.readUInt16BE(12), owdMin: owd === NO_DELAY ? null : owd,
           echo: b.readUInt32BE(18), holdMs: b.readUInt16BE(22), blocks };
}

/**
 * REPAIR: one repair symbol (fec.ts) of one block of a unit.
 *    0  u8 kind   1  u8 level   2  u32 x   6  u32 y   10  u8 block   11  u16 k
 *   13  u16 symbol width         15  u16 symbol index (>= k)          17  symbol
 */
export const REPAIR_HEAD = 17;

export interface RepairHead extends UnitId {
  block: number;
  k: number;
  width: number;
  index: number;
}

export function encodeRepair(h: RepairHead, symbol: Uint8Array): Buffer {
  const b = Buffer.alloc(REPAIR_HEAD + symbol.length);
  b[0] = h.kind;
  b[1] = h.level;
  b.writeUInt32BE(h.x, 2);
  b.writeUInt32BE(h.y, 6);
  b[10] = h.block;
  b.writeUInt16BE(h.k, 11);
  b.writeUInt16BE(h.width, 13);
  b.writeUInt16BE(h.index, 15);
  b.set(symbol, REPAIR_HEAD);
  return b;
}

export function decodeRepair(b: Buffer): { head: RepairHead; symbol: Buffer } {
  return {
    head: { kind: b[0], level: b[1], x: b.readUInt32BE(2), y: b.readUInt32BE(6), block: b[10],
            k: b.readUInt16BE(11), width: b.readUInt16BE(13), index: b.readUInt16BE(15) },
    symbol: b.subarray(REPAIR_HEAD),
  };
}
