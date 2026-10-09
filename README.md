# C3U Multi-Drone Racing Testbed — 3D browser simulator

A 3D, in-browser simulator and demo of the C3U Lab (Georgia Tech Aerospace Engineering) multi-drone
racing testbed: two to six Crazyflie quadrotors fly aggressive precomputed trajectories in a Vicon arena,
a control barrier function (CBF) safety filter keeps them apart, game-theoretic planners (Nash and
Stackelberg) choose racing strategies, and every run is scored automatically.

> **Simulation. Idealised models; numbers are illustrative, not hardware results.**
> The planners are **simplified stand-ins for the lab's solvers**; the real solvers' trajectories can be
> imported as CSV.

The simulator has three jobs:

1. **A working prototype of the real logic.** The validator, executor, safety filter, supervisor,
   metrics and statistics are implemented for real in a pure TypeScript core (`src/core`), unit-tested
   against the values of the project's preliminary study, and written to be ported to Python / ROS 2.
2. **A demo of the three research milestones and the scoring system** (guided modes with narration).
3. **A sandbox** to explore scenarios, speeds, latencies and filter settings before anything flies.

## Quick start

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # Vitest: core maths, Section 13 verification values, metrics, planners, experiments
npm run build      # type-check and build a static site into dist/
npm run preview    # serve dist/ locally
```

Node 20.19+ or 22.12+ is required (Vite 7). There is no backend: the build is a static site that runs offline.

### Deploying

`vite.config.ts` uses `base: './'`, so `dist/` works from any sub-path.

- **GitHub Pages:** build, then publish `dist/` (for example with the `peaceiris/actions-gh-pages` action
  or by pushing `dist/` to a `gh-pages` branch).
- **Vercel / Netlify:** framework preset "Vite", build command `npm run build`, output directory `dist`.
- **Any file server:** copy `dist/` anywhere; open `index.html` through a web server (Web Workers do not
  load from `file://`).

## What you see

```
┌ Top bar: title · scenario preset · Sandbox | Milestone 1 | 2 | 3 | Scorecard · transport · speed · seed · Record ┐
│ Left sidebar    │ 3D arena (orbit / follow / top / chase / side / FPV / cinematic)  │ Right panel tabs:      │
│ Course          │ drones, trails, downwash ellipsoids, reference ghosts,            │ Live · Tracking ·      │
│ Scenario        │ intervention arrows, separation lines, gates, obstacles,          │ Safety · Race · Game · │
│ Drones          │ racing line, Vicon cameras                                        │ Results                │
│ Planner         │ guided narration card (milestone modes)                           │                        │
│ Safety filter   │                                                                   │                        │
│ System, Visuals │                                                                   │                        │
├─────────────────┴───────────────────────────────────────────────────────────────────┴────────────────────────┤
│ Timeline: scrubber with event markers (interventions, violations, overtakes, emergency stops, gates, laps)   │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

Screenshots are in [`docs/screenshots/`](docs/screenshots/).

## Controls

### Top bar

| Control | What it does |
| --- | --- |
| Scenario preset | Loads one of the test cases T1–T14 (table below) with its drones, trajectories and settings. |
| Sandbox / Milestone 1 / 2 / 3 / Scorecard | Mode tabs. Milestone modes show a step-by-step narration card that sets up the scene for each step; Scorecard mode explains the scoring formula interactively. |
| Play / Pause, Step, Reset | Run the trial in real time, advance one control tick, or rebuild the trial from the current settings. |
| Sim speed | 0.1× to 4× real time. |
| Seed | Every random element (noise, wind, random trajectories, race seeds) derives from it; the same seed and settings replay bit for bit. |
| Record | When on, every finished trial is stored with its scorecard (Results → Trials) and, for multi-drone runs, its cost of safety (M15) is computed by flying each drone alone in a worker. |
| Import CSV… | Load the lab's trajectory CSVs (one per drone) and optional metadata JSON. You can also drop the files anywhere on the window. |
| Export | Trajectories (CSV + JSON per drone), the trial log (JSON), the time series (CSV) and the metrics summary (JSON). |
| Link | Copies a URL whose hash encodes the full configuration. |
| Shot | Saves a PNG screenshot of the 3D view (key S). |
| Light / Dark | Theme toggle (dark by default). |

### Left sidebar

Every control has a tooltip explaining the concept in one sentence.

- **Course** — course preset C1–C12, difficulty, random-course seed and sliders (gate count, gate size,
  height variation, spacing, turn angle, pillar count, obstacle density), **Edit course** (opens the
  course editor, key E), dynamic obstacles on/off, gate margin.
- **Scenario** — trajectory type (figure-8, circle, intersection, head-on, antipodal, split-S, random,
  pinch, race track, ring circuit, imported), its parameters (amplitude A, rate w or target speed, phase
  offset, radius, ring inner diameter, start offset / gap, closing speed, laps, height z0), time-scale
  multiplier k, "Fly anyway (expect saturation)".
- **Drones** — count 1–6 with add/remove, per-drone colour, hardware preset (Crazyflie 2.1, TWR 1.8 /
  Crazyflie 2.1 Brushless, TWR 3.5), start positions (auto or editable).
- **Planner** — Independent / Nash / Stackelberg, leader, equilibrium tie-break rule, candidate count M,
  collision penalty P, risk margin, collision responsibility (shared / follower only), receding-horizon
  re-planning, **Solve** (runs in a worker; shows the solve time and whether the plan is out of date).
- **Safety filter** — on/off; barrier type (exponential CBF with λ, braking-aware CBF with α); margin
  multiplier on the downwash ellipsoid (1.0 / 1.25 / 1.5); latency compensation; control rate 50/100 Hz;
  responsibility weights; obstacle constraints with their own margin; deadlock breaker; supervisor
  emergency brake and geofence.
- **System** — total latency 0–80 ms (or the advanced split into sensing delay τs and command delay τc),
  Vicon noise σ, wind σ, battery sag, packet loss, onboard controller (Mellinger-like with feed-forward /
  PID-like without), execution mode (streamed setpoints vs uploaded trajectory), η thrust reserve, max
  tilt, marker-swap fault, and the pure double-integrator test mode used for the verification table.
- **Visuals** — trails (length, colour by speed or drone), downwash ellipsoids, reference ghosts (nominal
  and filtered), commanded path, intervention arrows, separation line, Vicon camera frustums, safety
  nets, racing line, detour search path, labels, drone size 1× / 3× (3× by default because real
  Crazyflies are tiny).

### Right panel

- **Live** — per-drone cards (speed, tracking error, scaled separation to the nearest drone, filter
  active, battery), the live scorecard with sub-score bars, and the pre-flight validator's verdict.
- **Tracking** — error vs time, along-track / cross-track split, commanded vs executed path (top view).
- **Safety** — scaled separation s(t) for every pair with the s = 1 line, interventions, barrier values,
  correction size, solve-time histogram.
- **Race** — progress along the track per drone, the gap, overtakes, predicted vs realised outcome.
- **Game** — the payoff matrix (colour = progress gap, hatching = collision risk), best-response markers,
  pure Nash cells, Stackelberg picks, the flown cell; hovering a cell previews both candidate paths in 3D.
- **Results** — the milestone experiments (speed sweep, controller comparison, safety and margin sweeps,
  drone-count scaling, race series) with confidence intervals and Holm-corrected tests, run on a pool of
  Web Workers with progress and cancel; a "quick demo" toggle reduces trial counts. Also the recorded
  trials ranked by score with adjustable weights.

### Timeline

Scrub the recorded trial; coloured markers show interventions, separation violations, overtakes,
emergency stops, collisions, gate passes and misses, and laps. Click to jump; press Play after the
trial ends to replay at any speed.

### Keyboard shortcuts

| Key | Action |
| --- | --- |
| Space | Play / pause |
| R | Reset (rebuild the trial) |
| . | Step one control tick |
| F | Follow camera, cycling through the drones |
| T | Top view (toggle) |
| V | FPV view (toggle) |
| E | Course editor |
| K | Kill: motors off, drones fall |
| 1 / 2 / 3 | Milestone 1 / 2 / 3 mode |
| S | Screenshot |
| Esc | Back to the orbit camera |

### Course editor (E)

A top-down editor of the arena on a 0.1 m snap grid with the arena boundary and the 0.3 m geofence.
Add standing or hanging gates, pillars, boxes/walls, banners, a pendulum and a sliding panel; drag to
move; edit every property in the inspector; build the gate sequence (a gate may be visited twice or in
reverse). Live validation reports gates too close to walls, overlaps, blocked gate entries and the result
of the racing-line generator (remaining collisions, and whether it had to slow down for an impossible
turn), and draws the racing line. Apply makes it course C12; Save / Load JSON; export a printable floor
plan PNG with dimensions to lay out the real arena.

### Trajectory files

CSV columns: `t, x, y, z, vx, vy, vz, ax, ay, az, yaw` (SI units, z-up arena frame), one file per drone,
plus optional metadata JSON (`run_id, drone_id, strategy, solver, dynamics_model, d_min_assumed,
track_id, sample_period, created`). Imported files go through the same pre-flight validator as built-in
trajectories; a failing check blocks the run and says why.

## Scenario presets

| ID | Preset | What it shows |
| --- | --- | --- |
| T1 | Baseline figure-8 (A = 1.5 m, w = 0.52 rad/s) | Tracking error under 2 cm |
| T2 | Aggressive figure-8 (w = 1.54 rad/s, the CF2.1 thrust limit at η = 0.7) | Error grows, cross-track dominates in the lobes |
| T3 | Split-S dive through two stacked rings | Thrust and tilt limits in the vertical plane |
| T4 | Pinch: two drones, one 0.30 m ring | Who goes first; Nash vs Stackelberg; the filter resolves conflicts |
| T5 | Intersection: two drones on one figure-8 | Repeated conflicts at the centre |
| T6 | Head-on | Reproduces the preliminary study's table |
| T7 | Antipodal swap, 2–6 drones | N-drone QP filter, everyone gets through |
| T8 | Random crossing stress, 2–6 drones | Interventions and safety vs drone count |
| T9 | Race loop, 4 gates | Milestone 3 racing with every planner condition |
| T10 | Latency stress, head-on at 3 m/s, 80 ms | Without latency compensation the filter fails; with it, it holds |
| T11 | Filter off | Collisions, gate factor 0: the case for the filter |
| T12 | Ring course (C9 figure-8 circuit) | Gate passes, strikes, racing through a circuit |
| T13 | Obstacle forest (C6) | Drone–obstacle vs drone–drone interventions |
| T14 | Gauntlet timing (C7, moving obstacles) | Whether the filter keeps up with moving obstacles |

Courses: C1 Slalom, C2 Hairpin, C3 Corkscrew, C4 Ladder dive, C5 Keyhole, C6 Forest, C7 Gauntlet, C8
Merge, C9 Figure-8 circuit, C10 Complex circuit, C11 Random course, C12 Custom (course editor).

## How the simulator maps onto the real testbed

The lab already has the drones, the Vicon system and offline solvers that produce Nash and Stackelberg
trajectory pairs. The project builds the layer in between; each piece has a counterpart in the
simulator's core that is meant to be ported to a ROS 2 node:

| Real testbed (ROS 2 + Crazyswarm2) | Simulator (`src/core`) | Notes for the port |
| --- | --- | --- |
| Offline Nash / Stackelberg solvers | `planners/*` (stand-ins) and `csv.ts` (import) | The real solvers' output enters through the same CSV format. |
| **Validator** (pre-flight) | `validator.ts`, `feasibility.ts`, `planned.ts` | Pure functions on the trajectory set: timing, arena margin, thrust/tilt feasibility, planned separation (M17), start positions. |
| Vicon → pose topic | `sensing.ts` (`GroundEstimator`) | Noise, low-pass velocity, jump rejection; latency modelled as a timestamped queue. |
| **Executor** (setpoint streaming at 50 Hz) | `executor.ts` | Samples the nominal trajectory on the race clock; filtered / blending modes keep the reference kinematically consistent after an intervention; feed-forward inversion through the onboard law. |
| **Safety filter** (ASIF) | `safety/*` | Pair and obstacle CBFs, closed form for one constraint, Hildreth QP otherwise, clipping to the thrust cone, latency compensation from the sent-command history. |
| **Supervisor** | `supervisor.ts` + the supervisor block in `sim.ts` | Geofence hover, stale setpoints, emergency brake, kill, Vicon jump rejection. |
| Crazyradio + onboard Mellinger controller | command queue + `onboard.ts` + `dynamics.ts` | Mellinger-like (with feed-forward) and PID-like laws at 100 Hz; thrust cone, acceleration lag, wind, battery sag. |
| **Logger** (rosbag) | `TrialLog` in `sim.ts`, exports in the app | Every signal the metrics need, at the log rate, plus timestamped events; deterministic hash per run. |
| **Evaluation** | `metrics/*`, `experiments.ts` | M1–M27, the scorecard, ranking stability, bootstrap CIs, Wilson intervals, binomial and permutation tests, Holm correction. |

The core has no browser or three.js dependencies; the order of operations in one control tick is
documented at the top of `src/core/sim.ts`, and every equation is in [docs/MODEL.md](docs/MODEL.md).

## Scoring

Per trial: `Score = G × (wS·S + wV·V + wA·A + wE·E) / (wS + wV + wA + wE)` with the gate `G` = 0 for a
collision, gate strike, obstacle hit, leaving the arena, a kill or a missed gate; 0.5 for an emergency
brake (or a geofence hover); 0.75 for a separation violation without contact; 1 otherwise.
S = safety, V = speed vs plan, A = accuracy, E = effort vs plan (definitions in docs/MODEL.md §13).
Weights are sliders; the ranking-stability check samples 200 random weight vectors.

## Verification

`npm test` reproduces the values of Section 13 of the build specification: the feasibility numbers
(12.4 m/s² usable thrust, 7.5 m/s² horizontal, 37.5° tilt), the figure-8 coefficients, the CBF worked
example, the preliminary head-on table (pure double-integrator mode, within 10%), Wilson intervals,
trial-log determinism, metric unit tests on synthetic logs, and Hildreth vs the closed form.

## Code map

```
src/core/      pure TypeScript simulation core (z-up frame), no browser dependencies
  sim.ts         multi-rate simulation loop and logging
  safety/        CBFs, QP, filter
  metrics/       M1–M27, scorecard, statistics
  planners/      track, candidates, rollouts, game solvers, re-planning
  experiments.ts milestone experiments and their statistics
src/workers/   planner and sweep workers (comlink)
src/app/       React UI: store, engine, panels, charts, 3D scene, milestones, results
src/tests/     Vitest suites
docs/MODEL.md  every equation, as implemented
DECISIONS.md   non-obvious choices and why
PROGRESS.md    build-phase checklist
```

## Limitations

- No high-fidelity aerodynamics: downwash is only the ellipsoid rule.
- No ROS, no hardware connection, no backend.
- The planners are simplified stand-ins for the lab's solvers.
- All numbers are illustrative simulation results, not hardware results.

## References

Ames et al. 2019, *Control Barrier Functions: Theory and Applications*; Spica et al. 2020, *A Real-Time
Game Theoretic Planner for Autonomous Two-Player Drone Racing* (T-RO); Liniger & Lygeros 2020, *A
Non-Cooperative Game Approach to Autonomous Racing*; Pasumarti et al. 2025, *Agile Flight Emerges from
Multi-Agent Competitive Racing*; Preiss et al. 2017, *Crazyswarm*; Hönig et al. 2018, *Trajectory Planning
for Quadrotor Swarms* (T-RO, downwash ellipsoid); Wang, Ames & Egerstedt 2017 (safety barrier
certificates, deadlock perturbation); Mellinger & Kumar 2011; Hildreth 1957; nuPlan and CARLA
(scorecard structure).

Built for the C3U Lab, Georgia Tech Aerospace Engineering (PI: Dr. Sarah H.Q. Li).
