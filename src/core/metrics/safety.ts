/** Safety metrics M10-M17 and the course metrics M23-M27 (Section 9). */
import type { TrialLog } from '../types';
import { mean, percentile, windowLength } from './window';

export interface SafetyMetrics {
  /** M10 collisions (contacts, including gate strikes and obstacle hits). */
  collisions: number;
  /** M11 closest approach (scaled separation, physical ellipsoid). */
  closestApproach: number;
  /** Closest Euclidean centre distance (m). */
  closestDistance: number;
  /** M12 total violation time (s). */
  violationTime: number;
  /** M13 intervention rate (0..1): ticks where any drone's command changed by > 0.05 m/s^2. */
  interventionRate: number;
  interventionRatePerDrone: number[];
  /** M14 mean correction over intervened ticks (m/s^2). */
  interventionSize: number;
  /** M16 99th percentile filter solve time (ms). */
  solveP99: number;
  /** M17 planned safety (min planned scaled separation). */
  plannedSafety: number;
  /** M26 share of ticks with a drone-obstacle correction. */
  obstacleInterventionRate: number;
  /** Share of ticks with a drone-drone correction. */
  pairInterventionRate: number;
  emergencies: number;
  clippedShare: number;
}

export function safetyMetrics(log: TrialLog): SafetyMetrics {
  const n = windowLength(log);
  const D = log.drones.length;
  let anyTicks = 0;
  let obsTicks = 0;
  let pairTicks = 0;
  const perDrone = new Array<number>(D).fill(0);
  const sizes: number[] = [];
  for (let k = 0; k < n; k++) {
    let any = false;
    let obs = false;
    let pair = false;
    for (let i = 0; i < D; i++) {
      const g = log.drones[i];
      if (g.intervened[k]) {
        any = true;
        perDrone[i]++;
        sizes.push(g.correction[k]);
      }
      if (g.obsIntervened[k]) obs = true;
      if (g.pairIntervened[k]) pair = true;
    }
    if (any) anyTicks++;
    if (obs) obsTicks++;
    if (pair) pairTicks++;
  }
  const solve = log.solveMs.slice(0, n).filter((x) => x > 0);
  return {
    collisions: log.summary.collisions,
    closestApproach: log.summary.minScaledSeparation,
    closestDistance: log.summary.minCentreDistance,
    violationTime: log.summary.violationTime,
    interventionRate: n ? anyTicks / n : 0,
    interventionRatePerDrone: perDrone.map((c) => (n ? c / n : 0)),
    interventionSize: sizes.length ? mean(sizes) : 0,
    solveP99: solve.length ? percentile(solve, 0.99) : 0,
    plannedSafety: log.planned.minPlannedSeparation,
    obstacleInterventionRate: n ? obsTicks / n : 0,
    pairInterventionRate: n ? pairTicks / n : 0,
    emergencies: log.summary.emergencies,
    clippedShare: log.summary.ctrlTicks ? log.summary.clippedTicks / log.summary.ctrlTicks : 0,
  };
}

/** M15 cost of safety: multi-drone RMSE minus the same trajectory flown alone (per drone). */
export function costOfSafety(multiRmse: number[], soloRmse: number[]): number[] {
  return multiRmse.map((m, i) => m - (soloRmse[i] ?? NaN));
}

export interface CourseMetrics {
  /** M23 gate pass rate (clean passes / attempted). */
  passRate: number;
  passes: number;
  attempted: number;
  /** M24 strikes and misses. */
  strikes: number;
  misses: number;
  /** M25 minimum drone-surface to obstacle-surface distance (m). */
  obstacleClearance: number;
  /** M27 course time per drone (s, NaN if not finished) and path ratio. */
  courseTime: number[];
  pathRatio: number[];
}

export function courseMetrics(log: TrialLog): CourseMetrics {
  const g = log.summary.gates;
  const passes = g.reduce((a, x) => a + x.passes, 0);
  const attempted = g.reduce((a, x) => a + x.attempted, 0);
  return {
    passRate: attempted ? passes / attempted : NaN,
    passes,
    attempted,
    strikes: g.reduce((a, x) => a + x.strikes, 0),
    misses: g.reduce((a, x) => a + x.misses, 0),
    obstacleClearance: log.summary.obstacleClearance,
    courseTime: g.map((x) => x.finishTime),
    pathRatio: log.summary.pathLength.map((L) => (log.planned.lineLength > 0 ? L / log.planned.lineLength : NaN)),
  };
}
