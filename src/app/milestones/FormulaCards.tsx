/**
 * Formula cards of the guided modes, computed live from the core models (no typed-in results):
 * the thrust feasibility check of Milestone 1 (Section 5.3) and the CBF worked example of
 * Milestone 2 (Section 13).
 */
import { useMemo } from 'react';
import { G } from '../../core/constants';
import { useStore } from '../store';
import { cx, fmt, Slider } from '../ui';
import { BASELINE_W, cbfWorkedExample, feasibilityNumbers } from './summaries';
import { Box, FormulaRow } from './widgets';

/** Figure-8 parameters of the current scene, or the T1 baseline when another scenario is loaded. */
function useFigure8() {
  const cfg = useStore((s) => s.config);
  const isFig8 = cfg.scenario.type === 'figure8';
  return { cfg, isFig8, A: isFig8 ? cfg.scenario.A : 1.5, w: isFig8 ? cfg.scenario.w : BASELINE_W };
}

export function FeasibilityCard() {
  const { cfg, isFig8, A, w } = useFigure8();
  const preset = cfg.drones[0]?.preset ?? 'CF21';
  const n = feasibilityNumbers(preset, cfg.system.eta, A, w);
  const share = n.peakAccel / n.horizontal;
  const setW = (v: number) => {
    const st = useStore.getState();
    // the slider drives the scene: on another scenario it first loads the T1 figure-8
    if (st.config.scenario.type !== 'figure8') st.applyPreset('T1');
    st.setConfig((c) => (c.scenario.w = v));
  };
  return (
    <Box title="Can the motors do it? (feasibility check)" right={<span className="text-[10px] text-slate-500">{n.presetName}</span>}>
      <FormulaRow f="thrust needed = |a + g eᶻ|" note="per planned sample" />
      <FormulaRow f={`usable = η × TWR × g = ${fmt(n.eta, 2)} × ${fmt(n.twr, 1)} × ${fmt(G, 2)}`} v={`${fmt(n.usable, 1)} m/s²`} />
      <FormulaRow f="horizontal limit = √(usable² − g²)" v={`${fmt(n.horizontal, 1)} m/s²`} />
      <FormulaRow f="tilt at the limit = arccos(g / usable)" v={`${fmt(n.tiltDeg, 1)}°`} />
      <div className="my-1.5 border-t border-slate-200 dark:border-slate-700/70" />
      <FormulaRow
        f={
          <>
            figure-8 peak = (17/8) A w²
            <span className="block text-slate-500">
              = 2.125 × {fmt(A, 2)} m × ({fmt(w, 3)} rad/s)²
            </span>
          </>
        }
        v={`${fmt(n.peakAccel, 2)} m/s²`}
      />
      {/* gauge: peak acceleration against the horizontal limit */}
      <div className="mt-1 flex items-center gap-2">
        <div className="relative h-2.5 min-w-0 flex-1 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
          <div className={cx('h-full rounded-full', n.feasible ? 'bg-emerald-500' : 'bg-rose-500')} style={{ width: `${Math.min(100, share * 100).toFixed(1)}%` }} />
        </div>
        <span className={cx('tabular shrink-0 font-mono text-[10px]', n.feasible ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400')}>
          {(share * 100).toFixed(0)}% of the limit
        </span>
      </div>
      <div className="mt-1.5">
        <Slider
          label={isFig8 ? 'w of the figure-8 in the scene' : 'w (moving it loads T1)'}
          tip="Angular rate of the figure-8; the lap takes 2π / w seconds. Peak acceleration grows with w², so doubling w quadruples it."
          value={w}
          min={0.3}
          max={2.1}
          step={0.01}
          format={(v) => `${v.toFixed(2)} rad/s · lap ${((2 * Math.PI) / v).toFixed(1)} s`}
          onChange={setW}
        />
      </div>
      <p className="mt-1 text-[10.5px] leading-snug text-slate-600 dark:text-slate-400">
        {n.feasible ? (
          <>
            Feasible: at this speed the drone needs {(share * 100).toFixed(0)}% of its horizontal budget ({fmt(n.meanSpeed, 2)} m/s mean).
          </>
        ) : (
          <>
            Too fast: the plan needs more than the budget, so the validator marks red segments on the path and blocks the run (the Fly anyway switch in the sandbox overrides it).
          </>
        )}{' '}
        Fastest feasible w = {fmt(n.wMax, 2)} rad/s: {fmt(n.lapAtMax, 2)} s lap, {fmt(n.meanAtMax, 2)} m/s mean, {fmt(n.peakSpeedAtMax, 2)} m/s peak.
      </p>
    </Box>
  );
}

const vec = (v: { x: number; y: number; z: number }, d = 2) => `(${fmt(v.x, d)}, ${fmt(v.y, d)}, ${fmt(v.z, d)})`;
const signed = (x: number, d = 2) => (x > 0 ? `+${x.toFixed(d)}` : x.toFixed(d));

/** Side view (x right, z up) of the pair ellipsoid around drone 1 with drone 2 approaching. */
function CbfPicture({ u1, u2 }: { u1: number; u2: number }) {
  const S = 110; // px per metre
  const cx0 = 62;
  const cz0 = 74;
  const x2 = cx0 + 0.5 * S;
  const rx = 0.24 * S;
  const rz = 0.6 * S;
  const arrow = (x: number, y: number, dx: number, cls: string, dashed = false) => (
    <g className={cls}>
      <line x1={x} y1={y} x2={x + dx} y2={y} stroke="currentColor" strokeWidth={1.8} strokeDasharray={dashed ? '3 2' : undefined} />
      <path d={`M${x + dx},${y} l${dx > 0 ? -5 : 5},-3.5 v7 z`} fill="currentColor" />
    </g>
  );
  return (
    <svg viewBox="0 0 380 150" className="w-full" role="img" aria-label="Two drones closing head-on next to the downwash ellipsoid">
      <rect x={0} y={0} width={190} height={150} rx={6} className="fill-emerald-500/5" />
      <ellipse cx={cx0} cy={cz0} rx={rx} ry={rz} className="fill-rose-500/15 stroke-rose-500" strokeWidth={1.2} />
      <text x={cx0} y={cz0 - rz + 14} textAnchor="middle" fontSize={8.5} className="fill-rose-600 dark:fill-rose-300">
        h &lt; 0
      </text>
      <text x={150} y={16} textAnchor="middle" fontSize={8.5} className="fill-emerald-700 dark:fill-emerald-300">
        h ≥ 0 (safe)
      </text>
      <circle cx={cx0} cy={cz0} r={5} fill="#38bdf8" />
      <circle cx={x2} cy={cz0} r={5} fill="#f472b6" />
      <text x={cx0} y={cz0 + 16} textAnchor="middle" fontSize={8.5} className="fill-slate-600 dark:fill-slate-300">
        1
      </text>
      <text x={x2} y={cz0 + 16} textAnchor="middle" fontSize={8.5} className="fill-slate-600 dark:fill-slate-300">
        2
      </text>
      {arrow(cx0 + 7, cz0 - 12, 30, 'text-sky-500')}
      {arrow(x2 - 7, cz0 - 12, -30, 'text-pink-500')}
      {arrow(cx0 - 7, cz0 + 28, u1 * 10, 'text-amber-500', true)}
      {arrow(x2 + 7, cz0 + 28, u2 * 10, 'text-amber-500', true)}
      <line x1={8} y1={140} x2={8 + 0.5 * S} y2={140} className="stroke-slate-400" strokeWidth={1} />
      <text x={10 + 0.25 * S} y={136} textAnchor="middle" fontSize={8} className="fill-slate-500">
        0.5 m
      </text>
      <g fontSize={9.5} className="fill-slate-700 dark:fill-slate-200">
        <text x={200} y={22}>Side view, z up. The red ellipse</text>
        <text x={200} y={35}>(0.24 × 0.24 × 0.60 m) is where</text>
        <text x={200} y={48}>drone 2 would sit in drone 1’s</text>
        <text x={200} y={61}>downwash: h &lt; 0 inside.</text>
        <text x={200} y={82} className="fill-sky-600 dark:fill-sky-300">→ ← velocities, 1 m/s each</text>
        <text x={200} y={96} className="fill-amber-600 dark:fill-amber-300">⇠ ⇢ filter output u (m/s²):</text>
        <text x={200} y={109} className="fill-amber-600 dark:fill-amber-300">each drone brakes ±{Math.abs(u1).toFixed(2)}</text>
      </g>
    </svg>
  );
}

export function CbfExampleCard() {
  const ex = useMemo(() => cbfWorkedExample(), []);
  return (
    <Box title="Worked example: two drones head-on" right={<span className="text-[10px] text-slate-500">computed live, Section 13</span>}>
      <CbfPicture u1={ex.u1.x} u2={ex.u2.x} />
      <div className="mt-1 text-[10.5px] text-slate-600 dark:text-slate-400">
        p₁ = {vec(ex.p1, 1)}, p₂ = {vec(ex.p2, 1)} m; v₁ = {vec(ex.v1, 0)}, v₂ = {vec(ex.v2, 0)} m/s; no nominal input; λ = {ex.lambda}.
      </div>
      <div className="mt-1">
        <FormulaRow f="D = E⁻²" v={`diag(${fmt(ex.D.x, 2)}, ${fmt(ex.D.y, 2)}, ${fmt(ex.D.z, 2)})`} />
        <FormulaRow f="h = dpᵀ D dp − 1" v={fmt(ex.h, 2)} note={`s = ${fmt(ex.s, 2)}: safe now`} />
        <FormulaRow f="ḣ = 2 dpᵀ D dv" v={fmt(ex.hdot, 1)} note="closing fast" />
        <FormulaRow f="ḧ + 2λḣ + λ²h ≥ 0  ⇔  aᵀ(u₁ − u₂) ≥ b" />
        <FormulaRow f="a = 2 D dp" v={vec(ex.a, 2)} />
        <FormulaRow f="b = −2 dvᵀD dv − 2λḣ − λ²h" v={fmt(ex.b, 2)} />
        <FormulaRow f="smallest change: c = (b − aᵀΔu) / 2|a|²" v={fmt(ex.c, 3)} />
        <FormulaRow f="u₁ = c a,  u₂ = −c a" v={`${signed(ex.u1.x)} / ${signed(ex.u2.x)} m/s²`} />
      </div>
      <p className="mt-1 text-[10.5px] leading-snug text-slate-600 dark:text-slate-400">
        Zero input would break the condition (0 &lt; b), so the filter splits the smallest fix equally: each drone brakes by {Math.abs(ex.u1.x).toFixed(2)} m/s² along the line between them.
      </p>
    </Box>
  );
}
