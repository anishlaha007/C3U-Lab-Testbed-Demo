/**
 * Fast kinematic rollouts for payoff evaluation (Section 7.2). Candidates are open-loop
 * trajectories, so a rollout is just sampling them on a common time grid: each candidate's
 * positions and track progress are precomputed once; a pair rollout then only needs the scaled
 * separation per time step.
 */
import { pairD } from '../safety/ecbf';
import { sampleTrajectory } from '../trajectories/common';
import type { Trajectory } from '../types';
import type { Vec3 } from '../vec';
import { ProgressTracker, type Track } from './track';

export const ROLLOUT_DT = 0.05;

export interface CandidateSamples {
  /** Positions on the common time grid. */
  p: Vec3[];
  /** Progress along the shared track (m). */
  s: number[];
}

/** Sample a candidate on the grid t = 0, dt, ..., T and track its progress. */
export function sampleCandidate(traj: Trajectory, track: Track, T: number, dt = ROLLOUT_DT): CandidateSamples {
  const n = Math.floor(T / dt + 1e-9) + 1;
  const p: Vec3[] = [];
  const s: number[] = [];
  let tracker: ProgressTracker | null = null;
  for (let k = 0; k < n; k++) {
    const q = sampleTrajectory(traj, k * dt).p;
    p.push(q);
    if (!tracker) tracker = new ProgressTracker(track, q);
    s.push(tracker.update(q));
  }
  return { p, s };
}

export interface PairRollout {
  /** Progress gap s_1(T) - s_2(T) (m). */
  gap: number;
  /** Total progress s_1(T) + s_2(T). */
  total: number;
  /** Time with scaled separation below 1 (s). */
  risk: number;
  /** Violation time attributed to drone 1 / drone 2 when the follower is responsible. */
  riskFollower1: number;
  riskFollower2: number;
  minS: number;
}

const D1 = pairD(1);

export function rolloutPair(a: CandidateSamples, b: CandidateSamples, dt = ROLLOUT_DT, margin = 1): PairRollout {
  const n = Math.min(a.p.length, b.p.length);
  let risk = 0;
  let r1 = 0;
  let r2 = 0;
  let minS = Infinity;
  for (let k = 0; k < n; k++) {
    const pa = a.p[k];
    const pb = b.p[k];
    const dx = pa.x - pb.x;
    const dy = pa.y - pb.y;
    const dz = pa.z - pb.z;
    const s = Math.sqrt(dx * dx * D1.x + dy * dy * D1.y + dz * dz * D1.z);
    if (s < minS) minS = s;
    if (s < margin) {
      risk += dt;
      // the drone behind (less progress) is the follower
      if (a.s[k] < b.s[k]) r1 += dt;
      else if (b.s[k] < a.s[k]) r2 += dt;
      else {
        r1 += dt / 2;
        r2 += dt / 2;
      }
    }
  }
  const s1 = a.s[n - 1];
  const s2 = b.s[n - 1];
  return { gap: s1 - s2, total: s1 + s2, risk, riskFollower1: r1, riskFollower2: r2, minS };
}
