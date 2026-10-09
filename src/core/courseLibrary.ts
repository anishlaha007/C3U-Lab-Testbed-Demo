/**
 * Course presets C1-C12 (Section 5.2b) and the gate layouts used by the race loop (T9), pinch
 * (T4) and split-S (T3) scenarios. Coordinates in the core frame (z-up, origin at the arena floor
 * centre). Each course carries a difficulty rating and a recommended arena size.
 */
import { diameterForInner } from './course';
import { COURSE_INFO } from './courses';
import { deriveSeed, Rng } from './rng';
import type { Course, CourseId, CourseParams, Gate, GateVisit, Obstacle } from './types';
import { v3 } from './vec';

const COLORS = ['#3b82f6', '#ef4444', '#eab308', '#22c55e', '#a855f7', '#f97316', '#06b6d4', '#ec4899', '#84cc16', '#f43f5e', '#14b8a6', '#8b5cf6'];

const deg = (d: number) => (d * Math.PI) / 180;

function gate(i: number, x: number, y: number, z: number, yawDeg: number, diameter = 0.8, mount: Gate['mount'] = 'stand', pitchDeg = 0): Gate {
  return { id: `G${i + 1}`, center: v3(x, y, z), yaw: deg(yawDeg), pitch: deg(pitchDeg), diameter, color: COLORS[i % COLORS.length], mount };
}

function seqOf(n: number): GateVisit[] {
  return Array.from({ length: n }, (_, i) => ({ gate: i }));
}

function info(id: CourseId) {
  return COURSE_INFO.find((c) => c.id === id)!;
}

function base(id: CourseId, gates: Gate[], extra: Partial<Course> = {}): Course {
  const ci = info(id);
  return {
    id,
    name: `${id} ${ci.name}`,
    difficulty: ci.difficulty,
    description: `${ci.layout}. ${ci.hard}.`,
    gates,
    obstacles: [],
    sequence: seqOf(gates.length),
    closed: true,
    laps: 1,
    arena: { sx: 8, sy: 5, sz: 3 },
    targetSpeed: 1.8,
    ...extra,
  };
}

/** C1 Slalom: 6 gates in a zig-zag line, alternating left/right (1 m apart) and 0.8 / 1.4 m high. */
function slalom(): Course {
  const gates = Array.from({ length: 6 }, (_, i) => gate(i, -2.75 + i * 1.1, i % 2 === 0 ? 0.5 : -0.5, i % 2 === 0 ? 0.8 : 1.4, 0));
  return base('C1', gates, { closed: false, targetSpeed: 1.5 });
}

/** C2 Hairpin: two gates 1.2 m apart facing opposite directions, then a third back the way you came. */
function hairpin(): Course {
  const gates = [gate(0, 1.4, 0.6, 1.0, 0), gate(1, 1.4, -0.6, 1.0, 180), gate(2, -1.6, -0.6, 1.2, 180)];
  return base('C2', gates, { targetSpeed: 1.6 });
}

/** C3 Corkscrew: 6 gates on a rising helix (radius 1.5 m, climbing 1.2 m), 60 deg apart. */
function corkscrew(): Course {
  const gates = Array.from({ length: 6 }, (_, i) => {
    const th = deg(-90 + i * 60);
    return gate(i, 1.5 * Math.cos(th), 1.5 * Math.sin(th), 0.6 + (1.2 * i) / 5, (th * 180) / Math.PI + 90, 0.8);
  });
  return base('C3', gates, { closed: false, targetSpeed: 1.5 });
}

/**
 * C4 Ladder dive: gates stacked vertically (0.6 / 1.2 / 1.8 m) entered in alternating directions
 * (a split-S descent), staggered so hanging cables stay clear of the flight path.
 */
function ladderDive(): Course {
  const gates = [gate(0, 0.6, -0.35, 1.8, 0, 0.55, 'hanging'), gate(1, 0.0, 0.0, 1.2, 180, 0.55, 'hanging'), gate(2, -0.6, 0.35, 0.6, 0, 0.55, 'stand')];
  // after the bottom gate, climb back around the stack on the +y side to re-enter the top gate
  const via = [{ after: 2, points: [v3(1.6, 1.0, 0.9), v3(0.2, 1.8, 1.5), v3(-1.7, 0.6, 1.9), v3(-0.9, -0.35, 1.8)] }];
  return base('C4', gates, { via, targetSpeed: 1.3 });
}

/** C5 Keyhole: a 0.45 m gate directly behind a pillar. */
function keyhole(): Course {
  const gates = [gate(0, -2.2, -0.4, 1.0, 0), gate(1, 1.6, -0.4, 1.0, 0, 0.45), gate(2, 1.0, 1.4, 1.3, 180), gate(3, -2.3, 1.2, 1.1, 210)];
  const obstacles: Obstacle[] = [{ kind: 'pillar', id: 'P1', x: 0.6, y: -0.4, radius: 0.15, height: 2.6 }];
  return base('C5', gates, { obstacles, targetSpeed: 1.4 });
}

/** C6 Forest: 5 gates through a field of 8-12 seeded pillars. */
function forest(pillars: number, seed: number): Course {
  const gates = [gate(0, -2.6, -0.2, 1.0, -60), gate(1, -0.6, -1.4, 1.2, 0), gate(2, 2.3, -0.9, 1.0, 60), gate(3, 2.0, 1.3, 1.3, 160), gate(4, -0.9, 1.4, 1.1, 200)];
  const rng = new Rng(deriveSeed(seed, 'forest'));
  const obstacles: Obstacle[] = [];
  let guard = 0;
  while (obstacles.length < pillars && guard++ < 2000) {
    const x = rng.uniform(-3.2, 3.2);
    const y = rng.uniform(-1.9, 1.9);
    const r = rng.uniform(0.05, 0.2);
    // keep gates, their entry/exit lines and other pillars clear
    const nearGate = gates.some((g) => {
      const dx = x - g.center.x;
      const dy = y - g.center.y;
      const along = dx * Math.cos(g.yaw) + dy * Math.sin(g.yaw);
      const across = -dx * Math.sin(g.yaw) + dy * Math.cos(g.yaw);
      return Math.hypot(dx, dy) < 0.75 + r || (Math.abs(along) < 0.9 && Math.abs(across) < g.diameter / 2 + 0.25 + r);
    });
    const nearPillar = obstacles.some((o) => o.kind === 'pillar' && Math.hypot(o.x - x, o.y - y) < o.radius + r + 0.55);
    if (nearGate || nearPillar) continue;
    obstacles.push({ kind: 'pillar', id: `P${obstacles.length + 1}`, x, y, radius: r, height: 2.7 });
  }
  return base('C6', gates, { obstacles, targetSpeed: 1.4 });
}

/** C7 Gauntlet: 4 gates with a swinging pendulum and a sliding panel between them. */
function gauntlet(): Course {
  const gates = [gate(0, -2.8, -0.6, 1.2, 0), gate(1, 0.2, -0.6, 1.2, 0), gate(2, 2.9, 0.6, 1.2, 90), gate(3, -0.6, 1.3, 1.2, 180)];
  const obstacles: Obstacle[] = [
    { kind: 'pendulum', id: 'pendulum', pivot: v3(-1.3, -0.6, 3.05), length: 1.85, bobRadius: 0.12, amplitude: 0.5, period: 2.6, phase: 0, swingYaw: deg(90) },
    { kind: 'slider', id: 'slider', center: v3(1.6, -0.6, 1.2), size: v3(0.06, 0.6, 0.7), yaw: deg(90), travel: 0.55, period: 3.0, phase: Math.PI / 2 },
  ];
  return base('C7', gates, { obstacles, targetSpeed: 1.5 });
}

/** C8 Merge: two side-by-side gates feeding the single 0.30 m pinch ring. */
function merge(): Course {
  const gates = [gate(0, -2.0, 0.45, 1.0, 0, 0.7), gate(1, -2.0, -0.45, 1.0, 0, 0.7), gate(2, 0.6, 0, 1.0, 0, diameterForInner(0.3)), gate(3, 2.6, 0, 1.0, 0, 0.8)];
  return base('C8', gates, {
    closed: false,
    sequence: [{ gate: 2 }, { gate: 3 }],
    droneSequences: [
      [{ gate: 0 }, { gate: 2 }, { gate: 3 }],
      [{ gate: 1 }, { gate: 2 }, { gate: 3 }],
    ],
    targetSpeed: 1.6,
  });
}

/** C9 Figure-8 circuit: 5 gates on a 5 m x 4.4 m figure-8; the centre gate is passed twice. */
function figure8Circuit(): Course {
  // lemniscate x = 2.5 sin th, y = 2.2 sin 2th: centre (twice, heading +y), lobe gates at th = pi/4 + k pi/2
  const pt = (th: number) => ({ x: 2.5 * Math.sin(th), y: 2.2 * Math.sin(2 * th), dx: 2.5 * Math.cos(th), dy: 4.4 * Math.cos(2 * th) });
  const yawAt = (th: number) => (Math.atan2(pt(th).dy, pt(th).dx) * 180) / Math.PI;
  const lobe = [Math.PI / 4, (3 * Math.PI) / 4, (5 * Math.PI) / 4, (7 * Math.PI) / 4];
  const gates = [gate(0, 0, 0, 1.2, 90, 0.8), ...lobe.map((th, k) => gate(k + 1, pt(th).x, pt(th).y, k % 2 === 0 ? 1.4 : 1.0, yawAt(th), 0.8))];
  const sequence: GateVisit[] = [{ gate: 0 }, { gate: 1 }, { gate: 2 }, { gate: 0 }, { gate: 3 }, { gate: 4 }];
  return base('C9', gates, { sequence, arena: { sx: 8, sy: 6, sz: 3 }, targetSpeed: 2.0 });
}

/** C10 Complex circuit: 6 gates including a split-S pair plus 4 pillars on an 8 m x 7 m course. */
function complex(): Course {
  const gates = [
    gate(0, -3.0, -2.4, 1.2, 0),
    gate(1, 0.5, -2.8, 1.0, 0),
    // split-S pair: upper gate heading north, lower gate stacked below heading south
    gate(2, 3.3, -1.2, 1.95, 90, 0.7, 'hanging'),
    gate(3, 3.3, -1.2, 0.75, 270, 0.7, 'stand'),
    gate(4, 0.3, -0.4, 1.0, 150),
    gate(5, -2.4, 1.9, 1.6, 150),
  ];
  const obstacles: Obstacle[] = [
    { kind: 'pillar', id: 'P1', x: -1.3, y: -2.2, radius: 0.12, height: 2.9 },
    { kind: 'pillar', id: 'P2', x: 2.2, y: -2.4, radius: 0.12, height: 2.9 },
    { kind: 'pillar', id: 'P3', x: 1.7, y: 0.4, radius: 0.12, height: 2.9 },
    { kind: 'pillar', id: 'P4', x: -1.2, y: 1.2, radius: 0.12, height: 2.9 },
  ];
  // split-S: after the upper gate, carry on north and dive back south through the lower gate;
  // after the last gate, swing down the west side back to the start
  const via = [
    { after: 2, points: [v3(3.3, -0.2, 1.5)] },
    { after: 5, points: [v3(-3.6, 0.6, 1.4), v3(-3.6, -1.4, 1.2)] },
  ];
  return base('C10', gates, { obstacles, via, arena: { sx: 9, sy: 8, sz: 3.2 }, targetSpeed: 2.0 });
}

/**
 * C11 random course generator: gates along a seeded closed loop whose curvature grows with the
 * turn-angle and difficulty settings; pillars seeded near (not on) the line; optional pendulum.
 */
export function randomCourse(p: CourseParams['random']): Course {
  const rng = new Rng(deriveSeed(p.seed, 'randomCourse'));
  const N = Math.max(4, Math.min(12, Math.round(p.gateCount)));
  const ax = 2.9;
  const ay = 1.6;
  const wobble = 0.12 + 0.22 * ((p.turnAngle - 20) / 130) + 0.03 * p.difficulty;
  const harmonics = Array.from({ length: 3 }, (_, k) => ({ a: rng.uniform(-wobble, wobble) / (k + 1), ph: rng.uniform(0, 2 * Math.PI), m: k + 2 }));
  const r = (th: number) => 1 + harmonics.reduce((s, h) => s + h.a * Math.sin(h.m * th + h.ph), 0);
  const P = (th: number) => ({ x: ax * r(th) * Math.cos(th), y: ay * r(th) * Math.sin(th) });
  const gates: Gate[] = [];
  const phase0 = rng.uniform(0, 2 * Math.PI);
  for (let i = 0; i < N; i++) {
    const th = phase0 + (2 * Math.PI * i) / N + rng.uniform(-0.15, 0.15) * (2 * Math.PI) / N;
    const a = P(th);
    const b = P(th + 0.01);
    const yaw = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
    const z = 1.2 + rng.uniform(-p.heightVariation, p.heightVariation);
    const dia = Math.max(0.45, Math.min(1.2, p.gateSize + rng.uniform(-0.1, 0.1) * (p.difficulty / 5)));
    gates.push(gate(i, Math.max(-3.2, Math.min(3.2, a.x)), Math.max(-1.9, Math.min(1.9, a.y)), Math.max(0.6, Math.min(1.9, z)), yaw, dia));
  }
  const obstacles: Obstacle[] = [];
  const nP = Math.round(p.obstacleDensity * 10);
  let guard = 0;
  while (obstacles.length < nP && guard++ < 3000) {
    const x = rng.uniform(-3.2, 3.2);
    const y = rng.uniform(-1.9, 1.9);
    const rad = rng.uniform(0.06, 0.18);
    if (gates.some((g) => Math.hypot(x - g.center.x, y - g.center.y) < 0.9)) continue;
    if (obstacles.some((o) => o.kind === 'pillar' && Math.hypot(o.x - x, o.y - y) < 0.6)) continue;
    obstacles.push({ kind: 'pillar', id: `P${obstacles.length + 1}`, x, y, radius: rad, height: 2.7 });
  }
  if (p.dynamic) {
    const a = gates[0];
    const b = gates[1];
    obstacles.push({ kind: 'pendulum', id: 'pendulum', pivot: v3((a.center.x + b.center.x) / 2, (a.center.y + b.center.y) / 2, 3.05), length: 1.8, bobRadius: 0.11, amplitude: 0.45, period: 2.5, phase: rng.uniform(0, 6), swingYaw: Math.atan2(b.center.y - a.center.y, b.center.x - a.center.x) + Math.PI / 2 });
  }
  const c = base('C11', gates, { obstacles, targetSpeed: 1.2 + 0.25 * p.difficulty });
  c.name = `C11 Random course (seed ${p.seed})`;
  c.difficulty = Math.max(1, Math.min(5, Math.round(p.difficulty)));
  return c;
}

/** Default custom course (C12) when the editor has not produced one. */
export function defaultCustomCourse(): Course {
  const gates = [gate(0, -2, 0, 1.0, 0), gate(1, 2, 0.5, 1.2, 30), gate(2, 0, 1.5, 1.4, 180)];
  return base('C12', gates, { name: 'C12 Custom', targetSpeed: 1.6 });
}

export function buildCourse(params: CourseParams): Course | null {
  switch (params.courseId) {
    case 'C1':
      return slalom();
    case 'C2':
      return hairpin();
    case 'C3':
      return corkscrew();
    case 'C4':
      return ladderDive();
    case 'C5':
      return keyhole();
    case 'C6':
      return forest(Math.max(8, Math.min(12, params.pillarCount)), params.random.seed);
    case 'C7':
      return gauntlet();
    case 'C8':
      return merge();
    case 'C9':
      return figure8Circuit();
    case 'C10':
      return complex();
    case 'C11':
      return randomCourse(params.random);
    case 'C12':
      return params.custom ? { ...params.custom, id: 'C12' } : defaultCustomCourse();
    default:
      return null;
  }
}

// ------------------------------------------------------------------------------------------
// Gate layouts of the race loop, pinch and split-S scenarios
// ------------------------------------------------------------------------------------------

/** T9 race loop: 6 m x 3 m oval, 4 gates, one of them the narrow pinch ring (0.30 m inner). */
export function raceLoopCourse(): Course {
  const gates = [gate(0, 0, -1.5, 1.0, 0, 0.9), gate(1, 3.0, 0, 1.0, 90, 0.9), gate(2, 0, 1.5, 1.0, 180, diameterForInner(0.3)), gate(3, -3.0, 0, 1.0, 270, 0.9)];
  return {
    id: 'raceLoop',
    name: 'Race loop (6 m x 3 m oval)',
    difficulty: 3,
    description: 'Closed oval with four gates; the far gate is the 0.30 m pinch ring, so only one drone fits through at a time.',
    gates,
    obstacles: [],
    sequence: seqOf(4),
    closed: true,
    laps: 1,
    arena: { sx: 8, sy: 5, sz: 3 },
    targetSpeed: 2.0,
  };
}

/** T4 pinch: one ring of the given inner diameter 2.5 m ahead of the start, on the x axis. */
export function pinchCourse(innerDiameter: number): Course {
  return {
    id: 'pinch',
    name: `Pinch (ring ${innerDiameter.toFixed(2)} m)`,
    difficulty: 3,
    description: 'Approach lanes 0.6 m apart converge on a ring 2.5 m ahead; then both exit together.',
    gates: [gate(0, 0, 0, 1.0, 0, diameterForInner(innerDiameter))],
    obstacles: [],
    sequence: [{ gate: 0 }],
    closed: false,
    laps: 1,
    arena: { sx: 8, sy: 5, sz: 3 },
    targetSpeed: 1.6,
  };
}

/** T3 split-S: two rings stacked vertically (0.6 m and 1.6 m) on one side of the arena. */
export function splitSCourse(): Course {
  return {
    id: 'splitS',
    name: 'Split-S',
    difficulty: 4,
    description: 'Dive through the upper ring, loop down and back through the lower ring, climb back.',
    gates: [gate(0, 1.6, 0, 1.6, 0, 0.8, 'hanging'), gate(1, 1.6, 0, 0.6, 180, 0.8, 'stand')],
    obstacles: [],
    sequence: [{ gate: 0 }, { gate: 1 }],
    // dive: past the upper ring, loop down to the lower ring; return with a climbing U-turn
    via: [
      { after: 0, points: [v3(2.5, 0, 1.15)] },
      { after: 1, points: [v3(-1.2, 0.9, 0.85), v3(-2.6, 0, 1.25), v3(-1.2, -0.9, 1.6)] },
    ],
    closed: true,
    laps: 1,
    arena: { sx: 8, sy: 5, sz: 3 },
    targetSpeed: 1.6,
  };
}

/** Recommended cruise speed of a course preset (m/s). */
export function recommendedSpeed(params: CourseParams): number {
  return buildCourse(params)?.targetSpeed ?? 1.6;
}
