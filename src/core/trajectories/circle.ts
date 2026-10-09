/** Circle of radius R at height z0: p = (R cos th, R sin th, z0), th = w t + phase. */
import type { Trajectory, TrajectoryMeta } from '../types';
import { v3 } from '../vec';
import { defaultMeta, trajectoryFromFunction } from './common';

export interface CircleParams {
  radius: number;
  w: number;
  z0: number;
  phase?: number;
  laps?: number;
  cx?: number;
  cy?: number;
}

export function circlePoint(c: CircleParams, t: number) {
  const th = c.w * t + (c.phase ?? 0);
  const { radius: R, w } = c;
  return {
    p: v3(R * Math.cos(th) + (c.cx ?? 0), R * Math.sin(th) + (c.cy ?? 0), c.z0),
    v: v3(-R * w * Math.sin(th), R * w * Math.cos(th), 0),
    a: v3(-R * w * w * Math.cos(th), -R * w * w * Math.sin(th), 0),
  };
}

export function circle(c: CircleParams, meta: Partial<TrajectoryMeta> = {}): Trajectory {
  const laps = c.laps ?? 1;
  const period = (2 * Math.PI) / Math.abs(c.w);
  const tr = trajectoryFromFunction(laps * period, (t) => circlePoint(c, t), defaultMeta({ track_id: 'circle', ...meta }));
  tr.lapPeriod = period;
  tr.laps = laps;
  return tr;
}
