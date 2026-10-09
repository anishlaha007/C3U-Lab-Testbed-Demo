/**
 * Trials section: the live trials recorded from the 3D view, ranked by composite score under the
 * current weights (Section 9), with a radar overlay of up to four trials, the ranking stability
 * check over the recorded set and the weight sliders.
 */
import { useMemo, useState } from 'react';
import { compositeScore, rankingStability } from '../../core/metrics/scorecard';
import { useStore, type RecordedTrial } from '../store';
import { Badge, Button, Card, cx, fmt } from '../ui';
import { finite, LEVEL_COLORS, RadarOverlay } from './charts';
import { Footer, Note, TD, TH, TH_LEFT, WeightSliders } from './common';

const MAX_OVERLAY = 4;
const avg = (xs: number[] | undefined) => {
  const v = (xs ?? []).filter(finite);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN;
};

function gTone(G: number) {
  return G >= 1 ? 'text-emerald-600 dark:text-emerald-400' : G > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-rose-600 dark:text-rose-400';
}

/** Secondary metrics line under the trial name: RMSE, closest approach, cost of safety. */
function metricsLine(t: RecordedTrial): string {
  const parts = [`RMSE ${fmt(avg(t.evaluation.tracking.map((x) => x.rmse)) * 100, 1)} cm`];
  const s = t.evaluation.safety.closestApproach;
  if (finite(s)) parts.push(`s_min ${s.toFixed(2)}`);
  const m15 = avg(t.costOfSafety);
  if (finite(m15)) parts.push(`M15 ${(m15 * 100).toFixed(1)} cm`);
  else if (t.log.drones.length > 1) parts.push('M15 …');
  return parts.join(' · ');
}

export function TrialsResults() {
  const trials = useStore((s) => s.trials);
  const weights = useStore((s) => s.weights);
  const removeTrial = useStore((s) => s.removeTrial);
  const clearTrials = useStore((s) => s.clearTrials);
  const recording = useStore((s) => s.recording);
  const toggleRecording = useStore((s) => s.toggleRecording);
  const ranked = useMemo(
    () => trials.map((t) => ({ t, score: compositeScore(t.evaluation.scorecard.G, t.evaluation.scorecard.sub, weights) })).sort((a, b) => b.score - a.score || a.t.id - b.t.id),
    [trials, weights],
  );
  // overlay selection: user picks, or the two best trials until the user picks something
  const [picked, setPicked] = useState<number[] | null>(null);
  const live = new Set(trials.map((t) => t.id));
  const sel = (picked ?? ranked.slice(0, 2).map((x) => x.t.id)).filter((id) => live.has(id));
  const toggle = (id: number) => setPicked(sel.includes(id) ? sel.filter((x) => x !== id) : sel.length < MAX_OVERLAY ? [...sel, id] : sel);
  const colorOf = (id: number) => LEVEL_COLORS[sel.indexOf(id) % LEVEL_COLORS.length];
  const stability = useMemo(
    () => (trials.length > 1 ? rankingStability(trials.map((t) => ({ name: t.name, G: t.evaluation.scorecard.G, sub: t.evaluation.scorecard.sub })), weights, 200, 99) : null),
    [trials, weights],
  );
  const weightsCard = (
    <Card title="Scorecard weights">
      <WeightSliders />
    </Card>
  );
  if (!trials.length)
    return (
      <div className="space-y-2.5">
        <div className="rounded-md border border-dashed border-slate-300 p-3 text-[11px] leading-snug text-slate-600 dark:border-slate-700 dark:text-slate-400">
          <p>
            No recorded trials yet. Every live trial that finishes in the 3D view is recorded here automatically while <b>Record</b> is on (top bar), with its scorecard, tracking and safety metrics; multi-drone trials also get the cost of safety (M15) from an automatic solo run.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <Badge tone={recording ? 'emerald' : 'amber'}>Record is {recording ? 'on' : 'off'}</Badge>
            {!recording && (
              <Button small kind="primary" onClick={toggleRecording}>
                Turn Record on
              </Button>
            )}
          </div>
        </div>
        {weightsCard}
        <Footer />
      </div>
    );
  const trialById = new Map(trials.map((t) => [t.id, t]));
  return (
    <div className="space-y-2.5">
      <Card
        title={`Recorded trials (${trials.length})`}
        right={
          <Button small kind="ghost" onClick={clearTrials} title="Remove every recorded trial.">
            Clear all
          </Button>
        }
      >
        <table className="w-full table-fixed text-[10px]">
          <colgroup>
            <col className="w-5" />
            <col />
            <col className="w-8" />
            <col className="w-8" />
            <col className="w-8" />
            <col className="w-8" />
            <col className="w-8" />
            <col className="w-10" />
            <col className="w-5" />
          </colgroup>
          <thead>
            <tr className="border-b border-slate-200 dark:border-slate-800">
              <th className={TH} title={`Overlay in the radar (up to ${MAX_OVERLAY})`}>◩</th>
              <th className={TH_LEFT}>trial</th>
              <th className={TH} title="Gate factor: 0 crash / kill / missed gate, 0.5 emergency brake, 0.75 separation violation, 1 clean. Hover a value for the reason.">G</th>
              <th className={TH} title="Safety: 0.5 [(1 − M13) + min(1, M11)]">S</th>
              <th className={TH} title="Speed: planned / actual lap time">V</th>
              <th className={TH} title="Accuracy: 1 − M1 / 0.30 m">A</th>
              <th className={TH} title="Effort: planned / actual effort">E</th>
              <th className={TH} title="Composite with the current weights">score</th>
              <th className={TH} />
            </tr>
          </thead>
          <tbody>
            {ranked.map(({ t, score }, i) => {
              const sc = t.evaluation.scorecard;
              const on = sel.includes(t.id);
              return (
                <tr key={t.id} className={cx('border-b border-slate-100 align-top dark:border-slate-800/60', on && 'bg-sky-50/70 dark:bg-sky-500/5')}>
                  <td className={cx(TD, 'pt-1')}>
                    <input
                      type="checkbox"
                      checked={on}
                      disabled={!on && sel.length >= MAX_OVERLAY}
                      onChange={() => toggle(t.id)}
                      style={{ accentColor: on ? colorOf(t.id) : undefined }}
                      title={on ? 'Remove from the radar' : sel.length >= MAX_OVERLAY ? `At most ${MAX_OVERLAY} trials in the radar` : 'Overlay in the radar'}
                    />
                  </td>
                  <td className="min-w-0 px-1 py-0.5">
                    <div className="truncate font-medium text-slate-800 dark:text-slate-200" title={t.name}>
                      {i + 1}. {t.name}
                    </div>
                    <div className="truncate text-slate-500" title={t.condition}>
                      {t.condition}
                    </div>
                    <div className="tabular font-mono text-[9px] leading-tight text-slate-500">{metricsLine(t)}</div>
                  </td>
                  <td className={cx(TD, gTone(sc.G), 'cursor-help underline decoration-dotted underline-offset-2')} title={`G = ${sc.G}: ${sc.gateReason}`}>
                    {fmt(sc.G, 2)}
                  </td>
                  <td className={TD}>{fmt(sc.sub.S, 2)}</td>
                  <td className={TD}>{fmt(sc.sub.V, 2)}</td>
                  <td className={TD}>{fmt(sc.sub.A, 2)}</td>
                  <td className={TD}>{fmt(sc.sub.E, 2)}</td>
                  <td className={cx(TD, 'font-semibold')}>{fmt(score, 3)}</td>
                  <td className={TD}>
                    <button className="text-slate-400 hover:text-rose-500" title="Remove this trial" onClick={() => removeTrial(t.id)}>
                      ✕
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <Note>RMSE is M1 averaged over drones; s_min is the closest approach M11; M15 (cost of safety) appears once the automatic solo runs finish.</Note>
      </Card>
      <Card title="Sub-scores" right={<span className="text-[10px] font-normal text-slate-500">tick up to {MAX_OVERLAY} trials</span>}>
        {sel.length ? (
          <RadarOverlay series={sel.map((id) => ({ name: trialById.get(id)!.name, color: colorOf(id), sub: trialById.get(id)!.evaluation.scorecard.sub }))} height={220} />
        ) : (
          <p className="text-[11px] text-slate-500">Tick trials in the table to overlay their S, V, A, E sub-scores.</p>
        )}
        {stability ? (
          <div className="mt-1 flex flex-wrap items-center gap-1 text-[11px] text-slate-700 dark:text-slate-300">
            <span>Ranking stability:</span>
            <Badge tone={stability.share >= 0.8 ? 'emerald' : stability.share >= 0.5 ? 'amber' : 'rose'}>{(stability.share * 100).toFixed(0)}%</Badge>
            <span className="text-[10px] text-slate-500">
              of 200 random weight vectors keep the full ranking of these {trials.length} trials{trials.length > 4 ? ' (a strict test: any swap counts as a change)' : ''}.
            </span>
          </div>
        ) : (
          <Note>Record a second trial to check how stable the ranking is under other weights.</Note>
        )}
      </Card>
      {weightsCard}
      <Footer />
    </div>
  );
}
