/**
 * Statistics (Section 9): mean and seeded bootstrap 95% CI, Wilson score interval, exact
 * binomial test, two-sample permutation test, Holm correction.
 */
import { Rng } from '../rng';

export function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
}

export function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

/** Percentile bootstrap CI of the mean (default 1000 resamples, 95%). */
export function bootstrapCI(xs: number[], opts: { resamples?: number; level?: number; seed?: number } = {}): { mean: number; lo: number; hi: number } {
  const n = xs.length;
  if (n === 0) return { mean: NaN, lo: NaN, hi: NaN };
  const B = opts.resamples ?? 1000;
  const level = opts.level ?? 0.95;
  const rng = new Rng(opts.seed ?? 12345);
  const means = new Float64Array(B);
  for (let b = 0; b < B; b++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += xs[rng.int(n)];
    means[b] = s / n;
  }
  means.sort();
  const a = (1 - level) / 2;
  const q = (p: number) => {
    const pos = (B - 1) * p;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return means[lo] + (means[hi] - means[lo]) * (pos - lo);
  };
  return { mean: mean(xs), lo: q(a), hi: q(1 - a) };
}

/** Wilson score interval for k successes in n trials (z = 1.96 for 95%). */
export function wilson(k: number, n: number, z = 1.959963984540054): { p: number; lo: number; hi: number } {
  if (n === 0) return { p: NaN, lo: 0, hi: 1 };
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { p, lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}

function logChoose(n: number, k: number): number {
  return lgamma(n + 1) - lgamma(k + 1) - lgamma(n - k + 1);
}

/** log Gamma (Lanczos approximation). */
export function lgamma(x: number): number {
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - lgamma(1 - x);
  x -= 1;
  let a = c[0];
  const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Exact two-sided binomial test of k successes in n against p0 (sum of outcomes as or less likely). */
export function binomialTest(k: number, n: number, p0 = 0.5): number {
  if (n === 0) return 1;
  const pmf = (i: number) => Math.exp(logChoose(n, i) + i * Math.log(p0) + (n - i) * Math.log(1 - p0));
  const pk = pmf(k);
  let p = 0;
  for (let i = 0; i <= n; i++) {
    const pi = pmf(i);
    if (pi <= pk * (1 + 1e-7)) p += pi;
  }
  return Math.min(1, p);
}

/**
 * Two-sample permutation test on the difference in means (two-sided). Exact enumeration is
 * replaced by `permutations` seeded random relabellings.
 */
export function permutationTest(a: number[], b: number[], opts: { permutations?: number; seed?: number } = {}): { diff: number; p: number } {
  const na = a.length;
  const nb = b.length;
  if (!na || !nb) return { diff: NaN, p: 1 };
  const all = a.concat(b);
  const obs = Math.abs(mean(a) - mean(b));
  const P = opts.permutations ?? 5000;
  const rng = new Rng(opts.seed ?? 4242);
  const idx = all.map((_, i) => i);
  let count = 0;
  const total = all.reduce((x, y) => x + y, 0);
  for (let r = 0; r < P; r++) {
    // partial shuffle: draw na elements for group A
    let sa = 0;
    for (let i = 0; i < na; i++) {
      const j = i + rng.int(idx.length - i);
      [idx[i], idx[j]] = [idx[j], idx[i]];
      sa += all[idx[i]];
    }
    const diff = Math.abs(sa / na - (total - sa) / nb);
    if (diff >= obs - 1e-12) count++;
  }
  return { diff: mean(a) - mean(b), p: (count + 1) / (P + 1) };
}

/** Holm step-down adjusted p-values (same order as the input). */
export function holm(ps: number[]): number[] {
  const m = ps.length;
  const order = ps.map((p, i) => ({ p, i })).sort((x, y) => x.p - y.p);
  const adj = new Array<number>(m);
  let running = 0;
  order.forEach(({ p, i }, r) => {
    const a = Math.min(1, (m - r) * p);
    running = Math.max(running, a);
    adj[i] = running;
  });
  return adj;
}
