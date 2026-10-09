/** Racing metrics M18-M21 (Section 9). Per-race quantities; win rates are aggregated in stats. */
import type { TrialLog } from '../types';
import { windowLength } from './window';

export interface RaceResult {
  /** Winner (drone index) or -1 for no winner (both crashed). */
  winner: number;
  /** M19 final progress gap s_ego - s_opponent at race end (m), ego = drone 0. */
  gap: number;
  /** M21 overtakes (sign changes of s_1 - s_2). */
  overtakes: number;
  /** Progress per drone at race end (m). */
  progress: number[];
  predictedWinner?: number;
  predictedGap?: number;
  /** M20 per race: predicted winner won. */
  predictionCorrect?: boolean;
  crashed: boolean[];
}

export function lastProgress(log: TrialLog, i: number): number {
  const n = windowLength(log);
  const p = log.drones[i].progress;
  for (let k = Math.min(n, p.length) - 1; k >= 0; k--) if (Number.isFinite(p[k])) return p[k];
  return NaN;
}

export function raceResult(log: TrialLog): RaceResult {
  const nd = log.drones.length;
  const n = windowLength(log);
  const progress = log.drones.map((_, i) => lastProgress(log, i));
  const crashed = log.drones.map((d) => d.mode.slice(0, Math.max(1, n)).some((m) => m >= 3) || d.mode[d.mode.length - 1] >= 3);
  // ring courses: first to finish wins; otherwise largest progress among non-crashed drones
  let winner = -1;
  const fin = log.summary.gates.map((g) => g.finishTime);
  if (fin.length && fin.some((f) => Number.isFinite(f))) {
    let best = Infinity;
    fin.forEach((f, i) => {
      if (Number.isFinite(f) && f < best && !crashed[i]) {
        best = f;
        winner = i;
      }
    });
  }
  if (winner < 0) {
    let best = -Infinity;
    for (let i = 0; i < nd; i++) {
      if (crashed[i]) continue;
      const p = Number.isFinite(progress[i]) ? progress[i] : 0;
      if (p > best) {
        best = p;
        winner = i;
      }
    }
  }
  // overtakes: sign changes of s_0 - s_1 with 5 cm hysteresis
  let overtakes = 0;
  if (nd >= 2) {
    let sgn = 0;
    const a = log.drones[0].progress;
    const b = log.drones[1].progress;
    for (let k = 0; k < n; k++) {
      const g = a[k] - b[k];
      if (!Number.isFinite(g)) continue;
      const s = g > 0.05 ? 1 : g < -0.05 ? -1 : 0;
      if (s !== 0) {
        if (sgn !== 0 && s !== sgn) overtakes++;
        sgn = s;
      }
    }
  }
  const gap = nd >= 2 ? progress[0] - progress[1] : NaN;
  const pw = log.planned.predictedWinner;
  return {
    winner,
    gap,
    overtakes,
    progress,
    predictedWinner: pw,
    predictedGap: log.planned.predictedGap,
    predictionCorrect: pw !== undefined ? pw === winner : undefined,
    crashed,
  };
}
