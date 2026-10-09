/**
 * Point-mass quadrotor model with thrust-cone saturation and first-order acceleration lag
 * (Section 4.2). Dynamics use specific thrust f = a + g e_z (m/s^2); mass is display only.
 *
 *   f_cmd = a_cmd + g e_z, projected onto { f_z >= 0, tilt(f) <= theta_max, |f| <= TWR g }
 *           (first the tilt is clamped, then the magnitude)
 *   da/dt = (a_cmd_sat - a) / tau_a
 *   dv/dt = a + w_wind,   dp/dt = v           (semi-implicit Euler at 1 ms)
 */
import { BATTERY_FLIGHT_TIME, G } from './constants';
import type { Rng } from './rng';
import { v3, type Vec3 } from './vec';

export interface DroneState {
  p: Vec3;
  v: Vec3;
  /** Actual acceleration (after lag), excluding wind. */
  a: Vec3;
  /** Specific thrust vector currently produced (m/s^2). */
  f: Vec3;
  yaw: number;
  /** Current thrust-to-weight ratio (battery sag). */
  twr: number;
  /** 'flying' | 'falling' (killed or crashed) | 'landed' (on the floor after a fall). */
  phase: 'flying' | 'falling' | 'landed';
  /** Tumble angular velocity and accumulated angle for crash rendering. */
  tumbleAxis: Vec3;
  tumbleRate: number;
  tumbleAngle: number;
}

export function makeDroneState(p: Vec3, v: Vec3, a: Vec3, yaw: number, twr: number): DroneState {
  return {
    p: { ...p },
    v: { ...v },
    a: { ...a },
    f: { x: a.x, y: a.y, z: a.z + G },
    yaw,
    twr,
    phase: 'flying',
    tumbleAxis: v3(1, 0, 0),
    tumbleRate: 0,
    tumbleAngle: 0,
  };
}

export interface SaturationResult {
  /** Saturated commanded acceleration a_cmd_sat = f_sat - g e_z. */
  a: Vec3;
  f: Vec3;
  saturated: boolean;
}

/** Project a commanded acceleration onto the thrust cone: first tilt, then magnitude. */
export function saturateThrust(aCmd: Vec3, twr: number, thetaMax: number): SaturationResult {
  let fx = aCmd.x;
  let fy = aCmd.y;
  let fz = aCmd.z + G;
  let saturated = false;
  if (fz < 0) {
    fz = 0;
    saturated = true;
  }
  const fh = Math.hypot(fx, fy);
  const fhMax = fz * Math.tan(thetaMax);
  if (fh > fhMax) {
    const s = fh > 0 ? fhMax / fh : 0;
    fx *= s;
    fy *= s;
    saturated = true;
  }
  const fn = Math.hypot(fx, fy, fz);
  const fmax = twr * G;
  if (fn > fmax) {
    const s = fmax / fn;
    fx *= s;
    fy *= s;
    fz *= s;
    saturated = true;
  }
  return { a: v3(fx, fy, fz - G), f: v3(fx, fy, fz), saturated };
}

/**
 * Feasible set used by planners and the safety filter: |a + g e_z| <= eta TWR g and
 * tilt <= theta_max. Clipping keeps the vertical component (altitude priority) and shrinks the
 * horizontal component. Returns the clipped acceleration and whether clipping occurred.
 */
export function clipToFeasible(u: Vec3, twr: number, eta: number, thetaMax: number): { u: Vec3; clipped: boolean } {
  const F = eta * twr * G;
  let clipped = false;
  let fz = u.z + G;
  // vertical: keep thrust between 0 and the budget
  if (fz < 0) {
    fz = 0;
    clipped = true;
  }
  if (fz > F) {
    fz = F;
    clipped = true;
  }
  const fhMax = Math.min(Math.sqrt(Math.max(0, F * F - fz * fz)), fz * Math.tan(thetaMax));
  let ux = u.x;
  let uy = u.y;
  const fh = Math.hypot(ux, uy);
  if (fh > fhMax + 1e-12) {
    const s = fh > 0 ? fhMax / fh : 0;
    ux *= s;
    uy *= s;
    clipped = true;
  }
  return { u: v3(ux, uy, fz - G), clipped };
}

/**
 * Largest acceleration magnitude achievable along unit direction w inside the eta thrust budget:
 * max alpha s.t. |alpha w + g e_z| <= F (ignoring the tilt limit, which is looser for eta < 1).
 */
export function maxAccelAlong(w: Vec3, twr: number, eta: number): number {
  const F = eta * twr * G;
  const wz = w.z;
  const disc = G * G * wz * wz - G * G + F * F;
  return Math.max(0, -G * wz + Math.sqrt(Math.max(0, disc)));
}

export interface DynamicsParams {
  thetaMax: number;
  tauA: number;
  /** Test mode: no lag, no thrust cone; acceleration clipped to pureAccelLimit (norm). */
  pureDoubleIntegrator: boolean;
  pureAccelLimit: number;
}

/** Advance one drone by dt with commanded acceleration aCmd and wind acceleration. */
export function stepDrone(s: DroneState, aCmd: Vec3, wind: Vec3, dt: number, prm: DynamicsParams): { saturated: boolean } {
  if (s.phase !== 'flying') {
    stepFalling(s, dt);
    return { saturated: false };
  }
  if (prm.pureDoubleIntegrator) {
    // exact zero-order-hold integration of a double integrator
    let a = aCmd;
    const n = Math.hypot(a.x, a.y, a.z);
    let saturated = false;
    if (n > prm.pureAccelLimit) {
      a = { x: (a.x * prm.pureAccelLimit) / n, y: (a.y * prm.pureAccelLimit) / n, z: (a.z * prm.pureAccelLimit) / n };
      saturated = true;
    }
    s.p = {
      x: s.p.x + s.v.x * dt + 0.5 * a.x * dt * dt,
      y: s.p.y + s.v.y * dt + 0.5 * a.y * dt * dt,
      z: s.p.z + s.v.z * dt + 0.5 * a.z * dt * dt,
    };
    s.v = { x: s.v.x + a.x * dt, y: s.v.y + a.y * dt, z: s.v.z + a.z * dt };
    s.a = { ...a };
    s.f = { x: a.x, y: a.y, z: a.z + G };
    return { saturated };
  }
  const sat = saturateThrust(aCmd, s.twr, prm.thetaMax);
  const k = prm.tauA > 0 ? 1 - Math.exp(-dt / prm.tauA) : 1;
  s.a = {
    x: s.a.x + (sat.a.x - s.a.x) * k,
    y: s.a.y + (sat.a.y - s.a.y) * k,
    z: s.a.z + (sat.a.z - s.a.z) * k,
  };
  s.f = { x: s.a.x, y: s.a.y, z: s.a.z + G };
  s.v = { x: s.v.x + (s.a.x + wind.x) * dt, y: s.v.y + (s.a.y + wind.y) * dt, z: s.v.z + (s.a.z + wind.z) * dt };
  s.p = { x: s.p.x + s.v.x * dt, y: s.p.y + s.v.y * dt, z: s.p.z + s.v.z * dt };
  return { saturated: sat.saturated };
}

/** Ballistic fall with tumbling after a kill or a crash; rests on the floor. */
export function stepFalling(s: DroneState, dt: number): void {
  if (s.phase === 'landed') return;
  s.v = { x: s.v.x * (1 - 0.3 * dt), y: s.v.y * (1 - 0.3 * dt), z: s.v.z - G * dt };
  s.p = { x: s.p.x + s.v.x * dt, y: s.p.y + s.v.y * dt, z: s.p.z + s.v.z * dt };
  s.a = { x: 0, y: 0, z: -G };
  s.f = { x: 0, y: 0, z: 0 };
  s.tumbleAngle += s.tumbleRate * dt;
  if (s.p.z <= 0.012) {
    s.p.z = 0.012;
    s.v = v3();
    s.phase = 'landed';
    s.tumbleRate = 0;
  }
}

/** Start a crash/kill fall with a random spin (seeded). */
export function startFalling(s: DroneState, rng: Rng, impulse: Vec3 = v3()): void {
  if (s.phase !== 'flying') return;
  s.phase = 'falling';
  s.v = { x: s.v.x * 0.4 + impulse.x, y: s.v.y * 0.4 + impulse.y, z: Math.min(s.v.z, 0) * 0.5 + impulse.z };
  const ax = rng.normal();
  const ay = rng.normal();
  const az = rng.normal() * 0.5;
  const n = Math.hypot(ax, ay, az) || 1;
  s.tumbleAxis = v3(ax / n, ay / n, az / n);
  s.tumbleRate = 8 + 10 * rng.next();
}

/** Thrust-to-weight ratio after linear battery sag over a 7-minute flight. */
export function batteryTwr(twr0: number, sag: number, t: number): number {
  return twr0 * (1 - sag * Math.min(1, t / BATTERY_FLIGHT_TIME));
}

/**
 * Ornstein-Uhlenbeck wind acceleration: dw = -w / tau dt + sigma sqrt(2 / tau) dW, so the
 * stationary standard deviation is sigma. Exact discretisation.
 */
export class OUWind {
  w: Vec3 = v3();
  constructor(private sigma: number, private tau: number, private rng: Rng) {
    if (sigma > 0) this.w = v3(rng.gauss(0, sigma), rng.gauss(0, sigma), rng.gauss(0, sigma * 0.5));
  }
  step(dt: number): Vec3 {
    if (this.sigma <= 0) return this.w;
    const phi = Math.exp(-dt / this.tau);
    const q = this.sigma * Math.sqrt(1 - phi * phi);
    this.w = {
      x: phi * this.w.x + q * this.rng.normal(),
      y: phi * this.w.y + q * this.rng.normal(),
      z: phi * this.w.z + 0.5 * q * this.rng.normal(),
    };
    return this.w;
  }
}
