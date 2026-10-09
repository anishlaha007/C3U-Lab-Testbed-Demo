/**
 * Physical constants, hardware presets and default gains.
 * All values SI (m, s, kg, rad). See docs/MODEL.md for sources.
 */
import { v3, type Vec3 } from './vec';

export const G = 9.81;
/** Fixed physics step (s). */
export const DT_PHYS = 0.001;
/** Trajectory file standard sample period (s), 100 Hz. */
export const TRAJ_DT = 0.01;

export type DronePresetId = 'CF21' | 'CF21_BRUSHLESS';

export interface DronePreset {
  id: DronePresetId;
  name: string;
  /** Mass with markers (kg); display and effort only, the dynamics use specific thrust. */
  mass: number;
  /** Thrust-to-weight ratio with markers. */
  twr: number;
  /** Maximum total thrust (g-force grams), display only. */
  maxThrustGrams: number;
}

export const PRESETS: Record<DronePresetId, DronePreset> = {
  CF21: { id: 'CF21', name: 'Crazyflie 2.1', mass: 0.033, twr: 1.8, maxThrustGrams: 60 },
  CF21_BRUSHLESS: { id: 'CF21_BRUSHLESS', name: 'Crazyflie 2.1 Brushless', mass: 0.034, twr: 3.5, maxThrustGrams: 120 },
};

/** Default maximum tilt of the thrust vector (rad). */
export const THETA_MAX_DEFAULT = (60 * Math.PI) / 180;
/** Default planning thrust reserve eta (share of max thrust usable by plans). */
export const ETA_DEFAULT = 0.7;
/** Default acceleration lag time constant (attitude dynamics), s. */
export const TAU_A_DEFAULT = 0.03;

/** Mellinger-like onboard gains (final tuned values, see DECISIONS.md). */
export const MELLINGER_GAINS = { kp: v3(12, 12, 15), kd: v3(5, 5, 6) };
/** PID-like baseline gains: same P/D, small integral, no acceleration feed-forward. */
export const PID_GAINS = { kp: v3(12, 12, 15), kd: v3(5, 5, 6), ki: v3(1.5, 1.5, 2.0), iLimit: 0.5 };

/** Single-drone downwash ellipsoid radii (m), Hönig et al. 2018. */
export const ELLIPSOID_RADII: Readonly<Vec3> = Object.freeze(v3(0.12, 0.12, 0.3));
/** Pairwise ellipsoid semi-axes E = diag(0.24, 0.24, 0.60) (before the margin multiplier). */
export const PAIR_E: Readonly<Vec3> = Object.freeze(v3(0.24, 0.24, 0.6));
/** Drone body radius (m), used for gate passes, obstacle clearance and strikes. */
export const DRONE_RADIUS = 0.05;
/** Physical collision: centre distance below this (m). */
export const COLLISION_DIST = 0.1;
/** Geofence / validator margin inside the arena (m). */
export const ARENA_MARGIN = 0.3;
/** Vicon jumps larger than this per frame are rejected (m). */
export const VICON_JUMP_LIMIT = 0.1;
/** Filter correction above this counts as an intervention (m/s^2). */
export const INTERVENTION_THRESHOLD = 0.05;
/** Battery sag reference flight time (s). */
export const BATTERY_FLIGHT_TIME = 7 * 60;

export const DEFAULT_ARENA = { sx: 8, sy: 5, sz: 3 };

/** Drone colours (index = drone id). */
export const DRONE_COLORS = ['#38bdf8', '#f472b6', '#facc15', '#4ade80', '#a78bfa', '#fb923c'];
export const DRONE_NAMES = ['A', 'B', 'C', 'D', 'E', 'F'];

export const HONESTY_LABEL = 'Simulation. Idealised models; numbers are illustrative, not hardware results.';
export const PLANNER_LABEL = 'Simplified stand-ins for the lab’s solvers';
