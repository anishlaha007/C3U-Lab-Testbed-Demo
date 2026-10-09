/**
 * Launcher card of the Results tab: experiment options (quick demo, seed, extended speeds, hard
 * courses) and one row per experiment of the active section with Run / Cancel, progress, elapsed
 * time, worker count and status. Trials fly on the worker pool, so the UI stays responsive.
 */
import { useEffect, useMemo, useState } from 'react';
import { buildExperiment, type ExperimentKind } from '../../core/experiments';
import { cancelExperiment, EXPERIMENT_TITLES, poolSize, runExperiment, useExperiments, type ExperimentRun } from '../experiments';
import { Badge, Button, Card, cx, InfoDot, Toggle } from '../ui';

export type Section = 'm1' | 'm2' | 'm3' | 'trials';

export const SECTION_KINDS: Record<Section, ExperimentKind[]> = {
  m1: ['m1-speed', 'm1-compare'],
  m2: ['m2-safety', 'm2-margins', 'm2-scaling'],
  m3: ['m3-series'],
  trials: [],
};

export const sectionOfKind = (k: ExperimentKind): Section => (k.startsWith('m1') ? 'm1' : k.startsWith('m2') ? 'm2' : 'm3');

/** Re-render every 250 ms while `on`, so elapsed time keeps moving between record flushes. */
function useTicker(on: boolean) {
  const [, set] = useState(0);
  useEffect(() => {
    if (!on) return;
    const id = window.setInterval(() => set((x) => x + 1), 250);
    return () => window.clearInterval(id);
  }, [on]);
}

const STATUS_TONE = { running: 'sky', done: 'emerald', cancelled: 'amber', error: 'rose' } as const;

function ExperimentRow({ kind, trials }: { kind: ExperimentKind; trials: number }) {
  const run: ExperimentRun | undefined = useExperiments((s) => s.runs[kind]);
  const clear = useExperiments((s) => s.clear);
  const running = run?.status === 'running';
  useTicker(running);
  const elapsed = run ? (running ? performance.now() - run.startedAt : run.wallMs) : 0;
  const frac = run && run.total ? run.done / run.total : 0;
  return (
    <div className="rounded border border-slate-200 px-2 py-1.5 dark:border-slate-800">
      <div className="flex items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-slate-800 dark:text-slate-200" title={EXPERIMENT_TITLES[kind]}>
          {EXPERIMENT_TITLES[kind]}
        </span>
        {run && (
          <span title={run.error}>
            <Badge tone={STATUS_TONE[run.status]}>{run.status}</Badge>
          </span>
        )}
        {running ? (
          <Button small kind="danger" onClick={() => cancelExperiment(kind)} title="Stop the run; finished trials are kept.">
            ■ Cancel
          </Button>
        ) : (
          <Button small kind="primary" onClick={() => void runExperiment(kind)} title={`Fly ${trials} trials headlessly on the worker pool.`}>
            ▶ {run ? 'Re-run' : 'Run'}
          </Button>
        )}
        {run && !running && (
          <Button small kind="ghost" onClick={() => clear(kind)} title="Discard this run's results.">
            ✕
          </Button>
        )}
      </div>
      <div className="mt-1 flex items-center gap-2">
        <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
          <div
            className={cx('h-full rounded-full transition-[width] duration-200', run?.status === 'error' ? 'bg-rose-500' : run?.status === 'cancelled' ? 'bg-amber-500' : 'bg-sky-500')}
            style={{ width: `${(frac * 100).toFixed(1)}%` }}
          />
        </div>
        <span className="tabular shrink-0 font-mono text-[10px] text-slate-500">
          {run ? `${run.done}/${run.total} · ${(elapsed / 1000).toFixed(1)} s · ${run.workers} worker${run.workers === 1 ? '' : 's'}` : `${trials} trials · not run yet`}
        </span>
      </div>
      {run?.status === 'error' && run.error && <div className="mt-0.5 truncate text-[10px] text-rose-600 dark:text-rose-400">{run.error}</div>}
    </div>
  );
}

export function ExperimentLauncher({ section }: { section: Section }) {
  const { quick, seed, extended, hardCourses, setOptions } = useExperiments();
  const kinds = SECTION_KINDS[section];
  // trial counts for the current options (cheap: specs are plain configs, nothing is flown)
  const counts = useMemo(() => {
    const o = { quick, seed, extended, hardCourses };
    return Object.fromEntries(kinds.map((k) => [k, buildExperiment(k, o).length])) as Record<ExperimentKind, number>;
  }, [kinds, quick, seed, extended, hardCourses]);
  return (
    <Card
      title={
        <>
          Experiments
          <InfoDot text={`Each experiment flies its trials headlessly in parallel on up to ${poolSize()} Web Workers; results are deterministic for a given seed and do not depend on the worker count.`} />
        </>
      }
    >
      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
        <Toggle label="Quick demo" value={quick} onChange={(v) => setOptions({ quick: v })} tip="Reduced trial counts (e.g. 3 instead of 5 trials per speed, 10 instead of 30 races per condition) so every experiment finishes quickly." />
        <label className="flex items-center gap-1.5 text-[11px] text-slate-700 dark:text-slate-300">
          Seed
          <input
            type="number"
            min={0}
            step={1}
            value={seed}
            onChange={(e) => {
              const v = Math.floor(Number(e.target.value));
              if (Number.isFinite(v)) setOptions({ seed: Math.max(0, v) });
            }}
            className="tabular w-16 rounded border border-slate-300 bg-white px-1 py-0.5 font-mono text-[11px] dark:border-slate-700 dark:bg-slate-900"
          />
          <InfoDot text="Base seed: trial k uses seed + k (noise, wind, random courses). The same seed reproduces the same records." />
        </label>
        <Toggle label="Extended speeds" value={extended} onChange={(v) => setOptions({ extended: v })} tip="M1 speed sweep also flies w = 1.80 and 2.10 rad/s, beyond the eta = 0.7 planning limit (validator overridden), to show the breakdown." />
        <Toggle label="Hard courses" value={hardCourses} onChange={(v) => setOptions({ hardCourses: v })} tip="M3 race series also runs the optional hard courses C10 Complex circuit and C6 Forest." />
      </div>
      {kinds.length > 0 ? (
        <div className="mt-2 space-y-1.5">
          {kinds.map((k) => (
            <ExperimentRow key={k} kind={k} trials={counts[k]} />
          ))}
        </div>
      ) : (
        <p className="mt-2 text-[10px] leading-snug text-slate-500">This section ranks the live trials you flew in the 3D view. Headless experiments are in the M1, M2 and M3 sections.</p>
      )}
    </Card>
  );
}
