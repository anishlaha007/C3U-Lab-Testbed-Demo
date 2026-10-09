import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../core/defaults';
import { evaluateTrial } from '../core/metrics/scorecard';
import { hashTrialLog, runTrial } from '../core/sim';

function twoDroneIntersection(seed: number) {
  const c = defaultConfig();
  c.seed = seed;
  c.drones = [c.drones[0], { ...c.drones[0], color: '#f472b6' }];
  c.scenario.type = 'intersection';
  c.scenario.w = 0.78;
  c.scenario.laps = 1;
  c.system.windSigma = 0.3;
  c.system.markerSwap = true;
  return c;
}

describe('determinism', () => {
  it('same seed and config -> identical TrialLog hash', () => {
    const a = runTrial(twoDroneIntersection(42));
    const b = runTrial(twoDroneIntersection(42));
    expect(hashTrialLog(a)).toBe(hashTrialLog(b));
    expect(a.t.length).toBeGreaterThan(100);
  });
  it('a different seed changes the log', () => {
    const a = runTrial(twoDroneIntersection(42));
    const b = runTrial(twoDroneIntersection(43));
    expect(hashTrialLog(a)).not.toBe(hashTrialLog(b));
  });
});

describe('simulation behaviour', () => {
  it('T1 baseline figure-8 tracks within about 2 cm (streamed, 25 ms)', () => {
    const c = defaultConfig();
    const ev = evaluateTrial(runTrial(c));
    expect(ev.tracking[0].rmse).toBeLessThan(0.02);
    expect(ev.tracking[0].completion).toBe(1);
    expect(ev.scorecard.G).toBe(1);
  });
  it('uploaded mode removes the latency cost; PID-like baseline (no feed-forward) is worse', () => {
    const up = defaultConfig();
    up.system.mode = 'uploaded';
    const pid = defaultConfig();
    pid.system.controller = 'pid';
    const base = evaluateTrial(runTrial(defaultConfig())).tracking[0].rmse;
    expect(evaluateTrial(runTrial(up)).tracking[0].rmse).toBeLessThan(base / 2);
    expect(evaluateTrial(runTrial(pid)).tracking[0].rmse).toBeGreaterThan(base * 2);
  });
  it('T5 intersection: collision without the filter, safe with it', () => {
    const off = twoDroneIntersection(1);
    off.filter.enabled = false;
    off.system.windSigma = 0;
    off.system.markerSwap = false;
    const logOff = runTrial(off);
    expect(logOff.summary.collisions).toBeGreaterThan(0);
    expect(evaluateTrial(logOff).scorecard.G).toBe(0);
    const on = twoDroneIntersection(1);
    on.system.windSigma = 0;
    on.system.markerSwap = false;
    const logOn = runTrial(on);
    expect(logOn.summary.collisions).toBe(0);
    expect(logOn.summary.minScaledSeparation).toBeGreaterThanOrEqual(1);
    expect(evaluateTrial(logOn).safety.interventionRate).toBeGreaterThan(0);
  });
  it('T7 antipodal swap with 6 drones: N-drone QP keeps everyone apart', () => {
    const c = defaultConfig();
    c.drones = Array.from({ length: 6 }, (_, i) => ({ ...c.drones[0], color: `#${i}${i}${i}` }));
    c.scenario.type = 'antipodal';
    c.scenario.targetSpeed = 1.5;
    const log = runTrial(c);
    expect(log.summary.collisions).toBe(0);
    expect(log.summary.minScaledSeparation).toBeGreaterThanOrEqual(1);
  });
});
