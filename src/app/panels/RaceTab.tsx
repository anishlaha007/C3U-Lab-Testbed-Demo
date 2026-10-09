/** Race tab: progress s_i(t) per drone, the gap, overtakes and predicted vs realised outcome (M18-M21). */
import { useMemo } from 'react';
import { DRONE_NAMES } from '../../core/constants';
import { raceResult } from '../../core/metrics/racing';
import { windowLength } from '../../core/metrics/window';
import { downsample, TimeChart } from '../charts/common';
import { engine } from '../engine';
import { useStore } from '../store';
import { Badge, Card, fmt, Stat } from '../ui';
import { useLive } from './useLive';

/** Realised progress gap at a given time (for prediction fidelity, M20). */
export function gapAt(log: NonNullable<typeof engine.log>, t: number): number {
  if (log.drones.length < 2 || !log.t.length) return NaN;
  const k = Math.max(0, Math.min(log.t.length - 1, Math.round(t / log.dtLog)));
  return log.drones[0].progress[k] - log.drones[1].progress[k];
}

export function RaceTab() {
  const { tick } = useLive();
  const config = useStore((s) => s.config);
  const plan = useStore((s) => s.plan);
  const planStatus = useStore((s) => s.planStatus);
  const log = engine.log;
  const hasTrack = !!engine.build?.track;
  const colors = (log?.drones ?? []).map((_, i) => config.drones[i]?.color ?? '#94a3b8');
  const rows = useMemo(() => {
    if (!log || !hasTrack) return [];
    const n = Math.max(windowLength(log), Math.min(log.t.length, 1));
    const out: Record<string, number>[] = [];
    for (let k = 0; k < Math.min(log.t.length, n + 25); k++) {
      const r: Record<string, number> = { t: log.t[k] };
      log.drones.forEach((d, i) => (r[`s${i}`] = d.progress[k]));
      if (log.drones.length >= 2) r.gap = log.drones[0].progress[k] - log.drones[1].progress[k];
      out.push(r);
    }
    return downsample(out, 500);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, log, hasTrack]);
  const rr = useMemo(() => (log && hasTrack ? raceResult(log) : null), [tick, log, hasTrack]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!log) return <div className="text-xs text-slate-500">No trial yet.</div>;
  if (!hasTrack)
    return (
      <div className="space-y-2 text-xs text-slate-500">
        <p>Racing metrics need a race track: choose T4 Pinch, T9 Race loop or a ring course (T12-T14, Course section).</p>
      </div>
    );
  const pred = log.planned.predictedGap;
  const horizon = log.planned.predictionHorizon;
  const realisedAtHorizon = horizon !== undefined && engine.time >= horizon ? gapAt(log, horizon) : NaN;
  const two = log.drones.length >= 2;
  return (
    <div className="space-y-2.5">
      <Card
        title="Plan"
        right={
          <Badge tone={planStatus === 'solving' ? 'amber' : plan ? 'violet' : 'slate'}>
            {planStatus === 'solving' ? 'solving…' : plan ? `${plan.solver}${plan.solver === 'stackelberg' ? (plan.leader ? ' (B leads)' : ' (A leads)') : ''}` : 'default (unsolved)'}
          </Badge>
        }
      >
        <p className="text-[11px] leading-snug text-slate-600 dark:text-slate-400">{plan ? plan.note : 'Every drone flies the centreline at full speed until the planner returns.'}</p>
        {plan && (
          <div className="mt-1 text-[11px] text-slate-500">
            Strategies: {plan.choice.map((k, d) => `${DRONE_NAMES[d]} ${plan.candidates[d][k]?.label}`).join(' · ')}
          </div>
        )}
      </Card>
      <div className="grid grid-cols-3 gap-1.5">
        <Stat label="Winner" value={rr && rr.winner >= 0 ? DRONE_NAMES[rr.winner] : '–'} tip="First to finish the gates, otherwise the most progress; a crashed drone cannot win." />
        <Stat label="M19 final gap" value={two ? fmt(rr?.gap, 2) : '–'} unit="m" tip="s_A − s_B at the end of the race window." />
        <Stat label="M21 overtakes" value={two ? (rr?.overtakes ?? 0) : '–'} tip="Sign changes of s_A − s_B (5 cm hysteresis)." />
        <Stat label="Predicted winner" value={log.planned.predictedWinner !== undefined ? DRONE_NAMES[log.planned.predictedWinner] : '–'} tip="From the planner's rollout of the chosen strategies." />
        <Stat label="Predicted gap" value={fmt(pred, 2)} unit="m" tip={`Progress gap the planner predicted at its horizon T = ${fmt(horizon, 1)} s.`} />
        <Stat
          label="M20 realised/pred."
          value={Number.isFinite(realisedAtHorizon) && pred ? fmt(realisedAtHorizon / pred, 2) : '–'}
          tip="Realised gap at the planner's horizon divided by the predicted gap (1 = perfect prediction)."
          tone={Number.isFinite(realisedAtHorizon) && pred ? (Math.sign(realisedAtHorizon) === Math.sign(pred) ? 'good' : 'bad') : undefined}
        />
      </div>
      <Card title="Progress along the track s_i(t)">
        <TimeChart data={rows} series={log.drones.map((_, i) => ({ key: `s${i}`, name: `Drone ${DRONE_NAMES[i]}`, color: colors[i] }))} yLabel="m" cursorT={engine.replayTime ?? undefined} />
      </Card>
      {two && (
        <Card title="Gap s_A − s_B" right={<span className="text-[10px] text-slate-500">above 0: A ahead</span>}>
          <TimeChart data={rows} series={[{ key: 'gap', name: 'gap', color: '#a78bfa' }]} refLines={[{ y: 0, color: '#94a3b8' }, ...(Number.isFinite(pred) ? [{ y: pred!, label: 'predicted', color: '#f59e0b' }] : [])]} yLabel="m" height={130} />
        </Card>
      )}
      <p className="text-[10px] text-slate-500">Win rates with Wilson intervals (M18) and prediction fidelity across races come from the race series in the Results tab.</p>
    </div>
  );
}
