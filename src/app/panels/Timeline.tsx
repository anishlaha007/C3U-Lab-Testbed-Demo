/**
 * Bottom timeline: scrubber over the recorded trial with event markers (interventions,
 * violations, overtakes, emergency stops, collisions, gates). Click to jump; replay at any speed.
 */
import { useMemo, useRef } from 'react';
import type { SimEventType } from '../../core/types';
import { engine } from '../engine';
import { useLive } from './useLive';

const EVENT_STYLE: Partial<Record<SimEventType, { color: string; label: string; row: number }>> = {
  intervention: { color: '#facc15', label: 'intervention', row: 0 },
  violation: { color: '#f97316', label: 'separation violation', row: 1 },
  overtake: { color: '#a78bfa', label: 'overtake', row: 1 },
  emergency: { color: '#ef4444', label: 'emergency brake', row: 2 },
  collision: { color: '#dc2626', label: 'collision', row: 2 },
  gateStrike: { color: '#dc2626', label: 'gate strike', row: 2 },
  obstacleHit: { color: '#dc2626', label: 'obstacle hit', row: 2 },
  arenaExit: { color: '#dc2626', label: 'left the arena', row: 2 },
  kill: { color: '#dc2626', label: 'kill', row: 2 },
  gatePass: { color: '#22c55e', label: 'gate pass', row: 3 },
  gateMiss: { color: '#ef4444', label: 'gate miss', row: 3 },
  lap: { color: '#38bdf8', label: 'lap', row: 3 },
  geofence: { color: '#fb923c', label: 'geofence', row: 2 },
  stale: { color: '#fb923c', label: 'stale setpoint', row: 2 },
  viconJump: { color: '#94a3b8', label: 'Vicon jump rejected', row: 1 },
  finish: { color: '#22c55e', label: 'finish', row: 3 },
};

export function Timeline() {
  useLive();
  const bar = useRef<HTMLDivElement>(null);
  const log = engine.log;
  const end = Math.max(engine.sim?.raceEnd ?? 0, engine.logEnd(), 0.001) + (engine.sim?.cfg.extraTime ?? 0) * (engine.sim?.done ? 0 : 1);
  const tNow = engine.time;
  const markers = useMemo(() => {
    if (!log) return [];
    return log.events.filter((e) => EVENT_STYLE[e.type]).slice(0, 1500);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [log, log?.events.length]);
  const seekAt = (clientX: number) => {
    const el = bar.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    engine.seek(f * end);
  };
  const recorded = engine.logEnd();
  return (
    <div className="flex items-center gap-3 border-t border-slate-300 bg-white/90 px-3 py-1.5 text-[11px] dark:border-slate-800 dark:bg-slate-950/90">
      <span className="tabular w-32 shrink-0 font-mono whitespace-nowrap text-slate-600 dark:text-slate-400">
        t {tNow.toFixed(2)} / {end.toFixed(1)} s
      </span>
      <div
        ref={bar}
        className="relative h-9 flex-1 cursor-pointer rounded bg-slate-200 dark:bg-slate-800"
        onMouseDown={(e) => {
          seekAt(e.clientX);
          const move = (ev: MouseEvent) => seekAt(ev.clientX);
          const up = () => {
            window.removeEventListener('mousemove', move);
            window.removeEventListener('mouseup', up);
          };
          window.addEventListener('mousemove', move);
          window.addEventListener('mouseup', up);
        }}
        title="Click or drag to jump; press Play after the trial ends to replay"
      >
        {/* recorded span */}
        <div className="absolute inset-y-0 left-0 rounded bg-sky-500/15" style={{ width: `${(recorded / end) * 100}%` }} />
        {markers.map((e, i) => {
          const st = EVENT_STYLE[e.type]!;
          return <div key={i} className="absolute w-[2px]" style={{ left: `${(e.t / end) * 100}%`, top: 2 + st.row * 8, height: 6, background: st.color }} title={`${st.label} at ${e.t.toFixed(2)} s${e.drone !== undefined ? ` (drone ${e.drone + 1})` : ''}`} />;
        })}
        {engine.sim && <div className="absolute inset-y-0 w-0.5 bg-slate-900 dark:bg-white" style={{ left: `${Math.min(100, (tNow / end) * 100)}%` }} />}
      </div>
      <div className="flex w-56 flex-wrap gap-x-2 gap-y-0.5 text-[9px] text-slate-500">
        {[
          ['#facc15', 'interv.'],
          ['#f97316', 'violation'],
          ['#a78bfa', 'overtake'],
          ['#ef4444', 'emerg./coll.'],
          ['#22c55e', 'gate/lap'],
        ].map(([c, l]) => (
          <span key={l} className="flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-sm" style={{ background: c }} />
            {l}
          </span>
        ))}
        {engine.replayTime !== null && (
          <button className="rounded bg-sky-600 px-1.5 text-white" onClick={() => engine.goLive()}>
            live
          </button>
        )}
      </div>
    </div>
  );
}
