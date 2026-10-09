import { describe, expect, it } from 'vitest';
import { compositeScore, rankingStability } from '../core/metrics/scorecard';
import { binomialTest, bootstrapCI, holm, permutationTest, wilson } from '../core/metrics/stats';

describe('Wilson intervals (Section 13)', () => {
  const cases: [number, number, number, number][] = [
    [7, 10, 0.4, 0.89],
    [21, 30, 0.52, 0.83],
    [35, 50, 0.56, 0.81],
  ];
  for (const [k, n, lo, hi] of cases) {
    it(`${k}/${n} -> [${lo}, ${hi}]`, () => {
      const w = wilson(k, n);
      expect(Math.abs(w.lo - lo)).toBeLessThanOrEqual(0.01);
      expect(Math.abs(w.hi - hi)).toBeLessThanOrEqual(0.01);
    });
  }
});

describe('statistics', () => {
  it('exact binomial test', () => {
    // 9 of 10 heads: two-sided p = 22/1024
    expect(binomialTest(9, 10)).toBeCloseTo(22 / 1024, 6);
    expect(binomialTest(5, 10)).toBeCloseTo(1, 6);
  });
  it('bootstrap CI is seeded and brackets the mean', () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const a = bootstrapCI(xs, { seed: 5 });
    const b = bootstrapCI(xs, { seed: 5 });
    expect(a).toEqual(b);
    expect(a.lo).toBeLessThan(5.5);
    expect(a.hi).toBeGreaterThan(5.5);
  });
  it('permutation test separates different samples', () => {
    const a = [1, 1.1, 0.9, 1.2, 1.0, 0.95, 1.05, 1.1];
    const b = [2, 2.1, 1.9, 2.2, 2.0, 1.95, 2.05, 2.1];
    expect(permutationTest(a, b).p).toBeLessThan(0.01);
    expect(permutationTest(a, a.slice()).p).toBeGreaterThan(0.5);
  });
  it('Holm correction', () => {
    const adj = holm([0.01, 0.04, 0.03, 0.005]);
    expect(adj[3]).toBeCloseTo(0.02, 9);
    expect(adj[0]).toBeCloseTo(0.03, 9);
    expect(adj[2]).toBeCloseTo(0.06, 9);
    expect(adj[1]).toBeCloseTo(0.06, 9);
  });
});

describe('scorecard (Section 12 worked example)', () => {
  it('Strategy 1: S 0.94, V 0.87, A 0.70, E 0.87 -> 0.85; Strategy 2 -> 0.81', () => {
    expect(compositeScore(1, { S: 0.94, V: 0.87, A: 0.7, E: 0.87 })).toBeCloseTo(0.845, 3);
    expect(Math.round(compositeScore(1, { S: 0.94, V: 0.87, A: 0.7, E: 0.87 }) * 100) / 100).toBe(0.85);
    expect(Math.round(compositeScore(1, { S: 0.83, V: 0.95, A: 0.62, E: 0.83 }) * 100) / 100).toBe(0.81);
  });
  it('ranking stability is 1 for a dominating condition', () => {
    const r = rankingStability([
      { name: 'a', G: 1, sub: { S: 0.9, V: 0.9, A: 0.9, E: 0.9 } },
      { name: 'b', G: 1, sub: { S: 0.5, V: 0.5, A: 0.5, E: 0.5 } },
    ]);
    expect(r.share).toBe(1);
  });
});
