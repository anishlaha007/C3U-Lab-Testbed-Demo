/**
 * What the 3D scene needs to draw one instant. Produced by the engine either from the live
 * simulation state or from a recorded TrialLog (timeline replay).
 */
import type { Vec3 } from '../core/vec';

export interface DroneView {
  p: Vec3;
  v: Vec3;
  /** Specific thrust vector (core frame), sets the tilt. */
  f: Vec3;
  yaw: number;
  /** Normalised thrust 0..1 (prop spin rate). */
  thrust01: number;
  color: string;
  /** Nominal reference position. */
  ref: Vec3 | null;
  /** Filtered / blended reference actually sent (null when equal to nominal). */
  refFiltered: Vec3 | null;
  /** u_safe - u_nom (m/s^2). */
  correction: Vec3;
  intervened: boolean;
  /** Scaled separation to the nearest drone. */
  nearestS: number;
  /** 0 normal, 1 hover, 2 emergency, 3 killed, 4 crashed. */
  mode: number;
  /** Tumble rotation for crashed drones (axis-angle, rad). */
  tumble: Vec3 | null;
  nextGate: number;
  twr01: number;
  speed: number;
}

export interface SceneView {
  t: number;
  tRace: number;
  drones: DroneView[];
}
