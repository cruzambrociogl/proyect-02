// The protocol's messages. Every UDP datagram is one message:
//
//   0  'S' 'P'   magic
//   2  u8        version
//   3  u8        type
//   4  u32       epoch: raised by the viewer on every change of view, so the server can drop
//                anything still queued for an older one
//   8  u32       payload length
//  12  payload
//
// All integers are big-endian. Datagrams stay under MAX_DATAGRAM so they never fragment.

export const VERSION = 1;
export const HEADER = 12;
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
  out.set(payload, HEADER);
  return out;
}

export interface Message {
  type: number;
  epoch: number;
  payload: Buffer;
}

/** A datagram to a message, or null if it is not one of ours. */
export function decode(datagram: Buffer): Message | null {
  if (datagram.length < HEADER || datagram[0] !== 0x53 || datagram[1] !== 0x50) return null;
  if (datagram[2] !== VERSION) return null;
  const length = datagram.readUInt32BE(8);
  if (HEADER + length > datagram.length) return null;
  return { type: datagram[3], epoch: datagram.readUInt32BE(4), payload: datagram.subarray(HEADER, HEADER + length) };
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

/** REPORT: running totals of what arrived. Also the session's keepalive. */
export interface Report {
  packets: number;
  bytes: number;
}

export function encodeReport(r: Report): Buffer {
  const b = Buffer.alloc(8);
  b.writeUInt32BE(r.packets >>> 0, 0);
  b.writeUInt32BE(r.bytes >>> 0, 4);
  return b;
}

export function decodeReport(b: Buffer): Report {
  return { packets: b.readUInt32BE(0), bytes: b.readUInt32BE(4) };
}
