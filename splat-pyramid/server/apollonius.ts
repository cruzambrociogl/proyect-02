// Replaced as the default by Physarum (physarum.ts); still runs with --multi apollonius, for
// comparison.
//
// Circles of Apollonius: which connected users are about to need a unit, and who first.
//
// Every user is treated as a pursuer moving through the image. Its position is its current
// view: centre, and zoom as a level (log2 of image pixels per screen pixel). Its speed is how
// fast it has been moving lately, in "screens per second" (panning one screen width is a
// distance of 1) and "levels per second" (zooming 2x is a distance of 1), with a floor, since
// a user standing still can start moving at any moment.
//
// The time a user needs to reach a unit is its distance to the unit divided by its speed.
// Two users with speeds vA and vB reach a point P at the same moment when |PA| / |PB| =
// vA / vB: that locus is a circle of Apollonius, and all the pairs together split the image
// into regions of "who gets there first" (a multiplicatively weighted Voronoi diagram).
//
// From this the server asks, for any unit:
//   interest   how many users can reach it within HORIZON_S (its potential demand), and
//   first      which user reaches it first.
//
// The server uses interest to decide what its shared packet cache keeps: a unit several users
// are heading for is worth keeping, one nobody can reach soon goes first.
//
// And it uses each pursuer's speed to share its own upload when users want more than it can
// send: a user sweeping across the image will have left the view before its detail lands,
// one standing still will be looking at it. Each busy user gets a share in proportion to
// 1 / (1 + speed): someone still gets most of it, someone moving fast still gets some.
//
// Tried and dropped: warming (preparing ahead of time the units several users converged on)
// read more from disk, and prefetching each user's predicted path on idle capacity sent 3 MB
// more per session on the 75k image. On the images measured so far this eviction policy
// performs the same as plain LRU; see README.

import type { UnitId, View } from "../shared/wire.ts";
import type { PreparedImage } from "./image.ts";

export const HORIZON_S = 2;
const SPEED_FLOOR = 0.5;          // screens (or levels) per second: anyone can start moving
const SPEED_HALFLIFE_S = 1;       // how quickly a remembered speed fades once a user stops
const MOVING_HALFLIFE_MS = 150;   // the same, for "is it moving right now" (upload sharing)

interface Pursuer {
  image: PreparedImage;
  view: View;
  z: number;                      // zoom level of the view: log2(scale)
  at: number;                     // when the view was seen (ms)
  vx: number;                     // image px per second
  vy: number;
  vz: number;                     // levels per second
  speed: number;                  // screens-or-levels per second, remembered, fading
}

export class Apollonius {
  private pursuers = new Map<string, Pursuer>();

  /** A user sent a view: update its position, velocity and speed. */
  see(user: string, image: PreparedImage, v: View): void {
    const now = performance.now();
    const z = Math.log2(Math.max(v.scale, 1e-9));
    const p = this.pursuers.get(user);
    if (!p || p.image !== image) {
      this.pursuers.set(user, { image, view: v, z, at: now, vx: 0, vy: 0, vz: 0, speed: SPEED_FLOOR });
      return;
    }
    const dt = Math.max(0.016, (now - p.at) / 1000);
    const a = Math.min(1, dt / 0.25);                      // smooth over about a quarter second
    p.vx += a * ((v.cx - p.view.cx) / dt - p.vx);
    p.vy += a * ((v.cy - p.view.cy) / dt - p.vy);
    p.vz += a * ((z - p.z) / dt - p.vz);
    const screen = v.screenW * v.scale;                    // image px in one screen width
    const now_speed = Math.hypot(Math.hypot(p.vx, p.vy) / screen, p.vz);
    p.speed = Math.max(SPEED_FLOOR, Math.max(now_speed, this.faded(p, now)));
    p.view = v;
    p.z = z;
    p.at = now;
  }

  forget(user: string): void {
    this.pursuers.delete(user);
  }

  get users(): number {
    return this.pursuers.size;
  }

  /**
   * How fast a user is moving right now, in screens (or levels) per second, for sharing the
   * upload: the speed of its last move, halved every MOVING_HALFLIFE_MS it has been still.
   * Much shorter than the memory used for reach (a user who jumped to a spot 200 ms ago is
   * standing there now, and needs the data most), and 0 for a user standing still.
   */
  speed(user: string): number {
    const p = this.pursuers.get(user);
    if (!p) return 0;
    const moved = Math.max(0, p.speed - SPEED_FLOOR);
    return moved * 0.5 ** ((performance.now() - p.at) / MOVING_HALFLIFE_MS);
  }

  /** The remembered speed, faded by how long the user has been still. */
  private faded(p: Pursuer, now: number): number {
    return SPEED_FLOOR + (p.speed - SPEED_FLOOR) * 0.5 ** ((now - p.at) / 1000 / SPEED_HALFLIFE_S);
  }

  /**
   * Seconds until a user can reach a unit. Distance: how far the unit's rectangle is from the
   * view's, in screen widths, and how many levels finer than the view's the unit is (a
   * coarser unit is already part of what the view draws).
   */
  arrival(p: Pursuer, u: UnitId, now: number): number {
    const c = p.image.chart, T = c.tile, span = T * 2 ** u.level, v = p.view;
    const [w, h] = p.image.unitSize(u.level, u.x, u.y);
    const ux0 = u.x * span, ux1 = ux0 + w * 2 ** u.level, uy0 = u.y * span, uy1 = uy0 + h * 2 ** u.level;
    const vx0 = v.cx - (v.screenW * v.scale) / 2, vx1 = v.cx + (v.screenW * v.scale) / 2;
    const vy0 = v.cy - (v.screenH * v.scale) / 2, vy1 = v.cy + (v.screenH * v.scale) / 2;
    const gapX = Math.max(0, ux0 - vx1, vx0 - ux1), gapY = Math.max(0, uy0 - vy1, vy0 - uy1);
    const screens = Math.hypot(gapX, gapY) / (v.screenW * v.scale);
    const levels = Math.max(0, Math.floor(p.z) - u.level);
    return Math.hypot(screens, levels) / this.faded(p, now);
  }

  /** How many users can reach the unit within the horizon, and who gets there first. */
  demand(image: PreparedImage, u: UnitId): { interest: number; first: string | null; soonest: number } {
    const now = performance.now();
    let interest = 0, first: string | null = null, soonest = Infinity;
    for (const [user, p] of this.pursuers) {
      if (p.image !== image) continue;
      const t = this.arrival(p, u, now);
      if (t <= HORIZON_S) interest++;
      if (t < soonest) { soonest = t; first = user; }
    }
    return { interest, first, soonest };
  }



}
