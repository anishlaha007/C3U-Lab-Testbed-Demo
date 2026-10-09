/**
 * Chart helpers of the Results tab: bar and line charts with 95% CI error bars, radar overlay of
 * sub-scores, strip plot of a distribution with mean markers, and a predicted-vs-realised scatter
 * with the y = x line (heatmaps are in heatmap.tsx). Everything is sized for the 430 px right
 * panel (about 400 px of chart width).
 */
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ErrorBar,
  Legend,
  Line,
  LineChart,
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart,
  Rectangle,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from 'recharts';
import type { Stat } from '../../core/experiments';
import type { SubScores } from '../../core/metrics/scorecard';
import { useChartTheme } from '../charts/common';
import { fmt } from '../ui';

// ---- condition colours ----------------------------------------------------------------------

export const CONDITION_COLORS: Record<string, string> = {
  Independent: '#94a3b8',
  Nash: '#38bdf8',
  'Stackelberg A leads': '#a78bfa',
  'Stackelberg B leads': '#f59e0b',
  'Streamed, Mellinger-like': '#38bdf8',
  'Uploaded, Mellinger-like': '#34d399',
  'Streamed, PID-like': '#f472b6',
};
const SHORT: Record<string, string> = { Independent: 'Indep.', Nash: 'Nash', 'Stackelberg A leads': 'Stack. A', 'Stackelberg B leads': 'Stack. B' };
export const condColor = (c: string, i = 0) => CONDITION_COLORS[c] ?? ['#38bdf8', '#f472b6', '#facc15', '#4ade80', '#a78bfa', '#fb923c'][i % 6];
export const condShort = (c: string) => SHORT[c] ?? c;

// ---- CI helpers -----------------------------------------------------------------------------

export const finite = (x: number | undefined | null): x is number => typeof x === 'number' && Number.isFinite(x);

/** A Wilson interval (proportion with bounds) as a Stat, so it plots like a bootstrap CI. */
export const wilsonStat = (w: { p: number; lo: number; hi: number }, n: number): Stat => ({ n, mean: w.p, lo: w.lo, hi: w.hi });

/** Series colours for ordered levels (speeds, scenarios) that are not conditions. */
export const LEVEL_COLORS = ['#38bdf8', '#f59e0b', '#f43f5e', '#a78bfa', '#34d399', '#fb923c', '#94a3b8'];

/**
 * Row fields for a statistic: `key` (mean), `key_err` ([below, above] for ErrorBar), `key_lo`,
 * `key_hi`. Values are multiplied by `k` (e.g. 100 for cm or %). Non-finite means become null so
 * recharts leaves a gap instead of drawing at NaN.
 */
export function ciFields(key: string, st: Stat | undefined, k = 1): Record<string, number | number[] | null> {
  if (!st || !finite(st.mean)) return { [key]: null, [`${key}_err`]: [0, 0], [`${key}_lo`]: null, [`${key}_hi`]: null };
  const lo = finite(st.lo) ? st.lo : st.mean;
  const hi = finite(st.hi) ? st.hi : st.mean;
  return { [key]: st.mean * k, [`${key}_err`]: [Math.max(0, (st.mean - lo) * k), Math.max(0, (hi - st.mean) * k)], [`${key}_lo`]: lo * k, [`${key}_hi`]: hi * k };
}

type Row = Record<string, unknown>;

function useTooltipStyle() {
  const th = useChartTheme();
  return {
    contentStyle: { background: th.tooltipBg, border: `1px solid ${th.tooltipBorder}`, fontSize: 11, padding: '4px 8px' },
    labelStyle: { color: th.text, fontWeight: 600 },
    itemStyle: { padding: 0 },
  };
}

/** Tooltip value "mean [lo, hi]" when the row carries CI bounds for that series. */
function ciFormatter(d: number, unit: string) {
  return (v: unknown, name: unknown, item: { dataKey?: unknown; payload?: Row }) => {
    const key = String(item?.dataKey ?? '');
    const p = item?.payload ?? {};
    const lo = p[`${key}_lo`];
    const hi = p[`${key}_hi`];
    const val = typeof v === 'number' ? v.toFixed(d) : String(v ?? '–');
    const ci = typeof lo === 'number' && typeof hi === 'number' ? ` [${lo.toFixed(d)}, ${hi.toFixed(d)}]` : '';
    return [`${val}${unit}${ci}`, String(name)];
  };
}

export interface ChartSeries {
  key: string;
  name: string;
  color: string;
}

export interface RefLine {
  y?: number;
  x?: number;
  label?: string;
  color?: string;
  dashed?: boolean;
  /** Label placement; vertical lines default to the right of the line, horizontal ones to the top right. */
  labelPos?: 'insideTopLeft' | 'insideTopRight' | 'insideBottomLeft' | 'insideBottomRight';
}

function refLineEls(refs: RefLine[], fallback: string) {
  return refs.map((r, i) => (
    <ReferenceLine
      key={`ref${i}`}
      x={r.x}
      y={r.y}
      stroke={r.color ?? fallback}
      strokeDasharray={r.dashed === false ? undefined : '4 3'}
      ifOverflow="extendDomain"
      label={r.label ? { value: r.label, fontSize: 9, fill: r.color ?? fallback, position: r.labelPos ?? (r.x !== undefined ? 'insideTopLeft' : 'insideTopRight') } : undefined}
    />
  ));
}

// ---- bar chart with CI whiskers -------------------------------------------------------------

/**
 * Plain rectangle as a custom bar shape: recharts drops zero-height bars (and with them their
 * error bars) unless the bar has a custom shape, and a 0% win rate still has a Wilson interval.
 */
const barShape = (p: object) => <Rectangle {...p} />;

export function CIBarChart({
  data,
  xKey,
  series,
  height = 160,
  yLabel,
  refLines = [],
  yDomain,
  digits = 1,
  unit = '',
  cellColors,
  labelOf,
  xLabel,
}: {
  data: Row[];
  xKey: string;
  xLabel?: string;
  series: ChartSeries[];
  height?: number;
  yLabel?: string;
  refLines?: RefLine[];
  yDomain?: [number | 'auto', number | 'auto'];
  digits?: number;
  unit?: string;
  /** Per-category colours for a single series. */
  cellColors?: string[];
  /** Tooltip heading for a category (n, p-values...). */
  labelOf?: (row: Row) => string;
}) {
  const th = useChartTheme();
  const tt = useTooltipStyle();
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 10, right: 8, bottom: xLabel ? 14 : 2, left: 0 }} barCategoryGap="22%">
          <CartesianGrid stroke={th.grid} strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey={xKey}
            tick={{ fontSize: 10, fill: th.axis }}
            interval={0}
            tickLine={false}
            label={xLabel ? { value: xLabel, position: 'insideBottom', offset: -8, fontSize: 10, fill: th.axis } : undefined}
          />
          <YAxis
            width={42}
            tick={{ fontSize: 10, fill: th.axis }}
            domain={yDomain ?? [0, 'auto']}
            label={yLabel ? { value: yLabel, angle: -90, position: 'insideLeft', offset: 12, fontSize: 10, fill: th.axis } : undefined}
          />
          <Tooltip
            {...tt}
            cursor={{ fill: th.grid, opacity: 0.35 }}
            labelFormatter={(l, p) => (labelOf && p?.[0]?.payload ? labelOf(p[0].payload as Row) : String(l))}
            formatter={ciFormatter(digits, unit) as never}
          />
          {series.length > 1 && <Legend wrapperStyle={{ fontSize: 10, paddingBottom: 2 }} iconSize={8} verticalAlign="top" />}
          {refLineEls(refLines, th.axis)}
          {series.map((s) => (
            <Bar key={s.key} dataKey={s.key} name={s.name} fill={s.color} isAnimationActive={false} maxBarSize={36} shape={barShape as never}>
              {cellColors && data.map((_, i) => <Cell key={i} fill={cellColors[i]} />)}
              <ErrorBar isAnimationActive={false} dataKey={`${s.key}_err`} width={4} stroke={th.text} strokeWidth={1} direction="y" />
            </Bar>
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// ---- line chart over a numeric x with CI whiskers --------------------------------------------

export function CILineChart({
  data,
  xKey,
  xLabel,
  series,
  height = 170,
  yLabel,
  refLines = [],
  xTicks,
  yDomain,
  digits = 1,
  unit = '',
  dotColor,
  xFormat = (v: number) => v.toFixed(2),
}: {
  data: Row[];
  xKey: string;
  xLabel: string;
  series: ChartSeries[];
  height?: number;
  yLabel?: string;
  refLines?: RefLine[];
  xTicks?: number[];
  yDomain?: [number | 'auto' | 'dataMin', number | 'auto' | 'dataMax'];
  digits?: number;
  unit?: string;
  /** Override the dot colour of a data point (e.g. the breakdown level in red). */
  dotColor?: (row: Row) => string | undefined;
  xFormat?: (v: number) => string;
}) {
  const th = useChartTheme();
  const tt = useTooltipStyle();
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 10, right: 12, bottom: 14, left: 0 }}>
          <CartesianGrid stroke={th.grid} strokeDasharray="3 3" />
          <XAxis
            dataKey={xKey}
            type="number"
            domain={['dataMin', 'dataMax']}
            ticks={xTicks}
            tick={{ fontSize: 10, fill: th.axis }}
            tickFormatter={xFormat}
            padding={{ left: 10, right: 10 }}
            label={{ value: xLabel, position: 'insideBottom', offset: -8, fontSize: 10, fill: th.axis }}
          />
          <YAxis
            width={42}
            tick={{ fontSize: 10, fill: th.axis }}
            domain={yDomain ?? [0, 'auto']}
            label={yLabel ? { value: yLabel, angle: -90, position: 'insideLeft', offset: 12, fontSize: 10, fill: th.axis } : undefined}
          />
          <Tooltip {...tt} labelFormatter={(l) => `${xLabel.split(' (')[0]} = ${xFormat(Number(l))}`} formatter={ciFormatter(digits, unit) as never} />
          {series.length > 1 && <Legend wrapperStyle={{ fontSize: 10, paddingTop: 6 }} iconSize={8} verticalAlign="top" height={18} />}
          {refLineEls(refLines, th.axis)}
          {series.map((s) => (
            <Line
              key={s.key}
              dataKey={s.key}
              name={s.name}
              stroke={s.color}
              strokeWidth={1.6}
              isAnimationActive={false}
              connectNulls
              dot={(p) => {
                const c = (dotColor && p.payload ? dotColor(p.payload as Row) : undefined) ?? s.color;
                return finite(p.cx) && finite(p.cy) ? <circle key={`d${p.index}`} cx={p.cx} cy={p.cy} r={c === s.color ? 2.8 : 4.2} fill={c} stroke={th.tooltipBg} strokeWidth={0.8} /> : <g key={`d${p.index}`} />;
              }}
            >
              <ErrorBar isAnimationActive={false} dataKey={`${s.key}_err`} width={5} stroke={s.color} strokeWidth={1} direction="y" />
            </Line>
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

// ---- radar of sub-scores --------------------------------------------------------------------

const SUB_LABELS: Record<keyof SubScores, string> = { S: 'S safety', V: 'V speed', A: 'A accuracy', E: 'E effort' };

export function RadarOverlay({ series, height = 210 }: { series: { name: string; color: string; sub: SubScores }[]; height?: number }) {
  const th = useChartTheme();
  const tt = useTooltipStyle();
  const data = (Object.keys(SUB_LABELS) as (keyof SubScores)[]).map((k) => {
    const row: Row = { k: SUB_LABELS[k] };
    series.forEach((s, i) => (row[`r${i}`] = finite(s.sub[k]) ? s.sub[k] : null));
    return row;
  });
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <RadarChart data={data} outerRadius="68%" margin={{ top: 4, right: 8, bottom: 4, left: 8 }}>
          <PolarGrid stroke={th.grid} />
          <PolarAngleAxis dataKey="k" tick={{ fontSize: 10, fill: th.text }} />
          <PolarRadiusAxis domain={[0, 1]} tickCount={3} angle={90} tick={false} axisLine={false} />
          {series.map((s, i) => (
            <Radar key={i} dataKey={`r${i}`} name={s.name} stroke={s.color} fill={s.color} fillOpacity={0.1} strokeWidth={1.5} dot={{ r: 2 }} isAnimationActive={false} />
          ))}
          <Legend wrapperStyle={{ fontSize: 10 }} iconSize={8} />
          <Tooltip {...tt} formatter={(v) => (typeof v === 'number' ? v.toFixed(3) : '–')} />
        </RadarChart>
      </ResponsiveContainer>
    </div>
  );
}

// ---- strip plot (jittered dots + mean with CI) -------------------------------------------------

export function StripPlot({ groups, height = 190, yLabel, unit = '' }: { groups: { name: string; color: string; values: number[]; stat: Stat }[]; height?: number; yLabel?: string; unit?: string }) {
  const th = useChartTheme();
  const tt = useTooltipStyle();
  // deterministic jitter (golden-ratio sequence) so the plot does not reshuffle on re-render
  const pts = groups.map((g, i) => g.values.filter(finite).map((y, j) => ({ x: i + (((j * 0.618034) % 1) - 0.5) * 0.46, y, c: g.name })));
  const means = groups.map((g, i): Row => ({ x: i, ...ciFields('y', g.stat) })).filter((m) => m.y !== null);
  const ys = [...pts.flat().map((p) => p.y), ...groups.flatMap((g) => [g.stat.lo, g.stat.hi])].filter(finite);
  const yAxis = niceTicks(Math.min(0, ...ys), Math.max(0, ...ys));
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <ScatterChart margin={{ top: 10, right: 8, bottom: 2, left: 0 }}>
          <CartesianGrid stroke={th.grid} strokeDasharray="3 3" vertical={false} />
          <XAxis
            type="number"
            dataKey="x"
            name="condition"
            domain={[-0.5, groups.length - 0.5]}
            ticks={groups.map((_, i) => i)}
            interval={0}
            tickFormatter={(v: number) => condShort(groups[Math.round(v)]?.name ?? '')}
            tick={{ fontSize: 10, fill: th.axis }}
            tickLine={false}
          />
          <YAxis type="number" dataKey="y" name="value" width={42} domain={[yAxis.lo, yAxis.hi]} ticks={yAxis.ticks} interval={0} tickFormatter={tickFmt} tick={{ fontSize: 10, fill: th.axis }} label={yLabel ? { value: yLabel, angle: -90, position: 'insideLeft', offset: 12, fontSize: 10, fill: th.axis } : undefined} />
          <ZAxis range={[16, 16]} />
          <ReferenceLine y={0} stroke={th.axis} />
          <Tooltip
            {...tt}
            cursor={false}
            formatter={((v: unknown, n: unknown) => (n === 'condition' ? [groups[Math.round(Number(v))]?.name ?? '', 'condition'] : [`${fmt(Number(v), 3)}${unit}`, 'value'])) as never}
          />
          {pts.map((p, i) => (
            <Scatter key={i} data={p} fill={groups[i].color} fillOpacity={0.6} isAnimationActive={false} />
          ))}
          <Scatter
            data={means}
            isAnimationActive={false}
            shape={((p: { cx?: number; cy?: number }) => (finite(p.cx) && finite(p.cy) ? <path d={`M${p.cx - 12},${p.cy}H${p.cx + 12}`} stroke={th.text} strokeWidth={2.4} /> : <g />)) as never}
          >
            <ErrorBar isAnimationActive={false} dataKey="y_err" width={6} stroke={th.text} strokeWidth={1} direction="y" />
          </Scatter>
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  );
}

// ---- predicted vs realised scatter with y = x ---------------------------------------------------

/** Round axis limits and 4 to 7 evenly spaced ticks on a 1 / 2 / 2.5 / 5 × 10^k step. */
export function niceTicks(lo0: number, hi0: number): { lo: number; hi: number; ticks: number[] } {
  const span = Math.max(1e-6, hi0 - lo0);
  const raw = span / 5;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 2.5, 5, 10].find((m) => m * mag >= raw) ?? 10) * mag;
  const lo = Math.floor(lo0 / step + 1e-9) * step;
  const hi = Math.ceil(hi0 / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let v = lo; v <= hi + step * 1e-6; v += step) ticks.push(Number(v.toFixed(10)));
  return { lo, hi, ticks };
}
const tickFmt = (v: number) => (Math.abs(v) < 1e-9 ? '0' : Number(v.toFixed(3)).toString());

export function FidelityScatter({ groups, height = 220, xLabel, yLabel }: { groups: { name: string; color: string; points: { x: number; y: number }[] }[]; height?: number; xLabel: string; yLabel: string }) {
  const th = useChartTheme();
  const tt = useTooltipStyle();
  const all = groups.flatMap((g) => g.points.flatMap((p) => [p.x, p.y])).filter(finite);
  const [a0, b0] = [Math.min(0, ...all), Math.max(0, ...all)];
  const pad = 0.04 * Math.max(0.1, b0 - a0); // keep dots off the frame
  const { lo, hi, ticks } = niceTicks(a0 - pad, b0 + pad);
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <ScatterChart margin={{ top: 8, right: 12, bottom: 14, left: 0 }}>
          <CartesianGrid stroke={th.grid} strokeDasharray="3 3" />
          <XAxis type="number" dataKey="x" name="predicted" domain={[lo, hi]} ticks={ticks} interval={0} tick={{ fontSize: 10, fill: th.axis }} tickFormatter={tickFmt} label={{ value: xLabel, position: 'insideBottom', offset: -8, fontSize: 10, fill: th.axis }} />
          <YAxis type="number" dataKey="y" name="realised" domain={[lo, hi]} ticks={ticks} interval={0} width={42} tick={{ fontSize: 10, fill: th.axis }} tickFormatter={tickFmt} label={{ value: yLabel, angle: -90, position: 'insideLeft', offset: 12, fontSize: 10, fill: th.axis }} />
          <ZAxis range={[22, 22]} />
          <ReferenceLine segment={[{ x: lo, y: lo }, { x: hi, y: hi }]} stroke={th.axis} strokeDasharray="4 3" label={{ value: 'y = x', fontSize: 9, fill: th.axis, position: 'insideTopRight' }} />
          <ReferenceLine x={0} stroke={th.grid} />
          <ReferenceLine y={0} stroke={th.grid} />
          <Tooltip {...tt} cursor={false} formatter={((v: unknown, n: unknown) => [`${fmt(Number(v), 3)} m`, String(n)]) as never} />
          {groups.map((g) => (
            <Scatter key={g.name} name={condShort(g.name)} data={g.points} fill={g.color} fillOpacity={0.75} isAnimationActive={false} />
          ))}
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  );
}
