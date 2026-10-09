/** Milestone 1 narration: nominal trajectory tracking (Section 12). */
import { useMemo, useState } from 'react';
import { useStore, type RecordedTrial } from '../store';
import { Badge, Button, cm, fmt, Stat, Tabs } from '../ui';
import { autoRun, fly, setup, showTab } from './actions';
import { FeasibilityCard } from './FormulaCards';
import { m1Compare, m1Speed, m1Statements } from './summaries';
import type { GuideDef } from './types';
import { Actions, Box, Bullets, ExperimentStatus, NotRun, P, SimNote, useEngineFlying, useFinishedRecords, useLatestTrial } from './widgets';

const isPreset = (id: string) => (t: RecordedTrial) => t.config.scenario.preset === id;

function TrackingNumbers({ trial }: { trial: RecordedTrial }) {
  const tr = trial.evaluation.tracking[0];
  if (!tr) return null;
  return (
    <div className="grid grid-cols-3 gap-1.5">
      <Stat label="RMSE" value={cm(tr.rmse)} tone={tr.rmse <= 0.02 ? 'good' : tr.rmse <= 0.1 ? 'warn' : 'bad'} tip="M1: root-mean-square distance to the reference over the race window." />
      <Stat label="along-track" value={cm(tr.alongRms)} tip="M3: error along the direction of travel (lag; points at latency)." />
      <Stat label="cross-track" value={cm(tr.crossRms)} tip="M4: error sideways to the path (corner cutting; points at thrust limits)." />
    </div>
  );
}

function Feasibility() {
  return (
    <div className="space-y-2">
      <P>
        One Crazyflie flies a figure-8 at 1 m height. Before every flight a validator checks each planned sample: the motors must be able to produce the push the path asks for, with a reserve (η) left for
        corrections.
      </P>
      <FeasibilityCard />
      <P muted>Top view: the dashed line is the commanded path. Move the slider to see when the check fails.</P>
    </div>
  );
}

function FlyT1() {
  const trial = useLatestTrial(isPreset('T1'));
  const flying = useEngineFlying();
  return (
    <div className="space-y-2">
      <P>
        T1 is the lab’s baseline: a 12 s lap at 0.76 m/s mean. The ground computer streams a setpoint to the drone 100 times a second; the onboard controller turns errors into thrust. Crazyswarm’s published
        baseline was under 2 cm of error.
      </P>
      <Bullets
        items={[
          'Dashed line: where the drone should be. Trail: where it was, coloured by speed.',
          'The Tracking tab plots the error over time, split into along-track (lag) and cross-track (corner cutting).',
          'The run is recorded when it ends (about 30 s at 1×); the numbers appear below.',
        ]}
      />
      <Box title="Last T1 run" right={trial ? <Badge tone="emerald">recorded</Badge> : flying ? <Badge tone="sky">flying…</Badge> : undefined}>
        {trial ? <TrackingNumbers trial={trial} /> : <P muted>No T1 run recorded yet in this session. It appears here when the flight ends.</P>}
        <SimNote />
      </Box>
      <Actions>
        <Button small kind="primary" onClick={() => fly({ preset: 'T1', tab: 'tracking' })}>
          ▶ Fly T1 again
        </Button>
        <Button small onClick={() => fly({ preset: 'T2', tab: 'tracking' })} title="w = 1.54 rad/s, at the thrust limit of the CF2.1 with η = 0.7">
          Fly T2 (at the limit)
        </Button>
        <Button small kind="ghost" onClick={() => showTab('tracking')}>
          Tracking tab
        </Button>
      </Actions>
    </div>
  );
}

function SpeedSweep() {
  const { run, recs } = useFinishedRecords('m1-speed');
  const s = useMemo(() => m1Speed(recs), [recs]);
  return (
    <div className="space-y-2">
      <P>
        Now the same figure-8 at five speeds, from w = 0.52 to 1.54 rad/s (0.76 to 2.3 m/s mean), several noise seeds each. The trials fly headlessly on background workers, so the 3D view stays smooth. The
        Results tab charts the error with 95% intervals against speed, with a 10 cm line where we call tracking broken.
      </P>
      <ExperimentStatus kind="m1-speed" />
      {s && (
        <Box title="RMSE per speed level">
          <table className="w-full text-[10.5px]">
            <thead className="text-slate-500">
              <tr>
                <th className="text-left font-medium">w (rad/s)</th>
                <th className="text-right font-medium">mean speed</th>
                <th className="text-right font-medium">RMSE (95% CI)</th>
                <th className="text-right font-medium">plan fails</th>
              </tr>
            </thead>
            <tbody className="tabular font-mono">
              {s.rows.map((r) => (
                <tr key={r.w} className={s.breakdown?.w === r.w ? 'text-rose-600 dark:text-rose-400' : ''}>
                  <td>{fmt(r.w, 2)}</td>
                  <td className="text-right">{fmt(r.meanSpeed, 2)} m/s</td>
                  <td className="text-right">
                    {cm(r.rmse.mean)} <span className="text-slate-500">({fmt(r.rmse.lo * 100, 1)}–{fmt(r.rmse.hi * 100, 1)})</span>
                  </td>
                  <td className="text-right">{(r.feasibilityFail * 100).toFixed(0)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
          <SimNote run={run} />
        </Box>
      )}
      <P muted>“Plan fails” is the share of planned samples beyond the thrust budget (M9): the fastest level sits right at the limit.</P>
    </div>
  );
}

type Variant = { label: string; mode: 'streamed' | 'uploaded'; controller: 'mellinger' | 'pid'; title: string };
const VARIANTS: Variant[] = [
  { label: 'Streamed, Mellinger-like', mode: 'streamed', controller: 'mellinger', title: 'Setpoints sent over the radio every tick; controller with acceleration feed-forward (the default).' },
  { label: 'Uploaded', mode: 'uploaded', controller: 'mellinger', title: 'The whole trajectory is stored on the drone: no radio latency on the setpoints.' },
  { label: 'PID-like', mode: 'streamed', controller: 'pid', title: 'Reacts to errors only: same P and D gains, small integral, no acceleration feed-forward.' },
];

function Comparisons() {
  const { run, recs } = useFinishedRecords('m1-compare');
  const levels = useMemo(() => m1Compare(recs), [recs]);
  const config = useStore((s) => s.config);
  const [w, setW] = useState(0.522);
  const current = (v: Variant) => config.scenario.preset === 'T1' && config.system.mode === v.mode && config.system.controller === v.controller && Math.abs(config.scenario.w - w) < 1e-6;
  return (
    <div className="space-y-2">
      <P>
        Two design choices, each tested at the baseline and at twice the speed: <b>streamed vs uploaded</b> (does the radio delay cost accuracy?) and <b>Mellinger-like vs PID-like</b> (how much does
        knowing the planned acceleration in advance help?).
      </P>
      <ExperimentStatus kind="m1-compare" />
      {levels && (
        <Box title="RMSE by condition">
          <table className="w-full text-[10.5px]">
            <thead className="text-slate-500">
              <tr>
                <th className="text-left font-medium">condition</th>
                {levels.map((l) => (
                  <th key={l.level} className="text-right font-medium">
                    {l.level}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="tabular font-mono">
              {VARIANTS.map((v) => (
                <tr key={v.label}>
                  <td className="font-sans">{v.label}</td>
                  {levels.map((l) => {
                    const r = l.rows.find((x) => x.condition.startsWith(v.mode === 'uploaded' ? 'Uploaded' : 'Streamed') && x.condition.endsWith(v.controller === 'pid' ? 'PID-like' : 'Mellinger-like'));
                    return (
                      <td key={l.level} className="text-right">
                        {cm(r?.rmse.mean)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          <SimNote run={run} />
        </Box>
      )}
      <Box title="Fly a variant live">
        <div className="mb-1.5 flex items-center gap-2 text-[10.5px] text-slate-500">
          <span>speed</span>
          <Tabs
            small
            value={String(w)}
            options={[
              { value: '0.522', label: 'baseline w = 0.52' },
              { value: '1.04', label: '2× w = 1.04' },
            ]}
            onChange={(v) => setW(Number(v))}
          />
        </div>
        <Actions>
          {VARIANTS.map((v) => (
            <Button
              key={v.label}
              small
              kind={current(v) ? 'primary' : 'default'}
              title={v.title}
              onClick={() =>
                fly({
                  preset: 'T1',
                  tab: 'tracking',
                  set: (c) => {
                    c.scenario.w = w;
                    c.system.mode = v.mode;
                    c.system.controller = v.controller;
                  },
                })
              }
            >
              ▶ {v.label}
            </Button>
          ))}
        </Actions>
      </Box>
    </div>
  );
}

function Summary() {
  const speed = useFinishedRecords('m1-speed');
  const cmp = useFinishedRecords('m1-compare');
  const s = useMemo(() => m1Speed(speed.recs), [speed.recs]);
  const c = useMemo(() => m1Compare(cmp.recs), [cmp.recs]);
  const statements = useMemo(() => m1Statements(s, c), [s, c]);
  const base = c?.find((l) => l.level.startsWith('baseline'));
  const twice = c?.find((l) => !l.level.startsWith('baseline'));
  return (
    <div className="space-y-2">
      <P>What Milestone 1 shows, in numbers from the runs above:</P>
      {s ? (
        <div className="grid grid-cols-2 gap-1.5">
          <Stat label="RMSE at w = 0.522" value={cm(s.baseline?.rmse.mean)} tone={(s.baseline?.rmse.mean ?? 1) <= 0.02 ? 'good' : 'warn'} tip="Baseline T1 speed, mean over the noise seeds." />
          <Stat
            label="breakdown (> 10 cm)"
            value={s.breakdown ? `w = ${fmt(s.breakdown.w, 2)}` : `none ≤ w ${fmt(s.fastest.w, 2)}`}
            tone={s.breakdown ? 'warn' : 'good'}
            tip="First speed level whose mean RMSE exceeds 10 cm."
          />
        </div>
      ) : (
        <NotRun kind="m1-speed">Speed sweep: not run yet.</NotRun>
      )}
      {c ? (
        <div className="grid grid-cols-2 gap-1.5">
          <Stat label="uploaded vs streamed (2×)" value={`${cm(twice?.uploaded?.rmse.mean)} / ${cm(twice?.streamed?.rmse.mean)}`} tip="RMSE at w = 1.04 rad/s." />
          <Stat label="PID vs Mellinger (2×)" value={`${cm(twice?.pid?.rmse.mean)} / ${cm(twice?.streamed?.rmse.mean)}`} tip="RMSE at w = 1.04 rad/s, both streamed." />
          {base && <Stat label="uploaded vs streamed (base)" value={`${cm(base.uploaded?.rmse.mean)} / ${cm(base.streamed?.rmse.mean)}`} />}
          {base && <Stat label="PID vs Mellinger (base)" value={`${cm(base.pid?.rmse.mean)} / ${cm(base.streamed?.rmse.mean)}`} />}
        </div>
      ) : (
        <NotRun kind="m1-compare">Streamed / uploaded / PID-like comparison: not run yet.</NotRun>
      )}
      {statements.length > 0 && (
        <Box title="In plain words">
          <Bullets items={statements} />
          <SimNote />
        </Box>
      )}
    </div>
  );
}

export const M1_GUIDE: GuideDef = {
  mode: 'm1',
  label: 'Milestone 1',
  title: 'Nominal trajectory tracking',
  steps: [
    {
      title: 'The figure-8 and the thrust check',
      enter: () => setup({ preset: 'T1', tab: 'live', camera: 'top', visuals: { commandedPath: true, trails: true } }),
      Body: Feasibility,
    },
    { title: 'Fly T1 live', enter: () => fly({ preset: 'T1', tab: 'tracking', camera: 'orbit' }), Body: FlyT1 },
    { title: 'Speed sweep', enter: () => autoRun('m1-speed'), Body: SpeedSweep },
    { title: 'Uploaded vs streamed, PID vs Mellinger', enter: () => autoRun('m1-compare'), Body: Comparisons },
    { title: 'Summary', enter: () => showTab('results'), Body: Summary },
  ],
};
