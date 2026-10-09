/**
 * Supervisor (Section 8.4): geofence, stale setpoints, emergency brake, kill and Vicon jump
 * bookkeeping. The supervisor overrides the executor's setpoint per drone.
 */
import { ARENA_MARGIN } from './constants';
import type { ArenaConfig, Setpoint } from './types';
import { clamp, v3, type Vec3 } from './vec';

export type SupervisorMode = 'normal' | 'hover' | 'emergency' | 'killed';

export const MODE_CODE: Record<SupervisorMode | 'crashed', number> = { normal: 0, hover: 1, emergency: 2, killed: 3, crashed: 4 };

/** Is p inside the arena minus the margin? */
export function insideGeofence(p: Vec3, arena: ArenaConfig, margin = ARENA_MARGIN): boolean {
  return (
    Math.abs(p.x) <= arena.sx / 2 - margin &&
    Math.abs(p.y) <= arena.sy / 2 - margin &&
    p.z >= margin &&
    p.z <= arena.sz - margin
  );
}

/** Project a point onto the geofence box. */
export function geofencePoint(p: Vec3, arena: ArenaConfig, margin = ARENA_MARGIN): Vec3 {
  return v3(
    clamp(p.x, -arena.sx / 2 + margin, arena.sx / 2 - margin),
    clamp(p.y, -arena.sy / 2 + margin, arena.sy / 2 - margin),
    clamp(p.z, margin, arena.sz - margin),
  );
}

/** Physically outside the arena (through the net)? */
export function outsideArena(p: Vec3, arena: ArenaConfig): boolean {
  return Math.abs(p.x) > arena.sx / 2 || Math.abs(p.y) > arena.sy / 2 || p.z > arena.sz;
}

export function hoverSetpoint(p: Vec3, yaw: number): Setpoint {
  return { p: { ...p }, v: v3(), a: v3(), yaw };
}

/**
 * Emergency brake setpoint: maximum deceleration against the current velocity until nearly
 * stopped, then hover where it stopped. The setpoint is stateless in the velocity: the onboard
 * law receives v_ref = 0 and a feed-forward opposing the velocity.
 */
export function brakeSetpoint(pHat: Vec3, vHat: Vec3, aMax: number, yaw: number): Setpoint {
  const sp = Math.hypot(vHat.x, vHat.y, vHat.z);
  if (sp < 0.05) return hoverSetpoint(pHat, yaw);
  const a = v3((-vHat.x / sp) * aMax, (-vHat.y / sp) * aMax, (-vHat.z / sp) * Math.min(aMax, 3));
  return { p: { ...pHat }, v: { ...vHat }, a, yaw };
}

/**
 * Predict whether the pair will violate s < 1 within `horizon` seconds when both drones apply
 * their safe commands (double-integrator rollout at 5 ms).
 */
export function predictViolation(pi: Vec3, vi: Vec3, ui: Vec3, pj: Vec3, vj: Vec3, uj: Vec3, D: Vec3, horizon = 0.1): boolean {
  const dt = 0.005;
  for (let t = dt; t <= horizon + 1e-9; t += dt) {
    const h = 0.5 * t * t;
    const dx = pi.x - pj.x + (vi.x - vj.x) * t + (ui.x - uj.x) * h;
    const dy = pi.y - pj.y + (vi.y - vj.y) * t + (ui.y - uj.y) * h;
    const dz = pi.z - pj.z + (vi.z - vj.z) * t + (ui.z - uj.z) * h;
    if (dx * dx * D.x + dy * dy * D.y + dz * dz * D.z < 1) return true;
  }
  return false;
}
