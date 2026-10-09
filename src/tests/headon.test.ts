/**
 * Section 13 head-on preliminary results, pure double-integrator mode (acceleration lag off,
 * onboard controller bypassed, 50 Hz, acceleration limit 7.5 m/s^2, pure command delay,
 * zero nominal input). Match within 10%.
 */
import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../core/defaults';
import { runTrial } from '../core/sim';
import type { FilterType } from '../core/types';

function headon(opts: { type: FilterType; gain: number; v: number; gap: number; latency: number; comp: boolean; disc?: 'reference' | 'exact' }) {
  const c = defaultConfig();
  c.drones = [c.drones[0], { ...c.drones[0], color: '#f472b6' }];
  c.scenario.type = 'headon';
  c.scenario.headonCoast = true;
  c.scenario.headonSpeed = opts.v;
  c.scenario.headonGap = opts.gap;
  c.system.pureDoubleIntegrator = true;
  c.system.pureDiscretization = opts.disc ?? 'reference';
  c.system.fCtrl = 50;
  c.system.totalLatency = opts.latency;
  c.system.pureAccelLimit = 7.5;
  c.filter.type = opts.type;
  c.filter.lambda = opts.gain;
  c.filter.alpha = opts.gain;
  c.filter.latencyCompensation = opts.comp;
  c.filter.obstacles = false;
  c.filter.emergencyBrake = false;
  const log = runTrial(c);
  return { closest: log.summary.minCentreDistance, peak: Math.max(...log.summary.peakBraking) };
}

const within = (x: number, target: number, rel = 0.1) => Math.abs(x - target) <= rel * target;

describe('head-on preliminary results (pure double integrator, 50 Hz)', () => {
  it('ECBF lambda = 4, 2 m/s each, 1.5 m gap, 0 ms -> ~0.224 m (unsafe)', () => {
    const r = headon({ type: 'ecbf', gain: 4, v: 2, gap: 1.5, latency: 0, comp: false });
    expect(within(r.closest, 0.224)).toBe(true);
    expect(r.closest).toBeLessThan(0.24);
  });

  it('ECBF lambda = 8, 3 m/s each, 2.5 m gap, 50 ms -> ~0.240 m, peak braking ~7.1 m/s^2', () => {
    const r = headon({ type: 'ecbf', gain: 8, v: 3, gap: 2.5, latency: 0.05, comp: false });
    expect(within(r.closest, 0.24)).toBe(true);
    expect(within(r.peak, 7.1)).toBe(true);
  });

  it('ECBF lambda = 12, same case -> ~0.183 m (unsafe)', () => {
    const r = headon({ type: 'ecbf', gain: 12, v: 3, gap: 2.5, latency: 0.05, comp: false });
    expect(within(r.closest, 0.183)).toBe(true);
    expect(r.closest).toBeLessThan(0.24);
  });

  it('braking-aware alpha = 5 with delay prediction -> ~0.241 m, peak braking ~5.0 m/s^2', () => {
    const r = headon({ type: 'braking', gain: 5, v: 3, gap: 2.5, latency: 0.05, comp: true });
    expect(within(r.closest, 0.241)).toBe(true);
    expect(within(r.peak, 5.0)).toBe(true);
  });

  it('physically impossible: 3 m/s each, 1.5 m gap, 50 ms -> unsafe for every filter (stopping needs ~1.74 m)', () => {
    // stopping distance: relative speed 6 m/s, 2 x 7.5 m/s^2, plus 50 ms of delay, plus 0.24 m
    const stop = (6 * 6) / (2 * 15) + 6 * 0.05 + 0.24;
    expect(stop).toBeCloseTo(1.74, 2);
    for (const [type, gain, comp] of [
      ['ecbf', 4, false],
      ['ecbf', 8, false],
      ['ecbf', 8, true],
      ['ecbf', 12, true],
      ['braking', 5, true],
      ['braking', 10, true],
    ] as const) {
      const r = headon({ type, gain, v: 3, gap: 1.5, latency: 0.05, comp });
      expect(r.closest).toBeLessThan(0.24);
    }
  });
});
