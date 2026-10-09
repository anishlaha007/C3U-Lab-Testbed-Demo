/** Top bar: title, scenario presets, mode tabs, transport controls, sim speed, seed, record. */
import { useSyncExternalStore } from 'react';
import { HONESTY_LABEL } from '../../core/constants';
import { SCENARIO_PRESETS } from '../../core/presets';
import { engine } from '../engine';
import { copyLink, takeScreenshot } from '../share';
import { useStore, type Mode } from '../store';
import { ExportMenu } from './ExportMenu';
import { ImportButton } from './FileDrop';
import { Button, Select, Tabs, Tip } from '../ui';

const MODES: { value: Mode; label: string; short: string; title: string }[] = [
  { value: 'sandbox', label: 'Sandbox', short: 'Sandbox', title: 'Free exploration of every setting' },
  { value: 'm1', label: 'Milestone 1', short: 'M1', title: 'Milestone 1: nominal trajectory tracking (key 1)' },
  { value: 'm2', label: 'Milestone 2', short: 'M2', title: 'Milestone 2: safety-filtered tracking (key 2)' },
  { value: 'm3', label: 'Milestone 3', short: 'M3', title: 'Milestone 3: game-theoretic racing (key 3)' },
  { value: 'scorecard', label: 'Scorecard', short: 'Scorecard', title: 'How every run is scored' },
];

/** True while the viewport is at least `px` wide (keeps the top bar on one row on laptops). */
function useMinWidth(px: number): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia(`(min-width: ${px}px)`);
      mq.addEventListener('change', cb);
      return () => mq.removeEventListener('change', cb);
    },
    () => window.matchMedia(`(min-width: ${px}px)`).matches,
  );
}

export function useEngineStatus() {
  return useSyncExternalStore(
    (cb) => engine.subscribe(cb),
    () => `${engine.status}|${engine.playing}|${engine.replayPlaying}|${engine.replayTime !== null}|${engine.generation}`,
  );
}

export function TopBar() {
  const wide = useMinWidth(1800);
  const medium = useMinWidth(1500);
  const xwide = useMinWidth(2200);
  const config = useStore((s) => s.config);
  const mode = useStore((s) => s.mode);
  const setMode = useStore((s) => s.setMode);
  const applyPreset = useStore((s) => s.applyPreset);
  const simSpeed = useStore((s) => s.simSpeed);
  const setSimSpeed = useStore((s) => s.setSimSpeed);
  const setConfig = useStore((s) => s.setConfig);
  const recording = useStore((s) => s.recording);
  const toggleRecording = useStore((s) => s.toggleRecording);
  const dark = useStore((s) => s.dark);
  const toggleDark = useStore((s) => s.toggleDark);
  const toast = useStore((s) => s.toast);
  useEngineStatus();
  const running = engine.playing || engine.replayPlaying;
  const canPlay = engine.status !== 'invalid' && !!engine.sim;

  return (
    <header className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-slate-300 bg-white/90 px-3 py-1.5 dark:border-slate-800 dark:bg-slate-950/90">
      <div className="flex items-center gap-2">
        <svg viewBox="0 0 32 32" className="h-6 w-6">
          <rect width="32" height="32" rx="6" fill="#0b1220" />
          <g stroke="#38bdf8" strokeWidth="2.5" strokeLinecap="round">
            <line x1="9" y1="9" x2="23" y2="23" />
            <line x1="23" y1="9" x2="9" y2="23" />
          </g>
          <g fill="#0b1220" stroke="#f472b6" strokeWidth="2">
            <circle cx="8" cy="8" r="4" />
            <circle cx="24" cy="8" r="4" />
            <circle cx="8" cy="24" r="4" />
            <circle cx="24" cy="24" r="4" />
          </g>
        </svg>
        {/* the full title only where there is room, so the bar stays on one row on laptops */}
        {wide ? (
          <div className="leading-tight">
            <div className="text-sm font-semibold">C3U Multi-Drone Racing Testbed</div>
            <div className="text-[10px] text-slate-500">Georgia Tech AE · C3U Lab · browser simulator</div>
          </div>
        ) : (
          <div className="text-sm font-semibold whitespace-nowrap" title="C3U Multi-Drone Racing Testbed · Georgia Tech AE · C3U Lab">
            C3U Testbed
          </div>
        )}
      </div>

      <div className="w-48">
        <Select
          value={config.scenario.preset || ''}
          options={[{ value: '', label: 'Custom scenario' }, ...SCENARIO_PRESETS.map((p) => ({ value: p.id, label: p.name }))]}
          onChange={(v) => v && applyPreset(v)}
        />
      </div>

      <Tabs value={mode} options={MODES.map((m) => ({ value: m.value, label: medium ? m.label : m.short, title: m.title }))} onChange={setMode} />

      <div className="flex items-center gap-1">
        <Button kind="primary" onClick={() => engine.toggle()} disabled={!canPlay} title="Play / pause (Space)">
          {running ? '❚❚ Pause' : '▶ Play'}
        </Button>
        <Button onClick={() => engine.stepOnce()} disabled={!canPlay} title="Step one control tick (.)">
          Step
        </Button>
        <Button onClick={() => useStore.getState().replaceConfig(useStore.getState().config)} title="Reset the trial (R)">
          Reset
        </Button>
        <Button kind="danger" onClick={() => engine.kill()} disabled={!engine.sim || engine.sim.done} title="Kill switch: motors off (K)">
          Kill
        </Button>
      </div>

      <div className="flex items-center gap-1 text-[11px] text-slate-500">
        <select
          title="Simulation speed (multiple of real time)"
          className="rounded border border-slate-300 bg-white px-1 py-0.5 dark:border-slate-700 dark:bg-slate-900"
          value={simSpeed}
          onChange={(e) => setSimSpeed(Number(e.target.value))}
        >
          {[0.1, 0.25, 0.5, 1, 2, 4].map((s) => (
            <option key={s} value={s}>
              {s}x
            </option>
          ))}
        </select>
        <span className="ml-1">Seed</span>
        <input
          type="number"
          className="w-12 rounded border border-slate-300 bg-white px-1 py-0.5 dark:border-slate-700 dark:bg-slate-900"
          value={config.seed}
          onChange={(e) => setConfig((c) => (c.seed = Math.max(0, Math.floor(Number(e.target.value) || 0))))}
        />
        <Tip text="Record: every completed trial is kept in the Results tab for comparison and scoring.">
          <button className={`ml-2 flex items-center gap-1 rounded px-1.5 py-0.5 ${recording ? 'text-rose-500' : 'text-slate-500'}`} onClick={toggleRecording}>
            <span className={`inline-block h-2 w-2 rounded-full ${recording ? 'animate-pulse bg-rose-500' : 'bg-slate-400'}`} /> Rec
          </button>
        </Tip>
      </div>

      <div className="ml-auto flex items-center gap-1.5">
        {/* compact honesty label (the full sentence is also shown persistently over the 3D view) */}
        <span title={HONESTY_LABEL} className="rounded bg-amber-100 px-2 py-0.5 text-[10px] whitespace-nowrap text-amber-900 dark:bg-amber-500/15 dark:text-amber-300">
          {xwide ? HONESTY_LABEL : 'Simulation · illustrative'}
        </span>
        <ImportButton small label="Import…" />
        <ExportMenu />
        <Button small kind="ghost" title="Copy a link to this setup" onClick={() => copyLink(config).then((ok) => toast(ok ? 'Link to this setup copied.' : 'Could not copy the link.', ok ? 'success' : 'error'))}>
          Link
        </Button>
        <Button small kind="ghost" title="Screenshot (S)" onClick={() => takeScreenshot()}>
          Shot
        </Button>
        <Button small kind="ghost" onClick={toggleDark} title={dark ? 'Switch to the light theme' : 'Switch to the dark theme'}>
          {dark ? '☀' : '☾'}
        </Button>
      </div>
    </header>
  );
}
