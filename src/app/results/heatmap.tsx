/**
 * Heatmap with sequential / diverging colour scales and a gradient legend, for the sweep grids of
 * the Results tab (speed × margin, obstacle margin × gate margin). Colours mix from a neutral
 * background (theme-aware) to the hue, and cell text switches to dark or light for contrast.
 */
import { Fragment, type ReactNode } from 'react';
import { useStore } from '../store';

const finite = (x: number | undefined | null): x is number => typeof x === 'number' && Number.isFinite(x);

type Rgb = [number, number, number];
export const HUE: Record<'rose' | 'sky' | 'teal' | 'amber' | 'violet', Rgb> = {
  rose: [225, 29, 72],
  sky: [2, 132, 199],
  teal: [13, 148, 136],
  amber: [217, 119, 6],
  violet: [124, 58, 237],
};
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * Math.max(0, Math.min(1, t)))) as Rgb;
const css = (c: Rgb) => `rgb(${c[0]},${c[1]},${c[2]})`;
const neutral = (dark: boolean): Rgb => (dark ? [30, 41, 59] : [241, 245, 249]);
const textOn = (c: Rgb) => ((0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) / 255 > 0.58 ? '#0f172a' : '#f8fafc');

export interface ColorScale {
  min: number;
  max: number;
  color: (v: number, dark: boolean) => Rgb;
  ticks: { v: number; label: string }[];
}

/** Neutral at `min` to `hue` at `max` (or reversed: strong at `min`). */
export function sequentialScale(min: number, max: number, hue: Rgb, ticks: ColorScale['ticks'], reverse = false): ColorScale {
  return {
    min,
    max,
    ticks,
    color: (v, dark) => {
      const t = (v - min) / (max - min || 1);
      return mix(neutral(dark), hue, reverse ? 1 - t : t);
    },
  };
}

/** `low` hue below `center`, neutral at `center`, `high` hue above. */
export function divergingScale(min: number, center: number, max: number, low: Rgb, high: Rgb, ticks: ColorScale['ticks']): ColorScale {
  return {
    min,
    max,
    ticks,
    color: (v, dark) => (v < center ? mix(neutral(dark), low, (center - v) / (center - min || 1)) : mix(neutral(dark), high, (v - center) / (max - center || 1))),
  };
}

export function ScaleLegend({ scale, title }: { scale: ColorScale; title?: ReactNode }) {
  const dark = useStore((s) => s.dark);
  const stops = Array.from({ length: 11 }, (_, i) => `${css(scale.color(scale.min + ((scale.max - scale.min) * i) / 10, dark))} ${i * 10}%`).join(',');
  return (
    <div className="mt-1.5 flex items-start gap-2 pl-14">
      {title && <span className="shrink-0 pt-px text-[9px] text-slate-500">{title}</span>}
      <div className="relative min-w-0 flex-1 pb-3">
        <div className="h-1.5 rounded-sm" style={{ background: `linear-gradient(to right, ${stops})` }} />
        {scale.ticks.map((t) => {
          const f = (t.v - scale.min) / (scale.max - scale.min || 1);
          // end ticks align inwards so their labels stay inside the panel and clear of the title
          const shift = f <= 0.02 ? '' : f >= 0.98 ? '-translate-x-full' : '-translate-x-1/2';
          return (
            <span key={t.v} className={`absolute top-2 font-mono text-[9px] whitespace-nowrap text-slate-500 ${shift}`} style={{ left: `${f * 100}%` }}>
              {t.label}
            </span>
          );
        })}
      </div>
    </div>
  );
}

export interface HeatCell {
  value: number;
  text: string;
  title?: string;
  /** Red outline (e.g. a collision happened in this cell). */
  outline?: boolean;
  badge?: string;
}

export function Heatmap({ rows, cols, cells, scale, corner, colTitle, legendTitle }: { rows: string[]; cols: string[]; cells: (HeatCell | null)[][]; scale: ColorScale; corner?: string; colTitle?: string; legendTitle?: ReactNode }) {
  const dark = useStore((s) => s.dark);
  return (
    <div>
      {colTitle && <div className="mb-0.5 pl-14 text-center text-[10px] text-slate-500">{colTitle}</div>}
      <div className="grid gap-0.5" style={{ gridTemplateColumns: `3.4rem repeat(${cols.length}, minmax(0, 1fr))` }}>
        <div className="self-end pr-1 text-[9px] leading-tight text-slate-500">{corner}</div>
        {cols.map((c) => (
          <div key={c} className="text-center font-mono text-[10px] text-slate-500">
            {c}
          </div>
        ))}
        {rows.map((r, i) => (
          <Fragment key={r}>
            <div className="flex items-center pr-1 font-mono text-[10px] text-slate-600 dark:text-slate-400">{r}</div>
            {cols.map((_, j) => {
              const c = cells[i]?.[j] ?? null;
              const rgb = c && finite(c.value) ? scale.color(c.value, dark) : null;
              return (
                <div
                  key={j}
                  title={c?.title}
                  className="relative flex h-7 items-center justify-center rounded-sm font-mono text-[10px]"
                  style={{
                    background: rgb ? css(rgb) : dark ? '#0f172a' : '#e2e8f0',
                    color: rgb ? textOn(rgb) : '#64748b',
                    boxShadow: c?.outline ? 'inset 0 0 0 2px #dc2626' : undefined,
                  }}
                >
                  {c ? c.text : '–'}
                  {c?.badge && <span className="absolute -top-1 -right-0.5 rounded bg-rose-600 px-0.5 text-[8px] leading-tight font-bold text-white">{c.badge}</span>}
                </div>
              );
            })}
          </Fragment>
        ))}
      </div>
      <ScaleLegend scale={scale} title={legendTitle} />
    </div>
  );
}
