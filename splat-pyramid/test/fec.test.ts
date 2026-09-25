// The erasure code on its own: random blocks, random loss, repair until solved. Every rebuilt
// packet must match the original byte for byte, and it reports how many repair symbols were
// needed beyond the number of packets lost (0 means every repair symbol was useful).
//   node test/fec.test.ts

import { BlockDecoder, MAX_K, frame, repairSymbol, symbolWidth, unframe } from "../shared/fec.ts";

let blocks = 0, failures = 0, lostTotal = 0, repairTotal = 0;
const t0 = performance.now();
for (const k of [1, 2, 5, 13, 40, MAX_K]) {
  for (const loss of [0, 0.05, 0.3, 0.9]) {
    for (let t = 0; t < 20; t++) {
      blocks++;
      const packets = Array.from({ length: k }, () => {
        const p = new Uint8Array(200 + Math.floor(Math.random() * 1000));
        crypto.getRandomValues(p);
        return p;
      });
      const width = symbolWidth(packets);
      const framed = packets.map((p) => frame(p, width));
      const d = new BlockDecoder(k, width);
      let lost = 0;
      for (let i = 0; i < k; i++) {
        if (Math.random() >= loss) d.accept(i, framed[i]);
        else lost++;
      }
      // repair as the server does: each round, exactly as many symbols as still missing
      let next = k, sent = 0;
      while (!d.complete && sent < 4 * k + 10) {
        for (let want = d.missing; want > 0; want--, sent++) d.accept(next, repairSymbol(framed, next++));
      }
      lostTotal += lost;
      repairTotal += sent;
      if (!d.complete) { failures++; continue; }
      const rebuilt = new Map(d.recovered());
      if (rebuilt.size !== lost) failures++;
      for (const [i, s] of rebuilt) {
        const got = unframe(s);
        if (got.length !== packets[i].length || got.some((b, j) => b !== packets[i][j])) failures++;
      }
    }
  }
}
console.log(`${blocks} blocks, ${failures} failures, ${lostTotal} packets lost, ${repairTotal} repair symbols ` +
            `(${repairTotal - lostTotal} more than lost), ${(performance.now() - t0).toFixed(0)} ms`);
if (failures) process.exit(1);
