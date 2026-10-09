/**
 * Minimal 3D vector algebra for the simulation core.
 *
 * Frame convention (whole core): z-up, x forward, y left, origin at the arena floor centre
 * (matches Vicon / ROS). Conversion to three.js (y-up) happens in exactly one place:
 * `app/scene/frames.ts#toThree`.
 *
 * Functions return new objects; the core favours clarity over micro-optimisation so it can be
 * ported line by line to Python/NumPy.
 */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export const v3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
export const ZERO: Readonly<Vec3> = Object.freeze({ x: 0, y: 0, z: 0 });
export const EZ: Readonly<Vec3> = Object.freeze({ x: 0, y: 0, z: 1 });

export const clone = (a: Vec3): Vec3 => ({ x: a.x, y: a.y, z: a.z });
export const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const scale = (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
/** a + s * b */
export const addScaled = (a: Vec3, b: Vec3, s: number): Vec3 => ({
  x: a.x + s * b.x,
  y: a.y + s * b.y,
  z: a.z + s * b.z,
});
export const neg = (a: Vec3): Vec3 => ({ x: -a.x, y: -a.y, z: -a.z });
export const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
export const norm2 = (a: Vec3): number => a.x * a.x + a.y * a.y + a.z * a.z;
export const norm = (a: Vec3): number => Math.sqrt(norm2(a));
export const dist = (a: Vec3, b: Vec3): number => norm(sub(a, b));
export const normalize = (a: Vec3, fallback: Vec3 = EZ): Vec3 => {
  const n = norm(a);
  return n > 1e-12 ? scale(a, 1 / n) : clone(fallback);
};
export const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
  z: a.z + (b.z - a.z) * t,
});
/** Element-wise product (used for diagonal matrices). */
export const hadamard = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x * b.x, y: a.y * b.y, z: a.z * b.z });
/** Quadratic form a^T diag(d) b. */
export const quad = (a: Vec3, d: Vec3, b: Vec3): number => a.x * d.x * b.x + a.y * d.y * b.y + a.z * d.z * b.z;
export const horiz = (a: Vec3): Vec3 => ({ x: a.x, y: a.y, z: 0 });
export const normH = (a: Vec3): number => Math.hypot(a.x, a.y);
export const isFiniteVec = (a: Vec3): boolean => Number.isFinite(a.x) && Number.isFinite(a.y) && Number.isFinite(a.z);
/** Clamp each component into [lo, hi]. */
export const clampVec = (a: Vec3, lo: Vec3, hi: Vec3): Vec3 => ({
  x: Math.min(hi.x, Math.max(lo.x, a.x)),
  y: Math.min(hi.y, Math.max(lo.y, a.y)),
  z: Math.min(hi.z, Math.max(lo.z, a.z)),
});
/** Limit the Euclidean norm of a vector. */
export const clampNorm = (a: Vec3, max: number): Vec3 => {
  const n = norm(a);
  return n > max && n > 0 ? scale(a, max / n) : clone(a);
};
/** Rotate a vector about the z axis by angle psi (rad). */
export const rotZ = (a: Vec3, psi: number): Vec3 => {
  const c = Math.cos(psi);
  const s = Math.sin(psi);
  return { x: c * a.x - s * a.y, y: s * a.x + c * a.y, z: a.z };
};

export const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
export const deg = (rad: number): number => (rad * 180) / Math.PI;
export const rad = (degrees: number): number => (degrees * Math.PI) / 180;
export const wrapAngle = (a: number): number => {
  let r = (a + Math.PI) % (2 * Math.PI);
  if (r < 0) r += 2 * Math.PI;
  return r - Math.PI;
};
