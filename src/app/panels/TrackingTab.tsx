/** Tracking tab: error vs time, along / cross-track split, commanded vs executed path (top view), M1-M9. */
import { useMemo, useState } from 'react';
import { DRONE_NAMES } from '../../core/constants';
import { errorSeries, trackingMetrics } from '../../core/metrics/tracking';
import { windowLength } from '../../core/metrics/window';
import type { TrialLog } from '../../core/types';
import { downsample, TimeChart } from '../charts/common';
import { engine } from '../engine';
import { useStore } from '../store';
import { Card, cm, fmt, pct, Tabs } from '../ui';
import { useLive } from './useLive';

export function TopView({ log, colors, height = 210 }: { log: TrialLog; colors: string[]; height?: number }) {
  const arena = engine.build?.arena ?? { sx: 8, sy: 5, sz: 3 };
  const W = 300;
  const H = (W * arena.sy) / arena.sx;
  const sx = (x: number) => ((x + arena.sx / 2) / arena.sx) * W;
  const sy = (y: number) => H - ((y + arena.sy / 2) / arena.sy) * H;
  const n = windowLength(log) || log.t.length;
  const paths = log.drones.map((d) => {
    const step = Math.max(1, Math.floor(n / 500));
    let ref = '';
    let act = '';
    for (let k = 0; k < Math.min(n, d.px.length); k += step) {
      ref += `${k ? 'L' : 'M'}${sx(d.rx[k]).toFixed(1)},${sy(d.ry[k]).toFixed(1)}`;
      act += `${k ? 'L' : 'M'}${sx(d.px[k]).toFixed(1)},${sy(d.py[k]).toFixed(1)}`;
    }
    return { ref, act };
  });
  const gates = engine.build?.course?.gates ?? [];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ height, width: '100%' }} className="rounded bg-slate-100 dark:bg-slate-950">
      <rect x={sx(-arena.sx / 2 + 0.3)} y={sy(arena.sy / 2 - 0.3)} width={sx(arena.sx / 2 - 0.3) - sx(-arena.sx / 2 + 0.3)} height={sy(-arena.sy / 2 + 0.3) - sy(arena.sy / 2 - 0.3)} fill="none" stroke="#94a3b8" strokeDasharray="3 3" strokeWidth={0.6} />
      {gates.map((g, i) => {
        const r = (g.diameter / 2 / arena.sx) * W;
        const dx = -Math.sin(g.yaw) * r;
        const dy = Math.cos(g.yaw) * r;
        return <line key={i} x1={sx(g.center.x) - dx} y1={sy(g.center.y) + dy} x2={sx(g.center.x) + dx} y2={sy(g.center.y) - dy} stroke={g.color} strokeWidth={2.5} />;
      })}
      {paths.map((p, i) => (
        <g key={i}>
          <path d={p.ref} fill="none" stroke={colors[i]} strokeOpacity={0.45} strokeDasharray="4 3" strokeWidth={1} />
          <path d={p.act} fill="none" stroke={colors[i]} strokeWidth={1.3} />
        </g>
      ))}
      <text x={4} y={H - 4} fontSize={8} fill="#64748b">
        dashed: commanded · solid: executed · grid box: arena minus 0.3 m
      </text>
    </svg>
  );
}

export function TrackingTab() {
  const { tick } = useLive();
  const config = useStore((s) => s.config);
  const [sel, setSel] = useState(0);
  const log = engine.log;
  const colors = (log?.drones ?? []).map((_, i) => config.drones[i]?.color ?? '#94a3b8');
  const data = useMemo(() => {
    if (!log) return null;
    const series = log.drones.map((_, i) => errorSeries(log, i));
    const len = Math.max(...series.map((s) => s.t.length), 0);
    const rows: Record<string, number>[] = [];
    for (let k = 0; k < len; k++) {
      const r: Record<string, number> = { t: log.t[k] };
      series.forEach((s, i) => {
        if (k < s.e.length) {
          r[`e${i}`] = s.e[k] * 100;
          r[`a${i}`] = s.along[k] * 100;
          r[`c${i}`] = s.cross[k] * 100;
        }
      });
      rows.push(r);
    }
    return downsample(rows, 500);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, log]);
  const metrics = useMemo(() => (log ? log.drones.map((_, i) => trackingMetrics(log, i)) : []), [tick, log]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!log || !data) return <div className="text-xs text-slate-500">No trial yet.</div>;
  const d = Math.min(sel, log.drones.length - 1);
  return (
    <div className="space-y-2.5">
      <Card title="Tracking error |e(t)| vs nominal reference" right={<span className="text-[10px] text-slate-500">cm</span>}>
        <TimeChart data={data} series={log.drones.map((_, i) => ({ key: `e${i}`, name: `Drone ${DRONE_NAMES[i]}`, color: colors[i] }))} yLabel="cm" refLines={[{ y: 10, label: '10 cm', color: '#f59e0b' }]} cursorT={engine.replayTime ?? undefined} />
      </Card>
      <Card
        title="Along-track vs cross-track"
        right={log.drones.length > 1 ? <Tabs small value={String(d)} options={log.drones.map((_, i) => ({ value: String(i), label: DRONE_NAMES[i] }))} onChange={(v) => setSel(Number(v))} /> : null}
      >
        <TimeChart
          data={data}
          series={[
            { key: `a${d}`, name: 'along (lag → latency)', color: '#38bdf8' },
            { key: `c${d}`, name: 'cross (corner cutting → thrust)', color: '#f472b6' },
          ]}
          yLabel="cm"
          height={140}
        />
      </Card>
      <Card title="Commanded vs executed path (top view)">
        <TopView log={log} colors={colors} />
      </Card>
      <Card title="Tracking metrics">
        <table className="tabular w-full font-mono text-[11px]">
          <thead className="text-slate-500">
            <tr>
              <th className="text-left font-normal">metric</th>
              {metrics.map((_, i) => (
                <th key={i} className="text-right font-normal" style={{ color: colors[i] }}>
                  {DRONE_NAMES[i]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(
              [
                ['M1 RMSE', (m) => cm(m.rmse)],
                ['M2 max error', (m) => cm(m.maxError)],
                ['M3 along RMS', (m) => cm(m.alongRms)],
                ['M4 cross RMS', (m) => cm(m.crossRms)],
                ['M5 lap (plan)', (m) => `${fmt(m.lapTime, 2)} (${fmt(m.plannedLapTime, 2)}) s`],
                ['M6 speed mean/peak', (m) => `${fmt(m.meanSpeed, 2)}/${fmt(m.peakSpeed, 2)}`],
                ['M8 completion', (m) => pct(m.completion, 0)],
                ['M9 infeasible', (m) => pct(m.feasibilityFail, 1)],
              ] as [string, (m: (typeof metrics)[number]) => string][]
            ).map(([name, f]) => (
              <tr key={name} className="border-t border-slate-200 dark:border-slate-800">
                <td className="py-0.5 font-sans text-slate-600 dark:text-slate-400">{name}</td>
                {metrics.map((m, i) => (
                  <td key={i} className="text-right">
                    {f(m)}
                  </td>
                ))}
              </tr>
            ))}
            <tr className="border-t border-slate-200 dark:border-slate-800">
              <td className="py-0.5 font-sans text-slate-600 dark:text-slate-400">M7 latency cfg / meas.</td>
              <td colSpan={metrics.length} className="text-right">
                {fmt((config.system.totalLatency || 0) * 1000, 0)} / {fmt(log.summary.measuredLatency * 1000, 1)} ms
              </td>
            </tr>
          </tbody>
        </table>
      </Card>
    </div>
  );
}
