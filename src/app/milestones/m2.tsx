/** Milestone 2 narration: safety-filtered tracking (Section 12). */
import { useMemo } from 'react';
import { defaultDrone } from '../../core/defaults';
import { useStore, type RecordedTrial } from '../store';
import { Badge, Button, fmt, pct, Stat, Tabs } from '../ui';
import { autoRun, fly, setup, showTab } from './actions';
import { CbfExampleCard } from './FormulaCards';
import { m2Margins, m2Safety, m2Scaling, m2Statements } from './summaries';
import type { GuideDef } from './types';
import { Actions, Box, Bullets, ExperimentStatus, NotRun, P, SimNote, useFinishedRecords, useLatestTrial } from './widgets';

const preset = (t: RecordedTrial) => t.config.scenario.preset;

/** Safety numbers of one recorded live trial. */
function SafetyNumbers({ trial }: { trial: RecordedTrial | undefined }) {
  if (!trial) return <P muted>Not flown yet in this session.</P>;
  const { safety, scorecard } = trial.evaluation;
  const hit = safety.collisions > 0;
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5 text-[11px]">
        {hit ? <Badge tone="rose">collision</Badge> : <Badge tone="emerald">no contact</Badge>}
        <span className="text-slate-500">
          G = {scorecard.G}
          {scorecard.G < 1 ? ` (${scorecard.gateReason})` : ''}
        </span>
      </div>
      <div className="tabular font-mono text-[10.5px] text-slate-700 dark:text-slate-300">
        <div className="flex justify-between" title="M11: minimum scaled separation; below 1 means inside the downwash ellipsoid.">
          <span className="font-sans text-slate-500">closest s</span>
          <span className={safety.closestApproach >= 1 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}>{fmt(safety.closestApproach, 2)}</span>
        </div>
        <div className="flex justify-between" title="M13: share of control ticks where the filter changed a command by more than 0.05 m/s².">
          <span className="font-sans text-slate-500">interventions</span>
          <span>{pct(safety.interventionRate, 0)}</span>
        </div>
      </div>
    </div>
  );
}

function SafeSet() {
  return (
    <div className="space-y-2">
      <P>
        A drone’s propellers push air down. Another drone flying through that column, or too close beside it, can lose lift. So each pair of drones must keep out of an ellipsoid around each other that is
        tall in z (the see-through shapes around the drones in the scene).
      </P>
      <P>
        The <b>safety filter</b> sits between the planner and the drones. Each tick it measures the pair’s room with a barrier function <span className="font-mono">h = dpᵀ D dp − 1</span>: positive
        outside the ellipsoid, zero on its surface. It then changes the commanded accelerations as little as possible so that <span className="font-mono">ḧ + 2λḣ + λ²h ≥ 0</span>, which keeps h from ever
        reaching zero (λ sets how early it reacts).
      </P>
      <CbfExampleCard />
    </div>
  );
}

function FilterOffOn() {
  const off = useLatestTrial((t) => preset(t) === 'T11');
  const on = useLatestTrial((t) => preset(t) === 'T5' && t.config.filter.enabled);
  const cfg = useStore((s) => s.config);
  const current = (id: string) => cfg.scenario.preset === id;
  return (
    <div className="space-y-2">
      <P>
        T5: two drones share one figure-8, half a lap apart, so they meet at the crossing point twice per lap. First with the filter switched off (preset T11), then on. Each run is recorded when it ends;
        the Safety tab shows the separation over time.
      </P>
      <div className="grid grid-cols-2 gap-1.5">
        <Box title="Filter off (T11)">
          <SafetyNumbers trial={off} />
        </Box>
        <Box title="Filter on (T5)">
          <SafetyNumbers trial={on} />
        </Box>
      </div>
      <Actions>
        <Button small kind={current('T11') ? 'primary' : 'default'} onClick={() => fly({ preset: 'T11', tab: 'safety' })}>
          ▶ Filter off (T11)
        </Button>
        <Button small kind={current('T5') ? 'primary' : 'default'} onClick={() => fly({ preset: 'T5', tab: 'safety' })}>
          ▶ Filter on (T5)
        </Button>
      </Actions>
      <SimNote />
    </div>
  );
}

function Sweeps() {
  const saf = useFinishedRecords('m2-safety');
  const mar = useFinishedRecords('m2-margins');
  const s = useMemo(() => m2Safety(saf.recs), [saf.recs]);
  const m = useMemo(() => m2Margins(mar.recs), [mar.recs]);
  const statements = useMemo(() => m2Statements(s, m, null), [s, m]);
  return (
    <div className="space-y-2">
      <P>
        <b>Safety sweep:</b> T5 at 3 speeds × 3 ellipsoid margins × latency compensation on/off × 2 filter types. The Results tab shows heatmaps of the closest approach and of how often the filter steps in,
        and the cost of safety against the margin.
      </P>
      <ExperimentStatus kind="m2-safety" />
      <P>
        <b>Margin sweep:</b> single drones through the C6 forest and the C5 course with 4 obstacle margins × 4 gate margins. Margins buy safety, but a filter that keeps too far from everything starts
        blocking the gates the drone is meant to fly through: that is <b>conservatism</b>.
      </P>
      <ExperimentStatus kind="m2-margins" hint="About 10 s in quick mode on the worker pool." />
      {statements.length > 0 && (
        <Box title="Findings">
          <Bullets items={statements} />
          <SimNote />
        </Box>
      )}
    </div>
  );
}

const SCALING_PRESETS = [
  { value: 'T7', label: 'T7 antipodal swap' },
  { value: 'T8', label: 'T8 random crossing' },
];

function flyN(id: string, n: number) {
  fly({
    preset: id,
    tab: 'safety',
    set: (c) => {
      c.drones = Array.from({ length: n }, (_, i) => c.drones[i] ?? defaultDrone(i));
    },
  });
}

function Scaling() {
  const cfg = useStore((s) => s.config);
  const id = cfg.scenario.preset === 'T8' ? 'T8' : 'T7';
  const n = cfg.scenario.preset === 'T7' || cfg.scenario.preset === 'T8' ? cfg.drones.length : 4;
  const sc = useFinishedRecords('m2-scaling');
  const s = useMemo(() => m2Scaling(sc.recs), [sc.recs]);
  const t10off = useLatestTrial((t) => preset(t) === 'T10' && !t.config.filter.latencyCompensation);
  const t10on = useLatestTrial((t) => preset(t) === 'T10' && t.config.filter.latencyCompensation);
  return (
    <div className="space-y-2">
      <P>With more drones the filter solves one small optimisation over all pairs at once. Pick a scenario and a drone count to fly it:</P>
      <Box>
        <div className="flex flex-wrap items-center gap-1.5">
          <Tabs small value={id} options={SCALING_PRESETS} onChange={(v) => flyN(v, n)} />
          <Tabs small value={String(n)} options={[2, 3, 4, 5, 6].map((k) => ({ value: String(k), label: `${k}` }))} onChange={(v) => flyN(id, Number(v))} />
          <span className="text-[10px] text-slate-500">drones</span>
        </div>
      </Box>
      <ExperimentStatus kind="m2-scaling" />
      {s && (
        <Box title="Interventions and solve time vs drone count">
          <table className="w-full text-[10.5px]">
            <thead className="text-slate-500">
              <tr>
                <th className="text-left font-medium">drones</th>
                {s.scenarios.map((x) => (
                  <th key={x} className="text-right font-medium" colSpan={2}>
                    {x}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="tabular font-mono">
              {[...new Set(s.rows.map((r) => r.n))].map((k) => (
                <tr key={k}>
                  <td>{k}</td>
                  {s.scenarios.map((x) => {
                    const r = s.rows.find((q) => q.scenario === x && q.n === k);
                    return [
                      <td key={`${x}i`} className="text-right" title="intervention rate">
                        {pct(r?.intervention.mean, 0)}
                      </td>,
                      <td key={`${x}s`} className="text-right text-slate-500" title="99th-percentile filter solve time per tick">
                        {fmt(r?.solveP99.mean, 2)} ms
                      </td>,
                    ];
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          <SimNote run={sc.run} />
        </Box>
      )}
      <Box title="T10 latency stress">
        <P>
          Head-on at 3 m/s each with 80 ms of delay. Without latency compensation the filter acts on positions that are 80 ms old and the pair collides; with it, the filter predicts where the drones are now
          and holds.
        </P>
        <div className="mt-1.5 grid grid-cols-2 gap-1.5">
          <div>
            <div className="mb-0.5 text-[10px] font-medium text-slate-500">compensation off</div>
            <SafetyNumbers trial={t10off} />
          </div>
          <div>
            <div className="mb-0.5 text-[10px] font-medium text-slate-500">compensation on</div>
            <SafetyNumbers trial={t10on} />
          </div>
        </div>
        <div className="mt-1.5">
          <Actions>
            <Button small onClick={() => fly({ preset: 'T10', tab: 'safety', set: (c) => (c.filter.latencyCompensation = false) })}>
              ▶ T10, compensation off
            </Button>
            <Button small onClick={() => fly({ preset: 'T10', tab: 'safety', set: (c) => (c.filter.latencyCompensation = true) })}>
              ▶ T10, compensation on
            </Button>
          </Actions>
        </div>
      </Box>
    </div>
  );
}

function Summary() {
  const saf = useFinishedRecords('m2-safety');
  const mar = useFinishedRecords('m2-margins');
  const sca = useFinishedRecords('m2-scaling');
  const s = useMemo(() => m2Safety(saf.recs), [saf.recs]);
  const m = useMemo(() => m2Margins(mar.recs), [mar.recs]);
  const sc = useMemo(() => m2Scaling(sca.recs), [sca.recs]);
  const statements = useMemo(() => m2Statements(s, m, sc), [s, m, sc]);
  const off = useLatestTrial((t) => preset(t) === 'T11');
  const on = useLatestTrial((t) => preset(t) === 'T5' && t.config.filter.enabled);
  return (
    <div className="space-y-2">
      <P>What Milestone 2 shows:</P>
      {(off || on) && (
        <div className="grid grid-cols-2 gap-1.5">
          <Stat label="T11 filter off" value={off ? (off.evaluation.safety.collisions ? 'collision' : 'no contact') : '–'} tone={off ? (off.evaluation.safety.collisions ? 'bad' : 'good') : undefined} />
          <Stat label="T5 filter on" value={on ? (on.evaluation.safety.collisions ? 'collision' : `closest s ${fmt(on.evaluation.safety.closestApproach, 2)}`) : '–'} tone={on ? (on.evaluation.safety.collisions ? 'bad' : 'good') : undefined} />
        </div>
      )}
      {s ? (
        <div className="grid grid-cols-3 gap-1.5">
          <Stat label="sweep trials" value={`${s.n}`} />
          <Stat label="with collision" value={`${s.withCollision}`} tone={s.withCollision ? 'bad' : 'good'} />
          <Stat label="closest s" value={fmt(s.closestMin, 2)} tone={s.closestMin >= 1 ? 'good' : 'warn'} tip="Lowest scaled separation in any trial of the sweep." />
        </div>
      ) : (
        <NotRun kind="m2-safety">Safety sweep: not run yet.</NotRun>
      )}
      {!m && <NotRun kind="m2-margins">Margin sweep: not run yet.</NotRun>}
      {!sc && <NotRun kind="m2-scaling">Drone-count scaling: not run yet.</NotRun>}
      {statements.length > 0 && (
        <Box title="In plain words">
          <Bullets items={statements} />
          <SimNote />
        </Box>
      )}
    </div>
  );
}

export const M2_GUIDE: GuideDef = {
  mode: 'm2',
  label: 'Milestone 2',
  title: 'Safety-filtered tracking',
  steps: [
    {
      title: 'The safe set and the barrier function',
      enter: () => setup({ preset: 'T5', tab: 'safety', camera: 'orbit', visuals: { ellipsoids: true, separation: true } }),
      Body: SafeSet,
    },
    { title: 'Without the filter, then with it', enter: () => fly({ preset: 'T11', tab: 'safety', visuals: { ellipsoids: true } }), Body: FilterOffOn },
    { title: 'Safety and margin sweeps', enter: () => autoRun('m2-safety'), Body: Sweeps },
    {
      title: 'More drones, and latency',
      enter: () => {
        flyN('T7', 4);
        autoRun('m2-scaling');
        // keep the live view on the flight; the scaling table is in this card
        showTab('safety');
      },
      Body: Scaling,
    },
    { title: 'Summary', enter: () => showTab('results'), Body: Summary },
  ],
};
