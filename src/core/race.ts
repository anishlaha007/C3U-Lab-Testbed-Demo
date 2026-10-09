/**
 * Race setup shared by the planner scenarios (pinch T4, race loop T9, ring courses T12-T14):
 * course, shared progress track, per-drone tracks, start slots, drone limits and the obstacles a
 * candidate must avoid. Racing lines are cached because spline fitting and detour search are the
 * expensive part of building a scenario.
 */
import { PRESETS } from './constants';
import { gateFrame } from './course';
import { buildCourse, pinchCourse, raceLoopCourse } from './courseLibrary';
import { dronesFor } from './defaults';
import type { Primitive } from './geometry';
import { buildCandidate, type DroneLimits } from './planners/candidates';
import { makeTrack, type Track } from './planners/track';
import { buildRacingLine, lineObstacles, trackFromLine } from './racingLine';
import type { Course, SimConfig, Trajectory } from './types';
import { v3, type Vec3 } from './vec';

export interface StartSlot {
  lateral: number;
  s: number;
}

export interface RaceSetup {
  key: string;
  course: Course;
  track: Track;
  droneTracks: Track[];
  starts: StartSlot[];
  laps: number;
  limits: DroneLimits[];
  obstacles: Primitive[];
  searchPaths: Vec3[][];
  lineLength: number;
  /** Duration of the min-jerk racing line (s, one lap). */
  lineDuration: number;
}

const cache = new Map<string, RaceSetup>();

export function isRaceScenario(cfg: SimConfig): boolean {
  return cfg.scenario.type === 'pinch' || cfg.scenario.type === 'raceTrack' || (cfg.scenario.type === 'ringCircuit' && cfg.course.courseId !== 'none');
}

/** Key of everything a race setup depends on (used for caching and plan invalidation). */
export function raceKey(cfg: SimConfig): string {
  const sc = cfg.scenario;
  return JSON.stringify({
    type: sc.type,
    course: sc.type === 'ringCircuit' ? cfg.course : null,
    pinch: sc.type === 'pinch' ? [sc.ringInnerDiameter, sc.startOffset] : null,
    speed: sc.targetSpeed,
    laps: sc.laps,
    z0: sc.type === 'raceTrack' || sc.type === 'pinch' ? sc.z0 : null,
    drones: cfg.drones.map((d) => d.preset),
    n: cfg.drones.length,
    eta: cfg.system.eta,
    tilt: cfg.system.thetaMaxDeg,
    arena: cfg.arena,
    swap: cfg.planner.swapStarts,
  });
}

function limitsFor(cfg: SimConfig, n: number): DroneLimits[] {
  return dronesFor(cfg, n).map((d) => ({
    twr: (PRESETS[d.preset] ?? PRESETS.CF21).twr,
    eta: cfg.system.eta,
    thetaMaxDeg: cfg.system.thetaMaxDeg,
    vCap: cfg.scenario.targetSpeed,
  }));
}

/** Start slots: side by side 0.6 m apart (lanes), further drones in rows 0.8 m behind. */
export function startSlots(n: number, closed: boolean, swap: boolean, stagger = 0): StartSlot[] {
  const slots: StartSlot[] = [];
  for (let i = 0; i < n; i++) {
    const row = Math.floor(i / 2);
    let side = i % 2 === 0 ? 0.3 : -0.3;
    if (swap) side = -side;
    if (n === 1) side = 0;
    slots.push({ lateral: side, s: -0.8 * row + (i === 0 ? stagger : 0) });
  }
  if (!closed) {
    const minS = Math.min(...slots.map((s) => s.s));
    slots.forEach((s) => (s.s -= minS));
  } else {
    slots.forEach((s) => (s.s = s.s < 0 ? s.s : s.s));
  }
  return slots;
}

function ovalTrack(z0: number, course: Course): Track {
  // stadium: straights y = +-1.5 for |x| <= 1.5, semicircles of radius 1.5 centred at (+-1.5, 0)
  const pts: Vec3[] = [];
  const R = 1.5;
  const H = 1.5;
  const per = 4 * H + 2 * Math.PI * R;
  const n = 900;
  const s0 = H - 1.2; // start 1.2 m before the first gate (at x = 0 on the south straight)
  for (let k = 0; k < n; k++) {
    let s = (s0 + (k / n) * per) % per;
    let p: Vec3;
    if (s < 2 * H) p = v3(-H + s, -R, z0);
    else if ((s -= 2 * H) < Math.PI * R) {
      const a = -Math.PI / 2 + s / R;
      p = v3(H + R * Math.cos(a), R * Math.sin(a), z0);
    } else if ((s -= Math.PI * R) < 2 * H) p = v3(H - s, R, z0);
    else {
      s -= 2 * H;
      const a = Math.PI / 2 + s / R;
      p = v3(-H + R * Math.cos(a), R * Math.sin(a), z0);
    }
    pts.push(p);
  }
  const frames = course.gates.map(gateFrame);
  return trackFromLine(course, pts, true, frames, course.sequence, []);
}

function pinchTrack(z0: number, course: Course): Track {
  const pts: Vec3[] = [];
  for (let x = -3.0; x <= 3.0 + 1e-9; x += 0.05) pts.push(v3(x, 0, z0));
  return trackFromLine(course, pts, false, course.gates.map(gateFrame), course.sequence, []);
}

/** Average several tracks pointwise (shared progress track of the merge course). */
function averageTracks(tracks: Track[], course: Course): Track {
  const n = 600;
  const pts: Vec3[] = [];
  for (let k = 0; k < n; k++) {
    let x = 0;
    let y = 0;
    let z = 0;
    for (const t of tracks) {
      const i = Math.min(t.pts.length - 1, Math.round((k / (n - 1)) * (t.pts.length - 1)));
      x += t.pts[i].x;
      y += t.pts[i].y;
      z += t.pts[i].z;
    }
    pts.push(v3(x / tracks.length, y / tracks.length, z / tracks.length));
  }
  return makeTrack(pts, { id: `${course.id}-shared`, closed: course.closed, ds: 0.05, halfWidth: () => 0.5, halfHeight: () => 0.3 });
}

export function raceSetup(cfg: SimConfig): RaceSetup | null {
  if (!isRaceScenario(cfg)) return null;
  const key = raceKey(cfg);
  const hit = cache.get(key);
  if (hit) return hit;
  const sc = cfg.scenario;
  let course: Course;
  let track: Track;
  let droneTracks: Track[];
  let searchPaths: Vec3[][] = [];
  let lineDuration = 0;
  const n = Math.max(1, cfg.drones.length);
  const limits = limitsFor(cfg, n);
  const minTwr = Math.min(...limits.map((l) => l.twr));
  if (sc.type === 'raceTrack') {
    course = raceLoopCourse();
    course.laps = sc.laps;
    track = ovalTrack(sc.z0, course);
    droneTracks = Array.from({ length: n }, () => track);
  } else if (sc.type === 'pinch') {
    course = pinchCourse(sc.ringInnerDiameter);
    course.gates[0].center.z = sc.z0;
    track = pinchTrack(sc.z0, course);
    droneTracks = Array.from({ length: n }, () => track);
  } else {
    const c = buildCourse(cfg.course);
    if (!c) return null;
    course = c;
    course.laps = course.closed ? sc.laps : 1;
    const arena = { sx: Math.max(cfg.arena.sx, course.arena.sx), sy: Math.max(cfg.arena.sy, course.arena.sy), sz: Math.max(cfg.arena.sz, course.arena.sz) };
    const lineOpts = { speed: sc.targetSpeed, twr: minTwr, eta: cfg.system.eta, thetaMaxDeg: cfg.system.thetaMaxDeg, arena };
    if (course.droneSequences && n > 1) {
      const lines = Array.from({ length: n }, (_, i) => buildRacingLine(course, { ...lineOpts, sequence: course.droneSequences![i % course.droneSequences!.length] }));
      droneTracks = lines.map((l) => l.track);
      searchPaths = lines.flatMap((l) => l.searchPaths);
      track = averageTracks(droneTracks, course);
      lineDuration = Math.max(...lines.map((l) => l.duration));
    } else {
      const seq = course.droneSequences ? course.droneSequences[0] : undefined;
      const line = buildRacingLine(course, { ...lineOpts, sequence: seq });
      track = line.track;
      droneTracks = Array.from({ length: n }, () => track);
      searchPaths = line.searchPaths;
      lineDuration = line.duration;
    }
  }
  const starts = startSlots(n, track.closed, cfg.planner.swapStarts, sc.type === 'pinch' ? sc.startOffset : 0);
  if (sc.type === 'pinch') starts.forEach((s) => (s.s += 0.5));
  // merge: each drone starts on its own line, centred
  if (course.droneSequences && n > 1) starts.forEach((s) => (s.lateral = 0));
  const arenaForObs = { sx: Math.max(cfg.arena.sx, course.arena.sx), sy: Math.max(cfg.arena.sy, course.arena.sy), sz: Math.max(cfg.arena.sz, course.arena.sz) };
  const setup: RaceSetup = {
    key,
    course,
    track,
    droneTracks,
    starts,
    laps: track.closed ? Math.max(1, sc.laps) : 1,
    limits,
    obstacles: lineObstacles(course, arenaForObs),
    searchPaths,
    lineLength: track.closed ? track.length * Math.max(1, sc.laps) : track.length,
    lineDuration,
  };
  if (cache.size > 12) cache.delete(cache.keys().next().value!);
  cache.set(key, setup);
  return setup;
}

/** Default (unsolved) race trajectories: every drone flies the centreline at full speed. */
export function defaultRaceTrajectories(setup: RaceSetup): Trajectory[] {
  return setup.droneTracks.map(
    (tr, i) =>
      buildCandidate(
        tr,
        { lateral: [0, 0, 0, 0], vertical: [], speed: 1 },
        setup.limits[i],
        { startLateral: setup.starts[i].lateral, startS: setup.starts[i].s, laps: setup.laps, droneId: i, label: 'centreline@100%' },
      ).traj,
  );
}
