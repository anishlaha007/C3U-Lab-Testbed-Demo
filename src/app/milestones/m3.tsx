/** Milestone 3 narration: game-theoretic racing (Section 12). */
import { useMemo, useState } from 'react';
import { PolarAngleAxis, PolarGrid, PolarRadiusAxis, Radar, RadarChart, ResponsiveContainer, Legend, Tooltip } from 'recharts';
import { DRONE_NAMES, PLANNER_LABEL } from '../../core/constants';
import { buildExperiment, RACE_CONDITIONS } from '../../core/experiments';
import { raceResult } from '../../core/metrics/racing';
import { compositeScore, type SubScores } from '../../core/metrics/scorecard';
import { useChartTheme } from '../charts/common';
import { useExperiments } from '../experiments';
import { requestSolve } from '../planner';
import { useStore, type RecordedTrial } from '../store';
import { Badge, Button, fmt, pct, Tabs } from '../ui';
import { fly, setup, showTab } from './actions';
import { m3Summary } from './summaries';
import type { GuideDef } from './types';
import { Actions, Box, Bullets, ExperimentStatus, NotRun, P, SimNote, useFinishedRecords } from './widgets';

/** Same colours as the Results tab charts. */
const COND_COLOR: Record<string, string> = { Independent: '#94a3b8', Nash: '#38bdf8', 'Stackelberg A leads': '#a78bfa', 'Stackelberg B leads': '#f59e0b' };
const COND_SHORT: Record<string, string> = { Independent: 'Indep.', Nash: 'Nash', 'Stackelberg A leads': 'Stack. A', 'Stackelberg B leads': 'Stack. B' };

const conditionOf = (t: RecordedTrial) => RACE_CONDITIONS.find((c) => c.solver === t.config.planner.solver && (c.solver !== 'stackelberg' || c.leader === t.config.planner.leader))?.name;

function PlannerBadge() {
  return <Badge tone="amber">{PLANNER_LABEL}</Badge>;
}

function GameStep() {
  const plan = useStore((s) => s.plan);
  const planStatus = useStore((s) => s.planStatus);
  const progress = useStore((s) => s.planProgress);
  const game = plan?.game;
  const label = (d: number, i: number) => plan?.candidates[d]?.[i]?.label ?? `#${i}`;
  const nashSet = new Set(game?.nash.map(([i, j]) => `${i},${j}`) ?? []);
  return (
    <div className="space-y-2">
      <P>
        T9: two drones race one lap of an oval with four gates. Each drone picks one of M candidate racing lines (sideways offsets and a speed level). Simulating every pair gives a payoff matrix: progress
        ahead of the rival, minus a penalty for time spent in each other’s downwash (Game tab).
      </P>
      <Bullets
        items={[
          <>
            <b>Nash</b> (green squares): neither drone could do better by changing only its own line. Both choose at the same time.
          </>,
          <>
            <b>Stackelberg</b> (stars): the leader commits first, knowing the follower will answer with its best reply. Leading can pay off, or force the leader to yield.
          </>,
          'Dots and rings mark each drone’s best reply to every choice of the other.',
        ]}
      />
      <Box title="This game" right={<PlannerBadge />}>
        {planStatus === 'solving' && <P muted>Solving the game… {(progress * 100).toFixed(0)}%</P>}
        {planStatus === 'error' && <P muted>The planner failed; press Solve to retry.</P>}
        {game && plan ? (
          <div className="space-y-1 text-[11px] text-slate-700 dark:text-slate-300">
            <div>
              {game.payoff1.length} × {game.payoff1[0]?.length ?? 0} candidate pairs, rollouts over {fmt(game.horizon, 1)} s.
            </div>
            <div>
              Pure Nash cells: <b>{game.nash.length}</b>
              {game.nash.slice(0, 3).map(([i, j]) => (
                <span key={`${i},${j}`} className="ml-1 font-mono text-[10px] text-emerald-600 dark:text-emerald-400">
                  ({label(0, i)} | {label(1, j)})
                </span>
              ))}
              {game.nash.length > 3 ? ' …' : ''}
            </div>
            {game.stackelberg.map((s) => (
              <div key={s.leader}>
                Stackelberg, {DRONE_NAMES[s.leader]} leads:{' '}
                <span className="font-mono text-[10px]">
                  ({label(0, s.i)} | {label(1, s.j)})
                </span>{' '}
                {nashSet.has(`${s.i},${s.j}`) ? <Badge tone="emerald">same as a Nash cell</Badge> : <Badge tone="violet">differs from Nash</Badge>}
              </div>
            ))}
            <div className="text-slate-500">
              Flown now ({plan.solver}): predicted winner {DRONE_NAMES[plan.prediction.winner] ?? '–'}, predicted gap {fmt(plan.prediction.gap, 2)} m.
            </div>
            <div className="text-[10px] text-slate-500">Labels: offset per quarter lap (L/l left, 0 centre, r/R right) @ speed level; A’s line | B’s line.</div>
          </div>
        ) : (
          planStatus !== 'solving' && <P muted>No game for this scene yet: load T9 (button below) and the planner solves it automatically.</P>
        )}
      </Box>
      <Actions>
        <Button small onClick={() => setup({ preset: 'T9', tab: 'game' })}>
          Load T9
        </Button>
        <Button small disabled={planStatus === 'solving'} onClick={() => void requestSolve()}>
          Solve again
        </Button>
        <Button small kind="ghost" onClick={() => showTab('game')}>
          Game tab
        </Button>
      </Actions>
    </div>
  );
}

function flyCondition(solver: (typeof RACE_CONDITIONS)[number]) {
  fly({
    preset: 'T9',
    tab: 'race',
    set: (c) => {
      c.planner.solver = solver.solver;
      c.planner.leader = solver.leader;
    },
  });
}

function RaceStep() {
  const cfg = useStore((s) => s.config);
  const trials = useStore((s) => s.trials);
  const planStatus = useStore((s) => s.planStatus);
  const latest = useMemo(() => {
    const m = new Map<string, { trial: RecordedTrial; res: ReturnType<typeof raceResult> }>();
    for (const t of trials) {
      if (t.config.scenario.preset !== 'T9') continue;
      const c = conditionOf(t);
      if (c && !m.has(c)) m.set(c, { trial: t, res: raceResult(t.log) });
    }
    return m;
  }, [trials]);
  const current = cfg.scenario.preset === 'T9' ? RACE_CONDITIONS.find((c) => c.solver === cfg.planner.solver && (c.solver !== 'stackelberg' || c.leader === cfg.planner.leader))?.name : undefined;
  return (
    <div className="space-y-2">
      <P>
        Fly one race per planner condition. Each button solves the game for that condition (a second or two), then flies it. The Race tab shows progress, the gap between the drones and overtakes.
      </P>
      <Actions>
        {RACE_CONDITIONS.map((c) => (
          <Button key={c.name} small kind={current === c.name ? 'primary' : 'default'} onClick={() => flyCondition(c)}>
            ▶ {c.name}
          </Button>
        ))}
      </Actions>
      {planStatus === 'solving' && <P muted>Solving the game for this condition…</P>}
      <Box title="Last race per condition (live runs)">
        <table className="w-full text-[10.5px]">
          <thead className="text-slate-500">
            <tr>
              <th className="text-left font-medium">condition</th>
              <th className="text-right font-medium">winner</th>
              <th className="text-right font-medium">gap A − B</th>
              <th className="text-right font-medium">G</th>
            </tr>
          </thead>
          <tbody className="tabular font-mono">
            {RACE_CONDITIONS.map((c) => {
              const r = latest.get(c.name);
              return (
                <tr key={c.name}>
                  <td className="font-sans" style={{ color: COND_COLOR[c.name] }}>
                    {c.name}
                  </td>
                  <td className="text-right">{r ? (r.res.winner >= 0 ? DRONE_NAMES[r.res.winner] : 'none') : '–'}</td>
                  <td className="text-right">{r ? `${fmt(r.res.gap, 2)} m` : '–'}</td>
                  <td className="text-right" title={r?.trial.evaluation.scorecard.gateReason}>
                    {r ? r.trial.evaluation.scorecard.G : '–'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <SimNote />
      </Box>
      <P muted>One race proves little: small timing differences decide close races. The next step repeats each condition many times.</P>
    </div>
  );
}

function SeriesStep() {
  // primitive selectors: an object selector would be a new snapshot on every store read
  const quick = useExperiments((s) => s.quick);
  const seed = useExperiments((s) => s.seed);
  const extended = useExperiments((s) => s.extended);
  const hardCourses = useExperiments((s) => s.hardCourses);
  const total = useMemo(() => buildExperiment('m3-series', { quick, seed, extended, hardCourses }).length, [quick, seed, extended, hardCourses]);
  const perCond = quick ? 10 : 30;
  return (
    <div className="space-y-2">
      <P>
        The race series repeats every condition {perCond} times{quick ? ' (quick demo; 30 with quick mode off in the Results tab)' : ''} on four scenarios: T4 pinch, T9 race loop, and the ring courses C8
        merge and C9 figure-8 circuit{hardCourses ? ', plus C10 and C6' : ''}. Start positions alternate and seeds vary, so luck evens out.
      </P>
      <Bullets
        items={[
          'Win rate of drone A with Wilson 95% intervals (the honest error bar for a proportion).',
          'Final progress gap, filter interventions, and how well the planner predicted the outcome.',
          'Every race solves its own game, so this takes longer than the other experiments.',
        ]}
      />
      <ExperimentStatus kind="m3-series" label={`M3 race series · ${total} races`} hint={`Fly ${total} races headlessly on the worker pool.`} />
    </div>
  );
}

function RadarMini({ series }: { series: { name: string; color: string; sub: SubScores }[] }) {
  const th = useChartTheme();
  const keys: (keyof SubScores)[] = ['S', 'V', 'A', 'E'];
  const names: Record<keyof SubScores, string> = { S: 'S safety', V: 'V speed', A: 'A accuracy', E: 'E effort' };
  const data = keys.map((k) => Object.fromEntries([['k', names[k]], ...series.map((s, i) => [`r${i}`, Number.isFinite(s.sub[k]) ? s.sub[k] : 0])]));
  return (
    <div style={{ height: 210 }}>
      <ResponsiveContainer width="100%" height="100%">
        <RadarChart data={data} outerRadius="66%" margin={{ top: 4, right: 8, bottom: 4, left: 8 }}>
          <PolarGrid stroke={th.grid} />
          <PolarAngleAxis dataKey="k" tick={{ fontSize: 10, fill: th.text }} />
          <PolarRadiusAxis domain={[0, 1]} tickCount={3} angle={90} tick={false} axisLine={false} />
          {series.map((s, i) => (
            <Radar key={s.name} dataKey={`r${i}`} name={COND_SHORT[s.name] ?? s.name} stroke={s.color} fill={s.color} fillOpacity={0.08} strokeWidth={1.5} isAnimationActive={false} />
          ))}
          <Legend wrapperStyle={{ fontSize: 10 }} iconSize={8} />
          <Tooltip contentStyle={{ background: th.tooltipBg, border: `1px solid ${th.tooltipBorder}`, fontSize: 11 }} formatter={(v) => (typeof v === 'number' ? v.toFixed(3) : String(v))} />
        </RadarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Race series summary for the current weights (finished runs only). */
function useSeries() {
  const weights = useStore((s) => s.weights);
  const { run, recs } = useFinishedRecords('m3-series');
  const s = useMemo(() => m3Summary(recs, weights), [recs, weights]);
  return { run, s, weights };
}

function RadarStep() {
  const { run, s, weights } = useSeries();
  const [pick, setPick] = useState<string | null>(null);
  if (!s) return <NotRun kind="m3-series">Race series: not run yet. Its sub-scores and rankings appear here.</NotRun>;
  const scenario = pick && s.scenarios.includes(pick) ? pick : s.scenarios[0];
  const rows = s.byScenario.get(scenario) ?? [];
  const st = s.stability.find((x) => x.scenario === scenario);
  return (
    <div className="space-y-2">
      <P>
        Each race also gets a scorecard: safety S, speed V, accuracy A and effort E, gated by G (0 after a crash). The radar shows the mean sub-scores per condition. Are the rankings robust? We redraw the
        weights at random 200 times and count how often the order stays the same.
      </P>
      <Tabs small value={scenario} options={s.scenarios.map((x) => ({ value: x, label: x.split(' ')[0] }))} onChange={setPick} />
      <Box title={scenario}>
        <RadarMini series={rows.map((r) => ({ name: r.condition, color: COND_COLOR[r.condition] ?? '#94a3b8', sub: r.sub }))} />
        <table className="mt-1 w-full text-[10.5px]">
          <thead className="text-slate-500">
            <tr>
              <th className="text-left font-medium">rank</th>
              <th className="text-left font-medium">condition</th>
              <th className="text-right font-medium">mean G</th>
              <th className="text-right font-medium">score</th>
            </tr>
          </thead>
          <tbody className="tabular font-mono">
            {(st?.ranking ?? rows.map((r) => r.condition)).map((name, k) => {
              const r = rows.find((x) => x.condition === name);
              return (
                <tr key={name}>
                  <td>{k + 1}</td>
                  <td className="font-sans" style={{ color: COND_COLOR[name] }}>
                    {name}
                  </td>
                  <td className="text-right">{fmt(r?.G, 2)}</td>
                  <td className="text-right">{r ? fmt(compositeScore(r.G, r.sub, weights), 3) : '–'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {st && (
          <div className="mt-1 text-[11px] text-slate-700 dark:text-slate-300">
            Ranking stability: the order holds for <b>{pct(st.share, 0)}</b> of 200 random weightings{st.share >= 0.8 ? ' — robust to the choice of weights.' : st.share >= 0.5 ? ' — mostly robust.' : ' — depends on the weights.'}
          </div>
        )}
        <SimNote run={run} />
      </Box>
      <P muted>Score uses the current weights (change them in Scorecard mode). The Results tab has the full charts.</P>
    </div>
  );
}

function SummaryStep() {
  const { run, s } = useSeries();
  if (!s) return <NotRun kind="m3-series">Race series: not run yet. The statistically supported differences appear here.</NotRun>;
  const conds = RACE_CONDITIONS.map((c) => c.name);
  // the supported differences, one compact line per test (the full sentences are in the Results tab)
  const metricName = { 'win rate A': 'A’s win rate', 'progress gap': 'final gap A − B', 'intervention rate': 'interventions' } as const;
  const groups = s.scenarios.map((sc) => ({
    sc,
    items: s.tests
      .filter((t) => t.scenario === sc && t.significant)
      .map((t) => (
        <>
          {metricName[t.metric]}: <span style={{ color: COND_COLOR[t.a] }}>{COND_SHORT[t.a] ?? t.a}</span> vs <span style={{ color: COND_COLOR[t.b] }}>{COND_SHORT[t.b] ?? t.b}</span>{' '}
          <span className="tabular font-mono text-[10px] text-slate-500">
            Δ {t.diff >= 0 ? '+' : ''}
            {fmt(t.diff, 2)} · p<sub>Holm</sub> {fmt(t.pHolm, 3)}
          </span>
        </>
      )),
  }));
  const none = groups.every((g) => !g.items.length);
  return (
    <div className="space-y-2">
      <P>
        Drone A’s win rate per condition, with Wilson 95% intervals ({s.races} races in total). Differences count as supported only if they survive Holm’s correction for testing many pairs at once.
      </P>
      <Box title="Win rate of drone A">
        <table className="w-full text-[10px]">
          <thead className="text-slate-500">
            <tr>
              <th className="text-left font-medium">scenario</th>
              {conds.map((c) => (
                <th key={c} className="text-right font-medium" style={{ color: COND_COLOR[c] }}>
                  {COND_SHORT[c]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="tabular font-mono">
            {s.scenarios.map((sc) => (
              <tr key={sc}>
                <td className="font-sans whitespace-nowrap">{sc.split(' ')[0]}</td>
                {conds.map((c) => {
                  const r = s.byScenario.get(sc)?.find((x) => x.condition === c);
                  return (
                    <td key={c} className="text-right" title={r ? `${r.winsA} of ${r.n} races; 95% interval ${pct(r.winRateA.lo, 0)}–${pct(r.winRateA.hi, 0)}` : undefined}>
                      {r ? (
                        <>
                          {pct(r.winRateA.p, 0)}
                          <span className="text-slate-500"> {(r.winRateA.lo * 100).toFixed(0)}–{(r.winRateA.hi * 100).toFixed(0)}</span>
                        </>
                      ) : (
                        '–'
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </Box>
      <Box title="Statistically supported (Holm-corrected, 5%)">
        {none ? (
          <P>{s.statements[0]}</P>
        ) : (
          <div className="space-y-1.5">
            {groups
              .filter((g) => g.items.length)
              .map((g) => (
                <div key={g.sc}>
                  <div className="mb-0.5 text-[10.5px] font-semibold text-slate-600 dark:text-slate-300">{g.sc}</div>
                  <Bullets items={g.items} tone="emerald" />
                </div>
              ))}
            {groups.some((g) => !g.items.length) && <P muted>No supported difference on {groups.filter((g) => !g.items.length).map((g) => g.sc).join(', ')}.</P>}
            <P muted>Δ: first condition minus second (win rate and interventions as shares, gap in metres); two-sided permutation tests, Holm-corrected within each scenario.</P>
          </div>
        )}
        <SimNote run={run} />
      </Box>
      <P muted>{PLANNER_LABEL}: the conclusions are about these stand-ins in simulation, not the lab’s solvers on hardware.</P>
    </div>
  );
}

export const M3_GUIDE: GuideDef = {
  mode: 'm3',
  label: 'Milestone 3',
  title: 'Game-theoretic racing',
  steps: [
    { title: 'Nash vs Stackelberg', enter: () => setup({ preset: 'T9', tab: 'game', camera: 'top' }), Body: GameStep },
    { title: 'One race per condition', enter: () => fly({ preset: 'T9', tab: 'race', camera: 'orbit' }), Body: RaceStep },
    { title: 'Race series', enter: () => showTab('results'), Body: SeriesStep },
    { title: 'Sub-scores and ranking stability', enter: () => showTab('results'), Body: RadarStep },
    { title: 'What the statistics support', enter: () => showTab('results'), Body: SummaryStep },
  ],
};
