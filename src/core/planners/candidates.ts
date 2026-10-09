/**
 * Strategy candidates (Section 7.1): a candidate is a lateral (and vertical) offset profile
 * across the lap, smoothed through K control points, times a speed scale. Each candidate is turned
 * into a full trajectory (p, v, a): the offset path is resampled in arc length, a
 * curvature-limited speed profile is computed (forward-backward pass with the drone's
 * acceleration budget), scaled by the speed level, and time-parametrised at 100 Hz. Infeasible
 * candidates are time-scaled down until the thrust/tilt check passes.
 */
import { G, TRAJ_DT } from '../constants';
import { checkFeasibility } from '../feasibility';
import type { Primitive } from '../geometry';
import { distanceToPrimitive, nearBounds, primitiveBounds } from '../geometry';
import { Rng } from '../rng';
import { allocTrajectory, defaultMeta, fillYawFromHeading, timeScaleTrajectory } from '../trajectories/common';
import type { Trajectory } from '../types';
import { v3, type Vec3 } from '../vec';
import { trackAt, type Track } from './track';
import type { Candidate } from './types';

export const OFFSET_LEVELS = [-1, -0.5, 0, 0.5, 1];
export const SPEED_LEVELS = [0.8, 0.85, 0.9, 0.95, 1.0];

export interface CandidateSpec {
  lateral: number[];
  vertical: number[];
  speed: number;
}

export interface DroneLimits {
  twr: number;
  eta: number;
  thetaMaxDeg: number;
  /** Cruise speed cap (m/s). */
  vCap: number;
}

export interface CandidateOptions {
  /** Lateral offset of the drone at s = 0 (m), blended into the profile over `startBlend` m. */
  startLateral: number;
  /** Arc-length position of the drone at t = 0 (m) (staggered starts). */
  startS: number;
  laps: number;
  startBlend?: number;
  /** Obstacles a candidate must not hit (inflated by `clearance`). */
  obstacles?: Primitive[];
  clearance?: number;
  droneId?: number;
  label?: string;
}

/** Smooth periodic (closed) or clamped (open) interpolation of K control values across [0, L]. */
export function profileValue(ctrl: number[], s: number, L: number, closed: boolean): number {
  const K = ctrl.length;
  if (K === 0) return 0;
  // control points sit at the centres of K equal intervals
  const x = (s / L) * K - 0.5;
  if (closed) {
    const i0 = Math.floor(x);
    const f = x - i0;
    const w = 0.5 - 0.5 * Math.cos(Math.PI * f); // cosine blend
    const a = ctrl[((i0 % K) + K) % K];
    const b = ctrl[(((i0 + 1) % K) + K) % K];
    return a + (b - a) * w;
  }
  if (x <= 0) return ctrl[0];
  if (x >= K - 1) return ctrl[K - 1];
  const i0 = Math.floor(x);
  const f = x - i0;
  const w = 0.5 - 0.5 * Math.cos(Math.PI * f);
  return ctrl[i0] + (ctrl[i0 + 1] - ctrl[i0]) * w;
}

/** Offset path for a candidate over `laps` laps (closed) or the whole track (open). */
export function candidatePath(track: Track, spec: CandidateSpec, opts: CandidateOptions): Vec3[] {
  const L = track.length;
  const total = track.closed ? L * opts.laps : L - opts.startS;
  const ds = 0.05;
  const n = Math.max(3, Math.round(total / ds) + 1);
  const blend = opts.startBlend ?? Math.min(1.5, 0.3 * L);
  const pts: Vec3[] = [];
  for (let k = 0; k < n; k++) {
    const sRel = (k / (n - 1)) * total;
    const s = opts.startS + sRel;
    const fr = trackAt(track, s);
    const sLap = track.closed ? ((s % L) + L) % L : s;
    const prof = profileValue(spec.lateral, sLap, L, track.closed);
    const vprof = spec.vertical.length ? profileValue(spec.vertical, sLap, L, track.closed) : 0;
    let lat = prof * fr.w;
    // blend from the drone's start offset into the profile
    if (sRel < blend) {
      const f = 0.5 - 0.5 * Math.cos((Math.PI * sRel) / blend);
      lat = opts.startLateral + (lat - opts.startLateral) * f;
    }
    const vert = vprof * fr.h;
    pts.push(v3(fr.p.x + fr.l.x * lat + fr.u.x * vert, fr.p.y + fr.l.y * lat + fr.u.y * vert, fr.p.z + fr.l.z * lat + fr.u.z * vert));
  }
  return smoothPath(pts, track.closed && opts.laps >= 1 && opts.startS === 0 ? false : false);
}

/** Light 3-point smoothing to remove kinks from the offset blending (endpoints fixed). */
function smoothPath(pts: Vec3[], _closed: boolean): Vec3[] {
  void _closed;
  const out = pts.map((p) => ({ ...p }));
  for (let it = 0; it < 2; it++) {
    for (let k = 1; k < out.length - 1; k++) {
      out[k] = v3(0.25 * out[k - 1].x + 0.5 * out[k].x + 0.25 * out[k + 1].x, 0.25 * out[k - 1].y + 0.5 * out[k].y + 0.25 * out[k + 1].y, 0.25 * out[k - 1].z + 0.5 * out[k].z + 0.25 * out[k + 1].z);
    }
  }
  return out;
}

/** Resample a polyline uniformly in arc length. */
export function resampleUniform(pts: Vec3[], ds: number): { pts: Vec3[]; ds: number } {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y, pts[i].z - pts[i - 1].z));
  const L = cum[cum.length - 1];
  const n = Math.max(2, Math.round(L / ds) + 1);
  const step = L / (n - 1);
  const out: Vec3[] = [];
  let k = 0;
  for (let i = 0; i < n; i++) {
    const s = i * step;
    while (k < cum.length - 2 && cum[k + 1] < s) k++;
    const seg = cum[k + 1] - cum[k];
    const f = seg > 0 ? (s - cum[k]) / seg : 0;
    out.push(v3(pts[k].x + (pts[k + 1].x - pts[k].x) * f, pts[k].y + (pts[k + 1].y - pts[k].y) * f, pts[k].z + (pts[k + 1].z - pts[k].z) * f));
  }
  return { pts: out, ds: step };
}

/**
 * Curvature-limited speed profile along a uniformly sampled path: v <= sqrt(a_lat / kappa),
 * forward pass with the remaining (friction-circle) acceleration, backward pass for braking.
 * Open paths start at v0 and end at rest; closed paths are made periodic by wrapping.
 */
export function speedProfile(pts: Vec3[], ds: number, aMax: number, vCap: number, opts: { closed: boolean; v0?: number; vEnd?: number }): number[] {
  const n = pts.length;
  const kappa = new Array<number>(n).fill(0);
  for (let i = 1; i < n - 1; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const c = pts[i + 1];
    const dx = c.x - 2 * b.x + a.x;
    const dy = c.y - 2 * b.y + a.y;
    const dz = c.z - 2 * b.z + a.z;
    kappa[i] = Math.hypot(dx, dy, dz) / (ds * ds);
  }
  if (n > 2) {
    kappa[0] = kappa[1];
    kappa[n - 1] = kappa[n - 2];
  }
  const aLat = 0.9 * aMax;
  const vmax = kappa.map((k) => Math.min(vCap, k > 1e-6 ? Math.sqrt(aLat / k) : vCap));
  const v = vmax.slice();
  const lon = (vi: number, ki: number) => Math.sqrt(Math.max(0.05 * aMax * aMax, aMax * aMax - (vi * vi * ki) ** 2));
  const passes = opts.closed ? 3 : 1;
  if (!opts.closed) v[0] = Math.min(v[0], opts.v0 ?? vCap);
  for (let p = 0; p < passes; p++) {
    for (let i = 0; i < n - 1; i++) v[i + 1] = Math.min(v[i + 1], Math.sqrt(v[i] * v[i] + 2 * lon(v[i], kappa[i]) * ds));
    if (opts.closed) v[0] = Math.min(v[0], v[n - 1]);
  }
  if (!opts.closed) v[n - 1] = Math.min(v[n - 1], opts.vEnd ?? 0);
  for (let p = 0; p < passes; p++) {
    for (let i = n - 1; i > 0; i--) v[i - 1] = Math.min(v[i - 1], Math.sqrt(v[i] * v[i] + 2 * lon(v[i], kappa[i]) * ds));
    if (opts.closed) v[n - 1] = Math.min(v[n - 1], v[0]);
  }
  return v.map((x) => Math.max(x, 0.05));
}

/**
 * Time-parametrise a uniformly sampled path with a speed profile and sample it at 100 Hz.
 * Velocity v T, acceleration v dv/ds T + v^2 dT/ds (finite differences on the path).
 */
export function pathToTrajectory(pts: Vec3[], ds: number, v: number[], meta = defaultMeta()): Trajectory {
  const n = pts.length;
  // arrival time at each sample
  const tk = new Float64Array(n);
  for (let i = 1; i < n; i++) tk[i] = tk[i - 1] + (2 * ds) / (v[i] + v[i - 1]);
  const T = tk[n - 1];
  const m = Math.max(2, Math.floor(T / TRAJ_DT) + 1);
  const tr = allocTrajectory(m, { ...meta, sample_period: TRAJ_DT });
  const tangent = (i: number): Vec3 => {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(n - 1, i + 1)];
    const d = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) || 1;
    return v3((b.x - a.x) / d, (b.y - a.y) / d, (b.z - a.z) / d);
  };
  const T0: Vec3[] = pts.map((_, i) => tangent(i));
  let j = 0;
  for (let q = 0; q < m; q++) {
    const t = Math.min(T, q * TRAJ_DT);
    while (j < n - 2 && tk[j + 1] < t) j++;
    const seg = tk[j + 1] - tk[j];
    const f = seg > 0 ? (t - tk[j]) / seg : 0;
    // constant acceleration along the segment: s(f) consistent with linear v in time
    const vj = v[j];
    const vj1 = v[j + 1];
    const aT = seg > 0 ? (vj1 - vj) / seg : 0;
    const tau = t - tk[j];
    const sLocal = Math.min(ds, vj * tau + 0.5 * aT * tau * tau);
    const g = ds > 0 ? sLocal / ds : f;
    const p = v3(pts[j].x + (pts[j + 1].x - pts[j].x) * g, pts[j].y + (pts[j + 1].y - pts[j].y) * g, pts[j].z + (pts[j + 1].z - pts[j].z) * g);
    const speed = vj + aT * tau;
    const ti = v3(T0[j].x + (T0[j + 1].x - T0[j].x) * g, T0[j].y + (T0[j + 1].y - T0[j].y) * g, T0[j].z + (T0[j + 1].z - T0[j].z) * g);
    const tn = Math.hypot(ti.x, ti.y, ti.z) || 1;
    const tu = v3(ti.x / tn, ti.y / tn, ti.z / tn);
    // dT/ds from neighbouring tangents
    const ja = Math.max(0, j - 1);
    const jb = Math.min(n - 1, j + 2);
    const dsab = (jb - ja) * ds;
    const dT = v3((T0[jb].x - T0[ja].x) / dsab, (T0[jb].y - T0[ja].y) / dsab, (T0[jb].z - T0[ja].z) / dsab);
    const acc = v3(aT * tu.x + speed * speed * dT.x, aT * tu.y + speed * speed * dT.y, aT * tu.z + speed * speed * dT.z);
    tr.t[q] = q * TRAJ_DT;
    tr.x[q] = p.x;
    tr.y[q] = p.y;
    tr.z[q] = p.z;
    tr.vx[q] = speed * tu.x;
    tr.vy[q] = speed * tu.y;
    tr.vz[q] = speed * tu.z;
    tr.ax[q] = acc.x;
    tr.ay[q] = acc.y;
    tr.az[q] = acc.z;
    tr.yaw[q] = NaN;
  }
  // smooth the acceleration a little (finite-difference noise)
  const sm = (arr: Float64Array) => {
    const c = arr.slice();
    for (let q = 2; q < m - 2; q++) arr[q] = (c[q - 2] + 2 * c[q - 1] + 3 * c[q] + 2 * c[q + 1] + c[q + 2]) / 9;
  };
  sm(tr.ax);
  sm(tr.ay);
  sm(tr.az);
  fillYawFromHeading(tr);
  return tr;
}

/** Horizontal acceleration budget for planning (eta-limited). */
export function planningAccel(lim: DroneLimits): number {
  const F = lim.eta * lim.twr * G;
  return Math.sqrt(Math.max(0, F * F - G * G));
}

/** Does a path hit any obstacle (inflated by clearance)? */
export function pathHitsObstacles(pts: Vec3[], obstacles: Primitive[], clearance: number, stride = 2): boolean {
  for (const prim of obstacles) {
    if (prim.kind === 'plane') continue;
    const b = primitiveBounds(prim);
    for (let i = 0; i < pts.length; i += stride) {
      if (!nearBounds(pts[i], b, clearance)) continue;
      if (distanceToPrimitive(pts[i], prim) < clearance) return true;
    }
  }
  return false;
}

/** Build a full candidate (trajectory + metadata). */
export function buildCandidate(track: Track, spec: CandidateSpec, lim: DroneLimits, opts: CandidateOptions, index = 0): { cand: Candidate; traj: Trajectory } {
  const raw = candidatePath(track, spec, opts);
  const { pts, ds } = resampleUniform(raw, 0.05);
  const aMax = planningAccel(lim);
  const vProf = speedProfile(pts, ds, aMax, lim.vCap, { closed: false, v0: lim.vCap, vEnd: track.closed ? lim.vCap : 0 });
  const scaled = vProf.map((x) => x * spec.speed);
  let traj = pathToTrajectory(pts, ds, scaled, defaultMeta({ drone_id: opts.droneId ?? 0, strategy: opts.label ?? candidateLabel(spec), solver: 'candidate', track_id: track.id }));
  // time-scale down until feasible
  let scale = 1;
  for (let it = 0; it < 30; it++) {
    if (checkFeasibility(traj, scale, lim.twr, lim.eta, lim.thetaMaxDeg).share === 0) break;
    scale *= 0.96;
  }
  if (scale < 1) traj = timeScaleTrajectory(traj, scale);
  const valid = !(opts.obstacles && opts.obstacles.length && pathHitsObstacles(pts, opts.obstacles, opts.clearance ?? 0.1));
  const lapLen = track.closed ? track.length : track.length - opts.startS;
  const duration = traj.t[traj.t.length - 1];
  traj.lapPeriod = track.closed ? duration / Math.max(1, opts.laps) : undefined;
  traj.laps = track.closed ? opts.laps : undefined;
  const stride = Math.max(1, Math.floor(pts.length / 160));
  return {
    traj,
    cand: {
      index,
      lateral: spec.lateral,
      vertical: spec.vertical,
      speed: spec.speed,
      feasibilityScale: scale,
      label: opts.label ?? candidateLabel(spec),
      duration: track.closed ? duration / Math.max(1, opts.laps) : (duration * lapLen) / Math.max(1e-6, lapLen),
      preview: pts.filter((_, i) => i % stride === 0),
      valid,
    },
  };
}

export function candidateLabel(spec: CandidateSpec): string {
  const lat = spec.lateral.map((x) => (x === 0 ? '0' : x > 0 ? (x === 1 ? 'L' : 'l') : x === -1 ? 'R' : 'r')).join('');
  return `${lat}@${Math.round(spec.speed * 100)}%`;
}

/**
 * Candidate set of size M (Section 7.1): K = 4 lateral control points from
 * {-w, -w/2, 0, w/2, w} x 5 speed levels, a seeded subset that always includes the centreline at
 * full speed.
 */
export function candidateSpecs(M: number, seed: number, K = 4, vertical = false): CandidateSpec[] {
  const out: CandidateSpec[] = [{ lateral: new Array(K).fill(0), vertical: vertical ? new Array(K).fill(0) : [], speed: 1.0 }];
  const key = (c: CandidateSpec) => `${c.lateral.join(',')}|${c.vertical.join(',')}|${c.speed}`;
  const seen = new Set([key(out[0])]);
  // structured members first: constant offsets at each speed, then random smooth profiles
  for (const sp of SPEED_LEVELS.slice().reverse()) {
    for (const o of [0, -0.5, 0.5, -1, 1]) {
      const c: CandidateSpec = { lateral: new Array(K).fill(o), vertical: vertical ? new Array(K).fill(0) : [], speed: sp };
      if (!seen.has(key(c)) && out.length < Math.min(M, 15)) {
        seen.add(key(c));
        out.push(c);
      }
    }
  }
  const rng = new Rng(seed);
  let guard = 0;
  while (out.length < M && guard++ < 10000) {
    const c: CandidateSpec = {
      lateral: Array.from({ length: K }, () => rng.pick(OFFSET_LEVELS)),
      vertical: vertical ? Array.from({ length: K }, () => rng.pick([-0.5, 0, 0, 0.5])) : [],
      speed: rng.pick(SPEED_LEVELS),
    };
    if (seen.has(key(c))) continue;
    seen.add(key(c));
    out.push(c);
  }
  return out.slice(0, M);
}
