/**
 * Racing-line generation through ring gates (Section 5.2b), used by every planner:
 *  1. for each gate visit, an entry and an exit point 0.4 m before and after the gate centre
 *     along its (visit-direction) normal, so the drone passes straight through;
 *  2. a minimum-jerk piecewise polynomial through the sequence, time allocated from a target
 *     speed, then time-scaled until the feasibility check passes;
 *  3. a check against all obstacles (inflated by the drone radius plus a margin); colliding
 *     stretches get detour waypoints from an A* search on a 0.1 m voxel grid of free space,
 *     then the spline is re-fitted and re-checked (raw search paths kept for display);
 *  4. the resulting centreline becomes a Track whose half-width shrinks to each gate's opening,
 *     so the planners' lateral/vertical offsets stay inside the gates.
 */
import { DRONE_RADIUS } from './constants';
import { gateFrame, gatePrimitives, isDynamic, obstaclePrimitives, type GateFrame } from './course';
import { checkFeasibility } from './feasibility';
import { distanceToPrimitive, nearBounds, primitiveBounds, type Primitive } from './geometry';
import { makeTrack, type Track } from './planners/track';
import { minDerivSpline, type PolySpline } from './trajectories/minJerk';
import type { ArenaConfig, Course, GateVisit } from './types';
import { v3, type Vec3 } from './vec';

export const ENTRY_EXIT = 0.4;

export interface RacingLineOptions {
  speed: number;
  twr: number;
  eta: number;
  thetaMaxDeg: number;
  arena: ArenaConfig;
  /** Clearance kept from obstacles by the line (m, centre to surface). */
  clearance?: number;
  /** Per-drone visit sequence override (merge course). */
  sequence?: GateVisit[];
}

export interface RacingLine {
  waypoints: Vec3[];
  spline: PolySpline;
  /** Dense samples along one lap (closed) or the whole course (open). */
  samples: Vec3[];
  track: Track;
  /** Lap / course duration of the min-jerk line after feasibility scaling (s). */
  duration: number;
  /** Raw A* paths used for detours. */
  searchPaths: Vec3[][];
  /** Remaining obstacle contacts after detouring (should be 0). */
  collisions: number;
  feasibilityScale: number;
  closed: boolean;
}

interface VisitPoint {
  p: Vec3;
  gateCentre: boolean;
  gate: number;
}

/** Static obstacle primitives the racing line must avoid (dynamic obstacles excluded). */
export function lineObstacles(course: Course, arena: ArenaConfig): Primitive[] {
  const out: Primitive[] = [];
  course.gates.forEach((g, i) => out.push(...gatePrimitives(g, i, arena.sz + 0.1)));
  for (const o of course.obstacles) if (!isDynamic(o)) out.push(...obstaclePrimitives(o, 0, false));
  return out;
}

function visitPoints(course: Course, seq: GateVisit[], frames: GateFrame[]): VisitPoint[] {
  const pts: VisitPoint[] = [];
  for (const v of seq) {
    const g = course.gates[v.gate];
    const f = frames[v.gate];
    const sgn = v.reverse ? -1 : 1;
    const n = v3(f.n.x * sgn, f.n.y * sgn, f.n.z * sgn);
    pts.push({ p: v3(g.center.x - ENTRY_EXIT * n.x, g.center.y - ENTRY_EXIT * n.y, g.center.z - ENTRY_EXIT * n.z), gateCentre: false, gate: v.gate });
    pts.push({ p: { ...g.center }, gateCentre: true, gate: v.gate });
    pts.push({ p: v3(g.center.x + ENTRY_EXIT * n.x, g.center.y + ENTRY_EXIT * n.y, g.center.z + ENTRY_EXIT * n.z), gateCentre: false, gate: v.gate });
  }
  return pts;
}

function durations(pts: Vec3[], speed: number, closed: boolean): number[] {
  const out: number[] = [];
  const m = closed ? pts.length : pts.length - 1;
  for (let j = 0; j < m; j++) {
    const a = pts[j];
    const b = pts[(j + 1) % pts.length];
    const d = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    out.push(Math.max(0.12, d / speed));
  }
  return out;
}

function sampleSpline(sp: PolySpline, dt = 0.01): Vec3[] {
  const out: Vec3[] = [];
  const T = sp.duration;
  const n = Math.max(2, Math.ceil(T / dt));
  for (let k = 0; k <= n; k++) out.push(sp.eval((k / n) * T * (sp.closed ? 1 - 1e-9 : 1)).p);
  return out;
}

/** Peak thrust ratio of a spline sampled at 100 Hz (|a + g| / (eta TWR g)). */
function splineFeasible(sp: PolySpline, twr: number, eta: number, thetaMaxDeg: number): boolean {
  const T = sp.duration;
  const n = Math.max(2, Math.ceil(T / 0.01));
  const tr = {
    t: new Float64Array(n + 1),
    x: new Float64Array(n + 1),
    y: new Float64Array(n + 1),
    z: new Float64Array(n + 1),
    vx: new Float64Array(n + 1),
    vy: new Float64Array(n + 1),
    vz: new Float64Array(n + 1),
    ax: new Float64Array(n + 1),
    ay: new Float64Array(n + 1),
    az: new Float64Array(n + 1),
    yaw: new Float64Array(n + 1),
    meta: { run_id: '', drone_id: 0, strategy: '', solver: '', dynamics_model: '', d_min_assumed: 0, track_id: '', sample_period: 0.01, created: '' },
  };
  for (let k = 0; k <= n; k++) {
    const e = sp.eval((k / n) * T * (sp.closed ? 1 - 1e-9 : 1));
    tr.ax[k] = e.a.x;
    tr.ay[k] = e.a.y;
    tr.az[k] = e.a.z;
  }
  return checkFeasibility(tr, 1, twr, eta, thetaMaxDeg).share === 0;
}

function fitFeasible(pts: Vec3[], speed: number, closed: boolean, o: RacingLineOptions, startVel?: Vec3): { sp: PolySpline; scale: number } {
  let durs = durations(pts, speed, closed);
  let scale = 1;
  for (let it = 0; it < 25; it++) {
    const sp = minDerivSpline(pts, durs, {
      order: 3,
      closed,
      startDerivs: closed ? undefined : [startVel ? v3(startVel.x / scale, startVel.y / scale, startVel.z / scale) : v3(), v3()],
      endDerivs: closed ? undefined : [v3(), v3()],
    });
    if (splineFeasible(sp, o.twr, o.eta, o.thetaMaxDeg)) return { sp, scale };
    scale *= 1.08;
    durs = durs.map((d) => d * 1.08);
  }
  return { sp: minDerivSpline(pts, durs, { order: 3, closed, startDerivs: closed ? undefined : [v3(), v3()], endDerivs: closed ? undefined : [v3(), v3()] }), scale };
}

// ------------------------------------------------------------------------------------------
// A* on a voxel grid
// ------------------------------------------------------------------------------------------

export interface Disc {
  c: Vec3;
  n: Vec3;
  r: number;
}

export class VoxelGrid {
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  readonly occ: Uint8Array;
  constructor(
    readonly arena: ArenaConfig,
    readonly res: number,
    obstacles: Primitive[],
    inflate: number,
    margin = 0.3,
    discs: Disc[] = [],
  ) {
    this.nx = Math.round(arena.sx / res);
    this.ny = Math.round(arena.sy / res);
    this.nz = Math.round(arena.sz / res);
    this.occ = new Uint8Array(this.nx * this.ny * this.nz);
    // arena margin
    for (let i = 0; i < this.nx; i++) {
      for (let j = 0; j < this.ny; j++) {
        for (let k = 0; k < this.nz; k++) {
          const p = this.centre(i, j, k);
          if (Math.abs(p.x) > arena.sx / 2 - margin || Math.abs(p.y) > arena.sy / 2 - margin || p.z < margin || p.z > arena.sz - margin) this.occ[this.idx(i, j, k)] = 1;
        }
      }
    }
    // obstacles: only cells inside each primitive's inflated bounds are tested
    for (const prim of obstacles) {
      if (prim.kind === 'plane') continue;
      const inf = prim.tag.source === 'gate' ? GATE_LINE_CLEARANCE + 0.03 : inflate;
      const b = primitiveBounds(prim);
      if (!b) continue;
      const [i0, j0, k0] = this.cell(v3(b.min.x - inf, b.min.y - inf, b.min.z - inf));
      const [i1, j1, k1] = this.cell(v3(b.max.x + inf, b.max.y + inf, b.max.z + inf));
      for (let i = i0; i <= i1; i++) {
        for (let j = j0; j <= j1; j++) {
          for (let k = k0; k <= k1; k++) {
            const id = this.idx(i, j, k);
            if (this.occ[id]) continue;
            if (distanceToPrimitive(this.centre(i, j, k), prim) < inf) this.occ[id] = 1;
          }
        }
      }
    }
    // gate openings that must not be crossed outside their scheduled passes
    for (const d of discs) {
      const ext = d.r + 0.1;
      const [i0, j0, k0] = this.cell(v3(d.c.x - ext, d.c.y - ext, d.c.z - ext));
      const [i1, j1, k1] = this.cell(v3(d.c.x + ext, d.c.y + ext, d.c.z + ext));
      for (let i = i0; i <= i1; i++) {
        for (let j = j0; j <= j1; j++) {
          for (let k = k0; k <= k1; k++) {
            const p = this.centre(i, j, k);
            const dx = p.x - d.c.x;
            const dy = p.y - d.c.y;
            const dz = p.z - d.c.z;
            const along = dx * d.n.x + dy * d.n.y + dz * d.n.z;
            const rad = Math.sqrt(Math.max(0, dx * dx + dy * dy + dz * dz - along * along));
            if (Math.abs(along) < 0.08 && rad < d.r) this.occ[this.idx(i, j, k)] = 1;
          }
        }
      }
    }
  }
  idx(i: number, j: number, k: number): number {
    return (i * this.ny + j) * this.nz + k;
  }
  centre(i: number, j: number, k: number): Vec3 {
    return v3(-this.arena.sx / 2 + (i + 0.5) * this.res, -this.arena.sy / 2 + (j + 0.5) * this.res, (k + 0.5) * this.res);
  }
  cell(p: Vec3): [number, number, number] {
    const c = (x: number, n: number) => Math.max(0, Math.min(n - 1, Math.floor(x)));
    return [c((p.x + this.arena.sx / 2) / this.res, this.nx), c((p.y + this.arena.sy / 2) / this.res, this.ny), c(p.z / this.res, this.nz)];
  }
  free(i: number, j: number, k: number): boolean {
    return i >= 0 && j >= 0 && k >= 0 && i < this.nx && j < this.ny && k < this.nz && this.occ[this.idx(i, j, k)] === 0;
  }

  /** 26-connected A* from a to b (endpoints are allowed to be in occupied cells). */
  astar(a: Vec3, b: Vec3, maxExpand = 200000): Vec3[] | null {
    const [ai, aj, ak] = this.cell(a);
    const [bi, bj, bk] = this.cell(b);
    const N = this.nx * this.ny * this.nz;
    const g = new Float32Array(N).fill(Infinity);
    const came = new Int32Array(N).fill(-1);
    const closed = new Uint8Array(N);
    const start = this.idx(ai, aj, ak);
    const goal = this.idx(bi, bj, bk);
    const h = (i: number, j: number, k: number) => Math.hypot(i - bi, j - bj, k - bk);
    // binary heap
    const heapI: number[] = [];
    const heapF: number[] = [];
    const push = (id: number, f: number) => {
      heapI.push(id);
      heapF.push(f);
      let c = heapI.length - 1;
      while (c > 0) {
        const p = (c - 1) >> 1;
        if (heapF[p] <= heapF[c]) break;
        [heapI[p], heapI[c]] = [heapI[c], heapI[p]];
        [heapF[p], heapF[c]] = [heapF[c], heapF[p]];
        c = p;
      }
    };
    const pop = (): number => {
      const top = heapI[0];
      const li = heapI.pop()!;
      const lf = heapF.pop()!;
      if (heapI.length) {
        heapI[0] = li;
        heapF[0] = lf;
        let c = 0;
        for (;;) {
          const l = 2 * c + 1;
          const r = l + 1;
          let m = c;
          if (l < heapI.length && heapF[l] < heapF[m]) m = l;
          if (r < heapI.length && heapF[r] < heapF[m]) m = r;
          if (m === c) break;
          [heapI[m], heapI[c]] = [heapI[c], heapI[m]];
          [heapF[m], heapF[c]] = [heapF[c], heapF[m]];
          c = m;
        }
      }
      return top;
    };
    g[start] = 0;
    push(start, h(ai, aj, ak));
    let expanded = 0;
    while (heapI.length && expanded < maxExpand) {
      const cur = pop();
      if (closed[cur]) continue;
      closed[cur] = 1;
      expanded++;
      if (cur === goal) break;
      const k = cur % this.nz;
      const j = Math.floor(cur / this.nz) % this.ny;
      const i = Math.floor(cur / (this.nz * this.ny));
      for (let di = -1; di <= 1; di++) {
        for (let dj = -1; dj <= 1; dj++) {
          for (let dk = -1; dk <= 1; dk++) {
            if (!di && !dj && !dk) continue;
            const ni = i + di;
            const nj = j + dj;
            const nk = k + dk;
            if (ni < 0 || nj < 0 || nk < 0 || ni >= this.nx || nj >= this.ny || nk >= this.nz) continue;
            const nid = this.idx(ni, nj, nk);
            if (this.occ[nid] && nid !== goal) continue;
            const ng = g[cur] + Math.hypot(di, dj, dk);
            if (ng < g[nid]) {
              g[nid] = ng;
              came[nid] = cur;
              push(nid, ng + h(ni, nj, nk));
            }
          }
        }
      }
    }
    if (!closed[goal]) return null;
    const path: Vec3[] = [];
    let c = goal;
    while (c >= 0) {
      const k = c % this.nz;
      const j = Math.floor(c / this.nz) % this.ny;
      const i = Math.floor(c / (this.nz * this.ny));
      path.push(this.centre(i, j, k));
      if (c === start) break;
      c = came[c];
    }
    path.reverse();
    path[0] = { ...a };
    path[path.length - 1] = { ...b };
    return path;
  }

  /** Line of sight through free cells (sampled every half cell). */
  lineFree(a: Vec3, b: Vec3): boolean {
    const d = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    const n = Math.max(1, Math.ceil(d / (this.res * 0.5)));
    for (let s = 1; s < n; s++) {
      const p = v3(a.x + ((b.x - a.x) * s) / n, a.y + ((b.y - a.y) * s) / n, a.z + ((b.z - a.z) * s) / n);
      const [i, j, k] = this.cell(p);
      if (!this.free(i, j, k)) return false;
    }
    return true;
  }
}

/** Remove redundant A* nodes by line-of-sight pruning. */
export function prunePath(grid: VoxelGrid, path: Vec3[]): Vec3[] {
  if (path.length <= 2) return path;
  const out = [path[0]];
  let i = 0;
  while (i < path.length - 1) {
    let j = path.length - 1;
    while (j > i + 1 && !grid.lineFree(path[i], path[j])) j--;
    out.push(path[j]);
    i = j;
  }
  return out;
}

/**
 * Samples that come closer than the clearance to any obstacle. Gate frames use a tighter
 * clearance (the line deliberately threads their openings, some only 0.30 m wide).
 */
export const GATE_LINE_CLEARANCE = 0.16;

/** Is p inside gate g's passage (threading the opening)? */
function inPassage(p: Vec3, course: Course, frames: GateFrame[], g: number): boolean {
  const G = course.gates[g];
  const f = frames[g];
  const dx = p.x - G.center.x;
  const dy = p.y - G.center.y;
  const dz = p.z - G.center.z;
  const along = dx * f.n.x + dy * f.n.y + dz * f.n.z;
  const rad = Math.sqrt(Math.max(0, dx * dx + dy * dy + dz * dz - along * along));
  return Math.abs(along) < 0.45 && rad < f.rIn;
}

function collidingSamples(samples: Vec3[], obstacles: Primitive[], clearance: number, course?: Course, frames?: GateFrame[]): number[] {
  const bad: number[] = [];
  const bounds = obstacles.map((p) => primitiveBounds(p));
  // gate frames: keep the filter's clearance plus a buffer, except while threading the opening
  const cl = (prim: Primitive, p: Vec3) => {
    if (prim.tag.source !== 'gate') return clearance;
    if (course && frames && prim.tag.gateIndex !== undefined && prim.tag.part === 'frame' && inPassage(p, course, frames, prim.tag.gateIndex)) return DRONE_RADIUS + 0.03;
    return GATE_LINE_CLEARANCE;
  };
  for (let i = 0; i < samples.length; i++) {
    const p = samples[i];
    for (let q = 0; q < obstacles.length; q++) {
      const prim = obstacles[q];
      if (prim.kind === 'plane') continue;
      const c = cl(prim, p);
      if (!nearBounds(p, bounds[q], c)) continue;
      if (distanceToPrimitive(p, prim) < c) {
        bad.push(i);
        break;
      }
    }
  }
  return bad;
}

/**
 * Samples where the line crosses a gate opening other than at a scheduled pass (backwards, or a
 * gate that is not next): the drone would fly through a gate it should not.
 */
function unscheduledCrossings(samples: Vec3[], course: Course, frames: GateFrame[], sp: PolySpline, centres: { idx: number; gate: number; reverse: boolean }[]): number[] {
  const bad: number[] = [];
  const T = sp.duration;
  const tAt = (k: number) => (k / (samples.length - 1)) * T;
  for (let k = 0; k < samples.length - 1; k++) {
    const a = samples[k];
    const b = samples[k + 1];
    for (let g = 0; g < course.gates.length; g++) {
      const G = course.gates[g];
      const f = frames[g];
      const sa = (a.x - G.center.x) * f.n.x + (a.y - G.center.y) * f.n.y + (a.z - G.center.z) * f.n.z;
      const sb = (b.x - G.center.x) * f.n.x + (b.y - G.center.y) * f.n.y + (b.z - G.center.z) * f.n.z;
      if ((sa < 0 && sb < 0) || (sa > 0 && sb > 0) || sa === sb) continue;
      const u = sa / (sa - sb);
      const x = v3(a.x + (b.x - a.x) * u - G.center.x, a.y + (b.y - a.y) * u - G.center.y, a.z + (b.z - a.z) * u - G.center.z);
      const al = x.x * f.n.x + x.y * f.n.y + x.z * f.n.z;
      const rad = Math.sqrt(Math.max(0, x.x * x.x + x.y * x.y + x.z * x.z - al * al));
      if (rad > f.rIn + 0.1) continue;
      const forward = sb > sa;
      const t = tAt(k);
      const scheduled = centres.some((c) => c.gate === g && forward === !c.reverse && Math.abs(sp.starts[Math.min(c.idx, sp.starts.length - 1)] - t) < 0.6);
      if (!scheduled) bad.push(k);
    }
  }
  return bad;
}

/** Arena-bounds violations of the samples (margin 0.3 m). */
function outOfArena(samples: Vec3[], arena: ArenaConfig, margin = 0.3): number[] {
  const bad: number[] = [];
  samples.forEach((p, i) => {
    if (Math.abs(p.x) > arena.sx / 2 - margin || Math.abs(p.y) > arena.sy / 2 - margin || p.z < margin || p.z > arena.sz - margin) bad.push(i);
  });
  return bad;
}

export function buildRacingLine(course: Course, o: RacingLineOptions): RacingLine {
  const frames = course.gates.map(gateFrame);
  const seq = o.sequence ?? course.sequence;
  const closed = course.closed;
  const vps = visitPoints(course, seq, frames);
  let pts: Vec3[] = [];
  // fixed (gate) points must stay; detours are inserted between consecutive points
  let fixed: boolean[] = [];
  // gate-centre role of each waypoint (for the scheduled-crossing check)
  let roles: ({ gate: number; reverse: boolean } | null)[] = [];
  vps.forEach((v, k) => {
    pts.push(v.p);
    fixed.push(true);
    roles.push(v.gateCentre ? { gate: v.gate, reverse: !!seq[Math.floor(k / 3)].reverse } : null);
    // course-defined via points after a visit's exit point
    if (k % 3 === 2 && !o.sequence) {
      const visitIdx = (k - 2) / 3;
      for (const via of course.via ?? []) {
        if (via.after === visitIdx) {
          for (const q of via.points) {
            pts.push({ ...q });
            fixed.push(false);
            roles.push(null);
          }
        }
      }
    }
  });
  let startVel: Vec3 | undefined;
  if (!closed) {
    const first = pts[0];
    const n0 = v3(pts[1].x - first.x, pts[1].y - first.y, pts[1].z - first.z);
    const l0 = Math.hypot(n0.x, n0.y, n0.z) || 1;
    const dir0 = v3(n0.x / l0, n0.y / l0, n0.z / l0);
    const start = clampArena(v3(first.x - 1.2 * dir0.x, first.y - 1.2 * dir0.y, first.z - 1.2 * dir0.z), o.arena);
    const last = pts[pts.length - 1];
    const nl = v3(last.x - pts[pts.length - 2].x, last.y - pts[pts.length - 2].y, last.z - pts[pts.length - 2].z);
    const ll = Math.hypot(nl.x, nl.y, nl.z) || 1;
    // end well inside the nets: the drone decelerates to rest here and may overshoot slightly
    const end = clampArena(v3(last.x + (1.2 * nl.x) / ll, last.y + (1.2 * nl.y) / ll, last.z + (1.2 * nl.z) / ll), o.arena, 0.9);
    pts = [start, ...pts, end];
    fixed = [true, ...fixed, true];
    roles = [null, ...roles, null];
    startVel = v3(dir0.x * o.speed, dir0.y * o.speed, dir0.z * o.speed);
  } else {
    // start point midway between the last exit and the first entry, so s = 0 is on a straight
    const a = pts[pts.length - 1];
    const b = pts[0];
    const mid = v3((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
    pts = [mid, ...pts];
    fixed = [false, ...fixed];
    roles = [null, ...roles];
  }
  const obstacles = lineObstacles(course, o.arena);
  const clearance = o.clearance ?? DRONE_RADIUS + 0.12;
  const searchPaths: Vec3[][] = [];
  let grid: VoxelGrid | null = null;
  let fit = fitFeasible(pts, o.speed, closed, o, startVel);
  let samples = sampleSpline(fit.sp);
  const centresOf = () => roles.map((r, idx) => (r ? { idx, gate: r.gate, reverse: r.reverse } : null)).filter((x): x is { idx: number; gate: number; reverse: boolean } => !!x);
  const discs: Disc[] = course.gates.map((g, i) => ({ c: g.center, n: frames[i].n, r: frames[i].rIn + 0.08 }));
  for (let iter = 0; iter < 6; iter++) {
    const bad = [...new Set([...collidingSamples(samples, obstacles, clearance, course, frames), ...outOfArena(samples, o.arena), ...unscheduledCrossings(samples, course, frames, fit.sp, centresOf())])].sort((a, b) => a - b);
    if (!bad.length) break;
    // map bad samples to spline segments (by time)
    const T = fit.sp.duration;
    const segs = new Set<number>();
    for (const k of bad) {
      const t = (k / (samples.length - 1)) * T;
      let seg = 0;
      while (seg < fit.sp.starts.length - 2 && t > fit.sp.starts[seg + 1]) seg++;
      segs.add(seg);
    }
    if (!grid) grid = new VoxelGrid(o.arena, 0.1, obstacles, clearance + 0.05, 0.3, discs);
    const insert = new Map<number, Vec3[]>();
    for (const seg of segs) {
      const a = pts[seg];
      const b = pts[(seg + 1) % pts.length];
      const path = grid.astar(a, b);
      if (path && path.length > 2) {
        searchPaths.push(path);
        const pr = prunePath(grid, path);
        let mids = pr.slice(1, -1);
        if (!mids.length) mids = [path[Math.floor(path.length / 2)]];
        insert.set(seg, mids);
      } else {
        // no search path: push a midpoint up and away from the obstacle (fallback)
        const m = v3((a.x + b.x) / 2, (a.y + b.y) / 2, Math.min(o.arena.sz - 0.5, (a.z + b.z) / 2 + 0.3));
        insert.set(seg, [m]);
      }
    }
    const np: Vec3[] = [];
    const nf: boolean[] = [];
    const nr: typeof roles = [];
    pts.forEach((p, i) => {
      np.push(p);
      nf.push(fixed[i]);
      nr.push(roles[i]);
      const add = insert.get(i);
      if (add) {
        for (const q of add) {
          np.push(q);
          nf.push(false);
          nr.push(null);
        }
      }
    });
    pts = np;
    fixed = nf;
    roles = nr;
    fit = fitFeasible(pts, o.speed, closed, o, startVel);
    samples = sampleSpline(fit.sp);
  }
  const collisions = collidingSamples(samples, obstacles, DRONE_RADIUS + 0.02, course, frames).length;
  const track = trackFromLine(course, samples, closed, frames, seq, obstacles);
  return { waypoints: pts, spline: fit.sp, samples, track, duration: fit.sp.duration, searchPaths, collisions, feasibilityScale: fit.scale, closed };
}

function clampArena(p: Vec3, a: ArenaConfig, m = 0.4): Vec3 {
  return v3(Math.max(-a.sx / 2 + m, Math.min(a.sx / 2 - m, p.x)), Math.max(-a.sy / 2 + m, Math.min(a.sy / 2 - m, p.y)), Math.max(m, Math.min(a.sz - m, p.z)));
}

/**
 * Track along the racing line: half-width 0.5 m (lateral) and 0.3 m (vertical) on open
 * stretches, shrinking smoothly to the gate's pass radius within 0.6 m of each gate centre and
 * to the free clearance next to obstacles.
 */
export function trackFromLine(course: Course, samples: Vec3[], closed: boolean, frames: GateFrame[], seq: GateVisit[], obstacles: Primitive[]): Track {
  const gates = [...new Set(seq.map((v) => v.gate))];
  const gateLimit = (p: Vec3, base: number) => {
    let w = base;
    for (const gi of gates) {
      const g = course.gates[gi];
      const d = Math.hypot(p.x - g.center.x, p.y - g.center.y, p.z - g.center.z);
      const rp = Math.max(0.02, frames[gi].rPass - 0.03);
      if (d < 0.6) w = Math.min(w, rp);
      else if (d < 1.2) w = Math.min(w, rp + ((base - rp) * (d - 0.6)) / 0.6);
    }
    return w;
  };
  const obsLimit = (p: Vec3, base: number) => {
    let w = base;
    for (const prim of obstacles) {
      if (prim.kind === 'plane' || prim.tag.source === 'gate') continue;
      if (!nearBounds(p, primitiveBounds(prim), base + 0.3)) continue;
      const d = distanceToPrimitive(p, prim) - DRONE_RADIUS - 0.08;
      w = Math.min(w, Math.max(0.03, d));
    }
    return w;
  };
  return makeTrack(samples, {
    id: course.id,
    closed,
    ds: 0.05,
    halfWidth: (_s, p) => Math.min(gateLimit(p, 0.5), obsLimit(p, 0.5)),
    halfHeight: (_s, p) => Math.min(gateLimit(p, 0.3), obsLimit(p, 0.3)),
  });
}
