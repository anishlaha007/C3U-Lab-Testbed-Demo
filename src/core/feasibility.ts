/**
 * Flatness-based feasibility check (Section 5.3, metric M9).
 *
 * For a point-mass quadrotor the specific thrust needed to follow a reference acceleration a is
 * f = a + g e_z. A sample is flagged when |f| > eta * TWR * g (thrust reserve) or when the
 * tilt acos(f_z / |f|) exceeds theta_max.
 *
 * For TWR 1.8 and eta 0.7: usable thrust 12.4 m/s^2; in planar flight the horizontal limit is
 * sqrt(12.36^2 - 9.81^2) = 7.5 m/s^2 at a tilt of acos(9.81 / 12.36) = 37.5 deg.
 */
import { G } from './constants';
import type { Trajectory } from './types';

export interface FeasibilityResult {
  /** 1 where the sample fails the check. */
  flags: Uint8Array;
  /** Share of failing samples (0..1). */
  share: number;
  peakThrust: number;
  peakTiltDeg: number;
  /** Peak |f| / (TWR g) (share of the maximum thrust used). */
  peakThrustRatio: number;
}

export function usableThrust(twr: number, eta: number): number {
  return eta * twr * G;
}

export function tiltAtLimit(twr: number, eta: number): number {
  return (Math.acos(G / usableThrust(twr, eta)) * 180) / Math.PI;
}

export function checkFeasibility(tr: Trajectory, k: number, twr: number, eta: number, thetaMaxDeg: number): FeasibilityResult {
  const n = tr.t.length;
  const flags = new Uint8Array(n);
  const fmax = usableThrust(twr, eta);
  const thMax = (thetaMaxDeg * Math.PI) / 180;
  let fails = 0;
  let peak = 0;
  let peakTilt = 0;
  const k2 = k * k;
  for (let i = 0; i < n; i++) {
    const fx = tr.ax[i] * k2;
    const fy = tr.ay[i] * k2;
    const fz = tr.az[i] * k2 + G;
    const f = Math.hypot(fx, fy, fz);
    const tilt = f > 1e-9 ? Math.acos(Math.max(-1, Math.min(1, fz / f))) : Math.PI;
    if (f > peak) peak = f;
    if (tilt > peakTilt) peakTilt = tilt;
    if (f > fmax + 1e-9 || tilt > thMax + 1e-9) {
      flags[i] = 1;
      fails++;
    }
  }
  return { flags, share: fails / n, peakThrust: peak, peakTiltDeg: (peakTilt * 180) / Math.PI, peakThrustRatio: peak / (twr * G) };
}

/**
 * Smallest speed multiplier reduction (k_new <= k) for which the trajectory passes the check
 * (accelerations scale with k^2). Returns k if already feasible.
 */
export function feasibleTimeScale(tr: Trajectory, k: number, twr: number, eta: number, thetaMaxDeg: number): number {
  let kk = k;
  for (let it = 0; it < 60; it++) {
    if (checkFeasibility(tr, kk, twr, eta, thetaMaxDeg).share === 0) return kk;
    kk *= 0.97;
  }
  return kk;
}
