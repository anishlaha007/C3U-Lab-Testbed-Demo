/**
 * Export menu (Section 5.5 plus the logger): the built trajectories in the lab's file standard
 * (one CSV and one metadata JSON per drone), the raw trial log, a wide time-series CSV for
 * plotting elsewhere, and the metrics summary of the current trial.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { DRONE_NAMES } from '../../core/constants';
import { exportTrajectory } from '../../core/csv';
import { evaluateTrial } from '../../core/metrics/scorecard';
import type { TrialLog } from '../../core/types';
import { engine } from '../engine';
import { download } from '../share';
import { conditionLabel, useStore } from '../store';
import { Button } from '../ui';

/** Browsers block bursts of downloads; spacing them out keeps every file. */
const STAGGER_MS = 150;

const letter = (i: number) => DRONE_NAMES[i] ?? String(i + 1);

/** File-name prefix from the configuration the engine actually built. */
function fileBase(): string {
  const sc = engine.config?.scenario;
  return `c3u_${(sc?.preset || sc?.type || 'trial').replace(/[^A-Za-z0-9-]+/g, '-')}`;
}

/**
 * JSON.stringify drops typed arrays to index-keyed objects and Infinity / NaN to null; keep both
 * readable (closest approach and obstacle clearance are Infinity when there is nothing to meet).
 */
function jsonSafe(_key: string, value: unknown): unknown {
  if (typeof value === 'number' && !Number.isFinite(value)) return Number.isNaN(value) ? 'NaN' : value > 0 ? 'Infinity' : '-Infinity';
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) return Array.from(value as unknown as ArrayLike<number>);
  return value;
}

const num = (x: number | undefined): string => (x === undefined ? '' : Number.isFinite(x) ? String(Number(x.toFixed(6))) : Number.isNaN(x) ? 'NaN' : x > 0 ? 'inf' : '-inf');

const SERIES = ['px', 'py', 'pz', 'vx', 'vy', 'vz', 'rx', 'ry', 'rz', 'correction', 'intervened'] as const;

/** One row per log sample: t, then per drone A_px … A_intervened, then per pair AB_s, AB_d. */
export function timeSeriesCsv(log: TrialLog): string {
  const header = ['t'];
  log.drones.forEach((_, i) => SERIES.forEach((f) => header.push(`${letter(i)}_${f}`)));
  log.pairs.forEach((p) => header.push(`${letter(p.i)}${letter(p.j)}_s`, `${letter(p.i)}${letter(p.j)}_d`));
  const lines = [header.join(',')];
  for (let k = 0; k < log.t.length; k++) {
    const row = [num(log.t[k])];
    for (const d of log.drones) for (const f of SERIES) row.push(num(d[f][k]));
    for (const p of log.pairs) row.push(num(p.s[k]), num(p.d[k]));
    lines.push(row.join(','));
  }
  return lines.join('\n') + '\n';
}

function exportTrajectories(): number {
  const b = engine.build;
  if (!b) return 0;
  const base = fileBase();
  // build every file first so a rebuild during the stagger cannot mix two trials
  const files: [string, string, string][] = [];
  b.trajectories.forEach((tr, i) => {
    const { csv, meta } = exportTrajectory(tr, b.k);
    files.push([`${base}_drone${letter(i)}.csv`, csv, 'text/csv'], [`${base}_drone${letter(i)}.json`, meta, 'application/json']);
  });
  files.forEach(([name, content, type], j) => window.setTimeout(() => download(name, content, type), j * STAGGER_MS));
  return files.length;
}

function exportMetrics(log: TrialLog): void {
  const weights = useStore.getState().weights;
  // mid-run the speed score uses the schedule lag instead of lap / arrival times
  const provisional = !engine.sim?.done;
  const out = {
    condition: engine.config ? conditionLabel(engine.config) : '',
    seed: log.seed,
    configHash: log.configHash,
    endReason: log.summary.endReason,
    provisional,
    weights,
    evaluation: evaluateTrial(log, weights, provisional),
  };
  download(`${fileBase()}_seed${log.seed}_metrics.json`, JSON.stringify(out, jsonSafe, 2), 'application/json');
}

interface Item {
  key: string;
  label: string;
  hint: string;
  disabled: boolean;
  run: () => string;
}

export function ExportMenu() {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  // re-render on rebuilds and play / done so the enabled items follow the engine
  useSyncExternalStore(
    (cb) => engine.subscribe(cb),
    () => `${engine.generation}|${engine.status}`,
  );

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    // capture phase: the 3D canvas handles its own pointer events
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // a failed rebuild leaves the previous build in place, which no longer matches the setup
  const build = engine.error ? null : engine.build;
  const log = engine.log && engine.log.t.length > 0 ? engine.log : null;
  const running = !!log && !engine.sim?.done;
  const logHint = log ? `${log.t.length} samples, ${log.t[log.t.length - 1].toFixed(1)} s${running ? ' so far' : ''}` : 'Run a trial first';
  const nTraj = build?.trajectories.length ?? 0;

  const items: Item[] = [
    {
      key: 'traj',
      label: 'Trajectories (CSV + JSON per drone)',
      hint: build && nTraj ? `${nTraj} drone${nTraj > 1 ? 's' : ''}, ${build.k === 1 ? '100 Hz' : `speed ×${build.k}, resampled to 100 Hz`}` : 'No trajectories built',
      disabled: !build || !nTraj,
      run: () => `Downloading ${exportTrajectories()} files…`,
    },
    {
      key: 'log',
      label: 'Trial log (JSON)',
      hint: logHint,
      disabled: !log,
      run: () => {
        const l = engine.log!;
        download(`${fileBase()}_seed${l.seed}_log.json`, JSON.stringify(l, jsonSafe), 'application/json');
        return 'Trial log downloaded.';
      },
    },
    {
      key: 'series',
      label: 'Trial time series (CSV)',
      hint: log ? `${logHint}; per drone p, v, ref, correction; per pair s, d` : 'Run a trial first',
      disabled: !log,
      run: () => {
        const l = engine.log!;
        download(`${fileBase()}_seed${l.seed}_timeseries.csv`, timeSeriesCsv(l), 'text/csv');
        return 'Time series downloaded.';
      },
    },
    {
      key: 'metrics',
      label: 'Metrics summary (JSON)',
      hint: log ? `Scorecard, tracking, safety and effort metrics (current weights)${running ? ', provisional' : ''}` : 'Run a trial first',
      disabled: !log,
      run: () => {
        exportMetrics(engine.log!);
        return 'Metrics summary downloaded.';
      },
    },
  ];

  const pick = (it: Item) => {
    setOpen(false);
    const toast = useStore.getState().toast;
    try {
      toast(it.run(), 'info');
    } catch (e) {
      toast(`Export failed: ${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  };

  return (
    <div ref={root} className="relative">
      <Button small kind="ghost" title="Download trajectories, the trial log or the metrics" onClick={() => setOpen((o) => !o)}>
        Export <span className="text-[9px] opacity-70">▾</span>
      </Button>
      {open && (
        <div role="menu" className="absolute top-full right-0 z-50 mt-1 w-72 rounded-md border border-slate-200 bg-white py-1 shadow-xl dark:border-slate-700 dark:bg-slate-900">
          {items.map((it) => (
            <button
              key={it.key}
              role="menuitem"
              disabled={it.disabled}
              onClick={() => pick(it)}
              className="block w-full px-3 py-1.5 text-left transition-colors hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent dark:hover:bg-slate-800 dark:disabled:hover:bg-transparent"
            >
              <div className="text-xs font-medium text-slate-800 dark:text-slate-200">{it.label}</div>
              <div className="text-[10px] text-slate-500 dark:text-slate-400">{it.hint}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
