/** Shared pieces of the Results tab: throttled run records, empty states, export buttons, footers. */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { HONESTY_LABEL, PLANNER_LABEL } from '../../core/constants';
import type { ExperimentKind, TrialRecord } from '../../core/experiments';
import { EXPERIMENT_TITLES, runExperiment, useExperiments, type ExperimentRun } from '../experiments';
import { EQUAL_WEIGHTS, type Weights } from '../../core/metrics/scorecard';
import { useStore } from '../store';
import { Button, Slider } from '../ui';
import { downloadCsv, downloadJson } from './exporting';

/**
 * Records of an experiment run. While the run is in flight the pool flushes new records every
 * ~120 ms; re-aggregating (bootstrap CIs, permutation tests) that often would compete with the
 * UI, so the snapshot handed to the summaries is throttled to ~0.6 s until the run ends.
 */
export function useRunRecords(kind: ExperimentKind): { run: ExperimentRun | undefined; recs: TrialRecord[] } {
  const run = useExperiments((s) => s.runs[kind]);
  const records = run?.records;
  const running = run?.status === 'running';
  const [snap, setSnap] = useState(records);
  const last = useRef(0);
  useEffect(() => {
    if (!running) {
      setSnap(records);
      return;
    }
    const wait = Math.max(0, 600 - (performance.now() - last.current));
    const id = window.setTimeout(() => {
      last.current = performance.now();
      setSnap(records);
    }, wait);
    return () => window.clearTimeout(id);
  }, [records, running]);
  const recs = useMemo(() => (snap ? (snap.filter(Boolean) as TrialRecord[]) : []), [snap]);
  return { run, recs };
}

/** Records that ran without an exception (failed specs are kept in exports but not in charts). */
export const okRecords = (recs: TrialRecord[]) => recs.filter((r) => !r.error);

export function EmptyState({ kinds, children }: { kinds: ExperimentKind[]; children: ReactNode }) {
  const runs = useExperiments((s) => s.runs);
  const running = kinds.filter((k) => runs[k]?.status === 'running');
  return (
    <div className="rounded-md border border-dashed border-slate-300 p-3 text-[11px] leading-snug text-slate-600 dark:border-slate-700 dark:text-slate-400">
      <div className="mb-2">{children}</div>
      {running.length > 0 ? (
        <div className="text-[10px] text-sky-700 dark:text-sky-300">Running… the first results appear here as soon as trials finish.</div>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {kinds.map((k) => (
            <Button key={k} small kind="primary" onClick={() => void runExperiment(k)}>
              ▶ Run {EXPERIMENT_TITLES[k]}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Small "running…" note above partial charts. */
export function PartialNote({ run }: { run: ExperimentRun | undefined }) {
  if (!run || run.status === 'done') return null;
  const text =
    run.status === 'running'
      ? `Partial results: ${run.done} of ${run.total} trials so far; charts update as trials finish.`
      : `Incomplete run (${run.status}): ${run.done} of ${run.total} trials.`;
  return <div className="rounded bg-amber-50 px-2 py-1 text-[10px] text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">{text}</div>;
}

export function ExportButtons({ kind, run, recs, summary }: { kind: ExperimentKind; run: ExperimentRun | undefined; recs: TrialRecord[]; summary: () => unknown }) {
  if (!run || !recs.length) return null;
  return (
    <div className="flex items-center gap-1.5 text-[10px] text-slate-500">
      <span className="min-w-0 flex-1 truncate" title={EXPERIMENT_TITLES[kind]}>
        {EXPERIMENT_TITLES[kind]} · {recs.length} trials · seed {run.options.seed}
        {run.options.quick ? ' · quick' : ''}
      </span>
      <Button small onClick={() => downloadCsv(kind, run, recs)} title="One row per trial; group labels flattened, per-drone arrays joined with ';'.">
        ⬇ CSV
      </Button>
      <Button small onClick={() => downloadJson(kind, run, recs, summary())} title="Records plus the summaries (CIs, tests) shown here.">
        ⬇ JSON
      </Button>
    </div>
  );
}

export function Footer({ planner }: { planner?: boolean }) {
  return (
    <p className="border-t border-slate-200 pt-1.5 text-[10px] leading-snug text-slate-500 dark:border-slate-800">
      {HONESTY_LABEL}
      {planner && <> {PLANNER_LABEL}.</>}
    </p>
  );
}

/** "3" or "3–5": the range of per-group sample sizes. */
export function nRange(ns: number[]): string {
  if (!ns.length) return '0';
  const lo = Math.min(...ns);
  const hi = Math.max(...ns);
  return lo === hi ? String(lo) : `${lo}–${hi}`;
}

/** One-line explanatory note under a chart. */
export function Note({ children }: { children: ReactNode }) {
  return <p className="mt-1 text-[10px] leading-snug text-slate-500 dark:text-slate-400">{children}</p>;
}

/** Plain-language finding, computed from the data. */
export function Finding({ children, tone = 'sky' }: { children: ReactNode; tone?: 'sky' | 'amber' }) {
  return (
    <div
      className={
        tone === 'sky'
          ? 'rounded border-l-2 border-sky-500 bg-sky-50 px-2 py-1 text-[11px] leading-snug text-slate-700 dark:bg-sky-500/10 dark:text-slate-200'
          : 'rounded border-l-2 border-amber-500 bg-amber-50 px-2 py-1 text-[11px] leading-snug text-slate-700 dark:bg-amber-500/10 dark:text-slate-200'
      }
    >
      {children}
    </div>
  );
}

const WEIGHT_LABELS: { k: keyof Weights; label: string; tip: string }[] = [
  { k: 'S', label: 'wS safety', tip: 'S = 0.5 [(1 − M13) + min(1, M11)]: few interventions and a large closest approach.' },
  { k: 'V', label: 'wV speed', tip: 'V = min(1, planned lap time / actual lap time).' },
  { k: 'A', label: 'wA accuracy', tip: 'A = max(0, 1 − M1 / 0.30 m).' },
  { k: 'E', label: 'wE effort', tip: 'E = min(1, planned effort / actual effort).' },
];

/** Scorecard weight sliders (shared by the Trials and M3 sections; rankings update live). */
export function WeightSliders() {
  const w = useStore((s) => s.weights);
  const setWeights = useStore((s) => s.setWeights);
  const equal = (Object.keys(EQUAL_WEIGHTS) as (keyof Weights)[]).every((k) => w[k] === EQUAL_WEIGHTS[k]);
  return (
    <div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1">
        {WEIGHT_LABELS.map(({ k, label, tip }) => (
          <Slider key={k} label={label} tip={tip} value={w[k]} min={0} max={3} step={0.25} format={(v) => v.toFixed(2)} onChange={(v) => setWeights({ ...w, [k]: v })} />
        ))}
      </div>
      <div className="mt-1 flex items-center gap-2 text-[10px] text-slate-500">
        <span>Score = G × (wS·S + wV·V + wA·A + wE·E) / (wS + wV + wA + wE)</span>
        <Button small kind="ghost" className="ml-auto" disabled={equal} onClick={() => setWeights({ ...EQUAL_WEIGHTS })}>
          Reset to equal
        </Button>
      </div>
    </div>
  );
}

/** Compact "S 1 · V 1 · A 1 · E 1" line of the current weights. */
export function weightsText(w: Weights): string {
  return (['S', 'V', 'A', 'E'] as const).map((k) => `${k} ${Number(w[k].toFixed(2))}`).join(' · ');
}

/** Tiny table cell helpers so the result tables share one look. */
export const TH = 'px-1 py-0.5 text-right font-medium text-slate-500 first:text-left';
export const TD = 'px-1 py-0.5 text-right font-mono tabular first:text-left';
export const TH_LEFT = 'px-1 py-0.5 text-left font-medium text-slate-500';
export const TD_LEFT = 'px-1 py-0.5 text-left';
