// Units on the wire: how a splat unit becomes CONFETTI packets and an image tile becomes
// TILEPART packets.
//
// CONFETTI payload (one packet, some blobs of one splat unit):
//    0  u8   level          1  u32  x          5  u32  y
//    9  u8   mode (0 normalised base, 1 additive detail)
//   10  u16  unit width    12  u16  unit height
//   14  u32  blobs in the whole unit
//   18  u16  packet index  20  u16  packets in the whole unit
//   22  u16  blobs in this packet
//   24  blobs, 11 bytes each: x u16, y u16, sx, sy, theta, r, g, b (s8), amp (see the
//       prototype's codec.py for how each field is quantised)
//
// Blobs are dealt across a chunk's packets like cards: blob j of a chunk (in importance
// order) goes to packet j mod P. Every packet is then an even sample of its chunk, so any
// subset of packets draws the whole unit, just softer. Chunks keep their importance order:
// chunk 1's packets come first.
//
// TILEPART payload (one piece of an image tile):
//    0  u8   level          1  u32  x          5  u32  y
//    9  u8   format (0 JPEG, 1 WebP)
//   10  u32  tile bytes    14  u16  part index    16  u16  parts
//   18  data

import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { HEADER, MAX_DATAGRAM } from "./wire.ts";

export const RECORD = 11;
export const CONFETTI_HEAD = 24;
export const BLOBS_PER_PACKET = 100;
export const TILE_HEAD = 18;
export const TILE_PART = MAX_DATAGRAM - HEADER - TILE_HEAD;
export const FORMAT_JPEG = 0;
export const FORMAT_WEBP = 1;

if (HEADER + CONFETTI_HEAD + BLOBS_PER_PACKET * RECORD > MAX_DATAGRAM) {
  throw new Error("CONFETTI packets would not fit a datagram");
}

export interface SplatUnit {
  mode: number;
  w: number;
  h: number;
  records: Buffer;      // n x RECORD, in the file's order: chunk by chunk, most important first
  chunks: number[];     // blobs per chunk
}

/** Read a .spx file (see the prototype's codec.py) into interleaved 11-byte records. */
export function readSpx(path: string): SplatUnit {
  const raw = readFileSync(path);
  if (raw.toString("latin1", 0, 4) !== "SPX1") throw new Error(`${path} is not a .spx file`);
  const mode = raw[4], nchunks = raw[5];
  const w = raw.readUInt16BE(6), h = raw.readUInt16BE(8), n = raw.readUInt32BE(10);
  const records = Buffer.alloc(n * RECORD);
  const chunks: number[] = [];
  let at = 14 + 8 * nchunks, row = 0;
  for (let c = 0; c < nchunks; c++) {
    const count = raw.readUInt32BE(14 + 8 * c), size = raw.readUInt32BE(18 + 8 * c);
    const planes = inflateSync(raw.subarray(at, at + size));
    at += size;
    for (let i = 0; i < count; i++, row++) {
      for (let k = 0; k < RECORD; k++) records[row * RECORD + k] = planes[k * count + i];
    }
    chunks.push(count);
  }
  return { mode, w, h, records, chunks };
}

/**
 * A unit's packets in sending order, and where each importance chunk ends: packets
 * [ends[c-1], ends[c]) carry chunk c. An image tile is a single chunk.
 */
export interface Packets {
  packets: Buffer[];
  ends: number[];
}

/** The CONFETTI payloads of a splat unit, in sending order, chunk by chunk. */
export function confetti(level: number, x: number, y: number, u: SplatUnit): Packets {
  const n = u.records.length / RECORD;
  const plan: number[][] = [];            // per packet: the blob rows it carries
  const ends: number[] = [];
  let start = 0;
  for (const count of u.chunks) {
    const P = Math.max(1, Math.ceil(count / BLOBS_PER_PACKET));
    const packets: number[][] = Array.from({ length: P }, () => []);
    for (let j = 0; j < count; j++) packets[j % P].push(start + j);
    plan.push(...packets.filter((p) => p.length));
    ends.push(plan.length);
    start += count;
  }
  if (plan.length === 0) {                // an empty unit still says "I am complete"
    plan.push([]);
    ends.push(1);
  }
  const packets = plan.map((rows, index) => {
    const b = Buffer.alloc(CONFETTI_HEAD + rows.length * RECORD);
    b[0] = level;
    b.writeUInt32BE(x, 1);
    b.writeUInt32BE(y, 5);
    b[9] = u.mode;
    b.writeUInt16BE(u.w, 10);
    b.writeUInt16BE(u.h, 12);
    b.writeUInt32BE(n, 14);
    b.writeUInt16BE(index, 18);
    b.writeUInt16BE(plan.length, 20);
    b.writeUInt16BE(rows.length, 22);
    rows.forEach((r, i) => u.records.copy(b, CONFETTI_HEAD + i * RECORD, r * RECORD, (r + 1) * RECORD));
    return b;
  });
  return { packets, ends };
}

/** The TILEPART payloads of an image tile, in order: one chunk. */
export function tileParts(level: number, x: number, y: number, format: number, data: Buffer): Packets {
  const parts = Math.max(1, Math.ceil(data.length / TILE_PART));
  const packets = Array.from({ length: parts }, (_, i) => {
    const piece = data.subarray(i * TILE_PART, (i + 1) * TILE_PART);
    const b = Buffer.alloc(TILE_HEAD + piece.length);
    b[0] = level;
    b.writeUInt32BE(x, 1);
    b.writeUInt32BE(y, 5);
    b[9] = format;
    b.writeUInt32BE(data.length, 10);
    b.writeUInt16BE(i, 14);
    b.writeUInt16BE(parts, 16);
    piece.copy(b, TILE_HEAD);
    return b;
  });
  return { packets, ends: [packets.length] };
}

export interface TilePartHead {
  level: number;
  x: number;
  y: number;
  format: number;
  total: number;
  index: number;
  parts: number;
}

export function readTilePart(b: Buffer): TilePartHead {
  return { level: b[0], x: b.readUInt32BE(1), y: b.readUInt32BE(5), format: b[9],
           total: b.readUInt32BE(10), index: b.readUInt16BE(14), parts: b.readUInt16BE(16) };
}
