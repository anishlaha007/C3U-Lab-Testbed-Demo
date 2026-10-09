/**
 * Course editor (Section 5.2b, shortcut E). A full-screen top-down plan of the arena: place gates
 * and obstacles with the tools, drag to move (0.1 m snap, Alt for free placement), rotate with
 * the yaw handle, resize gates with the diameter handle, and set height / tilt in the gate's side
 * view. The inspector edits every parameter, the sequence list orders the gate visits, and the
 * validation strip re-checks the geometry and rebuilds the real racing line on a short debounce,
 * in a Web Worker so a badly broken course cannot freeze the plan. Edits stay local (with undo)
 * until Apply writes the course into config.course.custom as C12.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type MutableRefObject, type PointerEvent as RPointerEvent, type ReactNode } from 'react';
import { ARENA_MARGIN } from '../../core/constants';
import { diameterForInner, gateFrame } from '../../core/course';
import { COURSE_INFO } from '../../core/courses';
import { ENTRY_EXIT } from '../../core/racingLine';
import type { ArenaConfig, Course, CourseId, Gate, Obstacle } from '../../core/types';
import type { Vec3 } from '../../core/vec';
import { download } from '../share';
import { useStore } from '../store';
import { Badge, Button, Card, InfoDot, Slider, Stat, Tabs, Toggle, cx, fmt } from '../ui';
import {
  DIAMETER_RANGE,
  GATE_COLORS,
  PITCH_MAX_DEG,
  SNAP,
  addGate,
  addObstacle,
  addViaAfter,
  addVisit,
  CourseChecker,
  checkCourse,
  clamp,
  cloneCourse,
  deleteSel,
  drawFloorPlan,
  duplicateSel,
  effectiveArena,
  gateDirections,
  gateNumbers,
  gatePlan,
  heightRange,
  initialCourse,
  makeGate,
  makeObstacle,
  moveVisit,
  obstacleAnchor,
  parseCourseJson,
  pendulumSweep,
  raceTwr,
  rectCorners,
  removeVisit,
  round,
  selAnchor,
  selKey,
  selLabel,
  selValid,
  selYaw,
  setSelAnchor,
  setSelYaw,
  slug,
  snap,
  templateCourse,
  toDeg,
  toRad,
  toggleReverse,
  wrapDeg,
  type Issue,
  type LineReport,
  type Sel,
  type Tool,
} from './courseEditorUtils';

/** SVG user units per metre: the plan is drawn in centimetres so font sizes stay ordinary. */
const S = 100;
const PX = (x: number) => x * S;
/** The plan looks down the z axis with x to the right, so +y (left of the drones) points up. */
const PY = (y: number) => -y * S;
type P2 = { x: number; y: number };
type Edit = (fn: (c: Course) => void, key?: string) => void;
const NS = 'non-scaling-stroke';
const fm = (x: number, d = 2) => x.toFixed(d).replace('-', '−');

/** Stable callback that always sees the latest props/state (for memoised plan layers). */
function useEvent<A extends unknown[], R>(fn: (...a: A) => R): (...a: A) => R {
  const ref = useRef(fn);
  useLayoutEffect(() => {
    ref.current = fn;
  });
  return useCallback((...a: A) => ref.current(...a), []);
}

// ---------------------------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------------------------

const ic = (children: ReactNode) => (
  <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
    {children}
  </svg>
);

const TOOLS: { id: Tool; label: string; key: string; tip: string; icon: ReactNode }[] = [
  { id: 'select', label: 'Select', key: 'V', tip: 'select and drag items (Alt: no snap); arrows nudge 0.1 m, [ ] rotate 15°', icon: ic(<path d="M3.5 2.5 12.5 8l-4.2.9-2 4.6z" fill="currentColor" />) },
  { id: 'gate', label: 'Gate', key: 'G', tip: 'place a ring gate on a stand; it is appended to the sequence', icon: ic(<path d="M6 1.5h4l2.5 2.5v3.5L10 10H6L3.5 7.5V4zM8 10v4.5M5 14.5h6" />) },
  { id: 'hanging', label: 'Hanging', key: 'H', tip: 'place a gate hanging from the ceiling truss (it can be tilted up to 45°)', icon: ic(<path d="M6 6h4l2.5 2.5V12L10 14.5H6L3.5 12V8.5zM6 6V1M10 6V1" />) },
  { id: 'pillar', label: 'Pillar', key: 'P', tip: 'place a floor-to-ceiling pillar', icon: ic(<circle cx="8" cy="8" r="4.5" fill="currentColor" fillOpacity={0.35} />) },
  { id: 'box', label: 'Box/wall', key: 'B', tip: 'place a box on the floor (switch it to a low wall in the inspector)', icon: ic(<rect x="3" y="4" width="10" height="8" rx="0.5" fill="currentColor" fillOpacity={0.3} />) },
  { id: 'banner', label: 'Banner', key: 'N', tip: 'place a thin banner hanging from the ceiling', icon: ic(<path d="M2 2.5h12M4 2.5v8l2-1.5 2 1.5 2-1.5 2 1.5v-8" />) },
  { id: 'pendulum', label: 'Pendulum', key: 'L', tip: 'place a swinging pendulum (pivot on the truss)', icon: ic(<path d="M8 1.5 11 10.5M3 1.5h10M11 10.5m-2.5 0a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0" />) },
  { id: 'slider', label: 'Slider', key: 'S', tip: 'place a sliding panel that moves back and forth', icon: ic(<path d="M5.5 4h5v8h-5zM1.5 8h2.5M12 8h2.5M3 6.5 1.5 8 3 9.5M13 6.5 14.5 8 13 9.5" />) },
  { id: 'delete', label: 'Delete', key: 'X', tip: 'click an item to delete it (or select it and press Delete)', icon: ic(<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.8 9h5.4l.8-9" />) },
];

const HINTS: Record<Tool, string> = {
  select: 'Drag to move (snaps to 0.1 m, Alt = free) · drag the round handle to rotate, the square one to resize · Delete removes · Ctrl+Z undoes',
  gate: 'Click to place a gate on a stand (Shift-click to keep placing)',
  hanging: 'Click to place a hanging gate (Shift-click to keep placing)',
  pillar: 'Click to place a pillar (Shift-click to keep placing)',
  box: 'Click to place a box (Shift-click to keep placing)',
  banner: 'Click to place a hanging banner (Shift-click to keep placing)',
  pendulum: 'Click to place a pendulum pivot (Shift-click to keep placing)',
  slider: 'Click to place a sliding panel (Shift-click to keep placing)',
  delete: 'Click an item to delete it',
};

// ---------------------------------------------------------------------------------------------
// Small form controls
// ---------------------------------------------------------------------------------------------

/** Number box that only commits parseable values and keeps what is typed while focused. */
function NumBox({ value, onChange, min = -1e9, max = 1e9, step = 0.1, digits = 2, className, disabled, title }: { value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; digits?: number; className?: string; disabled?: boolean; title?: string }) {
  const [text, setText] = useState('');
  const [focused, setFocused] = useState(false);
  const shown = focused ? text : Number.isFinite(value) ? value.toFixed(digits) : '';
  return (
    <input
      type="number"
      title={title}
      disabled={disabled}
      className={cx('tabular w-full rounded border border-slate-300 bg-white px-1 py-0.5 text-right font-mono text-[11px] disabled:opacity-40 dark:border-slate-700 dark:bg-slate-900', className)}
      value={shown}
      step={step}
      min={min}
      max={max}
      onFocus={() => {
        setText(value.toFixed(digits));
        setFocused(true);
      }}
      onBlur={() => {
        setFocused(false);
        const v = parseFloat(text);
        if (Number.isFinite(v)) {
          const c = clamp(v, min, max);
          if (c !== value) onChange(c);
        }
      }}
      onChange={(e) => {
        setText(e.target.value);
        const v = parseFloat(e.target.value);
        if (Number.isFinite(v) && v >= min && v <= max) onChange(v);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
    />
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block min-w-0">
      <span className="mb-0.5 block text-[10px] tracking-wide text-slate-500 uppercase dark:text-slate-400">{label}</span>
      {children}
    </label>
  );
}

/** Label, exact number box and a range slider for the same value. */
function RangeRow({ label, tip, value, min, max, step, digits = 2, unit, onChange, boxMin, boxMax, disabled }: { label: string; tip?: string; value: number; min: number; max: number; step: number; digits?: number; unit?: string; onChange: (v: number) => void; boxMin?: number; boxMax?: number; disabled?: boolean }) {
  return (
    <div className={cx(disabled && 'opacity-40')}>
      <div className="flex items-center gap-1 text-[11px] text-slate-600 dark:text-slate-400">
        <span className="truncate">{label}</span>
        {tip && <InfoDot text={tip} />}
        <span className="ml-auto flex shrink-0 items-center gap-1">
          <NumBox value={value} min={boxMin ?? min} max={boxMax ?? max} step={step} digits={digits} onChange={onChange} disabled={disabled} className="w-16" />
          <span className="w-6 text-[10px] text-slate-500">{unit}</span>
        </span>
      </div>
      <input type="range" className="w-full" min={min} max={max} step={step} value={clamp(value, min, max)} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))} />
    </div>
  );
}

function MiniBtn({ children, onClick, title, disabled, active, danger }: { children: ReactNode; onClick: () => void; title?: string; disabled?: boolean; active?: boolean; danger?: boolean }) {
  return (
    <button
      title={title}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={cx(
        'rounded px-1 py-0.5 text-[10px] leading-none font-medium transition-colors disabled:opacity-30',
        active ? 'bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300' : danger ? 'text-rose-600 hover:bg-rose-100 dark:text-rose-400 dark:hover:bg-rose-500/15' : 'text-slate-600 hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-700',
      )}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------------------------
// Plan (SVG) layers
// ---------------------------------------------------------------------------------------------

function Arrow({ a, b, color, width = 2.5, dashed, head = 9 }: { a: P2; b: P2; color: string; width?: number; dashed?: boolean; head?: number }) {
  const ax = PX(a.x);
  const ay = PY(a.y);
  const bx = PX(b.x);
  const by = PY(b.y);
  const ang = Math.atan2(by - ay, bx - ax);
  const p1 = `${bx - head * Math.cos(ang - 0.45)},${by - head * Math.sin(ang - 0.45)}`;
  const p2 = `${bx - head * Math.cos(ang + 0.45)},${by - head * Math.sin(ang + 0.45)}`;
  return (
    <g pointerEvents="none">
      <line x1={ax} y1={ay} x2={bx - head * 0.6 * Math.cos(ang)} y2={by - head * 0.6 * Math.sin(ang)} stroke={color} strokeWidth={width} strokeDasharray={dashed ? '5 4' : undefined} />
      <polygon points={`${bx},${by} ${p1} ${p2}`} fill={color} />
    </g>
  );
}

const PlanGrid = memo(function PlanGrid({ sx, sy }: { sx: number; sy: number }) {
  const hx = sx / 2;
  const hy = sy / 2;
  const m = ARENA_MARGIN;
  let minor = '';
  let major = '';
  // 0.1 m snap grid with 0.5 m major lines, built as two paths (cheap to render)
  for (let k = Math.ceil(-hx / SNAP - 1e-9); k * SNAP <= hx + 1e-9; k++) {
    const d = `M${PX(round(k * SNAP, 6))} ${PY(hy)}V${PY(-hy)}`;
    if (k % 5 === 0) major += d;
    else minor += d;
  }
  for (let k = Math.ceil(-hy / SNAP - 1e-9); k * SNAP <= hy + 1e-9; k++) {
    const d = `M${PX(-hx)} ${PY(round(k * SNAP, 6))}H${PX(hx)}`;
    if (k % 5 === 0) major += d;
    else minor += d;
  }
  const ticksX: number[] = [];
  for (let x = Math.ceil(-hx); x <= hx + 1e-9; x++) ticksX.push(x);
  const ticksY: number[] = [];
  for (let y = Math.ceil(-hy); y <= hy + 1e-9; y++) ticksY.push(y);
  return (
    <g pointerEvents="none">
      <rect x={PX(-hx)} y={PY(hy)} width={sx * S} height={sy * S} className="fill-white dark:fill-slate-900" />
      <path d={`M${PX(-hx)} ${PY(hy)}h${sx * S}v${sy * S}h${-sx * S}Z M${PX(-hx + m)} ${PY(hy - m)}v${(sy - 2 * m) * S}h${(sx - 2 * m) * S}v${-(sy - 2 * m) * S}Z`} fillRule="evenodd" className="fill-rose-500/5 dark:fill-rose-500/10" />
      <path d={minor} className="stroke-slate-100 dark:stroke-slate-800/70" strokeWidth={1} vectorEffect={NS} />
      <path d={major} className="stroke-slate-300 dark:stroke-slate-700" strokeWidth={1} vectorEffect={NS} />
      <path d={`M${PX(-hx)} 0H${PX(hx)}M0 ${PY(hy)}V${PY(-hy)}`} className="stroke-slate-400 dark:stroke-slate-500" strokeWidth={1} strokeDasharray="6 4" vectorEffect={NS} />
      <rect x={PX(-hx + m)} y={PY(hy - m)} width={(sx - 2 * m) * S} height={(sy - 2 * m) * S} fill="none" className="stroke-rose-400 dark:stroke-rose-500/80" strokeWidth={1.5} strokeDasharray="8 5" vectorEffect={NS} />
      <rect x={PX(-hx)} y={PY(hy)} width={sx * S} height={sy * S} fill="none" className="stroke-slate-500 dark:stroke-slate-400" strokeWidth={2.5} vectorEffect={NS} />
      <text x={PX(-hx + m) + 6} y={PY(hy - m) + 15} fontSize={11} className="fill-rose-500 dark:fill-rose-400">
        geofence {m} m
      </text>
      {ticksX.map((x) => (
        <text key={`x${x}`} x={PX(x)} y={PY(-hy) + 20} fontSize={13} textAnchor="middle" className="fill-slate-500 dark:fill-slate-400">
          {fm(x, 0)}
        </text>
      ))}
      {ticksY.map((y) => (
        <text key={`y${y}`} x={PX(-hx) - 9} y={PY(y)} fontSize={13} textAnchor="end" dominantBaseline="central" className="fill-slate-500 dark:fill-slate-400">
          {fm(y, 0)}
        </text>
      ))}
      <text x={PX(hx)} y={PY(-hy) + 36} fontSize={12} textAnchor="end" className="fill-slate-400 dark:fill-slate-500">
        x (m) →
      </text>
      <text x={PX(-hx) - 9} y={PY(hy) - 12} fontSize={12} textAnchor="end" className="fill-slate-400 dark:fill-slate-500">
        y ↑
      </text>
      <Arrow a={{ x: 0, y: 0 }} b={{ x: 0.35, y: 0 }} color="#dc2626" width={2} head={7} />
      <Arrow a={{ x: 0, y: 0 }} b={{ x: 0, y: 0.35 }} color="#16a34a" width={2} head={7} />
    </g>
  );
});

const pts = (arr: P2[]) => arr.map((p) => `${PX(p.x).toFixed(1)},${PY(p.y).toFixed(1)}`).join(' ');
/**
 * Every k-th point (plus the last) so a polyline stays under ~1500 vertices: the line is sampled
 * in time, and a course slowed ×5 yields 15k+ samples that would make every drag repaint slowly.
 */
function thin<T>(arr: T[], max = 1500): T[] {
  if (arr.length <= max) return arr;
  const step = Math.ceil(arr.length / max);
  const out: T[] = [];
  for (let k = 0; k < arr.length; k += step) out.push(arr[k]);
  if ((arr.length - 1) % step) out.push(arr[arr.length - 1]);
  return out;
}

const LineLayer = memo(function LineLayer({ line }: { line: LineReport | null }) {
  if (!line || line.samples.length < 2) return null;
  const s = line.samples;
  const a = s[0];
  const b = s[Math.min(s.length - 1, 8)];
  const ang = Math.atan2(PY(b.y) - PY(a.y), PX(b.x) - PX(a.x));
  return (
    <g pointerEvents="none">
      {line.searchPaths.map((sp, k) => (
        <polyline key={k} points={pts(sp)} fill="none" className="stroke-violet-500/70 dark:stroke-violet-400/70" strokeWidth={1.5} strokeDasharray="4 3" vectorEffect={NS} />
      ))}
      <polyline points={pts(thin(s))} fill="none" className="stroke-sky-500/50 dark:stroke-sky-400/45" strokeWidth={3} strokeLinejoin="round" vectorEffect={NS} />
      {line.limitRuns.map(([i, j], k) => (
        <polyline key={k} points={pts(thin(s.slice(i, j + 1), 400))} fill="none" className="stroke-rose-500/75" strokeWidth={5} strokeLinecap="round" vectorEffect={NS} />
      ))}
      <polygon transform={`translate(${PX(a.x)} ${PY(a.y)}) rotate(${toDeg(ang)})`} points="9,0 -6,-6 -6,6" className="fill-sky-600 dark:fill-sky-400" />
    </g>
  );
});

/** Selection / problem rings around an item. */
function Marks({ c, r, selected, flagged }: { c: P2; r: number; selected?: boolean; flagged?: boolean }) {
  return (
    <>
      {selected && <circle cx={PX(c.x)} cy={PY(c.y)} r={r * S} fill="none" className="stroke-sky-500 dark:stroke-sky-400" strokeWidth={2} strokeDasharray="6 4" vectorEffect={NS} pointerEvents="none" />}
      {flagged && <circle cx={PX(c.x)} cy={PY(c.y)} r={r * S + 7} fill="none" className="stroke-rose-500" strokeWidth={1.5} strokeDasharray="2 3" vectorEffect={NS} pointerEvents="none" />}
    </>
  );
}

function GateGlyph({ g, num, dir, selected, flagged, ghost }: { g: Gate; num: string; dir: { fwd: boolean; rev: boolean }; selected?: boolean; flagged?: boolean; ghost?: boolean }) {
  const pl = gatePlan(g);
  const c = g.center;
  const visited = dir.fwd || dir.rev;
  const signs = visited ? [...(dir.fwd ? [1] : []), ...(dir.rev ? [-1] : [])] : [1];
  const R = g.diameter / 2;
  const at = (s: number, t = 0) => ({ x: c.x + s * pl.n.x + t * pl.l.x, y: c.y + s * pl.n.y + t * pl.l.y });
  const badge = at(0, R + 0.17);
  const bw = Math.max(22, num.length * 8 + 12);
  return (
    <g opacity={ghost ? 0.45 : 1}>
      <Marks c={c} r={R + 0.1} selected={selected} flagged={flagged} />
      {pl.legs.map(([a, b], k) => (
        <line key={k} x1={PX(a.x)} y1={PY(a.y)} x2={PX(b.x)} y2={PY(b.y)} className="stroke-slate-400 dark:stroke-slate-600" strokeWidth={2} />
      ))}
      {signs.map((s) => (
        <Arrow key={s} a={at(-s * ENTRY_EXIT)} b={at(s * (ENTRY_EXIT + 0.08))} color={visited ? g.color : '#94a3b8'} dashed={!visited} />
      ))}
      {visited &&
        [-1, 1].map((s) => {
          const p = at(s * ENTRY_EXIT);
          return <circle key={s} cx={PX(p.x)} cy={PY(p.y)} r={3} fill={g.color} />;
        })}
      <polygon points={pts(pl.poly)} fill={g.color} fillOpacity={0.15} stroke={g.color} strokeWidth={7} strokeLinejoin="round" />
      {pl.cables.map((p, k) => (
        <circle key={k} cx={PX(p.x)} cy={PY(p.y)} r={3.5} className="fill-white stroke-slate-700 dark:fill-slate-900 dark:stroke-slate-200" strokeWidth={1.5} />
      ))}
      <circle cx={PX(c.x)} cy={PY(c.y)} r={2.5} className="fill-slate-800 dark:fill-slate-100" />
      {/* generous invisible hit area along the bar */}
      <line x1={PX(at(0, -R).x)} y1={PY(at(0, -R).y)} x2={PX(at(0, R).x)} y2={PY(at(0, R).y)} stroke="transparent" strokeWidth={26} strokeLinecap="round" />
      <g transform={`translate(${PX(badge.x)} ${PY(badge.y)})`}>
        <rect x={-bw / 2} y={-11} width={bw} height={22} rx={11} fill={visited ? g.color : '#94a3b8'} />
        <text fontSize={13} fontWeight={700} textAnchor="middle" dominantBaseline="central" fill="#fff">
          {num || '–'}
        </text>
        <text y={23} fontSize={11} textAnchor="middle" className="fill-slate-500 dark:fill-slate-400">
          {g.id} · {g.center.z.toFixed(2)} m
        </text>
      </g>
    </g>
  );
}

/** Rough reach of an obstacle around its anchor (for the selection ring). */
function obstacleReach(o: Obstacle): { c: P2; r: number } {
  switch (o.kind) {
    case 'pillar':
      return { c: { x: o.x, y: o.y }, r: o.radius + 0.08 };
    case 'box':
      return { c: obstacleAnchor(o), r: Math.hypot(o.size.x, o.size.y) / 2 + 0.08 };
    case 'pendulum':
      return { c: obstacleAnchor(o), r: o.length * Math.sin(Math.abs(o.amplitude)) + o.bobRadius + 0.08 };
    case 'slider':
      return { c: obstacleAnchor(o), r: Math.hypot(o.size.x / 2 + o.travel, o.size.y / 2) + 0.08 };
  }
}

function ObstacleGlyph({ o, selected, flagged, ghost }: { o: Obstacle; selected?: boolean; flagged?: boolean; ghost?: boolean }) {
  const reach = obstacleReach(o);
  const label = (x: number, y: number, dy: number) => (
    <text x={PX(x)} y={PY(y) + dy} fontSize={11} textAnchor="middle" className="fill-slate-500 dark:fill-slate-400" pointerEvents="none">
      {o.id}
    </text>
  );
  let body: ReactNode;
  switch (o.kind) {
    case 'pillar': {
      const r = Math.max(3, o.radius * S);
      body = (
        <>
          <circle cx={PX(o.x)} cy={PY(o.y)} r={r} className="fill-amber-400/50 stroke-amber-600 dark:fill-amber-500/35 dark:stroke-amber-400" strokeWidth={2} />
          <circle cx={PX(o.x)} cy={PY(o.y)} r={r * 0.4} className="fill-amber-700/60 dark:fill-amber-300/60" pointerEvents="none" />
          <circle cx={PX(o.x)} cy={PY(o.y)} r={Math.max(r, 12)} fill="transparent" />
          {label(o.x, o.y, r + 13)}
        </>
      );
      break;
    }
    case 'box': {
      const corners = pts(rectCorners(o.center.x, o.center.y, o.size.x / 2, o.size.y / 2, o.yaw));
      const cls =
        o.label === 'banner'
          ? 'fill-violet-500/20 stroke-violet-600 dark:stroke-violet-400'
          : o.label === 'wall'
            ? 'fill-slate-500/35 stroke-slate-600 dark:fill-slate-400/30 dark:stroke-slate-300'
            : 'fill-amber-700/25 stroke-amber-700 dark:fill-amber-600/25 dark:stroke-amber-500';
      body = (
        <>
          <polygon points={corners} className={cls} strokeWidth={2} strokeDasharray={o.label === 'banner' ? '6 3' : undefined} vectorEffect={NS} />
          <polygon points={corners} fill="transparent" stroke="transparent" strokeWidth={16} />
          {label(o.center.x, o.center.y, 4)}
        </>
      );
      break;
    }
    case 'pendulum': {
      const [a, b] = pendulumSweep(o);
      const rb = o.bobRadius * S;
      body = (
        <>
          <line x1={PX(a.x)} y1={PY(a.y)} x2={PX(b.x)} y2={PY(b.y)} className="stroke-rose-500/20 dark:stroke-rose-400/20" strokeWidth={2 * rb} strokeLinecap="round" />
          <line x1={PX(a.x)} y1={PY(a.y)} x2={PX(b.x)} y2={PY(b.y)} className="stroke-rose-500 dark:stroke-rose-400" strokeWidth={1.5} strokeDasharray="5 3" vectorEffect={NS} pointerEvents="none" />
          {[a, b].map((p, k) => (
            <circle key={k} cx={PX(p.x)} cy={PY(p.y)} r={rb} fill="none" className="stroke-rose-500/70" strokeWidth={1.5} strokeDasharray="3 3" vectorEffect={NS} pointerEvents="none" />
          ))}
          <circle cx={PX(o.pivot.x)} cy={PY(o.pivot.y)} r={rb} className="fill-rose-500/40 stroke-rose-600 dark:stroke-rose-400" strokeWidth={1.5} vectorEffect={NS} />
          <path d={`M${PX(o.pivot.x) - 5} ${PY(o.pivot.y)}h10M${PX(o.pivot.x)} ${PY(o.pivot.y) - 5}v10`} className="stroke-rose-700 dark:stroke-rose-200" strokeWidth={1.5} vectorEffect={NS} pointerEvents="none" />
          {label(o.pivot.x, o.pivot.y, rb + 13)}
        </>
      );
      break;
    }
    case 'slider': {
      const e = { x: Math.cos(o.yaw), y: Math.sin(o.yaw) };
      const at = (s: number) => pts(rectCorners(o.center.x + s * e.x, o.center.y + s * e.y, o.size.x / 2, o.size.y / 2, o.yaw));
      const ends = [-1, 1].map((s) => ({ x: o.center.x + s * o.travel * e.x, y: o.center.y + s * o.travel * e.y }));
      body = (
        <>
          {[-o.travel, o.travel].map((s) => (
            <polygon key={s} points={at(s)} className="fill-yellow-400/10 stroke-yellow-600/80 dark:stroke-yellow-400/70" strokeWidth={1.5} strokeDasharray="4 3" vectorEffect={NS} />
          ))}
          <polygon points={at(0)} className="fill-yellow-400/50 stroke-yellow-700 dark:fill-yellow-400/35 dark:stroke-yellow-300" strokeWidth={2} vectorEffect={NS} />
          <polygon points={at(0)} fill="transparent" stroke="transparent" strokeWidth={16} />
          <Arrow a={o.center} b={ends[1]} color="#ca8a04" width={1.5} head={7} />
          <Arrow a={o.center} b={ends[0]} color="#ca8a04" width={1.5} head={7} />
          {label(o.center.x, o.center.y, -12)}
        </>
      );
      break;
    }
  }
  return (
    <g opacity={ghost ? 0.45 : 1}>
      <Marks c={reach.c} r={reach.r} selected={selected} flagged={flagged} />
      {body}
    </g>
  );
}

const PlanItems = memo(function PlanItems({ course, sel, flagged, tool, onDown }: { course: Course; sel: Sel; flagged: Set<string>; tool: Tool; onDown: (s: Sel, e: RPointerEvent) => void }) {
  const nums = useMemo(() => gateNumbers(course), [course]);
  const dirs = useMemo(() => gateDirections(course), [course]);
  const cur = tool === 'select' ? 'cursor-move' : tool === 'delete' ? 'cursor-pointer' : '';
  const sk = selKey(sel);
  return (
    <g>
      {course.obstacles.map((o, i) => (
        <g key={`${o.id}-${i}`} className={cx(cur, tool === 'delete' && 'hover:opacity-50')} onPointerDown={(e) => onDown({ t: 'obs', i }, e)}>
          <ObstacleGlyph o={o} selected={sk === `obs${i}`} flagged={flagged.has(`obs${i}`)} />
        </g>
      ))}
      {course.gates.map((g, i) => (
        <g key={`${g.id}-${i}`} className={cx(cur, tool === 'delete' && 'hover:opacity-50')} onPointerDown={(e) => onDown({ t: 'gate', i }, e)}>
          <GateGlyph g={g} num={nums[i]} dir={dirs[i]} selected={sk === `gate${i}`} flagged={flagged.has(`gate${i}`)} />
        </g>
      ))}
      {(course.via ?? []).map((v, i) =>
        v.points.map((p, k) => {
          const on = sk === `via${i}.${k}`;
          return (
            <g key={`via${i}.${k}`} className={cur} onPointerDown={(e) => onDown({ t: 'via', i, k }, e)}>
              <rect x={-6} y={-6} width={12} height={12} transform={`translate(${PX(p.x)} ${PY(p.y)}) rotate(45)`} className={on ? 'fill-sky-500 stroke-sky-700' : 'fill-white stroke-slate-600 dark:fill-slate-800 dark:stroke-slate-300'} strokeWidth={1.5} vectorEffect={NS} />
              <text x={PX(p.x) + 10} y={PY(p.y) - 8} fontSize={10} className="fill-slate-500 dark:fill-slate-400" pointerEvents="none">
                via {v.after + 1}·{k + 1} · {p.z.toFixed(1)} m
              </text>
            </g>
          );
        }),
      )}
    </g>
  );
});

/** Yaw and diameter handles of the selected item. */
function Handles({ course, sel, onDown }: { course: Course; sel: Sel; onDown: (mode: 'rotate' | 'diameter', e: RPointerEvent) => void }) {
  if (!sel || sel.t === 'via') return null;
  const a = selAnchor(course, sel);
  const yaw = selYaw(course, sel);
  if (!a || yaw === null) return null;
  let reach = 0.75;
  let gate: Gate | null = null;
  if (sel.t === 'gate') gate = course.gates[sel.i];
  else {
    const o = course.obstacles[sel.i];
    if (o.kind === 'box') reach = o.size.x / 2 + 0.25;
    else if (o.kind === 'slider') reach = o.size.x / 2 + o.travel + 0.25;
    else if (o.kind === 'pendulum') reach = o.length * Math.sin(Math.abs(o.amplitude)) + o.bobRadius + 0.2;
  }
  const h = { x: a.x + reach * Math.cos(yaw), y: a.y + reach * Math.sin(yaw) };
  // diameter handle on the end of the bar away from the sequence badge, so the labels do not collide
  const dpt = gate ? { x: a.x + (gate.diameter / 2) * Math.sin(yaw), y: a.y - (gate.diameter / 2) * Math.cos(yaw) } : null;
  return (
    <g>
      <line x1={PX(a.x)} y1={PY(a.y)} x2={PX(h.x)} y2={PY(h.y)} className="stroke-sky-500" strokeWidth={1.5} strokeDasharray="3 3" vectorEffect={NS} pointerEvents="none" />
      <circle cx={PX(h.x)} cy={PY(h.y)} r={8} className="cursor-grab fill-white stroke-sky-500 dark:fill-slate-900" strokeWidth={2.5} vectorEffect={NS} onPointerDown={(e) => onDown('rotate', e)}>
        <title>Drag to rotate (5° steps, Shift 15°, Alt free)</title>
      </circle>
      <text x={PX(h.x) + 12} y={PY(h.y) - 10} fontSize={12} fontWeight={600} className="fill-sky-600 dark:fill-sky-300" pointerEvents="none">
        {fm(wrapDeg(toDeg(yaw)), 0)}°
      </text>
      {dpt && gate && (
        <>
          <rect x={PX(dpt.x) - 6} y={PY(dpt.y) - 6} width={12} height={12} className="cursor-pointer fill-sky-500 stroke-white dark:stroke-slate-900" strokeWidth={1.5} vectorEffect={NS} onPointerDown={(e) => onDown('diameter', e)}>
            <title>Drag to resize the gate (0.05 m steps)</title>
          </rect>
          <text x={PX(dpt.x) + 10} y={PY(dpt.y) + 18} fontSize={11} className="fill-sky-600 dark:fill-sky-300" pointerEvents="none">
            Ø {gate.diameter.toFixed(2)}
          </text>
        </>
      )}
    </g>
  );
}

/** Ghost of the item the active tool would place, following the (snapped) cursor. */
function HoverGhost({ bind, tool, course, arena }: { bind: MutableRefObject<((p: P2 | null) => void) | null>; tool: Tool; course: Course; arena: ArenaConfig }) {
  const [p, setP] = useState<P2 | null>(null);
  useEffect(() => {
    bind.current = setP;
    return () => {
      bind.current = null;
    };
  }, [bind]);
  if (!p || tool === 'select' || tool === 'delete') return null;
  const x = snap(p.x);
  const y = snap(p.y);
  if (Math.abs(x) > arena.sx / 2 || Math.abs(y) > arena.sy / 2) return null;
  return (
    <g pointerEvents="none">
      {tool === 'gate' || tool === 'hanging' ? <GateGlyph g={makeGate(course, x, y, tool === 'gate' ? 'stand' : 'hanging')} num="+" dir={{ fwd: true, rev: false }} ghost /> : <ObstacleGlyph o={makeObstacle(tool, x, y, arena, [])} ghost />}
      <path d={`M${PX(x) - 14} ${PY(y)}h28M${PX(x)} ${PY(y) - 14}v28`} className="stroke-sky-500" strokeWidth={1} vectorEffect={NS} />
    </g>
  );
}

// ---------------------------------------------------------------------------------------------
// Gate side view (height and tilt handles)
// ---------------------------------------------------------------------------------------------

function GateSideView({ g, arena, onHeight, onPitch }: { g: Gate; arena: ArenaConfig; onHeight: (z: number, key: string) => void; onPitch: (deg: number, key: string) => void }) {
  const ref = useRef<SVGSVGElement>(null);
  const drag = useRef<{ mode: 'h' | 'p'; key: string } | null>(null);
  const seq = useRef(0);
  const [h0, h1] = heightRange(g, arena);
  const sz = arena.sz;
  const W = 0.85;
  const R = g.diameter / 2;
  const cp = Math.cos(g.pitch);
  const sp = Math.sin(g.pitch);
  const z = g.center.z;
  const U = (u: number) => u * S;
  const Z = (h: number) => -h * S;
  const toW = (e: { clientX: number; clientY: number }) => {
    const m = ref.current?.getScreenCTM();
    if (!m) return null;
    const q = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    return { u: q.x / S, z: -q.y / S };
  };
  const down = (mode: 'h' | 'p') => (e: RPointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    drag.current = { mode, key: `drag-side${++seq.current}` };
    ref.current?.setPointerCapture(e.pointerId);
  };
  const move = (e: RPointerEvent) => {
    const d = drag.current;
    const p = toW(e);
    if (!d || !p) return;
    if (d.mode === 'h') onHeight(clamp(e.altKey ? round(p.z, 2) : snap(p.z, 0.05), h0, h1), d.key);
    else {
      const deg = toDeg(Math.atan2(p.z - z, Math.max(0.05, Math.abs(p.u))));
      onPitch(clamp(e.altKey ? Math.round(deg) : snap(deg, 5), -PITCH_MAX_DEG, PITCH_MAX_DEG), d.key);
    }
  };
  const up = (e: RPointerEvent) => {
    drag.current = null;
    if (ref.current?.hasPointerCapture(e.pointerId)) ref.current.releasePointerCapture(e.pointerId);
  };
  const top = { u: -R * sp, z: z + R * cp };
  const bot = { u: R * sp, z: z - R * cp };
  const tip = { u: 0.5 * cp, z: z + 0.5 * sp };
  const ticks = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4].filter((t) => t <= sz + 1e-9);
  return (
    <svg ref={ref} viewBox={`${-W * S} ${Z(sz) - 14} ${2 * W * S} ${sz * S + 30}`} className="h-48 w-auto shrink-0 touch-none rounded border border-slate-200 select-none dark:border-slate-800" onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
      <title>Side view along the gate normal: drag the ring up or down for height; drag the handle to tilt (hanging gates)</title>
      <rect x={-W * S} y={Z(sz)} width={2 * W * S} height={sz * S} className="fill-slate-50 dark:fill-slate-900" />
      <rect x={-W * S} y={Z(h1)} width={2 * W * S} height={(h1 - h0) * S} className="fill-sky-500/10" />
      {[ARENA_MARGIN, sz - ARENA_MARGIN].map((h) => (
        <line key={h} x1={-W * S} x2={W * S} y1={Z(h)} y2={Z(h)} className="stroke-rose-400/70" strokeWidth={1} strokeDasharray="5 4" vectorEffect={NS} />
      ))}
      {ticks.map((t) => (
        <g key={t}>
          <line x1={-W * S} x2={-W * S + 10} y1={Z(t)} y2={Z(t)} className="stroke-slate-400" strokeWidth={1} vectorEffect={NS} />
          <text x={-W * S + 14} y={Z(t)} fontSize={18} dominantBaseline="central" className="fill-slate-400 dark:fill-slate-500">
            {t.toFixed(1)}
          </text>
        </g>
      ))}
      <line x1={-W * S} x2={W * S} y1={0} y2={0} className="stroke-slate-500 dark:stroke-slate-400" strokeWidth={2} vectorEffect={NS} />
      <line x1={-W * S} x2={W * S} y1={Z(sz)} y2={Z(sz)} className="stroke-slate-400 dark:stroke-slate-500" strokeWidth={1.5} strokeDasharray="8 4" vectorEffect={NS} />
      {g.mount === 'stand' ? (
        <path d={`M${U(bot.u)} ${Z(bot.z - 0.02)}V0M${U(bot.u) - 30} 0h60`} className="stroke-slate-500 dark:stroke-slate-400" strokeWidth={3} />
      ) : (
        <path d={`M${U(top.u) - 4} ${Z(top.z)}V${Z(sz)}M${U(top.u) + 4} ${Z(top.z)}V${Z(sz)}`} className="stroke-slate-400 dark:stroke-slate-500" strokeWidth={1.5} vectorEffect={NS} />
      )}
      <line x1={U(-ENTRY_EXIT * cp)} y1={Z(z - ENTRY_EXIT * sp)} x2={U(ENTRY_EXIT * cp)} y2={Z(z + ENTRY_EXIT * sp)} stroke={g.color} strokeWidth={1.5} strokeDasharray="4 3" vectorEffect={NS} />
      <line x1={U(bot.u)} y1={Z(bot.z)} x2={U(top.u)} y2={Z(top.z)} stroke={g.color} strokeWidth={8} strokeLinecap="round" />
      <line x1={U(bot.u)} y1={Z(bot.z)} x2={U(top.u)} y2={Z(top.z)} stroke="transparent" strokeWidth={34} className="cursor-ns-resize" onPointerDown={down('h')} />
      <line x1={0} y1={Z(z)} x2={U(tip.u)} y2={Z(tip.z)} stroke={g.color} strokeWidth={2.5} vectorEffect={NS} pointerEvents="none" />
      {g.mount === 'hanging' ? (
        <circle cx={U(tip.u)} cy={Z(tip.z)} r={9} className="cursor-grab fill-white stroke-sky-500 dark:fill-slate-900" strokeWidth={2.5} vectorEffect={NS} onPointerDown={down('p')} />
      ) : (
        <circle cx={U(tip.u)} cy={Z(tip.z)} r={4} fill={g.color} pointerEvents="none" />
      )}
      <text x={U(0.08)} y={Z(z) + 26} fontSize={20} fontWeight={600} className="fill-slate-700 dark:fill-slate-200" pointerEvents="none">
        {z.toFixed(2)} m
      </text>
    </svg>
  );
}

// ---------------------------------------------------------------------------------------------
// Inspector
// ---------------------------------------------------------------------------------------------

function XY({ x, y, onX, onY, z, onZ, zLabel = 'z (m)', zMin = 0, zMax = 5 }: { x: number; y: number; onX: (v: number) => void; onY: (v: number) => void; z?: number; onZ?: (v: number) => void; zLabel?: string; zMin?: number; zMax?: number }) {
  return (
    <div className={cx('grid gap-1.5', z !== undefined ? 'grid-cols-3' : 'grid-cols-2')}>
      <Field label="x (m)">
        <NumBox value={x} onChange={onX} min={-10} max={10} />
      </Field>
      <Field label="y (m)">
        <NumBox value={y} onChange={onY} min={-10} max={10} />
      </Field>
      {z !== undefined && onZ && (
        <Field label={zLabel}>
          <NumBox value={z} onChange={onZ} min={zMin} max={zMax} />
        </Field>
      )}
    </div>
  );
}

function SizeRow({ size, onSize }: { size: Vec3; onSize: (k: 'x' | 'y' | 'z', v: number) => void }) {
  return (
    <div className="grid grid-cols-3 gap-1.5">
      {(['x', 'y', 'z'] as const).map((k) => (
        <Field key={k} label={k === 'x' ? 'length (m)' : k === 'y' ? 'width (m)' : 'height (m)'}>
          <NumBox value={size[k]} onChange={(v) => onSize(k, v)} min={0.02} max={6} step={0.05} />
        </Field>
      ))}
    </div>
  );
}

function GateInspector({ g, i, course, arena, edit, onAction }: { g: Gate; i: number; course: Course; arena: ArenaConfig; edit: Edit; onAction: (a: 'delete' | 'duplicate' | 'visit' | 'reverseVisit') => void }) {
  const set = (key: string, fn: (g: Gate) => void) => edit((c) => fn(c.gates[i]), `g${i}.${key}`);
  const [h0, h1] = heightRange(g, arena);
  const f = gateFrame(g);
  const visits = course.sequence.map((v, k) => (v.gate === i ? `#${k + 1}${v.reverse ? ' (rev)' : ''}` : '')).filter(Boolean);
  const yawDeg = wrapDeg(toDeg(g.yaw));
  return (
    <Card
      title={
        <span className="flex items-center gap-1.5">
          <span className="h-3 w-3 rounded-full" style={{ background: g.color }} />
          Gate {g.id}
        </span>
      }
      right={<Badge tone={visits.length ? 'sky' : 'slate'}>{visits.length ? `visit ${visits.join(', ')}` : 'not in sequence'}</Badge>}
    >
      <div className="space-y-2.5">
        <div className="flex items-center gap-2">
          <Tabs
            small
            value={g.mount}
            options={[
              { value: 'stand', label: 'On stand', title: 'Freestanding ring on a pole with an X-shaped base' },
              { value: 'hanging', label: 'Hanging', title: 'Suspended from the ceiling truss by two cables; can be tilted and stacked' },
            ]}
            onChange={(m) =>
              set('mount', (q) => {
                q.mount = m;
                if (m === 'stand') {
                  q.pitch = 0;
                  q.center.z = clamp(q.center.z, 0.5, 1.8);
                }
              })
            }
          />
          <span className="ml-auto text-[10px] text-slate-500">pass radius {(f.rPass * 100).toFixed(0)} cm</span>
        </div>
        <XY x={g.center.x} y={g.center.y} onX={(v) => set('x', (q) => (q.center.x = v))} onY={(v) => set('y', (q) => (q.center.y = v))} />
        <div className="flex gap-2">
          <GateSideView g={g} arena={arena} onHeight={(z, key) => edit((c) => (c.gates[i].center.z = z), key)} onPitch={(d, key) => edit((c) => (c.gates[i].pitch = toRad(d)), key)} />
          <div className="min-w-0 flex-1 space-y-2">
            <RangeRow label="Height z" tip="Centre height of the ring: 0.5 to 1.8 m on a stand; hanging gates can go higher (up to the geofence)." value={g.center.z} min={h0} max={h1} step={0.05} unit="m" onChange={(v) => set('z', (q) => (q.center.z = v))} />
            <RangeRow label="Tilt" tip="Pitch of the ring about its horizontal axis (hanging gates only, up to ±45°); positive tilts the pass direction upwards." value={toDeg(g.pitch)} min={-PITCH_MAX_DEG} max={PITCH_MAX_DEG} step={1} digits={0} unit="°" disabled={g.mount === 'stand'} onChange={(v) => set('pitch', (q) => (q.pitch = toRad(v)))} />
            {g.mount === 'stand' && <p className="text-[10px] leading-snug text-slate-500">Hang the gate to tilt it.</p>}
          </div>
        </div>
        <RangeRow label="Yaw (pass direction)" tip="Direction the drone flies through the gate, measured from +x towards +y." value={yawDeg} min={-180} max={180} step={5} digits={0} unit="°" boxMin={-360} boxMax={360} onChange={(v) => set('yaw', (q) => (q.yaw = toRad(wrapDeg(v))))} />
        <div className="flex gap-1">
          <Button small onClick={() => set('yaw', (q) => (q.yaw = toRad(wrapDeg(yawDeg - 90))))}>−90°</Button>
          <Button small onClick={() => set('yaw', (q) => (q.yaw = toRad(wrapDeg(yawDeg + 90))))}>+90°</Button>
          <Button small onClick={() => set('yaw', (q) => (q.yaw = toRad(wrapDeg(yawDeg + 180))))} title="Turn the gate around (its visits keep their direction relative to the gate)">
            Flip 180°
          </Button>
        </div>
        <RangeRow
          label="Outer diameter"
          tip="Measured over the tube; the clear opening is smaller by the octagon's corners and the tube. The 0.30 m pinch ring has an outer diameter of 0.41 m."
          value={g.diameter}
          min={DIAMETER_RANGE[0]}
          max={DIAMETER_RANGE[1]}
          boxMin={round(diameterForInner(0.3), 2)}
          step={0.05}
          unit="m"
          onChange={(v) => set('d', (q) => (q.diameter = v))}
        />
        <p className="-mt-1.5 text-[10px] text-slate-500">
          Clear opening Ø {(2 * f.rClear).toFixed(2)} m · drone-centre window Ø {(2 * f.rPass).toFixed(2)} m
        </p>
        <div>
          <div className="mb-1 text-[10px] tracking-wide text-slate-500 uppercase dark:text-slate-400">Colour</div>
          <div className="flex flex-wrap items-center gap-1">
            {GATE_COLORS.map((col) => (
              <button key={col} title={col} onClick={() => set('color', (q) => (q.color = col))} className={cx('h-5 w-5 rounded-full border-2', g.color.toLowerCase() === col ? 'border-slate-900 dark:border-white' : 'border-transparent')} style={{ background: col }} />
            ))}
            <input type="color" value={/^#[0-9a-f]{6}$/i.test(g.color) ? g.color : '#3b82f6'} onChange={(e) => set('color', (q) => (q.color = e.target.value))} className="h-5 w-7 cursor-pointer rounded border border-slate-300 bg-transparent p-0 dark:border-slate-700" title="Custom colour" />
          </div>
        </div>
        <div className="flex flex-wrap gap-1 border-t border-slate-200 pt-2 dark:border-slate-800">
          <Button small onClick={() => onAction('visit')} title="Append another pass through this gate to the sequence">
            + Visit
          </Button>
          <Button small onClick={() => onAction('reverseVisit')} title="Append a pass against the gate's direction">
            + Reverse visit
          </Button>
          <Button small kind="ghost" onClick={() => onAction('duplicate')} title="Duplicate (Ctrl+D)">
            Duplicate
          </Button>
          <Button small kind="danger" className="ml-auto" onClick={() => onAction('delete')} title="Delete the gate and its visits (Delete)">
            Delete
          </Button>
        </div>
      </div>
    </Card>
  );
}

function ObstacleInspector({ o, i, arena, edit, onAction }: { o: Obstacle; i: number; arena: ArenaConfig; edit: Edit; onAction: (a: 'delete' | 'duplicate') => void }) {
  const set = (key: string, fn: (o: Obstacle) => void) => edit((c) => fn(c.obstacles[i]), `o${i}.${key}`);
  const a = obstacleAnchor(o);
  const setXY = (k: 'x' | 'y', v: number) =>
    set(k, (q) => {
      if (q.kind === 'pillar') q[k] = v;
      else if (q.kind === 'pendulum') q.pivot[k] = v;
      else q.center[k] = v;
    });
  let body: ReactNode = null;
  let title = '';
  switch (o.kind) {
    case 'pillar':
      title = `Pillar ${o.id}`;
      body = (
        <>
          <XY x={a.x} y={a.y} onX={(v) => setXY('x', v)} onY={(v) => setXY('y', v)} />
          <RangeRow label="Radius" value={o.radius} min={0.05} max={0.2} step={0.01} unit="m" onChange={(v) => set('r', (q) => q.kind === 'pillar' && (q.radius = v))} />
          <RangeRow label="Height" tip="Pillars usually run floor to ceiling." value={o.height} min={0.3} max={arena.sz} step={0.1} unit="m" onChange={(v) => set('h', (q) => q.kind === 'pillar' && (q.height = v))} />
        </>
      );
      break;
    case 'box': {
      const lbl = o.label ?? 'box';
      title = `${lbl === 'box' ? 'Box' : lbl === 'wall' ? 'Wall' : 'Banner'} ${o.id}`;
      body = (
        <>
          <Tabs
            small
            value={lbl}
            options={[
              { value: 'box', label: 'Box' },
              { value: 'wall', label: 'Low wall' },
              { value: 'banner', label: 'Banner' },
            ]}
            onChange={(v) =>
              set('label', (q) => {
                if (q.kind !== 'box') return;
                q.label = v;
                // sensible shapes for each kind: a low wall on the floor, a thin plate under the truss
                if (v === 'wall') {
                  q.size = { x: 1.5, y: 0.1, z: 0.6 };
                  q.center.z = 0.3;
                } else if (v === 'banner') {
                  q.size = { x: 1.0, y: 0.03, z: 0.8 };
                  q.center.z = round(arena.sz - 0.4, 2);
                } else {
                  q.size = { x: 0.6, y: 0.6, z: 0.6 };
                  q.center.z = 0.3;
                }
              })
            }
          />
          <XY x={a.x} y={a.y} onX={(v) => setXY('x', v)} onY={(v) => setXY('y', v)} z={o.center.z} zLabel="centre z (m)" zMax={arena.sz} onZ={(v) => set('z', (q) => q.kind === 'box' && (q.center.z = v))} />
          <SizeRow size={o.size} onSize={(k, v) => set(`s${k}`, (q) => q.kind === 'box' && (q.size[k] = v))} />
          <RangeRow label="Yaw" value={wrapDeg(toDeg(o.yaw))} min={-180} max={180} step={5} digits={0} unit="°" onChange={(v) => set('yaw', (q) => q.kind === 'box' && (q.yaw = toRad(v)))} />
          <div className="flex gap-1">
            <Button small onClick={() => set('z', (q) => q.kind === 'box' && (q.center.z = round(q.size.z / 2, 3)))}>Rest on floor</Button>
            <Button small onClick={() => set('z', (q) => q.kind === 'box' && (q.center.z = round(arena.sz - q.size.z / 2, 3)))}>Hang from ceiling</Button>
          </div>
        </>
      );
      break;
    }
    case 'pendulum': {
      const natural = 2 * Math.PI * Math.sqrt(o.length / 9.81);
      title = `Pendulum ${o.id}`;
      body = (
        <>
          <XY x={a.x} y={a.y} onX={(v) => setXY('x', v)} onY={(v) => setXY('y', v)} z={o.pivot.z} zLabel="pivot z (m)" zMax={arena.sz + 0.5} onZ={(v) => set('pz', (q) => q.kind === 'pendulum' && (q.pivot.z = v))} />
          <RangeRow label="Cable length" value={o.length} min={0.3} max={Math.max(0.4, round(o.pivot.z - 0.1, 2))} step={0.05} unit="m" onChange={(v) => set('L', (q) => q.kind === 'pendulum' && (q.length = v))} />
          <p className="-mt-1.5 text-[10px] text-slate-500">
            Bob swings down to {(o.pivot.z - o.length).toFixed(2)} m; reach ±{(o.length * Math.sin(Math.abs(o.amplitude))).toFixed(2)} m.
          </p>
          <RangeRow label="Bob radius" value={o.bobRadius} min={0.05} max={0.25} step={0.01} unit="m" onChange={(v) => set('br', (q) => q.kind === 'pendulum' && (q.bobRadius = v))} />
          <RangeRow label="Amplitude" value={toDeg(o.amplitude)} min={5} max={80} step={1} digits={0} unit="°" onChange={(v) => set('amp', (q) => q.kind === 'pendulum' && (q.amplitude = toRad(v)))} />
          <RangeRow label="Period" tip={`A real pendulum of this length swings at 2π√(L/g) = ${natural.toFixed(2)} s; the simulator uses the period you set.`} value={o.period} min={1} max={5} step={0.1} unit="s" onChange={(v) => set('T', (q) => q.kind === 'pendulum' && (q.period = v))} />
          <Button small onClick={() => set('T', (q) => q.kind === 'pendulum' && (q.period = round(natural, 2)))}>Use the natural period ({natural.toFixed(2)} s)</Button>
          <RangeRow label="Phase" value={toDeg(o.phase)} min={0} max={360} step={5} digits={0} unit="°" onChange={(v) => set('ph', (q) => q.kind === 'pendulum' && (q.phase = toRad(v)))} />
          <RangeRow label="Swing direction" value={wrapDeg(toDeg(o.swingYaw))} min={-180} max={180} step={5} digits={0} unit="°" onChange={(v) => set('sy', (q) => q.kind === 'pendulum' && (q.swingYaw = toRad(v)))} />
        </>
      );
      break;
    }
    case 'slider':
      title = `Sliding panel ${o.id}`;
      body = (
        <>
          <XY x={a.x} y={a.y} onX={(v) => setXY('x', v)} onY={(v) => setXY('y', v)} z={o.center.z} zLabel="centre z (m)" zMax={arena.sz} onZ={(v) => set('z', (q) => q.kind === 'slider' && (q.center.z = v))} />
          <SizeRow size={o.size} onSize={(k, v) => set(`s${k}`, (q) => q.kind === 'slider' && (q.size[k] = v))} />
          <RangeRow label="Travel direction" tip="The panel slides along its length axis." value={wrapDeg(toDeg(o.yaw))} min={-180} max={180} step={5} digits={0} unit="°" onChange={(v) => set('yaw', (q) => q.kind === 'slider' && (q.yaw = toRad(v)))} />
          <RangeRow label="Travel (±)" value={o.travel} min={0.05} max={1.5} step={0.05} unit="m" onChange={(v) => set('tr', (q) => q.kind === 'slider' && (q.travel = v))} />
          <RangeRow label="Period" value={o.period} min={1} max={6} step={0.1} unit="s" onChange={(v) => set('T', (q) => q.kind === 'slider' && (q.period = v))} />
          <RangeRow label="Phase" value={toDeg(o.phase)} min={0} max={360} step={5} digits={0} unit="°" onChange={(v) => set('ph', (q) => q.kind === 'slider' && (q.phase = toRad(v)))} />
        </>
      );
      break;
  }
  return (
    <Card title={title} right={<Badge tone={o.kind === 'pendulum' || o.kind === 'slider' ? 'rose' : 'amber'}>{o.kind === 'pendulum' || o.kind === 'slider' ? 'dynamic' : 'static'}</Badge>}>
      <div className="space-y-2.5">
        {body}
        <div className="flex gap-1 border-t border-slate-200 pt-2 dark:border-slate-800">
          <Button small kind="ghost" onClick={() => onAction('duplicate')} title="Duplicate (Ctrl+D)">
            Duplicate
          </Button>
          <Button small kind="danger" className="ml-auto" onClick={() => onAction('delete')} title="Delete (Delete)">
            Delete
          </Button>
        </div>
      </div>
    </Card>
  );
}

function ViaInspector({ course, s, arena, edit, onDelete }: { course: Course; s: Extract<Sel, { t: 'via' }>; arena: ArenaConfig; edit: Edit; onDelete: () => void }) {
  const v = course.via?.[s.i];
  const p = v?.points[s.k];
  if (!v || !p) return null;
  const set = (k: 'x' | 'y' | 'z', val: number) => edit((c) => c.via && (c.via[s.i].points[s.k][k] = val), `via${s.i}.${s.k}.${k}`);
  return (
    <Card title={`Via point ${s.k + 1} after visit ${v.after + 1}`} right={<Badge>racing line</Badge>}>
      <div className="space-y-2">
        <p className="text-[11px] leading-snug text-slate-600 dark:text-slate-400">An extra waypoint the racing line passes between visit {v.after + 1} and the next one (used for split-S loops and long turns).</p>
        <XY x={p.x} y={p.y} onX={(val) => set('x', val)} onY={(val) => set('y', val)} z={p.z} zMin={ARENA_MARGIN} zMax={arena.sz - ARENA_MARGIN} onZ={(val) => set('z', val)} />
        <Button small kind="danger" onClick={onDelete}>
          Delete via point
        </Button>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// Sequence and course settings
// ---------------------------------------------------------------------------------------------

function SequencePanel({ course, sel, edit, setSel, onAddVia }: { course: Course; sel: Sel; edit: Edit; setSel: (s: Sel) => void; onAddVia: (k: number) => void }) {
  const [pick, setPick] = useState(0);
  const gi = clamp(pick, 0, Math.max(0, course.gates.length - 1));
  const n = course.sequence.length;
  const viaCount = (k: number) => (course.via ?? []).filter((v) => v.after === k).reduce((s, v) => s + v.points.length, 0);
  const totalVia = (course.via ?? []).reduce((s, v) => s + v.points.length, 0);
  return (
    <Card title="Gate sequence" right={<Badge tone="sky">{n} visits</Badge>}>
      <div className="space-y-2">
        {n === 0 && <p className="text-[11px] text-slate-500">No visits yet: place a gate or add a visit below.</p>}
        <ol className="space-y-0.5">
          {course.sequence.map((v, k) => {
            const g = course.gates[v.gate];
            const on = sel?.t === 'gate' && sel.i === v.gate;
            const vc = viaCount(k);
            return (
              <li key={k} className={cx('flex items-center gap-1 rounded px-1 py-0.5 text-[11px]', on ? 'bg-sky-100 dark:bg-sky-500/15' : 'hover:bg-slate-100 dark:hover:bg-slate-800/60')}>
                <span className="tabular w-5 shrink-0 text-right font-mono text-slate-500">{k + 1}</span>
                <button className="flex min-w-0 flex-1 items-center gap-1.5 text-left" onClick={() => setSel({ t: 'gate', i: v.gate })} title="Select this gate">
                  <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: g?.color ?? '#888' }} />
                  <span className="font-medium">{g?.id ?? '?'}</span>
                  {vc > 0 && <span className="truncate text-[10px] text-slate-500">+{vc} via</span>}
                </button>
                <MiniBtn active={!!v.reverse} onClick={() => edit((c) => toggleReverse(c, k))} title="Pass direction: along the gate's arrow (fwd) or against it (rev)">
                  {v.reverse ? '← rev' : '→ fwd'}
                </MiniBtn>
                <MiniBtn onClick={() => onAddVia(k)} title="Add a via point after this visit (extra racing-line waypoint)">
                  +via
                </MiniBtn>
                <MiniBtn disabled={k === 0} onClick={() => edit((c) => moveVisit(c, k, -1))} title="Move up">
                  ▲
                </MiniBtn>
                <MiniBtn disabled={k === n - 1} onClick={() => edit((c) => moveVisit(c, k, 1))} title="Move down">
                  ▼
                </MiniBtn>
                <MiniBtn danger onClick={() => edit((c) => removeVisit(c, k))} title="Remove this visit (the gate stays)">
                  ✕
                </MiniBtn>
              </li>
            );
          })}
        </ol>
        {course.gates.length > 0 && (
          <div className="flex items-center gap-1">
            <select className="min-w-0 flex-1 rounded border border-slate-300 bg-white px-1.5 py-0.5 text-[11px] dark:border-slate-700 dark:bg-slate-900" value={gi} onChange={(e) => setPick(Number(e.target.value))}>
              {course.gates.map((g, i) => (
                <option key={i} value={i}>
                  {g.id}
                </option>
              ))}
            </select>
            <Button small onClick={() => edit((c) => addVisit(c, gi))} title="Append a visit (a gate may be passed more than once)">
              + Visit
            </Button>
            <Button small onClick={() => edit((c) => addVisit(c, gi, true))} title="Append a visit against the gate's direction">
              + Reverse
            </Button>
          </div>
        )}
        <div className="flex items-center gap-3 border-t border-slate-200 pt-2 dark:border-slate-800">
          <Toggle label="Closed loop" tip="Closed circuits loop back from the last gate to the first; open courses end after the last gate." value={course.closed} onChange={(v) => edit((c) => (c.closed = v))} />
          {totalVia > 0 && (
            <button className="ml-auto text-[10px] text-slate-500 underline hover:text-rose-600" onClick={() => edit((c) => delete c.via)} title="Remove every via point">
              clear {totalVia} via point{totalVia === 1 ? '' : 's'}
            </button>
          )}
        </div>
        <Slider label="Laps" tip="Laps of a closed circuit (written to the scenario on Apply)." value={course.laps} min={1} max={5} step={1} disabled={!course.closed} onChange={(v) => edit((c) => (c.laps = v), 'laps')} />
        {course.droneSequences && (
          <div className="rounded border border-amber-300 bg-amber-50 p-1.5 text-[10px] text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
            Per-drone sequences (merge course): {course.droneSequences.map((s, d) => `drone ${d + 1}: ${s.map((v) => course.gates[v.gate]?.id).join('→')}`).join(' · ')}.{' '}
            <button className="underline" onClick={() => edit((c) => delete c.droneSequences)}>
              Use the shared sequence instead
            </button>
          </div>
        )}
      </div>
    </Card>
  );
}

function CoursePanel({ course, edit, speed, setSpeed, arena, cfgArena }: { course: Course; edit: Edit; speed: number; setSpeed: (v: number) => void; arena: ArenaConfig; cfgArena: ArenaConfig }) {
  return (
    <Card title="Course">
      <div className="space-y-2.5">
        <Field label="Name">
          <input className="w-full rounded border border-slate-300 bg-white px-1.5 py-0.5 text-xs dark:border-slate-700 dark:bg-slate-900" value={course.name} onChange={(e) => edit((c) => (c.name = e.target.value), 'name')} />
        </Field>
        <Field label="Description">
          <textarea rows={2} className="w-full resize-y rounded border border-slate-300 bg-white px-1.5 py-0.5 text-[11px] dark:border-slate-700 dark:bg-slate-900" value={course.description} onChange={(e) => edit((c) => (c.description = e.target.value), 'desc')} />
        </Field>
        <Slider label="Target speed" tip="Speed the racing line is timed for; validation checks the turns against the thrust and tilt limits at this speed. Apply writes it to the scenario." value={speed} min={0.5} max={3.5} step={0.1} format={(v) => `${v.toFixed(1)} m/s`} onChange={setSpeed} />
        <Slider label="Difficulty" value={course.difficulty} min={1} max={5} step={1} format={(v) => '★'.repeat(v)} onChange={(v) => edit((c) => (c.difficulty = v), 'diff')} />
        <div>
          <div className="mb-1 flex items-center text-[11px] text-slate-600 dark:text-slate-400">
            Recommended arena
            <InfoDot text="The race uses the larger of this and the arena configured in the sidebar, so the plan shows that effective size." />
          </div>
          <div className="grid grid-cols-3 gap-1.5">
            {(['sx', 'sy', 'sz'] as const).map((k) => (
              <Field key={k} label={k === 'sx' ? 'x (m)' : k === 'sy' ? 'y (m)' : 'height (m)'}>
                <NumBox value={course.arena[k]} min={k === 'sz' ? 2 : 3} max={20} step={0.5} digits={1} onChange={(v) => edit((c) => (c.arena[k] = v), `arena.${k}`)} />
              </Field>
            ))}
          </div>
          <p className="mt-1 text-[10px] text-slate-500">
            Effective {arena.sx} × {arena.sy} × {arena.sz} m (configured {cfgArena.sx} × {cfgArena.sy} × {cfgArena.sz} m).
          </p>
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// Validation strip
// ---------------------------------------------------------------------------------------------

const LEVEL_ORDER = { error: 0, warn: 1, info: 2 } as const;

function ValidationPanel({ issues, line, pending, onPick }: { issues: Issue[]; line: LineReport | null; pending: boolean; onPick: (s: Sel) => void }) {
  const all = [...issues, ...(line?.issues ?? [])].sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);
  const ne = all.filter((i) => i.level === 'error').length;
  const nw = all.filter((i) => i.level === 'warn').length;
  const scale = line?.scale ?? NaN;
  return (
    <div className="flex h-44 shrink-0 border-t border-slate-300 bg-white/85 dark:border-slate-800 dark:bg-slate-900/70">
      <div className="grid w-72 shrink-0 grid-cols-2 content-start gap-1.5 border-r border-slate-200 p-2 dark:border-slate-800">
        <Stat label="Line length" value={fmt(line?.length, 1)} unit="m" tip="Length of the racing line over one lap (closed) or the whole course (open)." />
        <Stat label="Lap time" value={fmt(line?.duration, 1)} unit="s" tip="Duration of the min-jerk racing line after the feasibility time-scaling." />
        <Stat label="Time-scale" value={Number.isFinite(scale) ? `×${scale.toFixed(2)}` : '–'} tone={!Number.isFinite(scale) ? undefined : scale > 1.25 ? 'bad' : scale > 1 ? 'warn' : 'good'} tip="How much the line had to be slowed to respect the thrust and tilt limits; above 1 means the turns are impossible at the chosen speed." />
        <Stat label="Feasible speed" value={line && Number.isFinite(scale) ? (line.speed / scale).toFixed(2) : '–'} unit="m/s" tip="Chosen speed divided by the time-scale." />
        <Stat label="Line collisions" value={line?.error ? '–' : (line?.collisions ?? '–')} tone={line && !line.error ? (line.collisions > 0 ? 'bad' : 'good') : undefined} tip="Samples of the final racing line still touching an obstacle or a gate frame after the A* detours." />
        <Stat label="A* detours" value={line?.error ? '–' : (line?.searchPaths.length ?? '–')} tip="Detours the voxel A* search inserted around obstacles (dashed on the plan)." />
      </div>
      <div className="thin-scroll min-w-0 flex-1 overflow-y-auto p-2">
        <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-slate-700 dark:text-slate-300">
          Validation
          {ne > 0 && <Badge tone="rose">{ne} error{ne === 1 ? '' : 's'}</Badge>}
          {nw > 0 && <Badge tone="amber">{nw} warning{nw === 1 ? '' : 's'}</Badge>}
          {!ne && !nw && !pending && <Badge tone="emerald">flyable</Badge>}
          {pending && <span className="text-[10px] font-normal text-slate-500 italic">checking…</span>}
        </div>
        <ul className="space-y-0.5">
          {all.map((it, k) => (
            <li key={k}>
              <button disabled={!it.sel} onClick={() => onPick(it.sel ?? null)} className={cx('flex w-full items-start gap-1.5 rounded px-1 py-0.5 text-left text-[11px] leading-snug', it.sel ? 'hover:bg-slate-100 dark:hover:bg-slate-800' : 'cursor-default')}>
                <span className={cx('mt-1 h-2 w-2 shrink-0 rounded-full', it.level === 'error' ? 'bg-rose-500' : it.level === 'warn' ? 'bg-amber-500' : 'bg-sky-500')} />
                <span className={cx(it.level === 'error' ? 'text-rose-700 dark:text-rose-300' : it.level === 'warn' ? 'text-amber-800 dark:text-amber-200' : 'text-slate-600 dark:text-slate-400')}>{it.text}</span>
              </button>
            </li>
          ))}
          {!all.length && !pending && <li className="text-[11px] text-slate-500">No problems found: gates clear of the walls and each other, pass corridors free, racing line collision-free at the chosen speed.</li>}
        </ul>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------------------------

interface Drag {
  mode: 'move' | 'rotate' | 'diameter';
  sel: Sel;
  dx: number;
  dy: number;
  start: P2;
  moved: boolean;
  key: string;
}

const TEMPLATES = COURSE_INFO.filter((c) => c.id !== 'C12');

export function CourseEditor() {
  const config = useStore((s) => s.config);
  const setConfig = useStore((s) => s.setConfig);
  const setEditorOpen = useStore((s) => s.setEditorOpen);
  const toast = useStore((s) => s.toast);

  const [course, setCourse] = useState<Course>(() => initialCourse(useStore.getState().config));
  const courseRef = useRef(course);
  const hist = useRef({ past: [] as Course[], future: [] as Course[], key: '', t: 0 });
  const [dirty, setDirty] = useState(false);
  const [sel, setSel] = useState<Sel>(null);
  const [tool, setTool] = useState<Tool>('select');
  const [speed, setSpeedState] = useState(() => useStore.getState().config.scenario.targetSpeed);
  const [notice, setNotice] = useState<{ text: string; kind: 'info' | 'success' | 'error' } | null>(null);

  const ca = config.arena;
  // keyed on the numbers, not the objects: every edit clones the course
  const { sx: asx, sy: asy, sz: asz } = effectiveArena(ca, course);
  const arena = useMemo<ArenaConfig>(() => ({ sx: asx, sy: asy, sz: asz }), [asx, asy, asz]);
  const eta = config.system.eta;
  const thetaMax = config.system.thetaMaxDeg;
  // the race times the line for the weakest drone, so the editor's verdict matches the run
  const twr = raceTwr(config);

  // ---- edits with undo (typing and drags coalesce into one undo step)
  const commit = useCallback((next: Course, key = '') => {
    const h = hist.current;
    const now = performance.now();
    const same = key !== '' && key === h.key && (key.startsWith('drag') || now - h.t < 900);
    if (!same) {
      h.past.push(courseRef.current);
      if (h.past.length > 200) h.past.shift();
    }
    h.future = [];
    h.key = key;
    h.t = now;
    courseRef.current = next;
    setCourse(next);
    setDirty(true);
  }, []);
  const edit = useCallback<Edit>(
    (fn, key = '') => {
      const next = cloneCourse(courseRef.current);
      fn(next);
      commit(next, key);
    },
    [commit],
  );
  const travel = useCallback((from: 'past' | 'future') => {
    const h = hist.current;
    const to = from === 'past' ? 'future' : 'past';
    const c = h[from].pop();
    if (!c) return;
    h[to].push(courseRef.current);
    h.key = '';
    courseRef.current = c;
    setCourse(c);
    setDirty(true);
    setSel((s) => selValid(c, s));
  }, []);
  const undo = useCallback(() => travel('past'), [travel]);
  const redo = useCallback(() => travel('future'), [travel]);
  const setSpeed = (v: number) => {
    setSpeedState(v);
    setDirty(true);
  };

  useEffect(() => {
    if (!notice) return;
    const h = window.setTimeout(() => setNotice(null), notice.kind === 'error' ? 8000 : 4500);
    return () => window.clearTimeout(h);
  }, [notice]);

  // ---- live validation on a short debounce, in a worker: a healthy course takes 10-150 ms, but a
  // broken one (gate through the net, blocked corridor) sends the racing line into seconds of A*
  const [checks, setChecks] = useState<{ issues: Issue[]; line: LineReport | null; course: Course; speed: number } | null>(null);
  const [pending, setPending] = useState(true);
  const checker = useMemo(() => new CourseChecker(() => new Worker(new URL('../../workers/courseCheck.worker.ts', import.meta.url), { type: 'module' })), []);
  useEffect(() => () => checker.dispose(), [checker]);
  useEffect(() => {
    setPending(true);
    let live = true;
    const h = window.setTimeout(() => {
      checker.check(course, { speed, eta, thetaMaxDeg: thetaMax, arena, twr }).then(
        (r) => {
          if (!live || !r) return;
          setChecks({ ...r, course, speed });
          setPending(false);
        },
        (e: unknown) => {
          if (!live) return;
          setChecks({ issues: [{ level: 'error', text: `Validation failed: ${e instanceof Error ? e.message : String(e)}` }], line: null, course, speed });
          setPending(false);
        },
      );
    }, 300);
    return () => {
      live = false;
      window.clearTimeout(h);
      // a check of the previous version is no longer wanted: stop it instead of letting it finish
      checker.cancel();
    };
  }, [checker, course, arena, speed, eta, thetaMax, twr]);
  /** The last result describes exactly what is on screen (not an earlier version of the course). */
  const checksCurrent = !pending && !!checks && checks.course === course && checks.speed === speed;
  const flagged = useMemo(() => new Set((checks?.issues ?? []).filter((i) => i.level !== 'info' && i.sel).map((i) => selKey(i.sel ?? null))), [checks]);

  // ---- actions
  const close = useCallback(() => setEditorOpen(false), [setEditorOpen]);
  const requestClose = () => {
    if (dirty && !window.confirm('Close the course editor and discard your changes?')) return;
    close();
  };
  const apply = () => {
    const c = cloneCourse(courseRef.current);
    c.id = 'C12';
    c.targetSpeed = speed;
    // count errors from the live result when it is current; if a check is still running, re-run
    // only the fast geometry part here (the racing line can take seconds on a broken course)
    let errors = 0;
    if (checksCurrent && checks) errors = [...checks.issues, ...(checks.line?.issues ?? [])].filter((i) => i.level === 'error').length;
    else {
      try {
        errors = checkCourse(c, arena).filter((i) => i.level === 'error').length;
      } catch {
        errors = 1;
      }
    }
    setConfig((cfg) => {
      cfg.course.custom = c;
      cfg.course.courseId = 'C12';
      cfg.scenario.type = 'ringCircuit';
      cfg.scenario.targetSpeed = speed;
      if (c.closed) cfg.scenario.laps = c.laps;
      cfg.scenario.preset = '';
    });
    toast(errors ? `Custom course applied with ${errors} validation error${errors === 1 ? '' : 's'}; the validator may block the run.` : `Custom course C12 applied: ${c.gates.length} gates, ${c.obstacles.length} obstacles, ${speed.toFixed(1)} m/s.`, errors ? 'warning' : 'success');
    close();
  };
  const removeSel = (s: Sel) => {
    if (!s) return;
    edit((c) => deleteSel(c, s));
    setSel(null);
  };
  const duplicate = () => {
    const c = cloneCourse(courseRef.current);
    const ns = duplicateSel(c, sel, arena);
    if (!ns) return;
    commit(c);
    setSel(ns);
  };
  const addVia = (k: number) => {
    const c = cloneCourse(courseRef.current);
    const ns = addViaAfter(c, k);
    if (!ns) return;
    commit(c);
    setSel(ns);
  };
  const loadTemplate = (id: CourseId | 'default') => {
    const c = templateCourse(id, config);
    commit(c);
    setSel(null);
    setSpeedState(c.targetSpeed);
    setNotice({ text: `Started from ${c.name.replace(/^C12 Custom \(from (.*)\)$/, '$1')} (recommended ${c.targetSpeed.toFixed(1)} m/s). Undo with Ctrl+Z.`, kind: 'info' });
  };
  const saveJson = () => {
    const c = { ...cloneCourse(courseRef.current), id: 'C12', targetSpeed: speed };
    download(`${slug(c.name)}.course.json`, JSON.stringify(c, null, 2), 'application/json');
    setNotice({ text: 'Course saved as JSON.', kind: 'success' });
  };
  const fileRef = useRef<HTMLInputElement>(null);
  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    try {
      const r = parseCourseJson(await f.text());
      if ('error' in r) {
        setNotice({ text: `Could not load ${f.name}: ${r.error}`, kind: 'error' });
        return;
      }
      commit(r.course);
      setSel(null);
      setSpeedState(r.course.targetSpeed);
      setNotice({ text: `Loaded ${f.name}: ${r.course.gates.length} gates, ${r.course.obstacles.length} obstacles${r.notes.length ? ` (${r.notes.join('; ')})` : ''}.`, kind: 'success' });
    } catch (err) {
      setNotice({ text: `Could not read ${f.name}: ${err instanceof Error ? err.message : String(err)}`, kind: 'error' });
    }
  };
  const exportPng = () => {
    try {
      // the racing line is only drawn when it belongs to this exact version of the course
      const line = checksCurrent ? checks?.line?.samples : undefined;
      const name = courseRef.current.name;
      const canvas = drawFloorPlan(courseRef.current, arena, { line, speed });
      canvas.toBlob((b) => {
        if (b) download(`${slug(name)}-floor-plan.png`, b, 'image/png');
        else setNotice({ text: 'Floor plan export failed: the browser could not encode the PNG.', kind: 'error' });
      }, 'image/png');
      setNotice({ text: `Floor plan exported (PNG, ${canvas.width} × ${canvas.height} px)${checksCurrent ? '' : '; the racing line is left out while it is still being checked'}.`, kind: 'success' });
    } catch (err) {
      setNotice({ text: `Floor plan export failed: ${err instanceof Error ? err.message : String(err)}`, kind: 'error' });
    }
  };

  // ---- plan pointer handling
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<Drag | null>(null);
  const dragSeq = useRef(0);
  const hoverSet = useRef<((p: P2 | null) => void) | null>(null);
  const coordRef = useRef<HTMLSpanElement>(null);
  const toWorld = (e: { clientX: number; clientY: number }): P2 | null => {
    const m = svgRef.current?.getScreenCTM();
    if (!m) return null;
    const q = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    return { x: q.x / S, y: -q.y / S };
  };
  const inArena = (x: number, y: number): P2 => ({ x: clamp(x, -arena.sx / 2, arena.sx / 2), y: clamp(y, -arena.sy / 2, arena.sy / 2) });

  const onItemDown = useEvent((s: Sel, e: RPointerEvent) => {
    if (e.button !== 0) return;
    // placing tools drop new items on top of existing ones: let the plan handle the click
    if (tool !== 'select' && tool !== 'delete') return;
    e.stopPropagation();
    if (tool === 'delete') {
      removeSel(s);
      return;
    }
    setSel(s);
    const p = toWorld(e);
    const a = selAnchor(courseRef.current, s);
    if (!p || !a) return;
    drag.current = { mode: 'move', sel: s, dx: p.x - a.x, dy: p.y - a.y, start: p, moved: false, key: `drag${++dragSeq.current}` };
    svgRef.current?.setPointerCapture(e.pointerId);
  });
  const onHandleDown = useEvent((mode: 'rotate' | 'diameter', e: RPointerEvent) => {
    if (e.button !== 0 || !sel) return;
    e.stopPropagation();
    const p = toWorld(e);
    if (!p) return;
    drag.current = { mode, sel, dx: 0, dy: 0, start: p, moved: false, key: `drag${++dragSeq.current}` };
    svgRef.current?.setPointerCapture(e.pointerId);
  });
  const onPlanDown = (e: RPointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    const p = toWorld(e);
    if (!p) return;
    if (tool === 'select' || tool === 'delete') {
      setSel(null);
      return;
    }
    const x = snap(p.x);
    const y = snap(p.y);
    // clicks in the margin around the plan place nothing (the ghost is hidden there too)
    if (Math.abs(x) > arena.sx / 2 || Math.abs(y) > arena.sy / 2) return;
    const c = cloneCourse(courseRef.current);
    const ns: Sel = tool === 'gate' || tool === 'hanging' ? { t: 'gate', i: addGate(c, x, y, tool === 'gate' ? 'stand' : 'hanging') } : { t: 'obs', i: addObstacle(c, tool, x, y, arena) };
    commit(c);
    setSel(ns);
    if (!e.shiftKey) setTool('select');
  };
  const onPlanMove = (e: RPointerEvent<SVGSVGElement>) => {
    const p = toWorld(e);
    if (!p) return;
    if (coordRef.current) coordRef.current.textContent = `x ${fm(p.x)}  y ${fm(p.y)} m`;
    hoverSet.current?.(p);
    const d = drag.current;
    if (!d) return;
    if (!d.moved && Math.hypot(p.x - d.start.x, p.y - d.start.y) < 0.03) return;
    d.moved = true;
    const c0 = courseRef.current;
    const free = e.altKey;
    if (d.mode === 'move') {
      const q = inArena(free ? round(p.x - d.dx, 2) : snap(p.x - d.dx), free ? round(p.y - d.dy, 2) : snap(p.y - d.dy));
      const a = selAnchor(c0, d.sel);
      if (a && a.x === q.x && a.y === q.y) return;
      edit((c) => setSelAnchor(c, d.sel, q.x, q.y), d.key);
    } else if (d.mode === 'rotate') {
      const a = selAnchor(c0, d.sel);
      if (!a) return;
      const deg = toDeg(Math.atan2(p.y - a.y, p.x - a.x));
      const yaw = toRad(wrapDeg(free ? Math.round(deg) : snap(deg, e.shiftKey ? 15 : 5)));
      if (Math.abs((selYaw(c0, d.sel) ?? NaN) - yaw) < 1e-9) return;
      edit((c) => setSelYaw(c, d.sel, yaw), d.key);
    } else if (d.sel?.t === 'gate') {
      const gi = d.sel.i;
      const g = c0.gates[gi];
      if (!g) return;
      const half = Math.abs(-(p.x - g.center.x) * Math.sin(g.yaw) + (p.y - g.center.y) * Math.cos(g.yaw));
      const D = clamp(free ? round(2 * half, 2) : snap(2 * half, 0.05), DIAMETER_RANGE[0], DIAMETER_RANGE[1]);
      if (D === g.diameter) return;
      edit((c) => (c.gates[gi].diameter = D), d.key);
    }
  };
  const endDrag = (e: RPointerEvent<SVGSVGElement>) => {
    drag.current = null;
    if (svgRef.current?.hasPointerCapture(e.pointerId)) svgRef.current.releasePointerCapture(e.pointerId);
  };

  // ---- keyboard: captured at the window so the app's global shortcuts stay quiet under the editor
  const onKey = useEvent((e: KeyboardEvent) => {
    const el = e.target as HTMLElement | null;
    const typing = !!el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (typing) el?.blur();
      else if (tool !== 'select') setTool('select');
      else requestClose();
      return;
    }
    if (typing) return;
    e.stopPropagation();
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && k === 'z') {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
      return;
    }
    if (mod && k === 'y') {
      e.preventDefault();
      redo();
      return;
    }
    if (mod && k === 'd') {
      e.preventDefault();
      duplicate();
      return;
    }
    if (mod || e.altKey) return;
    const nudge = (dx: number, dy: number) => {
      const a = selAnchor(courseRef.current, sel);
      if (!a || !sel) return;
      const q = inArena(round(a.x + dx, 3), round(a.y + dy, 3));
      edit((c) => setSelAnchor(c, sel, q.x, q.y), `nudge${selKey(sel)}`);
    };
    const turn = (deg: number) => {
      const y = selYaw(courseRef.current, sel);
      if (y === null || !sel) return;
      edit((c) => setSelYaw(c, sel, toRad(wrapDeg(round(toDeg(y) + deg, 3)))), `turn${selKey(sel)}`);
    };
    const step = e.shiftKey ? 0.5 : SNAP;
    switch (e.key) {
      case 'Delete':
      case 'Backspace':
        e.preventDefault();
        removeSel(sel);
        return;
      case 'ArrowLeft':
        e.preventDefault();
        nudge(-step, 0);
        return;
      case 'ArrowRight':
        e.preventDefault();
        nudge(step, 0);
        return;
      case 'ArrowUp':
        e.preventDefault();
        nudge(0, step);
        return;
      case 'ArrowDown':
        e.preventDefault();
        nudge(0, -step);
        return;
      case '[':
        turn(15);
        return;
      case ']':
        turn(-15);
        return;
      case '{':
        turn(1);
        return;
      case '}':
        turn(-1);
        return;
      case 'e':
      case 'E':
        requestClose();
        return;
    }
    const t = TOOLS.find((x) => x.key.toLowerCase() === k);
    if (t) setTool(t.id);
  });
  useEffect(() => {
    const h = (e: KeyboardEvent) => onKey(e);
    window.addEventListener('keydown', h, true);
    return () => window.removeEventListener('keydown', h, true);
  }, [onKey]);

  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => rootRef.current?.focus(), []);

  // ---- render
  const h = hist.current;
  const pad = 48;
  const viewBox = `${PX(-arena.sx / 2) - pad} ${PY(arena.sy / 2) - pad} ${arena.sx * S + 2 * pad} ${arena.sy * S + 2 * pad}`;
  const line = checks?.line ?? null;
  const validSel = selValid(course, sel);
  let inspector: ReactNode;
  if (validSel?.t === 'gate') {
    const i = validSel.i;
    inspector = (
      <GateInspector
        g={course.gates[i]}
        i={i}
        course={course}
        arena={arena}
        edit={edit}
        onAction={(a) => {
          if (a === 'delete') removeSel(validSel);
          else if (a === 'duplicate') duplicate();
          else edit((c) => addVisit(c, i, a === 'reverseVisit'));
        }}
      />
    );
  } else if (validSel?.t === 'obs') {
    inspector = <ObstacleInspector o={course.obstacles[validSel.i]} i={validSel.i} arena={arena} edit={edit} onAction={(a) => (a === 'delete' ? removeSel(validSel) : duplicate())} />;
  } else if (validSel?.t === 'via') {
    inspector = <ViaInspector course={course} s={validSel} arena={arena} edit={edit} onDelete={() => removeSel(validSel)} />;
  } else {
    inspector = (
      <Card title="Inspector">
        <p className="text-[11px] leading-relaxed text-slate-600 dark:text-slate-400">
          Click an item on the plan to edit it. Place gates and obstacles with the toolbar (keys {TOOLS.map((t) => t.key).join(' ')}); gates join the sequence in the order you place them. Arrows on the plan show the pass direction, badges the sequence number(s).
        </p>
      </Card>
    );
  }

  return (
    <div ref={rootRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Course editor" className="fixed inset-0 z-50 flex flex-col bg-slate-100 text-slate-900 outline-none dark:bg-slate-950 dark:text-slate-100">
      {/* ---------------- toolbar */}
      <header className="flex flex-wrap items-center gap-2 border-b border-slate-300 bg-white/90 px-3 py-1.5 dark:border-slate-800 dark:bg-slate-900/90">
        <div className="mr-1 min-w-0">
          <div className="text-sm font-semibold">Course editor</div>
          <div className="max-w-56 truncate text-[10px] text-slate-500" title={course.name}>
            {course.name}
            {dirty ? ' · edited' : ''}
          </div>
        </div>
        <div role="toolbar" aria-label="Tools" className="flex flex-wrap items-center gap-0.5 rounded-md border border-slate-300 bg-slate-100 p-0.5 dark:border-slate-700 dark:bg-slate-900">
          {TOOLS.map((t) => (
            <button
              key={t.id}
              title={`${t.label} (${t.key}): ${t.tip}`}
              onClick={() => setTool(t.id)}
              className={cx(
                'flex items-center gap-1 rounded px-1.5 py-1 text-[11px] font-medium transition-colors',
                tool === t.id ? (t.id === 'delete' ? 'bg-rose-600 text-white' : 'bg-sky-600 text-white') : 'text-slate-600 hover:bg-white hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-white',
              )}
            >
              {t.icon}
              <span className="hidden lg:inline">{t.label}</span>
            </button>
          ))}
        </div>
        <div className="flex items-center gap-0.5">
          <Button small kind="ghost" onClick={undo} disabled={!h.past.length} title="Undo (Ctrl+Z)">
            ↶ Undo
          </Button>
          <Button small kind="ghost" onClick={redo} disabled={!h.future.length} title="Redo (Ctrl+Shift+Z)">
            ↷ Redo
          </Button>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <select
            className="rounded border border-slate-300 bg-white px-1.5 py-1 text-[11px] dark:border-slate-700 dark:bg-slate-900"
            value=""
            title="Replace the course with a preset as a starting point (undo restores it)"
            onChange={(e) => {
              if (e.target.value) loadTemplate(e.target.value as CourseId | 'default');
            }}
          >
            <option value="">Reset to template…</option>
            {TEMPLATES.map((c) => (
              <option key={c.id} value={c.id}>
                {c.id} {c.name} {'★'.repeat(c.difficulty)}
              </option>
            ))}
            <option value="default">Default C12 layout</option>
          </select>
          <Button small onClick={() => fileRef.current?.click()} title="Load a course saved as JSON">
            Load JSON
          </Button>
          <Button small onClick={saveJson} title="Download the course as JSON">
            Save JSON
          </Button>
          <Button small onClick={exportPng} title="Printable floor plan with dimensions, gate coordinates and heights (PNG)">
            Floor plan PNG
          </Button>
          <input ref={fileRef} type="file" accept=".json,application/json" className="hidden" onChange={onFile} />
          <span className="mx-1 h-5 w-px bg-slate-300 dark:bg-slate-700" />
          <Button small kind="ghost" onClick={requestClose} title="Close without applying (Esc)">
            Cancel
          </Button>
          <Button small kind="primary" onClick={apply} title="Use this course as C12 in the ring-course scenario">
            Apply
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* ---------------- plan */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="relative min-h-0 flex-1 bg-slate-200/60 dark:bg-slate-950">
            <svg
              ref={svgRef}
              viewBox={viewBox}
              preserveAspectRatio="xMidYMid meet"
              className={cx('absolute inset-0 h-full w-full touch-none select-none', tool !== 'select' && tool !== 'delete' && 'cursor-crosshair')}
              onPointerDown={onPlanDown}
              onPointerMove={onPlanMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              onPointerLeave={() => hoverSet.current?.(null)}
            >
              <PlanGrid sx={arena.sx} sy={arena.sy} />
              <LineLayer line={line} />
              <PlanItems course={course} sel={validSel} flagged={flagged} tool={tool} onDown={onItemDown} />
              {tool === 'select' && <Handles course={course} sel={validSel} onDown={onHandleDown} />}
              <HoverGhost bind={hoverSet} tool={tool} course={course} arena={arena} />
            </svg>
            <div className="pointer-events-none absolute top-2 left-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded bg-white/85 px-2 py-1 text-[10px] text-slate-600 shadow-sm dark:bg-slate-900/85 dark:text-slate-300">
              <span className="flex items-center gap-1">
                <span className="inline-block h-0.5 w-4 rounded bg-sky-500/70" /> racing line
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block w-4 border-t-2 border-dashed border-violet-500" /> A* search
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block h-1 w-4 rounded bg-rose-500/80" /> too fast at {speed.toFixed(1)} m/s
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block w-4 border-t border-dashed border-rose-400" /> geofence
              </span>
            </div>
            {!course.gates.length && (
              <div className="pointer-events-none absolute inset-x-0 top-1/3 text-center text-sm text-slate-500">
                Pick the <b>Gate</b> tool (G) and click on the plan to place the first gate.
              </div>
            )}
            <div className="pointer-events-none absolute bottom-2 left-2 flex max-w-[calc(100%-1rem)] items-center gap-2 rounded bg-white/85 px-2 py-1 text-[10px] text-slate-600 shadow-sm dark:bg-slate-900/85 dark:text-slate-300">
              <span ref={coordRef} className="tabular font-mono whitespace-nowrap">
                x –  y – m
              </span>
              <span className="truncate">{HINTS[tool]}</span>
            </div>
            {notice && (
              <div
                onClick={() => setNotice(null)}
                className={cx(
                  'absolute right-2 bottom-2 max-w-sm cursor-pointer rounded-md border px-3 py-2 text-xs shadow-lg',
                  notice.kind === 'error' ? 'border-rose-400 bg-rose-50 text-rose-900 dark:bg-rose-950 dark:text-rose-200' : notice.kind === 'success' ? 'border-emerald-400 bg-emerald-50 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200' : 'border-slate-300 bg-white text-slate-800 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200',
                )}
              >
                {notice.text}
              </div>
            )}
          </div>
          <ValidationPanel issues={checks?.issues ?? []} line={line} pending={pending} onPick={(s) => setSel(selValid(courseRef.current, s))} />
        </div>

        {/* ---------------- side panel */}
        <aside className="thin-scroll w-[22rem] shrink-0 space-y-2 overflow-y-auto border-l border-slate-300 bg-slate-50/90 p-2 dark:border-slate-800 dark:bg-slate-950/80">
          {inspector}
          {validSel && (
            <div className="-mt-1 px-1 text-[10px] text-slate-500">
              Selected {selLabel(course, validSel)} · arrows nudge 0.1 m (Shift 0.5 m) · [ ] rotate 15°
            </div>
          )}
          <SequencePanel course={course} sel={validSel} edit={edit} setSel={setSel} onAddVia={addVia} />
          <CoursePanel course={course} edit={edit} speed={speed} setSpeed={setSpeed} arena={arena} cfgArena={ca} />
        </aside>
      </div>
    </div>
  );
}
