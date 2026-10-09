/**
 * Antipodal swap: N drones evenly spaced on a circle, each flying straight to the opposite
 * point at the same time (rest-to-rest minimum-jerk profile). Everyone meets in the middle.
 */
import type { Trajectory } from '../types';
import { v3 } from '../vec';
import { defaultMeta, trajectoryFromFunction } from './common';
import { minJerkLine } from './minJerk';

export interface AntipodalParams {
  n: number;
  radius: number;
  z0: number;
  /** Peak speed (m/s). */
  speed: number;
  hold?: number;
}

export function antipodal(prm: AntipodalParams): Trajectory[] {
  const D = 2 * prm.radius;
  // rest-to-rest minimum jerk: peak speed = 1.875 D / T
  const T = (1.875 * D) / prm.speed;
  const hold = prm.hold ?? 1.0;
  const out: Trajectory[] = [];
  for (let k = 0; k < prm.n; k++) {
    const ang = (2 * Math.PI * k) / prm.n;
    const a = v3(prm.radius * Math.cos(ang), prm.radius * Math.sin(ang), prm.z0);
    const b = v3(-a.x, -a.y, prm.z0);
    out.push(
      trajectoryFromFunction(T + hold, (t) => ({ ...minJerkLine(a, b, T, t), yaw: ang + Math.PI }), defaultMeta({ drone_id: k, track_id: 'antipodal', strategy: 'straight' })),
    );
  }
  return out;
}
