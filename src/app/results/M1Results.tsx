/**
 * M1 results (Section 12, Milestone 1): RMSE vs mean speed with bootstrap CIs and the 10 cm
 * breakdown threshold, the along / cross-track split per level, the sweep table, and the
 * streamed vs uploaded vs PID-like comparison with sentences computed from the records.
 */
import { useMemo } from 'react';
import { summariseCompare, summariseSpeedSweep, type CompareRow, type Stat } from '../../core/experiments';
import { Card, cx, fmt, pct } from '../ui';
import { CIBarChart, ciFields, CILineChart, condColor, finite } from './charts';
import { EmptyState, ExportButtons, Finding, Footer, Note, nRange, okRecords, PartialNote, TD, TH, useRunRecords } from './common';

const BREAKDOWN_RED = '#ef4444';
const THRESHOLD = '#f59e0b';

/** "4.2 (3.9–4.6)" in cm. */
const ciCm = (s: Stat) => (finite(s.mean) ? `${(s.mean * 100).toFixed(1)} (${(s.lo * 100).toFixed(1)}–${(s.hi * 100).toFixed(1)})` : '–');
const overlap = (a: Stat, b: Stat) => !(a.hi < b.lo || b.hi < a.lo);

function SpeedSweep() {
  const { run, recs } = useRunRecords('m1-speed');
  const ok = useMemo(() => okRecords(recs), [recs]);
  const sum = useMemo(() => summariseSpeedSweep(ok), [ok]);
  const rows = useMemo(
    () => sum.rows.map((r) => ({ v: r.meanSpeed, w: r.w, wl: r.w.toFixed(2), ...ciFields('rmse', r.rmse, 100), ...ciFields('along', r.along, 100), ...ciFields('cross', r.cross, 100) })),
    [sum],
  );
  if (!ok.length)
    return (
      <Card title="Speed sweep (T1 figure-8)">
        <EmptyState kinds={['m1-speed']}>Flies the T1 figure-8 at five speed levels (w = 0.52 to 1.54 rad/s, several noise seeds each) and finds the speed at which the tracking RMSE first exceeds 10 cm.</EmptyState>
      </Card>
    );
  const br = sum.rows.find((r) => r.w === sum.breakdownW);
  const vMid = rows.length ? (rows[0].v + rows[rows.length - 1].v) / 2 : 0;
  const top = sum.rows[sum.rows.length - 1];
  return (
    <Card title="Speed sweep (T1 figure-8)">
      <div className="space-y-2">
        <PartialNote run={run} />
        <Finding tone={br ? 'amber' : 'sky'}>
          {br ? (
            <>
              Tracking breaks down at <b>w = {br.w.toFixed(2)} rad/s</b> (mean speed {fmt(br.meanSpeed, 2)} m/s): RMSE {fmt(br.rmse.mean * 100, 1)} cm, above the 10 cm threshold
              {br.rmse.lo > 0.1 ? ' with the whole 95% CI above it.' : ' (the 95% CI reaches below 10 cm).'}
            </>
          ) : (
            <>
              RMSE stays below the 10 cm threshold at every tested level (up to w = {fmt(top?.w, 2)} rad/s, {fmt(top?.meanSpeed, 2)} m/s; worst {fmt((top?.rmse.mean ?? NaN) * 100, 1)} cm).
            </>
          )}
        </Finding>
        <div>
          <div className="text-[11px] font-medium text-slate-600 dark:text-slate-400">M1 tracking RMSE vs mean speed (mean, 95% bootstrap CI)</div>
          <CILineChart
            data={rows}
            xKey="v"
            xLabel="mean speed (m/s)"
            xTicks={rows.map((r) => r.v)}
            series={[{ key: 'rmse', name: 'RMSE', color: '#38bdf8' }]}
            yLabel="RMSE (cm)"
            unit=" cm"
            dotColor={(r) => (r.w === sum.breakdownW ? BREAKDOWN_RED : undefined)}
            refLines={[
              { y: 10, label: '10 cm threshold', color: THRESHOLD, labelPos: 'insideTopLeft' },
              ...(br ? [{ x: br.meanSpeed, label: `breakdown w = ${br.w.toFixed(2)}`, color: BREAKDOWN_RED, labelPos: br.meanSpeed > vMid ? ('insideTopRight' as const) : ('insideTopLeft' as const) }] : []),
            ]}
            height={190}
          />
        </div>
        <div>
          <div className="text-[11px] font-medium text-slate-600 dark:text-slate-400">Along-track (M3) vs cross-track (M4) RMS per level</div>
          <CIBarChart
            data={rows}
            xKey="wl"
            xLabel="w (rad/s)"
            series={[
              { key: 'along', name: 'along-track (lag)', color: '#f59e0b' },
              { key: 'cross', name: 'cross-track (corner cutting)', color: '#a78bfa' },
            ]}
            yLabel="RMS (cm)"
            unit=" cm"
            height={170}
          />
          <Note>
            Along-track error is lag behind the reference, which grows with latency × speed; cross-track error is corner cutting where the thrust limit caps the turning acceleration.
            {top && finite(top.along.mean) && finite(top.cross.mean) && (
              <>
                {' '}
                At w = {top.w.toFixed(2)}: along {fmt(top.along.mean * 100, 1)} cm, cross {fmt(top.cross.mean * 100, 1)} cm, so {top.along.mean >= top.cross.mean ? 'lag' : 'corner cutting'} dominates.
              </>
            )}
          </Note>
        </div>
        <table className="w-full text-[10px]">
          <thead>
            <tr className="border-b border-slate-200 dark:border-slate-800">
              <th className={TH} title="Figure-8 angular rate">w</th>
              <th className={TH} title="Measured mean speed (M6)">v̄ m/s</th>
              <th className={TH} title="M1, mean and 95% bootstrap CI">RMSE cm (95% CI)</th>
              <th className={TH} title="M3 along-track RMS">along</th>
              <th className={TH} title="M4 cross-track RMS">cross</th>
              <th className={TH} title="M9: share of planned samples failing the thrust / tilt check">M9 fail</th>
            </tr>
          </thead>
          <tbody>
            {sum.rows.map((r) => (
              <tr key={r.w} className={cx('border-b border-slate-100 dark:border-slate-800/60', r.w === sum.breakdownW && 'bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-300')}>
                <td className={TD}>{r.w.toFixed(2)}</td>
                <td className={TD}>{fmt(r.meanSpeed, 2)}</td>
                <td className={TD}>{ciCm(r.rmse)}</td>
                <td className={TD}>{fmt(r.along.mean * 100, 1)}</td>
                <td className={TD}>{fmt(r.cross.mean * 100, 1)}</td>
                <td className={cx(TD, r.feasibilityFail > 0 && 'text-amber-600 dark:text-amber-400')}>{pct(r.feasibilityFail, 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <Note>n = {nRange(sum.rows.map((r) => r.rmse.n))} trials per level (different noise seeds). Highlighted: first level whose mean RMSE exceeds 10 cm.</Note>
        <ExportButtons kind="m1-speed" run={run} recs={recs} summary={() => sum} />
      </div>
    </Card>
  );
}

const SM = 'Streamed, Mellinger-like';
const UP = 'Uploaded, Mellinger-like';
const PID = 'Streamed, PID-like';
const CONDS = [SM, UP, PID];

/** "a → b cm at <level>" plus whether the CIs separate. */
function delta(rows: CompareRow[], a: string, b: string): { text: string; separate: number; levels: number; lower: number } | null {
  const parts: string[] = [];
  let separate = 0;
  let levels = 0;
  let lower = 0;
  for (const lvl of ['baseline', '2x']) {
    const ra = rows.find((r) => r.condition === a && r.level.startsWith(lvl))?.rmse;
    const rb = rows.find((r) => r.condition === b && r.level.startsWith(lvl))?.rmse;
    if (!ra || !rb || !finite(ra.mean) || !finite(rb.mean)) continue;
    levels++;
    if (!overlap(ra, rb)) separate++;
    if (rb.mean < ra.mean) lower++;
    parts.push(`${(ra.mean * 100).toFixed(1)} → ${(rb.mean * 100).toFixed(1)} cm at ${lvl === '2x' ? '2× speed' : 'baseline'}`);
  }
  return levels ? { text: parts.join(' and '), separate, levels, lower } : null;
}

const ciNote = (d: { separate: number; levels: number }) =>
  d.separate === d.levels ? ' (95% CIs do not overlap).' : d.separate === 0 ? ' (95% CIs overlap, so not conclusive at this n).' : ` (95% CIs separate at ${d.separate} of ${d.levels} levels).`;

function Compare() {
  const { run, recs } = useRunRecords('m1-compare');
  const ok = useMemo(() => okRecords(recs), [recs]);
  const rows = useMemo(() => summariseCompare(ok), [ok]);
  const data = useMemo(
    () =>
      ['baseline', '2x'].flatMap((lvl) => {
        const rs = rows.filter((r) => r.level.startsWith(lvl));
        if (!rs.length) return [];
        const row: Record<string, unknown> = { level: lvl === 'baseline' ? 'baseline (w 0.52)' : '2× (w 1.04)' };
        CONDS.forEach((c, i) => Object.assign(row, ciFields(`c${i}`, rs.find((r) => r.condition === c)?.rmse, 100)));
        return [row];
      }),
    [rows],
  );
  if (!ok.length)
    return (
      <Card title="Streamed vs uploaded vs PID-like">
        <EmptyState kinds={['m1-compare']}>Compares streamed and uploaded trajectories (latency cost) and the Mellinger-like vs PID-like controller (value of feed-forward) at the baseline and 2× speed levels.</EmptyState>
      </Card>
    );
  const lat = delta(rows, SM, UP);
  const ff = delta(rows, SM, PID);
  return (
    <Card title="Streamed vs uploaded vs PID-like">
      <div className="space-y-2">
        <PartialNote run={run} />
        <CIBarChart
          data={data}
          xKey="level"
          series={CONDS.map((c, i) => ({ key: `c${i}`, name: c, color: condColor(c, i) }))}
          yLabel="RMSE (cm)"
          unit=" cm"
          refLines={[{ y: 10, label: '10 cm', color: THRESHOLD }]}
          height={190}
        />
        {lat && (
          <Finding>
            {lat.lower === lat.levels ? 'Uploading removes the latency cost' : lat.lower === 0 ? 'Uploading does not lower the error here' : 'Uploading has a mixed effect'}: RMSE {lat.text}
            {ciNote(lat)}
          </Finding>
        )}
        {ff && (
          <Finding>
            {ff.lower === 0
              ? 'Dropping acceleration feed-forward (PID-like) costs accuracy'
              : ff.lower === ff.levels
                ? 'The PID-like controller (no acceleration feed-forward) is more accurate here'
                : 'Mellinger-like vs PID-like is mixed'}
            : RMSE {ff.text}
            {ciNote(ff)}
          </Finding>
        )}
        <Note>Mean and 95% bootstrap CI over {nRange(rows.map((r) => r.rmse.n))} trials per bar; same seeds across conditions.</Note>
        <ExportButtons kind="m1-compare" run={run} recs={recs} summary={() => rows} />
      </div>
    </Card>
  );
}

export function M1Results() {
  return (
    <div className="space-y-2.5">
      <SpeedSweep />
      <Compare />
      <Footer />
    </div>
  );
}
