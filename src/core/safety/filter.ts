/**
 * Active Set Invariance Filter (ASIF, Ames et al. 2019): minimally modify the nominal commanded
 * accelerations so that every barrier constraint holds (Section 8).
 *
 * Model for the filter: each drone is a double integrator p' = v, v' = u.
 * Constraints: one per drone pair (exponential or braking-aware CBF on the downwash ellipsoid)
 * plus one per nearby obstacle primitive per drone (Section 8.3b).
 * Solving: exact closed form when there is a single constraint; Hildreth's QP otherwise.
 * After solving, each modified command is clipped to the drone's feasible set (thrust budget
 * eta * TWR * g and tilt limit, altitude priority) and the constraints are re-checked.
 */
import { DRONE_RADIUS, INTERVENTION_THRESHOLD } from '../constants';
import { clipToFeasible, maxAccelAlong } from '../dynamics';
import { coreClosest, distanceToPrimitive, nearBounds, primitiveBounds, type Primitive } from '../geometry';
import type { FilterConfig } from '../types';
import { v3, type Vec3 } from '../vec';
import { brakingObstacle, brakingPair } from './brakingCbf';
import type { LinearConstraint } from './constraint';
import { ecbfObstacle, ecbfPair, pairD } from './ecbf';
import { closedFormPair, closedFormSingle, hildreth, rowFromConstraint, type QPRow } from './qp';

export interface FilterDrone {
  /** State used to evaluate constraints (estimate, predicted forward if compensating latency). */
  p: Vec3;
  v: Vec3;
  uNom: Vec3;
  twr: number;
  /** Participates in the filter (flying and streamed). */
  active: boolean;
  /** Progress along the track (m), NaN when no track (used for follower responsibility). */
  progress: number;
}

export interface FilterParams {
  cfg: FilterConfig;
  eta: number;
  thetaMax: number;
  /** Pure double-integrator test mode: clip |u| to this norm instead of the thrust cone. */
  pureAccelLimit?: number;
  /** Obstacles are included only within this distance (m). */
  obstacleRange?: number;
  /** Control period (s): enables the braking-aware one-step look-ahead when not closing. */
  dt?: number;
  /** Braking-aware reaction time (s): actuation lag plus half a control period (0 in pure mode). */
  reactionTime?: number;
}

export interface FilterResult {
  uSafe: Vec3[];
  correction: number[];
  intervened: boolean[];
  pairActive: boolean[];
  obsActive: boolean[];
  clippedDrone: boolean[];
  clipped: boolean;
  infeasible: boolean;
  infeasiblePairs: [number, number][];
  /** Barrier value per unordered pair (index from pairIndex(i, j, n)); NaN if inactive drone. */
  pairH: number[];
  /** Pairs violating the ECBF initial-condition requirement h' + lambda h >= 0. */
  initViolations: [number, number][];
  constraints: LinearConstraint[];
  nConstraints: number;
  iterations: number;
  solveMs: number;
}

/** Index of the unordered pair (i < j) among n drones. */
export function pairIndex(i: number, j: number, n: number): number {
  if (i > j) [i, j] = [j, i];
  return i * n - (i * (i + 1)) / 2 + (j - i - 1);
}

export function pairList(n: number): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) out.push([i, j]);
  return out;
}

/** Magnitude of the deadlock-breaking bias (m/s^2). */
export const DEADLOCK_BIAS = 1.0;

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Leader of a pair: larger progress if available, else the drone further along the mean velocity. */
export function pairLeader(a: FilterDrone, b: FilterDrone, ia: number, ib: number): number {
  if (Number.isFinite(a.progress) && Number.isFinite(b.progress) && Math.abs(a.progress - b.progress) > 1e-6) {
    return a.progress > b.progress ? ia : ib;
  }
  const mv = v3(a.v.x + b.v.x, a.v.y + b.v.y, a.v.z + b.v.z);
  const proj = (a.p.x - b.p.x) * mv.x + (a.p.y - b.p.y) * mv.y + (a.p.z - b.p.z) * mv.z;
  if (Math.abs(proj) < 1e-9) return Math.min(ia, ib);
  return proj > 0 ? ia : ib;
}

export function runSafetyFilter(drones: FilterDrone[], obstacles: readonly Primitive[], prm: FilterParams): FilterResult {
  const t0 = now();
  const cfg = prm.cfg;
  const n = drones.length;
  const D = pairD(cfg.marginMultiplier);
  const nPairs = (n * (n - 1)) / 2;
  const pairH = new Array<number>(nPairs).fill(NaN);
  const constraints: LinearConstraint[] = [];
  const initViolations: [number, number][] = [];
  const capability = (dir: Vec3, twr: number) =>
    prm.pureAccelLimit !== undefined ? prm.pureAccelLimit : maxAccelAlong(dir, twr, prm.eta);

  // ---- pair constraints
  for (let i = 0; i < n; i++) {
    if (!drones[i].active) continue;
    for (let j = i + 1; j < n; j++) {
      if (!drones[j].active) continue;
      const di = drones[i];
      const dj = drones[j];
      const k = pairIndex(i, j, n);
      if (cfg.type === 'ecbf') {
        const c = ecbfPair(i, j, di.p, di.v, dj.p, dj.v, D, cfg.lambda);
        pairH[k] = c.h;
        if ((c.hdot ?? 0) + cfg.lambda * c.h < 0) initViolations.push([i, j]);
        constraints.push(c);
      } else {
        const dp = v3(di.p.x - dj.p.x, di.p.y - dj.p.y, di.p.z - dj.p.z);
        const L = Math.hypot(dp.x, dp.y, dp.z) || 1;
        const u = v3(dp.x / L, dp.y / L, dp.z / L);
        const aRel = cfg.brakingFraction * (capability(u, di.twr) + capability(v3(-u.x, -u.y, -u.z), dj.twr));
        const r = brakingPair(i, j, di.p, di.v, dj.p, dj.v, D, aRel, cfg.alpha, prm.dt ?? 0, prm.reactionTime ?? 0);
        pairH[k] = r.h;
        if (r.constraint) constraints.push(r.constraint);
      }
    }
  }

  // ---- obstacle constraints (drones within range)
  if (cfg.obstacles && obstacles.length) {
    const range = prm.obstacleRange ?? 1.5;
    for (let i = 0; i < n; i++) {
      const di = drones[i];
      if (!di.active) continue;
      for (const prim of obstacles) {
        if (prim.kind !== 'plane' && !nearBounds(di.p, primitiveBounds(prim), range)) continue;
        if (distanceToPrimitive(di.p, prim) > range) continue;
        const margin = prim.tag.source === 'gate' ? cfg.gateMargin : cfg.obstacleMargin;
        const c = coreClosest(di.p, prim);
        const Rtot = c.R + DRONE_RADIUS + margin;
        let con: LinearConstraint | null;
        if (cfg.type === 'ecbf') con = ecbfObstacle(i, di.p, di.v, c, Rtot, cfg.obstacleLambda);
        else con = brakingObstacle(i, di.p, di.v, c, Rtot, cfg.brakingFraction * Math.max(0.5, capability(c.n, di.twr)), cfg.obstacleAlpha, prm.dt ?? 0, prm.reactionTime ?? 0);
        if (con) {
          con.label = prim.tag.id;
          constraints.push(con);
        }
      }
    }
  }

  // ---- responsibility: follower-only moves the leader's term to the right-hand side
  const weights = drones.map((_, i) => (cfg.responsibility === 'weights' ? Math.max(0.05, cfg.weights[i] ?? 1) : 1));
  const solveSet: LinearConstraint[] = constraints.map((c) => {
    if (c.kind !== 'pair' || cfg.responsibility !== 'follower') return c;
    const leader = pairLeader(drones[c.i], drones[c.j], c.i, c.j);
    if (leader === c.i) {
      // a.(u_i - u_j) >= b with u_i fixed  ->  (-a).u_j >= b - a.u_i
      const ui = drones[c.i].uNom;
      return { ...c, i: c.j, j: -1, a: v3(-c.a.x, -c.a.y, -c.a.z), b: c.b - (c.a.x * ui.x + c.a.y * ui.y + c.a.z * ui.z) };
    }
    const uj = drones[c.j].uNom;
    return { ...c, j: -1, b: c.b + (c.a.x * uj.x + c.a.y * uj.y + c.a.z * uj.z) };
  });

  // ---- symmetric-deadlock breaker: closing pairs whose nominal inputs violate the constraint
  // get a small opposite horizontal bias perpendicular to the line of centres (right-hand rule),
  // so the min-norm correction is no longer perfectly symmetric and one drone passes first.
  const uNom = drones.map((d) => ({ ...d.uNom }));
  if (cfg.deadlockBreaker && prm.pureAccelLimit === undefined) {
    for (const c of constraints) {
      if (c.kind !== 'pair') continue;
      const di = drones[c.i];
      const dj = drones[c.j];
      const lhs = c.a.x * (di.uNom.x - dj.uNom.x) + c.a.y * (di.uNom.y - dj.uNom.y) + c.a.z * (di.uNom.z - dj.uNom.z);
      if (lhs >= c.b) continue;
      const dx = di.p.x - dj.p.x;
      const dy = di.p.y - dj.p.y;
      const closing = dx * (di.v.x - dj.v.x) + dy * (di.v.y - dj.v.y) < 0;
      const dh = Math.hypot(dx, dy);
      if (!closing || dh < 1e-6) continue;
      // unit vector rotated -90 deg from dp (right-hand rule), magnitude 1 m/s^2
      const bx = (dy / dh) * DEADLOCK_BIAS;
      const by = (-dx / dh) * DEADLOCK_BIAS;
      uNom[c.i] = v3(uNom[c.i].x + bx, uNom[c.i].y + by, uNom[c.i].z);
      uNom[c.j] = v3(uNom[c.j].x - bx, uNom[c.j].y - by, uNom[c.j].z);
    }
  }

  // ---- solve
  let uSafe = uNom.map((u) => ({ ...u }));
  const activeFlags = new Array<boolean>(solveSet.length).fill(false);
  let iterations = 0;
  if (solveSet.length === 1) {
    const c = solveSet[0];
    if (c.j >= 0) {
      const r = closedFormPair(uNom[c.i], uNom[c.j], c.a, c.b, weights[c.i], weights[c.j]);
      uSafe[c.i] = r.ui;
      uSafe[c.j] = r.uj;
      activeFlags[0] = r.active;
    } else {
      const r = closedFormSingle(uNom[c.i], c.a, c.b);
      uSafe[c.i] = r.u;
      activeFlags[0] = r.active;
    }
  } else if (solveSet.length > 1) {
    const rows: QPRow[] = solveSet.map(rowFromConstraint);
    const res = hildreth(uNom, weights, rows, 100, 1e-6);
    iterations = res.iterations;
    uSafe = uNom.map((u, i) => v3(u.x + res.delta[i].x, u.y + res.delta[i].y, u.z + res.delta[i].z));
    res.lambda.forEach((l, k) => (activeFlags[k] = l > 1e-9));
  }

  // ---- clip modified commands to the feasible set
  const correction = new Array<number>(n).fill(0);
  const intervened = new Array<boolean>(n).fill(false);
  const clippedDrone = new Array<boolean>(n).fill(false);
  const uNomTrue = drones.map((d) => d.uNom);
  for (let i = 0; i < n; i++) {
    const dx = uSafe[i].x - uNomTrue[i].x;
    const dy = uSafe[i].y - uNomTrue[i].y;
    const dz = uSafe[i].z - uNomTrue[i].z;
    if (Math.hypot(dx, dy, dz) > 1e-9) {
      if (prm.pureAccelLimit !== undefined) {
        const m = Math.hypot(uSafe[i].x, uSafe[i].y, uSafe[i].z);
        if (m > prm.pureAccelLimit) {
          const s = prm.pureAccelLimit / m;
          uSafe[i] = v3(uSafe[i].x * s, uSafe[i].y * s, uSafe[i].z * s);
          clippedDrone[i] = true;
        }
      } else {
        const r = clipToFeasible(uSafe[i], drones[i].twr, prm.eta, prm.thetaMax);
        uSafe[i] = r.u;
        clippedDrone[i] = r.clipped;
      }
    }
    correction[i] = Math.hypot(uSafe[i].x - uNomTrue[i].x, uSafe[i].y - uNomTrue[i].y, uSafe[i].z - uNomTrue[i].z);
    intervened[i] = correction[i] > INTERVENTION_THRESHOLD;
  }

  // ---- attribution and feasibility re-check (on the original constraints)
  const pairActive = new Array<boolean>(n).fill(false);
  const obsActive = new Array<boolean>(n).fill(false);
  solveSet.forEach((c, k) => {
    if (!activeFlags[k]) return;
    const orig = constraints[k];
    if (orig.kind === 'pair') {
      pairActive[orig.i] = pairActive[orig.i] || intervened[orig.i];
      pairActive[orig.j] = pairActive[orig.j] || intervened[orig.j];
    } else obsActive[c.i] = obsActive[c.i] || intervened[c.i];
  });
  let infeasible = false;
  const infeasiblePairs: [number, number][] = [];
  for (const c of constraints) {
    const ui = uSafe[c.i];
    let lhs = c.a.x * ui.x + c.a.y * ui.y + c.a.z * ui.z;
    if (c.j >= 0) {
      const uj = uSafe[c.j];
      lhs -= c.a.x * uj.x + c.a.y * uj.y + c.a.z * uj.z;
    }
    if (c.b - lhs > 1e-3 * (1 + Math.abs(c.b))) {
      infeasible = true;
      if (c.j >= 0) infeasiblePairs.push([c.i, c.j]);
    }
  }

  return {
    uSafe,
    correction,
    intervened,
    pairActive,
    obsActive,
    clippedDrone,
    clipped: clippedDrone.some(Boolean),
    infeasible,
    infeasiblePairs,
    pairH,
    initViolations,
    constraints,
    nConstraints: constraints.length,
    iterations,
    solveMs: now() - t0,
  };
}
