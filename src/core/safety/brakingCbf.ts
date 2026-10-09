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
 *   When separating (d' >= 0) the continuous-time constraint is void, but the command is held
 *   for a whole control period dt: a large inward nominal input passes unfiltered for that tick
 *   and the pair ratchets inward (seen in head-on deadlocks). A one-step look-ahead closes the
 *   hole: the closing speed after one held tick must not exceed the stoppable speed,
 *     d' + dt (k + n^T (u_i - u_j)) >= -v_stop,
 *   v_stop = a_b (sqrt(tau_r^2 + 2 max(0, d - 1) / a_b) - tau_r)  (the closing speed that can
 *   still be stopped within d - 1 including the reaction distance below; sqrt(2 a_b (d - 1)) for
 *   tau_r = 0), which is linear in (u_i - u_j). It is applied only when d' >= 0 and dt > 0.
 * Reaction distance (full-physics mode): the commanded deceleration reaches the airframe through
 * a first-order acceleration lag and a zero-order hold, so braking starts about tau_r = tau_a +
 * dt/2 late. The barrier reserves that distance too:
 *   h_b = d - 1 - d'^2 / (2 a_b) + tau_r d'      (d' < 0, so the last term is -tau_r |d'|)
 *   h_b' = d' - (d'/a_b - tau_r) d''  ->  c0 = tau_r - d'/a_b >= tau_r > 0.
 * Without it the constraint degenerates as d' -> 0 (c0 -> 0) and a large inward nominal input
 * passes almost unfiltered right at the boundary; the lagged airframe then overshoots. tau_r = 0
 * (pure double-integrator mode) gives exactly the Section 8.2 barrier.
 * a_b is the combined braking capability in scaled units (1/s^2): the relative braking
 * acceleration in m/s^2 divided by the ellipsoid's effective radius along dp, |dp| / d
 * (0.24 m for horizontal approaches, 0.60 m for vertical ones, times the margin).
 */
import type { CoreClosest } from '../geometry';
import { v3, type Vec3 } from '../vec';
import type { LinearConstraint } from './constraint';
import { perpVelocity } from './ecbf';

/** Largest closing speed that can still be stopped within `room` (reaction time tauR, braking ab). */
export function stoppableSpeed(room: number, ab: number, tauR: number): number {
  return ab * (Math.sqrt(tauR * tauR + (2 * Math.max(0, room)) / ab) - tauR);
}

export interface BrakingPairResult {
  constraint: LinearConstraint | null;
  /** Barrier value for logging (h_b when closing, d - 1 otherwise). */
  h: number;
}

/**
 * @param aRel relative braking acceleration available to the pair (m/s^2), e.g.
 *   0.8 * (a_max_i + a_max_j) along the line of centres.
 */
export function brakingPair(i: number, j: number, pi: Vec3, vi: Vec3, pj: Vec3, vj: Vec3, D: Vec3, aRel: number, alpha: number, dt = 0, tauR = 0): BrakingPairResult {
  const dp = v3(pi.x - pj.x, pi.y - pj.y, pi.z - pj.z);
  const dv = v3(vi.x - vj.x, vi.y - vj.y, vi.z - vj.z);
  const Ddp = v3(D.x * dp.x, D.y * dp.y, D.z * dp.z);
  const d = Math.sqrt(Math.max(1e-12, dp.x * Ddp.x + dp.y * Ddp.y + dp.z * Ddp.z));
  const dpn = Math.hypot(dp.x, dp.y, dp.z);
  const dd = (Ddp.x * dv.x + Ddp.y * dv.y + Ddp.z * dv.z) / d;
  const rEff = dpn / d; // metres per scaled unit along dp
  const ab = aRel / Math.max(1e-6, rEff);
  const dvDdv = D.x * dv.x * dv.x + D.y * dv.y * dv.y + D.z * dv.z * dv.z;
  const k = (dvDdv - dd * dd) / d;
  const n = v3(Ddp.x / d, Ddp.y / d, Ddp.z / d);
  if (dd >= 0) {
    if (!(dt > 0)) return { constraint: null, h: d - 1 };
    const vStop = stoppableSpeed(d - 1, ab, tauR);
    return { constraint: { i, j, a: v3(dt * n.x, dt * n.y, dt * n.z), b: -vStop - dd - dt * k, kind: 'pair', h: d - 1 }, h: d - 1 };
  }
  const hb = d - 1 - (dd * dd) / (2 * ab) + tauR * dd;
  const c0 = tauR - dd / ab;
  return {
    constraint: { i, j, a: v3(c0 * n.x, c0 * n.y, c0 * n.z), b: -dd - c0 * k - alpha * hb, kind: 'pair', h: hb },
    h: hb,
  };
}

/**
 * Braking-aware CBF for a drone against an obstacle: d = distance to the inflated surface (m),
 * d' = n^T (v - v_obs), a_b the drone's braking capability along n (m/s^2).
 */
export function brakingObstacle(i: number, _p: Vec3, v: Vec3, c: CoreClosest, Rtot: number, ab: number, alpha: number, dt = 0, tauR = 0): LinearConstraint | null {
  // one-step look-ahead when not approaching (see brakingPair)
  const lookAhead = (n: Vec3, dist: number, dd: number, drift: number): LinearConstraint | null =>
    dt > 0 ? { i, j: -1, a: v3(dt * n.x, dt * n.y, dt * n.z), b: -stoppableSpeed(dist, ab, tauR) - dd - dt * drift, kind: 'obstacle', h: dist } : null;
  if (c.free === 'plane') {
    const dist = c.rho - Rtot;
    const dd = c.n.x * v.x + c.n.y * v.y + c.n.z * v.z;
    if (dd >= 0) return lookAhead(c.n, dist, dd, 0);
    const hb = dist - (dd * dd) / (2 * ab) + tauR * dd;
    const c0 = tauR - dd / ab;
    return { i, j: -1, a: v3(c0 * c.n.x, c0 * c.n.y, c0 * c.n.z), b: -dd - alpha * hb, kind: 'obstacle', h: hb };
  }
  if (c.rho < 1e-9) return null;
  const n = c.n;
  const w = v3(v.x - c.vel.x, v.y - c.vel.y, v.z - c.vel.z);
  const wp = perpVelocity(w, c);
  const dist = c.rho - Rtot;
  const dd = n.x * w.x + n.y * w.y + n.z * w.z;
  const k = (wp.x * wp.x + wp.y * wp.y + wp.z * wp.z - dd * dd) / c.rho;
  const nAcc = n.x * c.acc.x + n.y * c.acc.y + n.z * c.acc.z;
  if (dd >= 0) return lookAhead(n, dist, dd, k - nAcc);
  const hb = dist - (dd * dd) / (2 * ab) + tauR * dd;
  const c0 = tauR - dd / ab;
  return { i, j: -1, a: v3(c0 * n.x, c0 * n.y, c0 * n.z), b: -dd - c0 * (k - nAcc) - alpha * hb, kind: 'obstacle', h: hb };
}
