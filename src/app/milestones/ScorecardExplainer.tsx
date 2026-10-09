/**
 * Scorecard mode (Sections 9 and 12): an interactive explainer of
 *   Score = G × (wS·S + wV·V + wA·A + wE·E) / (wS + wV + wA + wE).
 * The weights are the app's weights (they also score live trials and experiments); the gate values
 * of the worked example and of recorded trials can be overridden here as a what-if, so the
 * ranking can flip. Everything shown is recomputed with the core compositeScore / ranking code.
 */
import { useMemo } from 'react';
import { create } from 'zustand';
import { EQUAL_WEIGHTS, type SubScores, type Weights } from '../../core/metrics/scorecard';
import { useStore } from '../store';
import { Badge, Button, cx, fmt, pct, Slider, Tabs } from '../ui';
import { fly, showTab } from './actions';
import { GATE_LEVELS, rankItems, WORKED_STRATEGIES, weightSum, type ScoredItem } from './summaries';
import type { GuideDef } from './types';
import { Actions, Box, Bullets, P } from './widgets';

interface DemoState {
  /** Gate overrides by item key (what-if); absent = the item's own G. */
  gates: Record<string, number>;
  /** Item shown in the diagram. */
  focus: string;
  setGate: (key: string, G: number | null) => void;
  setFocus: (key: string) => void;
  resetGates: () => void;
}

const useDemo = create<DemoState>((set, get) => ({
  gates: {},
  focus: 'ex1',
  setGate: (key, G) => {
    const gates = { ...get().gates };
    if (G === null) delete gates[key];
    else gates[key] = G;
    set({ gates });
  },
  setFocus: (focus) => set({ focus }),
  resetGates: () => set({ gates: {} }),
}));

type Item = Omit<ScoredItem, 'score'> & { actualG: number; reason: string };

/** The worked example plus (optionally) the recorded live trials, with gate overrides applied. */
function useItems(withTrials: boolean): Item[] {
  const trials = useStore((s) => s.trials);
  const gates = useDemo((s) => s.gates);
  return useMemo(() => {
    const ex: Item[] = WORKED_STRATEGIES.map((x, i) => {
      const key = `ex${i + 1}`;
      return { key, name: x.name, detail: 'worked example (Section 12)', kind: 'example', G: gates[key] ?? 1, actualG: 1, reason: 'clean', sub: x.sub };
    });
    if (!withTrials) return ex;
    // the 12 most recent trials keep the table readable
    const tr: Item[] = trials.slice(0, 12).map((t) => {
      const key = `t${t.id}`;
      const sc = t.evaluation.scorecard;
      return { key, name: t.name, detail: t.condition, kind: 'trial', G: gates[key] ?? sc.G, actualG: sc.G, reason: sc.gateReason, sub: sc.sub };
    });
    return [...ex, ...tr];
  }, [trials, gates, withTrials]);
}

const GATE_SHORT: Record<string, string> = { '1': 'clean', '0.75': 'violation', '0.5': 'brake / hover', '0': 'crash / miss' };
const gateTone = (G: number) => (G >= 1 ? 'emerald' : G >= 0.75 ? 'amber' : G > 0 ? 'violet' : 'rose');
const GATE_FILL: Record<string, string> = { emerald: 'fill-emerald-500/20 stroke-emerald-500', amber: 'fill-amber-500/20 stroke-amber-500', violet: 'fill-violet-500/20 stroke-violet-500', rose: 'fill-rose-500/20 stroke-rose-500' };

const SUBS: { k: keyof SubScores; name: string; def: string; formula: string }[] = [
  { k: 'S', name: 'safety', formula: '½ [(1 − M13) + min(1, M11)]', def: 'few filter corrections and never inside another drone’s downwash zone' },
  { k: 'V', name: 'speed', formula: 'min(1, planned lap / actual lap)', def: 'kept to the planned schedule' },
  { k: 'A', name: 'accuracy', formula: 'max(0, 1 − RMSE / 0.30 m)', def: 'close to the reference path (0 at 30 cm RMSE)' },
  { k: 'E', name: 'effort', formula: 'min(1, planned effort / actual effort)', def: 'no more thrust than the plan needed' },
];

/** Four sub-scores feed a weighted mean; the gate G multiplies it. */
function ScoreDiagram({ sub, G, w }: { sub: SubScores; G: number; w: Weights }) {
  const W = weightSum(w);
  const mean = W > 0 ? (w.S * sub.S + w.V * sub.V + w.A * sub.A + w.E * sub.E) / W : 0;
  const tone = gateTone(G);
  return (
    <svg viewBox="0 0 380 152" className="w-full" role="img" aria-label="Score diagram: four sub-scores, weighted mean, gate, score">
      {SUBS.map((s, k) => {
        const y = 2 + k * 38;
        const share = W > 0 ? w[s.k] / W : 0;
        return (
          <g key={s.k}>
            <rect x={2} y={y} width={104} height={32} rx={4} className="fill-white stroke-slate-300 dark:fill-slate-900 dark:stroke-slate-600" />
            <text x={8} y={y + 13} fontSize={10} className="fill-slate-700 dark:fill-slate-200">
              <tspan fontWeight={700}>{s.k}</tspan> {s.name}
            </text>
            <text x={100} y={y + 13} fontSize={10} textAnchor="end" className="fill-slate-900 font-mono dark:fill-slate-100">
              {fmt(sub[s.k], 2)}
            </text>
            <rect x={8} y={y + 20} width={92} height={5} rx={2} className="fill-slate-200 dark:fill-slate-800" />
            <rect x={8} y={y + 20} width={92 * Math.max(0, Math.min(1, sub[s.k]))} height={5} rx={2} className="fill-sky-500" />
            <line x1={106} y1={y + 16} x2={172} y2={78} className="stroke-sky-500" strokeOpacity={0.35 + 0.65 * share} strokeWidth={0.6 + 7 * share} />
            <text x={112} y={y + 11} fontSize={8.5} className="fill-slate-500 font-mono">
              w{s.k} {fmt(w[s.k], 2)}
            </text>
          </g>
        );
      })}
      <rect x={172} y={56} width={82} height={44} rx={6} className="fill-sky-500/10 stroke-sky-500" />
      <text x={213} y={72} fontSize={9} textAnchor="middle" className="fill-slate-600 dark:fill-slate-300">
        weighted mean
      </text>
      <text x={213} y={91} fontSize={14} fontWeight={700} textAnchor="middle" className="fill-slate-900 font-mono dark:fill-slate-100">
        {fmt(mean, 3)}
      </text>
      <text x={213} y={116} fontSize={8.5} textAnchor="middle" className="fill-slate-500">
        Σ wₖ·k / Σ wₖ
      </text>
      <line x1={254} y1={78} x2={268} y2={78} className="stroke-slate-400" strokeWidth={1.5} />
      <rect x={268} y={58} width={46} height={40} rx={6} className={GATE_FILL[tone]} />
      <text x={291} y={73} fontSize={9} textAnchor="middle" className="fill-slate-600 dark:fill-slate-300">
        × gate G
      </text>
      <text x={291} y={90} fontSize={13} fontWeight={700} textAnchor="middle" className="fill-slate-900 font-mono dark:fill-slate-100">
        {G}
      </text>
      <line x1={314} y1={78} x2={326} y2={78} className="stroke-slate-400" strokeWidth={1.5} />
      <rect x={326} y={54} width={52} height={48} rx={6} className="fill-emerald-500/10 stroke-emerald-500" strokeWidth={1.5} />
      <text x={352} y={70} fontSize={9} textAnchor="middle" className="fill-slate-600 dark:fill-slate-300">
        Score
      </text>
      <text x={352} y={90} fontSize={14} fontWeight={700} textAnchor="middle" className="fill-emerald-700 font-mono dark:fill-emerald-300">
        {fmt(G * mean, 3)}
      </text>
    </svg>
  );
}

function FocusPicker({ items }: { items: Item[] }) {
  const focus = useDemo((s) => s.focus);
  const setFocus = useDemo((s) => s.setFocus);
  const opts = items.slice(0, 4).map((x) => ({ value: x.key, label: x.kind === 'example' ? x.name : x.name.length > 14 ? `${x.name.slice(0, 13)}…` : x.name, title: x.detail }));
  return <Tabs small value={items.some((x) => x.key === focus) ? focus : items[0].key} options={opts} onChange={setFocus} />;
}

function useFocusItem(items: Item[]): Item {
  const focus = useDemo((s) => s.focus);
  return items.find((x) => x.key === focus) ?? items[0];
}

function WeightSliders() {
  const w = useStore((s) => s.weights);
  const setWeights = useStore((s) => s.setWeights);
  const equal = (Object.keys(EQUAL_WEIGHTS) as (keyof Weights)[]).every((k) => Math.abs(w[k] - w.S) < 1e-9);
  return (
    <Box title="Weights" right={<Button small kind="ghost" disabled={equal} onClick={() => setWeights({ ...EQUAL_WEIGHTS })}>Equal weights</Button>}>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1">
        {SUBS.map((s) => (
          <Slider
            key={s.k}
            label={`w${s.k} ${s.name}`}
            value={w[s.k]}
            min={0}
            max={3}
            step={0.05}
            format={(v) => `${v.toFixed(2)} (${pct(weightSum(w) > 0 ? v / weightSum(w) : 0, 0)})`}
            onChange={(v) => setWeights({ ...w, [s.k]: v })}
          />
        ))}
      </div>
      {weightSum(w) <= 0 && <div className="mt-1 text-[10px] text-rose-600 dark:text-rose-400">All weights are zero: every score is 0.</div>}
      <div className="mt-1 text-[10px] text-slate-500">These weights also score live trials and the milestone experiments.</div>
    </Box>
  );
}

function GateSelect({ item }: { item: Item }) {
  const setGate = useDemo((s) => s.setGate);
  return (
    <select
      className={cx('rounded border bg-white px-0.5 py-0 font-mono text-[10px] dark:bg-slate-900', item.G !== item.actualG ? 'border-amber-500' : 'border-slate-300 dark:border-slate-700')}
      value={String(item.G)}
      title={item.G !== item.actualG ? `What-if: the run’s own gate was ${item.actualG} (${item.reason})` : `${item.reason}`}
      onChange={(e) => {
        const G = Number(e.target.value);
        setGate(item.key, G === item.actualG ? null : G);
      }}
    >
      {GATE_LEVELS.map((g) => (
        <option key={g.G} value={String(g.G)} title={g.reason}>
          {g.G} {GATE_SHORT[String(g.G)]}
        </option>
      ))}
    </select>
  );
}

function RankingTable({ items, showQuoted }: { items: Item[]; showQuoted?: boolean }) {
  const w = useStore((s) => s.weights);
  const { ranked, stability } = useMemo(() => rankItems(items, w), [items, w]);
  const byKey = new Map(items.map((x) => [x.key, x]));
  return (
    <div>
      <table className="w-full text-[10px]">
        <thead className="text-slate-500">
          <tr>
            <th className="text-left font-medium">#</th>
            <th className="text-left font-medium">run</th>
            <th className="text-left font-medium">gate G</th>
            {SUBS.map((s) => (
              <th key={s.k} className="pl-1.5 text-right font-medium">
                {s.k}
              </th>
            ))}
            <th className="pl-1.5 text-right font-medium">score</th>
            {showQuoted && <th className="pl-1.5 text-right font-medium" title="Value quoted in the spec (equal weights, rounded)">spec</th>}
          </tr>
        </thead>
        <tbody className="tabular font-mono">
          {ranked.map((r) => {
            const it = byKey.get(r.key)!;
            const quoted = WORKED_STRATEGIES.find((x) => x.name === r.name)?.quoted;
            return (
              <tr key={r.key} className={r.rank === 1 ? 'text-emerald-700 dark:text-emerald-300' : ''}>
                <td>{r.rank}</td>
                <td className="max-w-[110px] truncate font-sans" title={r.detail}>
                  {r.name}
                </td>
                <td>
                  <GateSelect item={it} />
                </td>
                {SUBS.map((s) => (
                  <td key={s.k} className="pl-1.5 text-right">
                    {fmt(r.sub[s.k], 2)}
                  </td>
                ))}
                <td className="pl-1.5 text-right font-semibold">{fmt(r.score, 3)}</td>
                {showQuoted && <td className="pl-1.5 text-right text-slate-500">{quoted !== undefined && r.kind === 'example' ? fmt(quoted, 2) : ''}</td>}
              </tr>
            );
          })}
        </tbody>
      </table>
      {stability !== null && (
        <div className="mt-1.5 text-[11px] text-slate-700 dark:text-slate-300">
          Ranking stability: this order holds for <b>{pct(stability, 0)}</b> of 200 random weightings.
        </div>
      )}
    </div>
  );
}

function Structure() {
  const items = useItems(true);
  const it = useFocusItem(items);
  const w = useStore((s) => s.weights);
  return (
    <div className="space-y-2">
      <P>
        Every run, live or headless, gets one score from 0 to 1. Four sub-scores say how well it went; a <b>gate</b> G then multiplies the result, so a run that crashed scores 0 however neat it was.
      </P>
      <div className="rounded bg-slate-100 px-2 py-1 text-center font-mono text-[10.5px] text-slate-800 dark:bg-slate-800/70 dark:text-slate-200">Score = G × (wS·S + wV·V + wA·A + wE·E) / (wS + wV + wA + wE)</div>
      <FocusPicker items={items} />
      <ScoreDiagram sub={it.sub} G={it.G} w={w} />
      <Box title="The four sub-scores">
        <div className="space-y-1">
          {SUBS.map((s) => (
            <div key={s.k} className="text-[10.5px] leading-snug text-slate-700 dark:text-slate-300">
              <b>
                {s.k} {s.name}
              </b>{' '}
              = <span className="font-mono">{s.formula}</span>: {s.def}.
            </div>
          ))}
        </div>
      </Box>
      <P muted>M13 is the filter intervention rate, M11 the closest approach (scaled separation), RMSE the tracking error (Section 9).</P>
    </div>
  );
}

function WeightsStep() {
  const items = useItems(false);
  const it = useFocusItem(items);
  const w = useStore((s) => s.weights);
  return (
    <div className="space-y-2">
      <P>
        The worked example compares two strategies. Strategy 1 is safer and more accurate; Strategy 2 is faster. With equal weights Strategy 1 wins; move the weights toward speed and watch the
        scores.
      </P>
      <WeightSliders />
      <FocusPicker items={items} />
      <ScoreDiagram sub={it.sub} G={it.G} w={w} />
      <Box title="Worked example">
        <RankingTable items={items} showQuoted />
      </Box>
      <P muted>The spec quotes 0.85 and 0.81 at equal weights (0.845 and 0.8075, rounded).</P>
    </div>
  );
}

function GateStep() {
  const items = useItems(false);
  const setGate = useDemo((s) => s.setGate);
  const reset = useDemo((s) => s.resetGates);
  const changed = items.some((x) => x.G !== x.actualG);
  return (
    <div className="space-y-2">
      <P>
        The gate is not one more weight: it multiplies everything. A crash costs the whole score, an emergency brake half of it, a brush with another drone’s downwash a quarter. Change a gate and the
        ranking can flip.
      </P>
      <Box title="Worked example with gates" right={changed ? <Button small kind="ghost" onClick={reset}>Reset gates</Button> : undefined}>
        <RankingTable items={items} />
      </Box>
      <Actions>
        <Button small onClick={() => setGate('ex1', 0.75)} title="Strategy 1 dipped into the downwash zone without contact">
          Strategy 1 had a near miss (G 0.75)
        </Button>
        <Button small onClick={() => setGate('ex2', 0)} title="Strategy 2 crashed">
          Strategy 2 crashed (G 0)
        </Button>
      </Actions>
      <Box title="Gate levels">
        <Bullets
          items={GATE_LEVELS.map((g) => (
            <>
              <Badge tone={gateTone(g.G)}>G = {g.G}</Badge> {g.reason}
            </>
          ))}
        />
      </Box>
    </div>
  );
}

function TrialsStep() {
  const items = useItems(true);
  const trials = useStore((s) => s.trials);
  const reset = useDemo((s) => s.resetGates);
  const changed = items.some((x) => x.G !== x.actualG);
  return (
    <div className="space-y-2">
      <P>
        Your own runs join the ranking: every live trial is scored when it ends, with the gate it actually earned (hover a gate for the reason). Changing a gate here is a what-if; the recorded trial is not
        altered.
      </P>
      <Box title={`Ranking (${items.length} runs)`} right={changed ? <Button small kind="ghost" onClick={reset}>Reset gates</Button> : undefined}>
        <RankingTable items={items} />
        {!trials.length && <div className="mt-1 text-[10.5px] text-slate-500">No recorded trials yet in this session: fly one below (recording is on by default).</div>}
      </Box>
      <Actions>
        <Button small kind="primary" onClick={() => fly({ preset: 'T1', tab: 'results' })}>
          ▶ Fly T1 (clean)
        </Button>
        <Button small onClick={() => fly({ preset: 'T11', tab: 'results' })} title="T5 intersection with the filter off: expect G = 0">
          ▶ Fly T11 (filter off)
        </Button>
        <Button small onClick={() => fly({ preset: 'T5', tab: 'results' })}>
          ▶ Fly T5 (filter on)
        </Button>
      </Actions>
      <P muted>Simulation results; the Results tab (Trials) has the radar of each run’s sub-scores.</P>
    </div>
  );
}

export const SCORECARD_GUIDE: GuideDef = {
  mode: 'scorecard',
  label: 'Scorecard',
  title: 'How every run is scored',
  steps: [
    { title: 'Four sub-scores and a gate', Body: Structure },
    { title: 'Weights and the worked example', Body: WeightsStep },
    { title: 'The gate can flip the ranking', Body: GateStep },
    { title: 'Your own trials', enter: () => showTab('results'), Body: TrialsStep },
  ],
};
