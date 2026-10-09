/**
 * Course editor helpers (Section 5.2b): pure course edits that keep the gate sequence, per-drone
 * sequences and via points consistent, the live validation (geometry checks plus the real racing
 * line through the course), JSON loading and the printable floor plan. Everything except
 * `drawFloorPlan` and `CourseChecker` is DOM-free so it can be unit tested. The module doubles as
 * the validation worker's script (see `CourseChecker` and the guarded block after it).
 */
import { ARENA_MARGIN, DRONE_RADIUS, G, PRESETS } from '../../core/constants';
import { CABLE_R, GATE_TUBE_R, LEG_SPAN, POLE_R, gateFrame, gatePrimitives, isDynamic, obstaclePrimitives, pendulumState, sliderState } from '../../core/course';
import { buildCourse, defaultCustomCourse } from '../../core/courseLibrary';
import { dronesFor } from '../../core/defaults';
import { usableThrust } from '../../core/feasibility';
import { distanceToPrimitive, nearBounds, primitiveBounds, type Primitive } from '../../core/geometry';
import { ENTRY_EXIT, buildRacingLine } from '../../core/racingLine';
import type { ArenaConfig, Course, CourseId, Gate, GateVisit, Obstacle, SimConfig } from '../../core/types';
import { v3, type Vec3 } from '../../core/vec';

// ---------------------------------------------------------------------------------------------
// Basics
// ---------------------------------------------------------------------------------------------

/** Same palette as the course library (blue, red, yellow, green, purple...). */
export const GATE_COLORS = ['#3b82f6', '#ef4444', '#eab308', '#22c55e', '#a855f7', '#f97316', '#06b6d4', '#ec4899', '#84cc16', '#f43f5e', '#14b8a6', '#8b5cf6'];
/** Placement grid (m). */
export const SNAP = 0.1;
export const DIAMETER_RANGE: [number, number] = [0.45, 1.2];
export const PITCH_MAX_DEG = 45;
/** Gates closer than this to the net get a warning (geofence 0.3 m plus room to line up). */
export const WALL_CLEARANCE = 0.4;

export type Sel = { t: 'gate'; i: number } | { t: 'obs'; i: number } | { t: 'via'; i: number; k: number } | null;
export type ObstacleTool = 'pillar' | 'box' | 'banner' | 'pendulum' | 'slider';
export type Tool = 'select' | 'gate' | 'hanging' | ObstacleTool | 'delete';
type P2 = { x: number; y: number };

export const toDeg = (r: number): number => (r * 180) / Math.PI;
export const toRad = (d: number): number => (d * Math.PI) / 180;
export const round = (v: number, d = 3): number => Math.round(v * 10 ** d) / 10 ** d;
/** Round to a grid step without floating-point fuzz (0.30000000000000004 -> 0.3). */
export const snap = (v: number, step = SNAP): number => round(Math.round(v / step) * step, 6);
export const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
/** Wrap an angle in degrees to (-180, 180]. */
export function wrapDeg(d: number): number {
  const x = ((((d + 180) % 360) + 360) % 360) - 180;
  return x === -180 ? 180 : x;
}
export const cloneCourse = (c: Course): Course => JSON.parse(JSON.stringify(c)) as Course;
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Thrust-to-weight ratio the race times the racing line with: the weakest drone's preset
 * (race.ts uses the minimum over the drones), so the editor's feasibility verdict matches the run.
 */
export function raceTwr(cfg: SimConfig): number {
  const twr = dronesFor(cfg, Math.max(1, cfg.drones.length)).map((d) => (PRESETS[d.preset] ?? PRESETS.CF21).twr);
  return twr.length ? Math.min(...twr) : PRESETS.CF21.twr;
}

/** The race uses the larger of the configured arena and the course's recommendation. */
export function effectiveArena(a: ArenaConfig, c: Course): ArenaConfig {
  return { sx: Math.max(a.sx, c.arena.sx), sy: Math.max(a.sy, c.arena.sy), sz: Math.max(a.sz, c.arena.sz) };
}

/** Centre-height range of a gate: stands 0.5-1.8 m; hanging gates may go up to the geofence. */
export function heightRange(g: Gate, arena: ArenaConfig): [number, number] {
  if (g.mount === 'stand') return [0.5, 1.8];
  return [0.5, Math.max(1.8, round(arena.sz - ARENA_MARGIN - g.diameter / 2, 2))];
}

/** A copy of a library course re-badged as the custom course C12. */
export function asCustom(c: Course): Course {
  const out = cloneCourse(c);
  if (out.id !== 'C12') out.name = `C12 Custom (from ${c.name})`;
  out.id = 'C12';
  return out;
}

/** Editor starting point: the custom course, else the selected preset, else the default C12. */
export function initialCourse(cfg: SimConfig): Course {
  if (cfg.course.custom) return { ...cloneCourse(cfg.course.custom), id: 'C12' };
  const built = cfg.course.courseId !== 'none' ? buildCourse(cfg.course) : null;
  return built ? asCustom(built) : defaultCustomCourse();
}

export function templateCourse(id: CourseId | 'default', cfg: SimConfig): Course {
  if (id === 'default' || id === 'none' || id === 'C12') return defaultCustomCourse();
  const built = buildCourse({ ...cfg.course, courseId: id, custom: null });
  return built ? asCustom(built) : defaultCustomCourse();
}

export function nextId(prefix: string, used: string[]): string {
  const s = new Set(used);
  let k = 1;
  while (s.has(`${prefix}${k}`)) k++;
  return `${prefix}${k}`;
}

/** Sequence labels per gate: a gate visited twice shows both numbers ("1/4"); '' if unvisited. */
export function gateNumbers(c: Course): string[] {
  const nums: string[][] = c.gates.map(() => []);
  c.sequence.forEach((v, k) => nums[v.gate]?.push(String(k + 1)));
  return nums.map((n) => n.join('/'));
}

/** Which directions each gate is passed in (forward = along its normal). */
export function gateDirections(c: Course): { fwd: boolean; rev: boolean }[] {
  const out = c.gates.map(() => ({ fwd: false, rev: false }));
  for (const seq of [c.sequence, ...(c.droneSequences ?? [])]) {
    for (const v of seq) {
      const d = out[v.gate];
      if (!d) continue;
      if (v.reverse) d.rev = true;
      else d.fwd = true;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Item factories and edits (mutate the course passed in: the editor clones before editing)
// ---------------------------------------------------------------------------------------------

/** Default yaw of a new gate: facing away from the previous gate in the sequence (15 deg steps). */
export function defaultGateYaw(c: Course, x: number, y: number): number {
  const last = c.sequence.length ? c.gates[c.sequence[c.sequence.length - 1].gate] : undefined;
  if (!last || Math.hypot(x - last.center.x, y - last.center.y) < 0.2) return 0;
  return toRad(snap(toDeg(Math.atan2(y - last.center.y, x - last.center.x)), 15));
}

export function makeGate(c: Course, x: number, y: number, mount: Gate['mount']): Gate {
  return {
    id: nextId('G', c.gates.map((g) => g.id)),
    center: v3(x, y, mount === 'stand' ? 1.0 : 1.6),
    yaw: defaultGateYaw(c, x, y),
    pitch: 0,
    diameter: 0.8,
    color: GATE_COLORS[c.gates.length % GATE_COLORS.length],
    mount,
  };
}

/** Add a gate and append a visit of it to the sequence; returns its index. */
export function addGate(c: Course, x: number, y: number, mount: Gate['mount']): number {
  c.gates.push(makeGate(c, x, y, mount));
  const gi = c.gates.length - 1;
  c.sequence.push({ gate: gi });
  return gi;
}

export function makeObstacle(kind: ObstacleTool, x: number, y: number, arena: ArenaConfig, used: string[]): Obstacle {
  switch (kind) {
    case 'pillar':
      return { kind: 'pillar', id: nextId('P', used), x, y, radius: 0.1, height: round(Math.max(0.5, arena.sz - 0.3), 2) };
    case 'box':
      return { kind: 'box', id: nextId('B', used), center: v3(x, y, 0.3), size: v3(0.6, 0.6, 0.6), yaw: 0, label: 'box' };
    case 'banner': {
      // a thin plate hanging from the ceiling truss
      const h = 0.8;
      return { kind: 'box', id: nextId('BN', used), center: v3(x, y, round(arena.sz - h / 2, 2)), size: v3(1.0, 0.03, h), yaw: toRad(90), label: 'banner' };
    }
    case 'pendulum': {
      // pivot on the truss just above the ceiling, bob swinging through ~1.2 m
      const pz = round(arena.sz + 0.05, 2);
      return { kind: 'pendulum', id: nextId('PD', used), pivot: v3(x, y, pz), length: round(pz - 1.2, 2), bobRadius: 0.12, amplitude: toRad(30), period: 2.6, phase: 0, swingYaw: toRad(90) };
    }
    case 'slider':
      // a sliding door: the panel moves along its own long side, across the line
      return { kind: 'slider', id: nextId('S', used), center: v3(x, y, 1.2), size: v3(0.6, 0.06, 0.7), yaw: toRad(90), travel: 0.5, period: 3, phase: 0 };
  }
}

export function addObstacle(c: Course, kind: ObstacleTool, x: number, y: number, arena: ArenaConfig): number {
  c.obstacles.push(makeObstacle(kind, x, y, arena, c.obstacles.map((o) => o.id)));
  return c.obstacles.length - 1;
}

export function obstacleAnchor(o: Obstacle): P2 {
  switch (o.kind) {
    case 'pillar':
      return { x: o.x, y: o.y };
    case 'pendulum':
      return { x: o.pivot.x, y: o.pivot.y };
    default:
      return { x: o.center.x, y: o.center.y };
  }
}

function setObstacleAnchor(o: Obstacle, x: number, y: number): void {
  switch (o.kind) {
    case 'pillar':
      o.x = x;
      o.y = y;
      break;
    case 'pendulum':
      o.pivot.x = x;
      o.pivot.y = y;
      break;
    default:
      o.center.x = x;
      o.center.y = y;
  }
}

export function selValid(c: Course, s: Sel): Sel {
  if (!s) return null;
  if (s.t === 'gate') return c.gates[s.i] ? s : null;
  if (s.t === 'obs') return c.obstacles[s.i] ? s : null;
  return c.via?.[s.i]?.points[s.k] ? s : null;
}

export const selKey = (s: Sel): string => (!s ? '' : s.t === 'via' ? `via${s.i}.${s.k}` : `${s.t}${s.i}`);

export function selLabel(c: Course, s: Sel): string {
  if (!s) return '';
  if (s.t === 'gate') return c.gates[s.i]?.id ?? '';
  if (s.t === 'obs') return c.obstacles[s.i]?.id ?? '';
  return `via point ${s.k + 1} after visit ${(c.via?.[s.i]?.after ?? 0) + 1}`;
}

/** Plan position of a selected item. */
export function selAnchor(c: Course, s: Sel): P2 | null {
  if (!s) return null;
  if (s.t === 'gate') {
    const g = c.gates[s.i];
    return g ? { x: g.center.x, y: g.center.y } : null;
  }
  if (s.t === 'obs') {
    const o = c.obstacles[s.i];
    return o ? obstacleAnchor(o) : null;
  }
  const p = c.via?.[s.i]?.points[s.k];
  return p ? { x: p.x, y: p.y } : null;
}

export function setSelAnchor(c: Course, s: Sel, x: number, y: number): void {
  if (!s) return;
  if (s.t === 'gate') {
    const g = c.gates[s.i];
    if (g) {
      g.center.x = x;
      g.center.y = y;
    }
  } else if (s.t === 'obs') {
    const o = c.obstacles[s.i];
    if (o) setObstacleAnchor(o, x, y);
  } else {
    const p = c.via?.[s.i]?.points[s.k];
    if (p) {
      p.x = x;
      p.y = y;
    }
  }
}

/** Heading (rad) of an item that has one: gate yaw, box / slider yaw, pendulum swing plane. */
export function selYaw(c: Course, s: Sel): number | null {
  if (!s || s.t === 'via') return null;
  if (s.t === 'gate') return c.gates[s.i]?.yaw ?? null;
  const o = c.obstacles[s.i];
  if (!o || o.kind === 'pillar') return null;
  return o.kind === 'pendulum' ? o.swingYaw : o.yaw;
}

export function setSelYaw(c: Course, s: Sel, yaw: number): void {
  if (!s || s.t === 'via') return;
  if (s.t === 'gate') {
    if (c.gates[s.i]) c.gates[s.i].yaw = yaw;
    return;
  }
  const o = c.obstacles[s.i];
  if (!o || o.kind === 'pillar') return;
  if (o.kind === 'pendulum') o.swingYaw = yaw;
  else o.yaw = yaw;
}

/** Remove one visit; via points attached to it go too, later ones shift down. */
export function removeVisit(c: Course, k: number): void {
  c.sequence.splice(k, 1);
  if (c.via) {
    c.via = c.via.filter((v) => v.after !== k).map((v) => ({ ...v, after: v.after > k ? v.after - 1 : v.after }));
    if (!c.via.length) delete c.via;
  }
}

/** Swap visit k with its neighbour; via points travel with their visit. */
export function moveVisit(c: Course, k: number, dir: -1 | 1): void {
  const j = k + dir;
  if (j < 0 || j >= c.sequence.length) return;
  [c.sequence[k], c.sequence[j]] = [c.sequence[j], c.sequence[k]];
  if (c.via) c.via = c.via.map((v) => ({ ...v, after: v.after === k ? j : v.after === j ? k : v.after }));
}

export function addVisit(c: Course, gate: number, reverse = false): void {
  c.sequence.push(reverse ? { gate, reverse: true } : { gate });
}

export function toggleReverse(c: Course, k: number): void {
  const v = c.sequence[k];
  if (!v) return;
  if (v.reverse) delete v.reverse;
  else v.reverse = true;
}

/** Visit endpoint used by the racing line: entry (-0.4 m) or exit (+0.4 m) along the pass direction. */
export function visitPoint(c: Course, v: GateVisit, which: 'entry' | 'exit'): Vec3 {
  const g = c.gates[v.gate];
  const f = gateFrame(g);
  const s = (v.reverse ? -1 : 1) * (which === 'exit' ? 1 : -1) * ENTRY_EXIT;
  return v3(g.center.x + s * f.n.x, g.center.y + s * f.n.y, g.center.z + s * f.n.z);
}

/** Insert a via point halfway between visit k's exit and the next visit's entry; returns its selection. */
export function addViaAfter(c: Course, k: number): Sel {
  const v = c.sequence[k];
  if (!v) return null;
  const next = c.sequence[(k + 1) % c.sequence.length];
  const a = visitPoint(c, v, 'exit');
  const b = next && (k + 1 < c.sequence.length || c.closed) ? visitPoint(c, next, 'entry') : v3(a.x + (a.x - c.gates[v.gate].center.x) * 2, a.y + (a.y - c.gates[v.gate].center.y) * 2, a.z);
  const p = v3(snap((a.x + b.x) / 2), snap((a.y + b.y) / 2), snap((a.z + b.z) / 2));
  c.via = c.via ?? [];
  let i = c.via.findIndex((w) => w.after === k);
  if (i < 0) {
    c.via.push({ after: k, points: [] });
    i = c.via.length - 1;
  }
  c.via[i].points.push(p);
  return { t: 'via', i, k: c.via[i].points.length - 1 };
}

/** Delete a gate: its visits disappear (with their via points) and later gate indices shift down. */
export function deleteGate(c: Course, gi: number): void {
  const map: number[] = [];
  let n = 0;
  c.sequence.forEach((v, k) => (map[k] = v.gate === gi ? -1 : n++));
  const fix = (v: GateVisit): GateVisit => ({ ...v, gate: v.gate > gi ? v.gate - 1 : v.gate });
  if (c.via) {
    c.via = c.via.filter((v) => (map[v.after] ?? -1) >= 0).map((v) => ({ ...v, after: map[v.after] }));
    if (!c.via.length) delete c.via;
  }
  c.sequence = c.sequence.filter((v) => v.gate !== gi).map(fix);
  if (c.droneSequences) {
    c.droneSequences = c.droneSequences.map((s) => s.filter((v) => v.gate !== gi).map(fix));
    if (c.droneSequences.some((s) => !s.length)) delete c.droneSequences;
  }
  c.gates.splice(gi, 1);
}

export function deleteSel(c: Course, s: Sel): void {
  if (!s) return;
  if (s.t === 'gate') deleteGate(c, s.i);
  else if (s.t === 'obs') c.obstacles.splice(s.i, 1);
  else if (c.via?.[s.i]) {
    c.via[s.i].points.splice(s.k, 1);
    if (!c.via[s.i].points.length) c.via.splice(s.i, 1);
    if (!c.via.length) delete c.via;
  }
}

/** Copy the selected gate or obstacle 0.5 m to the side (a copied gate is also appended to the sequence). */
export function duplicateSel(c: Course, s: Sel, arena: ArenaConfig): Sel {
  if (!s || s.t === 'via') return null;
  const shift = (p: P2) => ({ x: clamp(snap(p.x + 0.5), -arena.sx / 2, arena.sx / 2), y: clamp(snap(p.y - 0.5), -arena.sy / 2, arena.sy / 2) });
  if (s.t === 'gate') {
    const g = c.gates[s.i];
    if (!g) return null;
    const copy: Gate = JSON.parse(JSON.stringify(g));
    copy.id = nextId('G', c.gates.map((q) => q.id));
    const p = shift(g.center);
    copy.center.x = p.x;
    copy.center.y = p.y;
    c.gates.push(copy);
    c.sequence.push({ gate: c.gates.length - 1 });
    return { t: 'gate', i: c.gates.length - 1 };
  }
  const o = c.obstacles[s.i];
  if (!o) return null;
  const copy: Obstacle = JSON.parse(JSON.stringify(o));
  const prefix = o.id.replace(/\d+$/, '') || 'O';
  copy.id = nextId(prefix, c.obstacles.map((q) => q.id));
  const p = shift(obstacleAnchor(o));
  setObstacleAnchor(copy, p.x, p.y);
  c.obstacles.push(copy);
  return { t: 'obs', i: c.obstacles.length - 1 };
}

// ---------------------------------------------------------------------------------------------
// Plan geometry shared by the SVG editor and the PNG floor plan
// ---------------------------------------------------------------------------------------------

/** Corners of a yawed rectangle (centre, half extents along its local x / y). */
export function rectCorners(cx: number, cy: number, hx: number, hy: number, yaw: number): P2[] {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return [
    [-hx, -hy],
    [hx, -hy],
    [hx, hy],
    [-hx, hy],
  ].map(([lx, ly]) => ({ x: cx + c * lx - s * ly, y: cy + s * lx + c * ly }));
}

/** Plan footprint of a gate: projected octagon, stand legs or cable points, horizontal normal. */
export function gatePlan(g: Gate): { poly: P2[]; legs: [P2, P2][]; cables: P2[]; n: P2; l: P2; rClear: number } {
  const f = gateFrame(g);
  const poly = f.verts.map((v) => ({ x: v.x, y: v.y }));
  const legs: [P2, P2][] = [];
  const cables: P2[] = [];
  if (g.mount === 'stand') {
    const top = { x: g.center.x - (f.rIn + GATE_TUBE_R) * f.u.x, y: g.center.y - (f.rIn + GATE_TUBE_R) * f.u.y };
    for (let k = 0; k < 4; k++) {
      const a = g.yaw + Math.PI / 4 + (k * Math.PI) / 2;
      legs.push([top, { x: top.x + (LEG_SPAN / 2) * Math.cos(a), y: top.y + (LEG_SPAN / 2) * Math.sin(a) }]);
    }
  } else {
    cables.push({ x: f.verts[1].x, y: f.verts[1].y }, { x: f.verts[2].x, y: f.verts[2].y });
  }
  return { poly, legs, cables, n: { x: Math.cos(g.yaw), y: Math.sin(g.yaw) }, l: { x: -Math.sin(g.yaw), y: Math.cos(g.yaw) }, rClear: f.rClear };
}

/** Horizontal sweep of a pendulum bob: the two extreme bob positions. */
export function pendulumSweep(o: Extract<Obstacle, { kind: 'pendulum' }>): [P2, P2] {
  const r = o.length * Math.sin(Math.abs(o.amplitude));
  const e = { x: Math.cos(o.swingYaw), y: Math.sin(o.swingYaw) };
  return [
    { x: o.pivot.x - r * e.x, y: o.pivot.y - r * e.y },
    { x: o.pivot.x + r * e.x, y: o.pivot.y + r * e.y },
  ];
}

// ---------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------

export type IssueLevel = 'error' | 'warn' | 'info';
export interface Issue {
  level: IssueLevel;
  text: string;
  sel?: Sel;
}

interface Sample {
  p: Vec3;
  r: number;
}

/** A solid of the course for overlap tests: primitives plus points (with radii) on its surface. */
interface Body {
  label: string;
  sel: Sel;
  dynamic: boolean;
  isGate: boolean;
  prims: (t: number) => Primitive[];
  samples: (t: number) => Sample[];
}

const lerp3 = (a: Vec3, b: Vec3, s: number): Vec3 => v3(a.x + (b.x - a.x) * s, a.y + (b.y - a.y) * s, a.z + (b.z - a.z) * s);

function segmentSamples(a: Vec3, b: Vec3, r: number, step: number): Sample[] {
  const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) / step));
  return Array.from({ length: n + 1 }, (_, k) => ({ p: lerp3(a, b, k / n), r }));
}

/** Box surface points: centre (with the inscribed radius) and the 12 edges every 5 cm. */
function boxSamples(c: Vec3, half: Vec3, yaw: number): Sample[] {
  const cs = Math.cos(yaw);
  const sn = Math.sin(yaw);
  const W = (lx: number, ly: number, lz: number) => v3(c.x + cs * lx - sn * ly, c.y + sn * lx + cs * ly, c.z + lz);
  const h = [half.x, half.y, half.z];
  const out: Sample[] = [{ p: { ...c }, r: Math.min(...h) }];
  for (let ax = 0; ax < 3; ax++) {
    const o1 = (ax + 1) % 3;
    const o2 = (ax + 2) % 3;
    for (const s1 of [-1, 1]) {
      for (const s2 of [-1, 1]) {
        const n = Math.max(1, Math.ceil((2 * h[ax]) / 0.05));
        for (let k = 0; k <= n; k++) {
          const l = [0, 0, 0];
          l[ax] = -h[ax] + (2 * h[ax] * k) / n;
          l[o1] = s1 * h[o1];
          l[o2] = s2 * h[o2];
          out.push({ p: W(l[0], l[1], l[2]), r: 0 });
        }
      }
    }
  }
  return out;
}

function gateBody(g: Gate, i: number, ceiling: number): Body {
  const prims = gatePrimitives(g, i, ceiling);
  const f = gateFrame(g);
  const samples: Sample[] = [];
  for (let k = 0; k < 8; k++) {
    for (const s of [0, 0.25, 0.5, 0.75]) samples.push({ p: lerp3(f.verts[k], f.verts[(k + 1) % 8], s), r: GATE_TUBE_R });
  }
  for (const p of prims) {
    if (p.kind !== 'capsule' || p.tag.part === 'frame' || p.tag.part === 'leg') continue;
    samples.push(...segmentSamples(p.a, p.b, p.tag.part === 'cable' ? CABLE_R : POLE_R, 0.12));
  }
  return { label: g.id, sel: { t: 'gate', i }, dynamic: false, isGate: true, prims: () => prims, samples: () => samples };
}

/** True when an id just names its kind ("pendulum", "slider"), so "pendulum pendulum" is avoided. */
function idIsKind(id: string, kind: string): boolean {
  const stem = id.replace(/\d+$/, '').toLowerCase();
  return stem.length >= 3 && kind.toLowerCase().startsWith(stem.slice(0, 4));
}

function obstacleName(o: Obstacle): string {
  const kind = o.kind === 'box' ? (o.label ?? 'box') : o.kind === 'slider' ? 'sliding panel' : o.kind;
  return idIsKind(o.id, kind) ? kind : `${kind} ${o.id}`;
}

function obstacleBody(o: Obstacle, i: number): Body {
  const prims = (t: number) => obstaclePrimitives(o, t, true);
  let samples: (t: number) => Sample[];
  switch (o.kind) {
    case 'pillar': {
      const s = segmentSamples(v3(o.x, o.y, Math.min(o.radius, o.height / 2)), v3(o.x, o.y, Math.max(o.height / 2, o.height - o.radius)), o.radius, 0.08);
      samples = () => s;
      break;
    }
    case 'box': {
      const s = boxSamples(o.center, v3(o.size.x / 2, o.size.y / 2, o.size.z / 2), o.yaw);
      samples = () => s;
      break;
    }
    case 'pendulum':
      samples = (t) => {
        const st = pendulumState(o, t);
        return [{ p: st.bob, r: o.bobRadius }, ...segmentSamples(o.pivot, st.bob, CABLE_R, 0.15)];
      };
      break;
    case 'slider':
      samples = (t) => boxSamples(sliderState(o, t).c, v3(o.size.x / 2, o.size.y / 2, o.size.z / 2), o.yaw);
      break;
  }
  return { label: obstacleName(o), sel: { t: 'obs', i }, dynamic: isDynamic(o), isGate: false, prims, samples };
}

const STATIC_T = [0];
/** 6 s at 10 Hz: two or more periods of any pendulum or slider (periods 1 to 5 s). */
const DYNAMIC_T = Array.from({ length: 60 }, (_, k) => k * 0.1);

function samplesHit(samples: Sample[], prims: Primitive[], tol: number): boolean {
  const bounds = prims.map(primitiveBounds);
  for (const s of samples) {
    for (let q = 0; q < prims.length; q++) {
      if (prims[q].kind === 'plane' || !nearBounds(s.p, bounds[q], s.r + tol)) continue;
      if (distanceToPrimitive(s.p, prims[q]) < s.r + tol) return true;
    }
  }
  return false;
}

function bodiesTouch(a: Body, b: Body, tol: number): boolean {
  const times = a.dynamic || b.dynamic ? DYNAMIC_T : STATIC_T;
  for (const t of times) {
    if (samplesHit(a.samples(t), b.prims(t), tol) || samplesHit(b.samples(t), a.prims(t), tol)) return true;
  }
  return false;
}

/** 2D segment-segment distance (stand legs on the floor). */
function segDist2(a: P2, b: P2, c: P2, d: P2): number {
  const pd = (p: P2, s0: P2, s1: P2) => {
    const dx = s1.x - s0.x;
    const dy = s1.y - s0.y;
    const L = dx * dx + dy * dy;
    const t = L > 0 ? clamp(((p.x - s0.x) * dx + (p.y - s0.y) * dy) / L, 0, 1) : 0;
    return Math.hypot(p.x - s0.x - t * dx, p.y - s0.y - t * dy);
  };
  const cr = (o: P2, p: P2, q: P2) => (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
  const d1 = cr(c, d, a);
  const d2 = cr(c, d, b);
  const d3 = cr(a, b, c);
  const d4 = cr(a, b, d);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0;
  return Math.min(pd(a, c, d), pd(b, c, d), pd(c, a, b), pd(d, a, b));
}

const WALLS: { name: string; d: (p: P2, a: ArenaConfig) => number }[] = [
  { name: '+x', d: (p, a) => a.sx / 2 - p.x },
  { name: '−x', d: (p, a) => a.sx / 2 + p.x },
  { name: '+y', d: (p, a) => a.sy / 2 - p.y },
  { name: '−y', d: (p, a) => a.sy / 2 + p.y },
];

function insideArena(p: Vec3, a: ArenaConfig, m: number): boolean {
  return Math.abs(p.x) <= a.sx / 2 - m && Math.abs(p.y) <= a.sy / 2 - m && p.z >= m && p.z <= a.sz - m;
}

/**
 * Geometry checks of a course in an arena: gates near or through the walls, entry / exit points
 * outside the geofence, gates and obstacles overlapping (dynamic ones over their whole motion),
 * pass corridors (0.4 m either side of each gate) blocked, parameter ranges and the sequence.
 */
export function checkCourse(c: Course, arena: ArenaConfig): Issue[] {
  const out: Issue[] = [];
  const ceiling = arena.sz + 0.1;
  const gs = c.gates;

  // --- sequence
  if (!gs.length) out.push({ level: 'error', text: 'The course has no gates: add at least one with the gate tool.' });
  if (!c.sequence.length && gs.length) out.push({ level: 'error', text: 'The gate sequence is empty: add visits in the sequence list.' });
  const badVisit = c.sequence.findIndex((v) => !gs[v.gate]);
  if (badVisit >= 0) out.push({ level: 'error', text: `Visit ${badVisit + 1} refers to a gate that does not exist.` });
  if (c.closed && c.sequence.length === 1) out.push({ level: 'warn', text: 'A closed loop through a single gate has to turn back on itself: add a second gate or make the course open.' });
  c.sequence.forEach((v, k) => {
    const isLast = k === c.sequence.length - 1;
    if (isLast && !c.closed) return;
    const w = c.sequence[(k + 1) % c.sequence.length];
    if (c.sequence.length > 1 && w && w.gate === v.gate && !!w.reverse === !!v.reverse && !c.via?.some((x) => x.after === k && x.points.length)) {
      out.push({ level: 'warn', text: `Visits ${k + 1} and ${((k + 1) % c.sequence.length) + 1} pass ${gs[v.gate]?.id} twice in a row in the same direction: the line must loop around; add a via point or another gate.`, sel: { t: 'gate', i: v.gate } });
    }
  });
  const visited = new Set([...c.sequence, ...(c.droneSequences ?? []).flat()].map((v) => v.gate));
  gs.forEach((g, i) => {
    if (!visited.has(i)) out.push({ level: 'info', text: `${g.id} is not in the sequence: it is only an obstacle.`, sel: { t: 'gate', i } });
  });
  const ids = new Map<string, number>();
  for (const id of [...gs.map((g) => g.id), ...c.obstacles.map((o) => o.id)]) ids.set(id, (ids.get(id) ?? 0) + 1);
  for (const [id, n] of ids) if (n > 1) out.push({ level: 'warn', text: `The id ${id} is used ${n} times; ids should be unique.` });

  // --- gates: ranges, walls, geofence
  gs.forEach((g, i) => {
    const sel: Sel = { t: 'gate', i };
    const [h0, h1] = heightRange(g, arena);
    if (g.center.z < h0 - 1e-6 || g.center.z > h1 + 1e-6) out.push({ level: 'warn', text: `${g.id}: centre height ${g.center.z.toFixed(2)} m is outside ${h0}–${h1} m for a ${g.mount === 'stand' ? 'stand' : 'hanging'} gate.`, sel });
    if (g.diameter < DIAMETER_RANGE[0] - 1e-6 || g.diameter > DIAMETER_RANGE[1] + 1e-6) out.push({ level: 'warn', text: `${g.id}: outer diameter ${g.diameter.toFixed(2)} m is outside ${DIAMETER_RANGE[0]}–${DIAMETER_RANGE[1]} m.`, sel });
    if (g.mount === 'stand' && Math.abs(g.pitch) > 1e-6) out.push({ level: 'warn', text: `${g.id}: a gate on a stand cannot be tilted; hang it from the truss or set the tilt to 0.`, sel });
    if (Math.abs(toDeg(g.pitch)) > PITCH_MAX_DEG + 1e-6) out.push({ level: 'warn', text: `${g.id}: tilt ${toDeg(g.pitch).toFixed(0)}° exceeds ${PITCH_MAX_DEG}°.`, sel });
    const f = gateFrame(g);
    if (f.verts.some((v) => !insideArena(v, arena, 0))) {
      out.push({ level: 'error', text: `${g.id}: the frame sticks through the net, floor or ceiling.`, sel });
      return;
    }
    const ends = [-1, 1].map((s) => v3(g.center.x + s * ENTRY_EXIT * f.n.x, g.center.y + s * ENTRY_EXIT * f.n.y, g.center.z + s * ENTRY_EXIT * f.n.z));
    if (ends.some((p) => !insideArena(p, arena, ARENA_MARGIN))) {
      out.push({ level: 'error', text: `${g.id}: an entry/exit point (${ENTRY_EXIT} m either side) is outside the ${ARENA_MARGIN} m geofence, so the drone cannot pass straight through.`, sel });
      return;
    }
    let near = { d: Infinity, wall: '' };
    for (const p of [...f.verts, g.center]) {
      for (const w of WALLS) {
        const d = w.d(p, arena);
        if (d < near.d) near = { d, wall: w.name };
      }
    }
    if (near.d < WALL_CLEARANCE) out.push({ level: 'warn', text: `${g.id} is ${near.d.toFixed(2)} m from the ${near.wall} net (keep ≥ ${WALL_CLEARANCE} m: ${ARENA_MARGIN} m geofence plus room to line up).`, sel });
  });

  // --- obstacles: inside the arena, sane parameters
  c.obstacles.forEach((o, i) => {
    const sel: Sel = { t: 'obs', i };
    const name = obstacleName(o);
    let pts: P2[] = [];
    if (o.kind === 'pillar') pts = [-1, 1].flatMap((s) => [{ x: o.x + s * o.radius, y: o.y }, { x: o.x, y: o.y + s * o.radius }]);
    else if (o.kind === 'box') pts = rectCorners(o.center.x, o.center.y, o.size.x / 2, o.size.y / 2, o.yaw);
    else if (o.kind === 'slider') pts = rectCorners(o.center.x, o.center.y, o.size.x / 2 + o.travel, o.size.y / 2, o.yaw);
    else pts = pendulumSweep(o);
    if (pts.some((p) => Math.abs(p.x) > arena.sx / 2 + 1e-6 || Math.abs(p.y) > arena.sy / 2 + 1e-6)) out.push({ level: 'error', text: `The ${name} reaches outside the arena.`, sel });
    if (o.kind === 'pendulum') {
      if (o.pivot.z - o.length - o.bobRadius < 0) out.push({ level: 'error', text: `The ${name}'s bob hits the floor (pivot height − length < bob radius).`, sel });
      if (o.period < 1 || o.period > 5) out.push({ level: 'info', text: `The ${name} has a ${o.period.toFixed(1)} s period; real pendulums of this length swing at 2–3 s.`, sel });
    }
    if (o.kind === 'pillar' && (o.radius < 0.05 - 1e-6 || o.radius > 0.2 + 1e-6)) out.push({ level: 'warn', text: `The ${name} radius ${o.radius.toFixed(2)} m is outside 0.05–0.2 m.`, sel });
    if ((o.kind === 'box' || o.kind === 'slider') && (o.center.z + o.size.z / 2 > arena.sz + 0.05 || o.center.z - o.size.z / 2 < -0.01)) out.push({ level: 'warn', text: `The ${name} pokes through the floor or ceiling.`, sel });
  });

  // --- overlaps
  const gb = gs.map((g, i) => gateBody(g, i, ceiling));
  const ob = c.obstacles.map((o, i) => obstacleBody(o, i));
  for (let i = 0; i < gb.length; i++) {
    for (let j = i + 1; j < gb.length; j++) {
      if (bodiesTouch(gb[i], gb[j], 0.02)) out.push({ level: 'error', text: `${gb[i].label} and ${gb[j].label} overlap (frames, stands or cables touch).`, sel: gb[i].sel });
      else if (gs[i].mount === 'stand' && gs[j].mount === 'stand') {
        const li = gatePlan(gs[i]).legs;
        const lj = gatePlan(gs[j]).legs;
        if (li.some((a) => lj.some((b) => segDist2(a[0], a[1], b[0], b[1]) < 2 * POLE_R + 0.01))) out.push({ level: 'warn', text: `The stand bases of ${gb[i].label} and ${gb[j].label} cross on the floor: move them apart or hang one.`, sel: gb[i].sel });
      }
    }
    for (const o of ob) {
      if (bodiesTouch(gb[i], o, 0.02)) out.push({ level: 'error', text: o.dynamic ? `The ${o.label} hits ${gb[i].label} as it moves.` : `${gb[i].label} overlaps the ${o.label}.`, sel: o.dynamic ? o.sel : gb[i].sel });
    }
  }
  for (let i = 0; i < ob.length; i++) {
    for (let j = i + 1; j < ob.length; j++) {
      if (!bodiesTouch(ob[i], ob[j], 0.01)) continue;
      const dyn = ob[i].dynamic || ob[j].dynamic;
      out.push({ level: dyn ? 'error' : 'warn', text: dyn ? `The ${ob[i].label} and the ${ob[j].label} collide as they move.` : `The ${ob[i].label} and the ${ob[j].label} overlap.`, sel: ob[j].sel });
    }
  }

  // --- pass corridors: the straight 0.8 m through each gate the racing line relies on
  const clearance = DRONE_RADIUS + 0.03;
  gs.forEach((g, i) => {
    if (!visited.has(i)) return;
    const f = gateFrame(g);
    const corridor: Sample[] = [];
    for (let s = -ENTRY_EXIT; s <= ENTRY_EXIT + 1e-9; s += 0.05) corridor.push({ p: v3(g.center.x + s * f.n.x, g.center.y + s * f.n.y, g.center.z + s * f.n.z), r: clearance });
    for (const b of [...gb, ...ob]) {
      if (b.isGate && b.sel?.t === 'gate' && b.sel.i === i) continue;
      if (!b.dynamic) {
        if (samplesHit(corridor, b.prims(0), 0)) out.push({ level: 'error', text: `${g.id} is blocked: ${b.isGate ? 'gate ' : 'the '}${b.label} sits in its ±${ENTRY_EXIT} m pass corridor.`, sel: { t: 'gate', i } });
      } else if (DYNAMIC_T.some((t) => samplesHit(corridor, b.prims(t), 0))) {
        out.push({ level: 'warn', text: `The ${b.label} sweeps through ${g.id}'s pass corridor: drones must time the pass (the safety filter will hold them back).`, sel: { t: 'gate', i } });
      }
    }
  });
  return out;
}

export interface LineReport {
  samples: Vec3[];
  searchPaths: Vec3[][];
  collisions: number;
  /** Time-scale the feasibility loop needed (1 = flyable at the chosen speed). */
  scale: number;
  /** Lap (closed) or course (open) duration after scaling (s). */
  duration: number;
  /** Length of the sampled line (m). */
  length: number;
  speed: number;
  /** Sample-index runs [start, end] that break the thrust / tilt limits at the chosen speed. */
  limitRuns: [number, number][];
  issues: Issue[];
  error?: string;
}

export interface LineOptions {
  speed: number;
  eta: number;
  thetaMaxDeg: number;
  arena: ArenaConfig;
  twr?: number;
}

/**
 * Build the actual racing line (entry/exit points, min-jerk fit, feasibility time-scaling, A*
 * detours) and turn its result into findings: remaining obstacle contacts, how much the line had
 * to slow down and where the chosen speed is impossible (thrust or tilt over the limit).
 */
export function lineReport(c: Course, o: LineOptions): LineReport {
  const twr = o.twr ?? 1.8;
  const base: LineReport = { samples: [], searchPaths: [], collisions: 0, scale: 1, duration: NaN, length: NaN, speed: o.speed, limitRuns: [], issues: [] };
  if (!c.gates.length || !c.sequence.length) return { ...base, error: 'No gate visits yet.' };
  try {
    const line = buildRacingLine(c, { speed: o.speed, twr, eta: o.eta, thetaMaxDeg: o.thetaMaxDeg, arena: o.arena });
    const S = line.samples;
    let length = 0;
    for (let k = 1; k < S.length; k++) length += Math.hypot(S[k].x - S[k - 1].x, S[k].y - S[k - 1].y, S[k].z - S[k - 1].z);
    // where the chosen speed breaks the limits: accelerations scale with the time-scale squared
    const fmax = usableThrust(twr, o.eta);
    const thMax = toRad(o.thetaMaxDeg);
    const k2 = line.feasibilityScale ** 2;
    const T = line.spline.duration;
    const runs: [number, number][] = [];
    let worst = { k: -1, ratio: 0 };
    if (line.feasibilityScale > 1 + 1e-9) {
      let start = -1;
      for (let k = 0; k < S.length; k++) {
        const a = line.spline.eval((k / Math.max(1, S.length - 1)) * T * (line.closed ? 1 - 1e-9 : 1)).a;
        const fx = a.x * k2;
        const fy = a.y * k2;
        const fz = a.z * k2 + G;
        const f = Math.hypot(fx, fy, fz);
        const tilt = f > 1e-9 ? Math.acos(clamp(fz / f, -1, 1)) : Math.PI;
        const ratio = Math.max(f / fmax, tilt / thMax);
        if (ratio > worst.ratio) worst = { k, ratio };
        const bad = ratio > 1 + 1e-9;
        if (bad && start < 0) start = k;
        if (!bad && start >= 0) {
          runs.push([start, k]);
          start = -1;
        }
      }
      if (start >= 0) runs.push([start, S.length - 1]);
    }
    const issues: Issue[] = [];
    if (line.collisions > 0) {
      issues.push({ level: 'error', text: `The racing line still touches obstacles or gate frames at ${line.collisions} samples after ${line.searchPaths.length} A* detour${line.searchPaths.length === 1 ? '' : 's'}: move the obstacle or the gates.` });
    }
    if (line.feasibilityScale > 1 + 1e-9) {
      let nearest = '';
      if (worst.k >= 0) {
        const p = S[worst.k];
        let best = Infinity;
        c.gates.forEach((g) => {
          const d = Math.hypot(p.x - g.center.x, p.y - g.center.y, p.z - g.center.z);
          if (d < best) {
            best = d;
            nearest = g.id;
          }
        });
      }
      const eff = o.speed / line.feasibilityScale;
      // up to ×1.25 the line is merely a little fast; beyond that the chosen speed is unrealistic
      const big = line.feasibilityScale > 1.25;
      issues.push({
        level: big ? 'warn' : 'info',
        text: `${big ? 'Impossible' : 'A little too fast'} at ${o.speed.toFixed(1)} m/s: the turns need more thrust or tilt than the limits allow (TWR ${twr.toFixed(1)}, η ${o.eta}, θmax ${o.thetaMaxDeg}°), so the line was slowed ×${line.feasibilityScale.toFixed(2)} to ≈ ${eff.toFixed(2)} m/s${nearest ? `; tightest near ${nearest}` : ''} (red on the plan).`,
      });
    }
    if (line.searchPaths.length && !line.collisions) issues.push({ level: 'info', text: `A* inserted ${line.searchPaths.length} detour${line.searchPaths.length === 1 ? '' : 's'} around obstacles (dashed on the plan).` });
    // moving obstacles are not part of the line's obstacle set: say which ones it crosses over a cycle
    const step = Math.max(1, Math.ceil(S.length / 400));
    const probe: Sample[] = S.filter((_, k) => k % step === 0).map((p) => ({ p, r: DRONE_RADIUS + 0.03 }));
    c.obstacles.forEach((ob, i) => {
      if (!isDynamic(ob)) return;
      if (DYNAMIC_T.some((t) => samplesHit(probe, obstaclePrimitives(ob, t, true), 0))) {
        issues.push({ level: 'info', text: `The racing line crosses the ${obstacleName(ob)}'s path: the line does not avoid moving obstacles, so the drones have to time the pass and rely on the safety filter.`, sel: { t: 'obs', i } });
      }
    });
    const outside = S.filter((p) => !insideArena(p, o.arena, ARENA_MARGIN - 0.02)).length;
    if (outside) issues.push({ level: 'warn', text: `The racing line leaves the ${ARENA_MARGIN} m geofence at ${outside} samples: move the gates away from the nets.` });
    return { samples: S, searchPaths: line.searchPaths, collisions: line.collisions, scale: line.feasibilityScale, duration: line.duration, length, speed: o.speed, limitRuns: runs, issues };
  } catch (e) {
    const msg = errText(e);
    return { ...base, error: msg, issues: [{ level: 'error', text: `The racing line could not be built: ${msg}` }] };
  }
}

// ---------------------------------------------------------------------------------------------
// Running the checks off the main thread
// ---------------------------------------------------------------------------------------------

export interface CheckResult {
  issues: Issue[];
  line: LineReport;
}

/** Geometry checks plus the racing line; each is guarded so one failing still reports the other. */
export function runChecks(c: Course, o: LineOptions): CheckResult {
  let issues: Issue[];
  try {
    issues = checkCourse(c, o.arena);
  } catch (e) {
    issues = [{ level: 'error', text: `The geometry check failed: ${errText(e)}` }];
  }
  return { issues, line: lineReport(c, o) };
}

export interface CheckRequest {
  id: number;
  course: Course;
  opts: LineOptions;
}
export interface CheckReply {
  id: number;
  result?: CheckResult;
  error?: string;
}

/**
 * Runs `runChecks` in a Web Worker. A healthy course takes 10-150 ms, but one with a gate through
 * the net or a blocked corridor drives the racing line into a dozen A* detours and a ×5 slow-down
 * (2-5 s), which on the main thread would freeze the editor after every edit. Only the newest
 * course matters, so a request made while the worker is busy terminates it rather than queueing
 * (`check` resolves null for the superseded request). Where no worker can be started (tests,
 * old browsers) the checks run synchronously as before.
 *
 * The worker script is src/workers/courseCheck.worker.ts; the caller passes a factory so the
 * `new Worker(new URL(...))` that Vite bundles sits in the importing component.
 */
export class CourseChecker {
  private worker: Worker | null = null;
  private busy: { id: number; done: (r: CheckResult | null) => void; fail: (e: Error) => void; req: CheckRequest } | null = null;
  private seq = 0;
  private broken = false;
  constructor(private readonly spawn: () => Worker) {}

  check(course: Course, opts: LineOptions): Promise<CheckResult | null> {
    this.cancel();
    const req: CheckRequest = { id: ++this.seq, course, opts };
    const w = this.ensure();
    if (!w) return Promise.resolve(runChecks(course, opts));
    return new Promise((done, fail) => {
      this.busy = { id: req.id, done, fail, req };
      w.postMessage(req);
    });
  }

  /** Abandon the running check (its promise resolves null). The worker restarts lazily. */
  cancel(): void {
    const b = this.busy;
    if (!b) return;
    this.busy = null;
    this.worker?.terminate();
    this.worker = null;
    b.done(null);
  }

  dispose(): void {
    this.cancel();
    this.worker?.terminate();
    this.worker = null;
  }

  private ensure(): Worker | null {
    if (this.worker || this.broken) return this.worker;
    try {
      const w = this.spawn();
      let answered = false;
      w.onmessage = (e: MessageEvent<CheckReply>) => {
        answered = true;
        const b = this.busy;
        if (!b || e.data.id !== b.id) return;
        this.busy = null;
        if (e.data.result) b.done(e.data.result);
        else b.fail(new Error(e.data.error ?? 'validation failed'));
      };
      w.onerror = (e) => {
        e.preventDefault();
        if (this.worker === w) this.worker = null;
        w.terminate();
        const b = this.busy;
        this.busy = null;
        if (!b) return;
        if (answered) {
          // a crash in a worker that was working: report it; the next edit starts a fresh one
          b.fail(new Error(e.message || 'the validation worker crashed'));
          return;
        }
        // the worker could not start: finish this request here and stay on the main thread
        this.broken = true;
        try {
          b.done(runChecks(b.req.course, b.req.opts));
        } catch (err) {
          b.fail(err instanceof Error ? err : new Error(String(err)));
        }
      };
      this.worker = w;
    } catch {
      this.broken = true;
    }
    return this.worker;
  }
}

// ---------------------------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const vec = (v: unknown, d: Vec3): Vec3 => (isObj(v) ? v3(num(v.x, d.x), num(v.y, d.y), num(v.z, d.z)) : { ...d });
const isVec2 = (v: unknown): boolean => isObj(v) && isNum(v.x) && isNum(v.y);

function parseVisits(v: unknown, n: number): GateVisit[] | null {
  if (!Array.isArray(v)) return null;
  const out: GateVisit[] = [];
  for (const e of v) {
    const g = isNum(e) ? e : isObj(e) && isNum(e.gate) ? e.gate : NaN;
    if (!Number.isInteger(g) || g < 0 || g >= n) continue;
    out.push(isObj(e) && e.reverse === true ? { gate: g, reverse: true } : { gate: g });
  }
  return out;
}

function parseObstacle(o: unknown, k: number): Obstacle | null {
  if (!isObj(o)) return null;
  const id = typeof o.id === 'string' && o.id ? o.id : `O${k + 1}`;
  switch (o.kind) {
    case 'pillar':
      if (!isNum(o.x) || !isNum(o.y)) return null;
      return { kind: 'pillar', id, x: o.x, y: o.y, radius: num(o.radius, 0.1), height: num(o.height, 2.7) };
    case 'box': {
      if (!isVec2(o.center)) return null;
      const label = o.label === 'wall' || o.label === 'banner' ? o.label : 'box';
      return { kind: 'box', id, center: vec(o.center, v3(0, 0, 0.3)), size: vec(o.size, v3(0.6, 0.6, 0.6)), yaw: num(o.yaw, 0), label };
    }
    case 'pendulum':
      if (!isVec2(o.pivot)) return null;
      return { kind: 'pendulum', id, pivot: vec(o.pivot, v3(0, 0, 3.05)), length: num(o.length, 1.8), bobRadius: num(o.bobRadius, 0.12), amplitude: num(o.amplitude, 0.5), period: num(o.period, 2.6), phase: num(o.phase, 0), swingYaw: num(o.swingYaw, 0) };
    case 'slider':
      if (!isVec2(o.center)) return null;
      return { kind: 'slider', id, center: vec(o.center, v3(0, 0, 1.2)), size: vec(o.size, v3(0.6, 0.06, 0.7)), yaw: num(o.yaw, 0), travel: num(o.travel, 0.5), period: num(o.period, 3), phase: num(o.phase, 0) };
    default:
      return null;
  }
}

/**
 * Parse a course file loosely: a bare Course, a { course } wrapper or a whole saved config.
 * Gates need a centre; everything else falls back to defaults and is reported as a note.
 */
export function parseCourseJson(text: string): { course: Course; notes: string[] } | { error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { error: `Not valid JSON (${errText(e)}).` };
  }
  let o: unknown = raw;
  if (isObj(o) && !Array.isArray(o.gates)) {
    const cc = o.course;
    if (isObj(cc) && isObj(cc.custom)) o = cc.custom;
    else if (isObj(cc) && Array.isArray(cc.gates)) o = cc;
    else if (isObj(o.custom)) o = o.custom;
  }
  if (!isObj(o) || !Array.isArray(o.gates)) return { error: 'No "gates" array found: this does not look like a course file.' };
  const notes: string[] = [];
  const gates: Gate[] = [];
  for (let i = 0; i < o.gates.length; i++) {
    const g = o.gates[i];
    if (!isObj(g) || !isVec2(g.center)) return { error: `Gate ${i + 1} has no valid centre {x, y, z}.` };
    gates.push({
      id: typeof g.id === 'string' && g.id ? g.id : `G${i + 1}`,
      center: vec(g.center, v3(0, 0, 1)),
      yaw: num(g.yaw, 0),
      pitch: num(g.pitch, 0),
      diameter: num(g.diameter, 0.8),
      color: typeof g.color === 'string' && /^#[0-9a-f]{3,8}$/i.test(g.color) ? g.color : GATE_COLORS[i % GATE_COLORS.length],
      mount: g.mount === 'hanging' ? 'hanging' : 'stand',
    });
  }
  if (!gates.length) return { error: 'The file has no gates.' };
  const obstacles: Obstacle[] = [];
  if (Array.isArray(o.obstacles)) {
    o.obstacles.forEach((x, k) => {
      const ob = parseObstacle(x, k);
      if (ob) obstacles.push(ob);
      else notes.push(`obstacle ${k + 1} skipped (unknown kind or no position)`);
    });
  }
  let sequence = parseVisits(o.sequence, gates.length);
  if (!sequence || !sequence.length) {
    sequence = gates.map((_, i) => ({ gate: i }));
    notes.push('no valid sequence: gates are visited in order');
  }
  const course: Course = {
    id: 'C12',
    name: typeof o.name === 'string' && o.name ? o.name : 'C12 Custom (loaded)',
    difficulty: clamp(Math.round(num(o.difficulty, 3)), 1, 5),
    description: typeof o.description === 'string' ? o.description : '',
    gates,
    obstacles,
    sequence,
    closed: typeof o.closed === 'boolean' ? o.closed : true,
    laps: clamp(Math.round(num(o.laps, 1)), 1, 10),
    arena: isObj(o.arena) ? { sx: num(o.arena.sx, 8), sy: num(o.arena.sy, 5), sz: num(o.arena.sz, 3) } : { sx: 8, sy: 5, sz: 3 },
    targetSpeed: num(o.targetSpeed, 1.6),
  };
  if (Array.isArray(o.droneSequences)) {
    const ds = o.droneSequences.map((s) => parseVisits(s, gates.length));
    if (ds.length && ds.every((s) => s && s.length)) course.droneSequences = ds as GateVisit[][];
  }
  if (Array.isArray(o.via)) {
    const via = o.via
      .filter((v): v is Record<string, unknown> => isObj(v) && Number.isInteger(v.after) && Array.isArray(v.points))
      .map((v) => ({ after: v.after as number, points: (v.points as unknown[]).filter((p) => isObj(p) && isNum(p.x) && isNum(p.y) && isNum(p.z)).map((p) => vec(p, v3())) }))
      .filter((v) => v.points.length && v.after < sequence.length);
    if (via.length) course.via = via;
  }
  return { course, notes };
}

// ---------------------------------------------------------------------------------------------
// Printable floor plan (PNG)
// ---------------------------------------------------------------------------------------------

const f2 = (x: number) => x.toFixed(2).replace('-', '−');
const fdeg = (r: number) => `${wrapDeg(toDeg(r)).toFixed(0).replace('-', '−')}°`;

/** Short, filesystem-safe name. */
export function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'course'
  );
}

/** Greedy word wrap to a pixel width (`measure` gives the rendered width of a string). */
export function wrapText(text: string, width: number, measure: (s: string) => number): string[] {
  const lines: string[] = [];
  let cur = '';
  for (const w of text.split(/\s+/).filter(Boolean)) {
    const next = cur ? `${cur} ${w}` : w;
    if (cur && measure(next) > width) {
      lines.push(cur);
      cur = w;
    } else cur = next;
  }
  if (cur) lines.push(cur);
  return lines;
}

/**
 * A clean printable floor plan for building the course from PVC stands: arena outline and
 * geofence, 0.5 m grid with metre ticks, arena dimensions, every gate with its centre coordinates,
 * height, diameter and pass direction, obstacles with their sizes, a 1 m scale bar and tables.
 */
export function drawFloorPlan(c: Course, arena: ArenaConfig, opts: { line?: Vec3[] | null; speed?: number } = {}): HTMLCanvasElement {
  const W = 2000;
  const padL = 200;
  const padR = 110;
  const top = 230;
  const ppm = (W - padL - padR) / arena.sx;
  const planH = arena.sy * ppm;
  const rowH = 40;
  const font = (px: number, w = 400) => `${w} ${px}px system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif`;
  const INK = '#0f172a';
  const MUTED = '#64748b';
  const canvas = document.createElement('canvas');
  canvas.width = W;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D is not available in this browser.');
  // the legend beside the scale bar is wrapped to the page width; its line count sets where the tables start
  const legendX = padL + ppm + 60;
  ctx.font = font(22);
  const legendLines = [
    `Scale 1 m = ${ppm.toFixed(0)} px. Gate bar = ring seen from above; arrow = pass direction (entry → exit, ${ENTRY_EXIT} m either side); badge = sequence number(s). Grey X = stand base (${LEG_SPAN} m span); white dots = ceiling cables.${opts.line?.length ? ' Dashed blue = planned racing line (simulation).' : ''}`,
    'Coordinates: origin at the arena floor centre, x forward, y left, z up; yaw measured from +x towards +y.',
  ].flatMap((para) => wrapText(para, W - padR - legendX, (t) => ctx.measureText(t).width));
  const tableTop = top + planH + Math.max(250, 226 + legendLines.length * 34);
  const obsTop = tableTop + (c.gates.length + 1) * rowH + 70;
  const H = Math.ceil(obsTop + (c.obstacles.length ? (c.obstacles.length + 1) * rowH + 40 : 0) + 110);
  canvas.height = H; // resets the context state; nothing is drawn yet
  const X = (x: number) => padL + (x + arena.sx / 2) * ppm;
  const Y = (y: number) => top + (arena.sy / 2 - y) * ppm;
  const hx = arena.sx / 2;
  const hy = arena.sy / 2;

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);

  // --- title block
  ctx.fillStyle = INK;
  ctx.font = font(56, 700);
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.fillText(c.name || 'Custom course', padL, 86);
  ctx.font = font(28);
  ctx.fillStyle = MUTED;
  const loop = c.closed ? `closed loop, ${c.laps} lap${c.laps === 1 ? '' : 's'}` : 'open course';
  ctx.fillText(`Floor plan · arena ${arena.sx.toFixed(1)} × ${arena.sy.toFixed(1)} × ${arena.sz.toFixed(1)} m · ${c.gates.length} gates · ${c.obstacles.length} obstacles · ${loop}${opts.speed ? ` · ${opts.speed.toFixed(1)} m/s target` : ''}`, padL, 132);
  const seqText = `Sequence: ${c.sequence.map((v) => `${c.gates[v.gate]?.id ?? '?'}${v.reverse ? ' (reverse)' : ''}`).join(' → ')}${c.closed && c.sequence.length ? ' → …' : ''}`;
  ctx.font = font(24);
  ctx.fillText(seqText.length > 150 ? `${seqText.slice(0, 147)}…` : seqText, padL, 172);
  ctx.textAlign = 'right';
  ctx.fillText(`C3U lab testbed · ${new Date().toISOString().slice(0, 10)}`, W - padR, 86);

  // --- floor, geofence band, grid
  ctx.fillStyle = '#f8fafc';
  ctx.fillRect(X(-hx), Y(hy), arena.sx * ppm, planH);
  ctx.fillStyle = 'rgba(244, 63, 94, 0.07)';
  ctx.beginPath();
  ctx.rect(X(-hx), Y(hy), arena.sx * ppm, planH);
  ctx.rect(X(-hx + ARENA_MARGIN), Y(hy - ARENA_MARGIN), (arena.sx - 2 * ARENA_MARGIN) * ppm, (arena.sy - 2 * ARENA_MARGIN) * ppm);
  ctx.fill('evenodd');
  const gridLine = (x0: number, y0: number, x1: number, y1: number) => {
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
  };
  for (let k = Math.ceil(-hx / 0.5); k * 0.5 <= hx + 1e-9; k++) {
    const x = k * 0.5;
    ctx.strokeStyle = x === 0 ? '#94a3b8' : k % 2 === 0 ? '#cbd5e1' : '#e2e8f0';
    ctx.lineWidth = x === 0 ? 2 : 1.5;
    gridLine(X(x), Y(hy), X(x), Y(-hy));
  }
  for (let k = Math.ceil(-hy / 0.5); k * 0.5 <= hy + 1e-9; k++) {
    const y = k * 0.5;
    ctx.strokeStyle = y === 0 ? '#94a3b8' : k % 2 === 0 ? '#cbd5e1' : '#e2e8f0';
    ctx.lineWidth = y === 0 ? 2 : 1.5;
    gridLine(X(-hx), Y(y), X(hx), Y(y));
  }
  ctx.setLineDash([16, 10]);
  ctx.strokeStyle = '#e11d48';
  ctx.lineWidth = 2.5;
  ctx.strokeRect(X(-hx + ARENA_MARGIN), Y(hy - ARENA_MARGIN), (arena.sx - 2 * ARENA_MARGIN) * ppm, (arena.sy - 2 * ARENA_MARGIN) * ppm);
  ctx.setLineDash([]);
  ctx.strokeStyle = INK;
  ctx.lineWidth = 5;
  ctx.strokeRect(X(-hx), Y(hy), arena.sx * ppm, planH);
  ctx.fillStyle = '#e11d48';
  ctx.font = font(20);
  ctx.textAlign = 'left';
  ctx.fillText(`geofence (${ARENA_MARGIN} m inside the net)`, X(-hx + ARENA_MARGIN) + 8, Y(hy - ARENA_MARGIN) + 24);

  // --- metre ticks
  ctx.fillStyle = MUTED;
  ctx.font = font(22);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let x = Math.ceil(-hx); x <= hx + 1e-9; x++) ctx.fillText(String(x).replace('-', '−'), X(x), Y(-hy) + 12);
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let y = Math.ceil(-hy); y <= hy + 1e-9; y++) ctx.fillText(String(y).replace('-', '−'), X(-hx) - 14, Y(y));

  // --- dimension lines
  const arrowHead = (x: number, y: number, ang: number, size = 16) => {
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x - size * Math.cos(ang - 0.4), y - size * Math.sin(ang - 0.4));
    ctx.lineTo(x - size * Math.cos(ang + 0.4), y - size * Math.sin(ang + 0.4));
    ctx.closePath();
    ctx.fill();
  };
  const dimLine = (x0: number, y0: number, x1: number, y1: number, label: string, vertical: boolean) => {
    ctx.strokeStyle = INK;
    ctx.fillStyle = INK;
    ctx.lineWidth = 2;
    gridLine(x0, y0, x1, y1);
    const ang = Math.atan2(y1 - y0, x1 - x0);
    arrowHead(x1, y1, ang);
    arrowHead(x0, y0, ang + Math.PI);
    ctx.save();
    ctx.translate((x0 + x1) / 2, (y0 + y1) / 2);
    if (vertical) ctx.rotate(-Math.PI / 2);
    ctx.font = font(28, 600);
    const w = ctx.measureText(label).width + 24;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(-w / 2, -20, w, 40);
    ctx.fillStyle = INK;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, 0, 0);
    ctx.restore();
  };
  ctx.strokeStyle = '#94a3b8';
  ctx.lineWidth = 1.5;
  gridLine(X(-hx), Y(-hy) + 44, X(-hx), Y(-hy) + 96);
  gridLine(X(hx), Y(-hy) + 44, X(hx), Y(-hy) + 96);
  dimLine(X(-hx), Y(-hy) + 80, X(hx), Y(-hy) + 80, `${arena.sx.toFixed(2)} m (x)`, false);
  ctx.strokeStyle = '#94a3b8';
  ctx.lineWidth = 1.5;
  gridLine(X(-hx) - 60, Y(hy), X(-hx) - 128, Y(hy));
  gridLine(X(-hx) - 60, Y(-hy), X(-hx) - 128, Y(-hy));
  dimLine(X(-hx) - 110, Y(-hy), X(-hx) - 110, Y(hy), `${arena.sy.toFixed(2)} m (y)`, true);

  // --- origin and axes
  ctx.lineWidth = 4;
  ctx.strokeStyle = '#dc2626';
  ctx.fillStyle = '#dc2626';
  gridLine(X(0), Y(0), X(0.5), Y(0));
  arrowHead(X(0.5), Y(0), 0, 18);
  ctx.strokeStyle = '#16a34a';
  ctx.fillStyle = '#16a34a';
  gridLine(X(0), Y(0), X(0), Y(0.5));
  arrowHead(X(0), Y(0.5), -Math.PI / 2, 18);
  ctx.font = font(24, 700);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#dc2626';
  ctx.fillText('x', X(0.5) + 8, Y(0));
  ctx.fillStyle = '#16a34a';
  ctx.fillText('y', X(0) + 10, Y(0.5) - 6);
  ctx.fillStyle = MUTED;
  ctx.font = font(20);
  ctx.fillText('origin (0, 0)', X(0) + 10, Y(0) + 22);

  // --- racing line (faint)
  if (opts.line && opts.line.length > 1) {
    ctx.strokeStyle = 'rgba(14, 165, 233, 0.5)';
    ctx.lineWidth = 3;
    ctx.setLineDash([14, 10]);
    ctx.beginPath();
    opts.line.forEach((p, k) => (k ? ctx.lineTo(X(p.x), Y(p.y)) : ctx.moveTo(X(p.x), Y(p.y))));
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // label placement: greedy, avoiding earlier labels, badges and the drawn items themselves
  type Rect = { x0: number; y0: number; x1: number; y1: number };
  const placed: Rect[] = [];
  const box = (ps: P2[], pad: number): Rect => ({
    x0: Math.min(...ps.map((p) => X(p.x))) - pad,
    y0: Math.min(...ps.map((p) => Y(p.y))) - pad,
    x1: Math.max(...ps.map((p) => X(p.x))) + pad,
    y1: Math.max(...ps.map((p) => Y(p.y))) + pad,
  });
  const footprints: Rect[] = [];
  const free = (r: { x0: number; y0: number; x1: number; y1: number }) => r.x0 >= X(-hx) + 4 && r.x1 <= X(hx) - 4 && r.y0 >= Y(hy) + 4 && r.y1 <= Y(-hy) - 4 && !placed.some((q) => r.x0 < q.x1 && r.x1 > q.x0 && r.y0 < q.y1 && r.y1 > q.y0);
  const label = (lines: string[], ax: number, ay: number, dirs: P2[], color: string) => {
    ctx.font = font(22);
    const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 16;
    const h = lines.length * 26 + 10;
    let best: { x0: number; y0: number; x1: number; y1: number } | null = null;
    for (const dist of [48, 80, 120, 170, 230, 300]) {
      for (const d of dirs) {
        const cx = ax + d.x * dist;
        const cy = ay + d.y * dist;
        const r = { x0: d.x < -0.3 ? cx - w : d.x > 0.3 ? cx : cx - w / 2, y0: d.y < -0.3 ? cy - h : d.y > 0.3 ? cy : cy - h / 2, x1: 0, y1: 0 };
        r.x1 = r.x0 + w;
        r.y1 = r.y0 + h;
        if (free(r)) {
          best = r;
          break;
        }
      }
      if (best) break;
    }
    if (!best) {
      const r = { x0: ax + 30, y0: ay + 30, x1: ax + 30 + w, y1: ay + 30 + h };
      best = r;
    }
    placed.push(best);
    ctx.strokeStyle = 'rgba(100, 116, 139, 0.6)';
    ctx.lineWidth = 1.5;
    const lx = clamp(ax, best.x0, best.x1);
    const ly = clamp(ay, best.y0, best.y1);
    gridLine(ax, ay, lx, ly);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
    ctx.fillRect(best.x0, best.y0, w, h);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.strokeRect(best.x0, best.y0, w, h);
    ctx.fillStyle = INK;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    lines.forEach((l, k) => {
      ctx.font = k === 0 ? font(22, 700) : font(22);
      ctx.fillText(l, best!.x0 + 8, best!.y0 + 7 + k * 26);
    });
  };
  const ring8: P2[] = Array.from({ length: 8 }, (_, k) => ({ x: Math.cos((k * Math.PI) / 4), y: -Math.sin((k * Math.PI) / 4) }));

  // --- obstacles
  const obsLabels: { lines: string[]; x: number; y: number }[] = [];
  // "P1 pillar", but just "pendulum" when the id already says what it is
  const head = (id: string, kind: string) => (idIsKind(id, kind) ? id : `${id} ${kind}`);
  for (const o of c.obstacles) {
    ctx.setLineDash([]);
    if (o.kind === 'pillar') {
      ctx.fillStyle = 'rgba(245, 158, 11, 0.4)';
      ctx.strokeStyle = '#b45309';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(X(o.x), Y(o.y), Math.max(4, o.radius * ppm), 0, 2 * Math.PI);
      ctx.fill();
      ctx.stroke();
      obsLabels.push({ lines: [head(o.id, 'pillar'), `(${f2(o.x)}, ${f2(o.y)}) · Ø ${f2(2 * o.radius)} · h ${f2(o.height)}`], x: X(o.x), y: Y(o.y) });
      footprints.push(box([{ x: o.x - o.radius, y: o.y - o.radius }, { x: o.x + o.radius, y: o.y + o.radius }], 6));
    } else if (o.kind === 'box') {
      const pts = rectCorners(o.center.x, o.center.y, o.size.x / 2, o.size.y / 2, o.yaw);
      ctx.fillStyle = o.label === 'banner' ? 'rgba(124, 58, 237, 0.25)' : o.label === 'wall' ? 'rgba(100, 116, 139, 0.4)' : 'rgba(161, 98, 7, 0.3)';
      ctx.strokeStyle = o.label === 'banner' ? '#7c3aed' : o.label === 'wall' ? '#475569' : '#a16207';
      ctx.lineWidth = 3;
      if (o.label === 'banner') ctx.setLineDash([10, 6]);
      ctx.beginPath();
      pts.forEach((p, k) => (k ? ctx.lineTo(X(p.x), Y(p.y)) : ctx.moveTo(X(p.x), Y(p.y))));
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.setLineDash([]);
      footprints.push(box(pts, 6));
      obsLabels.push({ lines: [head(o.id, o.label ?? 'box'), `(${f2(o.center.x)}, ${f2(o.center.y)}) · ${f2(o.size.x)}×${f2(o.size.y)}×${f2(o.size.z)} m`, `z ${f2(o.center.z - o.size.z / 2)}–${f2(o.center.z + o.size.z / 2)} m · yaw ${fdeg(o.yaw)}`], x: X(o.center.x), y: Y(o.center.y) });
    } else if (o.kind === 'pendulum') {
      const [a, b] = pendulumSweep(o);
      ctx.strokeStyle = 'rgba(225, 29, 72, 0.22)';
      ctx.lineCap = 'round';
      ctx.lineWidth = Math.max(6, 2 * o.bobRadius * ppm);
      gridLine(X(a.x), Y(a.y), X(b.x), Y(b.y));
      ctx.lineCap = 'butt';
      ctx.strokeStyle = '#e11d48';
      ctx.lineWidth = 2;
      gridLine(X(a.x), Y(a.y), X(b.x), Y(b.y));
      ctx.fillStyle = '#e11d48';
      ctx.beginPath();
      ctx.arc(X(o.pivot.x), Y(o.pivot.y), 7, 0, 2 * Math.PI);
      ctx.fill();
      footprints.push(box([a, b, o.pivot], Math.max(8, o.bobRadius * ppm + 4)));
      obsLabels.push({ lines: [head(o.id, 'pendulum'), `pivot (${f2(o.pivot.x)}, ${f2(o.pivot.y)}, ${f2(o.pivot.z)})`, `L ${f2(o.length)} m · ±${toDeg(o.amplitude).toFixed(0)}° · T ${o.period.toFixed(1)} s`], x: X(o.pivot.x), y: Y(o.pivot.y) });
    } else {
      const e = { x: Math.cos(o.yaw), y: Math.sin(o.yaw) };
      for (const s of [-1, 0, 1]) {
        const pts = rectCorners(o.center.x + s * o.travel * e.x, o.center.y + s * o.travel * e.y, o.size.x / 2, o.size.y / 2, o.yaw);
        ctx.fillStyle = s === 0 ? 'rgba(234, 179, 8, 0.45)' : 'rgba(234, 179, 8, 0.12)';
        ctx.strokeStyle = '#a16207';
        ctx.lineWidth = s === 0 ? 3 : 2;
        ctx.setLineDash(s === 0 ? [] : [8, 6]);
        ctx.beginPath();
        pts.forEach((p, k) => (k ? ctx.lineTo(X(p.x), Y(p.y)) : ctx.moveTo(X(p.x), Y(p.y))));
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
      ctx.setLineDash([]);
      footprints.push(box(rectCorners(o.center.x, o.center.y, o.size.x / 2 + o.travel, o.size.y / 2, o.yaw), 6));
      obsLabels.push({ lines: [head(o.id, 'sliding panel'), `(${f2(o.center.x)}, ${f2(o.center.y)}) · travel ±${f2(o.travel)} m`, `${f2(o.size.x)}×${f2(o.size.y)}×${f2(o.size.z)} m · T ${o.period.toFixed(1)} s`], x: X(o.center.x), y: Y(o.center.y) });
    }
  }

  // --- gates
  const nums = gateNumbers(c);
  const dirs = gateDirections(c);
  const badges: { x: number; y: number; text: string; color: string }[] = [];
  c.gates.forEach((g, i) => {
    const pl = gatePlan(g);
    ctx.strokeStyle = '#94a3b8';
    ctx.lineWidth = 3;
    for (const [a, b] of pl.legs) gridLine(X(a.x), Y(a.y), X(b.x), Y(b.y));
    ctx.strokeStyle = g.color;
    ctx.fillStyle = `${g.color}22`;
    ctx.lineWidth = 9;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    pl.poly.forEach((p, k) => (k ? ctx.lineTo(X(p.x), Y(p.y)) : ctx.moveTo(X(p.x), Y(p.y))));
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = INK;
    ctx.lineWidth = 2;
    for (const p of pl.cables) {
      ctx.beginPath();
      ctx.arc(X(p.x), Y(p.y), 6, 0, 2 * Math.PI);
      ctx.fill();
      ctx.stroke();
    }
    // pass direction(s): entry -> exit
    const d = dirs[i];
    const arrows = d.fwd || d.rev ? [d.fwd ? 1 : 0, d.rev ? -1 : 0].filter(Boolean) : [1];
    for (const s of arrows) {
      ctx.strokeStyle = d.fwd || d.rev ? g.color : '#94a3b8';
      ctx.fillStyle = ctx.strokeStyle;
      ctx.lineWidth = 4;
      const a = { x: g.center.x - s * ENTRY_EXIT * pl.n.x, y: g.center.y - s * ENTRY_EXIT * pl.n.y };
      const b = { x: g.center.x + s * (ENTRY_EXIT + 0.08) * pl.n.x, y: g.center.y + s * (ENTRY_EXIT + 0.08) * pl.n.y };
      gridLine(X(a.x), Y(a.y), X(b.x), Y(b.y));
      arrowHead(X(b.x), Y(b.y), Math.atan2(Y(b.y) - Y(a.y), X(b.x) - X(a.x)), 20);
    }
    ctx.fillStyle = INK;
    ctx.beginPath();
    ctx.arc(X(g.center.x), Y(g.center.y), 5, 0, 2 * Math.PI);
    ctx.fill();
    const off = g.diameter / 2 + 0.2;
    const bx = X(g.center.x + off * pl.l.x);
    const by = Y(g.center.y + off * pl.l.y);
    badges.push({ x: bx, y: by, text: nums[i] || '–', color: g.color });
    placed.push({ x0: bx - 30, y0: by - 22, x1: bx + 30, y1: by + 22 });
    const tips = [-1, 1].map((s) => ({ x: g.center.x + s * (ENTRY_EXIT + 0.08) * pl.n.x, y: g.center.y + s * (ENTRY_EXIT + 0.08) * pl.n.y }));
    footprints.push(box([...pl.poly, ...pl.legs.flat(), ...tips], 8));
  });
  placed.push(...footprints);
  for (const b of badges) {
    ctx.font = font(24, 700);
    const w = Math.max(44, ctx.measureText(b.text).width + 24);
    ctx.fillStyle = b.color;
    ctx.beginPath();
    ctx.roundRect(b.x - w / 2, b.y - 22, w, 44, 22);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(b.text, b.x, b.y + 1);
  }
  c.gates.forEach((g, i) => {
    const pl = gatePlan(g);
    const lines = [`${g.id}  (${f2(g.center.x)}, ${f2(g.center.y)}) m`, `height ${f2(g.center.z)} m · Ø ${f2(g.diameter)} m`, `yaw ${fdeg(g.yaw)}${g.mount === 'hanging' ? ` · hanging${Math.abs(g.pitch) > 1e-6 ? `, tilt ${fdeg(g.pitch)}` : ''}` : ' · stand'}`];
    const side = [
      { x: -pl.l.x, y: pl.l.y },
      { x: pl.n.x, y: -pl.n.y },
      { x: -pl.n.x, y: pl.n.y },
      { x: pl.l.x, y: -pl.l.y },
      ...ring8,
    ];
    label(lines, X(g.center.x), Y(g.center.y), side, g.color);
    void i;
  });
  for (const l of obsLabels) label(l.lines, l.x, l.y, ring8, '#94a3b8');

  // --- scale bar and legend
  const sbY = Y(-hy) + 150;
  const sbX = X(-hx);
  for (let k = 0; k < 10; k++) {
    ctx.fillStyle = k % 2 === 0 ? INK : '#ffffff';
    ctx.fillRect(sbX + k * 0.1 * ppm, sbY, 0.1 * ppm, 14);
  }
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2;
  ctx.strokeRect(sbX, sbY, ppm, 14);
  ctx.fillStyle = INK;
  ctx.font = font(22);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText('0', sbX, sbY + 22);
  ctx.fillText('0.5', sbX + 0.5 * ppm, sbY + 22);
  ctx.fillText('1 m', sbX + ppm, sbY + 22);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = MUTED;
  ctx.font = font(22);
  legendLines.forEach((l, k) => ctx.fillText(l, legendX, sbY + 8 + k * 34));

  // --- tables
  const table = (y0: number, title: string, cols: { h: string; w: number }[], rows: (string | { swatch: string })[][]) => {
    ctx.fillStyle = INK;
    ctx.font = font(30, 700);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(title, padL, y0 - 14);
    let x = padL;
    const xs = cols.map((col) => {
      const at = x;
      x += col.w;
      return at;
    });
    ctx.fillStyle = '#f1f5f9';
    ctx.fillRect(padL, y0, x - padL, rowH);
    ctx.font = font(22, 700);
    ctx.fillStyle = INK;
    ctx.textBaseline = 'middle';
    cols.forEach((col, k) => ctx.fillText(col.h, xs[k] + 8, y0 + rowH / 2));
    rows.forEach((r, ri) => {
      const ry = y0 + (ri + 1) * rowH;
      ctx.strokeStyle = '#e2e8f0';
      ctx.lineWidth = 1;
      gridLine(padL, ry + rowH, x, ry + rowH);
      ctx.font = font(22);
      r.forEach((cell, k) => {
        if (typeof cell === 'string') {
          ctx.fillStyle = INK;
          ctx.fillText(cell, xs[k] + 8, ry + rowH / 2);
        } else {
          ctx.fillStyle = cell.swatch;
          ctx.fillRect(xs[k] + 8, ry + 9, 40, rowH - 18);
          ctx.fillStyle = MUTED;
          ctx.fillText(cell.swatch, xs[k] + 56, ry + rowH / 2);
        }
      });
    });
  };
  table(
    tableTop,
    'Gates',
    [
      { h: 'Gate', w: 120 },
      { h: 'Seq.', w: 110 },
      { h: 'x (m)', w: 130 },
      { h: 'y (m)', w: 130 },
      { h: 'Height (m)', w: 160 },
      { h: 'Yaw', w: 110 },
      { h: 'Tilt', w: 100 },
      { h: 'Outer Ø (m)', w: 170 },
      { h: 'Inner Ø (m)', w: 170 },
      { h: 'Mount', w: 140 },
      { h: 'Colour', w: 200 },
    ],
    c.gates.map((g, i) => [g.id, nums[i] || '–', f2(g.center.x), f2(g.center.y), f2(g.center.z), fdeg(g.yaw), fdeg(g.pitch), f2(g.diameter), f2(2 * gatePlan(g).rClear), g.mount, { swatch: g.color }]),
  );
  if (c.obstacles.length) {
    table(
      obsTop,
      'Obstacles',
      [
        { h: 'Id', w: 120 },
        { h: 'Type', w: 200 },
        { h: 'x (m)', w: 130 },
        { h: 'y (m)', w: 130 },
        { h: 'Details', w: 1060 },
      ],
      c.obstacles.map((o) => {
        const a = obstacleAnchor(o);
        const type = o.kind === 'box' ? (o.label ?? 'box') : o.kind === 'slider' ? 'sliding panel' : o.kind;
        const det =
          o.kind === 'pillar'
            ? `radius ${f2(o.radius)} m, height ${f2(o.height)} m`
            : o.kind === 'box'
              ? `size ${f2(o.size.x)} × ${f2(o.size.y)} × ${f2(o.size.z)} m, centre height ${f2(o.center.z)} m, yaw ${fdeg(o.yaw)}`
              : o.kind === 'pendulum'
                ? `pivot height ${f2(o.pivot.z)} m, length ${f2(o.length)} m, bob Ø ${f2(2 * o.bobRadius)} m, ±${toDeg(o.amplitude).toFixed(0)}°, period ${o.period.toFixed(1)} s, swing ${fdeg(o.swingYaw)}`
                : `size ${f2(o.size.x)} × ${f2(o.size.y)} × ${f2(o.size.z)} m, centre height ${f2(o.center.z)} m, travel ±${f2(o.travel)} m along ${fdeg(o.yaw)}, period ${o.period.toFixed(1)} s`;
        return [o.id, type, f2(a.x), f2(a.y), det];
      }),
    );
  }
  return canvas;
}
