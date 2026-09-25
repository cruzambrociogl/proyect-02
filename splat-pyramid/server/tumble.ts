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
// The first run starts with the longest step, so a new session climbs to a fast link's rate
// in a few round trips. It ends at the first tumble, or as soon as any report shows a queue
// forming (checked on every report, not once per round trip, since each step of the first
// run is large): the rate steps back and the controller carries on with small steps.
//
// Every change is judged only once its effect can be seen: one round trip plus two reports
// later (one report during a long run), and over at least MIN_JUDGE_PACKETS delivered packets (one report alone, or a few
// dozen packets on a slow link, is too noisy: one burst of loss outweighs a 5% step). Queueing delay is the one-way delay minus the smallest seen in the last 10 s, so the
// two machines' clocks never need to agree. A queue past Q_MAX forces a cut, at most once
// per round trip.
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
const FIRST_RUN_EXIT_MS = 25;   // queueing delay that ends the first run...
const FIRST_RUN_EXIT_PACKETS = 20;  // ...measured over at least this many packets: the smallest
                                    // delay of a few packets on a jittery link can sit 25 ms
                                    // above the true minimum with no queue at all
const S_MIN = 0.05;         // smallest step: 5% of the rate
const S_MAX = 0.5;          // longest step while running
const EPS = 0.02;           // a score must beat the last one by 2% to count as better
const BIAS = 0.5;           // how strongly a rising delay pushes a tumble downward (per ms):
                            // 5 ms more queue than last time makes "up" 8% likely
const BASE_WINDOW_MS = 10_000;
const REPORT_MS = 100;
const MIN_JUDGE_PACKETS = 80;

export const RATE_MIN = 32_000;            // bytes/s: 256 kbit/s
export const RATE_START = 500_000;         // bytes/s: 4 Mbit/s. From 1 Mbit/s the first half
                                           // second on a fast link showed a blurry opening
                                           // view (21.8 dB against v1's 28.4); on a slower
                                           // link the first run's exit catches the excess

export class RunAndTumble {
  rate = RATE_START;
  private max: number;
  private dir = 1;
  private step = S_MAX;           // the first run is long; the first tumble brings it to S_MIN
  private firstRun = true;
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
    this.q = q;
    if (this.firstRun && q > FIRST_RUN_EXIT_MS && this.window.delivered >= FIRST_RUN_EXIT_PACKETS) {
      // the first run found the ceiling
      this.firstRun = false;
      this.dir = -1;
      this.step = S_MIN;
      this.change(1 / 1.5, now);
      return;
    }
    if (now < this.judgeAfter) return;                    // the last change is not visible yet
    if (q > Q_MAX_MS) {
      // The queue is out of hand: cut, then small steps. Once per round trip only: the queue
      // takes a while to drain, and cutting again on every report while it does would take
      // the rate to the floor.
      this.dir = -1;
      this.step = S_MIN;
      this.firstRun = false;
      this.change(0.7, now);
      this.cuts++;
      return;
    }

    const w = this.window;
    // not enough evidence yet (the first run needs none: a queue forming ends it anyway)
    if (!this.firstRun && w.delivered < MIN_JUDGE_PACKETS) return;
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
      this.firstRun = false;
      this.tumbles++;
    }
    this.lastScore = score;
    this.lastQ = q;
    this.change(1 + this.dir * this.step, now);
  }

  private change(factor: number, now: number): void {
    this.rate = Math.min(this.max, Math.max(RATE_MIN, this.rate * factor));
    if (factor < 1 && this.dir > 0) this.dir = -1;
    // a long run is judged after one report (a queue forming ends it on any report anyway);
    // small steps after two, since one report is too noisy to judge 5%
    this.judgeAfter = now + this.srtt + (this.firstRun ? 1 : 2) * REPORT_MS;
    this.resetWindow();
  }

  private resetWindow(): void {
    this.window = { bytes: 0, ms: 0, owdMin: null, sent: 0, sentBytes: 0, delivered: 0, busy: 0, ticks: 0,
                    since: performance.now() };
  }

  stats(): Record<string, unknown> {
    return { rateMbit: +((this.rate * 8) / 1e6).toFixed(2), srttMs: Math.round(this.srtt),
             queueMs: Math.round(this.q), loss: +this.loss.toFixed(3), runs: this.runs,
             tumbles: this.tumbles, cuts: this.cuts, dir: this.dir, step: +this.step.toFixed(3) };
  }
}
