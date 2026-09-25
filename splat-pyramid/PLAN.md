# PROJECT02 v2: plan

A gigapixel image viewer whose transport protocol is designed around the image
representation. The coarse zoom levels are Gaussian splats; the levels near 1:1 are
exact image tiles. Because a splat unit is a bag of independent blobs, losing part of it
makes it slightly softer instead of leaving a hole, and the protocol is built on that fact.

Status: plan, nothing of v2 built yet. Everything built before v2 (the `splatpyr`
preprocessing, the WebGL viewer, their measurements) is kept as is in
[prototype/](prototype/); see [prototype/README.md](prototype/README.md).

## 1. Constraints

- Any technology. Chosen: **Node.js with TypeScript** for the server and the client half.
- The browser cannot open UDP sockets, so each user runs a small **client half** locally:
  the browser talks to it over a WebSocket on the same machine, and it speaks our protocol
  over UDP to the server (as in v1).
- Well-known algorithms are taken by other groups (Reno, Vegas, Selective Repeat and most
  famous protocols). **The main algorithms must be unique**, ideally all of them.
- Load, zoom and pan with **no noticeable quality loss**.
- Careful use of browser resources: cache, memory, number of requests, request weight.
- Must hold up on **slow connections**, with **packet loss**, and with **2 users minimum,
  3+ if it works**, without the traffic looking like a DDoS.
- Suggested by the professor, not taken: **Abelian sandpile (Dhar's algorithm)** for request
  scheduling or cache redistribution, and **Circles of Apollonius** for predicting how many
  users are interested in a tile.

## 2. What already exists

**Image representation** (`prototype/splatpyr/`, Python, offline):

- Pyramid of power-of-2 levels. The top levels, up to a budget of ~300 units, are Gaussian
  splats: a normalised base level plus additive detail levels, each fitted to what the
  coarser levels miss. Smooth when magnified, no seams, and small (the ESO image's whole
  splat pyramid is 8 MB).
- Levels near 1:1 are image tiles, chosen per tile: lossless WebP when it is at most 1.5x the
  JPEG (text, digits and graphics come out exact), JPEG q85 otherwise (photos).
- `.spx` unit files: blobs of 11 bytes, ordered by importance in chunks at 1/8, 1/4, 1/2 and
  all of the unit, so any prefix of chunks draws a coarser version of the unit.
- Streaming ingest through libvips: a 75471 x 75471 PNG (17 GB) ingests in 50 s with 1 GB
  of RAM using JPEG-only tiles, 204 s with per-tile lossless WebP.

**Viewer** (`prototype/viewer/`, WebGL 2): draws splats and tiles, shows memory, requests
and bytes.

**Baseline to beat**, v1 against splat-pyramid over plain HTTP, same scripted sessions on the
ESO image (25000 x 18832), 1920 x 1080 screen, unlimited bandwidth:

| session | v1 (ladder tiles, 1.25 ratio) | splat-pyramid over HTTP |
|---|---|---|
| zoom from whole image to 1:1 and back | 44.9 MB, 1312 requests | 28.6 MB, 771 requests |
| pan at 1:1 across 15 screens | 26.0 MB, 651 requests | 27.9 MB, 689 requests |
| 10 jumps whole image to 1:1 | 17.0 MB, 463 requests | 19.4 MB, 499 requests |
| peak client memory | ~52-68 MB (50 MB budget) | ~105-167 MB |

Splat-pyramid wins on zooming but uses more memory than v1; v2 has to fix memory.

## 3. Architecture

```
  browser (viewer, WebGL)                 user's machine
        |  WebSocket, loopback
  client half (Node + TS)  ---- our protocol over UDP ---->  server (Node + TS)
        - reassembles units                                  - sessions, one per user
        - reports what arrived                               - rate control per user
        - forwards blobs and tiles                           - multi-user interest
          to the viewer as they land                         - reads prepared files
                                                                 |
                                               splatpyr (Python, offline): ingest + fit
```

- **Server and client half**: Node 24 runs TypeScript directly (type stripping), so no
  build step for either. Code shared by both (message format, packetising, decoders) lives
  in `shared/`.
- **Viewer**: TypeScript compiled for the browser (one dev dependency). It receives units
  from the client half and keeps drawing what it has.
- **Preprocessing** stays Python and offline.
- A **network emulator** sits in the server's send path and the client half's report path:
  loss (uniform and bursty), delay, jitter, rate cap, reordering, duplication. On loopback
  nothing is ever lost, so without it none of the protocol would be visible working.

Proposed layout:

```
splat-pyramid/
  prototype/     everything built before v2, untouched (preprocessing, viewer, test outputs)
  splatpyr/      preprocessing, brought over from prototype/
  viewer/        WebGL viewer, brought over from prototype/ and moved to TS
  shared/        messages, confetti packetising, erasure code, decoders
  server/        sessions, scheduler, rate control, Apollonius interest
  client/        client half: UDP <-> WebSocket
  bench/         emulator profiles, scripted sessions, multi-user runs
```

## 4. The algorithms

Main algorithms first. Each one has a fallback in case the professor finds it taken.

| # | problem | algorithm | where | fallback if taken |
|---|---|---|---|---|
| 1 | **loss on splat units (main)** | **Confetti delivery** (own) | server + client | none needed: specific to splats |
| 2 | **sending rate (main)** | **Run-and-tumble** (bacterial chemotaxis, own) | server, per user | integrate-and-fire pacing |
| 3 | multiple users | **Circles of Apollonius** (professor) | server | - |
| 4 | client cache and memory | **Abelian sandpile, Dhar** (professor) | viewer | - |
| 5 | sharing the server's upload among users (optional) | **Lotka-Volterra competition** | server | replicator dynamics |
| 6 | loss on image tiles | v1's rateless erasure code with count-only feedback (own, from v1) | server + client | - |

### 4.1 Confetti delivery (main)

**Problem.** A unit is several UDP packets. In a normal protocol a lost packet means the unit
cannot be used until the packet is resent, so loss causes stalls and holes.

**Idea.** A splat unit is a set of independent blobs. Deal the blobs out across packets like
cards, so that every packet is an even sample of the whole unit. Then any subset of packets
draws a complete unit, just slightly softer. Loss becomes softness, never a hole, and
nothing waits for a resend.

**How it works.**

1. The unit's chunks keep their importance order (chunk 1 = the most important 1/8 of the
   blobs). Chunk 1's packets are sent first.
2. Inside a chunk of `n` blobs, with `P = ceil(n / B)` packets of up to `B` blobs (about 100
   blobs, under 1200 bytes, so no IP fragmentation), blob `j` in importance order goes to
   packet `j mod P`. Every packet gets large and small blobs from all over the unit.
3. Every packet is self-contained: unit id, chunk, packet index and count, its blobs. The
   viewer draws each packet's blobs the moment it lands.
4. **Feedback is one number per unit**: how many packets of it arrived. No list of what was
   lost, no per-packet acknowledgement.
5. **No immediate resend.** The server moves on to the next chunk (more detail) or the next
   unit. Only if the link has idle capacity and the unit is still on screen does it send the
   chunk's packets again; the client drops the duplicates. The repair only ever uses
   capacity nothing else wanted.
6. Epochs (as in v1): every view change raises the epoch, and the server drops anything
   queued for an older one.

**Why it fits.** It is the piece that ties the representation to the protocol: the loss
strategy exists because the data is splats. With pixels (tiles) it cannot work, which is why
tiles keep an erasure code (4.6).

**To measure.** PSNR and visible softness at 1%, 5% and bursty loss, against the same units
with no loss; time to first image; bytes spent on repair. Open point: in the normalised base
level a missing blob shifts the neighbours' averages slightly; measure how much.

### 4.2 Run-and-tumble rate control (main)

**Problem.** How fast to send to each user without filling the network's queues.

**Idea.** Copy how the bacterium E. coli finds food. It swims in a straight line ("run")
while conditions keep improving, and when they get worse it spins to a random new direction
("tumble"). Here the "direction" is increasing or decreasing the sending rate, and
"conditions" are a score computed from the receiver's reports.

**How it works.**

1. The sender paces packets evenly at rate `R` (no bursts).
2. Every report interval (~50 ms) it computes a score from the report:
   `U = useful goodput x (1 - loss)^a x exp(-queueing delay / tau)`.
   Queueing delay is the current one-way delay minus the smallest one seen, so the two
   machines' clocks do not need to agree.
3. **Run**: if `U` improved, keep the direction and grow the step:
   `R = R x (1 + d x s)`, `s = min(1.5 s, s_max)`.
4. **Tumble**: if `U` got worse, pick a new direction at random, biased by the delay trend
   (delay rising makes "down" more likely), and reset the step to `s_min`.
5. Safety: an absolute ceiling on queueing delay forces an immediate decrease; rate floor
   and ceiling.

**Why it fits.** The randomness in the tumble is the point for several users: deterministic
controllers tend to back off at the same moment and oscillate together, and random tumbles
break that synchronisation.

**Risk.** It resembles PCC (a published controller that also tunes its rate by trial). The
mechanism differs (PCC runs paired experiments and follows a gradient; this is a biased
random walk with run persistence), but the professor should confirm.

**Fallback: integrate-and-fire pacing.** The sender behaves like a neuron: queueing delay
charges a "membrane potential" that leaks over time; when it crosses a threshold the sender
"fires", cutting the rate, and then ignores further signals for a refractory period so one
burst of loss is not punished several times. Between firings the rate grows.

### 4.3 Circles of Apollonius: multiple users

**Problem.** With several users, the server should not read, prepare and send the same unit
separately for each, should serve first whoever needs a unit first, and should know which
units are worth keeping ready.

**Idea.** Classically, the circle of Apollonius separates the points one pursuer reaches
first from the points another reaches first, given their speeds. Treat every user as a
pursuer moving through the image: position is their current view, speed is how fast they are
panning and zooming.

**How it works.**

1. From each user's view messages, the server keeps their position (centre and zoom level)
   and velocity. Zoom is measured in levels, so zooming in by 2x is one step.
2. For every unit, estimate each user's **time until they need it**: distance from their view
   to the unit, divided by their speed toward it. Between two users with speeds `v1` and
   `v2`, the units they reach at the same moment lie on the circle `|PA| / |PB| = v1 / v2`;
   across all users this divides the image into regions of "who gets there first"
   (a multiplicatively weighted Voronoi diagram, whose boundaries are Apollonius circles).
3. **Interest count** of a unit: how many users will need it within a horizon (~2 s).
   - Units with interest are kept ready in server memory, packetised once; every interested
     user is sent from that one copy. For tiles this includes the erasure repair symbols,
     which help any receiver whatever it lost.
   - Units with no interest are dropped from server memory.
4. **Order**: a unit goes first to the user who reaches it first; the others get it from the
   ready copy.
5. The same time-until-needed also orders a single user's sends. That is predictive
   viewport (it fixed mid-zoom blur in v1) coming out of the same model.

**Not looking like a DDoS.** Clients never request units. They send one small view message
per change and one report about every 50 ms. The server has a global upload cap, and every
user's rate stays under it.

### 4.4 Abelian sandpile (Dhar): the client cache

**Problem.** The viewer must stay under a fixed memory budget while zooming and panning,
keep what will be needed again (especially coarse levels) and drop the rest.

**Idea.** Every cached unit is a site holding a pile of "keep" grains. Looking at a unit adds
grains; piles that grow too tall topple and pass grains to their neighbours, including the
coarser unit above. Credit therefore flows toward the coarse levels that every view shares.

**How it works.**

1. Sites are the cached units. Neighbours: the 4 adjacent units of the same level, the parent
   (coarser) unit, the child (finer) units. The threshold of a site is its number of
   neighbours.
2. Every frame drops grains on the units on screen, in proportion to how much of the screen
   they cover.
3. A site at or above its threshold topples: it loses that many grains and each neighbour
   gains one. Grains that fall on uncached units are lost (the sink).
4. Over the memory budget, the units with the least grains per byte are evicted first.
5. Dhar's result, the **Abelian property**, is that the order of topplings does not change
   the final state. So the cache contents after a sequence of views are deterministic
   whatever order events are processed in, and can be tested.
6. Blobs move from 32 to 16 bytes on the GPU (half-precision), halving splat memory.

**To measure.** Steady and peak memory (target at most v1's 50 MB), bytes refetched after
eviction, coarse-level retention during long pans. Open point: whether Dhar's burning
algorithm gives a better eviction order than fewest grains per byte.

### 4.5 Lotka-Volterra competition (optional)

**Only if 3+ users show one starving another.** The server's upload is a resource the
sessions compete for. Each user's share `x_i` follows competitive Lotka-Volterra dynamics:
`dx_i/dt = r x_i (1 - sum_j a_ij x_j / K_i)`, where `K_i` is that user's rate from
run-and-tumble and `a_ij` is lower when two users are interested in the same units (one
copy serves both). It settles on coexistence: nobody's share goes to zero.

### 4.6 Tiles: v1's erasure code

Image tiles are entropy-coded, so a tile with a missing packet cannot be decoded; confetti
cannot apply. Tiles keep v1's scheme, ported to TypeScript: a systematic rateless erasure
code over GF(256), the receiver reports only how many symbols it is short, and there is no
acknowledgement. Repair symbols are generated once per tile and serve every user.

## 5. Messages (draft)

A 12-byte header: magic, version, type, epoch, length. Then the payload.

| type | direction | payload |
|---|---|---|
| `HELLO` / `WELCOME` | both | version |
| `OPEN` | client to server | image name |
| `CHART` | server to client | image size, levels, split level, tile formats |
| `VIEW` | client to server | centre, zoom, screen size, units the cache evicted |
| `REPORT` | client to server | packets received per unit in flight, symbols short per tile, bytes received, one-way delay samples |
| `CONFETTI` | server to client | unit id, chunk, packet index and count, blobs |
| `SYMBOL` | server to client | tile id, symbol index, symbol |
| `STATS` | server to client | what the session is doing, for the viewer's panel |
| `FAULT` | server to client | an error explained |

## 6. How each requirement is met

| requirement | mechanism | measured by |
|---|---|---|
| no visible quality loss | exact tiles at 1:1; splat levels at a higher fit target (~38 dB, to decide) | time until the view is sharp; % of frames at screen resolution |
| memory | sandpile budget, 16-byte blobs | steady and peak memory, target at most 50 MB |
| number of requests | one session, server push | messages per second, vs v1's 1312 requests per zoom |
| request weight | packets under 1200 bytes; most important chunk first | bytes per session, vs v1's 44.9 MB |
| slow connection | run-and-tumble; most important first, so the whole image shows as splats within a few KB | time to first image at 2 Mbit/s, 120 ms delay |
| packet loss | confetti for splats, erasure code for tiles | quality and time until sharp at 1%, 5% and bursty loss |
| 2-3+ users, no DDoS | Apollonius interest and ordering, global cap, optional Lotka-Volterra | server CPU and upload, fairness between users, with 1, 2, 3 and 5 users |

## 7. Test plan

**Link profiles** (applied by the emulator):

| profile | rate | delay | loss |
|---|---|---|---|
| LAN | 100 Mbit/s | 1 ms | 0 |
| home | 20 Mbit/s | 30 ms | 0.5% |
| bad mobile | 2 Mbit/s | 120 ms, jitter 20 ms | 3%, bursty |

**Sessions**: zoom from whole image to 1:1 and back, pan at 1:1 across 15 screens, 10 jumps
(the scripted sessions from the v1 comparison), for 1, 2, 3 and 5 users at once, including
users looking at the same area and at different areas.

**Images**: ESO (star field, 470 MP), Holbein (painting, 789 MP), bills (photo), bigbig
(75k x 75k digits, text-like).

**Every run reports**: bytes, messages, peak and steady client memory, time to first image,
time until sharp after each move, server CPU and upload, and per-user rate over time.

## 8. Build order

Each step ends with something running and measured.

1. **Walking skeleton.** Server, client half and viewer in TypeScript. One user, no loss, a
   plain fixed rate. Splat units and tiles travel as our messages and appear in the viewer.
2. **Confetti delivery** plus the emulator. Measure loss as softness.
3. **Run-and-tumble**, on the three link profiles.
4. **Sandpile cache** and 16-byte blobs. Hit the memory target.
5. **Apollonius**: 2 users, then 3 and 5.
6. **Lotka-Volterra**, only if step 5 shows unfairness.
7. **Tile erasure code** port (can run in parallel with 3-5).
8. Full measurement against v1, and the write-up.

## 9. Risks and open questions

- **Uniqueness.** Run-and-tumble may be judged too close to PCC; the fallback
  (integrate-and-fire) is ready. Confetti delivery is specific to splats.
- **Base level under loss.** Missing blobs in the normalised base shift colour averages;
  step 2 measures it. If it is visible, the base unit (a few KB) can use the erasure code
  instead.
- **Splat quality at mid zoom.** "No noticeable loss" may need a higher fit target on the
  splat levels, which costs fitting time and bytes.
- **Client half.** Confirm with the professor that a local helper process is acceptable, as
  in v1.
