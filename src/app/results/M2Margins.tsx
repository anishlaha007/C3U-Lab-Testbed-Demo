/**
 * M2 margin sweep (obstacle margin × gate margin on C6 Forest and C5 Narrow gates: gate pass rate
 * M23 and obstacle interventions M26) and drone-count scaling (T7, T8 with n = 2..6: intervention
 * rate, filter solve time p99 and closest approach).
 */
import { useMemo, useState } from 'react';
import { summariseMargins, summariseScaling, type MarginCell } from '../../core/experiments';
import { Card, fmt, Tabs } from '../ui';
import { ciFields, CILineChart, finite, LEVEL_COLORS } from './charts';
import { Heatmap, HUE, sequentialScale, type HeatCell } from './heatmap';
import { EmptyState, ExportButtons, Finding, Note, nRange, okRecords, PartialNote, useRunRecords } from './common';

const uniq = (xs: number[]) => [...new Set(xs)].sort((a, b) => a - b);
const COURSE_NAMES: Record<string, string> = { C6: 'C6 Forest', C5: 'C5 Narrow gates' };

/** Mean of finite values (NaN when none). */
const avg = (xs: number[]) => {
  const v = xs.filter(finite);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN;
};

function marginTitle(c: MarginCell): string {
  return [
    `${COURSE_NAMES[c.course] ?? c.course}: obstacle margin ${c.obstacleMargin} m, gate margin ${c.gateMargin} m`,
    `M23 gate pass rate ${fmt(c.passRate.mean * 100, 0)}% [${fmt(c.passRate.lo * 100, 0)}, ${fmt(c.passRate.hi * 100, 0)}]`,
    `M26 obstacle interventions ${fmt(c.obstacleIntervention.mean * 100, 1)}%`,
    `M25 obstacle clearance ${fmt(c.clearance.mean * 100, 1)} cm · collisions ${c.collisions} · n = ${c.n}`,
  ].join('\n');
}

/** Plain-language reading of the pass-rate grid of one course (computed, not asserted). */
function passSentence(course: string, cells: MarginCell[], gms: number[], oms: number[]): string {
  const name = COURSE_NAMES[course] ?? course;
  const byGate = gms.map((g) => ({ g, p: avg(cells.filter((c) => c.gateMargin === g).map((c) => c.passRate.mean)) }));
  const first = byGate.find((x) => finite(x.p) && x.p < 0.9995);
  // largest change of the pass rate across obstacle margins at a fixed gate margin
  const omEffect = Math.max(
    0,
    ...gms.map((g) => {
      const ps = oms.map((o) => cells.find((c) => c.gateMargin === g && c.obstacleMargin === o)?.passRate.mean).filter(finite);
      return ps.length > 1 ? Math.max(...ps) - Math.min(...ps) : 0;
    }),
  );
  const clr = Math.min(...cells.map((c) => c.clearance.mean).filter(finite));
  const clrText = finite(clr) ? ` (closest obstacle clearance M25 ${(clr * 100).toFixed(1)} cm)` : '';
  const omText =
    omEffect < 0.005
      ? ` The obstacle margin does not change the pass rate here${clrText}.`
      : ` The obstacle margin changes the pass rate by at most ${(omEffect * 100).toFixed(0)} percentage points at a fixed gate margin${clrText}.`;
  if (!first) return `On ${name} the gate pass rate stays at 100% for every tested margin pair.${omText}`;
  const last = byGate[byGate.length - 1];
  const tail = last.g !== first.g && finite(last.p) ? ` and is ${(last.p * 100).toFixed(0)}% at ${last.g.toFixed(2)} m` : '';
  return `On ${name} the gate pass rate first drops below 100% at gate margin ${first.g.toFixed(2)} m (${(first.p * 100).toFixed(0)}% averaged over obstacle margins)${tail}: the larger gate-frame margin shrinks the usable opening until the filter blocks legal passes through small gates (filter conservatism).${omText}`;
}

export function MarginSweep() {
  const { run, recs } = useRunRecords('m2-margins');
  const ok = useMemo(() => okRecords(recs), [recs]);
  const cells = useMemo(() => summariseMargins(ok), [ok]);
  const courses = useMemo(() => ['C6', 'C5'].filter((c) => cells.some((x) => x.course === c)), [cells]);
  const [pick, setPick] = useState('C5');
  const course = courses.includes(pick) ? pick : (courses[0] ?? pick);
  if (!ok.length)
    return (
      <Card title="Obstacle / gate margin sweep">
        <EmptyState kinds={['m2-margins']}>
          Flies one drone through C6 Forest and C5 Narrow gates with obstacle margin × gate margin (0.03 to 0.15 m each) and records the gate pass rate and obstacle interventions, showing where filter conservatism starts to block legal passes.
        </EmptyState>
      </Card>
    );
  const cs = cells.filter((c) => c.course === course);
  const oms = uniq(cs.map((c) => c.obstacleMargin));
  const gms = uniq(cs.map((c) => c.gateMargin));
  const at = (o: number, g: number) => cs.find((c) => c.obstacleMargin === o && c.gateMargin === g);
  const grid = (f: (c: MarginCell) => HeatCell) => oms.map((o) => gms.map((g) => (at(o, g) ? f(at(o, g)!) : null)));
  const extra = (c: MarginCell) => ({ outline: c.collisions > 0, badge: c.collisions > 0 ? `✕${c.collisions}` : undefined, title: marginTitle(c) });
  const pass = grid((c) => ({ value: c.passRate.mean * 100, text: finite(c.passRate.mean) ? `${(c.passRate.mean * 100).toFixed(0)}%` : '–', ...extra(c) }));
  const obs = grid((c) => ({ value: c.obstacleIntervention.mean * 100, text: `${fmt(c.obstacleIntervention.mean * 100, 1)}%`, ...extra(c) }));
  const obsMax = Math.max(5, Math.ceil(Math.max(0, ...cells.map((c) => c.obstacleIntervention.mean * 100).filter(finite)) / 5) * 5);
  const passScale = sequentialScale(0, 100, HUE.rose, [{ v: 0, label: '0%' }, { v: 50, label: '50%' }, { v: 100, label: '100%' }], true);
  const obsScale = sequentialScale(0, obsMax, HUE.violet, [{ v: 0, label: '0%' }, { v: obsMax, label: `${obsMax}%` }]);
  const rows = oms.map((o) => o.toFixed(2));
  const cols = gms.map((g) => g.toFixed(2));
  return (
    <Card title="Obstacle / gate margin sweep">
      <div className="space-y-2">
        <PartialNote run={run} />
        <div className="flex items-center gap-1.5 text-[10px] text-slate-500">
          Course
          <Tabs small value={course} onChange={setPick} options={courses.map((c) => ({ value: c, label: COURSE_NAMES[c] ?? c }))} />
        </div>
        <div>
          <div className="mb-1 text-[11px] font-medium text-slate-600 dark:text-slate-400">M23 gate pass rate</div>
          <Heatmap rows={rows} cols={cols} cells={pass} scale={passScale} corner="obstacle margin (m)" colTitle="gate margin (m)" legendTitle="M23" />
        </div>
        <div>
          <div className="mb-1 text-[11px] font-medium text-slate-600 dark:text-slate-400">M26 obstacle-intervention rate (share of ticks)</div>
          <Heatmap rows={rows} cols={cols} cells={obs} scale={obsScale} corner="obstacle margin (m)" colTitle="gate margin (m)" legendTitle="M26" />
        </div>
        <Finding tone="amber">{passSentence(course, cs, gms, oms)}</Finding>
        <Note>Mean over {nRange(cs.map((c) => c.n))} trial(s) per cell; hover a cell for the CI and obstacle clearance. Red outline: a collision or gate strike in that cell.</Note>
        <ExportButtons kind="m2-margins" run={run} recs={recs} summary={() => cells} />
      </div>
    </Card>
  );
}

export function Scaling() {
  const { run, recs } = useRunRecords('m2-scaling');
  const ok = useMemo(() => okRecords(recs), [recs]);
  const rows = useMemo(() => summariseScaling(ok), [ok]);
  const scen = useMemo(() => [...new Set(rows.map((r) => r.scenario))], [rows]);
  const ns = useMemo(() => uniq(rows.map((r) => r.n)), [rows]);
  const data = useMemo(
    () =>
      ns.map((n) => {
        const row: Record<string, unknown> = { n };
        scen.forEach((s, i) => {
          const r = rows.find((x) => x.scenario === s && x.n === n);
          Object.assign(row, ciFields(`ir${i}`, r?.intervention, 100), ciFields(`sp${i}`, r?.solveP99), ciFields(`cl${i}`, r?.closest));
        });
        return row;
      }),
    [rows, scen, ns],
  );
  if (!ok.length)
    return (
      <Card title="Drone-count scaling (T7, T8)">
        <EmptyState kinds={['m2-scaling']}>Flies the antipodal swap (T7) and random crossings (T8) with 2 to 6 drones and records the intervention rate, filter solve time (p99) and closest approach.</EmptyState>
      </Card>
    );
  const series = (p: string) => scen.map((s, i) => ({ key: `${p}${i}`, name: s, color: LEVEL_COLORS[i % LEVEL_COLORS.length] }));
  const coll = rows.reduce((a, r) => a + r.collisions, 0);
  const emerg = rows.reduce((a, r) => a + r.emergencies, 0);
  const solveTrend = scen
    .map((s) => {
      const a = rows.find((r) => r.scenario === s && r.n === ns[0])?.solveP99.mean;
      const b = rows.find((r) => r.scenario === s && r.n === ns[ns.length - 1])?.solveP99.mean;
      return finite(a) && finite(b) ? `${s} ${a.toFixed(2)} → ${b.toFixed(2)} ms` : null;
    })
    .filter(Boolean);
  const xTicks = ns;
  const xf = (v: number) => v.toFixed(0);
  return (
    <Card title="Drone-count scaling (T7, T8)">
      <div className="space-y-2">
        <PartialNote run={run} />
        <div>
          <div className="text-[11px] font-medium text-slate-600 dark:text-slate-400">M13 intervention rate vs drone count</div>
          <CILineChart data={data} xKey="n" xLabel="drones n" xTicks={xTicks} xFormat={xf} series={series('ir')} yLabel="M13 (%)" unit="%" height={160} />
        </div>
        <div>
          <div className="text-[11px] font-medium text-slate-600 dark:text-slate-400">M16 filter solve time, 99th percentile per tick</div>
          <CILineChart data={data} xKey="n" xLabel="drones n" xTicks={xTicks} xFormat={xf} series={series('sp')} yLabel="p99 (ms)" unit=" ms" digits={2} height={160} />
        </div>
        <div>
          <div className="text-[11px] font-medium text-slate-600 dark:text-slate-400">M11 closest approach vs drone count</div>
          <CILineChart
            data={data}
            xKey="n"
            xLabel="drones n"
            xTicks={xTicks}
            xFormat={xf}
            series={series('cl')}
            yLabel="min s"
            digits={2}
            refLines={[{ y: 1, label: 's = 1 danger boundary', color: '#ef4444' }]}
            height={160}
          />
        </div>
        <Note>
          {coll > 0 ? `${coll} collision${coll === 1 ? '' : 's'}` : 'No collisions'} and {emerg} emergency brake{emerg === 1 ? '' : 's'} across {ok.length} runs.
          {solveTrend.length > 0 && <> Solve time p99 from n = {ns[0]} to {ns[ns.length - 1]}: {solveTrend.join('; ')} (measured in the browser worker, so it depends on this machine).</>}
        </Note>
        <ExportButtons kind="m2-scaling" run={run} recs={recs} summary={() => rows} />
      </div>
    </Card>
  );
}
