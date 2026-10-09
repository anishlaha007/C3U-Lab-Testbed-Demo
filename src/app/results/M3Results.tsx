/**
 * M3 results (Section 12, Milestone 3): per scenario, drone A's win rate per condition (Wilson
 * 95%), final progress gap distributions, intervention rates, prediction fidelity, sub-score
 * radar and composite scores under the current weights, ranking stability, and the
 * Holm-corrected pairwise tests with the plain-language statements they support.
 */
import { useMemo, useState } from 'react';
import { RACE_CONDITIONS, summariseRaceSeries, type RaceConditionRow, type RaceTest } from '../../core/experiments';
import { compositeScore, rankingStability } from '../../core/metrics/scorecard';
import { useStore } from '../store';
import { Badge, Card, cx, fmt, Select } from '../ui';
import { CIBarChart, ciFields, condColor, condShort, FidelityScatter, finite, RadarOverlay, StripPlot, wilsonStat } from './charts';
import { EmptyState, ExportButtons, Finding, Footer, Note, nRange, okRecords, PartialNote, TD, TD_LEFT, TH, TH_LEFT, useRunRecords, weightsText, WeightSliders } from './common';

const color = (cond: string) => condColor(cond, RACE_CONDITIONS.findIndex((c) => c.name === cond));
const pFmt = (p: number) => (!finite(p) ? '–' : p < 0.001 ? '< 0.001' : p.toFixed(3));
const H = 'text-[11px] font-medium text-slate-600 dark:text-slate-400';

function HolmTable({ tests }: { tests: RaceTest[] }) {
  const sig = tests.filter((t) => t.significant).length;
  return (
    <details className="group rounded border border-slate-200 dark:border-slate-800">
      <summary className="cursor-pointer px-2 py-1 text-[11px] font-medium text-slate-600 select-none dark:text-slate-400">
        Pairwise permutation tests, Holm-corrected ({sig} of {tests.length} significant at 5%)
      </summary>
      <table className="w-full text-[10px]">
        <thead>
          <tr className="border-b border-slate-200 dark:border-slate-800">
            <th className={TH}>metric</th>
            <th className={TH_LEFT}>a vs b</th>
            <th className={TH} title="mean(a) − mean(b)">diff</th>
            <th className={TH}>p</th>
            <th className={TH}>Holm p</th>
          </tr>
        </thead>
        <tbody>
          {tests.map((t, i) => (
            <tr key={i} className={cx('border-b border-slate-100 dark:border-slate-800/60', t.significant && 'bg-emerald-50 font-semibold text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300')}>
              <td className={cx(TD, 'font-sans whitespace-nowrap')}>{t.metric}</td>
              <td className={cx(TD_LEFT, 'whitespace-nowrap')}>
                {condShort(t.a)} vs {condShort(t.b)}
              </td>
              <td className={TD}>{fmt(t.diff, 2)}</td>
              <td className={TD}>{pFmt(t.p)}</td>
              <td className={TD}>{pFmt(t.pHolm)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="px-2 py-1 text-[10px] text-slate-500">Two-sample permutation tests (2,000 permutations) between every pair of conditions, Holm-corrected within the scenario. Highlighted: Holm p &lt; 0.05.</p>
    </details>
  );
}

function ScoreTable({ rows }: { rows: RaceConditionRow[] }) {
  const w = useStore((s) => s.weights);
  const scored = rows.map((r) => ({ r, score: compositeScore(r.G, r.sub, w) })).sort((a, b) => b.score - a.score);
  return (
    <table className="w-full text-[10px]">
      <thead>
        <tr className="border-b border-slate-200 dark:border-slate-800">
          <th className={TH}>condition</th>
          <th className={TH} title="Mean gate factor (0 crash, 0.5 emergency brake, 0.75 separation violation, 1 clean)">G</th>
          <th className={TH}>S</th>
          <th className={TH}>V</th>
          <th className={TH}>A</th>
          <th className={TH}>E</th>
          <th className={TH} title="G × weighted mean of the mean sub-scores, with the current weights">score</th>
        </tr>
      </thead>
      <tbody>
        {scored.map(({ r, score }, i) => (
          <tr key={r.condition} className="border-b border-slate-100 dark:border-slate-800/60">
            <td className={cx(TD, 'font-sans whitespace-nowrap')}>
              <span className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: color(r.condition) }} />
              {i + 1}. {condShort(r.condition)}
            </td>
            <td className={TD}>{fmt(r.G, 2)}</td>
            <td className={TD}>{fmt(r.sub.S, 2)}</td>
            <td className={TD}>{fmt(r.sub.V, 2)}</td>
            <td className={TD}>{fmt(r.sub.A, 2)}</td>
            <td className={TD}>{fmt(r.sub.E, 2)}</td>
            <td className={cx(TD, 'font-semibold')}>{fmt(score, 3)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function M3Results() {
  const { run, recs } = useRunRecords('m3-series');
  const weights = useStore((s) => s.weights);
  const ok = useMemo(() => okRecords(recs), [recs]);
  // the tests do not depend on the weights; only the stability check below does
  const sum = useMemo(() => summariseRaceSeries(ok), [ok]);
  const scenarios = useMemo(() => [...new Set(sum.rows.map((r) => r.scenario))], [sum]);
  const [pick, setPick] = useState('');
  const scenario = scenarios.includes(pick) ? pick : (scenarios[0] ?? '');
  const rows = useMemo(() => sum.rows.filter((r) => r.scenario === scenario), [sum, scenario]);
  const stability = useMemo(
    () => (rows.length > 1 ? rankingStability(rows.map((r) => ({ name: r.condition, G: r.G, sub: r.sub })), weights, 200, 99) : null),
    [rows, weights],
  );
  if (!ok.length)
    return (
      <div className="space-y-2.5">
        <Card title="Race series">
          <EmptyState kinds={['m3-series']}>
            Races drone A against drone B on T4 Pinch, T9 Race loop, C8 Merge and C9 Figure-8 circuit under Independent, Nash and both Stackelberg planners, alternating start positions, and tests which differences are statistically supported.
          </EmptyState>
        </Card>
        <Footer planner />
      </div>
    );
  const tests = sum.tests.filter((t) => t.scenario === scenario);
  const statements = sum.statements.filter((s) => s.startsWith(`${scenario}:`)).map((s) => s.slice(scenario.length + 2).replace(/^./, (c) => c.toUpperCase()));
  const winData = rows.map((r) => ({ c: condShort(r.condition), cond: r.condition, n: r.n, winsA: r.winsA, p: r.binomialP, ...ciFields('win', wilsonStat(r.winRateA, r.n), 100) }));
  const irData = rows.map((r) => ({ c: condShort(r.condition), cond: r.condition, n: r.n, coll: r.collisions, ...ciFields('ir', r.intervention, 100) }));
  const colors = rows.map((r) => color(r.condition));
  const n = nRange(rows.map((r) => r.n));
  return (
    <div className="space-y-2.5">
      <Card title="Race series">
        <div className="space-y-2">
          <PartialNote run={run} />
          <Select label="Scenario" value={scenario} options={scenarios.map((s) => ({ value: s, label: s }))} onChange={setPick} />
          <div className="space-y-1">
            {statements.length ? (
              statements.map((s, i) => <Finding key={i}>{s}</Finding>)
            ) : (
              <Finding tone="amber">No difference between conditions on {scenario} is statistically supported after Holm correction at the 5% level (n = {n} races per condition).</Finding>
            )}
          </div>
          <div>
            <div className={H}>M18 win rate of drone A (Wilson 95% interval)</div>
            <CIBarChart
              data={winData}
              xKey="c"
              series={[{ key: 'win', name: 'A win rate', color: '#38bdf8' }]}
              cellColors={colors}
              yDomain={[0, 100]}
              yLabel="A wins (%)"
              unit="%"
              digits={0}
              refLines={[{ y: 50, label: '50%' }]}
              labelOf={(r) => `${r.cond}: A won ${r.winsA}/${r.n}, binomial p = ${pFmt(r.p as number)}`}
              height={165}
            />
          </div>
          <div>
            <div className={H}>M19 final progress gap A − B per race (bar: mean, 95% CI)</div>
            <StripPlot groups={rows.map((r) => ({ name: r.condition, color: color(r.condition), values: r.gaps, stat: r.gap }))} yLabel="gap (m)" unit=" m" height={175} />
          </div>
          <div>
            <div className={H}>M13 intervention rate per condition (95% CI)</div>
            <CIBarChart
              data={irData}
              xKey="c"
              series={[{ key: 'ir', name: 'intervention rate', color: '#f59e0b' }]}
              cellColors={colors}
              yLabel="M13 (%)"
              unit="%"
              labelOf={(r) => `${r.cond}: n = ${r.n}, collisions ${r.coll}`}
              height={150}
            />
          </div>
          <ExportButtons kind="m3-series" run={run} recs={recs} summary={() => summariseRaceSeries(ok, weights)} />
        </div>
      </Card>
      <Card title="Prediction fidelity (M20)">
        <FidelityScatter
          groups={rows.map((r) => ({ name: r.condition, color: color(r.condition), points: r.fidelity.map((f) => ({ x: f.predicted, y: f.realised })) }))}
          xLabel="predicted gap at horizon (m)"
          yLabel="realised gap (m)"
          height={230}
        />
        <div className="mt-1 grid grid-cols-2 gap-1">
          {rows.map((r) => (
            <div key={r.condition} className="flex items-center gap-1 text-[10px] text-slate-600 dark:text-slate-400">
              <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: color(r.condition) }} />
              <span className="truncate">{condShort(r.condition)}</span>
              <span className="tabular ml-auto font-mono">
                {r.predictionN ? `${((r.predictionCorrect / r.predictionN) * 100).toFixed(0)}% (${r.predictionCorrect}/${r.predictionN})` : '–'}
              </span>
            </div>
          ))}
        </div>
        <Note>Percentages: share of races where the planner's predicted winner won. Points on the dashed y = x line are perfectly predicted gaps; points in the off-diagonal quadrants predicted the wrong leader.</Note>
      </Card>
      <Card title="Scorecard per condition" right={<span className="text-[10px] font-normal text-slate-500">weights {weightsText(weights)}</span>}>
        <RadarOverlay series={rows.map((r) => ({ name: condShort(r.condition), color: color(r.condition), sub: r.sub }))} height={220} />
        <ScoreTable rows={rows} />
        {stability && (
          <div className="mt-2 flex flex-wrap items-center gap-1 text-[11px] text-slate-700 dark:text-slate-300">
            <span>Ranking stability:</span>
            <Badge tone={stability.share >= 0.8 ? 'emerald' : stability.share >= 0.5 ? 'amber' : 'rose'}>{(stability.share * 100).toFixed(0)}%</Badge>
            <span className="text-[10px] text-slate-500">of 200 random weight vectors keep the ranking {stability.reference.map((i) => condShort(rows[i].condition)).join(' > ')}.</span>
          </div>
        )}
        <details className="mt-2">
          <summary className="cursor-pointer text-[10px] text-slate-500 select-none">Adjust weights (shared with the Trials section)</summary>
          <div className="mt-1">
            <WeightSliders />
          </div>
        </details>
      </Card>
      <HolmTable tests={tests} />
      <Footer planner />
    </div>
  );
}
