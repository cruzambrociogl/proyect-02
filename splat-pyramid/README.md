# splat-pyramid v2

Gigapixel viewer: splats for the coarse zoom levels, exact image tiles near 1:1, carried
over our own protocol on UDP. The design and the build order are in [PLAN.md](PLAN.md);
everything built before v2 is in [prototype/](prototype/).

## Run

```sh
npm install
npm run build                                   # compile the viewer (TypeScript -> viewer/dist)
python3 -m splatpyr ingest IMAGE data/NAME      # prepare an image (needs numpy, scipy, Pillow;
python3 -m splatpyr build data/NAME             #   pyvips and torch optional, see requirements.txt)
node server/main.ts --images data               # server: UDP port 9000, upload cap 50 Mbit/s
node client/main.ts --server 127.0.0.1:9000     # client half, on the viewer's machine
```

Then open http://127.0.0.1:8090/?image=NAME. `#x=..&y=..&z=..` in the address opens on a
spot (z = screen pixels per image pixel).

Both server and client half take `--impair SPEC` to emulate a bad path: a profile (`lan`,
`home`, `mobile`) or e.g. `loss=2%,delay=30ms,jitter=5ms,rate=20mbit` (see
`shared/emulator.ts`). The server's `--fixed` sends at exactly `--rate`, with no rate
control, for comparison.

`npm run check` type-checks everything.

## Measure

```sh
node bench/run.ts --session jump --repeat 5     # scripted sessions over emulated links
python3 bench/softness.py data/bills 2          # what losing splat packets does to the image
```

## Where things are

| folder | what |
|---|---|
| `splatpyr/` | preprocessing (Python): ingest, splat fitting (loss-aware on the detail levels) |
| `shared/` | message format (`wire.ts`), units as packets (`units.ts`), network emulator |
| `server/` | UDP server: sessions and their job plan, packet cache, pacing, run-and-tumble (`tumble.ts`) |
| `client/` | client half: the protocol side (`link.ts`) and the browser bridge (`main.ts`) |
| `viewer/` | WebGL viewer (TypeScript in `src/`, compiled to `dist/`) |
| `bench/` | session benchmark and loss-softness measurement |
| `prototype/` | everything built before v2, untouched |

## Status

Following [PLAN.md](PLAN.md):

1. Walking skeleton: done.
2. Confetti delivery and the emulator: done. Splat units travel as confetti packets, one
   count per unit comes back, repairs use idle capacity; the base unit is always repaired
   first. The most important chunk of every unit goes first. Detail levels are fitted
   loss-aware: at 1% loss the drawn image loses 0.4 dB instead of 3.1.
3. Run-and-tumble: working. Medians of 7 runs (jump) and 5 (dive), time until sharp:

   | session / link | run-and-tumble (worst run) | best fixed rate, picked by hand per link |
   |---|---|---|
   | jump / LAN | 0.18 s (0.18) | 0.10 s |
   | jump / home | 0.53 s (0.57) | 0.59 s (0.65) |
   | jump / mobile | 5.28 s (5.82) | 3.61 s (4.06) |
   | dive / LAN | 0.41 s (0.41) | 0.02 s |
   | dive / home | 0.73 s (0.86) | 0.24 s |
   | dive / mobile | 3.06 s (3.63) | 2.86 s |

   It finds each link's rate on its own (on mobile it settles at the link's 2 Mbit/s) and
   beats the hand-picked rate on the home link. Known weak spots: the long first run
   overshoots before the queue shows (about 200 queue drops a session on home and mobile,
   repaired by the erasure code), and it does not grow while the viewer is between views.
4. Erasure code (plan step 7, brought forward): done. Every block of a unit (a splat chunk,
   or up to 64 tile parts) is repaired with fresh symbols, exactly as many as the client's
   count says it is short, whichever packets were lost. Repair traffic on the home link fell
   from 0.34 MB to 0.03 MB per session. `npm test` checks the code on its own.

Control messages (HELLO, OPEN, the latest VIEW) are resent until answered, so a lost or
reordered one no longer leaves the viewer waiting.

5. Apollonius (multiple users): built, no measured gain. Every user is a pursuer (position =
   its view, speed = how fast it has been panning and zooming); the time to reach a unit is
   distance over speed, and between two users the Apollonius circle splits who gets there
   first. The server's shared packet cache evicts first what no user can reach within 2 s.
   Incoming messages are limited per client (60/s, bursts of 120).

   `bench/users.ts` runs 3 users at once (converging on one spot, or spread out). On
   bills.jpg and on the 75k x 75k image the eviction policy performs the same as plain LRU:
   at these sizes LRU already shares every unit among the users. Two other uses were tried
   and dropped: warming the units several users converged on (it read more from disk, since
   during a zoom most views are replaced before anything is sent), and prefetching each
   user's predicted path on idle capacity (on the 75k image, 3 MB more per session and
   views sharp later: 0.25 s against 0.19 s).

Next: the sandpile cache (memory).
