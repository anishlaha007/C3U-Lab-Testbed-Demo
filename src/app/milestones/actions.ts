/**
 * Scene actions used by the narration steps. The engine reloads a changed configuration after a
 * short debounce (EngineSync in App.tsx) and race scenarios are solved in a worker first, so
 * "fly" cannot simply call engine.play(): it waits until the engine holds exactly the new
 * configuration (and, for races, its current plan) and only then starts the trial.
 */
import { planKey } from '../../core/planners/plan';
import { isRaceScenario } from '../../core/race';
import type { ExperimentKind } from '../../core/experiments';
import type { SimConfig } from '../../core/types';
import { engine } from '../engine';
import { runExperiment } from '../experiments';
import { requestSolve } from '../planner';
import { useStore, type CameraMode, type RightTab, type Visuals } from '../store';

let pendingFly: (() => void) | null = null;

/** Forget a fly request that has not started yet (another step was entered). */
export function cancelPendingFly(): void {
  pendingFly?.();
  pendingFly = null;
}

/** Play the current configuration as soon as the engine has loaded it (and its plan). */
export function flyWhenReady(timeoutMs = 90_000): void {
  cancelPendingFly();
  const started = performance.now();
  let timer = 0;
  let unsub: () => void = () => {};
  // a planner error left over from an earlier solve must not cancel this request
  let sawSolve = false;
  const stop = () => {
    window.clearInterval(timer);
    unsub();
    if (pendingFly === stop) pendingFly = null;
  };
  const check = () => {
    if (pendingFly !== stop) return;
    if (performance.now() - started > timeoutMs) return stop();
    const st = useStore.getState();
    const cfg = st.config;
    if (engine.config !== cfg) return;
    if (isRaceScenario(cfg)) {
      if (st.planStatus === 'solving') sawSolve = true;
      if (sawSolve && st.planStatus === 'error') return stop();
      if (!engine.plan || engine.plan.key !== planKey(cfg)) return;
    }
    if (engine.status === 'invalid') {
      st.toast('The validator blocked this run; the Live tab says why.', 'warning');
      return stop();
    }
    if (engine.status === 'ready') {
      stop();
      engine.play();
    }
  };
  pendingFly = stop;
  unsub = engine.subscribe(check) as () => void;
  timer = window.setInterval(check, 150);
}

export interface SetupOptions {
  /** Scenario preset to start from (T1 to T14). */
  preset?: string;
  /** Further changes on top of the preset (or of the current configuration). */
  set?: (c: SimConfig) => void;
  tab?: RightTab;
  camera?: CameraMode;
  visuals?: Partial<Visuals>;
}

/** Configure the scene without flying. */
export function setup(o: SetupOptions = {}): void {
  cancelPendingFly();
  const st = useStore.getState();
  if (o.preset) st.applyPreset(o.preset);
  if (o.set) st.setConfig(o.set);
  if (o.tab) st.setRightTab(o.tab);
  if (o.camera) st.setCamera(o.camera);
  if (o.visuals) st.setVisuals(o.visuals);
}

/** Configure the scene and fly a fresh trial of it. */
export function fly(o: SetupOptions = {}): void {
  const st = useStore.getState();
  setup(o);
  // a fresh configuration object makes the engine rebuild the trial even if nothing changed
  if (!o.preset && !o.set) st.replaceConfig(st.config);
  flyWhenReady();
}

/** Show a tab of the right panel. */
export function showTab(tab: RightTab): void {
  useStore.getState().setRightTab(tab);
}

/** Run a milestone experiment and show the Results tab, where its charts appear. */
export function startExperiment(kind: ExperimentKind): void {
  showTab('results');
  void runExperiment(kind);
}

/**
 * Solve the game for the current race configuration unless EngineSync's automatic solve is
 * already on it (a second request would only supersede the first and double the wait).
 */
export function solveSoon(): void {
  window.setTimeout(() => {
    const st = useStore.getState();
    if (!isRaceScenario(st.config) || st.planStatus === 'solving') return;
    if (st.plan && st.plan.key === planKey(st.config)) return;
    void requestSolve();
  }, 400);
}
