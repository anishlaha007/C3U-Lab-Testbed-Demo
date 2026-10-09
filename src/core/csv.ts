/**
 * Trajectory file standard (Section 5.5): one CSV per drone with columns
 * t,x,y,z,vx,vy,vz,ax,ay,az,yaw plus a JSON metadata file (run_id, drone_id, strategy, solver,
 * dynamics_model, d_min_assumed, track_id, sample_period, created).
 *
 * Import accepts the full column set, or only t,x,y,z: then positions are resampled to 100 Hz,
 * smoothed with a Gaussian kernel and differentiated for velocity and acceleration (which is
 * noisy; the importer says so).
 */
import { TRAJ_DT } from './constants';
import { allocTrajectory, defaultMeta, fillYawFromHeading, resampleTrajectory, timeScaleTrajectory } from './trajectories/common';
import type { Trajectory, TrajectoryMeta } from './types';

export const CSV_COLUMNS = ['t', 'x', 'y', 'z', 'vx', 'vy', 'vz', 'ax', 'ay', 'az', 'yaw'] as const;

const fmt = (x: number) => (Number.isFinite(x) ? Number(x.toFixed(6)).toString() : '0');

export function trajectoryToCsv(tr: Trajectory): string {
  const lines = [CSV_COLUMNS.join(',')];
  for (let i = 0; i < tr.t.length; i++) {
    lines.push([tr.t[i], tr.x[i], tr.y[i], tr.z[i], tr.vx[i], tr.vy[i], tr.vz[i], tr.ax[i], tr.ay[i], tr.az[i], tr.yaw[i]].map(fmt).join(','));
  }
  return lines.join('\n') + '\n';
}

/** Export with a speed multiplier applied (resampled to the 100 Hz standard). */
export function exportTrajectory(tr: Trajectory, k = 1): { csv: string; meta: string } {
  const scaled = k === 1 ? tr : resampleTrajectory(timeScaleTrajectory(tr, k), TRAJ_DT);
  const meta: TrajectoryMeta = { ...scaled.meta, sample_period: k === 1 ? tr.meta.sample_period : TRAJ_DT, created: new Date().toISOString() };
  return { csv: trajectoryToCsv(scaled), meta: JSON.stringify(meta, null, 2) };
}

export interface ImportResult {
  trajectory: Trajectory;
  warnings: string[];
}

function gaussianSmooth(arr: Float64Array, sigma: number): Float64Array {
  const r = Math.ceil(3 * sigma);
  const w: number[] = [];
  for (let k = -r; k <= r; k++) w.push(Math.exp(-(k * k) / (2 * sigma * sigma)));
  const out = new Float64Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    let s = 0;
    let ws = 0;
    for (let k = -r; k <= r; k++) {
      const j = i + k;
      if (j < 0 || j >= arr.length) continue;
      s += arr[j] * w[k + r];
      ws += w[k + r];
    }
    out[i] = s / ws;
  }
  return out;
}

function centralDiff(arr: Float64Array, dt: number): Float64Array {
  const n = arr.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1);
    const b = Math.min(n - 1, i + 1);
    out[i] = (arr[b] - arr[a]) / ((b - a) * dt || 1);
  }
  return out;
}

export function parseTrajectoryCsv(text: string, meta: Partial<TrajectoryMeta> = {}): ImportResult {
  const warnings: string[] = [];
  const rows = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  if (rows.length < 3) throw new Error('CSV has fewer than two data rows.');
  const header = rows[0].split(/[,;\t]/).map((h) => h.trim().toLowerCase());
  const col = (name: string) => header.indexOf(name);
  for (const req of ['t', 'x', 'y', 'z']) if (col(req) < 0) throw new Error(`CSV is missing the "${req}" column (expected ${CSV_COLUMNS.join(',')}).`);
  const data = rows.slice(1).map((r) => r.split(/[,;\t]/).map((x) => Number(x.trim())));
  const get = (name: string) => {
    const c = col(name);
    return c < 0 ? null : data.map((r) => r[c]);
  };
  const t = get('t')!;
  for (let i = 0; i < t.length; i++) if (!Number.isFinite(t[i])) throw new Error(`Row ${i + 2}: t is not a number.`);
  const full = ['vx', 'vy', 'vz', 'ax', 'ay', 'az'].every((c) => col(c) >= 0);
  const n = t.length;
  let tr = allocTrajectory(n, defaultMeta({ solver: 'imported', strategy: 'imported', ...meta }));
  const t0 = t[0];
  for (let i = 0; i < n; i++) {
    tr.t[i] = t[i] - t0;
    tr.x[i] = get('x')![i];
    tr.y[i] = get('y')![i];
    tr.z[i] = get('z')![i];
    tr.yaw[i] = col('yaw') >= 0 ? get('yaw')![i] : NaN;
  }
  const dts = Array.from({ length: n - 1 }, (_, i) => tr.t[i + 1] - tr.t[i]);
  const meanDt = dts.reduce((a, b) => a + b, 0) / dts.length;
  const uniform = dts.every((d) => Math.abs(d - meanDt) < 1e-3 * Math.max(1, meanDt));
  tr.meta.sample_period = meanDt;
  if (full) {
    const vx = get('vx')!;
    const vy = get('vy')!;
    const vz = get('vz')!;
    const ax = get('ax')!;
    const ay = get('ay')!;
    const az = get('az')!;
    for (let i = 0; i < n; i++) {
      tr.vx[i] = vx[i];
      tr.vy[i] = vy[i];
      tr.vz[i] = vz[i];
      tr.ax[i] = ax[i];
      tr.ay[i] = ay[i];
      tr.az[i] = az[i];
    }
    if (!uniform) {
      tr = resampleTrajectory(tr, TRAJ_DT);
      warnings.push('Non-uniform time stamps: resampled to 100 Hz.');
    }
  } else {
    warnings.push('Only t, x, y, z found: velocity and acceleration were obtained by smoothing and differentiating positions, so acceleration is noisy.');
    // resample positions to 100 Hz, smooth, differentiate
    const T = tr.t[n - 1];
    const m = Math.max(3, Math.round(T / TRAJ_DT) + 1);
    const res = allocTrajectory(m, { ...tr.meta, sample_period: TRAJ_DT });
    let j = 0;
    for (let q = 0; q < m; q++) {
      const tq = Math.min(T, q * TRAJ_DT);
      while (j < n - 2 && tr.t[j + 1] < tq) j++;
      const f = (tq - tr.t[j]) / (tr.t[j + 1] - tr.t[j] || 1);
      res.t[q] = q * TRAJ_DT;
      res.x[q] = tr.x[j] + (tr.x[j + 1] - tr.x[j]) * f;
      res.y[q] = tr.y[j] + (tr.y[j + 1] - tr.y[j]) * f;
      res.z[q] = tr.z[j] + (tr.z[j + 1] - tr.z[j]) * f;
      res.yaw[q] = NaN;
    }
    const sig = 4;
    const sx = gaussianSmooth(res.x, sig);
    const sy = gaussianSmooth(res.y, sig);
    const sz = gaussianSmooth(res.z, sig);
    res.vx = gaussianSmooth(centralDiff(sx, TRAJ_DT), sig);
    res.vy = gaussianSmooth(centralDiff(sy, TRAJ_DT), sig);
    res.vz = gaussianSmooth(centralDiff(sz, TRAJ_DT), sig);
    res.ax = gaussianSmooth(centralDiff(res.vx, TRAJ_DT), sig);
    res.ay = gaussianSmooth(centralDiff(res.vy, TRAJ_DT), sig);
    res.az = gaussianSmooth(centralDiff(res.vz, TRAJ_DT), sig);
    tr = res;
  }
  fillYawFromHeading(tr);
  return { trajectory: tr, warnings };
}

export function parseMetaJson(text: string): Partial<TrajectoryMeta> {
  const o = JSON.parse(text) as Record<string, unknown>;
  const out: Partial<TrajectoryMeta> = {};
  for (const k of ['run_id', 'strategy', 'solver', 'dynamics_model', 'track_id', 'created'] as const) if (typeof o[k] === 'string') out[k] = o[k] as string;
  for (const k of ['drone_id', 'd_min_assumed', 'sample_period'] as const) if (typeof o[k] === 'number') out[k] = o[k] as number;
  return out;
}

// registry of imported trajectories (main thread only)
let imported: Trajectory[] = [];

export function setImportedTrajectories(trs: Trajectory[]): void {
  imported = trs.slice();
}

export function importedTrajectories(): Trajectory[] {
  return imported;
}
