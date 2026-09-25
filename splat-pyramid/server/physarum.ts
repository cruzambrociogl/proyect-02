// Physarum polycephalum, the slime mould, as Tero and Nakagaki model it: a network of tubes
// whose conductance D grows with the flow Q through it and decays without it,
//
//     dD/dt = f(|Q|) - D,
//
// and in which flow splits between parallel tubes in proportion to their conductance. The
// mould uses this to find short paths (with f(Q) = Q, one tube wins) and to build networks
// that share the load (with f(Q) = Q^gamma, gamma < 1, the tubes coexist).
//
// The server uses it twice.
//
// Users. The server's upload reaches every user through its own tube; when the server's cap
// is what binds, each busy user gets a share in proportion to its conductance. What grows a
// tube is useful flow: bytes of a tile, or of a chunk of a splat unit, sent whole while the
// user's view still wanted it. Bytes of a unit the user moved away from before it was sent
// whole were wasted (server/session.ts). With gamma = 1/2 the tubes settle at conductances in proportion to how useful
// their flow has been, so a user sweeping past gets less than one who stops to look, and
// nobody is starved.
//
// Units. Every unit in the server's shared packet cache is a node, and its conductance is the
// flow served from it to anyone, decaying with a half-life (f(Q) = Q). Over the budget the
// cache evicts the least conductance per byte first.

const GAMMA = 0.5;                 // tubes: sublinear, so they coexist
const TUBE_TAU_S = 0.5;            // how fast a tube adapts
const TUBE_FLOOR = 0.1;            // a tube never closes: a user can always start looking
const USEFUL_HALFLIFE_S = 2;       // memory of how useful a user's flow has been
const NODE_HALFLIFE_S = 10;        // memory of a cached unit's flow

interface Tube {
  D: number;
  useful: number;                  // bytes, decaying
  total: number;
  at: number;                      // ms, for the decay
}

export class Physarum {
  private tubes = new Map<string, Tube>();
  private nodes = new Map<string, { D: number; at: number }>();

  private tube(user: string): Tube {
    let t = this.tubes.get(user);
    if (!t) this.tubes.set(user, (t = { D: 1, useful: 0, total: 0, at: performance.now() }));
    return t;
  }

  /** How bytes sent to `user` turned out: `useful` were still wanted, `wasted` were not. */
  flowed(user: string, useful: number, wasted: number): void {
    if (useful + wasted <= 0) return;
    const t = this.tube(user), now = performance.now();
    const k = 0.5 ** ((now - t.at) / 1000 / USEFUL_HALFLIFE_S);
    t.useful = t.useful * k + useful;
    t.total = t.total * k + useful + wasted;
    t.at = now;
  }

  /** Fraction of a user's recent flow that was useful (1 until something is known). */
  usefulness(user: string): number {
    const t = this.tubes.get(user);
    return t ? (t.useful + 16_384) / (t.total + 16_384) : 1;
  }

  /**
   * One step of the tubes of the users who want to send, dt seconds: flow splits by
   * conductance, and each tube moves toward its useful flow (relative to an even split) to
   * the power gamma.
   */
  adapt(busy: string[], dt: number): void {
    if (!busy.length) return;
    const total = busy.reduce((a, u) => a + this.tube(u).D, 0);
    const a = Math.min(1, dt / TUBE_TAU_S);
    for (const u of busy) {
      const t = this.tube(u);
      const q = this.usefulness(u) * (t.D / total) * busy.length;
      t.D = Math.max(TUBE_FLOOR, t.D + a * (q ** GAMMA - t.D));
    }
  }

  /** A user's share weight of the server's upload. */
  conductance(user: string): number {
    return this.tube(user).D;
  }

  forget(user: string): void {
    this.tubes.delete(user);
  }

  get users(): number {
    return this.tubes.size;
  }

  /** Bytes served from a cached unit. */
  through(key: string, bytes: number): void {
    const now = performance.now(), n = this.nodes.get(key);
    if (!n) { this.nodes.set(key, { D: bytes, at: now }); return; }
    n.D = n.D * 0.5 ** ((now - n.at) / 1000 / NODE_HALFLIFE_S) + bytes;
    n.at = now;
  }

  /** A cached unit's conductance now. */
  node(key: string): number {
    const n = this.nodes.get(key);
    return n ? n.D * 0.5 ** ((performance.now() - n.at) / 1000 / NODE_HALFLIFE_S) : 0;
  }

  dropNode(key: string): void {
    this.nodes.delete(key);
  }
}
