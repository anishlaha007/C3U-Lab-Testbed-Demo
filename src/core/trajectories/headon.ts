/**
 * Head-on: two drones on one line, closing at speed v each from a start gap. Each coasts at
 * constant speed (zero planned acceleration) until it has travelled the gap plus 0.6 m, i.e. past
 * the other drone's start, then decelerates at 3 m/s^2 and stops. The planned paths cross, so
 * only the safety filter keeps them apart; the long coast keeps the nominal input at zero
 * through the closest approach, as in the preliminary study.
 */
import type { Trajectory } from '../types';
import { v3 } from '../vec';
import { defaultMeta, trajectoryFromFunction } from './common';

export interface HeadonParams {
  speed: number;
  gap: number;
  z0: number;
  /** Lateral offset of the line (m). */
  y0?: number;
  overshoot?: number;
  decel?: number;
  /**
   * Preliminary-study variant: coast at constant velocity for the whole window (zero planned
   * acceleration; the plan leaves the arena, so it is meant for the pure double-integrator
   * test mode).
   */
  coast?: boolean;
  /** Coast window after crossing (s), coast variant only. */
  coastTime?: number;
}

export function headonPoint(prm: HeadonParams, dir: 1 | -1, t: number) {
  const { speed: v, gap, z0 } = prm;
  const over = prm.overshoot ?? 0.6;
  const dec = prm.decel ?? 3;
  const x0 = -dir * (gap / 2);
  const L1 = prm.coast ? Infinity : gap + over;
  const t1 = L1 / v;
  const tStop = v / dec;
  let s: number;
  let sd: number;
  let sdd: number;
  if (t <= t1) {
    s = v * t;
    sd = v;
    sdd = 0;
  } else if (t <= t1 + tStop) {
    const tau = t - t1;
    s = L1 + v * tau - 0.5 * dec * tau * tau;
    sd = v - dec * tau;
    sdd = -dec;
  } else {
    s = L1 + (v * v) / (2 * dec);
    sd = 0;
    sdd = 0;
  }
  return {
    p: v3(x0 + dir * s, prm.y0 ?? 0, z0),
    v: v3(dir * sd, 0, 0),
    a: v3(dir * sdd, 0, 0),
    yaw: dir > 0 ? 0 : Math.PI,
  };
}

export function headon(prm: HeadonParams): Trajectory[] {
  const over = prm.overshoot ?? 0.6;
  const dec = prm.decel ?? 3;
  const T = prm.coast ? prm.gap / (2 * prm.speed) + (prm.coastTime ?? 3) : (prm.gap + over) / prm.speed + prm.speed / dec + 0.5;
  return ([1, -1] as const).map((dir, i) =>
    trajectoryFromFunction(T, (t) => headonPoint(prm, dir, t), defaultMeta({ drone_id: i, track_id: 'headon', strategy: 'straight' })),
  );
}
