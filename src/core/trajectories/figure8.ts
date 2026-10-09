/**
 * Figure-8 (lemniscate of Gerono): x = A sin(theta), y = (A/2) sin(2 theta), z = z0,
 * theta = w t + phase.
 *
 * Derivatives:  v = A w (cos th, cos 2th, 0)
 *               a = -A w^2 (sin th, 2 sin 2th, 0)
 * |a|^2 = A^2 w^4 (sin^2 th + 4 sin^2 2th) = A^2 w^4 (17u - 16u^2), u = sin^2 th,
 * maximised at u = 17/32, giving a peak of (17/8) A w^2 = 2.125 A w^2
 * (= 3.1875 w^2 for A = 1.5 m, the "3.187" coefficient of the prompt).
 */
import { G } from '../constants';
import type { Trajectory, TrajectoryMeta } from '../types';
import { v3 } from '../vec';
import { defaultMeta, trajectoryFromFunction } from './common';

export interface Figure8Params {
  A: number;
  w: number;
  z0: number;
  phase?: number;
  laps?: number;
  /** Mirror x (x -> -x), used by the intersection scenario. */
  mirrorX?: boolean;
  /** Centre offset. */
  cx?: number;
  cy?: number;
}

/** Peak acceleration of the figure-8 divided by A w^2. */
export const FIGURE8_PEAK_ACCEL_COEFF = 17 / 8;

export function figure8Point(p: Figure8Params, t: number) {
  const th = p.w * t + (p.phase ?? 0);
  const sx = p.mirrorX ? -1 : 1;
  const { A, w } = p;
  const s1 = Math.sin(th);
  const c1 = Math.cos(th);
  const s2 = Math.sin(2 * th);
  const c2 = Math.cos(2 * th);
  return {
    p: v3(sx * A * s1 + (p.cx ?? 0), (A / 2) * s2 + (p.cy ?? 0), p.z0),
    v: v3(sx * A * w * c1, A * w * c2, 0),
    a: v3(-sx * A * w * w * s1, -2 * A * w * w * s2, 0),
  };
}

export function figure8(p: Figure8Params, meta: Partial<TrajectoryMeta> = {}): Trajectory {
  const laps = p.laps ?? 1;
  const period = (2 * Math.PI) / p.w;
  const tr = trajectoryFromFunction(laps * period, (t) => figure8Point(p, t), defaultMeta({ track_id: 'figure8', ...meta }));
  tr.lapPeriod = period;
  tr.laps = laps;
  return tr;
}

/** Peak acceleration magnitude (m/s^2). */
export function figure8PeakAccel(A: number, w: number): number {
  return FIGURE8_PEAK_ACCEL_COEFF * A * w * w;
}

/** Horizontal acceleration limit for a thrust budget eta * TWR * g (planar flight). */
export function horizontalLimit(twr: number, eta: number): number {
  const fmax = eta * twr * G;
  return Math.sqrt(Math.max(0, fmax * fmax - G * G));
}

/** Largest w for which the planar figure-8 stays inside the thrust budget. */
export function figure8MaxW(A: number, twr: number, eta: number): number {
  return Math.sqrt(horizontalLimit(twr, eta) / (FIGURE8_PEAK_ACCEL_COEFF * A));
}

/** Mean speed over one lap (numerical average of |v|). */
export function figure8MeanSpeed(A: number, w: number): number {
  const N = 20000;
  let s = 0;
  for (let i = 0; i < N; i++) {
    const th = (2 * Math.PI * (i + 0.5)) / N;
    s += Math.hypot(Math.cos(th), Math.cos(2 * th));
  }
  return (A * w * s) / N;
}

export function figure8PeakSpeed(A: number, w: number): number {
  return A * w * Math.SQRT2;
}
