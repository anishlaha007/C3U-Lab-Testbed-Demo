/**
 * Collision geometry primitives shared by the safety filter (obstacle CBFs), the supervisor
 * (strikes and hits), the racing-line obstacle check and the renderer.
 *
 * Every primitive is a "core" shape (point, segment, vertical axis, box, plane) inflated by a
 * radius. Distances returned are from a query point to the inflated surface.
 */
import { clamp, dot, v3, type Vec3 } from './vec';

export interface PrimTag {
  source: 'gate' | 'obstacle' | 'arena';
  id: string;
  /** Index of the gate this primitive belongs to (gate frames and stands). */
  gateIndex?: number;
  /** Part of a gate: frame edge, stand pole, base leg, cable. */
  part?: 'frame' | 'pole' | 'leg' | 'cable';
}

export type Primitive =
  | { kind: 'capsule'; a: Vec3; b: Vec3; r: number; vel: Vec3; acc: Vec3; tag: PrimTag }
  | { kind: 'cylinder'; cx: number; cy: number; r: number; zMin: number; zMax: number; vel: Vec3; acc: Vec3; tag: PrimTag }
  | { kind: 'sphere'; c: Vec3; r: number; vel: Vec3; acc: Vec3; tag: PrimTag }
  | { kind: 'box'; c: Vec3; half: Vec3; yaw: number; vel: Vec3; acc: Vec3; tag: PrimTag }
  /** Half-space n.p >= d is free; n is a unit vector pointing into free space. */
  | { kind: 'plane'; n: Vec3; d: number; tag: PrimTag };

/**
 * Closest-point information from p to a primitive's core shape.
 * - delta = p - q (q on the core shape), rho = |delta|
 * - free: which relative-velocity components change the distance to first order:
 *   'full' (point-like: sphere centre, segment end, box corner), 'xy' (vertical axis),
 *   'line' (segment interior or box edge, direction lineDir), 'face' (box face: only the normal
 *   component n n^T w matters), 'plane' (half-space, n fixed)
 * - R: the primitive's own radius (0 for boxes and planes)
 */
export interface CoreClosest {
  q: Vec3;
  delta: Vec3;
  rho: number;
  R: number;
  free: 'full' | 'xy' | 'line' | 'face' | 'plane';
  lineDir?: Vec3;
  /** Outward unit normal (from the shape towards p). */
  n: Vec3;
  vel: Vec3;
  acc: Vec3;
}

const ZERO = v3();

export function closestOnSegment(p: Vec3, a: Vec3, b: Vec3): { q: Vec3; t: number } {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const abz = b.z - a.z;
  const L2 = abx * abx + aby * aby + abz * abz;
  let t = L2 > 0 ? ((p.x - a.x) * abx + (p.y - a.y) * aby + (p.z - a.z) * abz) / L2 : 0;
  t = clamp(t, 0, 1);
  return { q: v3(a.x + abx * t, a.y + aby * t, a.z + abz * t), t };
}

export function coreClosest(p: Vec3, prim: Primitive): CoreClosest {
  switch (prim.kind) {
    case 'sphere': {
      const d = v3(p.x - prim.c.x, p.y - prim.c.y, p.z - prim.c.z);
      const rho = Math.hypot(d.x, d.y, d.z);
      return { q: prim.c, delta: d, rho, R: prim.r, free: 'full', n: unitOr(d, rho), vel: prim.vel, acc: prim.acc };
    }
    case 'capsule': {
      const { q, t } = closestOnSegment(p, prim.a, prim.b);
      const d = v3(p.x - q.x, p.y - q.y, p.z - q.z);
      const rho = Math.hypot(d.x, d.y, d.z);
      const interior = t > 1e-6 && t < 1 - 1e-6;
      let lineDir: Vec3 | undefined;
      if (interior) {
        const L = Math.hypot(prim.b.x - prim.a.x, prim.b.y - prim.a.y, prim.b.z - prim.a.z) || 1;
        lineDir = v3((prim.b.x - prim.a.x) / L, (prim.b.y - prim.a.y) / L, (prim.b.z - prim.a.z) / L);
      }
      return { q, delta: d, rho, R: prim.r, free: interior ? 'line' : 'full', lineDir, n: unitOr(d, rho), vel: prim.vel, acc: prim.acc };
    }
    case 'cylinder': {
      if (p.z >= prim.zMin && p.z <= prim.zMax) {
        const d = v3(p.x - prim.cx, p.y - prim.cy, 0);
        const rho = Math.hypot(d.x, d.y);
        return { q: v3(prim.cx, prim.cy, p.z), delta: d, rho, R: prim.r, free: 'xy', n: unitOr(d, rho), vel: prim.vel, acc: prim.acc };
      }
      // beyond an end cap: closest point on the cap disc
      const zc = p.z > prim.zMax ? prim.zMax : prim.zMin;
      const dx = p.x - prim.cx;
      const dy = p.y - prim.cy;
      const rh = Math.hypot(dx, dy);
      const s = rh > prim.r ? prim.r / rh : 1;
      const q = v3(prim.cx + dx * s, prim.cy + dy * s, zc);
      const d = v3(p.x - q.x, p.y - q.y, p.z - q.z);
      const rho = Math.hypot(d.x, d.y, d.z);
      return { q, delta: d, rho, R: 0, free: 'full', n: unitOr(d, rho), vel: prim.vel, acc: prim.acc };
    }
    case 'box': {
      const c = Math.cos(prim.yaw);
      const s = Math.sin(prim.yaw);
      const rx = p.x - prim.c.x;
      const ry = p.y - prim.c.y;
      const lx = c * rx + s * ry;
      const ly = -s * rx + c * ry;
      const lz = p.z - prim.c.z;
      let qx = clamp(lx, -prim.half.x, prim.half.x);
      let qy = clamp(ly, -prim.half.y, prim.half.y);
      let qz = clamp(lz, -prim.half.z, prim.half.z);
      const inside = qx === lx && qy === ly && qz === lz;
      // which local axes were clamped: 1 = face, 2 = edge (along the free axis), 3 = corner
      const cx = qx !== lx;
      const cy = qy !== ly;
      const cz = qz !== lz;
      const nClamped = (cx ? 1 : 0) + (cy ? 1 : 0) + (cz ? 1 : 0);
      if (inside) {
        // push to the nearest face
        const px = prim.half.x - Math.abs(lx);
        const py = prim.half.y - Math.abs(ly);
        const pz = prim.half.z - Math.abs(lz);
        if (px <= py && px <= pz) qx = Math.sign(lx || 1) * prim.half.x;
        else if (py <= pz) qy = Math.sign(ly || 1) * prim.half.y;
        else qz = Math.sign(lz || 1) * prim.half.z;
      }
      const q = v3(prim.c.x + c * qx - s * qy, prim.c.y + s * qx + c * qy, prim.c.z + qz);
      const d = v3(p.x - q.x, p.y - q.y, p.z - q.z);
      let rho = Math.hypot(d.x, d.y, d.z);
      let n = unitOr(d, rho);
      if (inside) {
        n = v3(-n.x, -n.y, -n.z);
        rho = -rho;
      }
      if (nClamped === 1 || inside) return { q, delta: d, rho, R: 0, free: 'face', n, vel: prim.vel, acc: prim.acc };
      if (nClamped === 2) {
        // edge: direction of the unclamped local axis, in world coordinates
        const lineDir = !cx ? v3(c, s, 0) : !cy ? v3(-s, c, 0) : v3(0, 0, 1);
        return { q, delta: d, rho, R: 0, free: 'line', lineDir, n, vel: prim.vel, acc: prim.acc };
      }
      return { q, delta: d, rho, R: 0, free: 'full', n, vel: prim.vel, acc: prim.acc };
    }
    case 'plane': {
      const sd = dot(prim.n, p) - prim.d;
      return {
        q: v3(p.x - prim.n.x * sd, p.y - prim.n.y * sd, p.z - prim.n.z * sd),
        delta: v3(prim.n.x * sd, prim.n.y * sd, prim.n.z * sd),
        rho: sd,
        R: 0,
        free: 'plane',
        n: prim.n,
        vel: ZERO,
        acc: ZERO,
      };
    }
  }
}

function unitOr(d: Vec3, rho: number): Vec3 {
  return rho > 1e-9 ? v3(d.x / rho, d.y / rho, d.z / rho) : v3(0, 0, 1);
}

/** Signed distance from p to the primitive's inflated surface (negative inside). */
export function distanceToPrimitive(p: Vec3, prim: Primitive): number {
  const c = coreClosest(p, prim);
  return c.rho - c.R;
}

/** Conservative axis-aligned bounds of a primitive (for broad-phase culling). */
export function primitiveBounds(prim: Primitive): { min: Vec3; max: Vec3 } | null {
  switch (prim.kind) {
    case 'sphere':
      return { min: v3(prim.c.x - prim.r, prim.c.y - prim.r, prim.c.z - prim.r), max: v3(prim.c.x + prim.r, prim.c.y + prim.r, prim.c.z + prim.r) };
    case 'capsule':
      return {
        min: v3(Math.min(prim.a.x, prim.b.x) - prim.r, Math.min(prim.a.y, prim.b.y) - prim.r, Math.min(prim.a.z, prim.b.z) - prim.r),
        max: v3(Math.max(prim.a.x, prim.b.x) + prim.r, Math.max(prim.a.y, prim.b.y) + prim.r, Math.max(prim.a.z, prim.b.z) + prim.r),
      };
    case 'cylinder':
      return { min: v3(prim.cx - prim.r, prim.cy - prim.r, prim.zMin), max: v3(prim.cx + prim.r, prim.cy + prim.r, prim.zMax) };
    case 'box': {
      const ext = Math.hypot(prim.half.x, prim.half.y);
      return { min: v3(prim.c.x - ext, prim.c.y - ext, prim.c.z - prim.half.z), max: v3(prim.c.x + ext, prim.c.y + ext, prim.c.z + prim.half.z) };
    }
    case 'plane':
      return null;
  }
}

/** Is p within `margin` of the bounds (cheap reject test)? */
export function nearBounds(p: Vec3, b: { min: Vec3; max: Vec3 } | null, margin: number): boolean {
  if (!b) return true;
  return (
    p.x >= b.min.x - margin &&
    p.x <= b.max.x + margin &&
    p.y >= b.min.y - margin &&
    p.y <= b.max.y + margin &&
    p.z >= b.min.z - margin &&
    p.z <= b.max.z + margin
  );
}

/** Distance from a point to a segment (m). */
export function pointSegmentDistance(p: Vec3, a: Vec3, b: Vec3): number {
  const { q } = closestOnSegment(p, a, b);
  return Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
}

/** Arena boundary planes (nets, floor, ceiling) pointing inwards. */
export function arenaPlanes(sx: number, sy: number, sz: number): Primitive[] {
  const tag = (id: string): PrimTag => ({ source: 'arena', id });
  return [
    { kind: 'plane', n: v3(0, 0, 1), d: 0, tag: tag('floor') },
    { kind: 'plane', n: v3(0, 0, -1), d: -sz, tag: tag('ceiling') },
    { kind: 'plane', n: v3(1, 0, 0), d: -sx / 2, tag: tag('net-x-') },
    { kind: 'plane', n: v3(-1, 0, 0), d: -sx / 2, tag: tag('net-x+') },
    { kind: 'plane', n: v3(0, 1, 0), d: -sy / 2, tag: tag('net-y-') },
    { kind: 'plane', n: v3(0, -1, 0), d: -sy / 2, tag: tag('net-y+') },
  ];
}
