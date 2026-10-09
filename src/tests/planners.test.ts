import { describe, expect, it } from 'vitest';
import { candidateSpecs } from '../core/planners/candidates';
import { bestResponses, iteratedBestResponse, pureNash, stackelberg, tieBreakNash } from '../core/planners/game';
import { planKey, solvePlan } from '../core/planners/plan';
import { makeTrack, ProgressTracker } from '../core/planners/track';
import { presetConfig } from '../core/presets';
import { v3 } from '../core/vec';

// Chicken: strategies 0 = swerve, 1 = straight. Two pure equilibria (0,1) and (1,0).
const p1 = [
  [0, -1],
  [1, -10],
];
const p2 = [
  [0, 1],
  [-1, -10],
];
const all = [true, true];

describe('game solvers', () => {
  it('finds both pure Nash equilibria of Chicken', () => {
    const eq = pureNash(p1, p2, all, all).map((c) => c.join(','));
    expect(eq.sort()).toEqual(['0,1', '1,0']);
  });
  it('best responses', () => {
    const { br1, br2 } = bestResponses(p1, p2, all, all);
    expect(br1).toEqual([1, 0]); // vs swerve go straight, vs straight swerve
    expect(br2).toEqual([1, 0]);
  });
  it('Stackelberg: the leader commits to straight and the follower swerves', () => {
    expect(stackelberg(p1, p2, all, all, 0)).toEqual([1, 0]);
    expect(stackelberg(p1, p2, all, all, 1)).toEqual([0, 1]);
  });
  it('tie-break rules pick among equilibria', () => {
    const total = [
      [0, 0],
      [0, -20],
    ];
    expect(tieBreakNash([[0, 1], [1, 0]], { payoff1: p1, total }, 'ego')).toEqual([1, 0]);
  });
  it('iterated best response cycles on matching pennies (no pure equilibrium)', () => {
    const a = [
      [1, -1],
      [-1, 1],
    ];
    const b = a.map((r) => r.map((x) => -x));
    expect(pureNash(a, b, all, all)).toEqual([]);
    expect(iteratedBestResponse(a, b, all, all, [0, 0], 50).converged).toBe(false);
  });
  it('invalid strategies are never chosen', () => {
    const eq = pureNash(p1, p2, [true, false], all);
    expect(eq.every(([i]) => i === 0)).toBe(true);
  });
});

describe('candidates and track', () => {
  it('candidate set of size M always contains the centreline at full speed first', () => {
    const s = candidateSpecs(30, 4);
    expect(s.length).toBe(30);
    expect(s[0]).toEqual({ lateral: [0, 0, 0, 0], vertical: [], speed: 1 });
    expect(new Set(s.map((c) => JSON.stringify(c))).size).toBe(30);
  });
  it('progress wraps laps on a closed track', () => {
    const pts = Array.from({ length: 200 }, (_, k) => v3(Math.cos((2 * Math.PI * k) / 200), Math.sin((2 * Math.PI * k) / 200), 1));
    const tr = makeTrack(pts, { closed: true });
    const pt = new ProgressTracker(tr, v3(1, 0, 1));
    let last = 0;
    for (let k = 1; k <= 300; k++) {
      const a = (2 * Math.PI * k) / 200;
      last = pt.update(v3(Math.cos(a), Math.sin(a), 1));
    }
    expect(last).toBeCloseTo(tr.length * 1.5, 1);
  });
});

describe('planned races (simplified stand-ins for the lab solvers)', () => {
  it('pinch: Stackelberg with A leading predicts A first, with B leading predicts B first', () => {
    const a = presetConfig('T4', 3);
    a.planner.solver = 'stackelberg';
    a.planner.leader = 0;
    const b = presetConfig('T4', 3);
    b.planner.solver = 'stackelberg';
    b.planner.leader = 1;
    const pa = solvePlan(a);
    const pb = solvePlan(b);
    expect(pa.prediction.winner).toBe(0);
    expect(pb.prediction.winner).toBe(1);
    expect(pa.game?.payoff1.length).toBe(a.planner.M);
    expect(pa.candidates[0][pa.choice[0]].valid).toBe(true);
    expect(pa.key).toBe(planKey(a));
    expect(planKey(a)).not.toBe(planKey(b));
  });
  it('plans are deterministic for a seed', () => {
    const c = presetConfig('T9', 5);
    expect(solvePlan(c).choice).toEqual(solvePlan(c).choice);
  });
});
