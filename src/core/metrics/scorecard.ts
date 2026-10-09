/**
 * Scorecard (Section 9): Score = G x (wS S + wV V + wA A + wE E) / (wS + wV + wA + wE).
 *
 *   G = 0 for a collision (incl. gate strike / obstacle hit), leaving the arena, a kill, or a missed
 *       gate in a ring course; 0.5 for a supervisor emergency brake; 0.75 for any separation
 *       violation without contact; otherwise 1.
 *   S = 0.5 [(1 - M13) + min(1, M11)]
 *   V = min(1, planned lap time / actual lap time)
 *   A = max(0, 1 - M1 / 0.30)
 *   E = min(1, planned effort / actual effort)
 */
import { Rng } from '../rng';
import type { TrialLog } from '../types';
import { effortMetrics } from './effort';
import { lastProgress } from './racing';
import { courseMetrics, safetyMetrics, type CourseMetrics, type SafetyMetrics } from './safety';
import { arrival, trackingMetrics, type TrackingMetrics } from './tracking';

export interface Weights {
  S: number;
  V: number;
  A: number;
  E: number;
}

export const EQUAL_WEIGHTS: Weights = { S: 1, V: 1, A: 1, E: 1 };

export interface SubScores {
  S: number;
  V: number;
  A: number;
  E: number;
}

export interface Scorecard {
  G: number;
  gateReason: string;
  sub: SubScores;
  score: number;
}

export function compositeScore(G: number, sub: SubScores, w: Weights = EQUAL_WEIGHTS): number {
  const W = w.S + w.V + w.A + w.E;
  if (W <= 0) return 0;
  return (G * (w.S * sub.S + w.V * sub.V + w.A * sub.A + w.E * sub.E)) / W;
}

export interface TrialEvaluation {
  tracking: TrackingMetrics[];
  safety: SafetyMetrics;
  course: CourseMetrics;
  effort: { actual: number[]; planned: number[]; ratio: number[] };
  scorecard: Scorecard;
  /** Per-drone V, A, E sub-scores. */
  perDrone: { V: number; A: number; E: number }[];
  isCourse: boolean;
}

export function gateFactor(log: TrialLog, isCourse: boolean): { G: number; reason: string } {
  const s = log.summary;
  if (s.collisions > 0 || s.endReason === 'collision') return { G: 0, reason: 'collision' };
  if (s.arenaExits > 0 || s.endReason === 'arenaExit') return { G: 0, reason: 'left the arena' };
  if (s.killed) return { G: 0, reason: 'kill' };
  if (isCourse && s.gates.some((g) => g.misses > 0)) return { G: 0, reason: 'missed gate' };
  if (s.emergencies > 0) return { G: 0.5, reason: 'emergency brake' };
  if (s.violationTime > 0) return { G: 0.75, reason: 'separation violation' };
  if (s.geofenceEvents > 0) return { G: 0, reason: 'geofence (left the flight volume)' };
  return { G: 1, reason: 'clean' };
}

/** Speed sub-score for drone i. */
export function speedScore(log: TrialLog, i: number, tr: TrackingMetrics): number {
  if (Number.isFinite(tr.lapTime) && Number.isFinite(tr.plannedLapTime) && tr.lapTime > 0) return Math.min(1, tr.plannedLapTime / tr.lapTime);
  const g = log.summary.gates[i];
  if (g && g.attempted > 0) {
    if (Number.isFinite(g.finishTime) && log.planned.duration > 0) return Math.min(1, log.planned.duration / g.finishTime);
    return g.attempted ? g.passes / g.attempted : 0;
  }
  const prog = lastProgress(log, i);
  if (Number.isFinite(prog) && Number.isFinite(log.trackLength)) {
    // progress actually made vs planned progress over the same window
    const planned = log.planned.lineLength > 0 ? log.planned.lineLength : log.trackLength;
    return planned > 0 ? Math.max(0, Math.min(1, prog / planned)) : 1;
  }
  if (Number.isFinite(tr.plannedLapTime)) return tr.completion;
  // point-to-point trajectories: planned arrival time / actual arrival time
  const arr = arrival(log, i);
  const planned = log.planned.arrival[i];
  if (Number.isFinite(arr.time) && arr.time > 0 && Number.isFinite(planned)) return Math.min(1, planned / arr.time);
  return arr.covered;
}

export function evaluateTrial(log: TrialLog, weights: Weights = EQUAL_WEIGHTS): TrialEvaluation {
  const isCourse = log.summary.gates.some((g) => g.attempted > 0);
  const tracking = log.drones.map((_, i) => trackingMetrics(log, i));
  const safety = safetyMetrics(log);
  const course = courseMetrics(log);
  const effort = effortMetrics(log);
  const perDrone = tracking.map((tr, i) => ({
    V: speedScore(log, i, tr),
    A: Number.isFinite(tr.rmse) ? Math.max(0, 1 - tr.rmse / 0.3) : 0,
    E: Number.isFinite(effort.ratio[i]) ? Math.min(1, effort.ratio[i]) : 0,
  }));
  const avg = (k: 'V' | 'A' | 'E') => perDrone.reduce((a, x) => a + x[k], 0) / Math.max(1, perDrone.length);
  const sub: SubScores = {
    S: 0.5 * (1 - safety.interventionRate + Math.min(1, Number.isFinite(safety.closestApproach) ? safety.closestApproach : 1)),
    V: avg('V'),
    A: avg('A'),
    E: avg('E'),
  };
  const gf = gateFactor(log, isCourse);
  return {
    tracking,
    safety,
    course,
    effort,
    perDrone,
    isCourse,
    scorecard: { G: gf.G, gateReason: gf.reason, sub, score: compositeScore(gf.G, sub, weights) },
  };
}

export interface ConditionScore {
  name: string;
  G: number;
  sub: SubScores;
}

/** Ranking of conditions (indices, best first) for the given weights. */
export function ranking(conds: ConditionScore[], w: Weights): number[] {
  return conds
    .map((c, i) => ({ i, s: compositeScore(c.G, c.sub, w) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.i);
}

/**
 * Ranking stability check: sample random weight vectors (flat Dirichlet, seeded) and report the
 * share for which the ranking equals the ranking under the reference weights.
 */
export function rankingStability(conds: ConditionScore[], ref: Weights = EQUAL_WEIGHTS, samples = 200, seed = 99): { share: number; reference: number[] } {
  const base = ranking(conds, ref);
  const rng = new Rng(seed);
  let same = 0;
  for (let k = 0; k < samples; k++) {
    const e = [0, 0, 0, 0].map(() => -Math.log(Math.max(1e-12, rng.next())));
    const w: Weights = { S: e[0], V: e[1], A: e[2], E: e[3] };
    const r = ranking(conds, w);
    if (r.every((x, i) => x === base[i])) same++;
  }
  return { share: same / samples, reference: base };
}
