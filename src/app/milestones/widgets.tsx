/**
 * Small building blocks of the narration steps: paragraphs, framed boxes, action rows, an
 * experiment progress row and a hook that hands finished experiment records to the summaries.
 */
import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { ExperimentKind, TrialRecord } from '../../core/experiments';
import { engine } from '../engine';
import { cancelExperiment, EXPERIMENT_TITLES, recordsOf, useExperiments, type ExperimentRun } from '../experiments';
import { useStore, type RecordedTrial } from '../store';
import { Badge, Button, cx } from '../ui';
import { startExperiment } from './actions';

export function P({ children, muted }: { children: ReactNode; muted?: boolean }) {
  return <p className={cx('text-[11.5px] leading-relaxed', muted ? 'text-slate-500 dark:text-slate-400' : 'text-slate-700 dark:text-slate-300')}>{children}</p>;
}

/** Framed sub-panel (formula cards, results). */
export function Box({ title, right, children, className }: { title?: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cx('rounded-md border border-slate-200 bg-slate-50/80 p-2 dark:border-slate-700/70 dark:bg-slate-900/60', className)}>
      {title && (
        <div className="mb-1 flex items-center gap-1 text-[11px] font-semibold text-slate-700 dark:text-slate-200">
          {title}
          <span className="ml-auto font-normal">{right}</span>
        </div>
      )}
      {children}
    </div>
  );
}

export function Actions({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-1.5">{children}</div>;
}

/** A formula line: monospace left, value right. */
export function FormulaRow({ f, v, note }: { f: ReactNode; v?: ReactNode; note?: ReactNode }) {
  return (
    <div className="flex items-baseline gap-2 py-0.5 text-[11px]">
      <span className="font-mono text-slate-700 dark:text-slate-300">{f}</span>
      {v !== undefined && <span className="tabular ml-auto font-mono font-semibold whitespace-nowrap text-slate-900 dark:text-slate-100">{v}</span>}
      {note && <span className="text-[10px] whitespace-nowrap text-slate-500">{note}</span>}
    </div>
  );
}

export function Bullets({ items, tone = 'sky' }: { items: ReactNode[]; tone?: 'sky' | 'amber' | 'emerald' }) {
  const dot = tone === 'amber' ? 'bg-amber-500' : tone === 'emerald' ? 'bg-emerald-500' : 'bg-sky-500';
  return (
    <ul className="space-y-1">
      {items.map((x, i) => (
        <li key={i} className="flex gap-1.5 text-[11px] leading-snug text-slate-700 dark:text-slate-300">
          <span className={cx('mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full', dot)} />
          <span>{x}</span>
        </li>
      ))}
    </ul>
  );
}

/** Re-render every 250 ms while `on` (elapsed time between record flushes). */
function useTicker(on: boolean) {
  const [, set] = useState(0);
  useEffect(() => {
    if (!on) return;
    const id = window.setInterval(() => set((x) => x + 1), 250);
    return () => window.clearInterval(id);
  }, [on]);
}

const TONE = { running: 'sky', done: 'emerald', cancelled: 'amber', error: 'rose' } as const;

/** One experiment: Run / Cancel, live progress from the worker pool, elapsed time. */
export function ExperimentStatus({ kind, label, hint }: { kind: ExperimentKind; label?: string; hint?: string }) {
  const run: ExperimentRun | undefined = useExperiments((s) => s.runs[kind]);
  const running = run?.status === 'running';
  useTicker(running);
  const elapsed = run ? (running ? performance.now() - run.startedAt : run.wallMs) : 0;
  const frac = run && run.total ? run.done / run.total : 0;
  return (
    <div className="rounded-md border border-slate-200 px-2 py-1.5 dark:border-slate-700/70">
      <div className="flex items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-slate-800 dark:text-slate-200" title={EXPERIMENT_TITLES[kind]}>
          {label ?? EXPERIMENT_TITLES[kind]}
        </span>
        {run && <Badge tone={TONE[run.status]}>{run.status}</Badge>}
        {running ? (
          <Button small kind="danger" onClick={() => cancelExperiment(kind)} title="Stop; finished trials are kept.">
            ■ Cancel
          </Button>
        ) : (
          <Button small kind="primary" onClick={() => startExperiment(kind)} title={hint ?? 'Fly the trials headlessly on the worker pool; charts appear in the Results tab.'}>
            ▶ {run ? 'Re-run' : 'Run'}
          </Button>
        )}
      </div>
      <div className="mt-1 flex items-center gap-2">
        <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
          <div className={cx('h-full rounded-full transition-[width] duration-200', run?.status === 'error' ? 'bg-rose-500' : run?.status === 'cancelled' ? 'bg-amber-500' : 'bg-sky-500')} style={{ width: `${(frac * 100).toFixed(1)}%` }} />
        </div>
        <span className="tabular shrink-0 font-mono text-[10px] text-slate-500">
          {run ? `${run.done}/${run.total} · ${(elapsed / 1000).toFixed(1)} s · ${run.workers} worker${run.workers === 1 ? '' : 's'}` : 'not run yet'}
        </span>
      </div>
      {run?.status === 'error' && run.error && <div className="mt-0.5 truncate text-[10px] text-rose-600 dark:text-rose-400">{run.error}</div>}
    </div>
  );
}

/**
 * Records of a finished (or cancelled) run. While a run is in flight the summaries wait for the
 * end instead of re-running bootstraps and permutation tests on every progress flush.
 */
export function useFinishedRecords(kind: ExperimentKind): { run: ExperimentRun | undefined; recs: TrialRecord[]; running: boolean } {
  const run = useExperiments((s) => s.runs[kind]);
  const running = run?.status === 'running';
  const finished = running ? undefined : run;
  const records = finished?.records;
  const recs = useMemo(() => (records ? recordsOf({ records } as ExperimentRun) : []), [records]);
  return { run, recs, running };
}

/** "Not run yet" note with a Run button (summary steps). */
export function NotRun({ kind, children }: { kind: ExperimentKind; children?: ReactNode }) {
  const running = useExperiments((s) => s.runs[kind]?.status === 'running');
  return (
    <div className="rounded-md border border-dashed border-slate-300 px-2 py-1.5 text-[11px] text-slate-600 dark:border-slate-700 dark:text-slate-400">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1">{children ?? `${EXPERIMENT_TITLES[kind]}: not run yet.`}</span>
        {running ? <Badge tone="sky">running…</Badge> : <Button small kind="primary" onClick={() => startExperiment(kind)}>▶ Run</Button>}
      </div>
    </div>
  );
}

/** Simulation-honesty footer of result boxes. */
export function SimNote({ run }: { run?: ExperimentRun }) {
  return (
    <div className="mt-1 text-[10px] text-slate-500">
      Simulation results{run ? ` · ${run.done} trials · seed ${run.options.seed}${run.options.quick ? ' · quick demo counts' : ''}` : ''}. Idealised models; not hardware numbers.
    </div>
  );
}

/** Most recent recorded live trial matching a predicate (trials are stored newest first). */
export function useLatestTrial(pred: (t: RecordedTrial) => boolean): RecordedTrial | undefined {
  const trials = useStore((s) => s.trials);
  return trials.find(pred);
}

/** True while the live engine is flying a trial. */
export function useEngineFlying(): boolean {
  return useSyncExternalStore(
    (cb) => engine.subscribe(cb),
    () => engine.playing,
  );
}
