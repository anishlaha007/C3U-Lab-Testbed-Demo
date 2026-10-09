/** Safety tab: s(t) per pair, interventions, barrier values, solve-time histogram, M10-M17, M25-M26. */
import { useMemo } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { DRONE_NAMES } from '../../core/constants';
import { courseMetrics, safetyMetrics } from '../../core/metrics/safety';
import { downsample, TimeChart, useChartTheme } from '../charts/common';
import { engine } from '../engine';
import { useStore } from '../store';
import { Card, fmt, pct, Stat } from '../ui';
import { useLive } from './useLive';

const PAIR_COLORS = ['#38bdf8', '#f472b6', '#facc15', '#4ade80', '#a78bfa', '#fb923c', '#2dd4bf', '#f87171', '#c084fc', '#fbbf24', '#60a5fa', '#34d399', '#e879f9', '#a3e635', '#fda4af'];

export function SafetyTab() {
  const { tick } = useLive();
  const config = useStore((s) => s.config);
  const th = useChartTheme();
  const log = engine.log;
  const colors = (log?.drones ?? []).map((_, i) => config.drones[i]?.color ?? '#94a3b8');
  const rows = useMemo(() => {
    if (!log) return [];
    const out: Record<string, number>[] = [];
    for (let k = 0; k < log.t.length; k++) {
      const r: Record<string, number> = { t: log.t[k] };
      log.pairs.forEach((p, q) => {
        r[`s${q}`] = Math.min(6, p.s[k]);
        const h = p.h[k];
        if (Number.isFinite(h)) r[`h${q}`] = Math.max(-5, Math.min(60, h));
      });
      log.drones.forEach((d, i) => {
        r[`u${i}`] = d.correction[k];
      });
      out.push(r);
    }
    return downsample(out, 500);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, log]);
  const sm = useMemo(() => (log ? safetyMetrics(log) : null), [tick, log]); // eslint-disable-line react-hooks/exhaustive-deps
  const cmx = useMemo(() => (log ? courseMetrics(log) : null), [tick, log]); // eslint-disable-line react-hooks/exhaustive-deps
  const hist = useMemo(() => {
    if (!log) return [];
    const xs = log.solveMs.filter((x) => x > 0);
    if (!xs.length) return [];
    const max = Math.max(...xs);
    const bins = 16;
    const w = max / bins || 0.01;
    const counts = new Array(bins).fill(0);
    for (const x of xs) counts[Math.min(bins - 1, Math.floor(x / w))]++;
    return counts.map((c, i) => ({ ms: (i + 0.5) * w, n: c }));
  }, [tick, log]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!log || !sm) return <div className="text-xs text-slate-500">No trial yet.</div>;
  const multi = log.pairs.length > 0;
  const pairName = (q: number) => `${DRONE_NAMES[log.pairs[q].i]}–${DRONE_NAMES[log.pairs[q].j]}`;
  const pairsShown = log.pairs.slice(0, 15);
  return (
    <div className="space-y-2.5">
      <div className="grid grid-cols-3 gap-1.5">
        <Stat label="M10 collisions" value={sm.collisions} tone={sm.collisions ? 'bad' : 'good'} tip="Contacts: centre distance < 0.10 m, gate strikes and obstacle hits." />
        <Stat label="M11 closest" value={Number.isFinite(sm.closestApproach) ? sm.closestApproach.toFixed(2) : '–'} unit="s" tone={sm.closestApproach < 1 ? 'bad' : 'good'} tip="Minimum scaled separation; below 1 is inside the downwash ellipsoid." />
        <Stat label="M12 violation" value={fmt(sm.violationTime, 2)} unit="s" tone={sm.violationTime > 0 ? 'warn' : 'good'} tip="Total time with s < 1." />
        <Stat label="M13 interv." value={pct(sm.interventionRate)} tip="Share of control ticks where the filter changed u by more than 0.05 m/s²." />
        <Stat label="M14 size" value={fmt(sm.interventionSize, 2)} unit="m/s²" tip="Mean correction over intervened ticks." />
        <Stat label="M16 p99 solve" value={fmt(sm.solveP99, 3)} unit="ms" tip="99th percentile filter solve time per tick (wall clock)." />
        <Stat label="M17 planned" value={Number.isFinite(sm.plannedSafety) ? sm.plannedSafety.toFixed(2) : '–'} unit="s" tone={sm.plannedSafety < 1 ? 'warn' : undefined} tip="Minimum scaled separation of the planned trajectories, before flight." />
        <Stat label="M26 obstacle int." value={pct(sm.obstacleInterventionRate)} tip="Share of ticks with a drone-obstacle correction." />
        <Stat label="M25 clearance" value={Number.isFinite(log.summary.obstacleClearance) ? `${(log.summary.obstacleClearance * 100).toFixed(1)}` : '–'} unit="cm" tip="Minimum drone-surface to obstacle-surface distance." />
      </div>
      {cmx && cmx.attempted > 0 && (
        <div className="grid grid-cols-3 gap-1.5">
          <Stat label="M23 pass rate" value={pct(cmx.passRate, 0)} tip="Clean gate passes / gates attempted." />
          <Stat label="M24 strikes" value={cmx.strikes} tone={cmx.strikes ? 'bad' : 'good'} />
          <Stat label="M24 misses" value={cmx.misses} tone={cmx.misses ? 'bad' : 'good'} />
        </div>
      )}
      {multi && (
        <Card title="Scaled separation s(t) per pair" right={<span className="text-[10px] text-slate-500">s &lt; 1: inside the downwash zone</span>}>
          <TimeChart
            data={rows}
            series={pairsShown.map((_, q) => ({ key: `s${q}`, name: pairName(q), color: PAIR_COLORS[q % PAIR_COLORS.length] }))}
            refLines={[
              { y: 1, label: 's = 1', color: '#ef4444' },
              { y: 1.25, color: '#f59e0b' },
            ]}
            yDomain={[0, 'auto']}
            cursorT={engine.replayTime ?? undefined}
          />
        </Card>
      )}
      <Card title="Filter correction |u_safe − u_nom|" right={<span className="text-[10px] text-slate-500">m/s² (ticks above 0.05 count as interventions)</span>}>
        <TimeChart data={rows} series={log.drones.map((_, i) => ({ key: `u${i}`, name: `Drone ${DRONE_NAMES[i]}`, color: colors[i] }))} refLines={[{ y: 0.05, color: '#94a3b8' }]} height={130} />
      </Card>
      {multi && (
        <Card title={`Barrier value ${config.filter.type === 'ecbf' ? 'h = dpᵀDdp − 1' : 'h_b (braking-aware)'}`}>
          <TimeChart data={rows} series={pairsShown.map((_, q) => ({ key: `h${q}`, name: pairName(q), color: PAIR_COLORS[q % PAIR_COLORS.length] }))} refLines={[{ y: 0, color: '#ef4444' }]} height={130} />
        </Card>
      )}
      <Card title="Filter solve time histogram" right={<span className="text-[10px] text-slate-500">ms per control tick</span>}>
        <div style={{ height: 110 }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={hist} margin={{ top: 4, right: 8, bottom: 12, left: 0 }}>
              <CartesianGrid stroke={th.grid} strokeDasharray="3 3" />
              <XAxis dataKey="ms" tick={{ fontSize: 9, fill: th.axis }} tickFormatter={(v: number) => v.toFixed(3)} />
              <YAxis width={34} tick={{ fontSize: 9, fill: th.axis }} />
              <Tooltip contentStyle={{ background: th.tooltipBg, border: `1px solid ${th.tooltipBorder}`, fontSize: 11 }} formatter={(v) => [String(v), 'ticks']} labelFormatter={(v) => `${Number(v).toFixed(3)} ms`} />
              <Bar dataKey="n" fill="#38bdf8" isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Card>
      {log.summary.ecbfInitWarnings > 0 && (
        <div className="rounded border border-amber-400 bg-amber-50 p-1.5 text-[11px] text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">
          ⚠ Exponential CBF initial condition h′ + λh ≥ 0 was violated at filter activation for {log.summary.ecbfInitWarnings} pair(s) (Ames et al. 2019, Theorem 8): forward invariance is not guaranteed from that state.
        </div>
      )}
    </div>
  );
}
