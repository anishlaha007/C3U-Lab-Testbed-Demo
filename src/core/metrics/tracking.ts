/**
 * Tracking metrics M1-M9 (Section 9). Tracking error e(t) = p(t) - p_ref(t) against the nominal
 * reference; along-track e_along = e . t_hat (t_hat = unit reference velocity) and cross-track
 * e_cross = e - e_along t_hat.
 */
import type { TrialLog } from '../types';
import { mean, windowLength } from './window';

export interface TrackingMetrics {
  /** M1 tracking RMSE (m). */
  rmse: number;
  /** M2 max tracking error (m). */
  maxError: number;
  /** M3 along-track RMS (m). */
  alongRms: number;
  /** M4 cross-track RMS (m). */
  crossRms: number;
  /** M5 mean lap time (s) and planned lap time. */
  lapTime: number;
  plannedLapTime: number;
  /** M6 mean and peak speed (m/s). */
  meanSpeed: number;
  peakSpeed: number;
  /** M8 completion rate (0..1). */
  completion: number;
  /** M9 share of planned samples failing the feasibility check. */
  feasibilityFail: number;
  samples: number;
}

/** Per-sample tracking error series for drone i (analysis window). */
export function errorSeries(log: TrialLog, i: number): { t: number[]; e: number[]; along: number[]; cross: number[] } {
  const n = windowLength(log);
  const d = log.drones[i];
  const out = { t: [] as number[], e: [] as number[], along: [] as number[], cross: [] as number[] };
  for (let k = 0; k < n; k++) {
    if (d.mode[k] >= 3) break; // killed or crashed: stop the tracking analysis
    const ex = d.px[k] - d.rx[k];
    const ey = d.py[k] - d.ry[k];
    const ez = d.pz[k] - d.rz[k];
    const vn = Math.hypot(d.rvx[k], d.rvy[k], d.rvz[k]);
    let along = 0;
    let cx = ex;
    let cy = ey;
    let cz = ez;
    if (vn > 0.05) {
      const tx = d.rvx[k] / vn;
      const ty = d.rvy[k] / vn;
      const tz = d.rvz[k] / vn;
      along = ex * tx + ey * ty + ez * tz;
      cx = ex - along * tx;
      cy = ey - along * ty;
      cz = ez - along * tz;
    }
    out.t.push(log.t[k]);
    out.e.push(Math.hypot(ex, ey, ez));
    out.along.push(along);
    out.cross.push(Math.hypot(cx, cy, cz));
  }
  return out;
}

const rms = (xs: number[]) => (xs.length ? Math.sqrt(xs.reduce((a, x) => a + x * x, 0) / xs.length) : NaN);

export function trackingMetrics(log: TrialLog, i: number): TrackingMetrics {
  const attemptedLaps = log.planned.laps[i] ?? 0;
  const s = errorSeries(log, i);
  const n = windowLength(log);
  const d = log.drones[i];
  const speeds: number[] = [];
  for (let k = 0; k < n; k++) {
    if (d.mode[k] >= 3) break;
    speeds.push(Math.hypot(d.vx[k], d.vy[k], d.vz[k]));
  }
  const laps = log.summary.lapTimes[i] ?? [];
  const crashed = ['collision', 'kill', 'arenaExit'].includes(log.summary.endReason) && d.mode[d.mode.length - 1] >= 3;
  let completion: number;
  const gates = log.summary.gates[i];
  if (gates && gates.attempted > 0) {
    completion = Number.isFinite(gates.finishTime) ? 1 : gates.passes / Math.max(1, gates.passes + gates.misses + (crashed ? 1 : 0));
  } else if (attemptedLaps > 0) {
    completion = Math.min(1, laps.length / attemptedLaps);
  } else {
    completion = crashed ? 0 : 1;
  }
  return {
    rmse: rms(s.e),
    maxError: s.e.length ? Math.max(...s.e) : NaN,
    alongRms: rms(s.along),
    crossRms: rms(s.cross),
    lapTime: laps.length ? mean(laps) : NaN,
    plannedLapTime: log.planned.lapTime[i] ?? NaN,
    meanSpeed: mean(speeds),
    peakSpeed: speeds.length ? Math.max(...speeds) : NaN,
    completion,
    feasibilityFail: log.planned.feasibilityFail[i] ?? 0,
    samples: s.e.length,
  };
}

/**
 * Arrival at the final planned point for non-periodic trajectories: first logged time within
 * 0.15 m of the final reference position (NaN if never), and the share of the planned
 * straight-line distance covered by the end of the log.
 */
export function arrival(log: TrialLog, i: number): { time: number; covered: number } {
  const d = log.drones[i];
  const n = d.px.length;
  if (!n) return { time: NaN, covered: 0 };
  const fx = d.rx[n - 1];
  const fy = d.ry[n - 1];
  const fz = d.rz[n - 1];
  let time = NaN;
  for (let k = 0; k < n; k++) {
    if (d.mode[k] >= 3) break;
    if (Math.hypot(d.px[k] - fx, d.py[k] - fy, d.pz[k] - fz) < 0.15) {
      time = log.t[k];
      break;
    }
  }
  const d0 = Math.hypot(d.px[0] - fx, d.py[0] - fy, d.pz[0] - fz);
  const d1 = Math.hypot(d.px[n - 1] - fx, d.py[n - 1] - fy, d.pz[n - 1] - fz);
  return { time, covered: d0 > 1e-6 ? Math.max(0, Math.min(1, 1 - d1 / d0)) : 1 };
}
