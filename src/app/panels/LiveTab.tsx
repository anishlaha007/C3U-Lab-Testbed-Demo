/** Live tab: per-drone cards and a live scorecard. */
import { useMemo } from 'react';
import { DRONE_NAMES } from '../../core/constants';
import { evaluateTrial } from '../../core/metrics/scorecard';
import { CHECK_NAMES } from '../../core/validator';
import { engine } from '../engine';
import { useStore } from '../store';
import { Badge, Card, fmt, pct } from '../ui';
import { useLive } from './useLive';

const MODE_NAMES = ['flying', 'hover', 'emergency brake', 'killed', 'crashed'];

export function SubScoreBars({ sub, G, score }: { sub: { S: number; V: number; A: number; E: number }; G: number; score: number }) {
  const rows: [string, number, string, string][] = [
    ['S', sub.S, 'Safety: 0.5 [(1 − M13) + min(1, M11)]', '#22c55e'],
    ['V', sub.V, 'Speed: planned lap time / actual lap time', '#38bdf8'],
    ['A', sub.A, 'Accuracy: 1 − RMSE / 0.30 m', '#a78bfa'],
    ['E', sub.E, 'Efficiency: planned effort / actual effort', '#f59e0b'],
  ];
  return (
    <div className="space-y-1">
      {rows.map(([k, v, tip, c]) => (
        <div key={k} className="flex items-center gap-2 text-[11px]" title={tip}>
          <span className="w-3 font-semibold">{k}</span>
          <div className="h-2 flex-1 overflow-hidden rounded bg-slate-200 dark:bg-slate-800">
            <div className="h-full rounded" style={{ width: `${Math.max(0, Math.min(1, v)) * 100}%`, background: c }} />
          </div>
          <span className="tabular w-9 text-right font-mono">{fmt(v, 2)}</span>
        </div>
      ))}
      <div className="mt-1 flex items-center gap-2 border-t border-slate-200 pt-1 text-xs dark:border-slate-800">
        <span title="Gate factor: 0 collision / arena exit / kill / missed gate, 0.5 emergency brake, 0.75 separation violation, else 1">
          G = <b className={G === 1 ? 'text-emerald-500' : G === 0 ? 'text-rose-500' : 'text-amber-500'}>{G}</b>
        </span>
        <span className="ml-auto">
          Score <b className="tabular font-mono text-sm">{fmt(score, 2)}</b>
        </span>
      </div>
    </div>
  );
}

export function ValidationPanel() {
  const v = engine.validation;
  if (engine.error) return <div className="rounded border border-rose-400 bg-rose-50 p-2 text-[11px] text-rose-800 dark:bg-rose-500/10 dark:text-rose-300">Scenario error: {engine.error}</div>;
  if (!v) return null;
  if (!v.issues.length) return <div className="text-[11px] text-emerald-600 dark:text-emerald-400">{'✔'} Validator: all 5 pre-flight checks pass.</div>;
  return (
    <div className="space-y-1">
      {v.issues.map((x, i) => (
        <div key={i} className={`rounded border p-1.5 text-[11px] leading-snug ${x.level === 'error' ? 'border-rose-400 bg-rose-50 text-rose-800 dark:bg-rose-500/10 dark:text-rose-300' : 'border-amber-400 bg-amber-50 text-amber-900 dark:bg-amber-500/10 dark:text-amber-200'}`}>
          <b>
            Check {x.check} ({CHECK_NAMES[x.check]}) {x.level === 'error' ? 'blocks the run' : 'warning'}:
          </b>{' '}
          {x.message}
        </div>
      ))}
    </div>
  );
}

export function LiveTab() {
  const { tick } = useLive();
  const config = useStore((s) => s.config);
  const weights = useStore((s) => s.weights);
  const sim = engine.sim;
  const view = engine.view();
  const evaluation = useMemo(() => {
    const sim = engine.sim;
    if (!sim || sim.log.t.length < 5) return null;
    try {
      return sim.done ? evaluateTrial(sim.log, weights) : evaluateTrial(sim.liveLog(), weights, true);
    } catch {
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, weights, engine.generation]);
  const raceEnd = sim?.raceEnd ?? 0;

  return (
    <div className="space-y-2.5">
      <Card title="Trial" right={<Badge tone={engine.status === 'done' ? 'emerald' : engine.status === 'running' ? 'sky' : engine.status === 'invalid' ? 'rose' : 'slate'}>{engine.status}</Badge>}>
        <div className="mb-1.5 flex items-center gap-3 text-[11px] text-slate-600 dark:text-slate-400">
          <span>
            t = <b className="tabular font-mono">{fmt(engine.time, 2)}</b> / {fmt(raceEnd, 1)} s
          </span>
          {engine.build && <span>{engine.build.name}</span>}
          {sim && <span>latency {(sim.tauS * 1000).toFixed(0)}+{(sim.tauC * 1000).toFixed(0)} ms</span>}
        </div>
        <ValidationPanel />
        {sim?.done && <div className="mt-1 text-[11px] text-slate-500">Ended: {sim.log.summary.endReason}. Scrub the timeline to replay.</div>}
      </Card>

      <div className="grid grid-cols-2 gap-2">
        {view.drones.map((d, i) => {
          const sd = sim?.drones[i];
          const err = d.ref ? Math.hypot(d.p.x - d.ref.x, d.p.y - d.ref.y, d.p.z - d.ref.z) : NaN;
          return (
            <div key={i} className="rounded-md border border-slate-200 bg-white/70 p-2 text-[11px] dark:border-slate-800 dark:bg-slate-900/50">
              <div className="mb-1 flex items-center gap-1.5">
                <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: d.color }} />
                <b>Drone {DRONE_NAMES[i]}</b>
                <span className={`ml-auto inline-block h-2 w-2 rounded-full ${d.intervened ? 'bg-amber-400' : 'bg-slate-300 dark:bg-slate-700'}`} title={d.intervened ? 'Filter active' : 'Filter idle'} />
              </div>
              <div className="tabular grid grid-cols-2 gap-x-2 font-mono">
                <span className="text-slate-500">speed</span>
                <span className="text-right">{fmt(d.speed, 2)} m/s</span>
                <span className="text-slate-500">error</span>
                <span className="text-right">{fmt(err * 100, 1)} cm</span>
                <span className="text-slate-500">near s</span>
                <span className={`text-right ${d.nearestS < 1 ? 'text-rose-500' : d.nearestS < 1.25 ? 'text-amber-500' : ''}`}>{Number.isFinite(d.nearestS) ? d.nearestS.toFixed(2) : '–'}</span>
                <span className="text-slate-500">battery</span>
                <span className="text-right">{pct(d.twr01, 0)}</span>
                {sd && sd.visits.length > 0 && (
                  <>
                    <span className="text-slate-500">gates</span>
                    <span className="text-right">
                      {sd.passes}/{sd.visits.length}
                      {sd.misses + sd.strikes > 0 ? ` (${sd.misses + sd.strikes}✗)` : ''}
                    </span>
                  </>
                )}
              </div>
              <div className="mt-1 text-[10px] text-slate-500">
                {MODE_NAMES[d.mode] ?? ''}
                {sd?.exec.mode && sd.exec.mode !== 'nominal' ? ` · ref ${sd.exec.mode}` : ''}
              </div>
            </div>
          );
        })}
      </div>

      <Card title={engine.sim?.done ? 'Scorecard' : 'Live scorecard (provisional)'} right={<span className="text-[10px] text-slate-500">Score = G × weighted mean</span>}>
        {evaluation ? <SubScoreBars sub={evaluation.scorecard.sub} G={evaluation.scorecard.G} score={evaluation.scorecard.score} /> : <div className="text-[11px] text-slate-500">Press Play to fly the trial.</div>}
        {evaluation && evaluation.scorecard.G < 1 && <div className="mt-1 text-[10px] text-rose-500">Gate: {evaluation.scorecard.gateReason}</div>}
      </Card>
      {config.drones.length > 0 && <div className="text-[10px] text-slate-500">Every number here is from an idealised simulation and is illustrative only.</div>}
    </div>
  );
}
