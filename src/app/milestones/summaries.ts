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
  { G: 0.5, reason: 'supervisor emergency brake or geofence hover' },
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

// ---- plain-language statements of the summary steps ------------------------------------------
// Pure string builders (no React), so the wording can be unit-tested against the records.

const f = (x: number, d = 2): string => (Number.isFinite(x) ? x.toFixed(d) : '–');
const fcm = (x: number, d = 1): string => (Number.isFinite(x) ? `${(x * 100).toFixed(d)} cm` : '–');
const fpct = (x: number, d = 0): string => (Number.isFinite(x) ? `${(x * 100).toFixed(d)}%` : '–');
/** "1.6 cm (95% CI 1.6–1.7 cm)" when there is an interval, else the mean alone. */
const withCI = (s: Stat, fx: (x: number) => string): string => (s.n > 1 && Number.isFinite(s.lo) ? `${fx(s.mean)} (95% CI ${fx(s.lo)}–${fx(s.hi)})` : fx(s.mean));

const cap = (x: string): string => x.charAt(0).toUpperCase() + x.slice(1);

/** Is a lower than b, higher, or are the 95% intervals overlapping (no supported difference)? */
export function compareStats(a: Stat, b: Stat): 'lower' | 'higher' | 'overlap' {
  if (!(a.n > 0 && b.n > 0)) return 'overlap';
  if (a.hi < b.lo) return 'lower';
  if (a.lo > b.hi) return 'higher';
  return 'overlap';
}

export function m1Statements(speed: M1Speed | null, cmp: M1CompareLevel[] | null): string[] {
  const out: string[] = [];
  if (speed) {
    const b = speed.baseline;
    if (b) out.push(`At the baseline w = ${f(b.w, 3)} rad/s (${f(b.meanSpeed)} m/s mean) the tracking RMSE is ${withCI(b.rmse, (x) => fcm(x))}, ${b.rmse.mean <= 0.02 ? 'within' : 'above'} the 2 cm of Crazyswarm’s published baseline.`);
    if (speed.breakdown) out.push(`Tracking breaks down (mean RMSE above ${fcm(BREAKDOWN_RMSE, 0)}) at w = ${f(speed.breakdown.w)} rad/s, ${f(speed.breakdown.meanSpeed)} m/s mean speed.`);
    else out.push(`No breakdown: the mean RMSE stays below ${fcm(BREAKDOWN_RMSE, 0)} up to w = ${f(speed.fastest.w)} rad/s (${f(speed.fastest.meanSpeed)} m/s mean), where it reaches ${fcm(speed.fastest.rmse.mean)}.`);
    const fast = speed.fastest;
    out.push(
      `At the fastest level the error is mostly ${fast.along.mean >= fast.cross.mean ? 'along-track (lagging behind the reference: latency)' : 'cross-track (cutting the corners: thrust limits)'}: along ${fcm(fast.along.mean)}, cross ${fcm(fast.cross.mean)}.`,
    );
  }
  // one sentence per comparison, covering both speed levels
  const levels = cmp ?? [];
  const short = (level: string) => level.replace(/\s*\(.*\)$/, '');
  const compare = (pickA: (l: M1CompareLevel) => CompareRow | undefined, nameA: string, nameB: string, better: string, worse: string) => {
    const rows = levels.map((l) => ({ l, a: pickA(l), b: l.streamed })).filter((x): x is { l: M1CompareLevel; a: CompareRow; b: CompareRow } => !!x.a && !!x.b);
    if (!rows.length) return;
    const parts = rows.map((x) => `${fcm(x.a.rmse.mean)} vs ${fcm(x.b.rmse.mean)} (${short(x.l.level)})`);
    const verdicts = rows.map((x) => compareStats(x.a.rmse, x.b.rmse));
    let verdict: string;
    if (verdicts.every((v) => v === 'lower')) verdict = `${better} (95% intervals do not overlap at ${rows.length > 1 ? 'either speed' : 'this speed'}).`;
    else if (verdicts.every((v) => v === 'higher')) verdict = `${worse} (95% intervals do not overlap).`;
    else if (verdicts.every((v) => v === 'overlap')) verdict = 'The difference is within the trial-to-trial spread (95% intervals overlap).';
    else verdict = cap(`${rows.map((x, i) => (verdicts[i] === 'overlap' ? `no supported difference at ${short(x.l.level)}` : `${nameA} ${verdicts[i]} at ${short(x.l.level)}`)).join('; ')} (95% intervals).`);
    out.push(`${nameA} vs ${nameB} RMSE: ${parts.join(', ')}. ${verdict}`);
  };
  compare((l) => l.uploaded, 'Uploaded', 'streamed', 'Running the trajectory on board removes the radio latency and the lag it causes', 'Uploading did not help here');
  compare((l) => l.pid, 'PID-like', 'Mellinger-like', 'The PID-like controller did better here', 'Without acceleration feed-forward the controller only reacts to errors after they appear');
  return out;
}

const monotone = (xs: number[], dir: 1 | -1): boolean => xs.every((x, i) => i === 0 || dir * (x - xs[i - 1]) >= -1e-12);

export function m2Statements(safety: M2Safety | null, margins: M2MarginCourse[] | null, scaling: M2Scaling | null): string[] {
  const out: string[] = [];
  if (safety) {
    out.push(
      `${safety.n} filtered T5 trials (3 speeds × 3 margins × latency compensation on/off × 2 filter types): ${safety.withCollision === 0 ? 'no collision' : `${safety.withCollision} with a collision`}${safety.emergencies ? `, ${safety.emergencies} with an emergency brake` : ''}; closest approach ${f(safety.closestMin)} (scaled separation, 1 = edge of the downwash zone).`,
    );
    out.push(`The filter intervened on ${fpct(safety.interventionCells[0])} to ${fpct(safety.interventionCells[1])} of control ticks, depending on speed, margin and filter type.`);
    const costs = safety.cost.filter((c) => c.stat.n > 0);
    if (costs.length) {
      const grows = costs.length > 1 && monotone(costs.map((c) => c.stat.mean), 1);
      out.push(`Cost of safety (M15, extra tracking RMSE from sharing the airspace, default filter): ${costs.map((c) => `${fcm(c.stat.mean)} at margin ×${c.margin}`).join(', ')}${grows ? ': it grows with the margin.' : '.'}`);
    }
  }
  for (const m of margins ?? []) {
    const first = m.byGate[0];
    const last = m.byGate[m.byGate.length - 1];
    if (!first || !last) continue;
    const drop = last.pass.mean < first.pass.mean - 1e-9;
    out.push(
      `${m.course}: gate pass rate ${m.byGate.map((g) => fpct(g.pass.mean)).join(' → ')} as the gate margin grows ${m.byGate.map((g) => f(g.gateMargin)).join(' → ')} m. ${
        drop ? 'Wider gate margins make the filter treat the gate edges as closer than they are, until it refuses legal passes: that is filter conservatism.' : 'The pass rate does not drop at these margins.'
      }`,
    );
    const cl = m.byObstacle.map((o) => o.clearance.mean).filter(Number.isFinite);
    if (cl.length > 1) out.push(`${m.course}: obstacle clearance ${f(Math.min(...cl))} to ${f(Math.max(...cl))} m across obstacle margins ${f(m.byObstacle[0].obstacleMargin)} to ${f(m.byObstacle[m.byObstacle.length - 1].obstacleMargin)} m${m.collisions ? `; ${m.collisions} trials with a contact` : ', no contact'}.`);
  }
  if (scaling) {
    for (const sc of scaling.scenarios) {
      const rows = scaling.rows.filter((r) => r.scenario === sc);
      if (!rows.length) continue;
      const a = rows[0];
      const b = rows[rows.length - 1];
      const col = rows.reduce((s, r) => s + r.collisions, 0);
      out.push(
        `${sc}: intervention rate ${fpct(a.intervention.mean)} with ${a.n} drones, ${fpct(b.intervention.mean)} with ${b.n}; worst 99th-percentile filter solve time ${f(Math.max(...rows.map((r) => r.solveP99.mean)), 1)} ms per tick; ${col ? `${col} collisions` : 'no collisions'}.`,
      );
    }
  }
  return out;
}
