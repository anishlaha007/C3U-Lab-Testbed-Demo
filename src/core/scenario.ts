/**
 * Scenario builder: turns a SimConfig into per-drone trajectories, an optional course (gates
 * and obstacles) and an optional race track (for progress and the planners).
 */
import { dronesFor } from './defaults';
import type { Track } from './planners/track';
import { defaultRaceTrajectories, raceSetup } from './race';
import { splitSCourse } from './courseLibrary';
import { buildRacingLine } from './racingLine';
import { antipodal } from './trajectories/antipodal';
import { randomCrossing } from './trajectories/random';
import { importedTrajectories } from './csv';
import { circle } from './trajectories/circle';
import { defaultMeta, trajDuration, trajectoryFromFunction } from './trajectories/common';
import { figure8 } from './trajectories/figure8';
import { headon } from './trajectories/headon';
import type { ArenaConfig, Course, SimConfig, Trajectory } from './types';
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
  prediction?: { gap: number; winner: number; horizon?: number };
  /** Racing-line length (M27). */
  lineLength: number;
  /** Raw obstacle-detour search paths (teaching view). */
  searchPaths?: Vec3[][];
  notes: string[];
}

export interface BuildOverrides {
  trajectories?: Trajectory[];
  course?: Course | null;
  track?: Track | null;
  prediction?: { gap: number; winner: number; horizon?: number };
}

export { dronesFor };

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
  splitS: (cfg) => {
    const course = splitSCourse();
    const line = buildRacingLine(course, { speed: cfg.scenario.targetSpeed, twr: 1.8, eta: cfg.system.eta, thetaMaxDeg: cfg.system.thetaMaxDeg, arena: cfg.arena });
    const laps = Math.max(1, cfg.scenario.laps);
    const lapT = line.spline.duration;
    const n = Math.max(1, cfg.drones.length);
    const trajectories = Array.from({ length: n }, (_, i) => {
      // extra drones share the loop, evenly spaced in time
      const off = (i * lapT) / n;
      const tr = trajectoryFromFunction(
        lapT * laps,
        (t) => {
          const e = line.spline.eval((t + off) % lapT);
          return { p: e.p, v: e.v, a: e.a };
        },
        defaultMeta({ drone_id: i, track_id: 'splitS', strategy: 'racing-line', solver: 'min_jerk' }),
      );
      tr.lapPeriod = lapT;
      tr.laps = laps;
      return tr;
    });
    course.laps = laps;
    return { name: 'Split-S dive', trajectories, course, track: line.track, notes: [], lineLength: line.track.length * laps, searchPaths: line.searchPaths };
  },
  random: (cfg) => {
    const n = Math.max(2, cfg.drones.length);
    return { name: 'Random crossing', trajectories: randomCrossing({ n, seed: cfg.seed, speed: cfg.scenario.targetSpeed, arena: cfg.arena, z0: cfg.scenario.z0 }), course: null, track: null, notes: [] };
  },
  pinch: (cfg) => raceBuild(cfg, 'Pinch'),
  raceTrack: (cfg) => raceBuild(cfg, 'Race loop'),
  ringCircuit: (cfg) => raceBuild(cfg, 'Ring course'),
  imported: (cfg) => {
    const trajectories = importedTrajectories();
    if (!trajectories.length) throw new Error('No imported trajectories: drop CSV files from the lab\'s solvers onto the app.');
    void cfg;
    return { name: 'Imported CSV', trajectories, course: null, track: null, notes: [] };
  },
};

function raceBuild(cfg: SimConfig, name: string): ReturnType<ScenarioBuilder> {
  const setup = raceSetup(cfg);
  if (!setup) throw new Error('Select a course (C1-C12) for a ring-course scenario.');
  return {
    name: `${name}: ${setup.course.name}`,
    trajectories: defaultRaceTrajectories(setup),
    course: setup.course,
    track: setup.track,
    notes: [],
    lineLength: setup.lineLength,
    searchPaths: setup.searchPaths,
  };
}

export function buildScenario(cfg: SimConfig, ov: BuildOverrides = {}): ScenarioBuild {
  const builder = BUILDERS[cfg.scenario.type] ?? BUILDERS.figure8!;
  // with overridden trajectories (a solved plan) race scenarios still need their course and
  // track (gates, progress); other scenarios have neither
  let base: ReturnType<ScenarioBuilder> | null = null;
  if (!ov.trajectories) base = builder(cfg);
  else {
    const setup = raceSetup(cfg);
    if (setup) base = { name: `${cfg.scenario.type === 'pinch' ? 'Pinch' : cfg.scenario.type === 'raceTrack' ? 'Race loop' : 'Ring course'}: ${setup.course.name}`, trajectories: ov.trajectories, course: setup.course, track: setup.track, notes: [], lineLength: setup.lineLength, searchPaths: setup.searchPaths };
  }
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
    name: base?.name ?? (cfg.scenario.type === 'imported' ? 'Imported' : cfg.scenario.type),
    trajectories,
    k: cfg.scenario.timeScale > 0 ? cfg.scenario.timeScale : 1,
    course,
    track,
    arena,
    lapPlanes,
    prediction: ov.prediction ?? base?.prediction,
    lineLength: base?.lineLength ?? (track ? track.length : 0),
    searchPaths: base?.searchPaths,
    notes: base?.notes ?? [],
  };
}

/** Longest scaled trajectory duration (race window). */
export function raceDuration(b: ScenarioBuild): number {
  return Math.max(...b.trajectories.map((t) => trajDuration(t))) / b.k;
}
