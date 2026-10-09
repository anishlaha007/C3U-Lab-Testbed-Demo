/**
 * Random crossing (T8): N drones, seeded start/end points on the arena's outer band, each flying a
 * smooth minimum-jerk spline through a waypoint in the centre region, timed so everybody crosses
 * the centre at about the same time.
 */
import { Rng, deriveSeed } from '../rng';
import type { ArenaConfig, Trajectory } from '../types';
import { v3, type Vec3 } from '../vec';
import { defaultMeta, trajectoryFromFunction } from './common';
import { minDerivSpline } from './minJerk';

export interface RandomParams {
  n: number;
  seed: number;
  speed: number;
  arena: ArenaConfig;
  z0: number;
}

export function randomCrossing(p: RandomParams): Trajectory[] {
  const rng = new Rng(deriveSeed(p.seed, 'randomCrossing'));
  const hx = p.arena.sx / 2 - 0.8;
  const hy = p.arena.sy / 2 - 0.7;
  const starts: Vec3[] = [];
  const ends: Vec3[] = [];
  const centres: Vec3[] = [];
  const zr = () => Math.max(0.6, Math.min(p.arena.sz - 0.8, p.z0 + rng.uniform(-0.35, 0.35)));
  for (let i = 0; i < p.n; i++) {
    let s: Vec3 = v3();
    for (let tries = 0; tries < 200; tries++) {
      const ang = rng.uniform(0, 2 * Math.PI);
      s = v3(hx * Math.cos(ang), hy * Math.sin(ang), zr());
      if (starts.every((q) => Math.hypot(q.x - s.x, q.y - s.y) > 1.0)) break;
    }
    starts.push(s);
    // end roughly opposite, jittered
    let e: Vec3 = v3();
    for (let tries = 0; tries < 200; tries++) {
      const ang = Math.atan2(-s.y / hy, -s.x / hx) + rng.uniform(-0.6, 0.6);
      e = v3(hx * Math.cos(ang), hy * Math.sin(ang), zr());
      if (ends.every((q) => Math.hypot(q.x - e.x, q.y - e.y) > 1.0)) break;
    }
    ends.push(e);
    centres.push(v3(rng.uniform(-0.6, 0.6), rng.uniform(-0.45, 0.45), zr()));
  }
  // common crossing time: the longest first leg at the target speed
  const leg = (a: Vec3, b: Vec3) => Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  const Tc = Math.max(...starts.map((s, i) => leg(s, centres[i]))) / p.speed;
  return starts.map((s, i) => {
    const T2 = Math.max(1.0, leg(centres[i], ends[i]) / p.speed);
    const sp = minDerivSpline([s, centres[i], ends[i]], [Tc * 1.25, T2 * 1.25], { order: 3, closed: false });
    const T = sp.duration;
    const tr = trajectoryFromFunction(T + 0.8, (t) => {
      const e = sp.eval(Math.min(t, T));
      return t > T ? { p: e.p, v: v3(), a: v3() } : { p: e.p, v: e.v, a: e.a };
    }, defaultMeta({ drone_id: i, track_id: 'random', solver: 'min_jerk', strategy: 'random-crossing' }));
    return tr;
  });
}
