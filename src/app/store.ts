/**
 * App state (zustand): configuration, UI state, recorded trials and results. The running
 * simulation itself lives in `engine` (outside React) and panels poll it through `liveTick`.
 */
import { create } from 'zustand';
import { cloneConfig, defaultConfig } from '../core/defaults';
import { EQUAL_WEIGHTS, evaluateTrial, type TrialEvaluation, type Weights } from '../core/metrics/scorecard';
import type { PlanResult } from '../core/planners/types';
import { presetConfig } from '../core/presets';
import type { SimConfig, TrialLog } from '../core/types';
import { engine } from './engine';

export type Mode = 'sandbox' | 'm1' | 'm2' | 'm3' | 'scorecard';
export type RightTab = 'live' | 'tracking' | 'safety' | 'race' | 'game' | 'results';
export type CameraMode = 'orbit' | 'follow' | 'top' | 'chase' | 'side' | 'fpv' | 'cinematic';

export interface Visuals {
  trails: boolean;
  trailLength: number;
  trailColor: 'speed' | 'drone';
  ellipsoids: boolean;
  ghosts: boolean;
  commandedPath: boolean;
  arrows: boolean;
  separation: boolean;
  frustums: boolean;
  exaggerate: 1 | 3;
  labels: boolean;
  racingLine: boolean;
  searchPath: boolean;
  nets: boolean;
}

export interface RecordedTrial {
  id: number;
  name: string;
  condition: string;
  config: SimConfig;
  log: TrialLog;
  evaluation: TrialEvaluation;
  /** M15 cost of safety per drone (filled asynchronously for multi-drone runs). */
  costOfSafety?: number[];
}

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'success' | 'warning' | 'error';
}

interface StoreState {
  config: SimConfig;
  mode: Mode;
  dark: boolean;
  rightTab: RightTab;
  camera: CameraMode;
  followIndex: number;
  visuals: Visuals;
  simSpeed: number;
  recording: boolean;
  plan: PlanResult | null;
  planStatus: 'idle' | 'solving' | 'done' | 'error';
  planProgress: number;
  planError: string | null;
  weights: Weights;
  liveTick: number;
  trials: RecordedTrial[];
  toasts: Toast[];
  editorOpen: boolean;
  narrationStep: number;
  leftOpen: Record<string, boolean>;
  hoverCell: [number, number] | null;

  setConfig: (fn: (c: SimConfig) => void) => void;
  replaceConfig: (c: SimConfig) => void;
  applyPreset: (id: string) => void;
  setMode: (m: Mode) => void;
  toggleDark: () => void;
  setRightTab: (t: RightTab) => void;
  setCamera: (c: CameraMode) => void;
  cycleFollow: () => void;
  setVisuals: (v: Partial<Visuals>) => void;
  setSimSpeed: (s: number) => void;
  toggleRecording: () => void;
  setPlan: (p: PlanResult | null) => void;
  setPlanStatus: (s: StoreState['planStatus'], progress?: number, error?: string | null) => void;
  setWeights: (w: Weights) => void;
  bump: () => void;
  addTrial: (t: Omit<RecordedTrial, 'id'>) => number;
  updateTrial: (id: number, patch: Partial<RecordedTrial>) => void;
  removeTrial: (id: number) => void;
  clearTrials: () => void;
  toast: (text: string, kind?: Toast['kind']) => void;
  dismissToast: (id: number) => void;
  setEditorOpen: (o: boolean) => void;
  setNarrationStep: (s: number) => void;
  toggleSection: (k: string) => void;
  setHoverCell: (c: [number, number] | null) => void;
}

let toastId = 1;
let trialId = 1;

const initialConfig = (): SimConfig => {
  const c = presetConfig('T1');
  return c;
};

export const useStore = create<StoreState>((set, get) => ({
  config: initialConfig(),
  mode: 'sandbox',
  dark: true,
  rightTab: 'live',
  camera: 'orbit',
  followIndex: 0,
  visuals: {
    trails: true,
    trailLength: 4,
    trailColor: 'speed',
    ellipsoids: true,
    ghosts: true,
    commandedPath: true,
    arrows: true,
    separation: true,
    frustums: false,
    exaggerate: 3,
    labels: true,
    racingLine: true,
    searchPath: false,
    nets: true,
  },
  simSpeed: 1,
  recording: true,
  plan: null,
  planStatus: 'idle',
  planProgress: 0,
  planError: null,
  weights: { ...EQUAL_WEIGHTS },
  liveTick: 0,
  trials: [],
  toasts: [],
  editorOpen: false,
  narrationStep: 0,
  leftOpen: { course: false, scenario: true, drones: true, planner: false, filter: true, system: false, visuals: false },
  hoverCell: null,

  setConfig: (fn) => {
    const c = cloneConfig(get().config);
    fn(c);
    set({ config: c });
  },
  replaceConfig: (c) => set({ config: cloneConfig(c) }),
  applyPreset: (id) => {
    const seed = get().config.seed;
    set({ config: presetConfig(id, seed) });
  },
  setMode: (m) => set({ mode: m, narrationStep: 0 }),
  toggleDark: () => set({ dark: !get().dark }),
  setRightTab: (t) => set({ rightTab: t }),
  setCamera: (c) => set({ camera: c }),
  cycleFollow: () => {
    const n = Math.max(1, engine.sim?.n ?? get().config.drones.length);
    const cam = get().camera;
    set({ camera: 'follow', followIndex: cam === 'follow' ? (get().followIndex + 1) % n : get().followIndex % n });
  },
  setVisuals: (v) => set({ visuals: { ...get().visuals, ...v } }),
  setSimSpeed: (s) => {
    engine.simSpeed = s;
    set({ simSpeed: s });
  },
  toggleRecording: () => set({ recording: !get().recording }),
  setPlan: (p) => set({ plan: p }),
  setPlanStatus: (s, progress = 0, error = null) => set({ planStatus: s, planProgress: progress, planError: error }),
  setWeights: (w) => set({ weights: w }),
  bump: () => set({ liveTick: get().liveTick + 1 }),
  addTrial: (t) => {
    const id = trialId++;
    const trials = [{ ...t, id }, ...get().trials].slice(0, 40);
    set({ trials });
    return id;
  },
  updateTrial: (id, patch) => set({ trials: get().trials.map((t) => (t.id === id ? { ...t, ...patch } : t)) }),
  removeTrial: (id) => set({ trials: get().trials.filter((t) => t.id !== id) }),
  clearTrials: () => set({ trials: [] }),
  toast: (text, kind = 'info') => {
    const id = toastId++;
    set({ toasts: [...get().toasts, { id, text, kind }].slice(-4) });
    setTimeout(() => get().dismissToast(id), kind === 'error' ? 8000 : 5000);
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
  setEditorOpen: (o) => set({ editorOpen: o }),
  setNarrationStep: (s) => set({ narrationStep: s }),
  toggleSection: (k) => set({ leftOpen: { ...get().leftOpen, [k]: !get().leftOpen[k] } }),
  setHoverCell: (c) => set({ hoverCell: c }),
}));

/** Short human label of the condition a trial was run under. */
export function conditionLabel(c: SimConfig): string {
  const parts = [c.scenario.preset || c.scenario.type];
  if (c.drones.length > 1) parts.push(`${c.drones.length} drones`);
  parts.push(c.filter.enabled ? `${c.filter.type === 'ecbf' ? `ECBF λ=${c.filter.lambda}` : `braking α=${c.filter.alpha}`}` : 'filter off');
  if (['pinch', 'raceTrack', 'ringCircuit'].includes(c.scenario.type) && c.drones.length > 1) {
    parts.push(c.planner.solver === 'stackelberg' ? `Stackelberg ${c.planner.leader === 0 ? 'A' : 'B'} leads` : c.planner.solver === 'nash' ? 'Nash' : 'Independent');
  }
  return parts.join(' · ');
}

export function evaluate(log: TrialLog, w: Weights): TrialEvaluation {
  return evaluateTrial(log, w);
}

export { defaultConfig };
