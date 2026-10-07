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
//  16  u32       sequence number: every data packet (CONFETTI, TILEPART, REPAIR) of a session
//                gets the next one, from 1; 0 on everything else. ACK names the highest one
//                received, which is how the server knows what is still in flight
//  20  payload
//
// All integers are big-endian. Datagrams stay under MAX_DATAGRAM so they never fragment.

export const VERSION = 2;
export const HEADER = 20;

/** This process's clock for "sent at", in ms. */
const clockZero = performance.now();
export const clockMs = (): number => Math.floor(performance.now() - clockZero) >>> 0;
export const MAX_DATAGRAM = 1200;

export const Type = {
  HELLO: 1,      // client -> server: let's talk
  WELCOME: 2,    // server -> client
  OPEN: 3,       // client -> server: image name
  CHART: 4,      // server -> client: the image's shape, JSON
  VIEW: 5,       // client -> server: where the viewer is looking, what its cache dropped and holds
  REPORT: 6,     // client -> server: what arrived
  CONFETTI: 7,   // server -> client: some blobs of a splat unit
  TILEPART: 8,   // server -> client: a piece of an image tile
  STATS: 9,      // server -> client: what the session is doing, JSON
  FAULT: 10,     // server -> client: an error, text
  BYE: 11,       // either way: the session is over
  REPAIR: 12,    // server -> client: a mixture of one block's packets (fec.ts)
  LIST: 13,      // client -> server: which images are there? (needs no session)
  CATALOG: 14,   // server -> client: one part of the answer, JSON
  ACK: 15,       // client -> server: highest sequence number received, receive window
} as const;
export type TypeCode = (typeof Type)[keyof typeof Type];

export const typeName = (t: number): string =>
  Object.entries(Type).find(([, v]) => v === t)?.[0] ?? `type ${t}`;

export function encode(type: TypeCode, epoch: number, payload: Uint8Array = new Uint8Array(0), seq = 0): Buffer {
  const out = Buffer.allocUnsafe(HEADER + payload.length);
  out[0] = 0x53; // 'S'
  out[1] = 0x50; // 'P'
  out[2] = VERSION;
  out[3] = type;
  out.writeUInt32BE(epoch >>> 0, 4);
  out.writeUInt32BE(payload.length, 8);
  out.writeUInt32BE(clockMs(), 12);
  out.writeUInt32BE(seq >>> 0, 16);
  out.set(payload, HEADER);
  return out;
}

export interface Message {
  type: number;
  epoch: number;
  sentAt: number;
  seq: number;
  payload: Buffer;
}

/**
 * The protocol version a datagram of ours speaks, or null if it is not one of ours: so a side
 * that cannot decode a message can say "the other side runs another version" instead of
 * ignoring it in silence.
 */
export function versionOf(datagram: Buffer): number | null {
  return datagram.length >= 3 && datagram[0] === 0x53 && datagram[1] === 0x50 ? datagram[2] : null;
}

/** A datagram to a message, or null if it is not one of ours. */
export function decode(datagram: Buffer): Message | null {
  if (datagram.length < HEADER || datagram[0] !== 0x53 || datagram[1] !== 0x50) return null;
  if (datagram[2] !== VERSION) return null;
  const length = datagram.readUInt32BE(8);
  if (HEADER + length > datagram.length) return null;
  return { type: datagram[3], epoch: datagram.readUInt32BE(4), sentAt: datagram.readUInt32BE(12),
           seq: datagram.readUInt32BE(16), payload: datagram.subarray(HEADER, HEADER + length) };
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

/**
 * VIEW: centre (level-0 px), scale (level-0 px per screen px), screen size, dropped units, and
 * held units.
 *
 *   0  f64  cx       8  f64  cy      16  f64  scale
 *  24  u16  screenW  26  u16  screenH
 *  28  u16  n dropped, then n units of 10 bytes (u8 kind, u8 level, u32 x, u32 y)
 *  then u16 m held, then m units the same way (absent in a VIEW with none)
 *
 * Dropped: the viewer's cache let these go, so the server sends them again when wanted.
 * Held: units of this view the page already holds whole, sent after a reconnect. A new session
 * starts knowing nothing of the page, and without them it sent the whole view again.
 */
export interface View {
  cx: number;
  cy: number;
  scale: number;
  screenW: number;
  screenH: number;
  dropped: UnitId[];
  held?: UnitId[];
}

const VIEW_FIXED = 8 * 3 + 2 * 2 + 2;
const UNIT_BYTES = 10;
/** How many units (dropped and held together) fit in one VIEW datagram. */
export const MAX_VIEW_UNITS = Math.floor((MAX_DATAGRAM - HEADER - VIEW_FIXED - 2) / UNIT_BYTES);

function putUnit(b: Buffer, at: number, u: UnitId): void {
  b[at] = u.kind;
  b[at + 1] = u.level;
  b.writeUInt32BE(u.x, at + 2);
  b.writeUInt32BE(u.y, at + 6);
}

function getUnit(b: Buffer, at: number): UnitId {
  return { kind: b[at], level: b[at + 1], x: b.readUInt32BE(at + 2), y: b.readUInt32BE(at + 6) };
}

/** Dropped units go first; held ones fill what room is left. The rest are left out. */
export function encodeView(v: View): Buffer {
  const dropped = v.dropped.slice(0, MAX_VIEW_UNITS);
  const held = (v.held ?? []).slice(0, MAX_VIEW_UNITS - dropped.length);
  const heldAt = VIEW_FIXED + dropped.length * UNIT_BYTES;
  const b = Buffer.alloc(heldAt + (held.length ? 2 + held.length * UNIT_BYTES : 0));
  b.writeDoubleBE(v.cx, 0);
  b.writeDoubleBE(v.cy, 8);
  b.writeDoubleBE(v.scale, 16);
  b.writeUInt16BE(Math.min(65535, v.screenW), 24);
  b.writeUInt16BE(Math.min(65535, v.screenH), 26);
  b.writeUInt16BE(dropped.length, 28);
  dropped.forEach((u, i) => putUnit(b, VIEW_FIXED + i * UNIT_BYTES, u));
  if (held.length) {
    b.writeUInt16BE(held.length, heldAt);
    held.forEach((u, i) => putUnit(b, heldAt + 2 + i * UNIT_BYTES, u));
  }
  return b;
}

export function decodeView(b: Buffer): View {
  const n = b.readUInt16BE(28);
  const dropped: UnitId[] = [];
  for (let i = 0; i < n; i++) dropped.push(getUnit(b, VIEW_FIXED + i * UNIT_BYTES));
  const held: UnitId[] = [];
  const heldAt = VIEW_FIXED + n * UNIT_BYTES;
  if (b.length >= heldAt + 2) {
    const m = Math.min(b.readUInt16BE(heldAt), Math.floor((b.length - heldAt - 2) / UNIT_BYTES));
    for (let i = 0; i < m; i++) held.push(getUnit(b, heldAt + 2 + i * UNIT_BYTES));
  }
  return { cx: b.readDoubleBE(0), cy: b.readDoubleBE(8), scale: b.readDoubleBE(16),
           screenW: b.readUInt16BE(24), screenH: b.readUInt16BE(26), dropped, held };
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
 * ACK: the sliding window's feedback, sent after every few data packets (more often than
 * REPORT, which carries the erasure code's counts and paces the rate controller).
 *
 *   0  u32  highest sequence number received: every data packet up to it has arrived or is
 *           lost; the ones after it may still be on their way (the server's "in flight")
 *   4  u32  data packets received so far (so packets lost = sent up to that number - this)
 *   8  u32  receive window, bytes: how much more the receiver can take now (flow control)
 *  12  i32  smallest one-way delay since the last ACK, ms; INT32_MIN if none
 *  16  u32  "sent at" of the packet with the highest sequence number
 *  20  u16  ms between that packet arriving and this ACK (so the server can take it out of
 *           the round-trip time)
 */
export interface Ack {
  seq: number;
  got: number;
  rwnd: number;
  owdMin: number | null;
  echo: number;
  holdMs: number;
}

export const ACK_BYTES = 22;

export function encodeAck(a: Ack): Buffer {
  const b = Buffer.alloc(ACK_BYTES);
  b.writeUInt32BE(a.seq >>> 0, 0);
  b.writeUInt32BE(a.got >>> 0, 4);
  b.writeUInt32BE(Math.max(0, Math.min(0xffffffff, Math.round(a.rwnd))), 8);
  b.writeInt32BE(a.owdMin === null ? NO_DELAY : Math.max(NO_DELAY + 1, Math.min(0x7fffffff, Math.round(a.owdMin))), 12);
  b.writeUInt32BE(a.echo >>> 0, 16);
  b.writeUInt16BE(Math.min(65535, Math.max(0, Math.round(a.holdMs))), 20);
  return b;
}

export function decodeAck(b: Buffer): Ack | null {
  if (b.length < ACK_BYTES) return null;
  const owd = b.readInt32BE(12);
  return { seq: b.readUInt32BE(0), got: b.readUInt32BE(4), rwnd: b.readUInt32BE(8),
           owdMin: owd === NO_DELAY ? null : owd, echo: b.readUInt32BE(16), holdMs: b.readUInt16BE(20) };
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

/**
 * CATALOG: the images ready to be viewed, as JSON, cut into parts that each fit a datagram.
 *    0  u16 part   2  u16 parts   4  JSON text (the parts joined make the whole)
 */
export const CATALOG_HEAD = 4;
const CATALOG_PART = MAX_DATAGRAM - HEADER - CATALOG_HEAD;

export function encodeCatalog(json: string): Buffer[] {
  const text = Buffer.from(json, "utf8");
  const parts = Math.max(1, Math.ceil(text.length / CATALOG_PART));
  return Array.from({ length: parts }, (_, i) => {
    const piece = text.subarray(i * CATALOG_PART, (i + 1) * CATALOG_PART);
    const b = Buffer.alloc(CATALOG_HEAD + piece.length);
    b.writeUInt16BE(i, 0);
    b.writeUInt16BE(parts, 2);
    piece.copy(b, CATALOG_HEAD);
    return b;
  });
}

export function decodeCatalogPart(b: Buffer): { part: number; parts: number; text: Buffer } {
  return { part: b.readUInt16BE(0), parts: b.readUInt16BE(2), text: b.subarray(CATALOG_HEAD) };
}
