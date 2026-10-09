/**
 * Live engine: owns the running Simulation (outside React state), advances it from the render
 * loop, and produces SceneViews either from the live state or from the recorded log (replay).
 */
import { G, PRESETS } from '../core/constants';
import { CourseGeometry } from '../core/course';
import type { PlanResult } from '../core/planners/types';
import { buildScenario, type ScenarioBuild } from '../core/scenario';
import { Simulation } from '../core/sim';
import { pairD, scaledSeparation } from '../core/safety/ecbf';
import { validate, type ValidationResult } from '../core/validator';
import type { SimConfig, TrialLog } from '../core/types';
import { v3, type Vec3 } from '../core/vec';
import type { DroneView, SceneView } from './view';

export type EngineStatus = 'idle' | 'ready' | 'running' | 'paused' | 'done' | 'invalid';

type Listener = () => void;

const D1 = pairD(1);

class Engine {
  sim: Simulation | null = null;
  build: ScenarioBuild | null = null;
  geom: CourseGeometry | null = null;
  validation: ValidationResult | null = null;
  config: SimConfig | null = null;
  plan: PlanResult | null = null;
  status: EngineStatus = 'idle';
  playing = false;
  simSpeed = 1;
  /** Replay time (s) when scrubbing the timeline; null = live. */
  replayTime: number | null = null;
  replayPlaying = false;
  /** Bumped whenever a new trial is built. */
  generation = 0;
  error: string | null = null;
  private listeners = new Set<Listener>();
  private doneListeners = new Set<(log: TrialLog) => void>();

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  onDone(l: (log: TrialLog) => void): () => void {
    this.doneListeners.add(l);
    return () => this.doneListeners.delete(l);
  }
  private emit(): void {
    this.listeners.forEach((l) => l());
  }

  /** Build (and validate) a trial for a configuration. Does not start it. */
  load(cfg: SimConfig, plan: PlanResult | null = null): ValidationResult | null {
    this.config = cfg;
    this.plan = plan;
    this.error = null;
    this.replayTime = null;
    this.replayPlaying = false;
    this.playing = false;
    try {
      const build = buildScenario(cfg, plan ? { trajectories: plan.trajectories, prediction: plan.prediction } : {});
      this.build = build;
      this.geom = new CourseGeometry(build.course, build.arena, cfg.course.dynamicObstacles, false);
      this.validation = validate(cfg, build);
      if (this.validation.ok) {
        this.sim = new Simulation(cfg, { build });
        this.status = 'ready';
      } else {
        this.sim = null;
        this.status = 'invalid';
      }
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      this.sim = null;
      this.status = 'invalid';
      this.validation = null;
    }
    this.generation++;
    this.emit();
    return this.validation;
  }

  play(): void {
    if (!this.sim) return;
    if (this.sim.done) {
      // replay from the start
      this.replayTime = 0;
      this.replayPlaying = true;
      this.emit();
      return;
    }
    this.replayTime = null;
    this.playing = true;
    this.status = 'running';
    this.emit();
  }

  pause(): void {
    this.playing = false;
    this.replayPlaying = false;
    if (this.sim && !this.sim.done) this.status = 'paused';
    this.emit();
  }

  toggle(): void {
    if (this.playing || this.replayPlaying) this.pause();
    else this.play();
  }

  /** Advance one control period. */
  stepOnce(): void {
    if (!this.sim || this.sim.done) return;
    this.playing = false;
    this.replayTime = null;
    this.sim.advance(1 / this.sim.cfg.system.fCtrl);
    this.status = this.sim.done ? 'done' : 'paused';
    if (this.sim.done) this.finished();
    this.emit();
  }

  kill(): void {
    if (!this.sim) return;
    this.sim.kill();
    this.emit();
  }

  /** Called every animation frame with the wall-clock delta (s). */
  frame(dtWall: number): void {
    const sim = this.sim;
    if (!sim) return;
    if (this.replayTime !== null && this.replayPlaying) {
      this.replayTime = Math.min(this.logEnd(), this.replayTime + dtWall * this.simSpeed);
      if (this.replayTime >= this.logEnd()) this.replayPlaying = false;
      return;
    }
    if (!this.playing || sim.done) return;
    // cap the work per frame so a slow machine degrades to slow motion instead of freezing
    const target = Math.min(dtWall * this.simSpeed, 0.25);
    const t0 = performance.now();
    const chunk = 0.01;
    let done = 0;
    while (done < target - 1e-9 && !sim.done) {
      sim.advance(Math.min(chunk, target - done));
      done += chunk;
      if (performance.now() - t0 > 30) break;
    }
    if (sim.done) {
      this.playing = false;
      this.finished();
      this.emit();
    }
  }

  private finished(): void {
    this.status = 'done';
    const log = this.sim?.log;
    if (log) this.doneListeners.forEach((l) => l(log));
  }

  get log(): TrialLog | null {
    return this.sim?.log ?? null;
  }

  logEnd(): number {
    const log = this.log;
    return log && log.t.length ? log.t[log.t.length - 1] : 0;
  }

  /** Current time shown (live or replay). */
  get time(): number {
    if (this.replayTime !== null) return this.replayTime;
    return this.sim ? this.sim.t : 0;
  }

  seek(t: number): void {
    if (!this.sim) return;
    this.playing = false;
    if (!this.sim.done && t >= this.sim.t) {
      this.replayTime = null;
      return;
    }
    this.replayTime = Math.max(0, Math.min(this.logEnd(), t));
    this.emit();
  }

  goLive(): void {
    this.replayTime = null;
    this.replayPlaying = false;
    this.emit();
  }

  // ------------------------------------------------------------------ views

  private viewCache: { key: string; view: SceneView } | null = null;

  /** Scene view of the current instant (memoised per simulation time / replay time). */
  view(): SceneView {
    const key = `${this.generation}|${this.sim?.tick ?? -1}|${this.replayTime ?? 'live'}`;
    if (this.viewCache && this.viewCache.key === key) return this.viewCache.view;
    const view = this.computeView();
    this.viewCache = { key, view };
    return view;
  }

  private computeView(): SceneView {
    const sim = this.sim;
    const cfg = this.config;
    if (!sim || !cfg) return this.previewView();
    if (this.replayTime !== null) return this.replayView(this.replayTime);
    const n = sim.n;
    const drones: DroneView[] = sim.drones.map((d, i) => {
      const s = d.state;
      const nom = d.exec.nominal(sim.t);
      let nearest = Infinity;
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        nearest = Math.min(nearest, scaledSeparation(s.p, sim.drones[j].state.p, D1));
      }
      const twrMax = (PRESETS[cfg.drones[i]?.preset ?? 'CF21'] ?? PRESETS.CF21).twr;
      return {
        p: s.p,
        v: s.v,
        f: s.f,
        yaw: nom.yaw,
        thrust01: Math.min(1, Math.hypot(s.f.x, s.f.y, s.f.z) / (s.twr * G)),
        color: cfg.drones[i]?.color ?? '#fff',
        ref: nom.p,
        refFiltered: d.exec.filteredRef(sim.t),
        correction: v3(d.uSafe.x - d.uNom.x, d.uSafe.y - d.uNom.y, d.uSafe.z - d.uNom.z),
        intervened: d.intervened,
        nearestS: nearest,
        mode: d.crashed ? 4 : d.mode === 'killed' ? 3 : d.mode === 'emergency' ? 2 : d.mode === 'hover' ? 1 : 0,
        tumble: s.phase !== 'flying' ? v3(s.tumbleAxis.x * s.tumbleAngle, s.tumbleAxis.y * s.tumbleAngle, s.tumbleAxis.z * s.tumbleAngle) : null,
        nextGate: d.nextVisit < d.visits.length ? d.visits[d.nextVisit].gate : -1,
        twr01: s.twr / twrMax,
        speed: Math.hypot(s.v.x, s.v.y, s.v.z),
      };
    });
    return { t: sim.t, tRace: sim.t, drones };
  }

  /** Before a trial is built: show drones at the start of their trajectories. */
  private previewView(): SceneView {
    return { t: 0, tRace: 0, drones: [] };
  }

  replayView(t: number): SceneView {
    const log = this.log!;
    const cfg = this.config!;
    const k = Math.max(0, Math.min(log.t.length - 1, Math.round(t / log.dtLog)));
    const kk = Math.min(log.t.length - 1, k + 1);
    const f = log.t.length > 1 && kk > k ? Math.max(0, Math.min(1, (t - log.t[k]) / (log.t[kk] - log.t[k]))) : 0;
    const L = (arr: number[]) => arr[k] + (arr[kk] - arr[k]) * f;
    const n = log.drones.length;
    const pos = log.drones.map((g) => v3(L(g.px), L(g.py), L(g.pz)));
    const drones: DroneView[] = log.drones.map((g, i) => {
      let nearest = Infinity;
      for (let j = 0; j < n; j++) if (j !== i) nearest = Math.min(nearest, scaledSeparation(pos[i], pos[j], D1));
      const fvec = v3(L(g.thx), L(g.thy), L(g.thz));
      const twr = g.twr[k] || 1.8;
      const vel = v3(L(g.vx), L(g.vy), L(g.vz));
      const ref = v3(L(g.rx), L(g.ry), L(g.rz));
      const fr = v3(L(g.fx), L(g.fy), L(g.fz));
      const filtered = Math.hypot(fr.x - ref.x, fr.y - ref.y, fr.z - ref.z) > 1e-4 ? fr : null;
      const yaw = Math.atan2(L(g.rvy), L(g.rvx));
      const mode = g.mode[k];
      return {
        p: pos[i],
        v: vel,
        f: fvec,
        yaw: Number.isFinite(yaw) ? yaw : 0,
        thrust01: Math.min(1, Math.hypot(fvec.x, fvec.y, fvec.z) / (twr * G)),
        color: cfg.drones[i]?.color ?? '#fff',
        ref,
        refFiltered: filtered,
        correction: v3(g.usx[k] - g.unx[k], g.usy[k] - g.uny[k], g.usz[k] - g.unz[k]),
        intervened: g.intervened[k] === 1,
        nearestS: nearest,
        mode,
        tumble: mode >= 3 ? v3(t * 3, t * 2, 0) : null,
        nextGate: -1,
        twr01: 1,
        speed: Math.hypot(vel.x, vel.y, vel.z),
      };
    });
    return { t, tRace: t, drones };
  }

  /** Trail points for drone i over the last `seconds` (from the log, plus the live position). */
  trailPoints(i: number, seconds: number): { x: number; y: number; z: number; speed: number }[] {
    const log = this.log;
    if (!log || !log.drones[i]) return [];
    const g = log.drones[i];
    const tNow = this.time;
    const nAvail = log.t.length;
    let kEnd = Math.min(nAvail - 1, Math.floor(tNow / log.dtLog));
    if (kEnd < 0) return [];
    const kStart = Math.max(0, kEnd - Math.round(seconds / log.dtLog));
    const out: { x: number; y: number; z: number; speed: number }[] = [];
    for (let k = kStart; k <= kEnd; k++) {
      if (g.mode[k] >= 4) break;
      out.push({ x: g.px[k], y: g.py[k], z: g.pz[k], speed: Math.hypot(g.vx[k], g.vy[k], g.vz[k]) });
    }
    if (this.replayTime === null && this.sim) {
      const s = this.sim.drones[i]?.state;
      if (s && s.phase === 'flying') out.push({ x: s.p.x, y: s.p.y, z: s.p.z, speed: Math.hypot(s.v.x, s.v.y, s.v.z) });
    } else {
      kEnd = Math.max(0, kEnd);
    }
    return out;
  }

  /** Closest pair at the current view (for the separation line). */
  closestPair(view: SceneView): { i: number; j: number; s: number; d: number } | null {
    let best: { i: number; j: number; s: number; d: number } | null = null;
    const ds = view.drones;
    for (let i = 0; i < ds.length; i++) {
      for (let j = i + 1; j < ds.length; j++) {
        if (ds[i].mode >= 3 || ds[j].mode >= 3) continue;
        const s = scaledSeparation(ds[i].p, ds[j].p, D1);
        if (!best || s < best.s) best = { i, j, s, d: dist(ds[i].p, ds[j].p) };
      }
    }
    return best;
  }
}

function dist(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

export const engine = new Engine();
