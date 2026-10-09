/**
 * Receding-horizon re-planning (Section 7.3, stretch): every Δt the game is re-solved from the
 * drones' current state (progress along the track, lateral offset, speed) and each drone switches
 * to its new strategy for the rest of the race. Uses a reduced candidate set to stay fast enough
 * to run inside the control loop; the solve time is reported.
 */
import { DRONE_RADIUS } from '../constants';
import { isDynamic, obstaclePrimitives } from '../course';
import { distanceToPrimitive } from '../geometry';
import type { RaceSetup } from '../race';
import { sampleTrajectory } from '../trajectories/common';
import type { SimConfig, Trajectory } from '../types';
import type { Vec3 } from '../vec';
import { buildCandidate, candidateSpecs } from './candidates';
import { insideArena, solveTwoDroneGame } from './plan';
import { sampleCandidate } from './rollout';
import { closestIndex, offsetsAt, refineS } from './track';

export interface ReplanDrone {
  p: Vec3;
  v: Vec3;
  /** Progress along the shared track (m). */
  progress: number;
  active: boolean;
}

export interface ReplanResult {
  trajectories: (Trajectory | null)[];
  choice: number[];
  solveMs: number;
  note: string;
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function hitsDynamicFrom(traj: Trajectory, setup: RaceSetup, tStart: number, clearance: number): boolean {
  const dyn = setup.course.obstacles.filter(isDynamic);
  if (!dyn.length) return false;
  const T = Math.min(traj.t[traj.t.length - 1], 4);
  for (let t = 0; t <= T; t += 0.05) {
    const p = sampleTrajectory(traj, t).p;
    for (const o of dyn) for (const prim of obstaclePrimitives(o, tStart + t, true)) if (distanceToPrimitive(p, prim) < clearance) return true;
  }
  return false;
}

export function replanFromState(cfg: SimConfig, setup: RaceSetup, drones: ReplanDrone[], tNow: number, round: number, horizon = 3): ReplanResult | null {
  const t0 = now();
  const n = drones.length;
  const pl = cfg.planner;
  const M = Math.max(4, Math.min(12, Math.round(pl.M)));
  const timing = cfg.course.dynamicObstacles && setup.course.obstacles.some(isDynamic);
  const specs = candidateSpecs(M, cfg.seed * 7919 + round, 4, cfg.scenario.type === 'ringCircuit', timing);
  const arena = { sx: Math.max(cfg.arena.sx, setup.course.arena.sx), sy: Math.max(cfg.arena.sy, setup.course.arena.sy), sz: Math.max(cfg.arena.sz, setup.course.arena.sz) };
  const L = setup.track.length;
  const raceLength = setup.track.closed ? L * setup.laps : L;
  const trajs: Trajectory[][] = [];
  const valid: boolean[][] = [];
  const remainingOf: number[] = [];
  for (let d = 0; d < n; d++) {
    const dr = drones[d];
    // open tracks: stop where this drone parks (rows behind park earlier)
    const remaining = raceLength - dr.progress - (setup.track.closed ? 0 : setup.starts[d].endBack);
    remainingOf.push(remaining);
    if (!dr.active || remaining < 1.0) {
      trajs.push([]);
      valid.push([]);
      continue;
    }
    const tr = setup.droneTracks[d];
    // search near the drone's known progress: a global nearest point can jump to the other
    // branch where a track crosses itself (C9 figure-8), as ProgressTracker's window avoids
    const L0 = setup.track.length;
    const sLap = setup.track.closed ? ((dr.progress % L0) + L0) % L0 : Math.max(0, Math.min(L0, dr.progress));
    const nPts = tr.pts.length;
    const raw = Math.round(((sLap / L0) * tr.length) / tr.ds);
    const hint = tr.closed ? ((raw % nPts) + nPts) % nPts : Math.max(0, Math.min(nPts - 1, raw));
    const idx = closestIndex(tr, dr.p, Number.isFinite(dr.progress) ? hint : -1, 1.0);
    const sOwn = refineS(tr, dr.p, idx);
    const off = offsetsAt(tr, dr.p, idx);
    const lat = Math.max(-tr.halfWidth[idx], Math.min(tr.halfWidth[idx], off.lat));
    const v0 = Math.hypot(dr.v.x, dr.v.y, dr.v.z);
    const ts: Trajectory[] = [];
    const vs: boolean[] = [];
    specs.forEach((spec, k) => {
      const { cand, traj } = buildCandidate(
        tr,
        spec,
        setup.limits[d],
        { startLateral: lat, endLateral: setup.starts[d].endLateral, startS: sOwn, laps: 1, total: remaining, v0: Math.max(0.2, v0), obstacles: setup.obstacles, clearance: DRONE_RADIUS + 0.06, droneId: d, startBlend: 1.0 },
        k,
      );
      let ok = cand.valid && insideArena(traj, arena);
      if (ok && cfg.course.dynamicObstacles) ok = !hitsDynamicFrom(traj, setup, tNow, DRONE_RADIUS + 0.1);
      ts.push(traj);
      vs.push(ok);
    });
    if (!vs.some(Boolean)) vs[0] = true;
    trajs.push(ts);
    valid.push(vs);
  }
  if (trajs.every((t) => !t.length)) return null;
  // horizon: Δ ahead, never past the earliest finish
  let H = horizon;
  trajs.forEach((ts, d) => ts.forEach((tr, k) => valid[d][k] && (H = Math.min(H, tr.t[tr.t.length - 1]))));
  H = Math.max(0.5, H);
  const samples = trajs.map((ts) => ts.map((tr) => sampleCandidate(tr, setup.track, H)));
  const own = samples.map((ss) => ss.map((s) => s.s[s.s.length - 1]));
  const indep = own.map((ps, d) => {
    let best = 0;
    ps.forEach((p, k) => valid[d][k] && (!valid[d][best] || p > ps[best]) && (best = k));
    return best;
  });
  let choice = indep;
  let note = 'independent re-plan';
  if (n === 2 && trajs[0].length && trajs[1].length) {
    const r = solveTwoDroneGame(samples, valid, pl, indep);
    choice = r.choice;
    note = r.note;
  }
  return {
    trajectories: trajs.map((ts, d) => (ts.length ? ts[choice[d]] : null)),
    choice,
    solveMs: now() - t0,
    note,
  };
}
