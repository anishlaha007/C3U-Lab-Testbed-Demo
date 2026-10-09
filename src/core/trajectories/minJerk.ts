/**
 * Minimum-derivative piecewise polynomials through waypoints (minimum jerk, order r = 3, or
 * minimum snap, r = 4), with fixed time allocation.
 *
 * Minimising \int |p^(r)|^2 dt with position-only interior waypoints gives, per segment, a
 * polynomial of degree 2r-1 (Euler-Lagrange: p^(2r) = 0) and continuity of derivatives
 * 1 .. 2r-2 at interior waypoints. Boundary conditions: derivatives 1 .. r-1 prescribed at both
 * ends (open), or periodic continuity at the wrap point (closed). The resulting square linear
 * system (2r unknowns per segment) is solved once and reused for x, y and z.
 */
import { TRAJ_DT } from '../constants';
import { luDecompose, luSolve } from '../linalg';
import type { Trajectory, TrajectoryMeta } from '../types';
import { v3, type Vec3 } from '../vec';
import { defaultMeta, trajectoryFromFunction } from './common';

export interface SplineOptions {
  order?: 3 | 4;
  closed?: boolean;
  /** Prescribed boundary derivatives (velocity, acceleration, jerk...) for open splines. */
  startDerivs?: Vec3[];
  endDerivs?: Vec3[];
}

export class PolySpline {
  /** coef[axis][segment * deg1 + k], normalised time tau in [0, 1]. */
  constructor(
    readonly coef: Float64Array[],
    readonly durations: number[],
    readonly deg1: number,
    readonly closed: boolean,
  ) {
    this.starts = [0];
    for (const T of durations) this.starts.push(this.starts[this.starts.length - 1] + T);
  }
  readonly starts: number[];

  get duration(): number {
    return this.starts[this.starts.length - 1];
  }

  /** Evaluate derivative orders 0..3 at time t (clamped / wrapped). */
  eval(t: number): { p: Vec3; v: Vec3; a: Vec3; j: Vec3 } {
    const Ttot = this.duration;
    let tt = t;
    if (this.closed) tt = ((t % Ttot) + Ttot) % Ttot;
    else tt = Math.max(0, Math.min(Ttot, t));
    let seg = 0;
    while (seg < this.durations.length - 1 && tt > this.starts[seg + 1]) seg++;
    const T = this.durations[seg];
    const tau = Math.max(0, Math.min(1, (tt - this.starts[seg]) / T));
    const out = [v3(), v3(), v3(), v3()];
    const axes: ('x' | 'y' | 'z')[] = ['x', 'y', 'z'];
    for (let ax = 0; ax < 3; ax++) {
      const c = this.coef[ax];
      const base = seg * this.deg1;
      for (let r = 0; r < 4; r++) {
        let s = 0;
        for (let k = this.deg1 - 1; k >= r; k--) {
          s = s * tau + c[base + k] * fallingFactorial(k, r);
        }
        // the Horner loop above accumulated in tau^(k-r)
        out[r][axes[ax]] = s / Math.pow(T, r);
      }
    }
    return { p: out[0], v: out[1], a: out[2], j: out[3] };
  }
}

function fallingFactorial(k: number, r: number): number {
  let f = 1;
  for (let i = 0; i < r; i++) f *= k - i;
  return f;
}

/** Fit a minimum-jerk (or snap) spline through waypoints with the given segment durations. */
export function minDerivSpline(waypoints: Vec3[], durations: number[], opts: SplineOptions = {}): PolySpline {
  const r = opts.order ?? 3;
  const closed = !!opts.closed;
  const m = durations.length;
  const pts = closed ? [...waypoints.slice(0, m), waypoints[0]] : waypoints;
  if (pts.length !== m + 1) throw new Error(`need ${m + 1} waypoints for ${m} segments`);
  const deg1 = 2 * r; // number of coefficients per segment
  const N = m * deg1;
  const A = new Float64Array(N * N);
  const rhs = [new Float64Array(N), new Float64Array(N), new Float64Array(N)];
  let row = 0;
  const setRow = (cols: [number, number][], b: [number, number, number]) => {
    for (const [c, v] of cols) A[row * N + c] += v;
    rhs[0][row] = b[0];
    rhs[1][row] = b[1];
    rhs[2][row] = b[2];
    row++;
  };
  // derivative-of-order-q row entries of segment j at tau (0 or 1), scaled by 1/T^q
  const derivEntries = (j: number, q: number, atEnd: boolean, sign = 1): [number, number][] => {
    const T = durations[j];
    const out: [number, number][] = [];
    for (let k = q; k < deg1; k++) {
      const val = atEnd ? fallingFactorial(k, q) : k === q ? fallingFactorial(k, q) : 0;
      if (val !== 0) out.push([j * deg1 + k, (sign * val) / Math.pow(T, q)]);
    }
    return out;
  };
  // positions
  for (let j = 0; j < m; j++) {
    setRow(derivEntries(j, 0, false), [pts[j].x, pts[j].y, pts[j].z]);
    setRow(derivEntries(j, 0, true), [pts[j + 1].x, pts[j + 1].y, pts[j + 1].z]);
  }
  // interior continuity of derivatives 1 .. 2r-2
  const junctions = closed ? m : m - 1;
  for (let jn = 0; jn < junctions; jn++) {
    const a = jn;
    const b = (jn + 1) % m;
    for (let q = 1; q <= 2 * r - 2; q++) setRow([...derivEntries(a, q, true), ...derivEntries(b, q, false, -1)], [0, 0, 0]);
  }
  if (!closed) {
    for (let q = 1; q <= r - 1; q++) {
      const s = opts.startDerivs?.[q - 1] ?? v3();
      const e = opts.endDerivs?.[q - 1] ?? v3();
      setRow(derivEntries(0, q, false), [s.x, s.y, s.z]);
      setRow(derivEntries(m - 1, q, true), [e.x, e.y, e.z]);
    }
  }
  if (row !== N) throw new Error(`spline system has ${row} rows for ${N} unknowns`);
  const piv = luDecompose(A, N);
  const coef = rhs.map((b) => luSolve(A, piv, N, b));
  return new PolySpline(coef, durations, deg1, closed);
}

/** Durations from segment lengths and a target speed (with a floor). */
export function allocateTimes(waypoints: Vec3[], speed: number, closed = false, minT = 0.25): number[] {
  const out: number[] = [];
  const m = closed ? waypoints.length : waypoints.length - 1;
  for (let j = 0; j < m; j++) {
    const a = waypoints[j];
    const b = waypoints[(j + 1) % waypoints.length];
    const d = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    out.push(Math.max(minT, d / speed));
  }
  return out;
}

export function splineToTrajectory(sp: PolySpline, meta: Partial<TrajectoryMeta> = {}, dt = TRAJ_DT): Trajectory {
  const T = sp.duration;
  return trajectoryFromFunction(
    T,
    (t) => {
      const e = sp.eval(Math.min(t, T - 1e-9));
      return { p: e.p, v: e.v, a: e.a };
    },
    defaultMeta({ solver: 'min_jerk', ...meta }),
    dt,
  );
}

/** Rest-to-rest minimum-jerk straight line from a to b in time T (classic 10-15-6 profile). */
export function minJerkLine(a: Vec3, b: Vec3, T: number, t: number): { p: Vec3; v: Vec3; a: Vec3 } {
  const s = Math.max(0, Math.min(1, t / T));
  const pos = 10 * s ** 3 - 15 * s ** 4 + 6 * s ** 5;
  const vel = (30 * s ** 2 - 60 * s ** 3 + 30 * s ** 4) / T;
  const acc = (60 * s - 180 * s ** 2 + 120 * s ** 3) / (T * T);
  const d = v3(b.x - a.x, b.y - a.y, b.z - a.z);
  const inRange = t >= 0 && t <= T;
  return {
    p: v3(a.x + d.x * pos, a.y + d.y * pos, a.z + d.z * pos),
    v: inRange ? v3(d.x * vel, d.y * vel, d.z * vel) : v3(),
    a: inRange ? v3(d.x * acc, d.y * acc, d.z * acc) : v3(),
  };
}
