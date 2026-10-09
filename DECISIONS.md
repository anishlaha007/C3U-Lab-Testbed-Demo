# Decisions

Non-obvious choices made while building the simulator, with the reason for each. Equations are in
[docs/MODEL.md](docs/MODEL.md); this file records why things are the way they are.

## Stack

- **React 18** (as the prompt specifies) with the matching three.js bindings: `@react-three/fiber` 8 and
  `@react-three/drei` 9 (fiber 9 / drei 10 require React 19). three.js is pinned to r172, the last release
  these bindings were validated against.
- **Vite 7** + **Vitest 3** + **Tailwind CSS 4** (via `@tailwindcss/vite`). TypeScript 5.9 strict.
- `base: './'` in `vite.config.ts` so the static build works from any sub-path (GitHub Pages, Vercel, a file server).
- The running simulation lives in an `engine` singleton outside React; panels poll it through a
  throttled `liveTick` (8 Hz) and the 3D scene reads it every frame in `useFrame`. Putting per-tick
  state in zustand would re-render the whole app at the physics rate.
- Planner solves and experiment sweeps run in Web Workers through comlink. Experiments use a pool of
  `min(6, cores − 1)` workers fed one trial spec at a time; records are stored by spec index, so results
  do not depend on the pool size or on finishing order.
- Scratch exploration tests are named `src/tests/_*.test.ts`; they are gitignored and only run with
  `VITEST_SCRATCH=1`.

## Scene

- Net walls are single-sided planes whose front face points into the arena, so walls between an outside
  camera and the arena are culled and do not veil the view.
- Drones are drawn 3× their real size by default (Crazyflies are 9 cm); collision maths always uses the
  real radius (0.05 m).
- The only frame conversion is `toThree(p) = [p.x, p.z, −p.y]` in `src/app/scene/frames.ts`; nothing in
  `src/core` knows about three.js.

## Simulation timing and models

- **Flying start.** The race clock starts at t = 0 with each drone already on its reference (position and
  velocity). Takeoff, hover and landing are outside the analysis window anyway (Section 9), and a
  simulated takeoff only adds a transient that is not part of any metric.
- **Delays are timestamped FIFO queues** with fixed physics ticks of 1 ms and integer-tick rate tasks, so
  every run is bit-for-bit reproducible from the seed (TrialLog hash test).
- **Feed-forward inversion in the executor.** The onboard controller adds its own feedback to the
  setpoint acceleration, so to make the airframe produce `u_safe` the executor sends
  `a_ff = u_safe − feedback`, and the filtered reference integrates `a_ff`, not `u_safe` (integrating
  `u_safe` made the reference run away vertically).
- **Return-to-plan term** (`RETURN_KP = RETURN_KD = 4`) in the filtered reference: after repeated
  interventions the filtered reference otherwise drifts away from the nominal one and never comes back.
- **Blending** back to the nominal reference uses a first-order, kinematically consistent blend
  (τ = 0.5 s) after 0.3 s without interventions, so the setpoint never jumps.
- **Pure double-integrator mode with a 'reference' discretisation** (semi-implicit Euler at the control
  period, delay floored to whole control periods, coasting nominal). This is what reproduces the
  preliminary head-on table of Section 13 within 10%; the 'exact' zero-order-hold alternative is kept
  and its different numbers are explained in docs/MODEL.md §14.
- **Head-on coast.** In the head-on scenario the nominal input after the meeting point is zero (the
  drones coast), as in the preliminary study; without it the nominal keeps pulling each drone through
  the other.
- **Figure-8 peak acceleration.** The prompt's "3.187 × A w²" is the value 3.1875 w² at A = 1.5 m; in
  general the peak is (17/8) A w². The test checks the general form.

## Safety filter and supervisor

- **Clipping only modified commands.** After the QP, only commands the filter changed are clipped to
  the thrust cone (altitude priority). Clipping unmodified nominal commands would hide planner
  infeasibility that the validator and M9 already report.
- **Deadlock breaker.** Perfectly symmetric conflicts (head-on, the T5 swap at phase π) give a min-norm
  correction with no lateral component, so the drones stop nose to nose. A 1 m/s² right-hand-rule bias
  perpendicular to the line of centres (Wang, Ames, Egerstedt 2017) is added to closing pairs whose
  nominal violates the constraint. It is a toggle and is off in the head-on verification cases.
- **Braking-aware CBF: reaction distance and sampled-data look-ahead.** The Section 8.2 barrier assumes
  the commanded deceleration acts instantly and drops the constraint whenever the pair is not closing.
  In the full-physics mode (acceleration lag, held commands) a head-on pair pulled together by its
  reference ratcheted into the ellipsoid even at zero latency. The barrier now reserves a reaction
  distance `τ_r |d'|` with `τ_r = τ_a + Δt/2` and, when not closing, limits the closing speed after one
  held tick to what can still be stopped. Pure mode passes `τ_r = 0`, so the Section 13 table is
  unchanged (docs/MODEL.md §9.4, regression tests in `cbf.test.ts`).
- **Box obstacles** use the closest feature (face, edge or corner) to pick the CBF model ('face', 'line'
  or point); a point model on a box face under-estimated the barrier rate and let a drone clip a slider.
- **Emergency brake.** Infeasibility must persist for 3 control ticks (one-tick transients are absorbed
  by the margin); an imminent violation triggers immediately but only for closing pairs and only when the
  constant-input prediction drops below s = 0.98 within 0.1 s (a CBF legitimately rides s = 1, and the
  extrapolation of that motion dips marginally under it).
- **Infeasibility persistence** and the closing-only rule removed spurious emergencies in clean runs.
- **Separation metrics use the unit-margin ellipsoid** (E = diag(0.24, 0.24, 0.60), multiplier 1)
  regardless of the filter's margin multiplier, so M11/M12 are comparable across the margin sweep.
- **Validator check 4** (planned separation below 1) is a warning, not a block: the whole point of
  Aim 2 is to fly conflicting plans and watch the filter resolve them.

## Scoring

- **Geofence hover scores G = 0.5.** The supervisor's geofence hover is a safety intervention of the
  same kind as an emergency brake; the spec does not list it, and 0 (as for leaving the arena) would
  punish a drone the supervisor kept inside.
- **M22 effort uses the actual thrust** (the specific force after saturation and lag), not the
  commanded one: it is what the battery pays for.
- **Provisional live scoring.** While a trial runs, V and E are computed up to the current time so the
  live scorecard is meaningful mid-flight; the final values use the whole window.
- **Trials end 1.5 s after a collision** (2.5 s after an emergency brake) so the crash is visible but the
  log does not fill with a pile of fallen drones.

## Courses and racing line

- **Gates are octagons** of round tube (circumradius D/2 − r_tube); the pass radius is the inscribed
  radius minus the tube and drone radii. A pass is a centre crossing of the gate plane inside that
  radius in the scheduled direction; a crossing outside it is a miss, contact with the frame a strike.
- **Racing line entry/exit points** ±0.4 m along each gate normal force a straight pass through the gate.
- **Unscheduled crossings.** A smooth line through gates can cut back through a gate plane the wrong way
  (C7, C12). Gate discs are added to the voxel grid as obstacles outside their scheduled passage, and the
  A* detour avoids them.
- **Gate line clearance 0.16 m** around gate frames except in the passage: the filter's obstacle margin
  plus the drone radius would otherwise push the drone off a line planned closer than that.
- **Voxel A\*** at 0.1 m; the grid is built by iterating each primitive's bounds (a full scan took 1.5 s
  per course; now ≤ 150 ms).
- **Course arenas resize automatically** when a course needs more room than the configured arena
  (C9, C10), and the geofence follows.
- **Intersection scenario** drones start a quarter period apart (base phase π/2), otherwise both started
  on the same point.

## Planners

- The planners are labelled "simplified stand-ins for the lab's solvers" everywhere: a finite candidate
  set (lateral, and for ring courses vertical, offsets × speed levels) with rollouts, not the lab's
  continuous game solvers.
- **Risk margin 1.25.** The payoff's collision-risk term counts time with predicted s < 1.25 rather
  than s < 1: the rollouts are open loop, and plans that graze s = 1 in the rollout make the filter
  intervene in flight.
- **Whole-race horizon.** Rollouts cover the whole race (race presets fly one lap), so the predicted
  winner is the one that actually finishes first; M20 compares the realised gap at the planner's horizon.
- **Pure-strategy Nash** with a tie-break rule; when no pure equilibrium exists, iterated best response
  from the independent solution, reported as such. **Strong Stackelberg** (ties broken in the leader's
  favour).
- **Starts alternate** in race series (`swapStarts` on odd races) so a start-position advantage averages
  out of the win rates.
- Candidates leaving the geofence are invalid; open (non-loop) courses end with the drone clamped 0.9 m
  inside the arena.
- **Finish in lanes, at rest.** Every candidate ends at rest in the drone's own lane: on closed courses on
  its own start slot (same arc length and lane), on open tracks in its lane with rows behind stopping
  0.8 m earlier, blended in over the last 1.5 m. On open tracks (the pinch) every Independent plan used to
  end both drones on the same point and trigger an emergency brake after the race. The finish is the last gate pass,
  which comes before this run-in, so race results are unaffected. Before, all drones crossed the line at
  full speed and the reference then stopped dead on the same point, so every race ended with the filter
  separating the drones at the line (and the validator warned about it on every ring-course run).
- **Braking keeps a 5% margin** in the speed profile's backward pass: the piecewise-constant deceleration
  between path samples overshot the thrust budget by about 1% at a full stop, which made the feasibility
  check time-scale the whole trajectory (and shifted its timing against the moving obstacles of C7).

## Experiments (Section 12)

- **Margin sweep adds a 0.15 m obstacle-margin level** to the spec's (0.03, 0.05, 0.10). The racing lines
  keep about 0.17 m from obstacles, so obstacle margins up to 0.10 m barely bind on C6; the gate margin is
  what blocks legal passes (C5 pass rate 100% → 75% → 25% at gate margins 0.05 → 0.10 → 0.15 m).
- **Run time.** Measured single-threaded: M1 ≈ 2 s, M2 safety ≈ 12 s, margins ≈ 30 s, scaling ≈ 3 s, race
  series ≈ 190 s (480 races, each with a game solve). On the worker pool this is about a minute on a
  4-core laptop and half that on 8 cores; quick mode runs the race series in about 20 s.
- **Quick demo** mode cuts trial counts (M1 3 per level, M2 1, M3 10 races per condition) so every
  experiment finishes in seconds to about a minute; the full counts follow the spec.
- **M15 cost of safety** is computed by flying each drone's trajectory alone with the same seed and
  settings, in a worker, for recorded multi-drone trials and for the default filter configuration of
  the safety sweep (solo runs are cached per seed).
- **Holm correction** is applied within each scenario of the race series (the family is the pairwise
  condition tests on win rate, gap and intervention rate for that scenario).

## Presets

- **T10 latency stress** uses the braking-aware filter (α = 5) head-on at 3 m/s with 80 ms latency and
  the deadlock breaker off: without latency compensation every seed collides; with it none does (small
  boundary dips remain at this delay). With the exponential CBF at λ = 12 the case fails even at zero
  latency, matching the preliminary table's "λ = 12 unsafe".
- **T11 filter off** uses the T5 intersection at w = 0.78 with phase π, where the drones collide at the
  centre without the filter.
