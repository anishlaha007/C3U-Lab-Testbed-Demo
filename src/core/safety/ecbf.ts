/**
 * Exponential (high-order) control barrier functions (Section 8.1; Ames et al. 2019, Sec. III-B,
 * "exponential CBFs" for relative degree 2).
 *
 * Pair (downwash ellipsoid): h = dp^T D dp - 1, dp = p_i - p_j, dv = v_i - v_j, D = E^-2.
 *   h'  = 2 dp^T D dv
 *   h'' = 2 dv^T D dv + 2 dp^T D (u_i - u_j)
 * With both poles at -lambda the condition h'' + 2 lambda h' + lambda^2 h >= 0 is linear:
 *   a^T (u_i - u_j) >= b,  a = 2 D dp,  b = -2 dv^T D dv - 2 lambda h' - lambda^2 h.
 * Forward invariance additionally needs h' + lambda h >= 0 when the filter activates (Theorem 8).
 */
import { PAIR_E } from '../constants';
import type { CoreClosest } from '../geometry';
import { v3, type Vec3 } from '../vec';
import type { LinearConstraint } from './constraint';

/** D = E^-2 for the pair ellipsoid E = diag(0.24, 0.24, 0.60) * margin. */
export function pairD(marginMultiplier = 1): Vec3 {
  const ex = PAIR_E.x * marginMultiplier;
  const ey = PAIR_E.y * marginMultiplier;
  const ez = PAIR_E.z * marginMultiplier;
  return v3(1 / (ex * ex), 1 / (ey * ey), 1 / (ez * ez));
}

/** Scaled separation s = sqrt(dp^T D dp); s >= 1 is outside the downwash zone. */
export function scaledSeparation(pi: Vec3, pj: Vec3, D: Vec3): number {
  const dx = pi.x - pj.x;
  const dy = pi.y - pj.y;
  const dz = pi.z - pj.z;
  return Math.sqrt(dx * dx * D.x + dy * dy * D.y + dz * dz * D.z);
}

export function ecbfPair(i: number, j: number, pi: Vec3, vi: Vec3, pj: Vec3, vj: Vec3, D: Vec3, lambda: number): LinearConstraint {
  const dp = v3(pi.x - pj.x, pi.y - pj.y, pi.z - pj.z);
  const dv = v3(vi.x - vj.x, vi.y - vj.y, vi.z - vj.z);
  const Ddp = v3(D.x * dp.x, D.y * dp.y, D.z * dp.z);
  const h = dp.x * Ddp.x + dp.y * Ddp.y + dp.z * Ddp.z - 1;
  const hdot = 2 * (Ddp.x * dv.x + Ddp.y * dv.y + Ddp.z * dv.z);
  const dvDdv = D.x * dv.x * dv.x + D.y * dv.y * dv.y + D.z * dv.z * dv.z;
  const a = v3(2 * Ddp.x, 2 * Ddp.y, 2 * Ddp.z);
  const b = -2 * dvDdv - 2 * lambda * hdot - lambda * lambda * h;
  return { i, j, a, b, kind: 'pair', h, hdot };
}

/** Velocity component that changes the distance to the core shape (see geometry.CoreClosest). */
export function perpVelocity(w: Vec3, c: CoreClosest): Vec3 {
  switch (c.free) {
    case 'xy':
      return v3(w.x, w.y, 0);
    case 'line': {
      const e = c.lineDir!;
      const s = w.x * e.x + w.y * e.y + w.z * e.z;
      return v3(w.x - s * e.x, w.y - s * e.y, w.z - s * e.z);
    }
    default:
      return w;
  }
}

/**
 * Exponential CBF for a drone against an obstacle (Section 8.3b).
 * Round shapes: h = |p - q|^2 - R^2 (R = r_obstacle + r_drone + margin), using the obstacle's
 * known velocity and acceleration. Planes: h = n^T p - (d + r_drone + margin).
 */
export function ecbfObstacle(i: number, _p: Vec3, v: Vec3, c: CoreClosest, Rtot: number, lambda: number): LinearConstraint {
  if (c.free === 'plane') {
    const h = c.rho - Rtot;
    const hdot = c.n.x * v.x + c.n.y * v.y + c.n.z * v.z;
    return { i, j: -1, a: { ...c.n }, b: -2 * lambda * hdot - lambda * lambda * h, kind: 'obstacle', h, hdot };
  }
  const d = c.delta;
  const w = v3(v.x - c.vel.x, v.y - c.vel.y, v.z - c.vel.z);
  const wp = perpVelocity(w, c);
  const h = c.rho * c.rho - Rtot * Rtot;
  const hdot = 2 * (d.x * w.x + d.y * w.y + d.z * w.z);
  const wp2 = wp.x * wp.x + wp.y * wp.y + wp.z * wp.z;
  const dAcc = d.x * c.acc.x + d.y * c.acc.y + d.z * c.acc.z;
  return {
    i,
    j: -1,
    a: v3(2 * d.x, 2 * d.y, 2 * d.z),
    b: 2 * dAcc - 2 * wp2 - 2 * lambda * hdot - lambda * lambda * h,
    kind: 'obstacle',
    h,
    hdot,
  };
}
