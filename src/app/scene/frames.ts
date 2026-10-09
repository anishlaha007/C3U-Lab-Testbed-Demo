/**
 * The ONLY place where simulation coordinates (z-up: x forward, y left, z up) are converted to
 * three.js coordinates (y-up). Every scene component goes through these helpers.
 */
import * as THREE from 'three';
import type { Vec3 } from '../../core/vec';

/** Core (z-up) point -> three.js (y-up) tuple: [x, z, -y]. */
export function toThree(p: Vec3): [number, number, number] {
  return [p.x, p.z, -p.y];
}

export function toThreeVec(p: Vec3, out = new THREE.Vector3()): THREE.Vector3 {
  const [x, y, z] = toThree(p);
  return out.set(x, y, z);
}

/** Write a core point into a flat array at index i (x, y, z triplet) in three.js coordinates. */
export function writeThree(arr: Float32Array | number[], i: number, x: number, y: number, z: number): void {
  arr[3 * i] = x;
  arr[3 * i + 1] = z;
  arr[3 * i + 2] = -y;
}

/**
 * Orientation of a body whose thrust axis is `f` (core frame) and whose heading is `yaw`
 * (rad about core z). Body model convention in three.js: local +X forward, +Y up (thrust),
 * local +Z = core -y_body.
 */
export function attitudeQuaternion(f: Vec3, yaw: number, out = new THREE.Quaternion()): THREE.Quaternion {
  const fn = Math.hypot(f.x, f.y, f.z);
  const zb = fn > 1e-6 ? { x: f.x / fn, y: f.y / fn, z: f.z / fn } : { x: 0, y: 0, z: 1 };
  const xc = { x: Math.cos(yaw), y: Math.sin(yaw), z: 0 };
  // y_b = normalize(z_b x x_c)
  let yb = { x: zb.y * xc.z - zb.z * xc.y, y: zb.z * xc.x - zb.x * xc.z, z: zb.x * xc.y - zb.y * xc.x };
  const yn = Math.hypot(yb.x, yb.y, yb.z) || 1;
  yb = { x: yb.x / yn, y: yb.y / yn, z: yb.z / yn };
  // x_b = y_b x z_b
  const xb = { x: yb.y * zb.z - yb.z * zb.y, y: yb.z * zb.x - yb.x * zb.z, z: yb.x * zb.y - yb.y * zb.x };
  const m = new THREE.Matrix4().makeBasis(
    toThreeVec(xb),
    toThreeVec(zb),
    toThreeVec({ x: -yb.x, y: -yb.y, z: -yb.z }),
  );
  return out.setFromRotationMatrix(m);
}

/** Rotation for an object whose local +Y (three) should point along core direction d. */
export function alignYTo(d: Vec3, out = new THREE.Quaternion()): THREE.Quaternion {
  const v = toThreeVec(d).normalize();
  return out.setFromUnitVectors(new THREE.Vector3(0, 1, 0), v);
}

/** Yaw (about core z) as a three.js rotation about +Y. */
export function yawToThreeY(yaw: number): number {
  return yaw;
}
