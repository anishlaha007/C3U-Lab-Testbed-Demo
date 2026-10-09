import { lazy, Suspense, useEffect, useRef } from 'react';
import { HONESTY_LABEL, PLANNER_LABEL } from '../core/constants';
import { evaluateTrial } from '../core/metrics/scorecard';
import { engine } from './engine';
import { LeftSidebar, PLANNER_TYPES } from './panels/LeftSidebar';
import { RightPanel } from './panels/RightPanel';
import { Timeline } from './panels/Timeline';
import { Toasts } from './panels/Toasts';
import { TopBar } from './panels/TopBar';
import { SceneRoot } from './scene/SceneRoot';
import { planKey } from '../core/planners/plan';
import { isRaceScenario } from '../core/race';
import type { SimConfig } from '../core/types';
import { requestSolve } from './planner';
import { configFromHash, takeScreenshot } from './share';
import { conditionLabel, useStore, type CameraMode } from './store';
import { cx } from './ui';

const MilestoneCard = lazy(() => import('./milestones/MilestoneCard').then((m) => ({ default: m.MilestoneCard })));
const CourseEditor = lazy(() => import('./panels/CourseEditor').then((m) => ({ default: m.CourseEditor })));

/** Keeps the engine in sync with the configuration and records finished trials. */
function EngineSync() {
  const config = useStore((s) => s.config);
  const plan = useStore((s) => s.plan);
  const timer = useRef<number | null>(null);
  const lastLoad = useRef<{ config: SimConfig | null; planKey: string | null }>({ config: null, planKey: null });
  useEffect(() => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      const current = plan && plan.key === planKey(config) ? plan : null;
      const sameConfig = lastLoad.current.config === config;
      // a plan arriving while a trial is flying waits for the next reset instead of interrupting it
      if (sameConfig && current && (engine.status === 'running' || engine.status === 'paused')) {
        useStore.getState().toast('New plan ready: press Reset (R) to fly it.', 'info');
        return;
      }
      if (sameConfig && (current?.key ?? null) === lastLoad.current.planKey) return;
      lastLoad.current = { config, planKey: current?.key ?? null };
      engine.load(config, current);
      useStore.getState().bump();
      // race scenarios: solve the game in the background when the plan is missing or stale
      if (isRaceScenario(config) && !current) void requestSolve(true);
    }, 120);
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [config, plan]);

  useEffect(
    () =>
      engine.onDone((log) => {
        const st = useStore.getState();
        const ev = evaluateTrial(log, st.weights);
        const cfg = engine.config ?? st.config;
        if (st.recording) {
          st.addTrial({ name: `${cfg.scenario.preset || cfg.scenario.type} #${log.seed}`, condition: conditionLabel(cfg), config: cfg, log, evaluation: ev });
        }
        const rm = ev.tracking.map((t) => t.rmse).filter(Number.isFinite);
        const rmse = rm.length ? rm.reduce((a, b) => a + b, 0) / rm.length : NaN;
        const kind = ev.scorecard.G === 0 ? 'error' : ev.scorecard.G < 1 ? 'warning' : 'success';
        st.toast(
          `Trial ${log.summary.endReason}: score ${ev.scorecard.score.toFixed(2)} (G = ${ev.scorecard.G}${ev.scorecard.G < 1 ? `, ${ev.scorecard.gateReason}` : ''}), RMSE ${(rmse * 100).toFixed(1)} cm, closest s ${Number.isFinite(ev.safety.closestApproach) ? ev.safety.closestApproach.toFixed(2) : '–'}.`,
          kind,
        );
        st.bump();
      }),
    [],
  );
  return null;
}

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || e.metaKey || e.ctrlKey || e.altKey) return;
      const st = useStore.getState();
      switch (e.key) {
        case ' ':
          e.preventDefault();
          engine.toggle();
          break;
        case 'r':
        case 'R':
          st.replaceConfig(st.config);
          break;
        case '.':
          engine.stepOnce();
          break;
        case 'f':
        case 'F':
          st.cycleFollow();
          break;
        case 't':
        case 'T':
          st.setCamera(st.camera === 'top' ? 'orbit' : 'top');
          break;
        case 'v':
        case 'V':
          st.setCamera(st.camera === 'fpv' ? 'orbit' : 'fpv');
          break;
        case 'e':
        case 'E':
          st.setEditorOpen(!st.editorOpen);
          break;
        case 'k':
        case 'K':
          engine.kill();
          break;
        case '1':
          st.setMode('m1');
          break;
        case '2':
          st.setMode('m2');
          break;
        case '3':
          st.setMode('m3');
          break;
        case 's':
        case 'S':
          takeScreenshot();
          break;
        case 'Escape':
          st.setCamera('orbit');
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

const CAMS: { value: CameraMode; label: string; key?: string }[] = [
  { value: 'orbit', label: 'Orbit' },
  { value: 'follow', label: 'Follow', key: 'F' },
  { value: 'top', label: 'Top', key: 'T' },
  { value: 'chase', label: 'Chase' },
  { value: 'side', label: 'Side' },
  { value: 'fpv', label: 'FPV', key: 'V' },
  { value: 'cinematic', label: 'Cinematic' },
];

function ViewHud() {
  const camera = useStore((s) => s.camera);
  const setCamera = useStore((s) => s.setCamera);
  const cycleFollow = useStore((s) => s.cycleFollow);
  const followIndex = useStore((s) => s.followIndex);
  const config = useStore((s) => s.config);
  const planner = PLANNER_TYPES.includes(config.scenario.type) && config.drones.length > 1;
  return (
    <>
      <div className="absolute top-2 left-2 z-10 flex flex-wrap gap-1">
        {CAMS.map((c) => (
          <button
            key={c.value}
            onClick={() => (c.value === 'follow' ? cycleFollow() : setCamera(c.value))}
            className={cx(
              'rounded px-2 py-0.5 text-[11px] backdrop-blur',
              camera === c.value ? 'bg-sky-600 text-white' : 'bg-white/70 text-slate-700 hover:bg-white dark:bg-slate-900/70 dark:text-slate-300 dark:hover:bg-slate-800',
            )}
            title={c.key ? `${c.label} (${c.key})` : c.label}
          >
            {c.label}
            {c.value === 'follow' && camera === 'follow' ? ` ${String.fromCharCode(65 + followIndex)}` : ''}
          </button>
        ))}
      </div>
      <div className="pointer-events-none absolute bottom-2 left-2 z-10 max-w-md rounded bg-white/70 px-2 py-1 text-[10px] text-slate-600 backdrop-blur dark:bg-slate-900/70 dark:text-slate-400">
        {HONESTY_LABEL}
        {planner && <> Planners: {PLANNER_LABEL.toLowerCase()}.</>}
      </div>
    </>
  );
}

export default function App() {
  const dark = useStore((s) => s.dark);
  const mode = useStore((s) => s.mode);
  const editorOpen = useStore((s) => s.editorOpen);
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
  }, [dark]);
  useEffect(() => {
    const c = configFromHash();
    if (c) {
      useStore.getState().replaceConfig(c);
      useStore.getState().toast('Loaded the setup from the link.', 'info');
    }
  }, []);
  useShortcuts();
  return (
    <div className="flex h-full flex-col text-slate-900 dark:text-slate-100">
      <EngineSync />
      <TopBar />
      <div className="flex min-h-0 flex-1">
        <LeftSidebar />
        <main className="relative min-w-0 flex-1">
          <SceneRoot dark={dark} />
          <ViewHud />
          {mode !== 'sandbox' && (
            <Suspense fallback={null}>
              <MilestoneCard />
            </Suspense>
          )}
          <Toasts />
        </main>
        <RightPanel />
      </div>
      <Timeline />
      {editorOpen && (
        <Suspense fallback={null}>
          <CourseEditor />
        </Suspense>
      )}
    </div>
  );
}
