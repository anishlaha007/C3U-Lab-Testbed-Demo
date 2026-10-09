/**
 * Pre-flight quantities computed from the planned trajectories: planned lap time and effort
 * (scorecard references), feasibility share (M9) and planned safety (M17).
 */
import { G, PRESETS } from './constants';
import { gateCrossing, gateFrame } from './course';
import { checkFeasibility } from './feasibility';
import { pairD } from './safety/ecbf';
import type { ScenarioBuild } from './scenario';
import { dronesFor } from './scenario';
import { sampleScaled, trajDuration } from './trajectories/common';
import type { GateVisit, PlannedInfo, SimConfig, Trajectory } from './types';

/**
 * Planned effort: integral over scaled time of |a_ref k^2 + g e_z|. With `windowEnd` (s, scaled),
 * a drone whose trajectory ends earlier is planned to hover (|f| = g) until then, so the planned
 * and measured effort cover the same window (the measured effort runs to the end of the race).
 */
export function plannedEffort(tr: Trajectory, k: number, windowEnd?: number): number {
  let s = 0;
  for (let i = 1; i < tr.t.length; i++) {
    const dt = (tr.t[i] - tr.t[i - 1]) / k;
    const f0 = Math.hypot(tr.ax[i - 1] * k * k, tr.ay[i - 1] * k * k, tr.az[i - 1] * k * k + G);
    const f1 = Math.hypot(tr.ax[i] * k * k, tr.ay[i] * k * k, tr.az[i] * k * k + G);
    s += 0.5 * (f0 + f1) * dt;
  }
  const end = trajDuration(tr) / k;
  return windowEnd !== undefined && windowEnd > end ? s + G * (windowEnd - end) : s;
}

/** Planned effort up to race time t (scaled), for provisional live scoring. */
export function plannedEffortUpTo(tr: Trajectory, k: number, tEnd: number): number {
  let s = 0;
  for (let i = 1; i < tr.t.length; i++) {
    if (tr.t[i] / k > tEnd) break;
    const dt = (tr.t[i] - tr.t[i - 1]) / k;
    const f0 = Math.hypot(tr.ax[i - 1] * k * k, tr.ay[i - 1] * k * k, tr.az[i - 1] * k * k + G);
    const f1 = Math.hypot(tr.ax[i] * k * k, tr.ay[i] * k * k, tr.az[i] * k * k + G);
    s += 0.5 * (f0 + f1) * dt;
  }
  const end = trajDuration(tr) / k;
  return tEnd > end ? s + G * (tEnd - end) : s;
}

/**
 * Planned time of the last scheduled gate pass of each drone (s, scaled): the reference for the
 * speed sub-score on courses (the trajectory itself continues to a stop in the drone's lane).
 */
export function plannedFinishTimes(b: ScenarioBuild): number[] {
  const course = b.course;
  if (!course) return b.trajectories.map(() => NaN);
  const laps = Math.max(1, course.laps);
  const frames = course.gates.map((g) => gateFrame(g));
  return b.trajectories.map((tr, i) => {
    const own = course.droneSequences?.[i] ?? course.sequence;
    const visits: GateVisit[] = [];
    for (let l = 0; l < laps; l++) visits.push(...own);
    if (!visits.length) return NaN;
    let next = 0;
    for (let k = 1; k < tr.t.length && next < visits.length; k++) {
      const v = visits[next];
      const c = gateCrossing(course.gates[v.gate], frames[v.gate], { x: tr.x[k - 1], y: tr.y[k - 1], z: tr.z[k - 1] }, { x: tr.x[k], y: tr.y[k], z: tr.z[k] }, !!v.reverse);
      if (c.kind === 'pass') {
        next++;
        if (next === visits.length) return tr.t[k] / b.k;
      }
    }
    return NaN;
  });
}

/** Minimum scaled separation between planned trajectories (unit margin), sampled at 100 Hz. */
export function minPlannedSeparation(trajs: Trajectory[], k: number, marginMultiplier = 1): { min: number; t: number; i: number; j: number } {
  const D = pairD(marginMultiplier);
  const T = Math.max(...trajs.map((t) => trajDuration(t))) / k;
  let best = { min: Infinity, t: 0, i: -1, j: -1 };
  for (let t = 0; t <= T + 1e-9; t += 0.01) {
    const ps = trajs.map((tr) => sampleScaled(tr, t, k).p);
    for (let i = 0; i < ps.length; i++) {
      for (let j = i + 1; j < ps.length; j++) {
        const dx = ps[i].x - ps[j].x;
        const dy = ps[i].y - ps[j].y;
        const dz = ps[i].z - ps[j].z;
        const s = Math.sqrt(dx * dx * D.x + dy * dy * D.y + dz * dz * D.z);
        if (s < best.min) best = { min: s, t, i, j };
      }
    }
  }
  return best;
}

/** First time the planned trajectory comes within 0.15 m of its final point (unscaled). */
export function plannedArrival(tr: Trajectory): number {
  const n = tr.t.length;
  const fx = tr.x[n - 1];
  const fy = tr.y[n - 1];
  const fz = tr.z[n - 1];
  for (let i = 0; i < n; i++) {
    if (Math.hypot(tr.x[i] - fx, tr.y[i] - fy, tr.z[i] - fz) < 0.15) return tr.t[i];
  }
  return tr.t[n - 1];
}

export function computePlanned(cfg: SimConfig, b: ScenarioBuild): PlannedInfo {
  const drones = dronesFor(cfg, b.trajectories.length);
  const sys = cfg.system;
  const raceEnd = Math.max(...b.trajectories.map((t) => trajDuration(t))) / b.k;
  return {
    lapTime: b.trajectories.map((tr) => (tr.lapPeriod ? tr.lapPeriod / b.k : NaN)),
    laps: b.trajectories.map((tr) => (tr.lapPeriod ? (tr.laps ?? 1) : 0)),
    arrival: b.trajectories.map((tr) => plannedArrival(tr) / b.k),
    finish: plannedFinishTimes(b),
    effort: b.trajectories.map((tr) => plannedEffort(tr, b.k, raceEnd)),
    feasibilityFail: b.trajectories.map((tr, i) => checkFeasibility(tr, b.k, (PRESETS[drones[i].preset] ?? PRESETS.CF21).twr, sys.eta, sys.thetaMaxDeg).share),
    minPlannedSeparation: b.trajectories.length > 1 ? minPlannedSeparation(b.trajectories, b.k).min : Infinity,
    duration: raceEnd,
    lineLength: b.lineLength,
    predictedGap: b.prediction?.gap,
    predictedWinner: b.prediction?.winner,
    // the planner's horizon is in trajectory time; the race reaches it at horizon / k
    predictionHorizon: b.prediction?.horizon !== undefined ? b.prediction.horizon / b.k : undefined,
  };
}
