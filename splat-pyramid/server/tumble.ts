// Run-and-tumble rate control: how fast to send to one client.
//
// Borrowed from how the bacterium E. coli finds food. It swims straight ("runs") while
// conditions improve, and when they get worse it spins to a random new heading ("tumbles").
// Here the heading is up or down for the sending rate, and "conditions" are a score from
// the client's reports:
//
//   score = sending rate x exp(-queueing delay / TAU)
//
// Below the path's capacity, sending faster raises the score; past it, packets wait in the
// bottleneck's queue, the delay term falls faster than the rate rises, and the score falls.
// The rate is the one actually sent in the window (windows where the session had little to
// send teach nothing and are skipped). Measured goodput was tried and swings with every burst
// of random loss, which the erasure code repairs anyway: on a bursty link a 5% step could not
// be told from noise. Loss is left out for the same reason; congestion shows up as delay.
//
// Below the path's capacity, sending faster raises goodput and the score; past it, packets
// wait in the bottleneck's queue, delay grows and the score falls. So:
//
//   run     the score improved: keep the direction, lengthen the step (x1.5, up to S_MAX)
//   tumble  it got worse: pick a direction at random, biased by the delay trend (delay rising
//           makes "down" likely), and go back to the smallest step
//
// A session does not start here: it starts with slow start (below), which hands over a rate.
//
// Every change is judged only once its effect can be seen: one round trip plus two reports
// later, and over at least MIN_JUDGE_PACKETS delivered packets (one report alone, or a few
// dozen packets on a slow link, is too noisy: one burst of loss outweighs a 5% step). Queueing delay is the one-way delay minus the smallest seen in the last 10 s, so the
// two machines' clocks never need to agree. A queue past Q_MAX forces a cut, at most once
// per round trip.
//
// Slow start. A session opens with a
// congestion window of IW bytes, and every byte acknowledged (ACK) adds a byte to it, so the
// window doubles each round trip (RFC 5681). It is paced at twice the window per round trip.
// It ends, HyStart++ style (RFC 9406), on a queue rather than on a loss (random loss is the
// erasure code's business). The first sign of a queue starts Conservative Slow Start: the
// window grows at a quarter of the pace, and if the delay falls back it was jitter and slow
// start resumes; if it lasts CSS_ROUNDS round trips, slow start is over. A link with a short
// queue drops instead of delaying, so slow start also ends on loss, but only on both signs of
// a full link together: over SS_EXIT_LOSS of the packets of two round trips lost, and the
// delivery rate no longer growing (by PLATEAU_GROWTH in the last busy round trip). Either
// alone misleads: bursts of random loss come while delivery still grows, and bunched ACKs
// or a pause make delivery look flat with nothing lost. Reaching the server's cap says only
// how fast the server will go, not what the link takes: slow start paces at the cap for
// CAP_ROUNDS more round trips (the window no longer growing) and ends there only if none of
// them showed a full link. Then the rate is the
// most that was delivered over two round trips (once a queue forms, that is the bottleneck's
// rate), and run-and-tumble takes over from there. After IDLE_RESTART_MS without
// sending, the session starts slowly again, but only up to the rate it had (its ssthresh):
// shorter pauses, a viewer looking at the image, keep the window (RFC 7661).
//
// The window. In flight is at most cwnd bytes (server/session.ts): during slow start the
// window above; after it, twice what the rate delivers in a round trip of the path without a
// queue (the minimum RTT) plus the ACK delay. Pacing sets the speed and the window is the
// cap, as BBR combines them: the queue stays within about one round trip, and if
// acknowledgements stop, so does the sending (session.ts: timeouts with backoff).
//
// The randomness is the point with several clients. Controllers that all react the same way
// to the same congestion back off together and oscillate together; tumbles do not line up.

import type { Report } from "../shared/wire.ts";
import { clockMs } from "../shared/wire.ts";

const TAU_MS = 80;          // queueing delay at which the score is divided by e. Much larger
                            // than the jitter a report window still shows (a few ms on a
                            // mobile link): at 25 ms a 3 ms wobble moved the score 12%, more
                            // than a 5% step, and the controller chased jitter downward
const Q_MAX_MS = 150;       // queueing delay that forces an immediate cut
const S_MIN = 0.05;         // smallest step: 5% of the rate
const S_MAX = 0.5;          // longest step while running
const EPS = 0.02;           // a score must beat the last one by 2% to count as better
const BIAS = 0.5;           // how strongly a rising delay pushes a tumble downward (per ms):
                            // 5 ms more queue than last time makes "up" 8% likely
const BASE_WINDOW_MS = 10_000;
const REPORT_MS = 100;
const MIN_JUDGE_PACKETS = 80;

export const PACKET = 1200;
export const IW = 10 * PACKET;             // initial window (RFC 6928)
const WINDOW_GAIN = 2;                     // cwnd after slow start: this many rate x round trips
const ACK_DELAY_MS = 20;                   // the longest a client holds an ACK (client/link.ts)
const SS_EXIT_MS = 25;                     // queueing delay that ends slow start...
const SS_EXIT_PACKETS = 20;                // ...seen over at least this many acknowledged packets
export const IDLE_RESTART_MS = 10_000;
const CSS_GROWTH_DIVISOR = 4;              // RFC 9406
const CSS_ROUNDS = 5;                      // RFC 9406
const SS_EXIT_LOSS = 0.1;                  // random loss is a few %; a full link drops more
const SS_LOSS_PACKETS = 64;                // judged over at least this many packets
const PLATEAU_GROWTH = 1.25;               // delivery growing less than this per round: flat
const CAP_ROUNDS = 3;                      // clean round trips at the cap before trusting it

export const RATE_MIN = 32_000;            // bytes/s: 256 kbit/s

export class RunAndTumble {
  rate = RATE_MIN;                        // set by slow start from the first moment
  /** "slow start" until the first queue, then "run-and-tumble". */
  phase: "slow start" | "run-and-tumble" = "slow start";
  private ssWindow = IW;                  // the congestion window while in slow start
  private ssthresh = Infinity;            // bytes/s: where a restarted slow start stops
  private ssAcked = 0;                    // packets acknowledged in this slow start
  private delivered: { at: number; bytes: number; packets: number; lost: number }[] = [];
  private rttSamples: { at: number; rtt: number }[] = [];
  private ssMaxDelivery = 0;              // the most delivered in a round trip, this slow start
  private cssSince = 0;                   // when Conservative Slow Start began; 0: not in it
  private round = { start: 0, bw: 0, flat: false, busy: 0, ticks: 0 };     // delivery per round
  private capSince = 0;                   // when slow start reached the cap; 0: not at it
  private max: number;
  private dir = 1;
  private step = S_MIN;
  private lastScore: number | null = null;
  private lastQ = 0;
  private judgeAfter = 0;
  private owdSamples: { at: number; owd: number }[] = [];
  srtt = 100;
  // the window since the last decision
  private window = { bytes: 0, ms: 0, owdMin: null as number | null, sent: 0, sentBytes: 0, delivered: 0,
                     busy: 0, ticks: 0, since: performance.now() };
  private lastDelivered = -1;
  // what it did, for STATS
  runs = 0;
  tumbles = 0;
  cuts = 0;
  q = 0;
  score = 0;
  loss = 0;

  constructor(max: number) {
    this.max = max;
    this.enterSlowStart(Infinity);
  }

  private enterSlowStart(ssthresh: number): void {
    this.phase = "slow start";
    this.ssWindow = IW;
    this.ssthresh = ssthresh;
    this.ssAcked = 0;
    this.ssMaxDelivery = 0;
    this.cssSince = 0;
    this.round = { start: performance.now(), bw: 0, flat: false, busy: 0, ticks: 0 };
    this.capSince = 0;
    this.paceSlowStart();
  }

  /** Slow start is paced at twice its window per round trip. */
  private paceSlowStart(): void {
    this.rate = Math.min(this.max, Math.max(RATE_MIN, (2 * this.ssWindow) / (Math.max(1, this.srtt) / 1000)));
  }

  /**
   * The congestion window, bytes: how much may be in flight. After slow start, twice what the
   * rate delivers in a round trip of the path without a queue (the minimum RTT, as BBR does).
   * The smoothed RTT includes the queue: a window from it grows as the queue grows, which
   * lets the queue grow further; from the minimum, the queue is held to about one round trip.
   */
  get cwnd(): number {
    if (this.phase === "slow start") return this.ssWindow;
    return Math.max(IW, (WINDOW_GAIN * this.rate * (this.minRtt + ACK_DELAY_MS)) / 1000);
  }

  /** The smallest round trip seen over the last BASE_WINDOW_MS: the path without a queue. */
  get minRtt(): number {
    return this.rttSamples.length ? Math.min(...this.rttSamples.map((s) => s.rtt)) : this.srtt;
  }

  /** Bytes delivered per second over the last round trip, from the ACKs. */
  get deliveryRate(): number {
    const d = this.delivered;
    if (d.length < 2) return 0;
    const span = d[d.length - 1].at - d[0].at;
    return span > 0 ? (d.slice(1).reduce((a, x) => a + x.bytes, 0) / span) * 1000 : 0;
  }

  /** Nothing was sent for IDLE_RESTART_MS: start slowly again, up to the rate it had. */
  restartAfterIdle(): void {
    if (this.phase === "run-and-tumble") this.enterSlowStart(this.rate);
  }

  /**
   * An ACK: what it acknowledged (bytes, packets), packets newly known lost, its delay sample
   * and a round-trip sample (ms, or null).
   */
  onAck(ackedBytes: number, ackedPackets: number, lostPackets: number, owdMin: number | null, rtt: number | null): void {
    const now = performance.now();
    if (rtt !== null && rtt >= 0 && rtt < 10_000) {
      this.srtt = 0.875 * this.srtt + 0.125 * rtt;
      // the minimum over a window: one sample per 50 ms is plenty
      const last = this.rttSamples[this.rttSamples.length - 1];
      if (!last || now - last.at > 50 || rtt < last.rtt) this.rttSamples.push({ at: now, rtt });
      while (this.rttSamples.length && now - this.rttSamples[0].at > BASE_WINDOW_MS) this.rttSamples.shift();
    }
    if (owdMin !== null) {
      this.owdSamples.push({ at: now, owd: owdMin });
      while (this.owdSamples.length && now - this.owdSamples[0].at > BASE_WINDOW_MS) this.owdSamples.shift();
    }
    if (ackedBytes > 0 || lostPackets !== 0) {
      this.delivered.push({ at: now, bytes: ackedBytes, packets: ackedPackets, lost: lostPackets });
      const keep = Math.max(100, 2 * this.srtt);
      while (this.delivered.length > 2 && now - this.delivered[0].at > keep) this.delivered.shift();
      // the bottleneck's rate: once a queue forms the link delivers at full speed, so the
      // largest round trip's delivery seen is the estimate (BBR's max filter), not an average
      // that includes the start of the ramp
      if (this.phase === "slow start" && now - this.delivered[0].at >= keep * 0.8) {
        this.ssMaxDelivery = Math.max(this.ssMaxDelivery, this.deliveryRate);
      }
    }
    if (this.phase !== "slow start") return;
    this.ssAcked += ackedPackets;
    const base = this.owdSamples.length ? Math.min(...this.owdSamples.map((s) => s.owd)) : 0;
    const q = owdMin === null ? this.q : Math.max(0, owdMin - base);
    this.q = q;
    if (this.capSince) {
      // at the cap: the window stays, the link is on probation
    } else if (!this.cssSince) {
      this.ssWindow += ackedBytes;
      if (q > SS_EXIT_MS && this.ssAcked >= SS_EXIT_PACKETS) this.cssSince = now;   // a queue?
    } else {
      this.ssWindow += ackedBytes / CSS_GROWTH_DIVISOR;
      if (q < SS_EXIT_MS / 2) this.cssSince = 0;                // it was jitter: carry on
      else if (now - this.cssSince > CSS_ROUNDS * this.srtt) return this.leaveSlowStart(now, -1);
    }
    // a full link that drops: loss and a flat delivery rate together
    const r = this.round;
    if (now - r.start >= this.srtt) {
      if (r.ticks > 0 && r.busy / r.ticks >= 0.7) {       // a round with little to send says nothing
        r.flat = this.ssMaxDelivery < r.bw * PLATEAU_GROWTH;
        r.bw = Math.max(r.bw, this.ssMaxDelivery);
      }
      r.start = now;
      r.busy = r.ticks = 0;
    }
    const counted = this.delivered.reduce((a, d) => a + d.packets + Math.max(0, d.lost), 0);
    const lost = Math.max(0, this.delivered.reduce((a, d) => a + d.lost, 0));
    if (r.flat && counted >= SS_LOSS_PACKETS && lost / counted > SS_EXIT_LOSS) return this.leaveSlowStart(now, -1);
    this.paceSlowStart();
    if (this.rate >= this.ssthresh) {                     // a restart: back where it was
      this.rate = Math.min(this.max, this.ssthresh);
      return this.leaveSlowStart(now, 1);
    }
    if (this.rate >= this.max) {
      this.rate = this.max;
      if (!this.capSince) this.capSince = now;
      else if (now - this.capSince > CAP_ROUNDS * this.srtt) this.leaveSlowStart(now, 1);   // it holds
    }
  }

  /** Slow start found the ceiling (or its ssthresh): carry on at the delivered rate. */
  private leaveSlowStart(now: number, dir: number): void {
    this.phase = "run-and-tumble";
    if (dir < 0) this.rate = Math.min(this.max, Math.max(RATE_MIN, this.ssMaxDelivery || this.deliveryRate || this.rate / 2));
    this.dir = dir;
    this.step = S_MIN;
    this.lastScore = null;
    this.change(1, now);
  }

  /** The session sent a packet of this many bytes. */
  sent(bytes: number): void {
    this.window.sent++;
    this.window.sentBytes += bytes;
  }

  /** One pacing tick passed; busy = the session had something to send. */
  tick(busy: boolean): void {
    this.window.ticks++;
    if (busy) this.window.busy++;
    this.round.ticks++;
    if (busy) this.round.busy++;
  }

  onReport(r: Report): void {
    const now = performance.now();
    // round trip: the report echoes our newest "sent at" and how long the client held it
    const rtt = clockMs() - r.echo - r.holdMs;
    if (r.echo && rtt >= 0 && rtt < 10_000) this.srtt = 0.875 * this.srtt + 0.125 * rtt;

    if (r.owdMin !== null) {
      this.owdSamples.push({ at: now, owd: r.owdMin });
      while (this.owdSamples.length && now - this.owdSamples[0].at > BASE_WINDOW_MS) this.owdSamples.shift();
      if (this.window.owdMin === null || r.owdMin < this.window.owdMin) this.window.owdMin = r.owdMin;
    }
    this.window.bytes += r.intervalBytes;
    this.window.ms += r.intervalMs;
    if (this.lastDelivered >= 0) this.window.delivered += r.packets - this.lastDelivered;
    this.lastDelivered = r.packets;

    const base = Math.min(...this.owdSamples.map((s) => s.owd));
    const q = this.window.owdMin === null ? this.lastQ : Math.max(0, this.window.owdMin - base);
    if (this.phase === "slow start") {                    // the ACKs drive it; nothing to judge
      this.resetWindow();
      return;
    }
    this.q = q;
    if (now < this.judgeAfter) return;                    // the last change is not visible yet
    if (q > Q_MAX_MS) {
      // The queue is out of hand: cut, then small steps. Once per round trip only: the queue
      // takes a while to drain, and cutting again on every report while it does would take
      // the rate to the floor.
      this.dir = -1;
      this.step = S_MIN;
      this.change(0.7, now);
      this.cuts++;
      return;
    }

    const w = this.window;
    if (w.delivered < MIN_JUDGE_PACKETS) return;          // not enough evidence yet
    const appLimited = w.ticks > 0 && w.busy / w.ticks < 0.7;
    if (appLimited || w.ms <= 0) {                        // nothing to learn from an idle link
      this.resetWindow();
      return;
    }
    const sentRate = (w.sentBytes / Math.max(1, now - w.since)) * 1000;
    this.loss = w.sent > 0 ? Math.min(1, Math.max(0, 1 - w.delivered / w.sent)) : 0;   // shown only
    const score = sentRate * Math.exp(-q / TAU_MS);
    this.score = score;

    if (this.lastScore === null || score > this.lastScore * (1 + EPS)) {
      if (this.lastScore !== null) this.step = Math.min(this.step * 1.5, S_MAX);         // run
      this.runs++;
    } else {
      const pUp = 1 / (1 + Math.exp(BIAS * (q - this.lastQ)));                             // tumble
      this.dir = Math.random() < pUp ? 1 : -1;
      this.step = S_MIN;
      this.tumbles++;
    }
    this.lastScore = score;
    this.lastQ = q;
    this.change(1 + this.dir * this.step, now);
  }

  private change(factor: number, now: number): void {
    this.rate = Math.min(this.max, Math.max(RATE_MIN, this.rate * factor));
    if (factor < 1 && this.dir > 0) this.dir = -1;
    // judged after a round trip and two reports: one report is too noisy to judge 5%
    this.judgeAfter = now + this.srtt + 2 * REPORT_MS;
    this.resetWindow();
  }

  private resetWindow(): void {
    this.window = { bytes: 0, ms: 0, owdMin: null, sent: 0, sentBytes: 0, delivered: 0, busy: 0, ticks: 0,
                    since: performance.now() };
  }

  stats(): Record<string, unknown> {
    return { phase: this.phase === "slow start" && this.cssSince ? "conservative slow start" : this.phase, cwndKB: Math.round(this.cwnd / 1024), minRttMs: Math.round(this.minRtt),
             rateMbit: +((this.rate * 8) / 1e6).toFixed(2), srttMs: Math.round(this.srtt),
             queueMs: Math.round(this.q), loss: +this.loss.toFixed(3), runs: this.runs,
             tumbles: this.tumbles, cuts: this.cuts, dir: this.dir, step: +this.step.toFixed(3) };
  }
}
