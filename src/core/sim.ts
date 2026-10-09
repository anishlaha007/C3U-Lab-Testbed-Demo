/**
 * Headless, deterministic multi-drone simulation (Sections 4, 6, 8).
 *
 * Fixed physics step of 1 ms. Per physics tick, in order:
 *   1. Vicon sampling (f_vicon) with noise / marker swaps -> sensing queue (delay tau_s)
 *   2. sensing deliveries -> ground estimators (jump rejection, low-pass velocity)
 *   3. ground control (f_ctrl): executor nominal -> u_nom, safety filter -> u_safe, supervisor,
 *      reference consistency -> setpoint packet -> command queue (delay tau_c)
 *   4. command deliveries -> onboard setpoint
 *   5. onboard controller (100 Hz) -> a_cmd (zero-order hold)
 *   6. dynamics (thrust cone, acceleration lag, wind, battery)
 *   7. physics-rate checks: collisions, separation, gates, obstacles, arena, laps
 * The race clock starts at t = 0 with a flying start on the reference (takeoff and entry are
 * outside the analysis window).
 */
import { COLLISION_DIST, DRONE_RADIUS, DT_PHYS, G, PRESETS } from './constants';
import { CourseGeometry, gateCrossing } from './course';
import { latencies } from './defaults';
import { OUWind, batteryTwr, makeDroneState, startFalling, stepDrone, type DroneState } from './dynamics';
import { Executor } from './executor';
import { distanceToPrimitive, nearBounds, primitiveBounds, type Primitive } from './geometry';
import { OnboardController } from './onboard';
import { computePlanned, plannedEffortUpTo } from './planned';
import { replanFromState } from './planners/replan';
import { ProgressTracker } from './planners/track';
import { raceSetup } from './race';
import { deriveSeed, Rng } from './rng';
import { pairD, scaledSeparation } from './safety/ecbf';
import { pairIndex, pairList, runSafetyFilter, type FilterDrone, type FilterResult } from './safety/filter';
import { buildScenario, dronesFor, raceDuration, type BuildOverrides, type ScenarioBuild } from './scenario';
import { GroundEstimator, OnboardEstimator, type ViconSample } from './sensing';
import {
  MODE_CODE,
  brakeSetpoint,
  geofencePoint,
  hoverSetpoint,
  insideGeofence,
  outsideArena,
  predictViolation,
  type SupervisorMode,
} from './supervisor';
import { DelayQueue, RateTask, periodTicks } from './time';
import { sampleScaled } from './trajectories/common';
import type { DroneLog, GateVisit, PairLog, Setpoint, SimConfig, SimEvent, SimEventType, TrialLog } from './types';
import { v3, type Vec3 } from './vec';

interface CmdPacket {
  sp: Setpoint;
  tSent: number;
  tCapture: number;
}

export interface SimDrone {
  id: number;
  twr0: number;
  state: DroneState;
  exec: Executor;
  ctrl: OnboardController;
  ground: GroundEstimator;
  onboard: OnboardEstimator;
  cmdQ: DelayQueue<CmdPacket>;
  setpoint: Setpoint;
  lastArrival: number;
  aCmd: Vec3;
  mode: SupervisorMode;
  crashed: boolean;
  hoverPoint: Vec3 | null;
  /** Where the onboard loop holds during a stale-setpoint episode (cleared when packets resume). */
  staleHoverPoint: Vec3 | null;
  stale: boolean;
  wind: OUWind;
  noise: Rng;
  progress: ProgressTracker | null;
  /** Sent commands (time, intended acceleration) for latency compensation. */
  sent: { t: number; u: Vec3 }[];
  // filter outputs for display
  uNom: Vec3;
  uSafe: Vec3;
  correction: number;
  intervened: boolean;
  pairActive: boolean;
  obsActive: boolean;
  wasIntervening: boolean;
  // gates
  visits: GateVisit[];
  nextVisit: number;
  passes: number;
  misses: number;
  strikes: number;
  passTimes: { k: number; t: number }[];
  finishTime: number;
  // laps
  lapSide: number;
  lastLapT: number;
  /** Gate misses / strikes at the last lap boundary (a lap counts only if it adds none). */
  missesAtLap: number;
  strikesAtLap: number;
  lapTimes: number[];
  // accumulators
  pathLength: number;
  effort: number;
  peakBraking: number;
  prevP: Vec3;
  nearestS: number;
}

export interface SimOptions extends BuildOverrides {
  /** Skip all logging (fast rollouts). */
  noLog?: boolean;
  /** Prebuilt scenario (skips buildScenario). */
  build?: ScenarioBuild;
}

const EMPTY_SUMMARY = (): TrialLog['summary'] => ({
  endReason: 'timeout',
  endTime: 0,
  raceEnd: 0,
  minCentreDistance: Infinity,
  minScaledSeparation: Infinity,
  violationTime: 0,
  collisions: 0,
  emergencies: 0,
  geofenceEvents: 0,
  arenaExits: 0,
  staleEvents: 0,
  viconJumps: 0,
  killed: false,
  peakBraking: [],
  obstacleClearance: Infinity,
  gates: [],
  measuredLatency: NaN,
  lapTimes: [],
  lapsCompleted: [],
  pathLength: [],
  effort: [],
  ecbfInitWarnings: 0,
  clippedTicks: 0,
  ctrlTicks: 0,
  replans: 0,
  replanMsMax: 0,
});

function emptyDroneLog(): DroneLog {
  const keys: (keyof DroneLog)[] = [
    'px', 'py', 'pz', 'vx', 'vy', 'vz', 'rx', 'ry', 'rz', 'rvx', 'rvy', 'rvz', 'fx', 'fy', 'fz',
    'unx', 'uny', 'unz', 'usx', 'usy', 'usz', 'thx', 'thy', 'thz', 'intervened', 'obsIntervened',
    'pairIntervened', 'correction', 'progress', 'twr', 'mode',
  ];
  const o = {} as DroneLog;
  for (const k of keys) o[k] = [];
  return o;
}

/** FNV-style hash of a JSON string (config fingerprint). */
export function hashText(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x5bd1e995);
  }
  return ((h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0'));
}

const periodTicksOf = (hz: number) => periodTicks(hz, DT_PHYS);

export class Simulation {
  readonly cfg: SimConfig;
  readonly build: ScenarioBuild;
  readonly n: number;
  readonly dt = DT_PHYS;
  tick = 0;
  t = 0;
  readonly tauS: number;
  readonly tauC: number;
  readonly raceEnd: number;
  readonly drones: SimDrone[];
  readonly geom: CourseGeometry;
  readonly log: TrialLog;
  done = false;
  private endAt = Infinity;
  private readonly vicon: RateTask;
  private readonly ctrlTask: RateTask;
  private readonly onboardTask: RateTask;
  private readonly viconQ = new DelayQueue<ViconSample>();
  private readonly swapRng: Rng;
  private readonly crashRng: Rng;
  private readonly lossRng: Rng;
  private readonly Dunit: Vec3;
  private readonly pairs: [number, number][];
  private violating: boolean[];
  private lastPrims: Primitive[] = [];
  private lastFilter: FilterResult | null = null;
  private latencySum = 0;
  private latencyCount = 0;
  private overtakeSign = 0;
  private readonly noLog: boolean;
  private filterWasEnabled = false;
  private infeasibleTicks = 0;
  private lastReplan = 0;
  private replanRound = 0;
  /** Pure double-integrator mode with the reference (control-rate, semi-implicit) discretisation. */
  private readonly pureRef: boolean;

  constructor(cfg: SimConfig, opts: SimOptions = {}) {
    this.cfg = cfg;
    this.build = opts.build ?? buildScenario(cfg, opts);
    const b = this.build;
    this.n = b.trajectories.length;
    const lat = latencies(cfg.system);
    const pure = cfg.system.pureDoubleIntegrator;
    this.pureRef = pure && cfg.system.pureDiscretization === 'reference';
    const ctrlT = periodTicksOf(cfg.system.fCtrl) * DT_PHYS;
    this.tauS = pure ? 0 : lat.tauS;
    // pure mode: all latency is command delay; the reference discretisation rounds it down to
    // whole control periods (as in the preliminary study)
    this.tauC = pure ? (this.pureRef ? Math.floor((lat.tauS + lat.tauC) / ctrlT + 1e-9) * ctrlT : lat.tauS + lat.tauC) : lat.tauC;
    this.raceEnd = raceDuration(b);
    this.vicon = new RateTask(cfg.system.fVicon, this.dt);
    this.ctrlTask = new RateTask(cfg.system.fCtrl, this.dt);
    this.onboardTask = new RateTask(cfg.system.fOnboard, this.dt);
    this.swapRng = new Rng(deriveSeed(cfg.seed, 'markerSwap'));
    this.crashRng = new Rng(deriveSeed(cfg.seed, 'crash'));
    this.lossRng = new Rng(deriveSeed(cfg.seed, 'packetLoss'));
    this.Dunit = pairD(1);
    this.pairs = pairList(this.n);
    this.violating = this.pairs.map(() => false);
    this.noLog = !!opts.noLog;
    this.geom = new CourseGeometry(b.course, b.arena, cfg.course.dynamicObstacles);
    const droneCfgs = dronesFor(cfg, this.n);
    const visitsPerLap = b.course ? b.course.sequence : [];
    const laps = b.course ? Math.max(1, b.course.laps) : 0;
    this.drones = b.trajectories.map((tr, i) => {
      const preset = PRESETS[droneCfgs[i].preset] ?? PRESETS.CF21;
      const sp0 = sampleScaled(tr, 0, b.k);
      const p0 = droneCfgs[i].start ? { ...droneCfgs[i].start! } : sp0.p;
      const state = makeDroneState(p0, sp0.v, sp0.a, sp0.yaw, preset.twr);
      const visits: GateVisit[] = [];
      const own = b.course?.droneSequences?.[i] ?? visitsPerLap;
      for (let l = 0; l < laps; l++) visits.push(...own);
      const d: SimDrone = {
        id: i,
        twr0: preset.twr,
        state,
        exec: new Executor(tr, b.k, cfg.system.controller, pure),
        ctrl: new OnboardController(cfg.system.controller),
        ground: new GroundEstimator(p0, sp0.v),
        onboard: new OnboardEstimator(p0, sp0.v, 0.002),
        cmdQ: new DelayQueue<CmdPacket>(),
        setpoint: { p: p0, v: sp0.v, a: sp0.a, yaw: sp0.yaw },
        lastArrival: 0,
        aCmd: { ...sp0.a },
        mode: 'normal',
        crashed: false,
        hoverPoint: null,
        staleHoverPoint: null,
        stale: false,
        wind: new OUWind(cfg.system.windSigma, cfg.system.windTau, new Rng(deriveSeed(cfg.seed, 'wind', i))),
        noise: new Rng(deriveSeed(cfg.seed, 'noise', i)),
        progress: b.track ? new ProgressTracker(b.track, p0) : null,
        sent: [],
        uNom: { ...sp0.a },
        uSafe: { ...sp0.a },
        correction: 0,
        intervened: false,
        pairActive: false,
        obsActive: false,
        wasIntervening: false,
        visits,
        nextVisit: 0,
        passes: 0,
        misses: 0,
        strikes: 0,
        passTimes: [],
        finishTime: NaN,
        lapSide: 0,
        lastLapT: 0,
        missesAtLap: 0,
        strikesAtLap: 0,
        lapTimes: [],
        pathLength: 0,
        effort: 0,
        peakBraking: 0,
        prevP: { ...p0 },
        nearestS: Infinity,
      };
      return d;
    });
    this.log = {
      seed: cfg.seed,
      configHash: hashText(JSON.stringify(cfg)),
      nDrones: this.n,
      dtLog: 1 / cfg.system.fCtrl,
      t: [],
      drones: this.drones.map(() => emptyDroneLog()),
      pairs: this.pairs.map(([i, j]): PairLog => ({ i, j, s: [], d: [], h: [] })),
      solveMs: [],
      clipped: [],
      events: [],
      summary: EMPTY_SUMMARY(),
      planned: computePlanned(cfg, b),
      trackLength: b.track ? b.track.length : NaN,
    };
    this.log.summary.raceEnd = this.raceEnd;
  }

  get tRace(): number {
    return this.t;
  }

  event(type: SimEventType, extra: Partial<SimEvent> = {}): void {
    this.log.events.push({ t: this.t, type, ...extra });
  }

  /** Kill switch: motors off for every drone. */
  kill(): void {
    if (this.log.summary.killed) return;
    this.log.summary.killed = true;
    for (const d of this.drones) {
      d.mode = 'killed';
      startFalling(d.state, this.crashRng);
    }
    this.event('kill');
    this.endAt = Math.min(this.endAt, this.t + 2.0);
  }

  /** Advance the simulation by `seconds` (whole physics steps). */
  advance(seconds: number): void {
    const steps = Math.round(seconds / this.dt);
    for (let k = 0; k < steps && !this.done; k++) this.step();
  }

  runToEnd(): TrialLog {
    const tMax = this.raceEnd + this.cfg.extraTime + 5;
    while (!this.done && this.t < tMax) this.step();
    if (!this.done) this.finish('timeout');
    return this.log;
  }

  step(): void {
    if (this.done) return;
    const t = this.t;
    const tick = this.tick;
    const cfg = this.cfg;
    const sys = cfg.system;
    const pure = sys.pureDoubleIntegrator;
    const uploaded = sys.mode === 'uploaded';

    // 1-2. sensing
    if (pure) {
      for (const d of this.drones) {
        d.ground.p = { ...d.state.p };
        d.ground.v = { ...d.state.v };
        d.ground.tCapture = t;
      }
    } else {
      if (this.vicon.fires(tick)) this.sampleVicon(t);
      for (const s of this.viconQ.popReady(t)) {
        const d = this.drones[s.id];
        if (!d) continue;
        const ok = d.ground.update(s, true);
        if (!ok) {
          this.log.summary.viconJumps++;
          this.event('viconJump', { drone: s.id });
        }
      }
    }

    // 3. ground control
    if (this.ctrlTask.fires(tick)) this.controlTick(t, uploaded, pure);

    // 4. command deliveries
    for (const d of this.drones) {
      const pk = d.cmdQ.popLatest(t);
      if (pk) {
        d.setpoint = pk.sp;
        if (pure) d.aCmd = { ...pk.sp.a };
        d.lastArrival = t;
        this.latencySum += t - pk.tCapture;
        this.latencyCount++;
        if (d.stale) {
          d.stale = false;
          d.staleHoverPoint = null;
        }
      }
    }

    // 5. onboard controllers
    if (this.onboardTask.fires(tick)) {
      const dtOn = this.onboardTask.period * this.dt;
      const ctrlPeriod = this.ctrlTask.period * this.dt;
      for (const d of this.drones) {
        if (d.mode === 'killed' || d.crashed) continue;
        let sp = d.setpoint;
        if (uploaded) {
          sp = d.exec.nominal(t);
        } else if (!pure && t - d.lastArrival > 2 * ctrlPeriod + 1e-6 && t > this.tauC + 2 * ctrlPeriod) {
          if (!d.stale) {
            d.stale = true;
            this.log.summary.staleEvents++;
            this.event('stale', { drone: d.id });
            // hold where the drone is now (a geofence hover keeps its own point)
            d.staleHoverPoint = d.hoverPoint ?? { ...d.onboard.latest.p };
          }
          sp = hoverSetpoint(d.staleHoverPoint ?? d.onboard.latest.p, d.setpoint.yaw);
        }
        if (!pure) {
          const est = d.onboard.read(t);
          d.aCmd = d.ctrl.compute(sp, est.p, est.v, dtOn);
        }
      }
    }

    // 6. dynamics
    const dyn = {
      thetaMax: (sys.thetaMaxDeg * Math.PI) / 180,
      tauA: sys.tauA,
      pureDoubleIntegrator: pure,
      pureAccelLimit: sys.pureAccelLimit,
    };
    const ctrlPeriod = this.ctrlTask.period;
    for (const d of this.drones) {
      d.prevP = { ...d.state.p };
      d.state.twr = batteryTwr(d.twr0, sys.batterySag, t);
      if (this.pureRef) {
        // reference discretisation: one semi-implicit Euler step per control period, applied
        // on the last physics tick of the period
        if ((tick + 1) % ctrlPeriod === 0 && d.state.phase === 'flying') this.pureRefStep(d, ctrlPeriod * this.dt);
        else if (d.state.phase !== 'flying') stepDrone(d.state, v3(), v3(), this.dt, dyn);
        continue;
      }
      const wind = pure ? v3() : d.wind.step(this.dt);
      stepDrone(d.state, d.mode === 'killed' || d.crashed ? v3() : d.aCmd, wind, this.dt, dyn);
      if (!pure) {
        const n = d.noise;
        d.onboard.push(t + this.dt, {
          p: v3(d.state.p.x + n.gauss(0, 0.0005), d.state.p.y + n.gauss(0, 0.0005), d.state.p.z + n.gauss(0, 0.0005)),
          v: v3(d.state.v.x + n.gauss(0, 0.005), d.state.v.y + n.gauss(0, 0.005), d.state.v.z + n.gauss(0, 0.005)),
        });
      }
    }

    this.tick++;
    this.t = this.tick * this.dt;

    // 7. physics-rate checks
    this.physicsChecks();

    if (this.t >= this.endAt) this.finish(this.endReasonPending ?? 'completed');
    else if (this.t >= this.raceEnd + cfg.extraTime && this.endAt === Infinity) this.finish('completed');
  }

  private endReasonPending: TrialLog['summary']['endReason'] | null = null;

  private replan(t: number): void {
    this.lastReplan = t;
    const setup = raceSetup(this.cfg);
    if (!setup) return;
    const res = replanFromState(
      this.cfg,
      setup,
      this.drones.map((d) => ({ p: d.ground.p, v: d.ground.v, progress: d.progress ? d.progress.progress : 0, active: !d.crashed && d.mode === 'normal' })),
      t,
      this.replanRound++,
    );
    if (!res) return;
    res.trajectories.forEach((tr, i) => {
      if (!tr) return;
      const d = this.drones[i];
      d.exec.replaceTrajectory(tr, t);
      d.exec.mode = 'nominal';
    });
    this.log.summary.replans++;
    this.log.summary.replanMsMax = Math.max(this.log.summary.replanMsMax, res.solveMs);
    this.event('replan', { detail: `${res.solveMs.toFixed(0)} ms` });
  }

  private pureRefStep(d: SimDrone, T: number): void {
    const s = d.state;
    let a = d.aCmd;
    const lim = this.cfg.system.pureAccelLimit;
    const n = Math.hypot(a.x, a.y, a.z);
    if (n > lim) a = v3((a.x * lim) / n, (a.y * lim) / n, (a.z * lim) / n);
    const sp = Math.hypot(s.v.x, s.v.y, s.v.z);
    if (sp > 0.05 && this.t <= this.raceEnd) {
      const brake = -(a.x * s.v.x + a.y * s.v.y + a.z * s.v.z) / sp;
      if (brake > d.peakBraking) d.peakBraking = brake;
    }
    s.v = v3(s.v.x + a.x * T, s.v.y + a.y * T, s.v.z + a.z * T);
    s.p = v3(s.p.x + s.v.x * T, s.p.y + s.v.y * T, s.p.z + s.v.z * T);
    s.a = { ...a };
    s.f = v3(a.x, a.y, a.z + G);
  }

  private sampleVicon(t: number): void {
    const sys = this.cfg.system;
    const meas: ViconSample[] = this.drones.map((d) => ({
      t,
      id: d.id,
      p: v3(d.state.p.x + d.noise.gauss(0, sys.viconNoise), d.state.p.y + d.noise.gauss(0, sys.viconNoise), d.state.p.z + d.noise.gauss(0, sys.viconNoise)),
    }));
    if (sys.markerSwap) {
      for (const [i, j] of this.pairs) {
        const a = this.drones[i].state.p;
        const b = this.drones[j].state.p;
        if (Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) < 0.15 && this.swapRng.next() < 0.05) {
          meas[i].id = j;
          meas[j].id = i;
          this.event('markerSwap', { drone: i, other: j });
        }
      }
    }
    for (const m of meas) this.viconQ.push(t, this.tauS, m);
  }

  /** Predict a drone's state from its estimate to the time its next command takes effect. */
  private predict(d: SimDrone, tNow: number): { p: Vec3; v: Vec3 } {
    let p = { ...d.ground.p };
    let v = { ...d.ground.v };
    const t0 = d.ground.tCapture;
    const t1 = tNow + this.tauC;
    if (t1 <= t0) return { p, v };
    // acceleration acting at time tau is the command sent at tau - tau_c (zero-order hold)
    const hist = d.sent;
    const uAt = (tau: number): Vec3 => {
      let u: Vec3 | null = null;
      for (let k = hist.length - 1; k >= 0; k--) {
        if (hist[k].t <= tau - this.tauC + 1e-9) {
          u = hist[k].u;
          break;
        }
      }
      return u ?? d.state.a; // before any command: assume the initial acceleration
    };
    const breaks = [t0];
    for (const h of hist) {
      const tb = h.t + this.tauC;
      if (tb > t0 && tb < t1) breaks.push(tb);
    }
    breaks.push(t1);
    breaks.sort((a, b) => a - b);
    for (let k = 0; k < breaks.length - 1; k++) {
      const dt = breaks[k + 1] - breaks[k];
      if (dt <= 0) continue;
      const u = uAt(breaks[k] + 1e-9);
      p = v3(p.x + v.x * dt + 0.5 * u.x * dt * dt, p.y + v.y * dt + 0.5 * u.y * dt * dt, p.z + v.z * dt + 0.5 * u.z * dt * dt);
      v = v3(v.x + u.x * dt, v.y + u.y * dt, v.z + u.z * dt);
    }
    return { p, v };
  }

  private controlTick(t: number, uploaded: boolean, pure: boolean): void {
    const cfg = this.cfg;
    const fcfg = cfg.filter;
    const sys = cfg.system;
    const dtCtrl = this.ctrlTask.period * this.dt;
    const tRace = t;
    const filterOn = fcfg.enabled && !uploaded;
    const comp = filterOn && fcfg.latencyCompensation;

    // receding-horizon re-planning (stretch): re-solve the game from the current state
    if (cfg.planner.replan && !pure && t > 0.2 && t < this.raceEnd - 0.5 && t - this.lastReplan >= cfg.planner.replanDt - 1e-9) this.replan(t);

    const preds = this.drones.map((d) => (comp ? this.predict(d, t) : { p: { ...d.ground.p }, v: { ...d.ground.v } }));
    const cands = this.drones.map((d) => d.exec.candidate(tRace));
    const uNoms = this.drones.map((d, i) => d.exec.uNominal(cands[i], preds[i].p, preds[i].v));
    for (const d of this.drones) if (d.progress) d.progress.update(d.ground.p);

    let res: FilterResult | null = null;
    if (filterOn) {
      const fd: FilterDrone[] = this.drones.map((d, i) => {
        const twr = batteryTwr(d.twr0, sys.batterySag, t);
        const active = d.mode === 'normal' && !d.crashed;
        // drones under supervisor control stay in the pair constraints with their known input
        const present = !active && !d.crashed && (d.mode === 'emergency' || d.mode === 'hover');
        const uFixed = d.mode === 'emergency' ? brakeSetpoint(preds[i].p, preds[i].v, 0.9 * Math.sqrt(Math.max(0, (sys.eta * twr * G) ** 2 - G * G)), 0).a : v3();
        return { p: preds[i].p, v: preds[i].v, uNom: present ? uFixed : uNoms[i], twr, active, present, progress: d.progress ? d.progress.progress : NaN };
      });
      // moving obstacles at the same time as the predicted drone states (t + tau_c when
      // compensating latency); physics checks use the obstacles at the current time
      this.lastPrims = this.geom.primitives(comp ? tRace + this.tauC : tRace);
      res = runSafetyFilter(fd, fcfg.obstacles ? this.lastPrims : [], {
        cfg: fcfg,
        eta: sys.eta,
        thetaMax: (sys.thetaMaxDeg * Math.PI) / 180,
        pureAccelLimit: pure ? sys.pureAccelLimit : undefined,
        dt: dtCtrl,
        reactionTime: pure ? 0 : sys.tauA + dtCtrl / 2,
      });
      if (!this.filterWasEnabled) {
        // filter activation: check the exponential CBF initial condition (Ames et al. Thm 8)
        for (const [i, j] of res.initViolations) {
          this.log.summary.ecbfInitWarnings++;
          this.event('ecbfInitWarning', { drone: i, other: j });
        }
      }
    }
    this.filterWasEnabled = filterOn;
    this.lastFilter = res;

    // supervisor: emergency brake on infeasibility or imminent violation
    if (res && fcfg.emergencyBrake && !pure) {
      const D = pairD(fcfg.marginMultiplier);
      const trigger = new Set<number>();
      // infeasibility must persist for 3 control ticks (one-tick transients are absorbed by the
      // filter's margin); an imminent violation triggers immediately
      this.infeasibleTicks = res.infeasiblePairs.length ? this.infeasibleTicks + 1 : 0;
      if (this.infeasibleTicks >= 3) {
        for (const [i, j] of res.infeasiblePairs) {
          trigger.add(i);
          trigger.add(j);
        }
      }
      for (const [i, j] of this.pairs) {
        const di = this.drones[i];
        const dj = this.drones[j];
        // pairs with at least one normal drone: a drone already braking or hovering is an obstacle
        // the normal one must not run into (only normal drones switch to emergency below)
        if (di.crashed || dj.crashed || di.mode === 'killed' || dj.mode === 'killed') continue;
        if (di.mode !== 'normal' && dj.mode !== 'normal') continue;
        if (predictViolation(preds[i].p, preds[i].v, res.uSafe[i], preds[j].p, preds[j].v, res.uSafe[j], D, 0.1)) {
          // only when currently outside (otherwise the violation is ongoing, not imminent)
          if (scaledSeparation(preds[i].p, preds[j].p, D) >= 1) {
            trigger.add(i);
            trigger.add(j);
          }
        }
      }
      for (const i of trigger) {
        const d = this.drones[i];
        if (d.mode === 'normal' && !d.crashed) {
          d.mode = 'emergency';
          this.log.summary.emergencies++;
          this.event('emergency', { drone: i });
          if (this.endAt === Infinity) {
            this.endAt = t + 2.5;
            this.endReasonPending = 'emergency';
          }
        }
      }
    }

    // per-drone setpoints
    for (let i = 0; i < this.n; i++) {
      const d = this.drones[i];
      d.uNom = uNoms[i];
      d.uSafe = res ? res.uSafe[i] : uNoms[i];
      d.correction = res ? res.correction[i] : 0;
      d.intervened = res ? res.intervened[i] : false;
      d.pairActive = res ? res.pairActive[i] : false;
      d.obsActive = res ? res.obsActive[i] : false;
      if (d.intervened && !d.wasIntervening) this.event('intervention', { drone: i });
      d.wasIntervening = d.intervened;
      if (uploaded || d.crashed || d.mode === 'killed') continue;

      // geofence
      if (cfg.filter.geofence && d.mode === 'normal' && !pure && !insideGeofence(d.ground.p, this.build.arena)) {
        d.mode = 'hover';
        d.hoverPoint = geofencePoint(d.ground.p, this.build.arena);
        this.log.summary.geofenceEvents++;
        this.event('geofence', { drone: i });
      }

      let sp: Setpoint;
      let uIntended: Vec3;
      if (d.mode === 'hover') {
        sp = hoverSetpoint(d.hoverPoint ?? d.ground.p, d.setpoint.yaw);
        uIntended = v3();
      } else if (d.mode === 'emergency') {
        const aMax = 0.9 * Math.sqrt(Math.max(0, (sys.eta * d.state.twr * G) ** 2 - G * G));
        sp = brakeSetpoint(preds[i].p, preds[i].v, aMax, d.setpoint.yaw);
        uIntended = sp.a;
      } else {
        sp = d.exec.update(tRace, dtCtrl, cands[i], d.uSafe, d.intervened, preds[i].p, preds[i].v, preds[i].p, preds[i].v);
        uIntended = d.uSafe;
      }
      d.sent.push({ t, u: uIntended });
      if (d.sent.length > 40) d.sent.splice(0, d.sent.length - 40);
      const lost = sys.packetLoss > 0 && this.lossRng.next() < sys.packetLoss;
      if (!lost) d.cmdQ.push(t, this.tauC, { sp, tSent: t, tCapture: d.ground.tCapture });
    }

    // progress, overtakes
    if (this.n >= 2 && this.drones[0].progress && this.drones[1].progress) {
      const gap = this.drones[0].progress.progress - this.drones[1].progress.progress;
      const sgn = gap > 0.05 ? 1 : gap < -0.05 ? -1 : 0;
      if (sgn !== 0) {
        if (this.overtakeSign !== 0 && sgn !== this.overtakeSign && t <= this.raceEnd) this.event('overtake', { drone: sgn > 0 ? 0 : 1, other: sgn > 0 ? 1 : 0 });
        this.overtakeSign = sgn;
      }
    }

    if (t <= this.raceEnd + 1e-9) {
      this.log.summary.ctrlTicks++;
      if (res?.clipped) this.log.summary.clippedTicks++;
    }
    if (!this.noLog) this.record(t, res);
  }

  private record(t: number, res: FilterResult | null): void {
    const L = this.log;
    L.t.push(t);
    for (let i = 0; i < this.n; i++) {
      const d = this.drones[i];
      const g = L.drones[i];
      const s = d.state;
      const nom = d.exec.nominal(t);
      const fr = d.exec.filteredRef(t) ?? nom.p;
      g.px.push(s.p.x);
      g.py.push(s.p.y);
      g.pz.push(s.p.z);
      g.vx.push(s.v.x);
      g.vy.push(s.v.y);
      g.vz.push(s.v.z);
      g.rx.push(nom.p.x);
      g.ry.push(nom.p.y);
      g.rz.push(nom.p.z);
      g.rvx.push(nom.v.x);
      g.rvy.push(nom.v.y);
      g.rvz.push(nom.v.z);
      g.fx.push(fr.x);
      g.fy.push(fr.y);
      g.fz.push(fr.z);
      g.unx.push(d.uNom.x);
      g.uny.push(d.uNom.y);
      g.unz.push(d.uNom.z);
      g.usx.push(d.uSafe.x);
      g.usy.push(d.uSafe.y);
      g.usz.push(d.uSafe.z);
      g.thx.push(s.f.x);
      g.thy.push(s.f.y);
      g.thz.push(s.f.z);
      g.intervened.push(d.intervened ? 1 : 0);
      g.obsIntervened.push(d.obsActive ? 1 : 0);
      g.pairIntervened.push(d.pairActive ? 1 : 0);
      g.correction.push(d.correction);
      g.progress.push(d.progress ? d.progress.progress : NaN);
      g.twr.push(s.twr);
      g.mode.push(d.crashed ? MODE_CODE.crashed : MODE_CODE[d.mode]);
    }
    this.pairs.forEach(([i, j], k) => {
      const a = this.drones[i].state.p;
      const b = this.drones[j].state.p;
      L.pairs[k].s.push(scaledSeparation(a, b, this.Dunit));
      L.pairs[k].d.push(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z));
      L.pairs[k].h.push(res ? res.pairH[pairIndex(i, j, this.n)] : NaN);
    });
    L.solveMs.push(res ? res.solveMs : 0);
    L.clipped.push(res?.clipped ? 1 : 0);
  }

  private crash(d: SimDrone, type: SimEventType, extra: Partial<SimEvent> = {}): void {
    if (d.crashed) return;
    d.crashed = true;
    startFalling(d.state, this.crashRng);
    this.event(type, { drone: d.id, ...extra });
    if (this.endAt === Infinity || this.endReasonPending === 'emergency') {
      this.endAt = this.t + 1.5;
      this.endReasonPending = type === 'arenaExit' ? 'arenaExit' : 'collision';
    }
  }

  private physicsChecks(): void {
    const t = this.t;
    const inRace = t <= this.raceEnd + 1e-9;
    // pairs
    for (let k = 0; k < this.pairs.length; k++) {
      const [i, j] = this.pairs[k];
      const di = this.drones[i];
      const dj = this.drones[j];
      const a = di.state.p;
      const b = dj.state.p;
      const dist = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
      const s = scaledSeparation(a, b, this.Dunit);
      if (di.state.phase === 'flying' || dj.state.phase === 'flying') {
        if (dist < this.log.summary.minCentreDistance) this.log.summary.minCentreDistance = dist;
        if (s < this.log.summary.minScaledSeparation) this.log.summary.minScaledSeparation = s;
      }
      if (s < 1 && inRace && !di.crashed && !dj.crashed) {
        this.log.summary.violationTime += this.dt;
        if (!this.violating[k]) this.event('violation', { drone: i, other: j });
        this.violating[k] = true;
      } else this.violating[k] = false;
      if (dist < COLLISION_DIST && !di.crashed && !dj.crashed && di.state.phase === 'flying' && dj.state.phase === 'flying') {
        this.log.summary.collisions++;
        this.crash(di, 'collision', { other: j });
        this.crash(dj, 'collision', { other: i });
        // split the drones apart a little so the tumble looks right
        const nx = (a.x - b.x) / (dist || 1);
        const ny = (a.y - b.y) / (dist || 1);
        di.state.v = v3(di.state.v.x + nx * 0.8, di.state.v.y + ny * 0.8, di.state.v.z);
        dj.state.v = v3(dj.state.v.x - nx * 0.8, dj.state.v.y - ny * 0.8, dj.state.v.z);
      }
    }
    for (const d of this.drones) {
      const s = d.state;
      d.nearestS = Infinity;
      if (s.phase !== 'flying') continue;
      // accumulators (analysis window)
      if (inRace) {
        d.pathLength += Math.hypot(s.p.x - d.prevP.x, s.p.y - d.prevP.y, s.p.z - d.prevP.z);
        d.effort += Math.hypot(s.f.x, s.f.y, s.f.z) * this.dt;
        const sp = Math.hypot(s.v.x, s.v.y, s.v.z);
        if (sp > 0.05 && !this.pureRef) {
          const brake = -(s.a.x * s.v.x + s.a.y * s.v.y + s.a.z * s.v.z) / sp;
          if (brake > d.peakBraking) d.peakBraking = brake;
        }
      }
      // arena
      if (outsideArena(s.p, this.build.arena)) {
        this.log.summary.arenaExits++;
        this.crash(d, 'arenaExit');
        continue;
      }
      if (s.p.z < DRONE_RADIUS * 0.5) {
        this.crash(d, 'obstacleHit', { detail: 'floor' });
        continue;
      }
      // gates and obstacles
      if (this.build.course) this.gateChecks(d);
      this.obstacleChecks(d);
      // laps
      this.lapCheck(d);
    }
  }

  private gateChecks(d: SimDrone): void {
    const course = this.build.course!;
    const p0 = d.prevP;
    const p1 = d.state.p;
    if (d.nextVisit < d.visits.length) {
      const visit = d.visits[d.nextVisit];
      const g = course.gates[visit.gate];
      const f = this.geom.gateFrames[visit.gate];
      const c = gateCrossing(g, f, p0, p1, !!visit.reverse);
      if (c.kind === 'pass') {
        d.passes++;
        d.passTimes.push({ k: d.nextVisit, t: this.t });
        this.event('gatePass', { drone: d.id, gate: visit.gate, detail: `${d.nextVisit}` });
        d.nextVisit++;
        if (d.nextVisit >= d.visits.length) {
          d.finishTime = this.t;
          this.event('finish', { drone: d.id });
        }
      } else if (c.kind === 'miss') {
        d.misses++;
        this.event('gateMiss', { drone: d.id, gate: visit.gate, detail: c.reason });
        d.nextVisit++;
      } else if (d.nextVisit + 1 < d.visits.length) {
        // skipped: a clean pass through the following gate means the expected one was missed
        const nv = d.visits[d.nextVisit + 1];
        if (nv.gate !== visit.gate) {
          const c2 = gateCrossing(course.gates[nv.gate], this.geom.gateFrames[nv.gate], p0, p1, !!nv.reverse);
          if (c2.kind === 'pass') {
            d.misses++;
            this.event('gateMiss', { drone: d.id, gate: visit.gate, detail: 'skipped' });
            d.nextVisit++;
            d.passes++;
            d.passTimes.push({ k: d.nextVisit, t: this.t });
            this.event('gatePass', { drone: d.id, gate: nv.gate, detail: `${d.nextVisit}` });
            d.nextVisit++;
          }
        }
      }
    }
  }

  private primsCache: { t: number; prims: Primitive[] } = { t: -1, prims: [] };
  /** Obstacle primitives at the current physics time (moving ones evaluated once per tick). */
  private primsNow(): Primitive[] {
    if (this.primsCache.t !== this.t) this.primsCache = { t: this.t, prims: this.geom.primitives(this.t) };
    return this.primsCache.prims;
  }

  private obstacleChecks(d: SimDrone): void {
    const p = d.state.p;
    const prims = this.primsNow();
    for (const prim of prims) {
      if (prim.kind === 'plane') continue;
      if (!nearBounds(p, primitiveBounds(prim), 1.0)) continue;
      const dist = distanceToPrimitive(p, prim) - DRONE_RADIUS;
      if (dist < this.log.summary.obstacleClearance) this.log.summary.obstacleClearance = dist;
      if (dist < 0) {
        if (prim.tag.source === 'gate') {
          d.strikes++;
          this.log.summary.collisions++;
          this.crash(d, 'gateStrike', { gate: prim.tag.gateIndex, detail: prim.tag.id });
        } else {
          this.log.summary.collisions++;
          this.crash(d, 'obstacleHit', { detail: prim.tag.id });
        }
        return;
      }
    }
  }

  private lapCheck(d: SimDrone): void {
    const plane = this.build.lapPlanes[d.id];
    if (!plane) return;
    const p = d.state.p;
    const side = (p.x - plane.p.x) * plane.n.x + (p.y - plane.p.y) * plane.n.y + (p.z - plane.p.z) * plane.n.z;
    const prevSide = d.lapSide;
    d.lapSide = side;
    if (prevSide < 0 && side >= 0) {
      const near = Math.hypot(p.x - plane.p.x, p.y - plane.p.y, p.z - plane.p.z) < 0.3;
      const v = d.state.v;
      const sp = Math.hypot(v.x, v.y, v.z);
      const aligned = sp > 1e-3 && (v.x * plane.n.x + v.y * plane.n.y + v.z * plane.n.z) > 0.5 * sp;
      const tr = this.build.trajectories[d.id];
      const minGap = 0.5 * ((tr.lapPeriod ?? 1) / this.build.k);
      if (near && aligned && this.t - d.lastLapT > minGap) {
        // on a course a lap with a missed or struck gate is not finished (Section 9 ring events)
        const clean = !this.build.course || (d.misses === d.missesAtLap && d.strikes === d.strikesAtLap);
        if (clean) {
          d.lapTimes.push(this.t - d.lastLapT);
          this.event('lap', { drone: d.id, detail: `${d.lapTimes.length}` });
        }
        d.lastLapT = this.t;
        d.missesAtLap = d.misses;
        d.strikesAtLap = d.strikes;
      }
    }
  }

  private finish(reason: TrialLog['summary']['endReason']): void {
    if (this.done) return;
    this.done = true;
    const S = this.log.summary;
    S.endReason = this.log.summary.killed ? 'kill' : reason;
    S.endTime = this.t;
    S.peakBraking = this.drones.map((d) => d.peakBraking);
    S.measuredLatency = this.latencyCount ? this.latencySum / this.latencyCount : NaN;
    S.lapTimes = this.drones.map((d) => d.lapTimes.slice());
    S.lapsCompleted = this.drones.map((d) => d.lapTimes.length);
    S.pathLength = this.drones.map((d) => d.pathLength);
    S.effort = this.drones.map((d) => d.effort);
    S.gates = this.drones.map((d) => {
      const completed = S.endReason === 'completed' || S.endReason === 'timeout';
      // gates never reached count as missed when the run completed (skipped)
      const remaining = completed ? d.visits.length - d.nextVisit : 0;
      return {
        passes: d.passes,
        misses: d.misses + remaining,
        strikes: d.strikes,
        attempted: d.passes + d.misses + remaining + d.strikes,
        scheduled: d.visits.length,
        finishTime: d.finishTime,
        passTimes: d.passTimes.slice(),
      };
    });
    this.event('end', { detail: S.endReason });
  }

  /**
   * Provisional copy of the log for live scoring before the trial ends: accumulators (effort,
   * path length, laps, gates) are filled from the running state.
   */
  liveLog(): TrialLog {
    if (this.done) return this.log;
    const S = this.log.summary;
    return {
      ...this.log,
      summary: {
        ...S,
        raceEnd: Math.min(this.raceEnd, this.t),
        effort: this.drones.map((d) => d.effort),
        pathLength: this.drones.map((d) => d.pathLength),
        lapTimes: this.drones.map((d) => d.lapTimes.slice()),
        lapsCompleted: this.drones.map((d) => d.lapTimes.length),
        peakBraking: this.drones.map((d) => d.peakBraking),
        gates: this.drones.map((d) => ({ passes: d.passes, misses: d.misses, strikes: d.strikes, attempted: d.passes + d.misses + d.strikes, scheduled: d.visits.length, finishTime: d.finishTime, passTimes: d.passTimes.slice() })),
      },
      planned: { ...this.log.planned, effort: this.log.planned.effort.map((_, i) => plannedEffortUpTo(this.build.trajectories[i], this.build.k, this.t)) },
    };
  }

  /** Latest filter result (for the UI). */
  get filterResult(): FilterResult | null {
    return this.lastFilter;
  }
}

/** Deterministic fingerprint of a TrialLog (wall-clock solve times excluded). */
export function hashTrialLog(log: TrialLog): string {
  const { solveMs: _omit, ...rest } = log;
  void _omit;
  // re-planning solve times are wall-clock measurements too: keep them out of the fingerprint
  const summary = { ...rest.summary, replanMsMax: 0 };
  const events = rest.events.map((e) => (e.type === 'replan' ? { ...e, detail: '' } : e));
  return hashText(JSON.stringify({ ...rest, summary, events }, (_k, v) => (typeof v === 'number' && !Number.isFinite(v) ? String(v) : v)));
}

/** Run a whole trial headlessly. */
export function runTrial(cfg: SimConfig, opts: SimOptions = {}): TrialLog {
  const sim = new Simulation(cfg, opts);
  return sim.runToEnd();
}
