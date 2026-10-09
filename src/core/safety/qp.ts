/**
 * Small QP solvers for the safety filter (Section 8.3).
 *
 *   minimise  sum_i w_i |u_i - u_i^nom|^2
 *   subject to rows  sum_m g_{k,m}^T u_m >= b_k
 *
 * With delta = u - u_nom the rows become G delta >= r, r_k = b_k - g_k^T u_nom.
 * Stationarity gives delta_m = (1/2) W_m^-1 sum_k lambda_k g_{k,m}; the dual
 *   maximise r^T lambda - (1/2) lambda^T H lambda,  H = (1/2) G W^-1 G^T,  lambda >= 0
 * is solved by Hildreth's algorithm (dual coordinate ascent):
 *   lambda_k <- max(0, lambda_k + (r_k - g_k^T delta) / H_kk),
 * which is exact for this separable structure and converges to the unique primal optimum.
 */
import { v3, type Vec3 } from '../vec';
import type { LinearConstraint } from './constraint';

export interface QPRow {
  /** Drone indices involved (1 or 2). */
  idx: number[];
  /** Coefficient vector per involved drone. */
  coef: Vec3[];
  b: number;
}

export interface QPResult {
  delta: Vec3[];
  lambda: number[];
  iterations: number;
  converged: boolean;
}

export function rowFromConstraint(c: LinearConstraint): QPRow {
  if (c.j < 0) return { idx: [c.i], coef: [c.a], b: c.b };
  return { idx: [c.i, c.j], coef: [c.a, v3(-c.a.x, -c.a.y, -c.a.z)], b: c.b };
}

const dot3 = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;

/** Hildreth's dual coordinate ascent. */
export function hildreth(uNom: Vec3[], weights: number[], rows: QPRow[], maxIter = 100, tol = 1e-6): QPResult {
  const n = uNom.length;
  const delta: Vec3[] = Array.from({ length: n }, () => v3());
  const m = rows.length;
  const lambda = new Array<number>(m).fill(0);
  if (m === 0) return { delta, lambda, iterations: 0, converged: true };
  // r_k and H_kk
  const r = new Array<number>(m);
  const Hkk = new Array<number>(m);
  for (let k = 0; k < m; k++) {
    const row = rows[k];
    let gu = 0;
    let hk = 0;
    for (let s = 0; s < row.idx.length; s++) {
      const d = row.idx[s];
      gu += dot3(row.coef[s], uNom[d]);
      hk += dot3(row.coef[s], row.coef[s]) / weights[d];
    }
    r[k] = row.b - gu;
    Hkk[k] = 0.5 * hk;
  }
  let it = 0;
  let converged = false;
  for (it = 1; it <= maxIter; it++) {
    let maxChange = 0;
    for (let k = 0; k < m; k++) {
      if (Hkk[k] < 1e-14) continue;
      const row = rows[k];
      let gd = 0;
      for (let s = 0; s < row.idx.length; s++) gd += dot3(row.coef[s], delta[row.idx[s]]);
      const lNew = Math.max(0, lambda[k] + (r[k] - gd) / Hkk[k]);
      const dl = lNew - lambda[k];
      if (dl !== 0) {
        lambda[k] = lNew;
        for (let s = 0; s < row.idx.length; s++) {
          const d = row.idx[s];
          const f = (0.5 * dl) / weights[d];
          const c = row.coef[s];
          delta[d] = v3(delta[d].x + f * c.x, delta[d].y + f * c.y, delta[d].z + f * c.z);
        }
        // scale-free change measure
        maxChange = Math.max(maxChange, Math.abs(dl) * Math.sqrt(Hkk[k]));
      }
    }
    if (maxChange < tol) {
      converged = true;
      break;
    }
  }
  return { delta, lambda, iterations: Math.min(it, maxIter), converged };
}

/**
 * Exact closed form for a single pair constraint a^T (u_i - u_j) >= b (Section 8.3):
 * if satisfied, pass through; otherwise distribute the correction by inverse weights.
 * With equal weights: c = (b - a^T (u_i^nom - u_j^nom)) / (2 |a|^2), u_i += c a, u_j -= c a.
 */
export function closedFormPair(uNomI: Vec3, uNomJ: Vec3, a: Vec3, b: number, wi = 1, wj = 1): { ui: Vec3; uj: Vec3; c: number; active: boolean } {
  const lhs = a.x * (uNomI.x - uNomJ.x) + a.y * (uNomI.y - uNomJ.y) + a.z * (uNomI.z - uNomJ.z);
  const a2 = dot3(a, a);
  if (lhs >= b || a2 < 1e-14) return { ui: { ...uNomI }, uj: { ...uNomJ }, c: 0, active: false };
  const resid = b - lhs;
  const inv = 1 / wi + 1 / wj;
  const mu = resid / (a2 * inv);
  const ci = mu / wi;
  const cj = mu / wj;
  return {
    ui: v3(uNomI.x + ci * a.x, uNomI.y + ci * a.y, uNomI.z + ci * a.z),
    uj: v3(uNomJ.x - cj * a.x, uNomJ.y - cj * a.y, uNomJ.z - cj * a.z),
    // with equal weights this is the c of Section 8.3
    c: resid / (2 * a2),
    active: true,
  };
}

/** Closed form for a single one-drone constraint a^T u >= b. */
export function closedFormSingle(uNom: Vec3, a: Vec3, b: number): { u: Vec3; active: boolean } {
  const lhs = dot3(a, uNom);
  const a2 = dot3(a, a);
  if (lhs >= b || a2 < 1e-14) return { u: { ...uNom }, active: false };
  const c = (b - lhs) / a2;
  return { u: v3(uNom.x + c * a.x, uNom.y + c * a.y, uNom.z + c * a.z), active: true };
}
