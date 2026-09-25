// The erasure code (from v1, ported): repair without knowing what was lost.
//
// A unit's packets are grouped in blocks of at most MAX_K (for a splat unit, one block per
// importance chunk). Within a block the code is systematic: symbols 0..k-1 are the packets
// themselves, so a receiver that loses nothing never decodes anything, and a confetti packet
// is drawn the moment it lands. Symbols k and up are repair symbols: each a mixture of all k
// packets over GF(256), with coefficients derived from the symbol's number, so both ends
// generate them identically and a repair symbol carries only its number.
//
// Any k independent symbols rebuild the block, whichever they are. So the receiver reports
// only how many it is still short per block, and the sender sends that many fresh repair
// symbols: no list of lost packets, no acknowledgements, and no packet sent twice.
//
// Packets of a block differ in length, so each is framed as a symbol of the block's width:
// a u16 length, the packet, zero padding.

export const MAX_K = 64;

// ---------------------------------------------------------------------------------------
// GF(256), polynomial x^8 + x^4 + x^3 + x^2 + 1
// ---------------------------------------------------------------------------------------

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let v = 1;
  for (let p = 0; p < 255; p++) {
    EXP[p] = v;
    LOG[v] = p;
    v <<= 1;
    if (v & 0x100) v ^= 0x11d;
  }
  for (let p = 255; p < 512; p++) EXP[p] = EXP[p - 255];
}
/** PRODUCT[a * 256 + b] = a * b: every multiply is one lookup. */
const PRODUCT = new Uint8Array(256 * 256);
for (let a = 1; a < 256; a++) for (let b = 1; b < 256; b++) PRODUCT[a * 256 + b] = EXP[LOG[a] + LOG[b]];
const inverse = (a: number): number => EXP[255 - LOG[a]];

/** dst ^= src * factor, over a whole symbol. The inner loop of everything here. */
function multiplyAdd(dst: Uint8Array, src: Uint8Array, factor: number): void {
  if (factor === 0) return;
  const row = factor * 256;
  for (let i = 0; i < dst.length; i++) dst[i] ^= PRODUCT[row + src[i]];
}

function scale(dst: Uint8Array, factor: number): void {
  const row = factor * 256;
  for (let i = 0; i < dst.length; i++) dst[i] = PRODUCT[row + dst[i]];
}

/**
 * Coefficients of repair symbol `index` over a block of k: never zero (a zero would leave a
 * packet out of the mixture). A small fixed mixer, so both ends get the same bytes.
 */
export function coefficients(index: number, k: number): Uint8Array {
  const out = new Uint8Array(k);
  let s = (Math.imul(index + 1, 0x9e3779b1) ^ 0x85ebca6b) >>> 0;
  for (let i = 0; i < k; i++) {
    s = (s + 0x6d2b79f5) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    const v = ((z ^ (z >>> 14)) >>> 0) & 0xff;
    out[i] = v === 0 ? 1 : v;
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// framing and encoding
// ---------------------------------------------------------------------------------------

/** A block's symbol width: the longest packet plus its u16 length. */
export const symbolWidth = (packets: Uint8Array[]): number => 2 + Math.max(0, ...packets.map((p) => p.length));

export function frame(packet: Uint8Array, width: number): Uint8Array {
  const s = new Uint8Array(width);
  s[0] = packet.length >> 8;
  s[1] = packet.length & 0xff;
  s.set(packet, 2);
  return s;
}

export function unframe(symbol: Uint8Array): Uint8Array {
  return symbol.subarray(2, 2 + ((symbol[0] << 8) | symbol[1]));
}

/** Repair symbol `index` (>= k) of a block, from its framed source symbols. */
export function repairSymbol(framed: Uint8Array[], index: number): Uint8Array {
  const k = framed.length;
  const out = new Uint8Array(framed[0].length);
  const c = coefficients(index, k);
  for (let i = 0; i < k; i++) multiplyAdd(out, framed[i], c[i]);
  return out;
}

// ---------------------------------------------------------------------------------------
// decoding
// ---------------------------------------------------------------------------------------

/**
 * Rebuilds one block from whatever symbols arrive. Every symbol is one linear equation in the
 * k unknown packets; each is eliminated against those already held as it arrives, so the
 * work is spread over the transfer, and one that adds nothing (a duplicate, a dependent
 * mixture) is dropped at once. With k independent equations the block is solved.
 */
export class BlockDecoder {
  readonly k: number;
  readonly width: number;
  private rows: (Uint8Array | null)[];
  private values: (Uint8Array | null)[];
  private known = 0;
  private have = new Set<number>();     // source symbols that arrived as themselves

  constructor(k: number, width: number) {
    this.k = k;
    this.width = width;
    this.rows = new Array(k).fill(null);
    this.values = new Array(k).fill(null);
  }

  get complete(): boolean { return this.known === this.k; }
  get rank(): number { return this.known; }
  get missing(): number { return this.k - this.known; }

  /** Take symbol `index`. True if it taught us something new. */
  accept(index: number, symbol: Uint8Array): boolean {
    if (this.complete) return false;
    if (index < this.k) this.have.add(index);
    let row: Uint8Array;
    if (index < this.k) {
      row = new Uint8Array(this.k);
      row[index] = 1;
    } else {
      row = coefficients(index, this.k);
    }
    const value = new Uint8Array(this.width);
    value.set(symbol.subarray(0, this.width));
    for (let p = 0; p < this.k; p++) {
      const f = row[p];
      if (f === 0) continue;
      const pivot = this.rows[p];
      if (!pivot) {
        const inv = inverse(f);
        scale(row, inv);
        scale(value, inv);
        this.rows[p] = row;
        this.values[p] = value;
        this.known++;
        return true;
      }
      multiplyAdd(row, pivot, f);
      multiplyAdd(value, this.values[p]!, f);
    }
    return false;
  }

  /**
   * Once complete: the source symbols that never arrived as themselves, rebuilt, as
   * [index, framed symbol]. Back substitution over the echelon rows.
   */
  recovered(): [number, Uint8Array][] {
    if (!this.complete) return [];
    for (let p = this.k - 1; p >= 0; p--) {
      for (let r = 0; r < p; r++) {
        const f = this.rows[r]![p];
        if (f === 0) continue;
        multiplyAdd(this.rows[r]!, this.rows[p]!, f);
        multiplyAdd(this.values[r]!, this.values[p]!, f);
      }
    }
    const out: [number, Uint8Array][] = [];
    for (let i = 0; i < this.k; i++) if (!this.have.has(i)) out.push([i, this.values[i]!]);
    return out;
  }
}
