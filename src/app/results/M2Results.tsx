/**
 * M2 results (Section 12, Milestone 2): safety-sweep heatmaps of closest approach (M11) and
 * intervention rate (M13) over speed × margin multiplier, with selectors for latency
 * compensation and filter type; and the cost of safety (M15) vs margin. The margin sweep and the
 * drone-count scaling live in M2Margins.tsx.
 */
import { useMemo, useState } from 'react';
import { summariseSafety, type SafetyCell } from '../../core/experiments';
import { Card, fmt, Tabs } from '../ui';
import { ciFields, CILineChart, finite, LEVEL_COLORS } from './charts';
import { divergingScale, Heatmap, HUE, sequentialScale, type HeatCell } from './heatmap';
import { EmptyState, ExportButtons, Finding, Footer, Note, okRecords, PartialNote, useRunRecords } from './common';
import { MarginSweep, Scaling } from './M2Margins';

const uniq = (xs: number[]) => [...new Set(xs)].sort((a, b) => a - b);

function cellTitle(c: SafetyCell): string {
  return [
    `w = ${c.w} rad/s, margin × ${c.margin}, latency comp. ${c.comp}, ${c.type === 'ecbf' ? 'ECBF' : 'braking-aware'}`,
    `M11 closest approach ${fmt(c.closest.mean, 2)} [${fmt(c.closest.lo, 2)}, ${fmt(c.closest.hi, 2)}]`,
    `M13 intervention rate ${fmt(c.intervention.mean * 100, 1)}% [${fmt(c.intervention.lo * 100, 1)}, ${fmt(c.intervention.hi * 100, 1)}]`,
    `M12 violation time ${fmt(c.violation.mean, 2)} s · collisions ${c.collisions} · emergency brakes ${c.emergencies}`,
    `n = ${c.n} trial${c.n === 1 ? '' : 's'}`,
  ].join('\n');
}

function SafetySweep() {
  const { run, recs } = useRunRecords('m2-safety');
  const ok = useMemo(() => okRecords(recs), [recs]);
  const cells = useMemo(() => summariseSafety(ok), [ok]);
  const [comp, setComp] = useState<'on' | 'off'>('on');
  const [type, setType] = useState<'ecbf' | 'braking'>('ecbf');
  const speeds = useMemo(() => uniq(cells.map((c) => c.w)), [cells]);
  const margins = useMemo(() => uniq(cells.map((c) => c.margin)), [cells]);
  // colour scales span every cell (both selectors), so switching the selectors compares like with like
  const scales = useMemo(() => {
    const s = cells.map((c) => c.closest.mean).filter(finite);
    const ir = cells.map((c) => c.intervention.mean * 100).filter(finite);
    const lo = Math.min(0.5, ...s);
    const hi = Math.max(2, ...s);
    const irMax = Math.max(5, Math.ceil(Math.max(0, ...ir) / 5) * 5);
    return {
      closest: divergingScale(lo, 1, hi, HUE.rose, HUE.teal, [
        { v: lo, label: lo.toFixed(1) },
        { v: 1, label: '1 = danger' },
        { v: hi, label: hi.toFixed(1) },
      ]),
      intervention: sequentialScale(0, irMax, HUE.amber, [
        { v: 0, label: '0%' },
        { v: irMax / 2, label: `${irMax / 2}%` },
        { v: irMax, label: `${irMax}%` },
      ]),
    };
  }, [cells]);
  if (!ok.length)
    return (
      <Card title="Safety sweep (T5 circle swap)">
        <EmptyState kinds={['m2-safety']}>
          Flies the T5 antipodal circle swap at 3 speeds × margin multiplier 1.0 / 1.25 / 1.5 × latency compensation on / off × ECBF / braking-aware filter, and records closest approach, interventions, collisions and the cost of safety.
        </EmptyState>
      </Card>
    );
  const sel = cells.filter((c) => c.comp === comp && c.type === type);
  const at = (w: number, m: number) => sel.find((c) => c.w === w && c.margin === m);
  const grid = (f: (c: SafetyCell) => HeatCell) => speeds.map((w) => margins.map((m) => (at(w, m) ? f(at(w, m)!) : null)));
  const coll = (c: SafetyCell) => ({ outline: c.collisions > 0, badge: c.collisions > 0 ? `✕${c.collisions}` : undefined, title: cellTitle(c) });
  const closest = grid((c) => ({ value: c.closest.mean, text: fmt(c.closest.mean, 2), ...coll(c) }));
  const interv = grid((c) => ({ value: c.intervention.mean * 100, text: `${fmt(c.intervention.mean * 100, 1)}%`, ...coll(c) }));
  const totalColl = sel.reduce((a, c) => a + c.collisions, 0);
  const totalN = sel.reduce((a, c) => a + c.n, 0);
  const minS = Math.min(...sel.map((c) => c.closest.mean).filter(finite));
  // margin effect at the fastest speed that has both ends of the margin range
  const wTop = speeds[speeds.length - 1];
  const lo = at(wTop, margins[0]);
  const hi = at(wTop, margins[margins.length - 1]);
  return (
    <Card title="Safety sweep (T5 circle swap)">
      <div className="space-y-2">
        <PartialNote run={run} />
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-slate-500">
          <span className="flex items-center gap-1">
            Latency comp.
            <Tabs small value={comp} onChange={setComp} options={[{ value: 'on', label: 'on' }, { value: 'off', label: 'off' }]} />
          </span>
          <span className="flex items-center gap-1">
            Filter
            <Tabs small value={type} onChange={setType} options={[{ value: 'ecbf', label: 'ECBF' }, { value: 'braking', label: 'braking-aware' }]} />
          </span>
        </div>
        <div>
          <div className="mb-1 text-[11px] font-medium text-slate-600 dark:text-slate-400">M11 closest approach (scaled s; s = 1 is the danger boundary)</div>
          <Heatmap rows={speeds.map((w) => w.toFixed(2))} cols={margins.map((m) => `× ${m}`)} cells={closest} scale={scales.closest} corner="w (rad/s)" colTitle="margin multiplier" legendTitle="min s" />
        </div>
        <div>
          <div className="mb-1 text-[11px] font-medium text-slate-600 dark:text-slate-400">M13 intervention rate (share of control ticks the filter changed u)</div>
          <Heatmap rows={speeds.map((w) => w.toFixed(2))} cols={margins.map((m) => `× ${m}`)} cells={interv} scale={scales.intervention} corner="w (rad/s)" colTitle="margin multiplier" legendTitle="M13" />
        </div>
        <Finding tone={totalColl > 0 || minS < 1 ? 'amber' : 'sky'}>
          {totalColl > 0 ? `${totalColl} collision${totalColl === 1 ? '' : 's'} in ${totalN} trials with this filter setting (red outlines).` : `No collisions in ${totalN} trials with this filter setting`}
          {finite(minS) && (minS < 1 ? `; the closest approach dips to s = ${minS.toFixed(2)}, inside the danger boundary.` : `; every cell keeps s ≥ ${minS.toFixed(2)} (above 1).`)}
          {lo && hi && lo !== hi && (
            <>
              {' '}
              At w = {wTop.toFixed(2)}, raising the margin from × {margins[0]} to × {margins[margins.length - 1]} moves s from {fmt(lo.closest.mean, 2)} to {fmt(hi.closest.mean, 2)} and the intervention rate from {fmt(lo.intervention.mean * 100, 1)}% to{' '}
              {fmt(hi.intervention.mean * 100, 1)}%.
            </>
          )}
        </Finding>
        <Note>Cell text is the mean over trials; hover a cell for the 95% CI, violation time and counts. Colours share one scale across the selectors.</Note>
        <CostOfSafety cells={cells} speeds={speeds} margins={margins} />
        <ExportButtons kind="m2-safety" run={run} recs={recs} summary={() => cells} />
      </div>
    </Card>
  );
}

function CostOfSafety({ cells, speeds, margins }: { cells: SafetyCell[]; speeds: number[]; margins: number[] }) {
  // M15 is computed only for the default filter set-up (ECBF, latency compensation on)
  const withCost = cells.filter((c) => c.costOfSafety.n > 0);
  if (!withCost.length) return null;
  const data = margins.map((m) => {
    const row: Record<string, unknown> = { m };
    speeds.forEach((w, i) => Object.assign(row, ciFields(`s${i}`, withCost.find((c) => c.w === w && c.margin === m)?.costOfSafety, 100)));
    return row;
  });
  const sentence = speeds
    .map((w) => {
      const a = withCost.find((c) => c.w === w && c.margin === margins[0])?.costOfSafety.mean;
      const b = withCost.find((c) => c.w === w && c.margin === margins[margins.length - 1])?.costOfSafety.mean;
      return finite(a) && finite(b) ? `${(a * 100).toFixed(1)} → ${(b * 100).toFixed(1)} cm at w = ${w.toFixed(2)}` : null;
    })
    .filter(Boolean);
  return (
    <div className="border-t border-slate-200 pt-2 dark:border-slate-800">
      <div className="text-[11px] font-medium text-slate-600 dark:text-slate-400">M15 cost of safety vs margin multiplier (one line per speed)</div>
      <CILineChart
        data={data}
        xKey="m"
        xLabel="margin multiplier"
        xTicks={margins}
        series={speeds.map((w, i) => ({ key: `s${i}`, name: `w = ${w.toFixed(2)}`, color: LEVEL_COLORS[i % LEVEL_COLORS.length] }))}
        yLabel="M15 (cm)"
        unit=" cm"
        height={180}
      />
      <Note>
        M15 = RMSE in the two-drone run minus RMSE of the same trajectory flown alone (ECBF, latency compensation on; mean and 95% CI over drones and trials).
        {sentence.length > 0 && <> From margin × {margins[0]} to × {margins[margins.length - 1]}: {sentence.join('; ')}.</>}
      </Note>
    </div>
  );
}

export function M2Results() {
  return (
    <div className="space-y-2.5">
      <SafetySweep />
      <MarginSweep />
      <Scaling />
      <Footer />
    </div>
  );
}
