/**
 * Export of experiment records (Section 12): one CSV row per TrialRecord with the group labels
 * flattened into columns and per-drone arrays joined with ';', plus a JSON dump of the records
 * together with the summaries shown in the Results tab.
 */
import type { ExperimentKind, TrialRecord } from '../../core/experiments';
import type { ExperimentRun } from '../experiments';
import { download } from '../share';

type Cell = string | number | boolean | undefined | null;

const SCALARS: (keyof TrialRecord)[] = [
  'collisions',
  'minS',
  'minD',
  'violationTime',
  'interventionRate',
  'interventionSize',
  'solveP99',
  'obstacleIntRate',
  'pairIntRate',
  'clearance',
  'passRate',
  'strikes',
  'misses',
  'emergencies',
  'G',
  'gateReason',
  'score',
  'rmseMean',
];
const ARRAYS: (keyof TrialRecord)[] = ['rmse', 'along', 'cross', 'meanSpeed', 'lapTime', 'completion', 'feasibilityFail'];

function esc(v: Cell): string {
  if (v === undefined || v === null) return '';
  const s = typeof v === 'number' ? (Number.isFinite(v) ? String(Number(v.toPrecision(8))) : '') : String(v);
  return /[",\n;]/.test(s) && typeof v !== 'number' ? `"${s.replace(/"/g, '""')}"` : s;
}

const join = (xs: readonly (number | string | boolean)[] | undefined): string => (xs ? xs.map((x) => (typeof x === 'number' ? (Number.isFinite(x) ? String(Number(x.toPrecision(8))) : 'NaN') : String(x))).join(';') : '');

export function recordsToCsv(recs: TrialRecord[]): string {
  // group keys differ between experiments (w / margin / scenario ...): take their union, in first-seen order
  const groupKeys: string[] = [];
  for (const r of recs) for (const k of Object.keys(r.group)) if (!groupKeys.includes(k)) groupKeys.push(k);
  const header = [
    'id',
    'kind',
    'seed',
    ...groupKeys.map((k) => `group_${k}`),
    'endReason',
    ...SCALARS,
    ...ARRAYS,
    'sub_S',
    'sub_V',
    'sub_A',
    'sub_E',
    'costOfSafety',
    'race_winner',
    'race_gap',
    'race_overtakes',
    'race_predictedWinner',
    'race_predictedGap',
    'race_realisedGapAtHorizon',
    'race_crashed',
    'race_planSolveMs',
    'race_strategies',
    'race_planNote',
    'wallMs',
    'error',
  ];
  const lines = [header.join(',')];
  for (const r of recs) {
    const row: Cell[] = [
      r.id,
      r.kind,
      r.seed,
      ...groupKeys.map((k) => r.group[k]),
      r.endReason,
      ...SCALARS.map((k) => r[k] as Cell),
      ...ARRAYS.map((k) => join(r[k] as number[])),
      r.sub.S,
      r.sub.V,
      r.sub.A,
      r.sub.E,
      join(r.costOfSafety),
      r.race?.winner,
      r.race?.gap,
      r.race?.overtakes,
      r.race?.predictedWinner,
      r.race?.predictedGap,
      r.race?.realisedGapAtHorizon,
      join(r.race?.crashed),
      r.race?.planSolveMs,
      join(r.race?.strategies),
      r.race?.planNote,
      r.wallMs,
      r.error,
    ];
    lines.push(row.map(esc).join(','));
  }
  return lines.join('\n') + '\n';
}

const fileBase = (kind: ExperimentKind, run: ExperimentRun) => `c3u_${kind}_seed${run.options.seed}`;

export function downloadCsv(kind: ExperimentKind, run: ExperimentRun, recs: TrialRecord[]): void {
  download(`${fileBase(kind, run)}.csv`, recordsToCsv(recs), 'text/csv');
}

/** JSON: options, weights, timing, the summaries the tab shows and the raw records. NaN becomes null. */
export function downloadJson(kind: ExperimentKind, run: ExperimentRun, recs: TrialRecord[], summary: unknown): void {
  const body = {
    note: 'Simulation results (C3U testbed simulator). Idealised models; numbers are illustrative, not hardware results.',
    kind,
    status: run.status,
    options: run.options,
    weights: run.weights,
    trials: { total: run.total, done: run.done },
    workers: run.workers,
    wallMs: run.wallMs,
    summary,
    records: recs,
  };
  download(`${fileBase(kind, run)}.json`, JSON.stringify(body, (_, v) => (typeof v === 'number' && !Number.isFinite(v) ? null : v), 1), 'application/json');
}
