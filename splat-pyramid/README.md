# splat-pyramid v2

Gigapixel viewer: splats for the coarse zoom levels, exact image tiles near 1:1, carried
over our own protocol on UDP. The design and the build order are in [PLAN.md](PLAN.md);
everything built before v2 is in [prototype/](prototype/).

## Run

```sh
npm install
npm run build                                   # compile the viewer (TypeScript -> viewer/dist)
pip install -r requirements.txt                 # the Python preprocessing (numpy, scipy, Pillow;
                                                #   pyvips and torch optional)
node server/main.ts                             # server: UDP 9000, server site on http://localhost:8000/
node client/main.ts --server 127.0.0.1:9000     # client half, on the viewer's machine
```

**Server site**, http://localhost:8000/: upload images (streamed to disk, any size) or drop
them into `originals/`, press **Prepare** (the Python preprocessing runs in the background,
one image at a time, with its progress on the page), and see what is being served. Prepared
images go to `data/` and are served as soon as they are ready.

**Client site**, http://127.0.0.1:8090/: the gallery of the images the server has ready
(the list travels over our protocol, LIST and CATALOG; only the thumbnails come from the
server site over HTTP). Click one to open it in the viewer, or go straight to
`/?image=NAME`. `#x=..&y=..&z=..` in the address opens on a spot.

Server options: `--images data`, `--originals originals`, `--http 8000`, `--port 9000`,
`--python python3` (the Python with the preprocessing's requirements), `--rate 50` (upload
cap, Mbit/s). Images can also be prepared by hand: `python3 -m splatpyr ingest IMAGE
data/NAME` then `python3 -m splatpyr build data/NAME`.

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
| `server/` | UDP server: sessions and their job plan, packet cache, pacing, run-and-tumble (`tumble.ts`), Apollonius, the server site (`admin.ts`, `admin.html`) |
| `client/` | client half: the protocol side (`link.ts`) and the browser bridge (`main.ts`) |
| `viewer/` | WebGL viewer (TypeScript in `src/`, compiled to `dist/`), sandpile cache, gallery page |
| `bench/` | sessions over emulated links (`run.ts`), several users (`users.ts`), cache policies (`cache.ts`), loss softness (`softness.py`) |
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
   | jump / LAN | 0.16 s (0.16) | 0.10 s |
   | jump / home | 0.57 s (0.59) | 0.59 s (0.65) |
   | jump / mobile | 4.64 s (5.62) | 3.61 s (4.06) |
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

5. Apollonius (multiple users): built, no measured gain in any of its uses. Every user is a pursuer (position =
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

   Pursuer speed also shares the server's upload when users want more than it can send: each
   busy user gets a share in proportion to 1 / (1 + speed), speed being how fast it is
   moving right now (a 150 ms memory, so a user who just jumped counts as standing still).
   Measured with `bench/users.ts --scenario mixed` (one user sweeping across the image at 3
   screens a second, two jumping to their own spot and staying, server capped at 10 Mbit/s):
   no reliable gain, 5 runs each, time until sharp for the two who stay:

   | per-user rates | Apollonius | equal shares |
   |---|---|---|
   | run-and-tumble | 1.56 s / 0.93 s | 1.69 s / 0.57 s |
   | fixed at the cap | 1.38 s / 0.68 s | 1.76 s / 0.53 s |

   The reason is that the protocol already does what the weighting was for: every new view
   raises the epoch and the server drops what was still queued for the old one, so a user
   sweeping across the image never builds a backlog and takes little of the upload anyway.

6. Sandpile cache (browser memory): done. Everything the viewer holds, blobs and tiles, stays
   under one 32 MB budget. Units are sites of a sandpile (neighbours: the 4 next to them on
   their level, the one above, the ones below); every frame drops grains on what is on
   screen, topplings carry them to the neighbours a pan reaches next and up to the coarse
   levels every view rests on, and over the budget the units with the least activity per
   byte are evicted (and reported to the server). `bench/cache.ts` compares it with plain
   LRU on scripted sessions: zig-zagging over bills.jpg at 1:1 with 32 MB it downloads again
   1.2 MB instead of 4.3 MB (8.1 MB in all instead of 11.2); coming back after panning away,
   0.1 MB instead of 0.6. Going A, B, then A again the two are the same.

   In a real browser, a 72-drag pan over the whole image at 1:1 kept memory between 28.7
   and 31.9 MB through 643 evictions. (The two full-screen half-float targets the viewer
   composes into are on top, constant: about 11 MB each at 1600 x 900.)

   The canvas has a pixel budget: the screen's own density, at most 2x and at most what keeps
   it under 2 megapixels (a phone gets 2x, a large laptop screen about 1.2x); the browser
   scales it up the rest of the way. Before this it was drawn at CSS pixels, which left a
   3x phone soft (stretched 3x), and before that at device pixels:
   Drawn at device pixels, a 2x (Retina) screen took 4x everything: the two targets were
   93 MB of GPU memory at 3438 x 1690, and one screenful of tiles could need more than the
   whole budget, so the cache evicted what the next frame needed and fetched it again (a
   test session received 104.8 MB with 11,293 evictions). At CSS pixels, 8 zooms in and out
   on an emulated 2x screen received 8.5 MB with 325 evictions, and the targets take 23 MB.
   The cost: on such a screen 1:1 is 2x magnified (drawn pixelated when "exact pixels" is on).

   Behind the sandpile there is a second level: what it evicts from the GPU is kept in
   memory as it arrived (tile files, splat records: 10-40x smaller than decoded), under a
   48 MB budget, and rebuilt from there when a view needs it again; only what leaves this
   level too is reported to the server. Zooming into the same four spots of bills.jpg twice
   on an emulated 2x laptop screen: 6.41 MB received in the first round, nothing in the
   second, although the GPU level evicted 925 units along the way.

   Also cut: blobs are held on the GPU as their raw 11-byte records, decoded in the vertex
   shader, instead of 32 bytes of floats; tiles have no mipmaps; and a view draws the coarser
   level from 1.68 image pixels per screen pixel on instead of 2 (at most 1.19x
   magnification), so a frame never holds more than 2.8x the screen's pixels instead of 4x.
   Together they took the simulated peak from 51.5 MB to 31.5 MB.

## v2 against v1

`bench/versus.ts` runs both versions in the same headless Chrome with the same synthetic input
(open holbein_8000.jpg, 7011 x 8000; wheel-zoom to 1:1; zig-zag with drags; wheel back out),
over the same emulated link (applied on the server's side, as v1 does it). v2's window is the
size of v1's canvas and both clamp the camera the same way, so both show exactly the same
part of the image at every moment. `bench/versus_quality.py` scores screenshots of the canvas,
taken 0.5, 2 and 5 s after each phase, against the original cropped to the camera the viewer
reports. Medians of 3 runs each; links: lan 100 Mbit/s 1 ms, home 20 Mbit/s 30 ms 0.5% loss,
mobile 2 Mbit/s 120 ms 1% loss.

What the user sees, PSNR against the original (dB):

| link | version | open 0.5 s | open 2 s | 1:1 zoom 0.5 s | pan 0.5 s | whole image again 0.5 s |
|---|---|---|---|---|---|---|
| lan | v1 | 28.4 | 28.4 | 35.0 | 34.3 | 28.4 |
| lan | v2 | **32.0** | **32.6** | 35.0 | 34.3 | **32.6** |
| home | v1 | 28.4 | 28.4 | 35.0 | 34.3 | 28.4 |
| home | v2 | **30.7** | **32.6** | 35.0 | 34.3 | **32.6** |
| mobile | v1 | 15.1 | 28.4 | 28.7 | 29.1 | 28.4 |
| mobile | v2 | **20.5** | **29.5** | **32.8** | **34.3** | **32.6** |

At 1:1 both show the same exact pixels once loaded (35.0 and 34.3 dB are the JPEG tiles
themselves). Zoomed out, v2's splats are 4.2 dB closer to the original than v1's tiles. On
every link v2 is ahead or level at every moment: on the mobile link, half a second after
zooming in it shows 32.8 dB where v1 shows 28.7, and after the pan 34.3 against 29.1. (v2's
rate controller used to start at 1 Mbit/s, which left its opening view blurry for the first
half second on fast links, 21.8 dB; it now starts at 4 Mbit/s. v2 rows are from after that
change, v1 rows from the same session as before.)

The browser's side:

| link | version | received MB | messages sent | peak memory held | JS heap |
|---|---|---|---|---|---|
| lan | v1 | 8.27 | 57 | 50.0 MB | 1.1 MB |
| lan | v2 | **3.29** | 55 | **31.9 MB** | 2.4 MB |
| home | v1 | **2.62** | 57 | 47.4 MB | 1.1 MB |
| home | v2 | 3.20 | 57 | **31.9 MB** | 2.2 MB |
| mobile | v1 | 0.59 | 57 | 13.0 MB | 1.4 MB |
| mobile | v2 | 1.60 | 54 | 24.5 MB | 1.7 MB |

On the fast link v2 receives 60% less for the same session. On the slower links v2 receives
more because it gets more through: that is the quality lead in the first table. Memory stays
under v2's 32 MB budget against v1's 50. Both send about the same number of messages (one per
view change). None of these 18 runs failed to load; v1 is known to show a black page now and
then until reloaded, which the scorer counts separately when it happens.

