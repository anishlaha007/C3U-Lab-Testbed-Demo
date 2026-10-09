/**
 * Ring gates and obstacles (Section 5.2b): geometry, collision primitives, dynamic obstacle
 * motion and gate pass detection.
 *
 * Gate model: a regular octagon of tube segments (radius 0.02 m) in the plane normal to the
 * gate's facing direction. The outer diameter D is measured over the tube, so the tube
 * centreline has circumradius R_c = D/2 - r_tube and inscribed radius r_in = R_c cos(pi/8).
 * A drone passes cleanly when its centre crosses the gate plane, in the gate direction, within
 * r_pass = r_in - r_tube - r_drone of the centre.
 */
import { DRONE_RADIUS } from './constants';
import { arenaPlanes, type Primitive } from './geometry';
import type { ArenaConfig, Course, Gate, Obstacle } from './types';
import { v3, type Vec3 } from './vec';

export const GATE_TUBE_R = 0.02;
export const POLE_R = 0.015;
export const LEG_SPAN = 0.6;
export const CABLE_R = 0.004;

export interface GateFrame {
  /** Unit normal (pass direction). */
  n: Vec3;
  /** In-plane lateral axis. */
  l: Vec3;
  /** In-plane "up" axis. */
  u: Vec3;
  /** Octagon vertices (tube centreline). */
  verts: Vec3[];
  Rc: number;
  rIn: number;
  /** Clear inner radius (inscribed minus tube). */
  rClear: number;
  /** Pass radius for the drone centre. */
  rPass: number;
}

export function gateFrame(g: Gate): GateFrame {
  const cy = Math.cos(g.yaw);
  const sy = Math.sin(g.yaw);
  const n0 = v3(cy, sy, 0);
  const l = v3(-sy, cy, 0);
  const cp = Math.cos(g.pitch);
  const sp = Math.sin(g.pitch);
  // tilt about the lateral axis: the normal pitches up by `pitch`
  const n = v3(cp * n0.x, cp * n0.y, sp);
  const u = v3(-sp * n0.x, -sp * n0.y, cp);
  const Rc = g.diameter / 2 - GATE_TUBE_R;
  const verts: Vec3[] = [];
  for (let k = 0; k < 8; k++) {
    const phi = Math.PI / 8 + (k * Math.PI) / 4;
    const c = Math.cos(phi) * Rc;
    const s = Math.sin(phi) * Rc;
    verts.push(v3(g.center.x + c * l.x + s * u.x, g.center.y + c * l.y + s * u.y, g.center.z + c * l.z + s * u.z));
  }
  const rIn = Rc * Math.cos(Math.PI / 8);
  const rClear = rIn - GATE_TUBE_R;
  return { n, l, u, verts, Rc, rIn, rClear, rPass: Math.max(0.01, rClear - DRONE_RADIUS) };
}

/** Outer diameter for a desired clear inner diameter (e.g. the 0.30 m pinch ring). */
export function diameterForInner(innerDiameter: number): number {
  const rIn = innerDiameter / 2 + GATE_TUBE_R;
  const Rc = rIn / Math.cos(Math.PI / 8);
  return 2 * (Rc + GATE_TUBE_R);
}

/** Static collision primitives of a gate (frame edges, stand or cables). */
export function gatePrimitives(g: Gate, gateIndex: number, ceilingZ: number): Primitive[] {
  const f = gateFrame(g);
  const out: Primitive[] = [];
  const zero = v3();
  for (let k = 0; k < 8; k++) {
    out.push({
      kind: 'capsule',
      a: f.verts[k],
      b: f.verts[(k + 1) % 8],
      r: GATE_TUBE_R,
      vel: zero,
      acc: zero,
      tag: { source: 'gate', id: `${g.id}:edge${k}`, gateIndex, part: 'frame' },
    });
  }
  if (g.mount === 'stand') {
    // bottom flat edge midpoint is at centre - r_in * u; the pole runs from just below it to the floor
    const top = v3(g.center.x - (f.rIn + GATE_TUBE_R) * f.u.x, g.center.y - (f.rIn + GATE_TUBE_R) * f.u.y, g.center.z - (f.rIn + GATE_TUBE_R) * f.u.z);
    const foot = v3(top.x, top.y, 0.02);
    if (top.z > foot.z) {
      out.push({ kind: 'capsule', a: top, b: foot, r: POLE_R, vel: zero, acc: zero, tag: { source: 'gate', id: `${g.id}:pole`, gateIndex, part: 'pole' } });
    }
    for (let k = 0; k < 4; k++) {
      const ang = g.yaw + Math.PI / 4 + (k * Math.PI) / 2;
      const end = v3(foot.x + (LEG_SPAN / 2) * Math.cos(ang), foot.y + (LEG_SPAN / 2) * Math.sin(ang), 0.02);
      out.push({ kind: 'capsule', a: foot, b: end, r: POLE_R, vel: zero, acc: zero, tag: { source: 'gate', id: `${g.id}:leg${k}`, gateIndex, part: 'leg' } });
    }
  } else {
    // two cables from the top flat edge's corners (vertices 1 and 2) to the ceiling truss
    for (const k of [1, 2]) {
      const a = f.verts[k];
      out.push({ kind: 'capsule', a, b: v3(a.x, a.y, ceilingZ), r: CABLE_R, vel: zero, acc: zero, tag: { source: 'gate', id: `${g.id}:cable${k}`, gateIndex, part: 'cable' } });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Obstacles
// ---------------------------------------------------------------------------------------------

export interface PendulumState {
  bob: Vec3;
  vel: Vec3;
  acc: Vec3;
  theta: number;
}

export function pendulumState(o: Extract<Obstacle, { kind: 'pendulum' }>, t: number): PendulumState {
  const w = (2 * Math.PI) / o.period;
  const th = o.amplitude * Math.sin(w * t + o.phase);
  const thd = o.amplitude * w * Math.cos(w * t + o.phase);
  const thdd = -o.amplitude * w * w * Math.sin(w * t + o.phase);
  const e = v3(Math.cos(o.swingYaw), Math.sin(o.swingYaw), 0);
  const s = Math.sin(th);
  const c = Math.cos(th);
  const L = o.length;
  const bob = v3(o.pivot.x + L * s * e.x, o.pivot.y + L * s * e.y, o.pivot.z - L * c);
  // d/dt (s e - c ez) = thd (c e + s ez)
  const tang = v3(c * e.x, c * e.y, s);
  const norml = v3(-s * e.x, -s * e.y, c);
  const vel = v3(L * thd * tang.x, L * thd * tang.y, L * thd * tang.z);
  const acc = v3(L * (thdd * tang.x + thd * thd * norml.x), L * (thdd * tang.y + thd * thd * norml.y), L * (thdd * tang.z + thd * thd * norml.z));
  return { bob, vel, acc, theta: th };
}

export interface SliderState {
  c: Vec3;
  vel: Vec3;
  acc: Vec3;
}

export function sliderState(o: Extract<Obstacle, { kind: 'slider' }>, t: number): SliderState {
  const w = (2 * Math.PI) / o.period;
  const e = v3(Math.cos(o.yaw), Math.sin(o.yaw), 0);
  const s = o.travel * Math.sin(w * t + o.phase);
  const sd = o.travel * w * Math.cos(w * t + o.phase);
  const sdd = -o.travel * w * w * Math.sin(w * t + o.phase);
  return {
    c: v3(o.center.x + s * e.x, o.center.y + s * e.y, o.center.z),
    vel: v3(sd * e.x, sd * e.y, 0),
    acc: v3(sdd * e.x, sdd * e.y, 0),
  };
}

export function isDynamic(o: Obstacle): boolean {
  return o.kind === 'pendulum' || o.kind === 'slider';
}

/** Collision primitives of an obstacle at race time t (dynamic obstacles frozen if !dynamicOn). */
export function obstaclePrimitives(o: Obstacle, t: number, dynamicOn: boolean): Primitive[] {
  const zero = v3();
  const tt = dynamicOn ? t : 0;
  switch (o.kind) {
    case 'pillar':
      return [{ kind: 'cylinder', cx: o.x, cy: o.y, r: o.radius, zMin: 0, zMax: o.height, vel: zero, acc: zero, tag: { source: 'obstacle', id: o.id } }];
    case 'box':
      return [{ kind: 'box', c: o.center, half: v3(o.size.x / 2, o.size.y / 2, o.size.z / 2), yaw: o.yaw, vel: zero, acc: zero, tag: { source: 'obstacle', id: o.id } }];
    case 'pendulum': {
      const s = pendulumState(o, tt);
      const vel = dynamicOn ? s.vel : zero;
      const acc = dynamicOn ? s.acc : zero;
      return [
        { kind: 'sphere', c: s.bob, r: o.bobRadius, vel, acc, tag: { source: 'obstacle', id: o.id } },
        {
          kind: 'capsule',
          a: o.pivot,
          b: s.bob,
          r: CABLE_R,
          vel: v3(vel.x * 0.5, vel.y * 0.5, vel.z * 0.5),
          acc: v3(acc.x * 0.5, acc.y * 0.5, acc.z * 0.5),
          tag: { source: 'obstacle', id: `${o.id}:cable` },
        },
      ];
    }
    case 'slider': {
      const s = sliderState(o, tt);
      return [
        {
          kind: 'box',
          c: s.c,
          half: v3(o.size.x / 2, o.size.y / 2, o.size.z / 2),
          yaw: o.yaw,
          vel: dynamicOn ? s.vel : zero,
          acc: dynamicOn ? s.acc : zero,
          tag: { source: 'obstacle', id: o.id },
        },
      ];
    }
  }
}

/** Precomputed static primitives of a course plus a function for the dynamic ones. */
export class CourseGeometry {
  readonly staticPrims: Primitive[];
  readonly gateFrames: GateFrame[];
  private readonly dynamicObs: Obstacle[];
  constructor(
    readonly course: Course | null,
    readonly arena: ArenaConfig,
    readonly dynamicOn: boolean,
    includeArena = true,
  ) {
    const prims: Primitive[] = [];
    const dyn: Obstacle[] = [];
    if (course) {
      course.gates.forEach((g, i) => prims.push(...gatePrimitives(g, i, arena.sz + 0.1)));
      for (const o of course.obstacles) {
        if (isDynamic(o)) dyn.push(o);
        else prims.push(...obstaclePrimitives(o, 0, false));
      }
    }
    if (includeArena) prims.push(...arenaPlanes(arena.sx, arena.sy, arena.sz));
    this.staticPrims = prims;
    this.dynamicObs = dyn;
    this.gateFrames = course ? course.gates.map(gateFrame) : [];
  }

  /** All primitives at race time t. */
  primitives(t: number): Primitive[] {
    if (!this.dynamicObs.length) return this.staticPrims;
    const out = this.staticPrims.slice();
    for (const o of this.dynamicObs) out.push(...obstaclePrimitives(o, t, this.dynamicOn));
    return out;
  }

  /** Solid primitives only (no arena planes) for collision checks. */
  solidPrimitives(t: number): Primitive[] {
    return this.primitives(t).filter((p) => p.kind !== 'plane');
  }
}

// ---------------------------------------------------------------------------------------------
// Pass detection
// ---------------------------------------------------------------------------------------------

export type CrossingResult = { kind: 'none' } | { kind: 'pass'; r: number } | { kind: 'miss'; r: number; reason: 'outside' | 'wrongWay' };

/**
 * Check whether the segment p0 -> p1 crosses the gate plane near the gate.
 * @param reverse the visit passes the gate against its normal
 */
export function gateCrossing(g: Gate, f: GateFrame, p0: Vec3, p1: Vec3, reverse = false): CrossingResult {
  const sgn = reverse ? -1 : 1;
  const s0 = sgn * ((p0.x - g.center.x) * f.n.x + (p0.y - g.center.y) * f.n.y + (p0.z - g.center.z) * f.n.z);
  const s1 = sgn * ((p1.x - g.center.x) * f.n.x + (p1.y - g.center.y) * f.n.y + (p1.z - g.center.z) * f.n.z);
  if ((s0 < 0 && s1 < 0) || (s0 > 0 && s1 > 0) || s0 === s1) return { kind: 'none' };
  const t = s0 / (s0 - s1);
  const x = v3(p0.x + (p1.x - p0.x) * t - g.center.x, p0.y + (p1.y - p0.y) * t - g.center.y, p0.z + (p1.z - p0.z) * t - g.center.z);
  const along = x.x * f.n.x + x.y * f.n.y + x.z * f.n.z;
  const r = Math.sqrt(Math.max(0, x.x * x.x + x.y * x.y + x.z * x.z - along * along));
  // ignore crossings of the infinite plane far from the gate
  if (r > g.diameter / 2 + 0.6) return { kind: 'none' };
  if (s0 > 0 && s1 <= 0) return r < f.rPass ? { kind: 'miss', r, reason: 'wrongWay' } : { kind: 'none' };
  if (r < f.rPass) return { kind: 'pass', r };
  return { kind: 'miss', r, reason: 'outside' };
}
