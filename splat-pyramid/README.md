# splat-pyramid v2

Gigapixel viewer: splats for the coarse zoom levels, exact image tiles near 1:1, carried
over our own protocol on UDP. The design and the build order are in [PLAN.md](PLAN.md);
everything built before v2 is in [prototype/](prototype/).

## Run

```sh
npm install
npm run build                                   # compile the viewer (TypeScript -> viewer/dist)
node server/main.ts --images prototype          # server: UDP port 9000, 50 Mbit/s fixed rate
node client/main.ts --server 127.0.0.1:9000     # client half, on the viewer's machine
```

Then open http://127.0.0.1:8090/?image=NAME, where NAME is a prepared image folder under
`--images` (with `prototype`: `out` is bills.jpg, `big` is the 75k x 75k digits image).
`#x=..&y=..&z=..` in the address opens on a spot (z = screen pixels per image pixel).

Images are prepared with the prototype's Python tools (`prototype/splatpyr`, see
[prototype/README.md](prototype/README.md)): `python3 -m splatpyr ingest IMAGE DIR` then
`python3 -m splatpyr build DIR`.

`npm run check` type-checks everything.

## Where things are

| folder | what |
|---|---|
| `shared/` | message format (`wire.ts`), splat units as CONFETTI packets and tiles as TILEPART packets (`units.ts`) |
| `server/` | UDP server: sessions, which units a view needs, shared packet cache, pacing |
| `client/` | client half: UDP to the server, WebSocket and the viewer page to the browser |
| `viewer/` | WebGL viewer (TypeScript in `src/`, compiled to `dist/`) |

## Status

Step 1 of the plan (walking skeleton) runs end to end: one user, no loss emulation, a fixed
sending rate. Splat units already travel as confetti packets (blobs dealt across packets,
each drawn as it lands); tiles travel as plain parts, reassembled by the client half.
Next: step 2, the network emulator and loss.
