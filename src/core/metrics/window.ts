/** Helpers to iterate over the analysis window of a TrialLog (race clock start to trajectory end). */
import type { TrialLog } from '../types';

/** Number of logged control ticks inside the analysis window. */
export function windowLength(log: TrialLog): number {
  const end = log.summary.raceEnd > 0 ? log.summary.raceEnd : log.planned.duration;
  let n = 0;
  while (n < log.t.length && log.t[n] <= end + 1e-9) n++;
  return n;
}

export function percentile(values: number[], q: number): number {
  if (!values.length) return NaN;
  const s = values.slice().sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

export const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
