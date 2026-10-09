/**
 * Trajectory construction, sampling and time scaling helpers.
 *
 * A trajectory is stored at a fixed sample period (100 Hz). The executor samples it at arbitrary
 * race times: position by cubic Hermite interpolation (using the stored velocity), velocity and
 * acceleration linearly. Before the start the first sample is held; after the end the final
 * position is held with zero velocity and acceleration (hover).
 *
 * Time scaling with speed multiplier k (Section 5.1): t -> t / k, so p_k(t) = p(k t),
 * v_k(t) = k v(k t), a_k(t) = k^2 a(k t).
 */
import { TRAJ_DT } from '../constants';
import type { Setpoint, Trajectory, TrajectoryMeta } from '../types';
import { v3, type Vec3 } from '../vec';

export interface TrajPoint {
  p: Vec3;
  v: Vec3;
  a: Vec3;
  yaw?: number;
}

export function defaultMeta(partial: Partial<TrajectoryMeta> = {}): TrajectoryMeta {
  return {
    run_id: 'sim',
    drone_id: 0,
    strategy: 'nominal',
    solver: 'analytic',
    dynamics_model: 'double_integrator',
    d_min_assumed: 0.24,
    track_id: 'none',
    sample_period: TRAJ_DT,
    created: '1970-01-01T00:00:00Z',
    ...partial,
  };
}

export function allocTrajectory(n: number, meta: TrajectoryMeta): Trajectory {
  return {
    meta,
    t: new Float64Array(n),
    x: new Float64Array(n),
    y: new Float64Array(n),
    z: new Float64Array(n),
    vx: new Float64Array(n),
    vy: new Float64Array(n),
    vz: new Float64Array(n),
    ax: new Float64Array(n),
    ay: new Float64Array(n),
    az: new Float64Array(n),
    yaw: new Float64Array(n),
  };
}

export function setPoint(tr: Trajectory, i: number, t: number, pt: TrajPoint): void {
  tr.t[i] = t;
  tr.x[i] = pt.p.x;
  tr.y[i] = pt.p.y;
  tr.z[i] = pt.p.z;
  tr.vx[i] = pt.v.x;
  tr.vy[i] = pt.v.y;
  tr.vz[i] = pt.v.z;
  tr.ax[i] = pt.a.x;
  tr.ay[i] = pt.a.y;
  tr.az[i] = pt.a.z;
  tr.yaw[i] = pt.yaw ?? NaN;
}

/**
 * Build a trajectory by sampling an analytic function f(t) on [0, duration] at period dt.
 * Yaw defaults to the (unwrapped) heading of the horizontal velocity.
 */
export function trajectoryFromFunction(
  duration: number,
  f: (t: number) => TrajPoint,
  meta: TrajectoryMeta,
  dt = TRAJ_DT,
): Trajectory {
  const n = Math.max(2, Math.round(duration / dt) + 1);
  const tr = allocTrajectory(n, { ...meta, sample_period: dt });
  for (let i = 0; i < n; i++) {
    const t = i * dt;
    setPoint(tr, i, t, f(t));
  }
  fillYawFromHeading(tr);
  return tr;
}

/** Replace NaN yaw entries by the unwrapped heading of the horizontal velocity. */
export function fillYawFromHeading(tr: Trajectory): void {
  const n = tr.t.length;
  let last = 0;
  let found = false;
  // initial heading: first sample with noticeable horizontal speed
  for (let i = 0; i < n; i++) {
    if (Math.hypot(tr.vx[i], tr.vy[i]) > 1e-3) {
      last = Math.atan2(tr.vy[i], tr.vx[i]);
      found = true;
      break;
    }
  }
  if (!found) last = 0;
  for (let i = 0; i < n; i++) {
    if (!Number.isNaN(tr.yaw[i])) {
      last = tr.yaw[i];
      continue;
    }
    const sp = Math.hypot(tr.vx[i], tr.vy[i]);
    if (sp > 1e-3) {
      let h = Math.atan2(tr.vy[i], tr.vx[i]);
      // unwrap relative to the previous yaw
      while (h - last > Math.PI) h -= 2 * Math.PI;
      while (h - last < -Math.PI) h += 2 * Math.PI;
      last = h;
    }
    tr.yaw[i] = last;
  }
}

export function trajDuration(tr: Trajectory): number {
  return tr.t[tr.t.length - 1] - tr.t[0];
}

/** Duration after applying speed multiplier k. */
export function scaledDuration(tr: Trajectory, k: number): number {
  return trajDuration(tr) / k;
}

export function pointAt(tr: Trajectory, i: number): TrajPoint {
  return {
    p: v3(tr.x[i], tr.y[i], tr.z[i]),
    v: v3(tr.vx[i], tr.vy[i], tr.vz[i]),
    a: v3(tr.ax[i], tr.ay[i], tr.az[i]),
    yaw: tr.yaw[i],
  };
}

/** Sample a trajectory at time t (unscaled). */
export function sampleTrajectory(tr: Trajectory, t: number): Setpoint {
  const n = tr.t.length;
  const t0 = tr.t[0];
  const tEnd = tr.t[n - 1];
  if (t <= t0) {
    const pt = pointAt(tr, 0);
    return { p: pt.p, v: pt.v, a: pt.a, yaw: pt.yaw ?? 0 };
  }
  if (t >= tEnd) {
    const pt = pointAt(tr, n - 1);
    return { p: pt.p, v: v3(), a: v3(), yaw: pt.yaw ?? 0 };
  }
  // uniform sampling assumed for index lookup, fall back to binary search otherwise
  const dt = tr.meta.sample_period > 0 ? tr.meta.sample_period : (tEnd - t0) / (n - 1);
  let i = Math.min(n - 2, Math.max(0, Math.floor((t - t0) / dt)));
  if (!(tr.t[i] <= t && t <= tr.t[i + 1])) i = searchIndex(tr.t, t);
  const h = tr.t[i + 1] - tr.t[i];
  const s = h > 0 ? (t - tr.t[i]) / h : 0;
  // cubic Hermite for position
  const s2 = s * s;
  const s3 = s2 * s;
  const h00 = 2 * s3 - 3 * s2 + 1;
  const h10 = s3 - 2 * s2 + s;
  const h01 = -2 * s3 + 3 * s2;
  const h11 = s3 - s2;
  const j = i + 1;
  const herm = (p0: number, v0: number, p1: number, v1: number) => h00 * p0 + h10 * h * v0 + h01 * p1 + h11 * h * v1;
  const lin = (a: number, b: number) => a + (b - a) * s;
  let yaw0 = tr.yaw[i];
  let yaw1 = tr.yaw[j];
  if (Number.isNaN(yaw0)) yaw0 = 0;
  if (Number.isNaN(yaw1)) yaw1 = yaw0;
  return {
    p: v3(
      herm(tr.x[i], tr.vx[i], tr.x[j], tr.vx[j]),
      herm(tr.y[i], tr.vy[i], tr.y[j], tr.vy[j]),
      herm(tr.z[i], tr.vz[i], tr.z[j], tr.vz[j]),
    ),
    v: v3(lin(tr.vx[i], tr.vx[j]), lin(tr.vy[i], tr.vy[j]), lin(tr.vz[i], tr.vz[j])),
    a: v3(lin(tr.ax[i], tr.ax[j]), lin(tr.ay[i], tr.ay[j]), lin(tr.az[i], tr.az[j])),
    yaw: lin(yaw0, yaw1),
  };
}

function searchIndex(ts: Float64Array, t: number): number {
  let lo = 0;
  let hi = ts.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (ts[mid] <= t) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Sample with speed multiplier k at race time tRace (Section 5.1 time scaling). */
export function sampleScaled(tr: Trajectory, tRace: number, k: number): Setpoint {
  const sp = sampleTrajectory(tr, tRace * k);
  return {
    p: sp.p,
    v: { x: sp.v.x * k, y: sp.v.y * k, z: sp.v.z * k },
    a: { x: sp.a.x * k * k, y: sp.a.y * k * k, z: sp.a.z * k * k },
    yaw: sp.yaw,
  };
}

/** Materialise a time-scaled copy of a trajectory (used for export and feasibility). */
export function timeScaleTrajectory(tr: Trajectory, k: number): Trajectory {
  if (k === 1) return tr;
  const n = tr.t.length;
  const out = allocTrajectory(n, { ...tr.meta, sample_period: tr.meta.sample_period / k });
  for (let i = 0; i < n; i++) {
    out.t[i] = tr.t[i] / k;
    out.x[i] = tr.x[i];
    out.y[i] = tr.y[i];
    out.z[i] = tr.z[i];
    out.vx[i] = tr.vx[i] * k;
    out.vy[i] = tr.vy[i] * k;
    out.vz[i] = tr.vz[i] * k;
    out.ax[i] = tr.ax[i] * k * k;
    out.ay[i] = tr.ay[i] * k * k;
    out.az[i] = tr.az[i] * k * k;
    out.yaw[i] = tr.yaw[i];
  }
  out.lapPeriod = tr.lapPeriod !== undefined ? tr.lapPeriod / k : undefined;
  out.laps = tr.laps;
  return out;
}

/** Resample a trajectory to the standard period (used after time scaling for export). */
export function resampleTrajectory(tr: Trajectory, dt = TRAJ_DT): Trajectory {
  const dur = trajDuration(tr);
  const t0 = tr.t[0];
  const out = trajectoryFromFunction(
    dur,
    (t) => {
      const sp = sampleTrajectory(tr, t0 + t);
      return { p: sp.p, v: sp.v, a: sp.a, yaw: sp.yaw };
    },
    { ...tr.meta, sample_period: dt },
    dt,
  );
  out.lapPeriod = tr.lapPeriod;
  out.laps = tr.laps;
  return out;
}

/** Hover trajectory at a fixed point. */
export function hoverTrajectory(p: Vec3, duration: number, meta: TrajectoryMeta): Trajectory {
  return trajectoryFromFunction(duration, () => ({ p, v: v3(), a: v3(), yaw: 0 }), meta);
}

/** Planned path length (m). */
export function pathLength(tr: Trajectory): number {
  let L = 0;
  for (let i = 1; i < tr.t.length; i++) {
    L += Math.hypot(tr.x[i] - tr.x[i - 1], tr.y[i] - tr.y[i - 1], tr.z[i] - tr.z[i - 1]);
  }
  return L;
}

/**
 * Fill velocity and acceleration of a position-only trajectory by central finite differences,
 * after smoothing (used for CSV import with only t, x, y, z).
 */
export function differentiatePositions(tr: Trajectory): void {
  const n = tr.t.length;
  const d = (arr: Float64Array, out: Float64Array) => {
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1);
      const b = Math.min(n - 1, i + 1);
      const dt = tr.t[b] - tr.t[a];
      out[i] = dt > 0 ? (arr[b] - arr[a]) / dt : 0;
    }
  };
  d(tr.x, tr.vx);
  d(tr.y, tr.vy);
  d(tr.z, tr.vz);
  d(tr.vx, tr.ax);
  d(tr.vy, tr.ay);
  d(tr.vz, tr.az);
}
