/**
 * Headline numbers of the guided modes (Section 12 summary cards, Section 13 worked examples).
 * Pure functions of the core models and of the experiment records: the only values typed in by
 * hand are the inputs of the spec's worked examples. Everything shown is a simulation result.
 */
import { G, PRESETS, type DronePresetId } from '../../core/constants';
import {
  stat,
  summariseCompare,
  summariseRaceSeries,
  summariseSafety,
  summariseScaling,
  summariseSpeedSweep,
  type CompareRow,
  type RaceConditionRow,
  type RaceSeriesSummary,
  type SafetyCell,
  type ScalingRow,
  type SpeedSweepRow,
  type Stat,
  type TrialRecord,
} from '../../core/experiments';
import { tiltAtLimit, usableThrust } from '../../core/feasibility';
import { compositeScore, ranking, rankingStability, type SubScores, type Weights } from '../../core/metrics/scorecard';
import { ecbfPair, pairD, scaledSeparation } from '../../core/safety/ecbf';
import { closedFormPair } from '../../core/safety/qp';
import { figure8MaxW, figure8MeanSpeed, figure8PeakAccel, figure8PeakSpeed, FIGURE8_PEAK_ACCEL_COEFF, horizontalLimit } from '../../core/trajectories/figure8';
import { v3 } from '../../core/vec';

const ok = (recs: TrialRecord[]) => recs.filter((r) => !r.error);

/** Do two 95% intervals overlap? (A quick, conservative reading of "is the difference real".) */
export function overlaps(a: Stat, b: Stat): boolean {
  return !(a.lo > b.hi || b.lo > a.hi);
}

// ---- M1: feasibility formula card ------------------------------------------------------------

export interface FeasibilityNumbers {
  presetName: string;
  twr: number;
  eta: number;
  g: number;
  /** eta TWR g (m/s^2). */
  usable: number;
  /** sqrt(usable^2 - g^2): largest horizontal acceleration in level flight (m/s^2). */
  horizontal: number;
  tiltDeg: number;
  coeff: number;
  A: number;
  w: number;
  peakAccel: number;
  /** |a + g e_z| at the peak (m/s^2). */
  peakThrust: number;
  feasible: boolean;
  lap: number;
  meanSpeed: number;
  wMax: number;
  lapAtMax: number;
  meanAtMax: number;
  peakSpeedAtMax: number;
}

export function feasibilityNumbers(preset: DronePresetId, eta: number, A: number, w: number): FeasibilityNumbers {
  const twr = PRESETS[preset].twr;
  const horizontal = horizontalLimit(twr, eta);
  const peakAccel = figure8PeakAccel(A, w);
  const wMax = figure8MaxW(A, twr, eta);
  return {
    presetName: PRESETS[preset].name,
    twr,
    eta,
    g: G,
    usable: usableThrust(twr, eta),
    horizontal,
    tiltDeg: tiltAtLimit(twr, eta),
    coeff: FIGURE8_PEAK_ACCEL_COEFF,
    A,
    w,
    peakAccel,
    peakThrust: Math.hypot(peakAccel, G),
    feasible: peakAccel <= horizontal + 1e-9,
    lap: (2 * Math.PI) / w,
    meanSpeed: figure8MeanSpeed(A, w),
    wMax,
    lapAtMax: (2 * Math.PI) / wMax,
    meanAtMax: figure8MeanSpeed(A, wMax),
    peakSpeedAtMax: figure8PeakSpeed(A, wMax),
  };
}

// ---- M2: CBF worked example (Section 13) -----------------------------------------------------

/** Two drones head-on: (0, 0, 1) and (0.5, 0, 1) at (1, 0, 0) and (-1, 0, 0), zero nominal input, lambda = 4. */
export function cbfWorkedExample() {
  const p1 = v3(0, 0, 1);
  const p2 = v3(0.5, 0, 1);
  const v1 = v3(1, 0, 0);
  const v2 = v3(-1, 0, 0);
  const lambda = 4;
  const D = pairD(1);
  const con = ecbfPair(0, 1, p1, v1, p2, v2, D, lambda);
  const r = closedFormPair(v3(), v3(), con.a, con.b);
  return { p1, p2, v1, v2, lambda, D, h: con.h, hdot: con.hdot ?? NaN, a: con.a, b: con.b, c: r.c, u1: r.ui, u2: r.uj, s: scaledSeparation(p1, p2, D) };
}

// ---- M1: speed sweep and comparisons ---------------------------------------------------------

export const BASELINE_W = 0.522;
export const BREAKDOWN_RMSE = 0.1;

export interface M1Speed {
  rows: SpeedSweepRow[];
  baseline?: SpeedSweepRow;
  /** First level whose mean RMSE exceeds 10 cm. */
  breakdown?: SpeedSweepRow;
  fastest: SpeedSweepRow;
  worst: SpeedSweepRow;
  trials: number;
}

export function m1Speed(recs: TrialRecord[]): M1Speed | null {
  const rs = ok(recs);
  if (!rs.length) return null;
  const { rows, breakdownW } = summariseSpeedSweep(rs);
  if (!rows.length) return null;
  return {
    rows,
    baseline: rows.find((r) => Math.abs(r.w - BASELINE_W) < 1e-6),
    breakdown: breakdownW === null ? undefined : rows.find((r) => r.w === breakdownW),
    fastest: rows[rows.length - 1],
    worst: rows.reduce((a, b) => (b.rmse.mean > a.rmse.mean ? b : a)),
    trials: rs.length,
  };
}

export interface M1CompareLevel {
  level: string;
  rows: CompareRow[];
  streamed?: CompareRow;
  uploaded?: CompareRow;
  pid?: CompareRow;
}

export function m1Compare(recs: TrialRecord[]): M1CompareLevel[] | null {
  const rs = ok(recs);
  if (!rs.length) return null;
  const rows = summariseCompare(rs);
  const levels = [...new Set(rows.map((r) => r.level))].sort((a, b) => (a.startsWith('baseline') ? -1 : b.startsWith('baseline') ? 1 : a.localeCompare(b)));
  return levels.map((level) => {
    const lr = rows.filter((r) => r.level === level);
    return {
      level,
      rows: lr,
      streamed: lr.find((r) => /^Streamed/.test(r.condition) && /Mellinger/.test(r.condition)),
      uploaded: lr.find((r) => /^Uploaded/.test(r.condition)),
      pid: lr.find((r) => /PID/.test(r.condition)),
    };
  });
}

// ---- M2: safety, margins, scaling ------------------------------------------------------------

/** A live T5 / T11 trial (recorded in the Results list), filter on or off. */
export interface LiveSafetyRun {
  filterOn: boolean;
  collided: boolean;
  minS: number;
  intervention: number;
}

export interface M2Safety {
  n: number;
  withCollision: number;
  emergencies: number;
  /** Lowest scaled separation in any trial. */
  closestMin: number;
  /** Range of the per-cell mean closest approach. */
  closestCells: [number, number];
  interventionCells: [number, number];
  cost: { margin: number; stat: Stat }[];
  cells: SafetyCell[];
}

export function m2Safety(recs: TrialRecord[]): M2Safety | null {
  const rs = ok(recs);
  if (!rs.length) return null;
  const cells = summariseSafety(rs);
  const cm = cells.map((c) => c.closest.mean).filter(Number.isFinite);
  const im = cells.map((c) => c.intervention.mean).filter(Number.isFinite);
  const margins = [...new Set(rs.map((r) => Number(r.group.margin)))].sort((a, b) => a - b);
  return {
    n: rs.length,
    withCollision: rs.filter((r) => r.collisions > 0).length,
    emergencies: rs.filter((r) => r.emergencies > 0).length,
    closestMin: Math.min(...rs.map((r) => r.minS).filter(Number.isFinite)),
    closestCells: [Math.min(...cm), Math.max(...cm)],
    interventionCells: [Math.min(...im), Math.max(...im)],
    // M15 is computed for the default filter configuration (ECBF, latency compensation on)
    cost: margins.map((m) => ({ margin: m, stat: stat(rs.filter((r) => Number(r.group.margin) === m).flatMap((r) => r.costOfSafety ?? [])) })),
    cells,
  };
}

export interface M2MarginCourse {
  course: string;
  /** Gate pass rate per gate margin, pooled over the obstacle margins. */
  byGate: { gateMargin: number; pass: Stat }[];
  /** Obstacle clearance per obstacle margin, pooled over the gate margins. */
  byObstacle: { obstacleMargin: number; clearance: Stat; intervention: Stat }[];
  collisions: number;
  n: number;
}

export function m2Margins(recs: TrialRecord[]): M2MarginCourse[] | null {
  const rs = ok(recs);
  if (!rs.length) return null;
  const courses = [...new Set(rs.map((r) => String(r.group.course)))];
  return courses.map((course) => {
    const cr = rs.filter((r) => r.group.course === course);
    const gms = [...new Set(cr.map((r) => Number(r.group.gateMargin)))].sort((a, b) => a - b);
    const oms = [...new Set(cr.map((r) => Number(r.group.obstacleMargin)))].sort((a, b) => a - b);
    return {
      course,
      byGate: gms.map((gm) => ({ gateMargin: gm, pass: stat(cr.filter((r) => Number(r.group.gateMargin) === gm).map((r) => r.passRate)) })),
      byObstacle: oms.map((om) => {
        const or = cr.filter((r) => Number(r.group.obstacleMargin) === om);
        return { obstacleMargin: om, clearance: stat(or.map((r) => r.clearance)), intervention: stat(or.map((r) => r.obstacleIntRate)) };
      }),
      collisions: cr.filter((r) => r.collisions > 0).length,
      n: cr.length,
    };
  });
}

export interface M2Scaling {
  rows: ScalingRow[];
  scenarios: string[];
  maxN: number;
}

export function m2Scaling(recs: TrialRecord[]): M2Scaling | null {
  const rs = ok(recs);
  if (!rs.length) return null;
  const rows = summariseScaling(rs);
  return { rows, scenarios: [...new Set(rows.map((r) => r.scenario))], maxN: Math.max(...rows.map((r) => r.n)) };
}

export function liveSafetyCounts(runs: LiveSafetyRun[]) {
  const part = (on: boolean) => {
    const rs = runs.filter((r) => r.filterOn === on);
    return { n: rs.length, collided: rs.filter((r) => r.collided).length, minS: rs.length ? Math.min(...rs.map((r) => r.minS).filter(Number.isFinite)) : NaN };
  };
  return { off: part(false), on: part(true) };
}

// ---- M3: race series -------------------------------------------------------------------------

export interface M3Summary extends RaceSeriesSummary {
  scenarios: string[];
  byScenario: Map<string, RaceConditionRow[]>;
  races: number;
}

export function m3Summary(recs: TrialRecord[], weights: Weights): M3Summary | null {
  const rs = ok(recs);
  if (!rs.length) return null;
  const s = summariseRaceSeries(rs, weights);
  const scenarios = [...new Set(s.rows.map((r) => r.scenario))];
  return { ...s, scenarios, byScenario: new Map(scenarios.map((sc) => [sc, s.rows.filter((r) => r.scenario === sc)])), races: rs.length };
}

// ---- Scorecard mode --------------------------------------------------------------------------

/** The worked example of Section 12 (sub-scores as given in the spec). */
export const WORKED_STRATEGIES: { name: string; sub: SubScores; quoted: number }[] = [
  { name: 'Strategy 1', sub: { S: 0.94, V: 0.87, A: 0.7, E: 0.87 }, quoted: 0.85 },
  { name: 'Strategy 2', sub: { S: 0.83, V: 0.95, A: 0.62, E: 0.83 }, quoted: 0.81 },
];

/** Gate factor levels of Section 9 and what triggers each. */
export const GATE_LEVELS: { G: number; reason: string }[] = [
  { G: 1, reason: 'clean run' },
  { G: 0.75, reason: 'separation violation without contact' },
  { G: 0.5, reason: 'supervisor emergency brake' },
  { G: 0, reason: 'collision, gate strike, obstacle hit, left the arena, kill or missed gate' },
];

export interface ScoredItem {
  key: string;
  name: string;
  detail?: string;
  kind: 'example' | 'trial';
  G: number;
  sub: SubScores;
  score: number;
}

/** Score and rank a set of items under the given weights, with the ranking stability share. */
export function rankItems(items: Omit<ScoredItem, 'score'>[], w: Weights): { ranked: (ScoredItem & { rank: number })[]; stability: number | null } {
  const conds = items.map((x) => ({ name: x.name, G: x.G, sub: x.sub }));
  const order = ranking(conds, w);
  const ranked = order.map((i, r) => ({ ...items[i], score: compositeScore(items[i].G, items[i].sub, w), rank: r + 1 }));
  return { ranked, stability: items.length > 1 ? rankingStability(conds, w, 200, 99).share : null };
}

export const weightSum = (w: Weights): number => w.S + w.V + w.A + w.E;
