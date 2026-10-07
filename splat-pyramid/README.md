# splat-pyramid v2

Gigapixel viewer: splats for the coarse zoom levels, exact image tiles near 1:1, carried
over our own protocol on UDP. The design and the build order are in [PLAN.md](PLAN.md);
everything built before v2 is in [prototype/](prototype/).

The protocol document (Spanish): [docs/protocolo-sp.md](docs/protocolo-sp.md), also as
[PDF](docs/protocolo-sp.pdf). Both are exported from the working copy in Claude Docs; edit
there and export again rather than editing these files by hand.

## Run

```sh
npm install
npm run build                                   # compile the viewer (TypeScript -> viewer/dist)
pip install -r requirements.txt                 # the Python preprocessing (numpy, scipy, Pillow;
                                                #   pyvips and torch optional)
node server/main.ts                             # server: UDP 9000, server site on http://localhost:8000/
node client/main.ts --server 127.0.0.1:9000     # client half, on the viewer's machine
```

Everything the browser loads comes from the **server site** over HTTP; the image itself comes
over our protocol, through the client half, which the pages reach on a local WebSocket
(`ws://127.0.0.1:8090`). The client half serves no pages: its own address redirects to the
server site.

- http://localhost:8000/ : the images the server has ready (the list travels over our
  protocol, LIST and CATALOG, through the client half; the thumbnails come over HTTP).
  Click one to open it in the viewer, or go straight to `/view?image=NAME`.
  `#x=..&y=..&z=..` in the address opens on a spot.
- http://localhost:8000/admin : upload images (streamed to disk, any size) or drop them into
  `originals/`, press **Prepare** (the Python preprocessing runs in the background, one
  image at a time, with its progress on the page), and see what is being served. Prepared
  images go to `data/` and are served as soon as they are ready.

A client half on another port: add `?client=127.0.0.1:PORT` to the page's address. It only
accepts pages from the server's host and this machine (`--origins` adds others).

Through a tunnel (VS Code port forwarding, for instance): the client half must accept the
tunnel's host, `--origins NAME-8000.use.devtunnels.ms`, or any tunnel's, whose address
changes every time: `--origins "*.devtunnels.ms"`. A browser on this machine needs
nothing else. A browser on another device has no client half of its own: start the client
half with `--proxy` and forward only port 8090; it passes the server site's pages through
and the pages connect back to it on the same address (wss:// through the tunnel). Without
`--proxy`, forward 8090 too and open
`https://NAME-8000.use.devtunnels.ms/?client=NAME-8090.use.devtunnels.ms`.

Server options: `--images data`, `--originals originals`, `--http 8000`, `--port 9000`,
`--python python3` (the Python with the preprocessing's requirements), `--rate 50` (upload
cap, Mbit/s). Images can also be prepared by hand: `python3 -m splatpyr ingest IMAGE
data/NAME` then `python3 -m splatpyr build data/NAME`.

Both server and client half take `--impair SPEC` to emulate a bad path: a profile (`lan`,
`home`, `mobile`) or e.g. `loss=2%,delay=30ms,jitter=5ms,rate=20mbit` (see
`shared/emulator.ts`). The server's `--fixed` sends at exactly `--rate`, with no rate
control, for comparison. `--multi physarum|apollonius|none` picks the model of several
users (Physarum by default).

`npm run check` type-checks everything.

## Measure

```sh
node bench/run.ts --session jump --repeat 5     # scripted sessions over emulated links
python3 bench/softness.py data/bills 2          # what losing splat packets does to the image
node bench/cache.ts --image bills               # browser cache: forgetting curve, sandpile, LRU
node bench/users.ts --scenario spread --cache 2 # several users: Physarum, Apollonius, none
```

## Where things are

| folder | what |
|---|---|
| `splatpyr/` | preprocessing (Python): ingest, splat fitting (loss-aware on the detail levels) |
| `shared/` | message format (`wire.ts`), units as packets (`units.ts`), network emulator |
| `server/` | UDP server: sessions and their job plan, packet cache, pacing, run-and-tumble (`tumble.ts`), Physarum (and Apollonius, for comparison), the server site (`admin.ts`, `admin.html`) |
| `client/` | client half: the protocol side (`link.ts`) and the browser bridge (`main.ts`) |
| `viewer/` | WebGL viewer (TypeScript in `src/`, compiled to `dist/`), forgetting-curve cache (and the sandpile, for comparison), gallery page |
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

7. Tiles at every level. Splats alone lost fine, low-contrast texture when zoomed out (the
   big Holbein's carpet, fur and wall came out smooth): the fitter judges by average error,
   and texture barely moves an average (an empty level-4 unit still scored 32 dB while
   keeping 24% of the original's pixel-to-pixel detail). Now every level is also cut into
   image tiles, and the view at rest is always the tiles; the splats are the layer that
   arrives first (the most important chunk of every unit goes before any tile), fills the
   screen while tiles load, and survives loss. For the big Holbein the coarse levels 7-3
   add 272 tiles, 3.1 MB; its zoomed-out view takes 2.27 MB to arrive in full.
   `splatpyr build` adds the missing tile levels to images prepared before this, without
   fitting again.

Control messages (HELLO, OPEN, the latest VIEW) are resent until answered, so a lost or
reordered one no longer leaves the viewer waiting.

4b. Sliding window, flow control and slow start (TCP's mechanisms, adapted). Every data packet
   carries a sequence number (header, 20 bytes, version 2), and the client half answers with
   ACK (type 15) after every 16 data packets: the highest sequence number received, data
   packets received, and the receive window. The server keeps what is in flight within
   min(cwnd, rwnd):

   - **Flow control (rwnd)**: the viewer reports what it has fully handled (drawn, or decoded
     for a tile), and the window is a 2 MB receive buffer minus what it has not. A page that
     stops handling data stopped the server at exactly 2.00 MB; it resumed on catching up.
   - **Congestion window**: during slow start, the slow-start window; after it, 2 x rate x
     (minimum RTT + ACK delay), from the minimum RTT so the queue stays within a round trip.
     A timeout (3 RTT, at least 200 ms) takes everything in flight as lost, leaves a window
     of one packet and doubles at each further timeout (RFC 6298): a client that went silent
     got 12 KB and a few probes in 10 s, against 707 KB in 3 s without the window.
   - **Slow start**: 10 packets, doubling per round trip, paced at twice the window. It ends
     on a queue (HyStart++, with Conservative Slow Start so jitter does not end it), on loss
     and a flat delivery rate together (a link that drops instead of queueing), or after 3
     clean round trips at the server's cap. Run-and-tumble takes over at the most that was
     delivered over two round trips. After 10 s idle it starts again, up to the old rate.

   `--window off` sends by rate alone, for comparison. The old opening (a fixed 4 Mbit/s, then
   run-and-tumble's "first run" with long steps) was removed once slow start measured as well.
   `bench/run.ts` on bigbig.png, medians of 5 runs (mobile: 9), time until sharp, MB sent,
   packets dropped by a full queue:

   | session | link | window + slow start | rate only, fixed 4 Mbit/s start (before) |
   |---|---|---|---|
   | jump | lan | **0.08 s**, 0.55 MB, 0 | 0.29 s, 0.55 MB, 0 |
   | jump | home | **0.51 s**, 0.56 MB, 0 | 0.56 s, 0.55 MB, 0 |
   | jump | mobile | 2.31 s, **0.64 MB**, **32** | 2.19 s, 0.80 MB, 134 |
   | dive | lan | 0.02 s, 6.86 MB, 0 | 0.02 s, 6.02 MB, 0 |
   | dive | home | **0.25 s**, **4.34 MB**, **0** | 0.29 s, 5.15 MB, 649 |
   | dive | mobile | **2.46 s**, **1.02 MB**, **80** | 2.56 s, 1.83 MB, 743 |

   Same speed or faster everywhere but the mobile jump (0.1 s slower), with far less waste on
   the links that lose packets. Tried and dropped on the way: handing over the average
   delivery rate (too low, the mobile link stayed at 1.3 Mbit/s), BBR's full-pipe exit alone
   (bunched ACKs fooled it), loss alone (bursts of random loss ended slow start early), a
   window from the smoothed RTT (it grew with the queue), and a waste term in run-and-tumble's
   score (sessions end before it acts).

5. Physarum (multiple users): the server's model of several users, `--multi physarum`
   (default). Tero and Nakagaki's slime-mould model: tubes whose conductance grows with the
   flow through them and decays without it (`server/physarum.ts`). Two uses:

   - Server packet cache: every cached unit is a node, its conductance the bytes served
     from it to anyone (half-life 10 s); over the budget the least conductance per byte goes
     first. With a 2 MB cache, 3 users, `bench/users.ts`, 5 runs each (medians), disk reads:

     | scenario | Physarum | Apollonius | none (LRU) |
     |---|---|---|---|
     | converge | **363** | 507 | 497 |
     | spread | **8,223** | 14,766 | 16,781 |

     Times until sharp stay the same (within noise). With the default 8 MB cache all three
     read the same: at that size LRU already keeps everything the users share.
   - Server upload, when its cap is what binds: one tube per user, each busy user gets a
     share in proportion to its conductance. Useful flow grows a tube: bytes of a tile, or of
     a chunk of a splat unit, sent whole while the user's view still wanted it; bytes of a
     unit the user moved away from first were wasted. With f(Q) = Q^(1/2) the tubes settle in
     proportion to how useful their flow has been, and none closes (floor 0.1). Measured with
     `--scenario mixed --rate 10` (one user sweeping at 3 screens a second, two stopping):
     the tubes stay close to 1, since usefulness is about 0.98 for all three. Even the
     sweeping user wastes little, because every new view drops what was queued for the old
     one (the epoch). No reliable change in times until sharp, as with Apollonius.
     (`TUBES=1 node bench/users.ts ...` prints the tubes as they adapt.)

   Incoming messages are limited per client (60/s, bursts of 120).

   Circles of Apollonius, the model before this one, is kept as `--multi apollonius`: every
   user is a pursuer (position = its view, speed = how fast it pans and zooms), the time to
   reach a unit is distance over speed, and the cache evicts first what nobody can reach
   within 2 s; the upload goes in proportion to 1 / (1 + speed). It measured no gain in any
   of its uses. Warming the units several users converged on, and prefetching each user's
   predicted path, were tried with it and dropped (more disk reads; on the 75k image 3 MB
   more per session and views sharp later).

6. Forgetting-curve cache (browser memory): Ebbinghaus's curve, as spaced-repetition
   software uses it (`viewer/src/forgetting.ts`). Everything the viewer holds, blobs and
   tiles, stays under one 32 MB budget. Every unit is a memory with retention exp(-t / S);
   being on screen is a review, and coming back after being away makes the memory more
   stable, more so the more had been forgotten (the spacing effect). A first sight starts
   with S = 4 s, doubled per level up (coarse units sit under every view of their area).
   Over the budget the least retention per byte goes first (and is reported to the server).
   Tried and left out: associative recall (a review also partly reviews the coarser unit
   and the neighbours), neutral.

   `bench/cache.ts` replays scripted sessions against it, the Abelian sandpile it replaces
   (`viewer/src/sandpile.ts`, kept for comparison) and plain LRU. MB downloaded again,
   budget 32 MB:

   | session | image | forgetting | sandpile | LRU |
   |---|---|---|---|---|
   | pan away, come back | bills | **0.4** | **0.4** | 0.8 |
   | A, B, then A again | bills | 7.2 | **6.6** | 11.7 |
   | zig-zag at 1:1 | bills | **1.6** | **1.6** | 4.4 |
   | pan away, come back | Holbein | **2.6** | 2.9 | 2.9 |
   | A, B, then A again | Holbein | **20.2** | 20.6 | 23.9 |
   | zig-zag at 1:1 | Holbein | 9.2 | **9.1** | 10.2 |

   The forgetting curve matches the sandpile (within 0.6 MB either way at 16, 32 and 48 MB)
   and both beat LRU. The per-byte choice is what matters most: by retention alone it is
   LRU. (The sandpile: every unit a site, grains dropped on what is on screen, topplings
   carry them to the neighbours and the coarser units, the least activity per byte evicted.)

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

   Behind the first level there is a second: what it evicts from the GPU is kept in
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

## How far zooming in goes

An image's pixel count is not its resolution. At ingest, `splatpyr/detail.py` shrinks a sample
of the finest tiles by 2, 4 and 8, enlarges them back, and finds where they stop coming back
close (30 dB): the **detail scale**, image pixels per unit of real detail. The server sends it
in CHART, and the viewer stops when one unit of real detail covers 16 screen pixels (never
short of 1:1). `python3 -m splatpyr detail data/NAME` measures an image prepared before this.

| image | 2x / 4x / 8x back (dB) | detail scale | zoom limit |
|---|---|---|---|
| bigbig.png (digits 1 px wide) | 9.5 / 7.8 / 7.7 | 1.00 | 16x |
| Holbein (scan softer than its pixels) | 32.0 / 29.7 / 28.3 | 3.62 | 4.4x |
| bills.jpg (enlarged photo) | 42.8 / 34.9 / 27.2 | 6.22 | 2.6x |

Before, every image stopped at 8x: bigbig's digits could have gone further, and the Holbein
turned to blur well before.

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

