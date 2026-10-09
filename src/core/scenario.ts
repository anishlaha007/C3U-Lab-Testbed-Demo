/**
 * Scenario builder: turns a SimConfig into per-drone trajectories, an optional course (gates
 * and obstacles) and an optional race track (for progress and the planners).
 */
import { defaultDrone } from './defaults';
import type { Track } from './planners/track';
import { antipodal } from './trajectories/antipodal';
import { circle } from './trajectories/circle';
import { trajDuration } from './trajectories/common';
import { figure8 } from './trajectories/figure8';
import { headon } from './trajectories/headon';
import type { ArenaConfig, Course, DroneConfig, SimConfig, Trajectory } from './types';
import { v3, type Vec3 } from './vec';

export interface ScenarioBuild {
  name: string;
  trajectories: Trajectory[];
  /** Speed multiplier k. */
  k: number;
  course: Course | null;
  track: Track | null;
  arena: ArenaConfig;
  /** Start planes for lap timing (null if not periodic). */
  lapPlanes: ({ p: Vec3; n: Vec3 } | null)[];
  /** Planner prediction (M20). */
  prediction?: { gap: number; winner: number };
  /** Racing-line length (M27). */
  lineLength: number;
  notes: string[];
}

export interface BuildOverrides {
  trajectories?: Trajectory[];
  course?: Course | null;
  track?: Track | null;
  prediction?: { gap: number; winner: number };
}

/** Pad or trim drone configs to n. */
export function dronesFor(cfg: SimConfig, n: number): DroneConfig[] {
  const out = cfg.drones.slice(0, n);
  while (out.length < n) out.push(defaultDrone(out.length));
  return out;
}

export type ScenarioBuilder = (cfg: SimConfig) => Omit<ScenarioBuild, 'k' | 'arena' | 'lapPlanes' | 'lineLength'> & { lineLength?: number };

/** Registry so later modules (courses, planners) can add builders without import cycles. */
export const BUILDERS: Partial<Record<SimConfig['scenario']['type'], ScenarioBuilder>> = {
  figure8: (cfg) => {
    const sc = cfg.scenario;
    const n = Math.max(1, cfg.drones.length);
    const trajectories = Array.from({ length: n }, (_, i) =>
      figure8({ A: sc.A, w: sc.w, z0: sc.z0, phase: sc.phase + (n > 1 ? Math.PI / 2 : 0) + (2 * Math.PI * i) / n, laps: sc.laps }, { drone_id: i }),
    );
    return { name: 'Figure-8', trajectories, course: null, track: null, notes: [] };
  },
  circle: (cfg) => {
    const sc = cfg.scenario;
    const n = Math.max(1, cfg.drones.length);
    const trajectories = Array.from({ length: n }, (_, i) =>
      circle({ radius: sc.radius, w: sc.w, z0: sc.z0, phase: sc.phase + (2 * Math.PI * i) / n, laps: sc.laps }, { drone_id: i }),
    );
    return { name: 'Circle', trajectories, course: null, track: null, notes: [] };
  },
  intersection: (cfg) => {
    const sc = cfg.scenario;
    // two drones on the same figure-8, drone 2 shifted in phase (pi: x2 = -x1, y2 = y1)
    // both start on the outer lobes (theta0 = pi/2) and meet in the centre twice per lap
    const th0 = Math.PI / 2;
    const trajectories = [
      figure8({ A: sc.A, w: sc.w, z0: sc.z0, phase: th0, laps: sc.laps }, { drone_id: 0, track_id: 'intersection' }),
      figure8({ A: sc.A, w: sc.w, z0: sc.z0, phase: th0 + sc.phaseOffset, laps: sc.laps }, { drone_id: 1, track_id: 'intersection' }),
    ];
    return { name: 'Intersection', trajectories, course: null, track: null, notes: [] };
  },
  headon: (cfg) => {
    const sc = cfg.scenario;
    return { name: 'Head-on', trajectories: headon({ speed: sc.headonSpeed, gap: sc.headonGap, z0: sc.z0, coast: sc.headonCoast }), course: null, track: null, notes: [] };
  },
  antipodal: (cfg) => {
    const sc = cfg.scenario;
    const n = Math.max(2, cfg.drones.length);
    return {
      name: 'Antipodal swap',
      trajectories: antipodal({ n, radius: 1.5, z0: sc.z0, speed: sc.targetSpeed }),
      course: null,
      track: null,
      notes: [],
    };
  },
};

export function buildScenario(cfg: SimConfig, ov: BuildOverrides = {}): ScenarioBuild {
  const builder = BUILDERS[cfg.scenario.type] ?? BUILDERS.figure8!;
  const base = ov.trajectories ? null : builder(cfg);
  const trajectories = ov.trajectories ?? base!.trajectories;
  const course = ov.course !== undefined ? ov.course : (base?.course ?? null);
  const track = ov.track !== undefined ? ov.track : (base?.track ?? null);
  const arena = course?.arena ? { ...course.arena } : { ...cfg.arena };
  // keep the user's arena if it is larger than the course's recommendation
  arena.sx = Math.max(arena.sx, cfg.arena.sx);
  arena.sy = Math.max(arena.sy, cfg.arena.sy);
  arena.sz = Math.max(arena.sz, cfg.arena.sz);
  const lapPlanes = trajectories.map((tr) => {
    if (!tr.lapPeriod || (tr.laps ?? 1) < 1) return null;
    const p = v3(tr.x[0], tr.y[0], tr.z[0]);
    const vn = Math.hypot(tr.vx[0], tr.vy[0], tr.vz[0]);
    if (vn < 1e-6) return null;
    return { p, n: v3(tr.vx[0] / vn, tr.vy[0] / vn, tr.vz[0] / vn) };
  });
  return {
    name: base?.name ?? 'Imported',
    trajectories,
    k: cfg.scenario.timeScale > 0 ? cfg.scenario.timeScale : 1,
    course,
    track,
    arena,
    lapPlanes,
    prediction: ov.prediction ?? base?.prediction,
    lineLength: base?.lineLength ?? (track ? track.length : 0),
    notes: base?.notes ?? [],
  };
}

/** Longest scaled trajectory duration (race window). */
export function raceDuration(b: ScenarioBuild): number {
  return Math.max(...b.trajectories.map((t) => trajDuration(t))) / b.k;
}
