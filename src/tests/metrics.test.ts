/** Unit tests of M1-M22 on small synthetic logs with hand-computed answers. */
import { describe, expect, it } from 'vitest';
import { effortMetrics } from '../core/metrics/effort';
import { raceResult } from '../core/metrics/racing';
import { costOfSafety, courseMetrics, safetyMetrics } from '../core/metrics/safety';
import { evaluateTrial } from '../core/metrics/scorecard';
import { trackingMetrics } from '../core/metrics/tracking';
import type { DroneLog, TrialLog } from '../core/types';

function droneLog(n: number, f: (k: number) => Partial<Record<keyof DroneLog, number>>): DroneLog {
  const keys: (keyof DroneLog)[] = ['px', 'py', 'pz', 'vx', 'vy', 'vz', 'rx', 'ry', 'rz', 'rvx', 'rvy', 'rvz', 'fx', 'fy', 'fz', 'unx', 'uny', 'unz', 'usx', 'usy', 'usz', 'thx', 'thy', 'thz', 'intervened', 'obsIntervened', 'pairIntervened', 'correction', 'progress', 'twr', 'mode'];
  const o = {} as DroneLog;
  for (const k of keys) o[k] = [];
  for (let i = 0; i < n; i++) {
    const v = f(i);
    for (const k of keys) o[k].push(v[k] ?? 0);
  }
  return o;
}

function baseLog(drones: DroneLog[], n: number, dt = 0.02): TrialLog {
  return {
    seed: 1,
    configHash: 'x',
    nDrones: drones.length,
    dtLog: dt,
    t: Array.from({ length: n }, (_, k) => k * dt),
    drones,
    pairs: [],
    solveMs: Array.from({ length: n }, (_, k) => (k + 1) * 0.01),
    clipped: new Array(n).fill(0),
    events: [],
    summary: {
      endReason: 'completed',
      endTime: n * dt,
      raceEnd: (n - 1) * dt,
      minCentreDistance: 0.5,
      minScaledSeparation: 1.4,
      violationTime: 0,
      collisions: 0,
      emergencies: 0,
      geofenceEvents: 0,
      arenaExits: 0,
      staleEvents: 0,
      viconJumps: 0,
      killed: false,
      peakBraking: drones.map(() => 0),
      obstacleClearance: 0.3,
      gates: drones.map(() => ({ passes: 0, misses: 0, strikes: 0, attempted: 0, finishTime: NaN, passTimes: [] })),
      measuredLatency: 0.025,
      lapTimes: drones.map(() => [4.2]),
      lapsCompleted: drones.map(() => 1),
      pathLength: drones.map(() => 10),
      effort: drones.map(() => 20),
      ecbfInitWarnings: 0,
      clippedTicks: 0,
      ctrlTicks: n,
      replans: 0,
      replanMsMax: 0,
    },
    planned: { lapTime: drones.map(() => 4.0), laps: drones.map(() => 1), arrival: drones.map(() => NaN), effort: drones.map(() => 18), feasibilityFail: drones.map(() => 0.1), minPlannedSeparation: 0.8, duration: (n - 1) * dt, lineLength: 8 },
    trackLength: NaN,
  };
}

describe('tracking metrics M1-M9', () => {
  // reference moves along +x at 1 m/s; error alternates (0.03, 0.04, 0) and (0, 0, 0)
  const n = 4;
  const errs = [
    [0.03, 0.04, 0],
    [0, 0, 0],
    [0.03, 0.04, 0],
    [0, 0, 0],
  ];
  const d = droneLog(n, (k) => ({ rx: k * 0.02, rvx: 1, px: k * 0.02 + errs[k][0], py: errs[k][1], vx: k === 1 ? 2 : 1, twr: 1.8 }));
  const log = baseLog([d], n);
  const m = trackingMetrics(log, 0);
  it('M1 RMSE = sqrt(mean |e|^2) = sqrt((0.0025 + 0 + 0.0025 + 0) / 4) = 0.0354', () => expect(m.rmse).toBeCloseTo(Math.sqrt(0.0025 / 2), 9));
  it('M2 max error = 0.05', () => expect(m.maxError).toBeCloseTo(0.05, 9));
  it('M3 along-track RMS: e_along = 0.03 on two of four samples', () => expect(m.alongRms).toBeCloseTo(Math.sqrt((2 * 0.0009) / 4), 9));
  it('M4 cross-track RMS: e_cross = 0.04 on two of four samples', () => expect(m.crossRms).toBeCloseTo(Math.sqrt((2 * 0.0016) / 4), 9));
  it('M5 lap time and planned lap', () => {
    expect(m.lapTime).toBe(4.2);
    expect(m.plannedLapTime).toBe(4.0);
  });
  it('M6 mean and peak speed', () => {
    expect(m.meanSpeed).toBeCloseTo(1.25, 9);
    expect(m.peakSpeed).toBe(2);
  });
  it('M7 latency (measured) is carried in the summary', () => expect(log.summary.measuredLatency).toBe(0.025));
  it('M8 completion = 1 lap of 1', () => expect(m.completion).toBe(1));
  it('M9 feasibility share from the plan', () => expect(m.feasibilityFail).toBe(0.1));
});

describe('safety metrics M10-M17', () => {
  const n = 5;
  const a = droneLog(n, (k) => ({ intervened: k === 1 || k === 2 ? 1 : 0, correction: k === 1 ? 1 : k === 2 ? 3 : 0, pairIntervened: k === 1 ? 1 : 0, obsIntervened: k === 2 ? 1 : 0 }));
  const b = droneLog(n, (k) => ({ intervened: k === 2 ? 1 : 0, correction: k === 2 ? 2 : 0 }));
  const log = baseLog([a, b], n);
  log.summary.collisions = 1;
  log.summary.violationTime = 0.12;
  const s = safetyMetrics(log);
  it('M10 collisions', () => expect(s.collisions).toBe(1));
  it('M11 closest approach', () => expect(s.closestApproach).toBe(1.4));
  it('M12 violation time', () => expect(s.violationTime).toBe(0.12));
  it('M13 intervention rate = 2 of 5 ticks', () => expect(s.interventionRate).toBeCloseTo(0.4, 9));
  it('M14 intervention size = mean(1, 3, 2) = 2', () => expect(s.interventionSize).toBeCloseTo(2, 9));
  it('M15 cost of safety = multi - solo RMSE', () => expect(costOfSafety([0.05, 0.07], [0.02, 0.02])).toEqual([0.05 - 0.02, 0.07 - 0.02]));
  it('M16 99th percentile solve time', () => expect(s.solveP99).toBeCloseTo(0.01 + 0.99 * 0.04, 9));
  it('M17 planned safety', () => expect(s.plannedSafety).toBe(0.8));
  it('M26 obstacle interventions = 1 of 5 ticks; pair interventions 1 of 5', () => {
    expect(s.obstacleInterventionRate).toBeCloseTo(0.2, 9);
    expect(s.pairInterventionRate).toBeCloseTo(0.2, 9);
  });
});

describe('racing metrics M18-M21 and effort M22', () => {
  const n = 6;
  // progress gap: +0.2, +0.1, -0.1, -0.2, +0.3, +0.4 -> two sign changes
  const p1 = [1, 2, 3, 4, 5, 6];
  const gaps = [0.2, 0.1, -0.1, -0.2, 0.3, 0.4];
  const a = droneLog(n, (k) => ({ progress: p1[k] }));
  const b = droneLog(n, (k) => ({ progress: p1[k] - gaps[k] }));
  const log = baseLog([a, b], n);
  log.planned.predictedWinner = 0;
  log.planned.predictedGap = 0.5;
  const r = raceResult(log);
  it('M19 final progress gap', () => expect(r.gap).toBeCloseTo(0.4, 9));
  it('M21 overtakes = 2', () => expect(r.overtakes).toBe(2));
  it('winner and M20 prediction correctness', () => {
    expect(r.winner).toBe(0);
    expect(r.predictionCorrect).toBe(true);
  });
  it('M22 effort and planned/actual ratio', () => {
    const e = effortMetrics(log);
    expect(e.actual).toEqual([20, 20]);
    expect(e.ratio[0]).toBeCloseTo(0.9, 9);
  });
  it('course metrics M23-M27', () => {
    log.summary.gates = [
      { passes: 5, misses: 1, strikes: 0, attempted: 6, finishTime: NaN, passTimes: [] },
      { passes: 6, misses: 0, strikes: 0, attempted: 6, finishTime: 9.5, passTimes: [] },
    ];
    const c = courseMetrics(log);
    expect(c.passRate).toBeCloseTo(11 / 12, 9);
    expect(c.misses).toBe(1);
    expect(c.obstacleClearance).toBe(0.3);
    expect(c.courseTime[1]).toBe(9.5);
    expect(c.pathRatio[0]).toBeCloseTo(10 / 8, 9);
    // a missed gate gates the score to zero
    expect(evaluateTrial(log).scorecard.G).toBe(0);
  });
});
