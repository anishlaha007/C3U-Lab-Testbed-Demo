/**
 * Milestone experiments (Section 12): speed sweeps, controller / mode comparisons, safety sweeps,
 * margin sweeps, drone-count scaling and the game-theoretic race series. An experiment is a list
 * of trial specs (pure data, runnable in any worker) plus an aggregation step with statistics.
 */
import { cloneConfig } from './defaults';
import { raceResult } from './metrics/racing';
import { evaluateTrial, EQUAL_WEIGHTS, rankingStability, type ConditionScore, type SubScores, type Weights } from './metrics/scorecard';
import { binomialTest, bootstrapCI, holm, mean, permutationTest, wilson } from './metrics/stats';
import { solvePlan } from './planners/plan';
import { presetConfig } from './presets';
import { isRaceScenario } from './race';
import { buildScenario } from './scenario';
import { runTrial } from './sim';
import { figure8MeanSpeed } from './trajectories/figure8';
import type { CourseId, SimConfig, SolverType, Trajectory, TrialLog } from './types';

export type ExperimentKind = 'm1-speed' | 'm1-compare' | 'm2-safety' | 'm2-margins' | 'm2-scaling' | 'm3-series';

export interface ExperimentOptions {
  /** Reduced trial counts so every experiment finishes in well under a minute. */
  quick: boolean;
  /** Base seed; trial i uses seed + i. */
  seed: number;
  /** M1: include speed levels beyond the eta = 0.7 planning limit (1.80, 2.10 rad/s). */
  extended?: boolean;
  /** M3: also run the optional hard courses C10 and C6. */
  hardCourses?: boolean;
}

export interface TrialSpec {
  id: string;
  kind: ExperimentKind;
  /** Grouping labels (condition, level, scenario...). */
  group: Record<string, string | number>;
  config: SimConfig;
  /** Solve the game before flying (race scenarios). */
  solve?: boolean;
  /** Also fly every drone alone to compute M15 (cost of safety). */
  solo?: boolean;
}

export interface TrialRecord {
  id: string;
  kind: ExperimentKind;
  group: Record<string, string | number>;
  seed: number;
  endReason: string;
  rmse: number[];
  along: number[];
  cross: number[];
  meanSpeed: number[];
  lapTime: number[];
  completion: number[];
  feasibilityFail: number[];
  collisions: number;
  minS: number;
  minD: number;
  violationTime: number;
  interventionRate: number;
  interventionSize: number;
  solveP99: number;
  obstacleIntRate: number;
  pairIntRate: number;
  clearance: number;
  passRate: number;
  strikes: number;
  misses: number;
  emergencies: number;
  G: number;
  gateReason: string;
  sub: SubScores;
  score: number;
  /** Mean RMSE over drones. */
  rmseMean: number;
  /** M15 per drone (multi-drone RMSE minus solo RMSE), when requested. */
  costOfSafety?: number[];
  race?: {
    winner: number;
    gap: number;
    overtakes: number;
    predictedWinner?: number;
    predictedGap?: number;
    realisedGapAtHorizon?: number;
    crashed: boolean[];
    planNote?: string;
    planSolveMs?: number;
    strategies?: string[];
  };
  wallMs: number;
  error?: string;
}

const W_LEVELS = [0.522, 0.78, 1.04, 1.31, 1.54];
const W_EXTENDED = [1.8, 2.1];

let idCounter = 0;
const nextId = (kind: string) => `${kind}-${++idCounter}`;

/** Build the trial list of an experiment. */
export function buildExperiment(kind: ExperimentKind, o: ExperimentOptions): TrialSpec[] {
  const specs: TrialSpec[] = [];
  const add = (group: TrialSpec['group'], config: SimConfig, extra: Partial<TrialSpec> = {}) => specs.push({ id: nextId(kind), kind, group, config, ...extra });
  switch (kind) {
    case 'm1-speed': {
      const trials = o.quick ? 3 : 5;
      const levels = o.extended ? [...W_LEVELS, ...W_EXTENDED] : W_LEVELS;
      for (const w of levels) {
        for (let k = 0; k < trials; k++) {
          const c = presetConfig('T1', o.seed + k);
          c.scenario.w = w;
          c.scenario.laps = 2;
          c.flyAnyway = true;
          add({ w, meanSpeed: figure8MeanSpeed(c.scenario.A, w), trial: k }, c);
        }
      }
      break;
    }
    case 'm1-compare': {
      const trials = o.quick ? 3 : 5;
      const conds: { name: string; mode: 'streamed' | 'uploaded'; controller: 'mellinger' | 'pid' }[] = [
        { name: 'Streamed, Mellinger-like', mode: 'streamed', controller: 'mellinger' },
        { name: 'Uploaded, Mellinger-like', mode: 'uploaded', controller: 'mellinger' },
        { name: 'Streamed, PID-like', mode: 'streamed', controller: 'pid' },
      ];
      for (const w of [0.522, 1.04]) {
        for (const cd of conds) {
          for (let k = 0; k < trials; k++) {
            const c = presetConfig('T1', o.seed + k);
            c.scenario.w = w;
            c.scenario.laps = 2;
            c.system.mode = cd.mode;
            c.system.controller = cd.controller;
            add({ condition: cd.name, level: w === 0.522 ? 'baseline (w = 0.52)' : '2x (w = 1.04)', w, trial: k }, c);
          }
        }
      }
      break;
    }
    case 'm2-safety': {
      const trials = o.quick ? 1 : 5;
      const speeds = [0.78, 1.04, 1.31];
      for (const w of speeds) {
        for (const margin of [1, 1.25, 1.5]) {
          for (const comp of [true, false]) {
            for (const type of ['ecbf', 'braking'] as const) {
              for (let k = 0; k < trials; k++) {
                const c = presetConfig('T5', o.seed + k);
                c.scenario.w = w;
                c.scenario.laps = 1;
                c.filter.marginMultiplier = margin;
                c.filter.latencyCompensation = comp;
                c.filter.type = type;
                // cost of safety (M15) for the default filter configuration only
                add({ w, margin, comp: comp ? 'on' : 'off', type, trial: k }, c, { solo: comp && type === 'ecbf' });
              }
            }
          }
        }
      }
      break;
    }
    case 'm2-margins': {
      const trials = o.quick ? 1 : 3;
      for (const course of ['C6', 'C5'] as CourseId[]) {
        // 0.15 m added to the spec's (0.03, 0.05, 0.10): the racing lines keep about 0.17 m
        // clearance from obstacles, so smaller obstacle margins rarely bind (Section 8.2b)
        for (const om of [0.03, 0.05, 0.1, 0.15]) {
          for (const gm of [0.03, 0.05, 0.1, 0.15]) {
            for (let k = 0; k < trials; k++) {
              const c = presetConfig(course === 'C6' ? 'T13' : 'T12', o.seed + k);
              c.course.courseId = course;
              c.drones = c.drones.slice(0, 1);
              c.filter.obstacleMargin = om;
              c.filter.gateMargin = gm;
              c.planner.solver = 'independent';
              add({ course, obstacleMargin: om, gateMargin: gm, trial: k }, c, { solve: true });
            }
          }
        }
      }
      break;
    }
    case 'm2-scaling': {
      const trials = o.quick ? 1 : 3;
      for (const preset of ['T7', 'T8']) {
        for (let n = 2; n <= 6; n++) {
          for (let k = 0; k < trials; k++) {
            const c = presetConfig(preset, o.seed + k);
            c.drones = Array.from({ length: n }, (_, i) => ({ ...(c.drones[i] ?? c.drones[0]), color: c.drones[i]?.color ?? ['#38bdf8', '#f472b6', '#facc15', '#4ade80', '#a78bfa', '#fb923c'][i] }));
            add({ scenario: preset === 'T7' ? 'Antipodal (T7)' : 'Random crossing (T8)', n, trial: k }, c);
          }
        }
      }
      break;
    }
    case 'm3-series': {
      const races = o.quick ? 10 : 30;
      const scenarios: { name: string; make: (seed: number) => SimConfig }[] = [
        { name: 'T4 Pinch', make: (s) => presetConfig('T4', s) },
        { name: 'T9 Race loop', make: (s) => presetConfig('T9', s) },
        { name: 'C8 Merge', make: (s) => courseConfig('C8', s) },
        { name: 'C9 Figure-8 circuit', make: (s) => courseConfig('C9', s) },
      ];
      if (o.hardCourses) {
        scenarios.push({ name: 'C10 Complex circuit', make: (s) => courseConfig('C10', s) });
        scenarios.push({ name: 'C6 Forest', make: (s) => courseConfig('C6', s) });
      }
      for (const sc of scenarios) {
        for (const cond of RACE_CONDITIONS) {
          for (let k = 0; k < races; k++) {
            const c = sc.make(o.seed + k);
            c.planner.solver = cond.solver;
            c.planner.leader = cond.leader;
            // alternate start positions between races
            c.planner.swapStarts = k % 2 === 1;
            add({ scenario: sc.name, condition: cond.name, race: k }, c, { solve: true });
          }
        }
      }
      break;
    }
  }
  return specs;
}

export const RACE_CONDITIONS: { name: string; solver: SolverType; leader: number }[] = [
  { name: 'Independent', solver: 'independent', leader: 0 },
  { name: 'Nash', solver: 'nash', leader: 0 },
  { name: 'Stackelberg A leads', solver: 'stackelberg', leader: 0 },
  { name: 'Stackelberg B leads', solver: 'stackelberg', leader: 1 },
];

function courseConfig(id: CourseId, seed: number): SimConfig {
  const c = presetConfig('T12', seed);
  c.course.courseId = id;
  c.scenario.targetSpeed = id === 'C9' || id === 'C10' ? 1.8 : 1.6;
  c.drones = c.drones.slice(0, 2);
  return c;
}

/** Realised progress gap (A - B) at time t. */
export function gapAtTime(log: TrialLog, t: number): number {
  if (log.drones.length < 2 || !log.t.length) return NaN;
  const k = Math.max(0, Math.min(log.t.length - 1, Math.round(t / log.dtLog)));
  return log.drones[0].progress[k] - log.drones[1].progress[k];
}

const soloCache = new Map<string, number>();

/** Fly one trial spec headlessly and reduce it to a record (runs inside a worker). */
export function runTrialSpec(spec: TrialSpec, weights: Weights = EQUAL_WEIGHTS): TrialRecord {
  const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
  const cfg = cloneConfig(spec.config);
  try {
    let plan: ReturnType<typeof solvePlan> | null = null;
    if (spec.solve && isRaceScenario(cfg)) plan = solvePlan(cfg);
    const log = runTrial(cfg, plan ? { trajectories: plan.trajectories, prediction: plan.prediction } : {});
    const ev = evaluateTrial(log, weights);
    const rec: TrialRecord = {
      id: spec.id,
      kind: spec.kind,
      group: spec.group,
      seed: cfg.seed,
      endReason: log.summary.endReason,
      rmse: ev.tracking.map((t) => t.rmse),
      along: ev.tracking.map((t) => t.alongRms),
      cross: ev.tracking.map((t) => t.crossRms),
      meanSpeed: ev.tracking.map((t) => t.meanSpeed),
      lapTime: ev.tracking.map((t) => t.lapTime),
      completion: ev.tracking.map((t) => t.completion),
      feasibilityFail: ev.tracking.map((t) => t.feasibilityFail),
      collisions: ev.safety.collisions,
      minS: ev.safety.closestApproach,
      minD: ev.safety.closestDistance,
      violationTime: ev.safety.violationTime,
      interventionRate: ev.safety.interventionRate,
      interventionSize: ev.safety.interventionSize,
      solveP99: ev.safety.solveP99,
      obstacleIntRate: ev.safety.obstacleInterventionRate,
      pairIntRate: ev.safety.pairInterventionRate,
      clearance: log.summary.obstacleClearance,
      passRate: ev.course.passRate,
      strikes: ev.course.strikes,
      misses: ev.course.misses,
      emergencies: log.summary.emergencies,
      G: ev.scorecard.G,
      gateReason: ev.scorecard.gateReason,
      sub: ev.scorecard.sub,
      score: ev.scorecard.score,
      rmseMean: mean(ev.tracking.map((t) => t.rmse).filter(Number.isFinite)),
      wallMs: 0,
    };
    if (log.drones.length >= 2 && log.trackLength > 0) {
      const rr = raceResult(log);
      rec.race = {
        winner: rr.winner,
        gap: rr.gap,
        overtakes: rr.overtakes,
        predictedWinner: rr.predictedWinner,
        predictedGap: rr.predictedGap,
        realisedGapAtHorizon: log.planned.predictionHorizon !== undefined ? gapAtTime(log, log.planned.predictionHorizon) : undefined,
        crashed: rr.crashed,
        planNote: plan?.note,
        planSolveMs: plan?.solveMs,
        strategies: plan ? plan.choice.map((k, d) => plan!.candidates[d][k].label) : undefined,
      };
    }
    if (spec.solo && log.drones.length > 1) {
      // M15: each drone's trajectory flown alone (same seed, same settings)
      rec.costOfSafety = log.drones.map((_, i) => {
        const key = `${spec.kind}|${JSON.stringify(spec.group.w)}|${cfg.seed}|${cfg.scenario.type}|${cfg.scenario.phaseOffset}|${i}`;
        let solo = soloCache.get(key);
        if (solo === undefined) {
          const sc = cloneConfig(cfg);
          sc.drones = [sc.drones[i]];
          const tr = runTrial(sc, { trajectories: [plan ? plan.trajectories[i] : soloTrajectory(cfg, i)] });
          solo = evaluateTrial(tr, weights).tracking[0].rmse;
          soloCache.set(key, solo);
        }
        return rec.rmse[i] - solo;
      });
    }
    rec.wallMs = (typeof performance !== 'undefined' ? performance.now() : 0) - t0;
    return rec;
  } catch (e) {
    return {
      id: spec.id,
      kind: spec.kind,
      group: spec.group,
      seed: cfg.seed,
      endReason: 'invalid',
      rmse: [],
      along: [],
      cross: [],
      meanSpeed: [],
      lapTime: [],
      completion: [],
      feasibilityFail: [],
      collisions: 0,
      minS: NaN,
      minD: NaN,
      violationTime: 0,
      interventionRate: NaN,
      interventionSize: NaN,
      solveP99: NaN,
      obstacleIntRate: NaN,
      pairIntRate: NaN,
      clearance: NaN,
      passRate: NaN,
      strikes: 0,
      misses: 0,
      emergencies: 0,
      G: 0,
      gateReason: 'error',
      sub: { S: 0, V: 0, A: 0, E: 0 },
      score: 0,
      rmseMean: NaN,
      wallMs: 0,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * M15 for a recorded multi-drone trial: fly each drone's trajectory alone with the same
 * configuration and seed and return its tracking RMSE (the multi-drone RMSE minus this is the
 * cost of safety).
 */
export function soloRmses(cfg: SimConfig, trajectories: Trajectory[], weights: Weights = EQUAL_WEIGHTS): number[] {
  return trajectories.map((tr, i) => {
    const sc = cloneConfig(cfg);
    sc.drones = [sc.drones[i] ?? sc.drones[0]];
    try {
      return evaluateTrial(runTrial(sc, { trajectories: [tr] }), weights).tracking[0]?.rmse ?? NaN;
    } catch {
      return NaN;
    }
  });
}

/** Trajectory of drone i of a (non-race) scenario, for its solo run. */
function soloTrajectory(cfg: SimConfig, i: number) {
  return buildScenario(cfg).trajectories[i];
}

// ---------------------------------------------------------------------------------------------
// Aggregation and statistics
// ---------------------------------------------------------------------------------------------

export interface Stat {
  n: number;
  mean: number;
  lo: number;
  hi: number;
}

export function stat(xs: number[], seed = 7): Stat {
  const v = xs.filter(Number.isFinite);
  if (!v.length) return { n: 0, mean: NaN, lo: NaN, hi: NaN };
  const ci = bootstrapCI(v, { seed, resamples: 1000 });
  return { n: v.length, mean: ci.mean, lo: ci.lo, hi: ci.hi };
}

export function groupBy<T>(xs: T[], key: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of xs) {
    const k = key(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(x);
  }
  return m;
}

export interface SpeedSweepRow {
  w: number;
  meanSpeed: number;
  rmse: Stat;
  along: Stat;
  cross: Stat;
  feasibilityFail: number;
}

export function summariseSpeedSweep(recs: TrialRecord[]): { rows: SpeedSweepRow[]; breakdownW: number | null } {
  const rows = [...groupBy(recs, (r) => String(r.group.w)).entries()]
    .map(([w, rs]) => ({
      w: Number(w),
      meanSpeed: mean(rs.map((r) => r.meanSpeed[0])),
      rmse: stat(rs.map((r) => r.rmse[0])),
      along: stat(rs.map((r) => r.along[0])),
      cross: stat(rs.map((r) => r.cross[0])),
      feasibilityFail: mean(rs.map((r) => r.feasibilityFail[0])),
    }))
    .sort((a, b) => a.w - b.w);
  const br = rows.find((r) => r.rmse.mean > 0.1);
  return { rows, breakdownW: br ? br.w : null };
}

export interface CompareRow {
  condition: string;
  level: string;
  rmse: Stat;
  along: Stat;
  cross: Stat;
}

export function summariseCompare(recs: TrialRecord[]): CompareRow[] {
  return [...groupBy(recs, (r) => `${r.group.level}|${r.group.condition}`).entries()].map(([k, rs]) => {
    const [level, condition] = k.split('|');
    return { condition, level, rmse: stat(rs.map((r) => r.rmse[0])), along: stat(rs.map((r) => r.along[0])), cross: stat(rs.map((r) => r.cross[0])) };
  });
}

export interface SafetyCell {
  w: number;
  margin: number;
  comp: string;
  type: string;
  closest: Stat;
  intervention: Stat;
  collisions: number;
  violation: Stat;
  costOfSafety: Stat;
  emergencies: number;
  n: number;
}

export function summariseSafety(recs: TrialRecord[]): SafetyCell[] {
  return [...groupBy(recs, (r) => `${r.group.w}|${r.group.margin}|${r.group.comp}|${r.group.type}`).entries()].map(([k, rs]) => {
    const [w, margin, comp, type] = k.split('|');
    return {
      w: Number(w),
      margin: Number(margin),
      comp,
      type,
      closest: stat(rs.map((r) => r.minS)),
      intervention: stat(rs.map((r) => r.interventionRate)),
      collisions: rs.reduce((a, r) => a + r.collisions, 0),
      violation: stat(rs.map((r) => r.violationTime)),
      costOfSafety: stat(rs.flatMap((r) => r.costOfSafety ?? [])),
      emergencies: rs.reduce((a, r) => a + r.emergencies, 0),
      n: rs.length,
    };
  });
}

export interface MarginCell {
  course: string;
  obstacleMargin: number;
  gateMargin: number;
  passRate: Stat;
  obstacleIntervention: Stat;
  clearance: Stat;
  collisions: number;
  n: number;
}

export function summariseMargins(recs: TrialRecord[]): MarginCell[] {
  return [...groupBy(recs, (r) => `${r.group.course}|${r.group.obstacleMargin}|${r.group.gateMargin}`).entries()].map(([k, rs]) => {
    const [course, om, gm] = k.split('|');
    return {
      course,
      obstacleMargin: Number(om),
      gateMargin: Number(gm),
      passRate: stat(rs.map((r) => r.passRate)),
      obstacleIntervention: stat(rs.map((r) => r.obstacleIntRate)),
      clearance: stat(rs.map((r) => r.clearance)),
      collisions: rs.reduce((a, r) => a + r.collisions, 0),
      n: rs.length,
    };
  });
}

export interface ScalingRow {
  scenario: string;
  n: number;
  intervention: Stat;
  solveP99: Stat;
  closest: Stat;
  collisions: number;
  emergencies: number;
}

export function summariseScaling(recs: TrialRecord[]): ScalingRow[] {
  return [...groupBy(recs, (r) => `${r.group.scenario}|${r.group.n}`).entries()]
    .map(([k, rs]) => {
      const [scenario, n] = k.split('|');
      return {
        scenario,
        n: Number(n),
        intervention: stat(rs.map((r) => r.interventionRate)),
        solveP99: stat(rs.map((r) => r.solveP99)),
        closest: stat(rs.map((r) => r.minS)),
        collisions: rs.reduce((a, r) => a + r.collisions, 0),
        emergencies: rs.reduce((a, r) => a + r.emergencies, 0),
      };
    })
    .sort((a, b) => a.scenario.localeCompare(b.scenario) || a.n - b.n);
}

export interface RaceConditionRow {
  scenario: string;
  condition: string;
  n: number;
  winsA: number;
  winRateA: { p: number; lo: number; hi: number };
  binomialP: number;
  gaps: number[];
  gap: Stat;
  intervention: Stat;
  collisions: number;
  emergencies: number;
  predictionCorrect: number;
  predictionN: number;
  fidelity: { predicted: number; realised: number }[];
  ratio: Stat;
  sub: SubScores;
  G: number;
  score: Stat;
}

export interface RaceTest {
  scenario: string;
  metric: 'win rate A' | 'progress gap' | 'intervention rate';
  a: string;
  b: string;
  diff: number;
  p: number;
  pHolm: number;
  significant: boolean;
}

export interface RaceSeriesSummary {
  rows: RaceConditionRow[];
  tests: RaceTest[];
  stability: { scenario: string; share: number; ranking: string[] }[];
  statements: string[];
}

export function summariseRaceSeries(recs: TrialRecord[], weights: Weights = EQUAL_WEIGHTS): RaceSeriesSummary {
  const rows: RaceConditionRow[] = [];
  const byScenario = groupBy(recs, (r) => String(r.group.scenario));
  const tests: RaceTest[] = [];
  const stability: RaceSeriesSummary['stability'] = [];
  for (const [scenario, srecs] of byScenario) {
    const byCond = groupBy(srecs, (r) => String(r.group.condition));
    const condRows: RaceConditionRow[] = [];
    for (const cond of RACE_CONDITIONS.map((c) => c.name)) {
      const rs = byCond.get(cond);
      if (!rs || !rs.length) continue;
      const winsA = rs.filter((r) => r.race?.winner === 0).length;
      const gaps = rs.map((r) => r.race?.gap ?? NaN).filter(Number.isFinite);
      const pred = rs.filter((r) => r.race?.predictedWinner !== undefined);
      const fid = rs
        .filter((r) => Number.isFinite(r.race?.predictedGap) && Number.isFinite(r.race?.realisedGapAtHorizon))
        .map((r) => ({ predicted: r.race!.predictedGap!, realised: r.race!.realisedGapAtHorizon! }));
      const sub = {
        S: mean(rs.map((r) => r.sub.S)),
        V: mean(rs.map((r) => r.sub.V)),
        A: mean(rs.map((r) => r.sub.A)),
        E: mean(rs.map((r) => r.sub.E)),
      };
      const row: RaceConditionRow = {
        scenario,
        condition: cond,
        n: rs.length,
        winsA,
        winRateA: wilson(winsA, rs.length),
        binomialP: binomialTest(winsA, rs.length, 0.5),
        gaps,
        gap: stat(gaps),
        intervention: stat(rs.map((r) => r.interventionRate)),
        collisions: rs.reduce((a, r) => a + r.collisions, 0),
        emergencies: rs.reduce((a, r) => a + (r.emergencies > 0 ? 1 : 0), 0),
        predictionCorrect: pred.filter((r) => r.race!.predictedWinner === r.race!.winner).length,
        predictionN: pred.length,
        fidelity: fid,
        ratio: stat(fid.filter((f) => Math.abs(f.predicted) > 0.05).map((f) => f.realised / f.predicted)),
        sub,
        G: mean(rs.map((r) => r.G)),
        score: stat(rs.map((r) => r.score)),
      };
      condRows.push(row);
      rows.push(row);
    }
    // pairwise permutation tests between conditions, Holm-corrected within the scenario
    const scenarioTests: RaceTest[] = [];
    for (let a = 0; a < condRows.length; a++) {
      for (let b = a + 1; b < condRows.length; b++) {
        const A = byCond.get(condRows[a].condition)!;
        const B = byCond.get(condRows[b].condition)!;
        const metrics: [RaceTest['metric'], (r: TrialRecord) => number][] = [
          ['win rate A', (r) => (r.race?.winner === 0 ? 1 : 0)],
          ['progress gap', (r) => r.race?.gap ?? NaN],
          ['intervention rate', (r) => r.interventionRate],
        ];
        for (const [metric, f] of metrics) {
          const xa = A.map(f).filter(Number.isFinite);
          const xb = B.map(f).filter(Number.isFinite);
          const pt = permutationTest(xa, xb, { permutations: 2000, seed: 11 + a * 7 + b });
          scenarioTests.push({ scenario, metric, a: condRows[a].condition, b: condRows[b].condition, diff: pt.diff, p: pt.p, pHolm: NaN, significant: false });
        }
      }
    }
    const adj = holm(scenarioTests.map((t) => t.p));
    scenarioTests.forEach((t, i) => {
      t.pHolm = adj[i];
      t.significant = adj[i] < 0.05;
    });
    tests.push(...scenarioTests);
    const conds: ConditionScore[] = condRows.map((r) => ({ name: r.condition, G: r.G, sub: r.sub }));
    if (conds.length > 1) {
      const st = rankingStability(conds, weights, 200, 99);
      stability.push({ scenario, share: st.share, ranking: st.reference.map((i) => conds[i].name) });
    }
  }
  const statements: string[] = [];
  for (const t of tests.filter((x) => x.significant)) {
    const what = t.metric === 'win rate A' ? `drone A's win rate` : t.metric === 'progress gap' ? 'the final progress gap (A − B)' : 'the intervention rate';
    statements.push(`${t.scenario}: ${what} differs between ${t.a} and ${t.b} (difference ${t.diff.toFixed(2)}, Holm-corrected p = ${t.pHolm.toFixed(3)}).`);
  }
  if (!statements.length) statements.push('No difference between conditions is statistically supported after Holm correction at the 5% level.');
  return { rows, tests, stability, statements };
}
