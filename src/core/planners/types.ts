/** Types shared by the game-theoretic planners (Section 7). */
import type { SolverType, Trajectory } from '../types';
import type { Vec3 } from '../vec';

export interface Candidate {
  index: number;
  /** Lateral offset control points (fractions of the half-width, in {-1, -0.5, 0, 0.5, 1}). */
  lateral: number[];
  /** Vertical offset control points (fractions of the half-height). */
  vertical: number[];
  /** Speed level (fraction of the feasible maximum, 0.8 .. 1.0). */
  speed: number;
  /** Time-scale applied to make the candidate feasible (<= 1). */
  feasibilityScale: number;
  label: string;
  /** Planned lap / course time (s). */
  duration: number;
  /** Downsampled path for previews (core frame). */
  preview: Vec3[];
  /** Discarded (hits an obstacle or misses a gate). */
  valid: boolean;
}

export interface GameMatrix {
  /** payoff1[i][j]: drone 1 plays candidate i, drone 2 plays candidate j. */
  payoff1: number[][];
  payoff2: number[][];
  /** Progress gap s1(T) - s2(T) per cell (m). */
  gap: number[][];
  /** Collision risk (s of violation) per cell. */
  risk: number[][];
  /** Best responses: br1[j] = drone 1's best reply to drone 2's j; br2[i] = drone 2's best reply to i. */
  br1: number[];
  br2: number[];
  /** Pure Nash equilibria (i, j). */
  nash: [number, number][];
  /** Stackelberg picks per leader (drone 0 leads / drone 1 leads). */
  stackelberg: { leader: number; i: number; j: number }[];
  horizon: number;
}

export interface PlanResult {
  solver: SolverType;
  leader: number;
  /** Selected candidate per drone. */
  choice: number[];
  trajectories: Trajectory[];
  candidates: Candidate[][];
  game: GameMatrix | null;
  prediction: { gap: number; winner: number };
  solveMs: number;
  note: string;
  trackId: string;
}
