import { describe, expect, it } from 'vitest';
import { G } from '../core/constants';
import { sampleScaled, sampleTrajectory } from '../core/trajectories/common';
import {
  FIGURE8_PEAK_ACCEL_COEFF,
  figure8,
  figure8MaxW,
  figure8MeanSpeed,
  figure8PeakAccel,
  figure8PeakSpeed,
  horizontalLimit,
} from '../core/trajectories/figure8';

describe('figure-8 (lemniscate of Gerono), A = 1.5 m', () => {
  const A = 1.5;

  it('peak acceleration coefficient: 3.187 w^2 for A = 1.5 (2.125 A w^2)', () => {
    // numerical peak over a lap at w = 1
    const tr = figure8({ A, w: 1, z0: 1 });
    let peak = 0;
    for (let i = 0; i < tr.t.length; i++) peak = Math.max(peak, Math.hypot(tr.ax[i], tr.ay[i], tr.az[i]));
    expect(peak).toBeCloseTo(3.187, 2);
    expect(Math.abs(peak - 3.187)).toBeLessThan(0.005);
    expect(FIGURE8_PEAK_ACCEL_COEFF * A).toBeCloseTo(3.1875, 4);
    expect(figure8PeakAccel(A, 1)).toBeCloseTo(3.1875, 4);
  });

  it('w_max for CF2.1 at eta 0.7 is 1.54 rad/s; lap 4.09 s; mean 2.24 m/s; peak 3.26 m/s', () => {
    const wmax = figure8MaxW(A, 1.8, 0.7);
    expect(Math.abs(wmax - 1.54)).toBeLessThan(0.01);
    expect(Math.abs((2 * Math.PI) / wmax - 4.09)).toBeLessThan(0.02);
    expect(Math.abs(figure8MeanSpeed(A, wmax) - 2.24)).toBeLessThan(0.01);
    expect(Math.abs(figure8PeakSpeed(A, wmax) - 3.26)).toBeLessThan(0.01);
    expect(horizontalLimit(1.8, 0.7)).toBeGreaterThan(7.45);
    expect(G).toBe(9.81);
  });

  it('baseline w = 0.522 gives mean speed 0.76 m/s (12.0 s lap)', () => {
    expect(Math.abs(figure8MeanSpeed(A, 0.522) - 0.76)).toBeLessThan(0.005);
    expect(Math.abs((2 * Math.PI) / 0.522 - 12.04)).toBeLessThan(0.05);
  });

  it('interpolated samples match the analytic curve and time scaling scales v by k and a by k^2', () => {
    const w = 0.8;
    const tr = figure8({ A, w, z0: 1 });
    const t = 1.2345;
    const sp = sampleTrajectory(tr, t);
    expect(sp.p.x).toBeCloseTo(A * Math.sin(w * t), 5);
    expect(sp.p.y).toBeCloseTo((A / 2) * Math.sin(2 * w * t), 5);
    const k = 1.7;
    const sk = sampleScaled(tr, t / k, k);
    expect(sk.p.x).toBeCloseTo(sp.p.x, 6);
    expect(sk.v.x).toBeCloseTo(sp.v.x * k, 4);
    expect(sk.a.y).toBeCloseTo(sp.a.y * k * k, 3);
  });
});
