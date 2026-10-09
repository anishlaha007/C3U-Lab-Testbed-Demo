/**
 * Planning entry point: build candidate sets for each drone, evaluate payoffs with rollouts and
 * solve the configured game (Section 7). Runs synchronously; the app calls it from a Web Worker.
 *
 * Payoffs (2 drones, horizon T = one lap of the fastest candidate):
 *   payoff_1(i, j) = s_1(T) - s_2(T) - P * risk_1(i, j)
 *   payoff_2(i, j) = -(s_1(T) - s_2(T)) - P * risk_2(i, j)
 * risk = time with scaled separation < 1 in the rollout; "shared" responsibility charges both
 * drones the whole violation time, "follower only" charges the drone behind at each instant.
 */
import { ARENA_MARGIN, DRONE_RADIUS } from '../constants';
import { gateCrossing, gateFrame, isDynamic, obstaclePrimitives } from '../course';
import { distanceToPrimitive } from '../geometry';
import { raceKey, raceSetup, slotOptions, type RaceSetup } from '../race';
import { sampleTrajectory } from '../trajectories/common';
import type { GateVisit, SimConfig, Trajectory } from '../types';
import { buildCandidate, candidateSpecs } from './candidates';
import { bestResponses, iteratedBestResponse, pureNash, stackelberg, tieBreakNash } from './game';
import { rolloutPair, sampleCandidate, type CandidateSamples } from './rollout';
import type { Candidate, GameMatrix, PlanResult } from './types';

/** Everything a plan depends on: when this key changes, a stored plan is stale. */
export function planKey(cfg: SimConfig): string {
  const p = cfg.planner;
  return `${raceKey(cfg)}|${JSON.stringify([p.solver, p.leader, p.tieBreak, p.M, p.responsibility, p.penalty, p.riskMargin])}|${cfg.seed}|${cfg.course.dynamicObstacles}`;
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Does a candidate trajectory pass every scheduled gate of its sequence? */
export function passesGates(traj: Trajectory, setup: RaceSetup, visits: GateVisit[]): boolean {
  if (!visits.length) return true;
  const course = setup.course;
  const frames = course.gates.map(gateFrame);
  let next = 0;
  const step = 2;
  for (let k = step; k < traj.t.length && next < visits.length; k += step) {
    const p0 = { x: traj.x[k - step], y: traj.y[k - step], z: traj.z[k - step] };
    const p1 = { x: traj.x[k], y: traj.y[k], z: traj.z[k] };
    const v = visits[next];
    const c = gateCrossing(course.gates[v.gate], frames[v.gate], p0, p1, !!v.reverse);
    if (c.kind === 'pass') next++;
    else if (c.kind === 'miss') return false;
  }
  return next >= visits.length;
}

/** Does a candidate stay inside the arena minus the 0.3 m geofence margin (with 5 cm spare)? */
export function insideArena(traj: Trajectory, arena: { sx: number; sy: number; sz: number }, margin = ARENA_MARGIN + 0.05): boolean {
  for (let k = 0; k < traj.t.length; k += 2) {
    if (Math.abs(traj.x[k]) > arena.sx / 2 - margin || Math.abs(traj.y[k]) > arena.sy / 2 - margin || traj.z[k] < margin || traj.z[k] > arena.sz - margin) return false;
  }
  return true;
}

/** Does a candidate hit a moving obstacle at the time it gets there? */
export function hitsDynamic(traj: Trajectory, setup: RaceSetup, clearance: number): boolean {
  const dyn = setup.course.obstacles.filter(isDynamic);
  if (!dyn.length) return false;
  const T = traj.t[traj.t.length - 1];
  for (let t = 0; t <= T; t += 0.04) {
    const p = sampleTrajectory(traj, t).p;
    for (const o of dyn) {
      for (const prim of obstaclePrimitives(o, t, true)) {
        if (distanceToPrimitive(p, prim) < clearance) return true;
      }
    }
  }
  return false;
}

export interface SolveOptions {
  onProgress?: (fraction: number, message: string) => void;
}

export function solvePlan(cfg: SimConfig, opts: SolveOptions = {}): PlanResult {
  const t0 = now();
  const setup = raceSetup(cfg);
  if (!setup) throw new Error('The planners need a race scenario: pinch, race loop or a ring course.');
  const n = setup.droneTracks.length;
  const pl = cfg.planner;
  const M = Math.max(1, Math.min(80, Math.round(pl.M)));
  const vertical = cfg.scenario.type === 'ringCircuit';
  const dynamicOn = cfg.course.dynamicObstacles;
  const timing = dynamicOn && setup.course.obstacles.some(isDynamic);
  const specs = candidateSpecs(M, cfg.seed, 4, vertical, timing);
  const geomVisits = (i: number): GateVisit[] => {
    const seq = setup.course.droneSequences?.[i] ?? setup.course.sequence;
    const out: GateVisit[] = [];
    for (let l = 0; l < setup.laps; l++) out.push(...seq);
    return out;
  };

  const arena = { sx: Math.max(cfg.arena.sx, setup.course.arena.sx), sy: Math.max(cfg.arena.sy, setup.course.arena.sy), sz: Math.max(cfg.arena.sz, setup.course.arena.sz) };

  // ---- candidates
  const candidates: Candidate[][] = [];
  const trajs: Trajectory[][] = [];
  let built = 0;
  for (let d = 0; d < n; d++) {
    const cs: Candidate[] = [];
    const ts: Trajectory[] = [];
    specs.forEach((spec, k) => {
      const { cand, traj } = buildCandidate(
        setup.droneTracks[d],
        spec,
        setup.limits[d],
        { ...slotOptions(setup, d), obstacles: setup.obstacles, clearance: DRONE_RADIUS + 0.06, droneId: d },
        k,
      );
      if (cand.valid && !insideArena(traj, arena)) cand.valid = false;
      if (cand.valid && !passesGates(traj, setup, geomVisits(d))) cand.valid = false;
      if (cand.valid && dynamicOn && hitsDynamic(traj, setup, DRONE_RADIUS + 0.1)) cand.valid = false;
      cs.push(cand);
      ts.push(traj);
      built++;
      opts.onProgress?.((0.8 * built) / (n * specs.length), `candidates ${built}/${n * specs.length}`);
    });
    // keep at least one candidate (the centreline) so the race can still be flown
    if (!cs.some((c) => c.valid)) cs[0].valid = true;
    candidates.push(cs);
    trajs.push(ts);
  }

  // ---- horizon: the whole race (default one lap) of the fastest valid candidate, slightly
  // before it finishes so the progress gap is still informative
  let T = Infinity;
  candidates.forEach((cs, d) =>
    cs.forEach((c, k) => {
      if (!c.valid) return;
      const tr = trajs[d][k];
      T = Math.min(T, tr.t[tr.t.length - 1]);
    }),
  );
  if (!Number.isFinite(T)) T = 5;
  T = Math.max(1, T * 0.97);

  const samples: CandidateSamples[][] = trajs.map((ts) => ts.map((tr) => sampleCandidate(tr, setup.track, T)));
  opts.onProgress?.(0.85, 'rollouts');
  const valid = candidates.map((cs) => cs.map((c) => c.valid));
  const ownProgress = samples.map((ss) => ss.map((s) => s.s[s.s.length - 1]));
  const independentChoice = ownProgress.map((ps, d) => {
    let best = -1;
    ps.forEach((p, k) => {
      if (valid[d][k] && (best < 0 || p > ps[best] + 1e-9)) best = k;
    });
    return Math.max(0, best);
  });

  let choice: number[];
  let game: GameMatrix | null = null;
  let note = '';
  let prediction = { gap: NaN, winner: 0, horizon: T };

  if (n === 2) {
    const r = solveTwoDroneGame(samples, valid, pl, independentChoice);
    choice = r.choice;
    game = { ...r.game, horizon: T };
    note = r.note;
    const gap = r.game.gap;
    const g = gap[choice[0]][choice[1]];
    prediction = { gap: g, winner: g >= 0 ? 0 : 1, horizon: T };
  } else {
    // ---- N-drone extensions
    const P = pl.penalty;
    const riskWith = (d: number, k: number, ch: number[], others: number[]) => {
      let rk = 0;
      for (const o of others) {
        const r = rolloutPair(samples[d][k], samples[o][ch[o]], undefined, pl.riskMargin);
        rk += pl.responsibility === 'follower' ? r.riskFollower1 : r.risk;
      }
      return rk;
    };
    const util = (d: number, k: number, ch: number[], others: number[]) => {
      const sd = ownProgress[d][k];
      const best = others.length ? Math.max(...others.map((o) => ownProgress[o][ch[o]])) : 0;
      return sd - best - P * riskWith(d, k, ch, others);
    };
    const bestFor = (d: number, ch: number[], others: number[]) => {
      let best = ch[d];
      let bv = -Infinity;
      for (let k = 0; k < specs.length; k++) {
        if (!valid[d][k]) continue;
        const u = util(d, k, ch, others);
        if (u > bv + 1e-9) {
          bv = u;
          best = k;
        }
      }
      return best;
    };
    const all = Array.from({ length: n }, (_, d) => d);
    if (pl.solver === 'independent') {
      choice = independentChoice.slice();
      note = 'Independent: every drone flies its fastest valid candidate.';
    } else if (pl.solver === 'nash') {
      choice = independentChoice.slice();
      let converged = false;
      let sweeps = 0;
      for (sweeps = 1; sweeps <= 50; sweeps++) {
        let changed = false;
        for (const d of all) {
          const b = bestFor(d, choice, all.filter((o) => o !== d));
          if (b !== choice[d]) {
            choice[d] = b;
            changed = true;
          }
        }
        if (!changed) {
          converged = true;
          break;
        }
      }
      note = `N-drone extension: Nash by sequential iterated best response (${converged ? `converged in ${sweeps} sweeps` : 'cap of 50 sweeps reached'}).`;
    } else {
      const lead = Math.min(n - 1, Math.max(0, pl.leader));
      const order = [lead, ...all.filter((d) => d !== lead)];
      choice = independentChoice.slice();
      const decided: number[] = [];
      for (const d of order) {
        choice[d] = bestFor(d, choice, decided);
        decided.push(d);
      }
      note = 'N-drone extension: Stackelberg as a priority chain (each drone best-responds to the drones ahead of it in priority).';
    }
    const prog = choice.map((k, d) => ownProgress[d][k]);
    const winner = prog.indexOf(Math.max(...prog));
    prediction = { gap: prog[0] - Math.max(...prog.slice(1)), winner, horizon: T };
  }

  opts.onProgress?.(1, 'done');
  const trajectories = choice.map((k, d) => {
    const tr = trajs[d][k];
    tr.meta = { ...tr.meta, solver: pl.solver, strategy: candidates[d][k].label, drone_id: d, run_id: `plan-${cfg.seed}` };
    return tr;
  });
  return {
    solver: pl.solver,
    leader: pl.leader,
    choice,
    trajectories,
    candidates,
    game,
    prediction,
    solveMs: now() - t0,
    note,
    trackId: setup.track.id,
    key: planKey(cfg),
  };
}

/**
 * Build the 2-drone bimatrix game from candidate samples and pick the configured solution.
 * Shared by the precomputed planner and receding-horizon re-planning.
 */
export function solveTwoDroneGame(
  samples: CandidateSamples[][],
  valid: boolean[][],
  pl: SimConfig['planner'],
  independentChoice: number[],
): { choice: number[]; game: GameMatrix; note: string } {
  const M1 = samples[0].length;
  const M2 = samples[1].length;
  const payoff1: number[][] = [];
  const payoff2: number[][] = [];
  const gap: number[][] = [];
  const risk: number[][] = [];
  const total: number[][] = [];
  for (let i = 0; i < M1; i++) {
    payoff1.push([]);
    payoff2.push([]);
    gap.push([]);
    risk.push([]);
    total.push([]);
    for (let j = 0; j < M2; j++) {
      const r = rolloutPair(samples[0][i], samples[1][j], undefined, pl.riskMargin);
      const r1 = pl.responsibility === 'follower' ? r.riskFollower1 : r.risk;
      const r2 = pl.responsibility === 'follower' ? r.riskFollower2 : r.risk;
      payoff1[i].push(r.gap - pl.penalty * r1);
      payoff2[i].push(-r.gap - pl.penalty * r2);
      gap[i].push(r.gap);
      risk[i].push(r.risk);
      total[i].push(r.total);
    }
  }
  const { br1, br2 } = bestResponses(payoff1, payoff2, valid[0], valid[1]);
  const nash = pureNash(payoff1, payoff2, valid[0], valid[1]);
  const stk = [0, 1].map((L) => {
    const [i, j] = stackelberg(payoff1, payoff2, valid[0], valid[1], L as 0 | 1);
    return { leader: L, i, j };
  });
  const horizon = (samples[0][0].p.length - 1) * 0.05;
  const game: GameMatrix = { payoff1, payoff2, gap, risk, total, br1, br2, nash, stackelberg: stk, horizon };
  let choice: number[];
  let note: string;
  if (pl.solver === 'independent') {
    choice = independentChoice;
    note = 'Independent: each drone flies its fastest valid candidate, ignoring the other (the safety filter alone resolves conflicts).';
  } else if (pl.solver === 'nash') {
    if (nash.length) {
      const c = tieBreakNash(nash, game, pl.tieBreak);
      choice = [c[0], c[1]];
      note = `${nash.length} pure Nash equilibri${nash.length === 1 ? 'um' : 'a'}; ${nash.length > 1 ? `picked by ${pl.tieBreak === 'ego' ? 'ego-favourable' : 'maximum total progress'} rule` : 'unique'}.`;
    } else {
      const r = iteratedBestResponse(payoff1, payoff2, valid[0], valid[1], [independentChoice[0], independentChoice[1]], 50);
      choice = [r.cell[0], r.cell[1]];
      note = `No pure equilibrium; IBR result shown (${r.converged ? 'converged' : 'did not converge'} after ${r.iterations} iterations).`;
    }
  } else {
    const L = pl.leader === 1 ? 1 : 0;
    choice = [stk[L].i, stk[L].j];
    note = `Stackelberg with drone ${L === 0 ? 'A' : 'B'} leading: the leader commits first, anticipating the follower's best reply.`;
  }
  return { choice, game, note };
}
