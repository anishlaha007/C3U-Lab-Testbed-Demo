/** Regression tests for defects found by the adversarial core review (see DECISIONS.md). */
import { describe, expect, it } from 'vitest';
import { parseTrajectoryCsv } from '../core/csv';
import { defaultConfig } from '../core/defaults';
import { G } from '../core/constants';
import { plannedEffort } from '../core/planned';
import { solvePlan } from '../core/planners/plan';
import { presetConfig } from '../core/presets';
import { runSafetyFilter, type FilterDrone } from '../core/safety/filter';
import { hashTrialLog, runTrial } from '../core/sim';
import { trajDuration } from '../core/trajectories/common';
import { v3 } from '../core/vec';

describe('safety filter with supervised drones', () => {
  it('a braking drone stays in the pair constraint as a fixed-input obstacle', () => {
    const cfg = defaultConfig().filter;
    const brake = v3(-5, 0, 0);
    const drones: FilterDrone[] = [
      // active drone flying at the braking one, nominal input pushing on
      { p: v3(0, 0, 1), v: v3(2, 0, 0), uNom: v3(1, 0, 0), twr: 1.8, active: true, progress: NaN },
      { p: v3(0.6, 0, 1), v: v3(-0.5, 0, 0), uNom: brake, twr: 1.8, active: false, present: true, progress: NaN },
    ];
    const r = runSafetyFilter(drones, [], { cfg, eta: 0.7, thetaMax: Math.PI / 3 });
    expect(r.nConstraints).toBe(1);
    expect(Number.isFinite(r.pairH[0])).toBe(true);
    // the active drone brakes; the supervised one keeps its own input
    expect(r.uSafe[0].x).toBeLessThan(0);
    expect(r.uSafe[1]).toEqual(brake);
    expect(r.intervened[1]).toBe(false);
  });

  it('two supervised drones get no constraint (nothing to correct)', () => {
    const cfg = defaultConfig().filter;
    const d = (x: number): FilterDrone => ({ p: v3(x, 0, 1), v: v3(), uNom: v3(), twr: 1.8, active: false, present: true, progress: NaN });
    expect(runSafetyFilter([d(0), d(0.5)], [], { cfg, eta: 0.7, thetaMax: Math.PI / 3 }).nConstraints).toBe(0);
  });
});

describe('scoring windows', () => {
  it('planned effort holds hover until the end of the race window', () => {
    const tr = solvePlan(presetConfig('T9', 1)).trajectories[0];
    const T = trajDuration(tr);
    expect(plannedEffort(tr, 1, T + 2) - plannedEffort(tr, 1)).toBeCloseTo(2 * G, 6);
    expect(plannedEffort(tr, 1, T - 1)).toBeCloseTo(plannedEffort(tr, 1), 9);
  });

  it('a ring-course run reports its own planned finish and scheduled visits', () => {
    const c = presetConfig('T12', 1);
    const plan = solvePlan(c);
    const log = runTrial(c, { trajectories: plan.trajectories, prediction: plan.prediction });
    expect(log.planned.finish?.every((f) => Number.isFinite(f) && f > 0 && f < log.planned.duration)).toBe(true);
    for (const g of log.summary.gates) expect(g.scheduled).toBe(6);
    // prediction horizon in race time (k = 1 here, so unchanged)
    expect(log.planned.predictionHorizon).toBeCloseTo(plan.prediction.horizon, 9);
  });
});

describe('re-planning', () => {
  it('re-plans start on the right branch of the self-crossing C9 circuit', () => {
    const c = presetConfig('T12', 1);
    c.planner.replan = true;
    const plan = solvePlan(c);
    const log = runTrial(c, { trajectories: plan.trajectories, prediction: plan.prediction });
    expect(log.summary.replans).toBeGreaterThan(0);
    expect(log.summary.gates.every((g) => g.misses === 0 && g.passes === 6)).toBe(true);
  });

  it('runs with re-planning hash identically (wall-clock solve times excluded)', () => {
    const c = presetConfig('T9', 1);
    c.planner.replan = true;
    const plan = solvePlan(c);
    const a = runTrial(c, { trajectories: plan.trajectories, prediction: plan.prediction });
    const b = runTrial(c, { trajectories: plan.trajectories, prediction: plan.prediction });
    expect(hashTrialLog(a)).toBe(hashTrialLog(b));
  });
});

describe('CSV import rejects malformed cells', () => {
  const csv = (rows: string[]) => ['t,x,y,z', ...rows].join('\n');
  const good = Array.from({ length: 20 }, (_, i) => `${(i * 0.01).toFixed(2)},${(i * 0.01).toFixed(3)},0,1`);
  it('non-numeric and empty cells, time going backwards', () => {
    expect(() => parseTrajectoryCsv(csv(good))).not.toThrow();
    const nan = good.slice();
    nan[5] = '0.05,nan,0,1';
    expect(() => parseTrajectoryCsv(csv(nan))).toThrow(/column "x"/);
    const empty = good.slice();
    empty[5] = '0.05,,0,1';
    expect(() => parseTrajectoryCsv(csv(empty))).toThrow(/not a finite number/);
    const back = good.slice();
    back[6] = '0.04,0.06,0,1';
    expect(() => parseTrajectoryCsv(csv(back))).toThrow(/strictly increase/);
  });
});
