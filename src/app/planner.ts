/**
 * Planner bridge: solves the game for the current configuration in a Web Worker (comlink) and
 * stores the plan. Plans carry the key of the configuration they were solved for; the engine
 * only flies a plan whose key matches the current configuration.
 */
import * as Comlink from 'comlink';
import { planKey } from '../core/planners/plan';
import { isRaceScenario } from '../core/race';
import type { SimConfig } from '../core/types';
import type { PlannerApi } from '../workers/planner.worker';
import { useStore } from './store';

let api: Comlink.Remote<PlannerApi> | null = null;
let requestId = 0;

function getApi(): Comlink.Remote<PlannerApi> {
  if (!api) {
    const w = new Worker(new URL('../workers/planner.worker.ts', import.meta.url), { type: 'module' });
    api = Comlink.wrap<PlannerApi>(w);
  }
  return api;
}

export function planIsCurrent(cfg: SimConfig): boolean {
  const plan = useStore.getState().plan;
  return !!plan && plan.key === planKey(cfg);
}

export async function requestSolve(auto = false): Promise<void> {
  const st = useStore.getState();
  const cfg = st.config;
  if (!isRaceScenario(cfg)) {
    if (!auto) st.toast('Planners apply to the pinch, race loop and ring-course scenarios.', 'warning');
    return;
  }
  const id = ++requestId;
  st.setPlanStatus('solving', 0);
  try {
    const res = await getApi().solve(
      cfg,
      Comlink.proxy((f: number) => {
        if (id === requestId) useStore.getState().setPlanStatus('solving', f);
      }),
    );
    if (id !== requestId) return; // a newer request superseded this one
    const now = useStore.getState();
    if (res.key !== planKey(now.config)) return;
    now.setPlan(res);
    now.setPlanStatus('done', 1);
    if (!auto) now.toast(`Plan solved in ${res.solveMs.toFixed(0)} ms. ${res.note}`, 'success');
  } catch (e) {
    if (id !== requestId) return;
    const msg = e instanceof Error ? e.message : String(e);
    useStore.getState().setPlanStatus('error', 0, msg);
    useStore.getState().toast(`Planner failed: ${msg}`, 'error');
  }
}
