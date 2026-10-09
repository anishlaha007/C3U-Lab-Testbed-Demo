/**
 * Braking-aware CBF (Section 8.2): a relative-degree-1 barrier that reserves the distance needed
 * to stop with the available braking capability.
 *
 * Pair: d = sqrt(dp^T D dp), d' = dp^T D dv / d (negative when closing), n = D dp / d.
 *   When d' < 0:  h_b = d - 1 - d'^2 / (2 a_b)
 *                 d'' = (dv^T D dv - d'^2) / d + n^T (u_i - u_j)
 *                 h_b' = d' - d' d'' / a_b
 *   Constraint h_b' + alpha h_b >= 0, linear in (u_i - u_j):
 *     c0 n^T (u_i - u_j) >= -d' - c0 k - alpha h_b,  c0 = -d' / a_b > 0,  k = (dv^T D dv - d'^2)/d.
 *   When separating (d' >= 0) no constraint is needed.
 * a_b is the combined braking capability in scaled units (1/s^2): the relative braking
 * acceleration in m/s^2 divided by the ellipsoid's effective radius along dp, |dp| / d
 * (0.24 m for horizontal approaches, 0.60 m for vertical ones, times the margin).
 */
import type { CoreClosest } from '../geometry';
import { v3, type Vec3 } from '../vec';
import type { LinearConstraint } from './constraint';
import { perpVelocity } from './ecbf';

export interface BrakingPairResult {
  constraint: LinearConstraint | null;
  /** Barrier value for logging (h_b when closing, d - 1 otherwise). */
  h: number;
}

/**
 * @param aRel relative braking acceleration available to the pair (m/s^2), e.g.
 *   0.8 * (a_max_i + a_max_j) along the line of centres.
 */
export function brakingPair(i: number, j: number, pi: Vec3, vi: Vec3, pj: Vec3, vj: Vec3, D: Vec3, aRel: number, alpha: number): BrakingPairResult {
  const dp = v3(pi.x - pj.x, pi.y - pj.y, pi.z - pj.z);
  const dv = v3(vi.x - vj.x, vi.y - vj.y, vi.z - vj.z);
  const Ddp = v3(D.x * dp.x, D.y * dp.y, D.z * dp.z);
  const d = Math.sqrt(Math.max(1e-12, dp.x * Ddp.x + dp.y * Ddp.y + dp.z * Ddp.z));
  const dpn = Math.hypot(dp.x, dp.y, dp.z);
  const dd = (Ddp.x * dv.x + Ddp.y * dv.y + Ddp.z * dv.z) / d;
  if (dd >= 0) return { constraint: null, h: d - 1 };
  const rEff = dpn / d; // metres per scaled unit along dp
  const ab = aRel / Math.max(1e-6, rEff);
  const hb = d - 1 - (dd * dd) / (2 * ab);
  const dvDdv = D.x * dv.x * dv.x + D.y * dv.y * dv.y + D.z * dv.z * dv.z;
  const k = (dvDdv - dd * dd) / d;
  const c0 = -dd / ab;
  const n = v3(Ddp.x / d, Ddp.y / d, Ddp.z / d);
  return {
    constraint: { i, j, a: v3(c0 * n.x, c0 * n.y, c0 * n.z), b: -dd - c0 * k - alpha * hb, kind: 'pair', h: hb },
    h: hb,
  };
}

/**
 * Braking-aware CBF for a drone against an obstacle: d = distance to the inflated surface (m),
 * d' = n^T (v - v_obs), a_b the drone's braking capability along n (m/s^2).
 */
export function brakingObstacle(i: number, _p: Vec3, v: Vec3, c: CoreClosest, Rtot: number, ab: number, alpha: number): LinearConstraint | null {
  if (c.free === 'plane') {
    const dist = c.rho - Rtot;
    const dd = c.n.x * v.x + c.n.y * v.y + c.n.z * v.z;
    if (dd >= 0) return null;
    const hb = dist - (dd * dd) / (2 * ab);
    const c0 = -dd / ab;
    return { i, j: -1, a: v3(c0 * c.n.x, c0 * c.n.y, c0 * c.n.z), b: -dd - alpha * hb, kind: 'obstacle', h: hb };
  }
  if (c.rho < 1e-9) return null;
  const n = c.n;
  const w = v3(v.x - c.vel.x, v.y - c.vel.y, v.z - c.vel.z);
  const wp = perpVelocity(w, c);
  const dist = c.rho - Rtot;
  const dd = n.x * w.x + n.y * w.y + n.z * w.z;
  if (dd >= 0) return null;
  const k = (wp.x * wp.x + wp.y * wp.y + wp.z * wp.z - dd * dd) / c.rho;
  const nAcc = n.x * c.acc.x + n.y * c.acc.y + n.z * c.acc.z;
  const hb = dist - (dd * dd) / (2 * ab);
  const c0 = -dd / ab;
  return { i, j: -1, a: v3(c0 * n.x, c0 * n.y, c0 * n.z), b: -dd - c0 * (k - nAcc) - alpha * hb, kind: 'obstacle', h: hb };
}
