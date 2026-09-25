"""
The .spx unit file: one unit's blobs, quantised, ordered so that any prefix is usable.

  header   "SPX1"  magic
           u8      mode: 0 normalised (base level), 1 additive (detail levels)
           u8      number of chunks
           u16     unit width, u16 unit height
           u32     number of blobs
           per chunk: u32 blobs in it, u32 compressed bytes
  chunks   each one zlib-compressed, holding its blobs as 11 byte planes:
           x hi, x lo, y hi, y lo, sx, sy, theta, r, g, b, amp

All integers are big-endian. Blobs are sorted by importance (amplitude x area), largest
first, and cut into chunks at 1/8, 1/4, 1/2 and all of them, so the first chunk alone is a
coarse version of the unit and every further chunk sharpens it: a sender can put the first
chunk first and drop the tail under congestion. Inside a chunk blobs are in Morton order and
stored as planes, which is what lets deflate find the repetition.

Fields, per blob:
  x, y     u16   centre, from -POS_PAD to size + POS_PAD
  sx, sy   u8    log-quantised radii, SIGMA_MIN .. SIGMA_MAX
  theta    u8    rotation, 0 .. pi
  r, g, b  s8    colour / amp, times 127
  amp      u8    log-quantised largest colour magnitude, AMP_MIN .. AMP_MAX
"""

import math
import struct
import zlib

import numpy as np

from .blobs import SIGMA_MAX, SIGMA_MIN, Blobs

MAGIC = b"SPX1"
POS_PAD = 16.0
AMP_MIN, AMP_MAX = 1e-3, 16.0
CHUNK_FRACTIONS = (1 / 8, 1 / 4, 1 / 2, 1)
NORMALIZED, ADDITIVE = 0, 1


def _log_code(v, lo, hi):
    v = np.clip(v, lo, hi)
    return np.round(255 * (np.log(v) - math.log(lo)) / (math.log(hi) - math.log(lo)))


def _from_log(code, lo, hi):
    return np.exp(math.log(lo) + code / 255.0 * (math.log(hi) - math.log(lo)))


def _pos_code(v, size):
    lo, hi = -POS_PAD, size + POS_PAD
    return np.round((np.clip(v, lo, hi) - lo) * 65535 / (hi - lo))


def _pos_value(code, size):
    lo, hi = -POS_PAD, size + POS_PAD
    return lo + code * (hi - lo) / 65535


def quantise_geometry(b, w, h):
    """The blobs with position, size and rotation rounded to what the file carries, colours
    untouched: the fitter solves colours for exactly the shapes the viewer will draw."""
    th = np.mod(b.th, math.pi)
    return Blobs(_pos_value(_pos_code(b.x, w), w), _pos_value(_pos_code(b.y, h), h),
                 _from_log(_log_code(b.sx, SIGMA_MIN, SIGMA_MAX), SIGMA_MIN, SIGMA_MAX),
                 _from_log(_log_code(b.sy, SIGMA_MIN, SIGMA_MAX), SIGMA_MIN, SIGMA_MAX),
                 np.round(th * 255 / math.pi).clip(0, 255) * math.pi / 255, b.c)


def to_codes(b, w, h):
    """Blobs to integer fields, one row per blob, columns as in the file."""
    amp = np.abs(b.c).max(1).clip(AMP_MIN, AMP_MAX)
    qamp = _log_code(amp, AMP_MIN, AMP_MAX)
    amp = _from_log(qamp, AMP_MIN, AMP_MAX)
    qc = np.round(127 * b.c / amp[:, None]).clip(-127, 127)
    th = np.mod(b.th, math.pi)
    return np.stack([_pos_code(b.x, w), _pos_code(b.y, h),
                     _log_code(b.sx, SIGMA_MIN, SIGMA_MAX), _log_code(b.sy, SIGMA_MIN, SIGMA_MAX),
                     np.round(th * 255 / math.pi).clip(0, 255),
                     qc[:, 0], qc[:, 1], qc[:, 2], qamp], 1).astype(np.int64)


def from_codes(codes, w, h):
    q = codes.astype(np.float64)
    amp = _from_log(q[:, 8], AMP_MIN, AMP_MAX)
    return Blobs(_pos_value(q[:, 0], w), _pos_value(q[:, 1], h),
                 _from_log(q[:, 2], SIGMA_MIN, SIGMA_MAX), _from_log(q[:, 3], SIGMA_MIN, SIGMA_MAX),
                 q[:, 4] * math.pi / 255, q[:, 5:8] / 127 * amp[:, None])


def _morton(qx, qy):
    def spread(v):
        v = v.astype(np.uint64) >> np.uint64(4)          # 12 bits are plenty for ordering
        out = np.zeros_like(v)
        for bit in range(12):
            out |= ((v >> np.uint64(bit)) & np.uint64(1)) << np.uint64(2 * bit)
        return out
    return spread(qx) | (spread(qy) << np.uint64(1))


def encode(codes, w, h, mode):
    """Integer fields to the bytes of a .spx file."""
    n = codes.shape[0]
    if n:
        values = from_codes(codes, w, h)
        importance = np.abs(values.c).max(1) * values.sx * values.sy
        codes = codes[np.argsort(-importance, kind="stable")]
        ends = sorted({max(1, math.ceil(n * f)) for f in CHUNK_FRACTIONS})
    else:
        ends = []
    chunks, start = [], 0
    for end in ends:
        part = codes[start:end]
        part = part[np.argsort(_morton(part[:, 0], part[:, 1]), kind="stable")]
        planes = np.stack([part[:, 0] >> 8, part[:, 0] & 255, part[:, 1] >> 8, part[:, 1] & 255,
                           part[:, 2], part[:, 3], part[:, 4],
                           part[:, 5] & 255, part[:, 6] & 255, part[:, 7] & 255, part[:, 8]])
        chunks.append((end - start, zlib.compress(planes.astype(np.uint8).tobytes(), 9)))
        start = end
    head = MAGIC + struct.pack(">BBHHI", mode, len(chunks), w, h, n)
    head += b"".join(struct.pack(">II", count, len(data)) for count, data in chunks)
    return head + b"".join(data for _, data in chunks)


def decode(raw, max_chunks=None):
    """Bytes of a .spx file to (mode, w, h, codes, chunk ends). max_chunks reads a prefix."""
    if raw[:4] != MAGIC:
        raise ValueError("not a .spx file")
    mode, nchunks, w, h, n = struct.unpack(">BBHHI", raw[4:14])
    table = [struct.unpack(">II", raw[14 + 8 * i:22 + 8 * i]) for i in range(nchunks)]
    at = 14 + 8 * nchunks
    parts, ends, total = [], [], 0
    for i, (count, size) in enumerate(table):
        if max_chunks is not None and i >= max_chunks:
            break
        planes = np.frombuffer(zlib.decompress(raw[at:at + size]), np.uint8).reshape(11, count)
        p = planes.astype(np.int64)
        signed = np.where(p[7:10] > 127, p[7:10] - 256, p[7:10])
        parts.append(np.stack([(p[0] << 8) | p[1], (p[2] << 8) | p[3], p[4], p[5], p[6],
                               signed[0], signed[1], signed[2], p[10]], 1))
        at += size
        total += count
        ends.append(total)
    codes = np.concatenate(parts) if parts else np.zeros((0, 9), np.int64)
    return mode, w, h, codes, ends


def read_unit(path):
    """A .spx file to (mode, w, h, Blobs)."""
    with open(path, "rb") as f:
        mode, w, h, codes, _ = decode(f.read())
    return mode, w, h, from_codes(codes, w, h)
