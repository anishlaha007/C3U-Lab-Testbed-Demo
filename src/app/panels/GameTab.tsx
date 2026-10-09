/**
 * Game tab: the M x M payoff matrix of drone A (diverging colour), best responses (row / column
 * markers), pure Nash cells outlined, Stackelberg picks starred, the flown cell ringed. Hovering a
 * cell previews both candidate paths in 3D. Key teaching visual of Section 7.3.
 */
import { useMemo, useState } from 'react';
import { DRONE_NAMES, PLANNER_LABEL } from '../../core/constants';
import type { GameMatrix, PlanResult } from '../../core/planners/types';
import { requestSolve } from '../planner';
import { useStore } from '../store';
import { Badge, Button, Card, fmt, Tabs } from '../ui';

function divergingColor(v: number, max: number, dark: boolean): string {
  const t = Math.max(-1, Math.min(1, v / (max || 1)));
  // blue (negative) - neutral - orange (positive)
  const neutral = dark ? [30, 41, 59] : [241, 245, 249];
  const pos = [234, 88, 12];
  const neg = [37, 99, 235];
  const c = t >= 0 ? pos : neg;
  const a = Math.abs(t);
  return `rgb(${Math.round(neutral[0] + (c[0] - neutral[0]) * a)},${Math.round(neutral[1] + (c[1] - neutral[1]) * a)},${Math.round(neutral[2] + (c[2] - neutral[2]) * a)})`;
}

type ColourBy = 'payoff' | 'gap';

function PayoffMatrix({ plan, game }: { plan: PlanResult; game: GameMatrix }) {
  const dark = useStore((s) => s.dark);
  const setHover = useStore((s) => s.setHoverCell);
  const [hover, setLocal] = useState<[number, number] | null>(null);
  // Section 7.3 asks for a heatmap of payoff_1; the gap view separates progress from risk
  const [colourBy, setColourBy] = useState<ColourBy>('payoff');
  const [hideInvalid, setHideInvalid] = useState(true);
  const v1 = plan.candidates[0].map((c) => c.valid);
  const v2 = plan.candidates[1].map((c) => c.valid);
  // displayed rows / columns -> candidate indices
  const rows = useMemo(() => v1.map((v, i) => (v || !hideInvalid ? i : -1)).filter((i) => i >= 0), [v1, hideInvalid]);
  const cols = useMemo(() => v2.map((v, j) => (v || !hideInvalid ? j : -1)).filter((j) => j >= 0), [v2, hideInvalid]);
  const rowPos = useMemo(() => new Map(rows.map((i, r) => [i, r])), [rows]);
  const colPos = useMemo(() => new Map(cols.map((j, c) => [j, c])), [cols]);
  const value = (i: number, j: number) => (colourBy === 'payoff' ? game.payoff1[i][j] : game.gap[i][j]);
  const { maxAbs, maxRisk } = useMemo(() => {
    let m = 0;
    let r = 0;
    for (const i of rows) for (const j of cols) if (v1[i] && v2[j]) {
      m = Math.max(m, Math.abs(colourBy === 'payoff' ? game.payoff1[i][j] : game.gap[i][j]));
      r = Math.max(r, game.risk[i][j]);
    }
    return { maxAbs: m || 1, maxRisk: r || 1 };
  }, [game, rows, cols, v1, v2, colourBy]);
  // the payoff spans the progress gap (metres) and P x risk (tens to hundreds): a signed log scale
  // keeps both visible; the gap alone is shown linearly
  const scaled = (v: number) => (colourBy === 'payoff' ? (Math.sign(v) * Math.log1p(Math.abs(v))) / Math.log1p(maxAbs) : v / maxAbs);
  const W = 360;
  const n = Math.max(rows.length, cols.length, 1);
  const cell = Math.max(4, Math.floor((W - 24) / n));
  const nashSet = new Set(game.nash.map(([i, j]) => `${i},${j}`));
  const [ci, cj] = plan.choice;
  const h = hover;
  const at = (i: number, j: number) => ({ x: (colPos.get(j) ?? -1) * cell, y: (rowPos.get(i) ?? -1) * cell, shown: rowPos.has(i) && colPos.has(j) });
  return (
    <div>
      <div className="mb-1 flex flex-wrap items-center gap-2 text-[10px] text-slate-500">
        <span>Colour</span>
        <Tabs
          small
          value={colourBy}
          options={[
            { value: 'payoff', label: 'payoff of A', title: 'payoff_1 = s_A − s_B − P × risk (Section 7.2), signed log scale' },
            { value: 'gap', label: 'progress gap', title: 's_A − s_B at the horizon, without the risk term' },
          ]}
          onChange={setColourBy}
        />
        <label className="ml-auto flex items-center gap-1">
          <input type="checkbox" checked={hideInvalid} onChange={(e) => setHideInvalid(e.target.checked)} />
          hide invalid candidates
        </label>
      </div>
      <svg width={cols.length * cell + 24} height={rows.length * cell + 24} className="select-none" onMouseLeave={() => (setLocal(null), setHover(null))}>
        <text x={24 + (cols.length * cell) / 2} y={9} fontSize={9} textAnchor="middle" fill="#94a3b8">
          drone B candidate j →
        </text>
        <text x={8} y={24 + (rows.length * cell) / 2} fontSize={9} textAnchor="middle" fill="#94a3b8" transform={`rotate(-90 8 ${24 + (rows.length * cell) / 2})`}>
          drone A candidate i →
        </text>
        <g transform="translate(20,14)">
          {rows.map((i, r) =>
            cols.map((j, c) => {
              const valid = v1[i] && v2[j];
              return (
                <rect
                  key={`${i}-${j}`}
                  x={c * cell}
                  y={r * cell}
                  width={cell}
                  height={cell}
                  fill={valid ? divergingColor(scaled(value(i, j)), 1, dark) : dark ? '#0f172a' : '#e2e8f0'}
                  stroke={dark ? '#0b1220' : '#ffffff'}
                  strokeWidth={0.4}
                  onMouseEnter={() => {
                    setLocal([i, j]);
                    setHover([i, j]);
                  }}
                />
              );
            }),
          )}
          {/* collision risk: hatching whose strength grows with the time inside the risk margin */}
          {rows.map((i, r) =>
            cols.map((j, c) =>
              v1[i] && v2[j] && game.risk[i][j] > 0 ? (
                <path
                  key={`r${i}-${j}`}
                  d={`M${c * cell},${(r + 1) * cell} L${(c + 1) * cell},${r * cell}`}
                  stroke="#ef4444"
                  strokeWidth={Math.max(0.6, cell * 0.12)}
                  opacity={0.12 + 0.88 * Math.min(1, game.risk[i][j] / maxRisk)}
                  pointerEvents="none"
                />
              ) : null,
            ),
          )}
          {/* best-response markers: drone A's reply to each column (dot), drone B's reply to each row (ring) */}
          {game.br1.map((i, j) => {
            const p = at(i, j);
            return i >= 0 && v2[j] && p.shown ? <circle key={`b1${j}`} cx={p.x + cell / 2} cy={p.y + cell / 2} r={Math.max(1, cell * 0.16)} fill="#0f172a" opacity={0.75} /> : null;
          })}
          {game.br2.map((j, i) => {
            const p = at(i, j);
            return j >= 0 && v1[i] && p.shown ? <circle key={`b2${i}`} cx={p.x + cell / 2} cy={p.y + cell / 2} r={Math.max(1.5, cell * 0.3)} fill="none" stroke="#f8fafc" strokeWidth={1} opacity={0.85} /> : null;
          })}
          {/* Nash cells */}
          {[...nashSet].map((k) => {
            const [i, j] = k.split(',').map(Number);
            const p = at(i, j);
            return p.shown ? <rect key={`n${k}`} x={p.x + 0.5} y={p.y + 0.5} width={cell - 1} height={cell - 1} fill="none" stroke="#22c55e" strokeWidth={2} /> : null;
          })}
          {/* Stackelberg picks */}
          {game.stackelberg.map((st) => {
            const p = at(st.i, st.j);
            return p.shown ? (
              <text key={`s${st.leader}`} x={p.x + cell / 2} y={p.y + cell * 0.78} fontSize={Math.max(8, cell * 0.9)} textAnchor="middle" fill={st.leader === 0 ? '#facc15' : '#f472b6'}>
                {st.leader === 0 ? '★' : '☆'}
              </text>
            ) : null;
          })}
          {/* flown cell */}
          {ci >= 0 && cj >= 0 && at(ci, cj).shown && <rect x={at(ci, cj).x - 1.5} y={at(ci, cj).y - 1.5} width={cell + 3} height={cell + 3} fill="none" stroke="#38bdf8" strokeWidth={1.5} strokeDasharray="3 2" />}
          {h && at(h[0], h[1]).shown && <rect x={at(h[0], h[1]).x} y={at(h[0], h[1]).y} width={cell} height={cell} fill="none" stroke="#e2e8f0" strokeWidth={1.2} />}
        </g>
      </svg>
      <div className="mt-1 min-h-[52px] rounded bg-slate-100 p-1.5 font-mono text-[10px] leading-snug dark:bg-slate-900">
        {h ? (
          <>
            <div>
              A[{h[0]}] {plan.candidates[0][h[0]]?.label}
              {v1[h[0]] ? '' : ' (invalid)'} vs B[{h[1]}] {plan.candidates[1][h[1]]?.label}
              {v2[h[1]] ? '' : ' (invalid)'}
            </div>
            <div>
              gap s_A−s_B {fmt(game.gap[h[0]][h[1]], 2)} m · risk {fmt(game.risk[h[0]][h[1]], 2)} s · payoff A {fmt(game.payoff1[h[0]][h[1]], 2)} · payoff B {fmt(game.payoff2[h[0]][h[1]], 2)}
            </div>
            <div className="text-slate-500">hover previews both paths in 3D</div>
          </>
        ) : (
          <span className="text-slate-500">Hover a cell to inspect it and preview both candidate paths in the 3D view.</span>
        )}
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-slate-500">
        <span>{colourBy === 'payoff' ? 'colour: payoff of A (orange: good for A, blue: bad for A; signed log scale)' : 'colour: progress gap s_A − s_B (orange: A ahead, blue: B ahead)'}</span>
        <span className="text-rose-500">╱ time inside the risk margin (stronger = longer)</span>
        <span>● A's best reply</span>
        <span>○ B's best reply</span>
        <span className="text-emerald-500">□ pure Nash</span>
        <span className="text-yellow-400">★ Stackelberg A leads</span>
        <span className="text-pink-400">☆ Stackelberg B leads</span>
        <span className="text-sky-400">⬚ flown</span>
        {hideInvalid && (v1.some((v) => !v) || v2.some((v) => !v)) && (
          <span>
            {v1.filter((v) => !v).length + v2.filter((v) => !v).length} invalid candidates hidden
          </span>
        )}
      </div>
    </div>
  );
}

export function GameTab() {
  const plan = useStore((s) => s.plan);
  const planStatus = useStore((s) => s.planStatus);
  const planProgress = useStore((s) => s.planProgress);
  const config = useStore((s) => s.config);
  const game = plan?.game;
  return (
    <div className="space-y-2.5">
      <Card
        title="Game-theoretic planner"
        right={
          <div className="flex items-center gap-1.5">
            <Badge tone="amber">{PLANNER_LABEL}</Badge>
            <Button small kind="primary" disabled={planStatus === 'solving'} onClick={() => requestSolve()}>
              {planStatus === 'solving' ? `Solving ${(planProgress * 100).toFixed(0)}%` : 'Solve'}
            </Button>
          </div>
        }
      >
        <p className="text-[11px] leading-snug text-slate-600 dark:text-slate-400">
          Each drone chooses one of M candidate strategies (a lateral/vertical offset profile across the lap × a speed level). Rollouts of every pair give the payoff: progress gap minus P × time inside the downwash zone. <b>Nash</b>: neither drone gains by changing its own choice. <b>Stackelberg</b>: the leader commits first, knowing the follower will best-respond.
        </p>
        {plan && (
          <div className="mt-1.5 text-[11px] text-slate-600 dark:text-slate-400">
            <b>{plan.solver}</b>: {plan.note} Solved in {fmt(plan.solveMs, 0)} ms; horizon {fmt(game?.horizon ?? plan.prediction.horizon, 1)} s; predicted gap {fmt(plan.prediction.gap, 2)} m, predicted winner {DRONE_NAMES[plan.prediction.winner]}.
          </div>
        )}
      </Card>
      {!plan && <div className="text-xs text-slate-500">{planStatus === 'solving' ? 'Solving the game…' : 'Choose a race scenario (T4, T9, T12-T14) to see the game.'}</div>}
      {plan && !game && <div className="text-xs text-slate-500">The payoff matrix is shown for two drones; with {config.drones.length} drones the N-drone extensions (iterated best response, priority chain) are used.</div>}
      {plan && game && (
        <Card title={`Payoff matrix of drone A (${game.payoff1.length} × ${game.payoff1[0]?.length ?? 0} candidates)`}>
          <PayoffMatrix plan={plan} game={game} />
        </Card>
      )}
      {plan && (
        <Card title="Candidates">
          <div className="grid grid-cols-2 gap-2">
            {plan.candidates.slice(0, 2).map((cs, d) => (
              <div key={d}>
                <div className="mb-0.5 text-[11px] font-semibold">Drone {DRONE_NAMES[d]}</div>
                <div className="thin-scroll max-h-40 overflow-y-auto font-mono text-[10px]">
                  {cs.map((c, k) => (
                    <div key={k} className={`flex justify-between ${!c.valid ? 'text-slate-400 line-through' : ''} ${plan.choice[d] === k ? 'font-bold text-sky-500' : ''}`}>
                      <span>
                        {k}. {c.label}
                      </span>
                      <span>{fmt(c.duration, 2)} s</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <p className="mt-1 text-[10px] text-slate-500">Labels: offset per quarter lap (L/l left, 0 centre, r/R right) @ speed level. Struck-through candidates hit an obstacle, miss a gate or leave the flight volume.</p>
        </Card>
      )}
    </div>
  );
}
