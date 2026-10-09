/**
 * Pre-flight validator (Section 5.4). Runs before every trial; any blocking failure stops the run
 * and reports the reason.
 *
 *  1. time strictly increasing, sample period 0.02 s or finer (after time scaling)
 *  2. every point inside the arena minus a 0.3 m margin
 *  3. feasibility check passes (or the user explicitly allows "fly anyway, expect saturation")
 *  4. multi-drone runs: planned scaled separation never below 1 (metric M17). Reported as a
 *     warning, not a block: the point of Aim 2 is to watch the filter save it.
 *  5. start positions match the drones' configured start positions within 0.1 m
 */
import { ARENA_MARGIN, PRESETS } from './constants';
import { checkFeasibility, type FeasibilityResult } from './feasibility';
import { minPlannedSeparation } from './planned';
import { dronesFor, type ScenarioBuild } from './scenario';
import type { SimConfig } from './types';

export interface ValidationIssue {
  check: 1 | 2 | 3 | 4 | 5;
  level: 'error' | 'warning';
  drone?: number;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
  feasibility: FeasibilityResult[];
  plannedSeparation: { min: number; t: number; i: number; j: number } | null;
}

export const CHECK_NAMES: Record<number, string> = {
  1: 'Time base',
  2: 'Arena bounds',
  3: 'Feasibility',
  4: 'Planned separation',
  5: 'Start positions',
};

export function validate(cfg: SimConfig, b: ScenarioBuild): ValidationResult {
  const issues: ValidationIssue[] = [];
  const drones = dronesFor(cfg, b.trajectories.length);
  const { sx, sy, sz } = b.arena;
  const pure = cfg.system.pureDoubleIntegrator;
  const feasibility: FeasibilityResult[] = [];
  b.trajectories.forEach((tr, i) => {
    // 1. time base
    let increasing = true;
    let maxDt = 0;
    for (let k = 1; k < tr.t.length; k++) {
      const dt = tr.t[k] - tr.t[k - 1];
      if (!(dt > 0)) increasing = false;
      if (dt > maxDt) maxDt = dt;
    }
    if (!increasing) issues.push({ check: 1, level: 'error', drone: i, message: `Drone ${i + 1}: time is not strictly increasing.` });
    if (maxDt / b.k > 0.02 + 1e-9) issues.push({ check: 1, level: 'error', drone: i, message: `Drone ${i + 1}: sample period ${(1000 * maxDt / b.k).toFixed(1)} ms is coarser than 20 ms.` });
    // 2. arena
    let worst = -Infinity;
    let worstK = -1;
    for (let k = 0; k < tr.t.length; k++) {
      const ex = Math.max(Math.abs(tr.x[k]) - (sx / 2 - ARENA_MARGIN), Math.abs(tr.y[k]) - (sy / 2 - ARENA_MARGIN), ARENA_MARGIN - tr.z[k], tr.z[k] - (sz - ARENA_MARGIN));
      if (ex > worst) {
        worst = ex;
        worstK = k;
      }
    }
    if (worst > 1e-6 && !pure) {
      issues.push({
        check: 2,
        level: 'error',
        drone: i,
        message: `Drone ${i + 1}: leaves the arena minus ${ARENA_MARGIN} m by ${(worst * 100).toFixed(0)} cm at t = ${(tr.t[worstK] / b.k).toFixed(2)} s (${tr.x[worstK].toFixed(2)}, ${tr.y[worstK].toFixed(2)}, ${tr.z[worstK].toFixed(2)}).`,
      });
    }
    // 3. feasibility
    const twr = (PRESETS[drones[i].preset] ?? PRESETS.CF21).twr;
    const f = checkFeasibility(tr, b.k, twr, cfg.system.eta, cfg.system.thetaMaxDeg);
    feasibility.push(f);
    if (f.share > 0 && !pure) {
      issues.push({
        check: 3,
        level: cfg.flyAnyway ? 'warning' : 'error',
        drone: i,
        message: `Drone ${i + 1}: ${(f.share * 100).toFixed(1)}% of samples exceed the thrust budget (peak ${f.peakThrust.toFixed(1)} m/s² vs ${(cfg.system.eta * twr * 9.81).toFixed(1)} usable, tilt ${f.peakTiltDeg.toFixed(0)}°).${cfg.flyAnyway ? ' Flying anyway: expect saturation.' : ' Enable "fly anyway" to run regardless.'}`,
      });
    }
    // 5. start positions
    const st = drones[i].start;
    if (st) {
      const d = Math.hypot(st.x - tr.x[0], st.y - tr.y[0], st.z - tr.z[0]);
      if (d > 0.1) issues.push({ check: 5, level: 'error', drone: i, message: `Drone ${i + 1}: start position is ${(d * 100).toFixed(0)} cm from the trajectory start (limit 10 cm).` });
    }
  });
  // 4. planned separation
  let plannedSeparation: ValidationResult['plannedSeparation'] = null;
  if (b.trajectories.length > 1) {
    plannedSeparation = minPlannedSeparation(b.trajectories, b.k);
    if (plannedSeparation.min < 1) {
      issues.push({
        check: 4,
        level: 'warning',
        message: `Planned safety M17 = ${plannedSeparation.min.toFixed(2)} < 1 (drones ${plannedSeparation.i + 1} and ${plannedSeparation.j + 1} at t = ${plannedSeparation.t.toFixed(2)} s): the safety filter will have to intervene.`,
      });
    }
  }
  return { ok: !issues.some((x) => x.level === 'error'), issues, feasibility, plannedSeparation };
}
