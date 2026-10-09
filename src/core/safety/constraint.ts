/** A linear constraint on the commanded accelerations produced by a CBF. */
import type { Vec3 } from '../vec';

export interface LinearConstraint {
  /** Drone index. */
  i: number;
  /** Second drone for pair constraints, -1 for drone-obstacle constraints. */
  j: number;
  /** Pair:  a . (u_i - u_j) >= b.   Obstacle:  a . u_i >= b. */
  a: Vec3;
  b: number;
  kind: 'pair' | 'obstacle';
  /** Barrier value (h for the exponential CBF, h_b for the braking-aware CBF). */
  h: number;
  /** Time derivative of h (exponential CBF) for the initial-condition check. */
  hdot?: number;
  label?: string;
}
