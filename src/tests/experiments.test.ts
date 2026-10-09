import { describe, expect, it } from 'vitest';
import {
  buildExperiment,
  runTrialSpec,
  summariseRaceSeries,
  summariseSpeedSweep,
  type ExperimentKind,
  type TrialRecord,
} from '../core/experiments';
import { EQUAL_WEIGHTS } from '../core/metrics/scorecard';

describe('experiment specs (Section 12)', () => {
  const count = (kind: ExperimentKind, quick: boolean, extra = {}) => buildExperiment(kind, { quick, seed: 1, ...extra }).length;

  it('full trial counts follow the spec', () => {
    // M1: 5 speed levels x 5 trials; extended adds 2 levels
    expect(count('m1-speed', false)).toBe(25);
    expect(count('m1-speed', false, { extended: true })).toBe(35);
    // M1 comparisons: 2 levels x 3 conditions x 5 trials
    expect(count('m1-compare', false)).toBe(30);
    // M2: 3 speeds x 3 margins x comp on/off x 2 filter types x 5 trials
    expect(count('m2-safety', false)).toBe(180);
    // M3: 4 scenarios x 4 conditions x 30 races; hard courses add 2 scenarios
    expect(count('m3-series', false)).toBe(480);
    expect(count('m3-series', false, { hardCourses: true })).toBe(720);
  });

  it('quick mode cuts the counts', () => {
    expect(count('m1-speed', true)).toBe(15);
    expect(count('m3-series', true)).toBe(160);
  });

  it('race series alternates start positions and varies seeds', () => {
    const specs = buildExperiment('m3-series', { quick: true, seed: 5 }).filter((s) => s.group.scenario === 'T9 Race loop' && s.group.condition === 'Nash');
    expect(specs.map((s) => s.config.planner.swapStarts)).toEqual(specs.map((_, k) => k % 2 === 1));
    expect(new Set(specs.map((s) => s.config.seed)).size).toBe(specs.length);
  });
});

describe('trial records', () => {
  const specs = buildExperiment('m1-speed', { quick: true, seed: 3 }).filter((s) => s.group.w === 0.522 || s.group.w === 1.54);

  it('runTrialSpec is deterministic and order-independent', () => {
    const a = specs.map((s) => runTrialSpec(s));
    const b = [...specs].reverse().map((s) => runTrialSpec(s)).reverse();
    expect(a.map((r) => r.rmse[0])).toEqual(b.map((r) => r.rmse[0]));
    expect(a.every((r) => !r.error && r.endReason === 'completed')).toBe(true);
    const sweep = summariseSpeedSweep(a);
    expect(sweep.rows.map((r) => r.w)).toEqual([0.522, 1.54]);
    // baseline under the 2 cm Crazyswarm figure, the eta limit level clearly worse
    expect(sweep.rows[0].rmse.mean).toBeLessThan(0.02);
    expect(sweep.rows[1].rmse.mean).toBeGreaterThan(sweep.rows[0].rmse.mean);
    expect(sweep.rows[0].rmse.lo).toBeLessThanOrEqual(sweep.rows[0].rmse.mean);
    expect(sweep.rows[0].rmse.hi).toBeGreaterThanOrEqual(sweep.rows[0].rmse.mean);
  });
});

/** Synthetic race record for the aggregation tests. */
function raceRecord(condition: string, k: number, winner: number, gap: number): TrialRecord {
  return {
    id: `${condition}-${k}`,
    kind: 'm3-series',
    group: { scenario: 'S', condition, race: k },
    seed: k,
    endReason: 'completed',
    rmse: [0.1, 0.1],
    along: [0, 0],
    cross: [0, 0],
    meanSpeed: [1, 1],
    lapTime: [5, 5],
    completion: [1, 1],
    feasibilityFail: [0, 0],
    collisions: 0,
    minS: 1.2,
    minD: 0.3,
    violationTime: 0,
    interventionRate: 0.1,
    interventionSize: 1,
    solveP99: 0.1,
    obstacleIntRate: 0,
    pairIntRate: 0.1,
    clearance: 0.2,
    passRate: 1,
    strikes: 0,
    misses: 0,
    emergencies: 0,
    G: 1,
    gateReason: 'clean',
    sub: { S: 0.9, V: winner === 0 ? 0.95 : 0.85, A: 0.7, E: 0.9 },
    score: 0.85,
    rmseMean: 0.1,
    race: { winner, gap, overtakes: 0, predictedWinner: 0, predictedGap: 1, realisedGapAtHorizon: gap, crashed: [false, false] },
    wallMs: 1,
  };
}

describe('race series statistics', () => {
  it('Wilson win rates, Holm-corrected tests and statements', () => {
    const recs: TrialRecord[] = [];
    // Nash: A wins 28 of 30; Independent: A wins 15 of 30
    for (let k = 0; k < 30; k++) recs.push(raceRecord('Nash', k, k < 28 ? 0 : 1, k < 28 ? 0.8 : -0.2));
    for (let k = 0; k < 30; k++) recs.push(raceRecord('Independent', k, k % 2, k % 2 ? -0.3 : 0.3));
    const s = summariseRaceSeries(recs, EQUAL_WEIGHTS);
    const nash = s.rows.find((r) => r.condition === 'Nash')!;
    const ind = s.rows.find((r) => r.condition === 'Independent')!;
    expect(nash.winsA).toBe(28);
    expect(nash.winRateA.lo).toBeGreaterThan(0.7);
    expect(ind.winRateA.lo).toBeLessThan(0.5);
    expect(ind.winRateA.hi).toBeGreaterThan(0.5);
    expect(nash.binomialP).toBeLessThan(0.001);
    expect(ind.binomialP).toBeGreaterThan(0.5);
    // prediction: predicted winner A, so correct exactly when A won
    expect(nash.predictionCorrect).toBe(28);
    // one pair of conditions x 3 metrics, Holm-adjusted p >= raw p
    expect(s.tests).toHaveLength(3);
    for (const t of s.tests) expect(t.pHolm).toBeGreaterThanOrEqual(t.p);
    const win = s.tests.find((t) => t.metric === 'win rate A')!;
    expect(win.significant).toBe(true);
    expect(s.statements.some((x) => x.includes('win rate'))).toBe(true);
    // identical intervention rates cannot be significant
    expect(s.tests.find((t) => t.metric === 'intervention rate')!.significant).toBe(false);
    expect(s.stability[0].share).toBeGreaterThan(0);
  });

  it('reports when nothing is supported', () => {
    const recs: TrialRecord[] = [];
    for (let k = 0; k < 10; k++) recs.push(raceRecord('Nash', k, k % 2, 0));
    for (let k = 0; k < 10; k++) recs.push(raceRecord('Independent', k, (k + 1) % 2, 0));
    const s = summariseRaceSeries(recs);
    expect(s.tests.every((t) => !t.significant)).toBe(true);
    expect(s.statements[0]).toMatch(/No difference/);
  });
});
