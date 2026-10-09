/**
 * Experiment runner (Section 12): a pool of sweep workers flies the trial specs of a milestone
 * experiment in parallel, one spec at a time per worker, with progress and cancellation. Records
 * are stored by spec index so the aggregated statistics do not depend on the pool size or on the
 * order in which workers finish. Also computes M15 (cost of safety) for recorded live trials.
 */
import * as Comlink from 'comlink';
import { create } from 'zustand';
import { buildExperiment, type ExperimentKind, type ExperimentOptions, type TrialRecord, type TrialSpec } from '../core/experiments';
import type { Weights } from '../core/metrics/scorecard';
import type { SimConfig, Trajectory } from '../core/types';
import type { SweepApi } from '../workers/sweep.worker';
import { useStore } from './store';

export interface ExperimentRun {
  kind: ExperimentKind;
  status: 'running' | 'done' | 'cancelled' | 'error';
  options: ExperimentOptions;
  weights: Weights;
  total: number;
  done: number;
  /** Indexed like the spec list; holes while running. */
  records: (TrialRecord | undefined)[];
  workers: number;
  startedAt: number;
  wallMs: number;
  error?: string;
}

interface ExperimentState {
  runs: Partial<Record<ExperimentKind, ExperimentRun>>;
  /** Reduced trial counts (Section 12 "quick demo" toggle). */
  quick: boolean;
  extended: boolean;
  hardCourses: boolean;
  seed: number;
  setOptions: (o: Partial<Pick<ExperimentState, 'quick' | 'extended' | 'hardCourses' | 'seed'>>) => void;
  clear: (kind?: ExperimentKind) => void;
}

export const useExperiments = create<ExperimentState>((set, get) => ({
  runs: {},
  quick: true,
  extended: false,
  hardCourses: false,
  seed: 1,
  setOptions: (o) => set(o),
  clear: (kind) => {
    if (!kind) return set({ runs: {} });
    const runs = { ...get().runs };
    delete runs[kind];
    set({ runs });
  },
}));

export const EXPERIMENT_TITLES: Record<ExperimentKind, string> = {
  'm1-speed': 'M1 speed sweep (T1 figure-8)',
  'm1-compare': 'M1 streamed vs uploaded vs PID-like',
  'm2-safety': 'M2 safety sweep (T5 circle swap)',
  'm2-margins': 'M2 obstacle / gate margin sweep (C6, C5)',
  'm2-scaling': 'M2 drone-count scaling (T7, T8)',
  'm3-series': 'M3 race series (Independent / Nash / Stackelberg)',
};

/** Completed records of a run (holes removed), in spec order. */
export function recordsOf(run: ExperimentRun | undefined): TrialRecord[] {
  return run ? (run.records.filter(Boolean) as TrialRecord[]) : [];
}

export function poolSize(): number {
  const hc = typeof navigator !== 'undefined' && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 4;
  return Math.max(1, Math.min(6, hc - 1));
}

interface PoolWorker {
  worker: Worker;
  api: Comlink.Remote<SweepApi>;
}

function spawn(): PoolWorker {
  const worker = new Worker(new URL('../workers/sweep.worker.ts', import.meta.url), { type: 'module' });
  return { worker, api: Comlink.wrap<SweepApi>(worker) };
}

const active = new Map<ExperimentKind, { token: number; pool: PoolWorker[] }>();
let tokenCounter = 0;

function patchRun(kind: ExperimentKind, token: number, fn: (r: ExperimentRun) => ExperimentRun) {
  if (active.get(kind)?.token !== token) return;
  const st = useExperiments.getState();
  const run = st.runs[kind];
  if (!run) return;
  useExperiments.setState({ runs: { ...st.runs, [kind]: fn(run) } });
}

/** Run a milestone experiment on a worker pool. Resolves with the records when finished. */
export async function runExperiment(kind: ExperimentKind, override: Partial<ExperimentOptions> = {}): Promise<TrialRecord[]> {
  cancelExperiment(kind, true);
  const es = useExperiments.getState();
  const options: ExperimentOptions = { quick: es.quick, seed: es.seed, extended: es.extended, hardCourses: es.hardCourses, ...override };
  const weights = { ...useStore.getState().weights };
  const specs: TrialSpec[] = buildExperiment(kind, options);
  const n = Math.min(poolSize(), specs.length);
  const pool = Array.from({ length: n }, spawn);
  const token = ++tokenCounter;
  active.set(kind, { token, pool });
  const startedAt = performance.now();
  useExperiments.setState({
    runs: {
      ...useExperiments.getState().runs,
      [kind]: { kind, status: 'running', options, weights, total: specs.length, done: 0, records: new Array(specs.length), workers: n, startedAt, wallMs: 0 },
    },
  });
  let next = 0;
  const results: (TrialRecord | undefined)[] = new Array(specs.length);
  // batch store updates so hundreds of fast trials do not re-render the UI hundreds of times
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    flushTimer = null;
    patchRun(kind, token, (r) => ({ ...r, records: results.slice(), done: results.filter(Boolean).length, wallMs: performance.now() - startedAt }));
  };
  const loop = async (w: PoolWorker) => {
    while (next < specs.length && active.get(kind)?.token === token) {
      const i = next++;
      results[i] = await w.api.run(specs[i], weights);
      if (!flushTimer) flushTimer = setTimeout(flush, 120);
    }
  };
  try {
    await Promise.all(pool.map(loop));
  } catch (e) {
    if (active.get(kind)?.token === token) {
      const msg = e instanceof Error ? e.message : String(e);
      patchRun(kind, token, (r) => ({ ...r, status: 'error', error: msg }));
      useStore.getState().toast(`Experiment failed: ${msg}`, 'error');
      finish(kind, token);
    }
    return results.filter(Boolean) as TrialRecord[];
  }
  if (flushTimer) clearTimeout(flushTimer);
  if (active.get(kind)?.token !== token) return results.filter(Boolean) as TrialRecord[];
  const wallMs = performance.now() - startedAt;
  patchRun(kind, token, (r) => ({ ...r, status: 'done', records: results.slice(), done: specs.length, wallMs }));
  finish(kind, token);
  useStore.getState().toast(`${EXPERIMENT_TITLES[kind]}: ${specs.length} trials in ${(wallMs / 1000).toFixed(1)} s on ${n} worker${n > 1 ? 's' : ''}.`, 'success');
  return results as TrialRecord[];
}

function finish(kind: ExperimentKind, token: number) {
  const a = active.get(kind);
  if (!a || a.token !== token) return;
  a.pool.forEach((p) => p.worker.terminate());
  active.delete(kind);
}

/** Stop a running experiment; completed records are kept. */
export function cancelExperiment(kind: ExperimentKind, silent = false): void {
  const a = active.get(kind);
  if (!a) return;
  patchRun(kind, a.token, (r) => ({ ...r, status: 'cancelled', records: r.records, wallMs: performance.now() - r.startedAt }));
  a.pool.forEach((p) => p.worker.terminate());
  active.delete(kind);
  if (!silent) useStore.getState().toast(`${EXPERIMENT_TITLES[kind]} cancelled.`, 'warning');
}

export function isRunning(kind: ExperimentKind): boolean {
  return active.has(kind);
}

// ---- M15 for recorded live trials ----------------------------------------------------------

let soloWorker: PoolWorker | null = null;

/**
 * Fly each drone of a recorded multi-drone trial alone in a worker and store the cost of safety
 * (multi-drone RMSE minus solo RMSE, M15) on the recorded trial.
 */
export async function computeCostOfSafety(trialId: number, cfg: SimConfig, trajectories: Trajectory[], multiRmse: number[]): Promise<void> {
  if (trajectories.length < 2) return;
  soloWorker ??= spawn();
  try {
    const solo = await soloWorker.api.solo(cfg, trajectories, useStore.getState().weights);
    useStore.getState().updateTrial(trialId, { costOfSafety: multiRmse.map((m, i) => m - solo[i]) });
  } catch {
    // M15 is optional; a failure leaves it blank
  }
}
