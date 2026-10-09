/** Shared chart helpers (recharts). */
import { CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useStore } from '../store';

export interface Series {
  key: string;
  name: string;
  color: string;
  dashed?: boolean;
  width?: number;
}

/** Keep at most `max` points by uniform striding (always keep the last point). */
export function downsample<T>(xs: T[], max = 400): T[] {
  if (xs.length <= max) return xs;
  const stride = xs.length / max;
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(xs[Math.floor(i * stride)]);
  out.push(xs[xs.length - 1]);
  return out;
}

export function useChartTheme() {
  const dark = useStore((s) => s.dark);
  return {
    grid: dark ? '#1e293b' : '#e2e8f0',
    axis: dark ? '#64748b' : '#64748b',
    text: dark ? '#cbd5e1' : '#334155',
    tooltipBg: dark ? '#0f172a' : '#ffffff',
    tooltipBorder: dark ? '#334155' : '#cbd5e1',
  };
}

export function TimeChart({
  data,
  series,
  height = 150,
  yLabel,
  refLines = [],
  yDomain,
  xKey = 't',
  xLabel = 't (s)',
  cursorT,
}: {
  data: Record<string, number>[];
  series: Series[];
  height?: number;
  yLabel?: string;
  refLines?: { y: number; label?: string; color?: string }[];
  yDomain?: [number | 'auto' | 'dataMin' | 'dataMax', number | 'auto' | 'dataMin' | 'dataMax'];
  xKey?: string;
  xLabel?: string;
  cursorT?: number;
}) {
  const th = useChartTheme();
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 6, right: 8, bottom: 14, left: 0 }}>
          <CartesianGrid stroke={th.grid} strokeDasharray="3 3" />
          <XAxis
            dataKey={xKey}
            type="number"
            domain={['dataMin', 'dataMax']}
            tick={{ fontSize: 10, fill: th.axis }}
            tickFormatter={(v: number) => (Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(1))}
            label={{ value: xLabel, position: 'insideBottom', offset: -8, fontSize: 10, fill: th.axis }}
          />
          <YAxis
            width={44}
            tick={{ fontSize: 10, fill: th.axis }}
            domain={yDomain ?? ['auto', 'auto']}
            tickFormatter={(v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(1) : v.toFixed(2))}
            label={yLabel ? { value: yLabel, angle: -90, position: 'insideLeft', offset: 12, fontSize: 10, fill: th.axis } : undefined}
          />
          <Tooltip
            contentStyle={{ background: th.tooltipBg, border: `1px solid ${th.tooltipBorder}`, fontSize: 11 }}
            labelFormatter={(v) => `${xKey === 't' ? 't = ' : ''}${Number(v).toFixed(2)}`}
            formatter={(v) => (typeof v === 'number' ? v.toFixed(3) : String(v))}
          />
          {series.length > 1 && <Legend wrapperStyle={{ fontSize: 10 }} iconSize={8} />}
          {refLines.map((r, i) => (
            <ReferenceLine key={i} y={r.y} stroke={r.color ?? '#ef4444'} strokeDasharray="4 3" label={r.label ? { value: r.label, fontSize: 9, fill: r.color ?? '#ef4444', position: 'insideTopRight' } : undefined} />
          ))}
          {cursorT !== undefined && <ReferenceLine x={cursorT} stroke={th.axis} strokeOpacity={0.6} />}
          {series.map((s) => (
            <Line key={s.key} dataKey={s.key} name={s.name} stroke={s.color} dot={false} strokeWidth={s.width ?? 1.4} strokeDasharray={s.dashed ? '4 3' : undefined} isAnimationActive={false} connectNulls />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
