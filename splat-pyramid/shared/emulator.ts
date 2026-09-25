// A network emulator for one direction of the path. On loopback nothing is ever lost,
// delayed or reordered, which is the one condition under which none of the protocol can be
// seen working; this puts those conditions back.
//
// A spec is a comma-separated list, or a profile name:
//   loss=2%          uniform loss
//   burst=5%/30%     bursty loss (Gilbert-Elliott): chance per packet of entering a bad spell,
//                    chance per packet of leaving it; in a bad spell every packet is lost
//   delay=30ms       one-way propagation delay
//   jitter=5ms       delay varies by up to this much either way (reorders packets)
//   rate=20mbit      bottleneck rate; packets queue behind it
//   queue=100ms      the bottleneck's queue, as time to drain; overflow is dropped
//   reorder=1%       chance a packet is held back by an extra 2 x delay
//   duplicate=0.5%   chance a packet arrives twice
//
// Profiles (see PLAN.md, test plan): lan, home, mobile.

export interface Impairment {
  loss: number;
  burstEnter: number;
  burstLeave: number;
  delayMs: number;
  jitterMs: number;
  rateBps: number;       // bytes per second, 0 = unlimited
  queueMs: number;
  reorder: number;
  duplicate: number;
}

export const NONE: Impairment = {
  loss: 0, burstEnter: 0, burstLeave: 1, delayMs: 0, jitterMs: 0, rateBps: 0, queueMs: 100,
  reorder: 0, duplicate: 0,
};

export const PROFILES: Record<string, string> = {
  lan: "rate=100mbit,delay=1ms",
  home: "rate=20mbit,delay=30ms,jitter=3ms,loss=0.5%",
  mobile: "rate=2mbit,delay=120ms,jitter=20ms,loss=1%,burst=1%/30%,queue=300ms",
};

export function parseImpairment(spec: string | undefined): Impairment {
  const out = { ...NONE };
  if (!spec || spec === "none") return out;
  const text = PROFILES[spec] ?? spec;
  for (const part of text.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [name, value] = part.split("=");
    const pct = (v: string) => Number(v.replace("%", "")) / 100;
    const ms = (v: string) => Number(v.replace("ms", ""));
    switch (name) {
      case "loss": out.loss = pct(value); break;
      case "burst": {
        const [enter, leave] = value.split("/");
        out.burstEnter = pct(enter);
        out.burstLeave = pct(leave);
        break;
      }
      case "delay": out.delayMs = ms(value); break;
      case "jitter": out.jitterMs = ms(value); break;
      case "rate": {
        const m = /^([\d.]+)\s*(k|m|g)?bit$/i.exec(value);
        if (!m) throw new Error(`rate: expected e.g. 20mbit, got ${value}`);
        const unit = { k: 1e3, m: 1e6, g: 1e9 }[(m[2] ?? "").toLowerCase() as "k" | "m" | "g"] ?? 1;
        out.rateBps = (Number(m[1]) * unit) / 8;
        break;
      }
      case "queue": out.queueMs = ms(value); break;
      case "reorder": out.reorder = pct(value); break;
      case "duplicate": out.duplicate = pct(value); break;
      default: throw new Error(`unknown impairment "${name}"`);
    }
  }
  return out;
}

export function describe(i: Impairment): string {
  if (i === NONE) return "none";
  const parts: string[] = [];
  if (i.rateBps) parts.push(`${((i.rateBps * 8) / 1e6).toFixed(1)} Mbit/s, queue ${i.queueMs} ms`);
  if (i.delayMs || i.jitterMs) parts.push(`delay ${i.delayMs}±${i.jitterMs} ms`);
  if (i.loss) parts.push(`loss ${(i.loss * 100).toFixed(1)}%`);
  if (i.burstEnter) parts.push(`bursts ${(i.burstEnter * 100).toFixed(1)}%/${(i.burstLeave * 100).toFixed(0)}%`);
  if (i.reorder) parts.push(`reorder ${(i.reorder * 100).toFixed(1)}%`);
  if (i.duplicate) parts.push(`duplicate ${(i.duplicate * 100).toFixed(1)}%`);
  return parts.join(", ") || "none";
}

/** One direction of an emulated path. */
export class EmulatedPath {
  readonly spec: Impairment;
  private deliver: (msg: Buffer) => void;
  private linkFreeAt = 0;
  private bad = false;
  // what the path did, for measurement
  sent = 0;
  dropped = 0;
  queueDrops = 0;

  constructor(spec: Impairment, deliver: (msg: Buffer) => void) {
    this.spec = spec;
    this.deliver = deliver;
  }

  send(msg: Buffer): void {
    const s = this.spec;
    this.sent++;
    const now = performance.now();
    // the bottleneck: wait for the link, drop if the queue is full
    let departure = now;
    if (s.rateBps > 0) {
      const start = Math.max(now, this.linkFreeAt);
      if (start - now > s.queueMs) {
        this.queueDrops++;
        return;
      }
      departure = start + (msg.length / s.rateBps) * 1000;
      this.linkFreeAt = departure;
    }
    // loss on the way: bursty spells, then uniform
    if (s.burstEnter > 0) {
      this.bad = this.bad ? Math.random() >= s.burstLeave : Math.random() < s.burstEnter;
      if (this.bad) { this.dropped++; return; }
    }
    if (Math.random() < s.loss) { this.dropped++; return; }
    let arrival = departure + s.delayMs + (Math.random() * 2 - 1) * s.jitterMs;
    if (Math.random() < s.reorder) arrival += 2 * Math.max(s.delayMs, 1);
    this.schedule(msg, arrival - now);
    if (Math.random() < s.duplicate) this.schedule(msg, arrival - now + 1);
  }

  private schedule(msg: Buffer, afterMs: number): void {
    if (afterMs <= 0.5) this.deliver(msg);
    else setTimeout(() => this.deliver(msg), afterMs);
  }
}
