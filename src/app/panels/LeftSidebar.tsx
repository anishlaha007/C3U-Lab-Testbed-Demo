/** Left sidebar: every configuration section, each with a one-sentence concept tooltip. */
import { DRONE_COLORS, DRONE_NAMES, PRESETS } from '../../core/constants';
import { recommendedSpeed } from '../../core/courseLibrary';
import { COURSE_INFO } from '../../core/courses';
import { latencies } from '../../core/defaults';
import { figure8MaxW } from '../../core/trajectories/figure8';
import type { SimConfig, TrajectoryType } from '../../core/types';
import { planIsCurrent, requestSolve } from '../planner';
import { useStore } from '../store';
import { Badge, Button, Label, Section, Select, Slider, Toggle, cx, fmt } from '../ui';

const TYPES: { value: TrajectoryType; label: string }[] = [
  { value: 'figure8', label: 'Figure-8 (lemniscate)' },
  { value: 'circle', label: 'Circle' },
  { value: 'splitS', label: 'Split-S' },
  { value: 'pinch', label: 'Pinch' },
  { value: 'intersection', label: 'Intersection' },
  { value: 'headon', label: 'Head-on' },
  { value: 'antipodal', label: 'Antipodal swap' },
  { value: 'random', label: 'Random crossing' },
  { value: 'raceTrack', label: 'Race loop' },
  { value: 'ringCircuit', label: 'Ring course' },
  { value: 'imported', label: 'Imported CSV' },
];

export const PLANNER_TYPES: TrajectoryType[] = ['pinch', 'raceTrack', 'ringCircuit'];

export function LeftSidebar() {
  const config = useStore((s) => s.config);
  const setConfig = useStore((s) => s.setConfig);
  const open = useStore((s) => s.leftOpen);
  const toggle = useStore((s) => s.toggleSection);
  const visuals = useStore((s) => s.visuals);
  const setVisuals = useStore((s) => s.setVisuals);
  const planStatus = useStore((s) => s.planStatus);
  const planProgress = useStore((s) => s.planProgress);
  const plan = useStore((s) => s.plan);
  const setEditorOpen = useStore((s) => s.setEditorOpen);
  const sc = config.scenario;
  const sys = config.system;
  const flt = config.filter;
  const pl = config.planner;
  const uploaded = sys.mode === 'uploaded';
  const set = (fn: (c: SimConfig) => void) =>
    setConfig((c) => {
      fn(c);
      c.scenario.preset = '';
    });
  const lat = latencies(sys);
  const isCourse = sc.type === 'ringCircuit';
  const isPlanner = PLANNER_TYPES.includes(sc.type);
  const wmax = figure8MaxW(sc.A, PRESETS[config.drones[0]?.preset ?? 'CF21'].twr, sys.eta);

  return (
    <aside className="thin-scroll w-72 shrink-0 overflow-y-auto border-r border-slate-300 bg-slate-50/90 dark:border-slate-800 dark:bg-slate-950/70">
      {/* ---------------- Course */}
      <Section title="Course" tip="Ring gates on stands and obstacles: the racing scenarios (Section 5.2b)." open={open.course} onToggle={() => toggle('course')} right={isCourse ? <Badge tone="sky">{config.course.courseId}</Badge> : null}>
        <Select
          label="Course preset"
          tip="C1 to C12: difficulty-rated ring-gate layouts; selecting one switches the scenario to a ring course."
          value={config.course.courseId}
          options={[{ value: 'none', label: 'None (no gates)' }, ...COURSE_INFO.map((c) => ({ value: c.id, label: `${c.id} ${c.name} ${'★'.repeat(c.difficulty)}` }))]}
          onChange={(v) =>
            set((c) => {
              c.course.courseId = v;
              if (v !== 'none') {
                c.scenario.type = 'ringCircuit';
                c.scenario.targetSpeed = recommendedSpeed(c.course);
              } else if (c.scenario.type === 'ringCircuit') c.scenario.type = 'figure8';
            })
          }
        />
        {config.course.courseId !== 'none' && (
          <p className="text-[11px] leading-snug text-slate-500">
            {COURSE_INFO.find((c) => c.id === config.course.courseId)?.layout}. <em>{COURSE_INFO.find((c) => c.id === config.course.courseId)?.hard}.</em>
          </p>
        )}
        {config.course.courseId === 'C6' && (
          <Slider label="Pillar count" tip="Number of seeded pillars in the forest." value={config.course.pillarCount} min={8} max={12} step={1} onChange={(v) => set((c) => (c.course.pillarCount = v))} />
        )}
        {config.course.courseId === 'C11' && (
          <div className="space-y-2 rounded border border-slate-200 p-2 dark:border-slate-800">
            <Label tip="The generator is seeded; the validator guarantees each course is flyable at the chosen speed.">Random course generator</Label>
            <Slider label="Seed" value={config.course.random.seed} min={1} max={99} step={1} onChange={(v) => set((c) => (c.course.random.seed = v))} />
            <Slider label="Difficulty" value={config.course.random.difficulty} min={1} max={5} step={1} onChange={(v) => set((c) => (c.course.random.difficulty = v))} />
            <Slider label="Gate count" value={config.course.random.gateCount} min={4} max={12} step={1} onChange={(v) => set((c) => (c.course.random.gateCount = v))} />
            <Slider label="Spacing" value={config.course.random.spacing} min={1.2} max={3} step={0.1} format={(v) => `${v.toFixed(1)} m`} onChange={(v) => set((c) => (c.course.random.spacing = v))} />
            <Slider label="Turn angle" value={config.course.random.turnAngle} min={20} max={150} step={5} format={(v) => `${v}°`} onChange={(v) => set((c) => (c.course.random.turnAngle = v))} />
            <Slider label="Height variation" value={config.course.random.heightVariation} min={0} max={0.8} step={0.05} format={(v) => `${v.toFixed(2)} m`} onChange={(v) => set((c) => (c.course.random.heightVariation = v))} />
            <Slider label="Gate size" value={config.course.random.gateSize} min={0.45} max={1.2} step={0.05} format={(v) => `${v.toFixed(2)} m`} onChange={(v) => set((c) => (c.course.random.gateSize = v))} />
            <Slider label="Obstacle density" value={config.course.random.obstacleDensity} min={0} max={1} step={0.05} onChange={(v) => set((c) => (c.course.random.obstacleDensity = v))} />
            <Toggle label="Dynamic obstacles" value={config.course.random.dynamic} onChange={(v) => set((c) => (c.course.random.dynamic = v))} />
          </div>
        )}
        <Toggle label="Dynamic obstacles moving" tip="Pendulum and sliding panel move deterministically with the race clock." value={config.course.dynamicObstacles} onChange={(v) => set((c) => (c.course.dynamicObstacles = v))} />
        <Slider
          label="Gate margin"
          tip="Extra clearance the filter keeps from gate frame edges; large margins can block legal passes through small gates."
          value={flt.gateMargin}
          min={0}
          max={0.15}
          step={0.01}
          format={(v) => `${(v * 100).toFixed(0)} cm`}
          onChange={(v) => set((c) => (c.filter.gateMargin = v))}
        />
        <Button small onClick={() => setEditorOpen(true)} title="Course editor (E)">
          Edit course…
        </Button>
      </Section>

      {/* ---------------- Scenario */}
      <Section title="Scenario" tip="What the drones are asked to fly: trajectory type, its parameters and the time scaling." open={open.scenario} onToggle={() => toggle('scenario')}>
        <Select label="Trajectory type" value={sc.type} options={TYPES} onChange={(v) => set((c) => (c.scenario.type = v))} />
        {(sc.type === 'figure8' || sc.type === 'intersection') && (
          <>
            <Slider label="Amplitude A" tip="Half-width of the lemniscate x = A sin(wt), y = (A/2) sin(2wt)." value={sc.A} min={0.8} max={2.0} step={0.05} format={(v) => `${v.toFixed(2)} m`} onChange={(v) => set((c) => (c.scenario.A = v))} />
            <Slider
              label="Rate w"
              tip={`Angular rate; the CF2.1 thrust limit at eta ${sys.eta} is w_max = ${wmax.toFixed(2)} rad/s.`}
              value={sc.w}
              min={0.3}
              max={2.4}
              step={0.01}
              format={(v) => `${v.toFixed(2)} rad/s${v > wmax + 1e-9 ? ' ⚠' : ''}`}
              onChange={(v) => set((c) => (c.scenario.w = v))}
            />
            <div className="flex flex-wrap gap-1">
              {[0.522, 0.78, 1.04, 1.31, 1.54].map((w) => (
                <button key={w} className={cx('rounded border px-1.5 text-[10px]', Math.abs(sc.w - w) < 1e-6 ? 'border-sky-500 text-sky-600' : 'border-slate-300 text-slate-500 dark:border-slate-700')} onClick={() => set((c) => (c.scenario.w = w))}>
                  {w}
                </button>
              ))}
            </div>
          </>
        )}
        {sc.type === 'circle' && (
          <>
            <Slider label="Radius" value={sc.radius} min={0.5} max={2.0} step={0.05} format={(v) => `${v.toFixed(2)} m`} onChange={(v) => set((c) => (c.scenario.radius = v))} />
            <Slider label="Rate w" value={sc.w} min={0.3} max={2.5} step={0.01} format={(v) => `${v.toFixed(2)} rad/s`} onChange={(v) => set((c) => (c.scenario.w = v))} />
          </>
        )}
        {sc.type === 'intersection' && (
          <Select
            label="Phase offset"
            tip="pi: both drones reach the centre at the same instant; smaller offsets stagger them."
            value={Math.round((sc.phaseOffset / Math.PI) * 10) / 10}
            options={[1, 0.9, 0.8].map((x) => ({ value: x, label: `${x === 1 ? '' : x}π` }))}
            onChange={(v) => set((c) => (c.scenario.phaseOffset = v * Math.PI))}
          />
        )}
        {(sc.type === 'figure8' || sc.type === 'circle') && (
          <Slider label="Phase" value={sc.phase} min={0} max={2 * Math.PI} step={0.05} format={(v) => `${(v / Math.PI).toFixed(2)}π`} onChange={(v) => set((c) => (c.scenario.phase = v))} />
        )}
        {['figure8', 'circle', 'intersection', 'splitS', 'raceTrack', 'ringCircuit'].includes(sc.type) && (
          <Slider label="Laps" value={sc.laps} min={1} max={5} step={1} onChange={(v) => set((c) => (c.scenario.laps = v))} />
        )}
        {sc.type === 'headon' && (
          <>
            <Select label="Closing speed (each)" value={sc.headonSpeed} options={[1, 2, 3].map((v) => ({ value: v, label: `${v} m/s` }))} onChange={(v) => set((c) => (c.scenario.headonSpeed = v))} />
            <Select label="Start gap" value={sc.headonGap} options={[1.5, 2.5].map((v) => ({ value: v, label: `${v} m` }))} onChange={(v) => set((c) => (c.scenario.headonGap = v))} />
            <Toggle
              label="Coast (preliminary study)"
              tip="Zero planned acceleration through the encounter, as in the preliminary analysis; the plan leaves the arena, so use it with the pure double-integrator mode."
              value={sc.headonCoast}
              onChange={(v) => set((c) => (c.scenario.headonCoast = v))}
            />
          </>
        )}
        {sc.type === 'pinch' && (
          <>
            <Slider label="Ring inner diameter" value={sc.ringInnerDiameter} min={0.3} max={0.8} step={0.05} format={(v) => `${v.toFixed(2)} m`} onChange={(v) => set((c) => (c.scenario.ringInnerDiameter = v))} />
            <Select label="Start offset" tip="Longitudinal head start of drone A." value={sc.startOffset} options={[0, 0.25, 0.5].map((v) => ({ value: v, label: `${v} m` }))} onChange={(v) => set((c) => (c.scenario.startOffset = v))} />
          </>
        )}
        {['splitS', 'pinch', 'antipodal', 'random', 'raceTrack', 'ringCircuit'].includes(sc.type) && (
          <Slider label="Target speed" tip="Speed used for time allocation of spline trajectories." value={sc.targetSpeed} min={0.5} max={4} step={0.1} format={(v) => `${v.toFixed(1)} m/s`} onChange={(v) => set((c) => (c.scenario.targetSpeed = v))} />
        )}
        <Slider label="Height z0" value={sc.z0} min={0.5} max={2.0} step={0.05} format={(v) => `${v.toFixed(2)} m`} onChange={(v) => set((c) => (c.scenario.z0 = v))} />
        <Slider
          label="Time-scale k"
          tip="Speed multiplier: t -> t/k, so velocities scale by k and accelerations by k²."
          value={sc.timeScale}
          min={0.25}
          max={2.5}
          step={0.05}
          format={(v) => `${v.toFixed(2)}x`}
          onChange={(v) => set((c) => (c.scenario.timeScale = v))}
        />
        <Toggle label="Fly anyway (expect saturation)" tip="Run even if the feasibility check fails." value={config.flyAnyway} onChange={(v) => set((c) => (c.flyAnyway = v))} />
      </Section>

      {/* ---------------- Drones */}
      <Section title="Drones" tip="How many Crazyflies fly, their colours, hardware preset and start positions." open={open.drones} onToggle={() => toggle('drones')} right={<Badge>{config.drones.length}</Badge>}>
        <div className="flex items-center gap-1">
          <Button small disabled={config.drones.length >= 6} onClick={() => set((c) => c.drones.push({ preset: 'CF21', color: DRONE_COLORS[c.drones.length % 6], start: null }))}>
            + Add
          </Button>
          <Button small disabled={config.drones.length <= 1} onClick={() => set((c) => c.drones.pop())}>
            − Remove
          </Button>
          <span className="ml-auto text-[10px] text-slate-500">some scenarios fix the count</span>
        </div>
        {config.drones.map((d, i) => (
          <div key={i} className="space-y-1 rounded border border-slate-200 p-1.5 dark:border-slate-800">
            <div className="flex items-center gap-1.5">
              <input type="color" className="h-5 w-6 cursor-pointer rounded border-0 bg-transparent p-0" value={d.color} onChange={(e) => set((c) => (c.drones[i].color = e.target.value))} />
              <span className="text-xs font-semibold">Drone {DRONE_NAMES[i]}</span>
              <select
                className="ml-auto rounded border border-slate-300 bg-white px-1 py-0.5 text-[11px] dark:border-slate-700 dark:bg-slate-900"
                value={d.preset}
                onChange={(e) => set((c) => (c.drones[i].preset = e.target.value as 'CF21'))}
                title="Hardware preset: thrust-to-weight ratio sets the dynamics"
              >
                <option value="CF21">CF2.1 (TWR 1.8)</option>
                <option value="CF21_BRUSHLESS">CF2.1 Brushless (TWR 3.5)</option>
              </select>
            </div>
            <div className="flex items-center gap-1 text-[10px] text-slate-500">
              <label className="flex items-center gap-1">
                <input type="checkbox" checked={!d.start} onChange={(e) => set((c) => (c.drones[i].start = e.target.checked ? null : { x: 0, y: 0, z: 1 }))} /> auto start
              </label>
              {d.start &&
                (['x', 'y', 'z'] as const).map((ax) => (
                  <input
                    key={ax}
                    type="number"
                    step={0.05}
                    className="w-12 rounded border border-slate-300 bg-white px-0.5 dark:border-slate-700 dark:bg-slate-900"
                    value={d.start![ax]}
                    onChange={(e) => set((c) => (c.drones[i].start![ax] = Number(e.target.value)))}
                  />
                ))}
            </div>
          </div>
        ))}
      </Section>

      {/* ---------------- Planner */}
      <Section title="Planner" tip="Simplified stand-ins for the lab's game-theoretic solvers: strategies chosen on a discretised space." open={open.planner} onToggle={() => toggle('planner')} right={isPlanner ? <Badge tone="violet">{pl.solver}</Badge> : null}>
        {!isPlanner && <p className="text-[11px] text-slate-500">Planners apply to the pinch, race loop and ring courses.</p>}
        <Select
          label="Solver"
          tip="Independent ignores the opponent; Nash finds mutual best responses; Stackelberg lets a leader commit first."
          value={pl.solver}
          options={[
            { value: 'independent', label: 'Independent' },
            { value: 'nash', label: 'Nash' },
            { value: 'stackelberg', label: 'Stackelberg' },
          ]}
          onChange={(v) => set((c) => (c.planner.solver = v))}
        />
        {pl.solver === 'stackelberg' && (
          <Select label="Leader" value={pl.leader} options={[0, 1].map((i) => ({ value: i, label: `Drone ${DRONE_NAMES[i]} leads` }))} onChange={(v) => set((c) => (c.planner.leader = v))} />
        )}
        {pl.solver === 'nash' && (
          <Select
            label="Equilibrium tie-break"
            tip="Which pure Nash equilibrium to fly when several exist."
            value={pl.tieBreak}
            options={[
              { value: 'maxTotal', label: 'Maximum total progress' },
              { value: 'ego', label: 'Ego-favourable (drone A)' },
            ]}
            onChange={(v) => set((c) => (c.planner.tieBreak = v))}
          />
        )}
        <Slider label="Candidates M" tip="Number of strategy candidates per drone (lateral offset profile x speed scale)." value={pl.M} min={9} max={80} step={1} onChange={(v) => set((c) => (c.planner.M = v))} />
        <Select
          label="Collision responsibility"
          tip="Shared: both pay the collision penalty (Spica et al.); follower only: the trailing drone pays (Liniger & Lygeros)."
          value={pl.responsibility}
          options={[
            { value: 'shared', label: 'Shared' },
            { value: 'follower', label: 'Follower only' },
          ]}
          onChange={(v) => set((c) => (c.planner.responsibility = v))}
        />
        <Slider label="Collision penalty P" tip="Metres of progress lost per second of separation violation in the rollout." value={pl.penalty} min={0} max={200} step={5} format={(v) => `${v} m/s`} onChange={(v) => set((c) => (c.planner.penalty = v))} />
        <Slider
          label="Risk margin s"
          tip="Rollouts count time with scaled separation below this as collision risk (1 = strict definition; 1.25 leaves a buffer for tracking error)."
          value={pl.riskMargin}
          min={1}
          max={1.6}
          step={0.05}
          format={(v) => v.toFixed(2)}
          onChange={(v) => set((c) => (c.planner.riskMargin = v))}
        />
        <Toggle label="Receding-horizon re-planning (stretch)" tip="Re-solve from the current state every 0.5 s instead of flying the precomputed plan." value={pl.replan} onChange={(v) => set((c) => (c.planner.replan = v))} />
        <div className="flex items-center gap-2">
          <Button small kind="primary" disabled={!isPlanner || planStatus === 'solving'} onClick={() => requestSolve()}>
            {planStatus === 'solving' ? `Solving ${(planProgress * 100).toFixed(0)}%` : 'Solve'}
          </Button>
          {plan && planIsCurrent(config) && <span className="text-[10px] text-slate-500">solved in {fmt(plan.solveMs, 0)} ms</span>}
          {plan && !planIsCurrent(config) && isPlanner && <span className="text-[10px] text-amber-500">plan out of date</span>}
        </div>
      </Section>

      {/* ---------------- Safety filter */}
      <Section
        title="Safety filter"
        tip="Control barrier function filter (ASIF): minimally changes commanded accelerations so the drones stay apart."
        open={open.filter}
        onToggle={() => toggle('filter')}
        right={<Badge tone={flt.enabled && !uploaded ? 'emerald' : 'rose'}>{flt.enabled && !uploaded ? 'on' : 'off'}</Badge>}
      >
        <div className={cx('space-y-2.5', uploaded && 'pointer-events-none opacity-40')} title={uploaded ? 'Uploaded mode: the drone flies its trajectory onboard, so there is no ground-side filter.' : undefined}>
          <Toggle label="Filter enabled" value={flt.enabled} onChange={(v) => set((c) => (c.filter.enabled = v))} />
          <Select
            label="Barrier type"
            tip="Exponential CBF (relative degree 2) or braking-aware CBF that reserves stopping distance."
            value={flt.type}
            options={[
              { value: 'ecbf', label: 'Exponential CBF' },
              { value: 'braking', label: 'Braking-aware CBF' },
            ]}
            onChange={(v) => set((c) => (c.filter.type = v))}
          />
          {flt.type === 'ecbf' ? (
            <Slider label="λ (both poles)" tip="Larger lambda lets drones approach faster before braking." value={flt.lambda} min={1} max={15} step={0.5} onChange={(v) => set((c) => (c.filter.lambda = v))} />
          ) : (
            <Slider label="α" tip="Class-K gain of the braking-aware barrier." value={flt.alpha} min={1} max={15} step={0.5} onChange={(v) => set((c) => (c.filter.alpha = v))} />
          )}
          <Select label="Margin multiplier on E" tip="Scales the downwash ellipsoid the filter enforces." value={flt.marginMultiplier} options={[1, 1.25, 1.5].map((v) => ({ value: v, label: `${v}x` }))} onChange={(v) => set((c) => (c.filter.marginMultiplier = v))} />
          <Toggle label="Latency compensation" tip="Predict each state forward by the delay using commands already sent." value={flt.latencyCompensation} onChange={(v) => set((c) => (c.filter.latencyCompensation = v))} />
          <Select label="Control rate" value={sys.fCtrl} options={[50, 100].map((v) => ({ value: v as 50 | 100, label: `${v} Hz` }))} onChange={(v) => set((c) => (c.system.fCtrl = v))} />
          <Select
            label="Responsibility"
            tip="How the correction is split between the two drones of a pair."
            value={flt.responsibility}
            options={[
              { value: 'equal', label: 'Equal' },
              { value: 'follower', label: 'Follower only' },
              { value: 'weights', label: 'Custom weights' },
            ]}
            onChange={(v) => set((c) => (c.filter.responsibility = v))}
          />
          {flt.responsibility === 'weights' &&
            config.drones.map((_, i) => (
              <Slider key={i} label={`Weight ${DRONE_NAMES[i]}`} tip="Higher weight = this drone deviates less." value={flt.weights[i] ?? 1} min={0.1} max={5} step={0.1} onChange={(v) => set((c) => (c.filter.weights[i] = v))} />
            ))}
          <Toggle label="Obstacle constraints" tip="Pillars, gate frames, nets, floor and ceiling add one constraint per nearby drone." value={flt.obstacles} onChange={(v) => set((c) => (c.filter.obstacles = v))} />
          <Slider label="Obstacle margin" value={flt.obstacleMargin} min={0} max={0.15} step={0.01} format={(v) => `${(v * 100).toFixed(0)} cm`} onChange={(v) => set((c) => (c.filter.obstacleMargin = v))} />
          <Slider label={flt.type === 'ecbf' ? 'Obstacle λ' : 'Obstacle α'} value={flt.type === 'ecbf' ? flt.obstacleLambda : flt.obstacleAlpha} min={1} max={15} step={0.5} onChange={(v) => set((c) => (flt.type === 'ecbf' ? (c.filter.obstacleLambda = v) : (c.filter.obstacleAlpha = v)))} />
          <Toggle label="Supervisor emergency brake" tip="Brake both drones when the constraint is infeasible after clipping or a violation is predicted within 0.1 s." value={flt.emergencyBrake} onChange={(v) => set((c) => (c.filter.emergencyBrake = v))} />
          <Toggle label="Deadlock breaker" tip="Small right-hand-rule bias for symmetric conflicts so one drone yields." value={flt.deadlockBreaker} onChange={(v) => set((c) => (c.filter.deadlockBreaker = v))} />
          <Toggle label="Geofence" tip="Hover at the boundary when a drone leaves the arena minus 0.3 m." value={flt.geofence} onChange={(v) => set((c) => (c.filter.geofence = v))} />
        </div>
      </Section>

      {/* ---------------- System */}
      <Section title="System" tip="Latency, sensing, wind, battery, onboard controller and the streamed / uploaded mode." open={open.system} onToggle={() => toggle('system')}>
        <Slider
          label="Total latency"
          tip="End-to-end delay, split into Vicon sensing delay and radio command delay."
          value={sys.totalLatency}
          min={0}
          max={0.08}
          step={0.005}
          format={(v) => `${(v * 1000).toFixed(0)} ms`}
          onChange={(v) => set((c) => (c.system.totalLatency = v))}
          disabled={sys.advancedLatency}
        />
        <div className="text-[10px] text-slate-500">
          τs = {(lat.tauS * 1000).toFixed(0)} ms, τc = {(lat.tauC * 1000).toFixed(0)} ms
        </div>
        <Toggle label="Advanced latency split" value={sys.advancedLatency} onChange={(v) => set((c) => (c.system.advancedLatency = v))} />
        {sys.advancedLatency && (
          <>
            <Slider label="Sensing delay τs" value={sys.tauS} min={0} max={0.06} step={0.001} format={(v) => `${(v * 1000).toFixed(0)} ms`} onChange={(v) => set((c) => (c.system.tauS = v))} />
            <Slider label="Command delay τc" value={sys.tauC} min={0} max={0.06} step={0.001} format={(v) => `${(v * 1000).toFixed(0)} ms`} onChange={(v) => set((c) => (c.system.tauC = v))} />
          </>
        )}
        <Slider label="Vicon noise σ" value={sys.viconNoise} min={0} max={0.005} step={0.0001} format={(v) => `${(v * 1000).toFixed(1)} mm`} onChange={(v) => set((c) => (c.system.viconNoise = v))} />
        <Slider label="Wind σ" tip="Ornstein-Uhlenbeck acceleration disturbance (seeded)." value={sys.windSigma} min={0} max={1} step={0.05} format={(v) => `${v.toFixed(2)} m/s²`} onChange={(v) => set((c) => (c.system.windSigma = v))} />
        <Slider label="Battery sag" tip="Thrust-to-weight loss over a 7-minute flight." value={sys.batterySag} min={0} max={0.3} step={0.01} format={(v) => `${(v * 100).toFixed(0)}%`} onChange={(v) => set((c) => (c.system.batterySag = v))} />
        <Select
          label="Onboard controller"
          tip="Mellinger-like uses acceleration feed-forward; PID-like does not."
          value={sys.controller}
          options={[
            { value: 'mellinger', label: 'Mellinger-like (feed-forward)' },
            { value: 'pid', label: 'PID-like (no feed-forward)' },
          ]}
          onChange={(v) => set((c) => (c.system.controller = v))}
        />
        <Select
          label="Execution mode"
          tip="Streamed: ground sends setpoints at 50 Hz over the radio. Uploaded: the trajectory runs onboard (no latency, no filter)."
          value={sys.mode}
          options={[
            { value: 'streamed', label: 'Streamed (ground station)' },
            { value: 'uploaded', label: 'Uploaded (onboard)' },
          ]}
          onChange={(v) => set((c) => (c.system.mode = v))}
        />
        <Slider label="η thrust reserve" tip="Share of maximum thrust plans may use." value={sys.eta} min={0.4} max={1} step={0.05} onChange={(v) => set((c) => (c.system.eta = v))} />
        <Slider label="Max tilt" value={sys.thetaMaxDeg} min={20} max={75} step={1} format={(v) => `${v}°`} onChange={(v) => set((c) => (c.system.thetaMaxDeg = v))} />
        <Toggle label="Marker-swap fault" tip="When two drones are within 0.15 m, Vicon may swap their identities for one frame." value={sys.markerSwap} onChange={(v) => set((c) => (c.system.markerSwap = v))} />
        <Slider label="Packet loss" value={sys.packetLoss} min={0} max={0.5} step={0.01} format={(v) => `${(v * 100).toFixed(0)}%`} onChange={(v) => set((c) => (c.system.packetLoss = v))} />
        <Toggle
          label="Pure double-integrator test mode"
          tip="Acceleration lag off, onboard controller bypassed, perfect sensing, pure command delay: the setting of the preliminary head-on table."
          value={sys.pureDoubleIntegrator}
          onChange={(v) => set((c) => (c.system.pureDoubleIntegrator = v))}
        />
        {sys.pureDoubleIntegrator && (
          <Select
            label="Discretisation"
            tip="Reference: semi-implicit Euler at the control period with the delay rounded down to whole periods (reproduces the preliminary study). Exact: 1 ms zero-order hold."
            value={sys.pureDiscretization}
            options={[
              { value: 'reference', label: 'Reference (preliminary study)' },
              { value: 'exact', label: 'Exact (1 ms ZOH)' },
            ]}
            onChange={(v) => set((c) => (c.system.pureDiscretization = v))}
          />
        )}
      </Section>

      {/* ---------------- Visuals */}
      <Section title="Visuals" tip="What the 3D view draws." open={open.visuals} onToggle={() => toggle('visuals')}>
        <Toggle label="Trails" value={visuals.trails} onChange={(v) => setVisuals({ trails: v })} />
        <Slider label="Trail length" value={visuals.trailLength} min={1} max={15} step={1} format={(v) => `${v} s`} onChange={(v) => setVisuals({ trailLength: v })} />
        <Select
          label="Trail colour"
          value={visuals.trailColor}
          options={[
            { value: 'speed', label: 'By speed' },
            { value: 'drone', label: 'By drone' },
          ]}
          onChange={(v) => setVisuals({ trailColor: v })}
        />
        <Toggle label="Downwash ellipsoids" tip="Amber when s < 1.25, red when s < 1." value={visuals.ellipsoids} onChange={(v) => setVisuals({ ellipsoids: v })} />
        <Toggle label="Reference ghosts" tip="Sphere: nominal reference. Ring: filtered reference actually sent." value={visuals.ghosts} onChange={(v) => setVisuals({ ghosts: v })} />
        <Toggle label="Commanded path" tip="Planned path; red where it fails the thrust/tilt check." value={visuals.commandedPath} onChange={(v) => setVisuals({ commandedPath: v })} />
        <Toggle label="Intervention arrows" tip="Arrow along u_safe - u_nom." value={visuals.arrows} onChange={(v) => setVisuals({ arrows: v })} />
        <Toggle label="Separation line" value={visuals.separation} onChange={(v) => setVisuals({ separation: v })} />
        <Toggle label="Racing line" value={visuals.racingLine} onChange={(v) => setVisuals({ racingLine: v })} />
        <Toggle label="Detour search path" tip="Raw A* path used to route the racing line around obstacles." value={visuals.searchPath} onChange={(v) => setVisuals({ searchPath: v })} />
        <Toggle label="Vicon camera frustums" value={visuals.frustums} onChange={(v) => setVisuals({ frustums: v })} />
        <Toggle label="Safety nets" value={visuals.nets} onChange={(v) => setVisuals({ nets: v })} />
        <Toggle label="Labels" value={visuals.labels} onChange={(v) => setVisuals({ labels: v })} />
        <Select
          label="Drone size"
          tip="Real Crazyflies are tiny; 3x makes them visible."
          value={visuals.exaggerate}
          options={[
            { value: 1, label: '1x (true size)' },
            { value: 3, label: '3x (exaggerated)' },
          ]}
          onChange={(v) => setVisuals({ exaggerate: v as 1 | 3 })}
        />
      </Section>
    </aside>
  );
}
