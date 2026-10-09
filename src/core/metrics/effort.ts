/** M22 control effort: integral of |u_cmd + g e_z| dt (thrust proxy), per drone (m/s). */
import type { TrialLog } from '../types';

export function effortMetrics(log: TrialLog): { actual: number[]; planned: number[]; ratio: number[] } {
  const actual = log.summary.effort.slice();
  const planned = log.planned.effort.slice();
  return { actual, planned, ratio: actual.map((a, i) => (a > 0 ? (planned[i] ?? NaN) / a : NaN)) };
}
