# Model reference

> **Simulation. Idealised models; numbers are illustrative, not hardware results.**
> The planners are simplified stand-ins for the lab's solvers.

This document lists every equation the simulator core uses, the way it is **actually implemented** in
`src/core` (file paths are given for each part), with references. Where the implementation differs from
the build prompt ("the spec"), the code is documented and the difference is called out in a
**Note**. Every numeric example in this document was recomputed from the code; they describe the model,
not a Crazyflie.

Notation used throughout (plain text, no LaTeX):

| Symbol | Meaning |
| --- | --- |
| `p, v, a` | position, velocity, actual (lagged) acceleration of a drone, core frame (m, m/s, m/s²) |
| `u` | commanded acceleration (m/s²); `u_nom` nominal, `u_safe` after the safety filter |
| `f = a + g e_z` | specific thrust vector (m/s²); `g = 9.81`, `e_z = (0, 0, 1)` |
| `TWR`, `η`, `θ_max` | thrust-to-weight ratio, planning thrust reserve (eta), maximum tilt |
| `dp = p_i − p_j`, `dv = v_i − v_j`, `Δu = u_i − u_j` | pair differences |
| `D = diag(Dx, Dy, Dz)` | ellipsoid metric of a drone pair |
| `xᵀy`, `\|x\|` | dot product, Euclidean norm |
| `k` | speed multiplier (time scaling) |
| `Δt` | physics step, 1 ms; `T` control period (20 ms at 50 Hz) |

---

## 1 Frames, units and default parameters

**Frame.** The core is z-up, matching Vicon / ROS: x forward, y left, z up, origin at the centre of the
arena floor. The default arena is 8 × 5 × 3 m, so `x ∈ [−4, 4]`, `y ∈ [−2.5, 2.5]`, `z ∈ [0, 3]`. Yaw `ψ`
is measured about +z from +x. three.js is y-up; the conversion happens in exactly one helper,
`src/app/scene/frames.ts`:

```
toThree(p) = [p.x, p.z, −p.y]
```

**Units.** SI everywhere (m, s, m/s, m/s², kg, rad). Degrees and cm appear only in the UI.

**Attitude for rendering** (`frames.ts attitudeQuaternion`, after Mellinger & Kumar 2011): body z axis
`z_b = f / |f|`, heading vector `x_c = (cos ψ, sin ψ, 0)`, `y_b = normalise(z_b × x_c)`, `x_b = y_b × z_b`.
Yaw comes from the reference: the unwrapped heading `atan2(v_y, v_x)` of the planned horizontal velocity
(`trajectories/common.ts fillYawFromHeading`).

**Determinism.** Every random element draws from a seeded mulberry32 generator (`rng.ts`); normals
use Box–Muller. Independent streams come from `deriveSeed(seed, label, index)` (FNV-1a of the label
mixed with a splitmix-style finaliser), so switching wind on does not change the sensor-noise
sequence. The same seed and config give an identical `TrialLog` hash (`sim.ts hashTrialLog`, which
excludes wall-clock solve times).

**Default parameters** (`constants.ts`, `defaults.ts`):

| Quantity | Default |
| --- | --- |
| Physics step `Δt` | 0.001 s |
| Vicon / ground control / onboard rates | 200 Hz / 50 Hz (option 100) / 100 Hz |
| Total latency, split | 25 ms, 40 % sensing (`τ_s = 10 ms`), 60 % command (`τ_c = 15 ms`) |
| Vicon noise σ | 0.5 mm |
| Presets | CF21: 0.033 kg, TWR 1.8; CF21_BRUSHLESS: 0.034 kg, TWR 3.5 (mass is display and effort only) |
| `θ_max`, `η`, `τ_a` | 60°, 0.7, 0.03 s |
| Mellinger gains | `Kp = diag(12, 12, 15)`, `Kd = diag(5, 5, 6)` |
| PID gains | same `Kp`, `Kd`; `Ki = diag(1.5, 1.5, 2.0)`, integral clamp ±0.5 m·s |
| Downwash ellipsoid radii (one drone) | (0.12, 0.12, 0.30) m |
| Pair ellipsoid `E` | diag(0.24, 0.24, 0.60) m × margin multiplier (default 1) |
| Drone radius / collision distance | 0.05 m / 0.10 m (centre to centre) |
| Arena margin (geofence, validator) | 0.3 m |
| Filter | ECBF, `λ = 8`; braking-aware `α = 5`, braking fraction 0.8; obstacle `λ = 8`, `α = 5`; obstacle and gate margins 0.05 m; latency compensation on |
| Intervention threshold | 0.05 m/s² |

---

## 2 Multi-rate timing and latency queues

Implemented in `time.ts` and the step loop of `sim.ts`.

**Integer ticks.** Time advances in integer physics ticks, `t = tick · Δt`, so rates never drift. A task
at `f` Hz has period

```
period(f) = max(1, round(1 / (f · Δt)))      [ticks]
fires(tick)  ⇔  tick mod period = 0
```

which gives 5 ticks for Vicon at 200 Hz, 20 for control at 50 Hz (10 at 100 Hz), 10 for the onboard loop
at 100 Hz. All tasks have offset 0, so control ticks coincide with Vicon and onboard ticks.

**Delay queues.** Latencies are timestamped FIFO queues (`DelayQueue`), never shifted arrays. An item
pushed at `t_send` with delay `τ` is delivered at the first tick with `t ≥ t_send + max(0, τ)` (tolerance
1e−9 s). `popLatest(t)` returns only the newest delivered item and discards older ones, so a newer
setpoint always supersedes an older one. Queues in use:

| Queue | Delay | Consumer |
| --- | --- | --- |
| Vicon samples (all drones) | `τ_s` | ground estimators |
| Command packets (per drone) | `τ_c` | onboard setpoint (`popLatest`) |
| Onboard estimate (per drone) | 2 ms | onboard controller (`popLatest`) |

**Latency split** (`defaults.ts latencies`): `τ_s = L · σ`, `τ_c = L · (1 − σ)`, with total `L` (slider,
0 to 80 ms) and split `σ = 0.4`; the advanced fields override both directly. Packet loss (optional) drops
each setpoint packet with probability `p_loss` before it enters the command queue.

**Order of operations in one physics tick** (`Simulation.step`):

1. Vicon sampling (if the Vicon task fires) → sensing queue.
2. Sensing deliveries → ground estimators (jump rejection, velocity filter).
3. Ground control (if the control task fires): executor → `u_nom` → safety filter → supervisor →
   reference consistency → setpoint packet → command queue.
4. Command deliveries → onboard setpoint.
5. Onboard controller (if the onboard task fires) → `a_cmd`, held constant (zero-order hold).
6. Dynamics for every drone (thrust cone, lag, wind, battery).
7. `tick ← tick + 1`, then physics-rate checks (collisions, separation, gates, obstacles, arena, laps).

The race clock is the simulation clock: `t_race = t`, starting at 0 with a flying start (each drone is
initialised on its reference with the planned velocity and acceleration). Takeoff and landing are
outside the model and outside the analysis window.

**Measured latency (M7).** For each delivered command packet the simulator records
`t_arrival − t_capture`, where `t_capture` is the capture time of the Vicon sample behind the estimate
used to compute it; M7 is the mean. With the default aligned rates (Vicon period 5 ms divides `τ_s` and
the control period) the measured value equals the configured total (24.98 ms for 25 ms); misaligned
delays add the wait for the next sample or control tick.

---

## 3 Drone model

`dynamics.ts`. A point mass driven by specific thrust; mass is never used by the dynamics.

**State:** `p, v, a` (actual acceleration excluding wind), `f` (thrust produced), yaw (cosmetic), current
`TWR` (battery), phase `flying | falling | landed`.

### 3.1 Thrust cone saturation (tilt first, then magnitude)

`saturateThrust(a_cmd, TWR, θ_max)`:

```
f = a_cmd + g e_z
1. if f_z < 0:                 f_z ← 0
2. f_h = |(f_x, f_y)|,  f_h,max = f_z · tan θ_max
   if f_h > f_h,max:           (f_x, f_y) ← (f_x, f_y) · f_h,max / f_h       (tilt clamp keeps f_z)
3. if |f| > TWR · g:           f ← f · TWR g / |f|                          (uniform shrink keeps the tilt)
a_sat = f − g e_z
```

The tilt clamp keeps the vertical component (altitude priority); the magnitude clamp scales the whole
vector, so it cannot re-violate the tilt limit. The result lies in the convex set
`{f_z ≥ 0, tilt(f) ≤ θ_max, |f| ≤ TWR g}`. It is the sequential rule of the spec, not the Euclidean
projection onto that set.

### 3.2 Acceleration lag (attitude dynamics), exact discretisation

```
da/dt = (a_sat − a) / τ_a
a_{n+1} = a_n + (a_sat − a_n) · (1 − exp(−Δt / τ_a))
```

This is the exact solution over one step with `a_sat` held constant (zero-order hold), so it is stable
for any `τ_a`; with `τ_a = 0.03 s` and `Δt = 1 ms` the factor is 0.0328. `τ_a = 0` gives `a = a_sat`.
Because each step is a convex combination of the previous `a` and a point of the convex thrust set, the
realised thrust also stays inside the set (up to battery sag shrinking the set over time).

### 3.3 Integration

Semi-implicit Euler at `Δt = 1 ms`, wind added as an acceleration:

```
v_{n+1} = v_n + (a_{n+1} + w_n) Δt
p_{n+1} = p_n + v_{n+1} Δt
f = a_{n+1} + g e_z               (thrust used for effort M22 and rendering; excludes wind)
```

### 3.4 Wind: Ornstein–Uhlenbeck acceleration

`OUWind`, after Uhlenbeck & Ornstein 1930. Per axis
`dw = −(w / τ_w) dt + σ √(2 / τ_w) dW`, whose stationary standard deviation is `σ`. Exact
discretisation:

```
φ = exp(−Δt / τ_w)
w_{n+1} = φ w_n + σ √(1 − φ²) ξ,      ξ ~ N(0, 1)
```

The z component uses `σ/2`. The initial `w` is drawn from the stationary distribution. Defaults:
`σ = 0` (off, slider 0 to 1 m/s²), `τ_w = 1 s`. Each drone has its own seeded stream.

### 3.5 Battery sag

```
TWR(t) = TWR_0 · (1 − sag · min(1, t / 420 s))
```

linear over a 7-minute flight (`batteryTwr`). Both the dynamics and the filter's feasible set use the
current value.

### 3.6 Falling after a kill or crash

`startFalling` / `stepFalling`: velocity is damped on impact
(`v_xy ← 0.4 v_xy + impulse`, `v_z ← 0.5 min(v_z, 0)`), a random unit spin axis and a rate of 8 to
18 rad/s are drawn (seeded). Then `v_xy ← v_xy (1 − 0.3 Δt)`, `v_z ← v_z − g Δt`, `p ← p + v Δt` until
`z ≤ 0.012 m` (landed). A drone–drone collision adds ±0.8 m/s along the horizontal line of centres.

---

## 4 Onboard controllers

`onboard.ts`, running at `f_onboard = 100 Hz` on each drone; output held between ticks.

**Mellinger-like (default)**, a position loop with acceleration feed-forward (after Mellinger & Kumar
2011, with the attitude loop folded into the lag of Section 3.2):

```
a_cmd = a_ref + Kp (p_ref − p̂) + Kd (v_ref − v̂),     Kp = diag(12, 12, 15),  Kd = diag(5, 5, 6)
```

With perfect feed-forward, no lag and no latency the error obeys `ë + Kd ė + Kp e = 0`, so
`ω_n = √Kp` and `ζ = Kd / (2 √Kp)`: horizontally 3.46 rad/s and ζ = 0.72, vertically 3.87 rad/s and
ζ = 0.77 (slightly underdamped). The 30 ms lag and the latency reduce the phase margin further.

**PID-like baseline** (no feed-forward, small integral):

```
I ← clamp(I + (p_ref − p̂) · T_on, ±0.5)            (per axis, T_on = 10 ms, rectangle rule)
a_cmd = Kp (p_ref − p̂) + Kd (v_ref − v̂) + Ki I,     Ki = diag(1.5, 1.5, 2.0)
```

`a_ref` is ignored. For a sinusoidal reference of frequency `ω` the linear loop's error transfer is
`E/R = s³ / (s³ + Kd s² + Kp s + Ki)`, so `|E/R| = ω³ / √((Ki − Kd ω²)² + (Kp ω − ω³)²)`: about 0.20 on the
x axis of the figure-8 at `ω_max = 1.54 rad/s` (illustrative linear estimate, ignoring lag and latency).
This is why Milestone 1 shows feed-forward matters.

**Ground-side model of the law** (`onboardLaw`, `feedbackTerm`): the ground station uses the same `Kp`,
`Kd` and feed-forward flag (1 for Mellinger, 0 for PID) to predict `u_nom` and to invert the law
(Section 8). The PID integral is not modelled on the ground.

**Uploaded mode** (`system.mode = 'uploaded'`): the onboard loop samples the nominal trajectory itself
(`exec.nominal(t)`), with no ground latency and no safety filter.

---

## 5 Sensing and estimation

`sensing.ts`, `sim.ts sampleVicon`.

**Vicon.** At `f_vicon` each drone's position is measured as

```
p_vicon = p_true + n,      n ~ N(0, σ_v² I),  σ_v = 0.5 mm
```

and pushed into the sensing queue with delay `τ_s`.

**Marker-swap fault** (optional): for each pair whose centres are closer than 0.15 m, with probability
0.05 per Vicon frame the two samples swap identities for that frame.

**Jump rejection.** Each sample is compared with the estimator's prediction:

```
δ = | p_vicon − (p̂ + v̂ (t_capture − t̂_capture)) |
reject if δ > 0.10 m  (and fewer than 5 consecutive rejections)
```

A rejected sample leaves the estimate (`p̂`, `v̂`, capture time) unchanged and counts a Vicon-jump event.
After 5 consecutive rejections the next sample is accepted regardless, so a genuine fast motion cannot
lock the estimator out.

**Ground velocity estimate**: a first-order low-pass of the finite difference, discretised exactly for
the actual sample spacing `dt`:

```
α = exp(−2π f_c dt),  f_c = 20 Hz            (α = 0.533 at 200 Hz)
v̂ ← α v̂ + (1 − α) (p_vicon − p̂) / dt
p̂ ← p_vicon
```

The position estimate is the raw (noisy) accepted sample.

**Onboard estimate** (`OnboardEstimator`): the spec allows a simple model, and the code uses one. After
each physics step the true state plus noise is pushed into a 2 ms delay queue:

```
p̃ = p + N(0, (0.5 mm)²),  ṽ = v + N(0, (5 mm/s)²)
```

and the onboard controller reads the newest delivered sample. Ground and onboard estimates are
independent: the ground filter output is not sent to the drone.

---

## 6 Trajectories

### 6.1 Representation and sampling

`trajectories/common.ts`. A trajectory is a time series at 100 Hz (`TRAJ_DT = 0.01 s`) of
`t, x, y, z, vx, vy, vz, ax, ay, az, yaw` plus metadata. The executor samples it at any time `t` by
locating the interval `[t_i, t_{i+1}]` (`h = t_{i+1} − t_i`, `s = (t − t_i) / h`) and using a **cubic Hermite**
interpolation for position (with the stored velocities as tangents) and linear interpolation for
velocity, acceleration and yaw:

```
h00 = 2s³ − 3s² + 1,  h10 = s³ − 2s² + s,  h01 = −2s³ + 3s²,  h11 = s³ − s²
p(t) = h00 p_i + h10 h v_i + h01 p_{i+1} + h11 h v_{i+1}
v(t) = v_i + s (v_{i+1} − v_i),   a(t) = a_i + s (a_{i+1} − a_i)
```

Before the first sample the first sample (including its velocity and acceleration) is held; after the
last, the final position is held with zero velocity and acceleration (hover).

### 6.2 Time scaling

A speed multiplier `k` replaces `t` by `k t` (`sampleScaled`, `timeScaleTrajectory`):

```
p_k(t) = p(k t),   v_k(t) = k v(k t),   a_k(t) = k² a(k t),   duration_k = duration / k
```

Every consumer (executor, feasibility, planned effort, planned separation, validator) applies the same
scaling.

### 6.3 Figure-8 (lemniscate of Gerono)

`trajectories/figure8.ts`, with `θ = ω t + φ` (optional mirror `x → −x`):

```
p = (A sin θ, (A/2) sin 2θ, z0)
v = A ω (cos θ, cos 2θ, 0)
a = −A ω² (sin θ, 2 sin 2θ, 0)
```

**Peak acceleration.** With `u = sin² θ`:

```
|a|² = A² ω⁴ (sin² θ + 4 sin² 2θ) = A² ω⁴ (sin² θ + 16 sin² θ cos² θ) = A² ω⁴ (17u − 16u²)
```

maximised at `u = 17/32`, where `17u − 16u² = 289/64`, so

```
|a|_max = (17/8) A ω² = 2.125 A ω²
```

For `A = 1.5 m` this is `3.1875 ω²`. **Note:** the spec writes "3.187 × A w²"; 3.187 is the coefficient of
`ω²` at `A = 1.5 m`, and the code uses the general `17/8 A ω²` (`FIGURE8_PEAK_ACCEL_COEFF`). The spec's
own `w_max = 1.54 rad/s` confirms this reading (Section 7).

**Speeds.** `|v|² = A² ω² (cos² θ + cos² 2θ)`, maximal (`= 2 A² ω²`) at `θ = 0`, so the peak speed is
`√2 A ω`. The mean speed over a lap is `A ω · (1/2π) ∮ √(cos² θ + cos² 2θ) dθ = 0.9704 A ω` (evaluated
numerically with 20 000 midpoints). Lap period `2π / ω`.

**Intersection scenario** (`scenario.ts`): both drones on the same figure-8 starting at `θ0 = π/2`, drone 2
shifted by the phase offset (default π, which gives `x2 = −x1, y2 = y1`), so they meet in the centre twice
per lap.

### 6.4 Circle

`trajectories/circle.ts`: `p = (R cos θ, R sin θ, z0)`, `v = R ω (−sin θ, cos θ, 0)`,
`a = −R ω² (cos θ, sin θ, 0)`, default `R = 1.2 m`.

### 6.5 Minimum-jerk spline (general formulation)

`trajectories/minJerk.ts minDerivSpline`, with fixed time allocation. For `m` segments with durations
`T_j`, minimise `∫ |p⁽ʳ⁾(t)|² dt` (jerk: `r = 3`; snap: `r = 4`) subject to the waypoint positions. The
Euler–Lagrange equation `p⁽²ʳ⁾ = 0` makes each segment a polynomial of degree `2r − 1` (quintic for
jerk). In normalised time `τ = (t − t_j) / T_j ∈ [0, 1]`:

```
p_j(τ) = Σ_{k=0}^{2r−1} c_{j,k} τᵏ
d^q p_j / dt^q = Σ_{k≥q} c_{j,k} · k! / (k − q)! · τ^{k−q} / T_j^q
```

Constraints (one row each, `2r` unknowns per segment):

- positions at both ends of each segment (`2m` rows);
- continuity of derivatives `1 … 2r − 2` at every interior junction (the optimality condition when
  interior waypoints fix positions only);
- open splines: derivatives `1 … r − 1` prescribed at both ends (velocity and acceleration for
  minimum jerk; zero unless given); closed splines: the continuity rows also at the wrap junction.

Row count check for `r = 3`: open `2m + 4(m − 1) + 4 = 6m`, closed `2m + 4m = 6m`. The square system is
factorised once by LU with partial pivoting (`linalg.ts`) and solved for x, y and z. Times come from
segment length over a target speed with a floor (`allocateTimes`: 0.25 s; racing line: 0.12 s).

**Rest-to-rest straight line** (`minJerkLine`, the classic 10-15-6 profile, Flash & Hogan 1985):

```
σ(τ) = 10τ³ − 15τ⁴ + 6τ⁵,   τ = t / T
p = a + (b − a) σ,   v = (b − a)(30τ² − 60τ³ + 30τ⁴) / T,   acc = (b − a)(60τ − 180τ² + 120τ³) / T²
```

Peak speed `1.875 |b − a| / T` at `τ = 1/2`; peak acceleration `(10/√3) |b − a| / T² ≈ 5.774 |b − a| / T²`
at `τ = (3 − √3)/6`.

### 6.6 Antipodal swap

`trajectories/antipodal.ts`: `N` drones at angles `2πk / N` on a circle of radius 1.5 m, each flying the
10-15-6 line to the opposite point, `T = 1.875 · 3 m / v_peak` (so the peak speed is the target speed),
followed by a 1 s hold. Everyone meets in the middle at `T/2`.

### 6.7 Head-on

`trajectories/headon.ts`. Drones start at `x = ∓gap/2` (same `y`, `z0`) and fly towards each other at
speed `v`:

- **Default variant:** coast at constant speed (zero planned acceleration) for `L1 = gap + 0.6 m`, i.e.
  past the other drone's start, then decelerate at 3 m/s² to rest:
  `s(t) = v t` for `t ≤ t1 = L1 / v`, then `s = L1 + v τ − 1.5 τ²`, ending at `L1 + v² / 6`. The planned
  paths cross; only the safety filter keeps the drones apart, and the nominal input is zero through
  the closest approach.
- **Coast variant** (`headonCoast`, used with the pure double-integrator mode of Section 14): constant
  velocity for `gap / (2v) + 3 s`; the plan leaves the arena, so it is meant for that test mode only.

### 6.8 Random crossing

`trajectories/random.ts`, seeded. Start points at random angles on the ellipse with semi-axes
`(sx/2 − 0.8, sy/2 − 0.7)`, at least 1 m apart; end points roughly opposite (angle jitter ±0.6 rad);
one centre waypoint per drone uniform in `[−0.6, 0.6] × [−0.45, 0.45]` m; heights `z0 ± 0.35 m` clamped
to `[0.6, sz − 0.8]`. A common crossing time `T_c = max_i |centre_i − start_i| / v` is shared, and each
drone flies an open rest-to-rest minimum-jerk spline through `[start, centre, end]` with durations
`1.25 T_c` and `1.25 max(1 s, |end − centre| / v)`, then holds for 0.8 s.

### 6.9 Imported CSV with positions only

`csv.ts`: positions are linearly resampled to 100 Hz, smoothed with a Gaussian kernel (σ = 4 samples,
40 ms) and differentiated by central differences, smoothing again after each differentiation. The
import warns that the resulting acceleration is noisy.

---

## 7 Feasibility check

`feasibility.ts` (metric M9, validator check 3). For every planned sample, after time scaling:

```
f = a k² + g e_z
flag  ⇔  |f| > η · TWR · g   or   acos(f_z / |f|) > θ_max
share = flagged samples / samples
```

**The TWR 1.8 / η 0.7 numbers.** The usable thrust is

```
F = η · TWR · g = 0.7 × 1.8 × 9.81 = 12.36 m/s²     (≈ 12.4)
```

In planar flight `f_z = g`, so the horizontal limit and the tilt at that limit are

```
a_h,max = √(F² − g²) = √(152.79 − 96.24) = 7.52 m/s²          (≈ 7.5)
θ_lim  = acos(g / F) = acos(0.794) = 37.47°                  (≈ 37.5)
```

Since 37.5° < θ_max = 60°, the thrust budget binds before the tilt limit for the CF2.1. At full thrust
(η = 1) the same formulas give 14.68 m/s² at 56.25°, still inside 60°.

**Figure-8 numbers** (A = 1.5 m, CF2.1, η = 0.7), from `figure8MaxW`, `figure8MeanSpeed`,
`figure8PeakSpeed`:

```
ω_max = √(a_h,max / (2.125 A)) = √(7.52 / 3.1875) = 1.536 rad/s
lap   = 2π / ω_max = 4.09 s,   mean speed = 0.9704 A ω = 2.24 m/s,   peak = √2 A ω = 3.26 m/s
baseline ω = 0.522 rad/s: mean speed 0.76 m/s, peak acceleration 0.87 m/s²
```

**Note (brushless preset):** with TWR 3.5 and η = 0.7, `F = 24.03 m/s²` and `acos(g / F) = 65.9° > 60°`,
so the tilt limit binds and the true planar limit is `g tan 60° = 16.99 m/s²`. `checkFeasibility`
handles this correctly, but `horizontalLimit` (figure-8 helper), `planningAccel` (planner speed
profiles) and `maxAccelAlong` (braking capability, Section 9.4) use `√(F² − g²) = 21.94 m/s²` and ignore
the tilt, so for the brushless preset they are optimistic; the final feasibility check and time
scaling still catch infeasible plans.

**Time-scale search.** `feasibleTimeScale` multiplies `k` by 0.97 until the share is 0 (at most 60 steps).
Planner candidates use steps of 0.96 (30 steps); the racing line stretches its segment durations by
1.08 per step (25 steps).

---

## 8 Executor and reference consistency

`executor.ts`. One executor per drone samples its trajectory on the shared race clock with
`sampleScaled(traj, t_race − t_offset, k)` at the control rate (`t_offset = 0` unless re-planned) and
keeps the streamed reference consistent with the safety filter. It has three modes.

**Nominal.** Send the planned setpoint `(p_nom, v_nom, a_nom, ψ)`.

**Nominal input for the filter.** The filter works on accelerations, so the executor predicts what the
onboard law would command for the candidate reference, using the ground's (possibly
latency-compensated) estimate `p̂, v̂`:

```
u_nom = onboardLaw(candidate, p̂, v̂) + r
      = ff · a_cand + Kp (p_cand − p̂) + Kd (v_cand − v̂) + r          (ff = 1 Mellinger, 0 PID)
```

where the return term `r` is non-zero only in filtered mode (below). In the pure double-integrator mode
`u_nom = a_cand` (the planned acceleration).

**Filtered mode** (entered on any tick where the filter intervened). On entry the filtered reference is
initialised at the drone's state, `p_f = p̂`, `v_f = v̂` (predicted state when compensating latency). While
filtered, the candidate reference is `(p_f, v_f, a_nom)` and the plan pulls back with a critically
damped return term

```
r = K_r (p_nom − p_f) + D_r (v_nom − v_f),     K_r = D_r = 4    (s² + 4s + 4 = (s + 2)²: ω = 2 rad/s, ζ = 1)
```

so repeated short interventions near gate frames do not accumulate into drift. The filter still has
the final say over it. After filtering, the executor **inverts the onboard law**: it sends the
feed-forward

```
a_ff = u_safe − [Kp (p_f − p̂) + Kd (v_f − v̂)]
setpoint = (p_f, v_f, a_ff)
```

so that, if the drone's estimate when the packet arrives equals the ground's prediction, the onboard
law produces exactly `u_safe`. The reference then integrates `a_ff` (exactly, for constant `a_ff` over the
control period `T`):

```
p_f ← p_f + v_f T + ½ a_ff T²,     v_f ← v_f + a_ff T
```

It integrates `a_ff` (= `a_nom + r + correction`), not `u_safe`: the feedback part belongs to the drone,
and integrating it into the reference would make the reference run away from a lagging drone. When
the filter is inactive while in filtered mode, `u_safe = u_nom` and `a_ff = a_nom + r`, so the
reference simply follows the plan plus the pull-back.

**Blending.** After 0.3 s without intervention the offset `d0 = p_f − p_nom` decays with a first-order
time constant `τ_b = 0.5 s`. The setpoint is kinematically consistent with `d(t) = d0 exp(−t / τ_b)`:

```
p = p_nom + d,   v = v_nom − d / τ_b,   a = a_nom + d / τ_b²
d ← d · exp(−T / τ_b)   each control tick;   |d| < 1 mm → nominal mode
```

A new intervention during blending re-enters filtered mode from the current estimate. The filtered
reference (`p_f`, or `p_nom + d` while blending) is logged and drawn as the ghost marker.

**Note (PID-like controller):** the PID-like law ignores `a_ref`, so `a_ff` has no direct effect onboard;
the correction then acts only through the integrated reference `(p_f, v_f)` via the position loop. The
reference-consistency design assumes the Mellinger-like default.

**Re-planning (stretch).** When enabled, `sim.ts` re-solves the game every `replanDt` (default 0.5 s)
from the current state (`planners/replan.ts`) and swaps each executor's trajectory (its `t = 0` becomes
the current race time, `t_offset`), returning it to nominal mode.

---

## 9 Safety filter

An Active Set Invariance Filter (ASIF, Ames et al. 2019): minimally modify the nominal accelerations so
every barrier constraint holds. Files: `safety/ecbf.ts`, `safety/brakingCbf.ts`, `safety/qp.ts`,
`safety/filter.ts`, `geometry.ts`.

### 9.1 Model and ellipsoid

For the filter each drone is a double integrator, `ṗ = v`, `v̇ = u`. Separation uses the downwash
ellipsoid of Hönig et al. 2018: per drone radii (0.12, 0.12, 0.30) m, so for a pair
`E = diag(0.24, 0.24, 0.60) · μ` (margin multiplier `μ`: 1, 1.25 or 1.5; the radii are in metres) and

```
D = E⁻² = diag(1/0.24², 1/0.24², 1/0.60²) / μ² = diag(17.36, 17.36, 2.78) / μ²
s = √(dpᵀ D dp)          (scaled separation; s ≥ 1 outside the downwash zone, s < 1 a violation)
```

The filter uses `D` with the margin multiplier; logged metrics (M11, M12) use the physical ellipsoid
(`m = 1`).

### 9.2 Exponential CBF for a pair (step by step)

`ecbfPair`, after Ames et al. 2019 and Nguyen & Sreenath 2016. Barrier and its derivatives (D symmetric):

```
h   = dpᵀ D dp − 1
ḣ   = 2 dpᵀ D dv
ḧ   = 2 dvᵀ D dv + 2 dpᵀ D Δu                (Δu = u_i − u_j)
```

`h` has relative degree 2. Define `ψ1 = ḣ + λ h` and require `ψ̇1 + λ ψ1 ≥ 0`, i.e. both poles of the
characteristic polynomial `(s + λ)²` at `−λ`:

```
ḧ + 2λ ḣ + λ² h ≥ 0
```

Substituting `ḧ` gives a constraint linear in `Δu`:

```
aᵀ Δu ≥ b,     a = 2 D dp,     b = −2 dvᵀ D dv − 2λ ḣ − λ² h
```

**Why it works.** If `ψ1 ≥ 0` and `h ≥ 0` when the filter activates, the comparison lemma gives
`ψ1(t) ≥ ψ1(0) e^{−λt} ≥ 0`, hence `ḣ ≥ −λ h` and `h(t) ≥ h(0) e^{−λt} ≥ 0`. The initial-condition
requirement `ḣ + λ h ≥ 0` is checked on the first control tick after the filter is enabled
(`initViolations`); a violation logs an `ecbfInitWarning` event (the code cites Ames et al. 2019,
Thm. 8). `λ`: slider 1 to 15, default 8.

### 9.3 Worked example

Drones at `p_1 = (0, 0, 1)` and `p_2 = (0.5, 0, 1)`, velocities `v_1 = (1, 0, 0)` and `v_2 = (−1, 0, 0)`, zero
nominal input, `λ = 4`, margin 1:

| Step | Value |
| --- | --- |
| `D` | `diag(1/0.0576, 1/0.0576, 1/0.36) = diag(17.36, 17.36, 2.78)` |
| `dp`, `dv` | `(−0.5, 0, 0)`, `(2, 0, 0)` |
| `h = 17.36 × 0.25 − 1` | **3.34** (`s = √4.34 = 2.08`) |
| `ḣ = 2 × (−0.5) × 17.36 × 2` | **−34.7** |
| `dvᵀ D dv = 4 × 17.36` | 69.4 |
| `a = 2 D dp` | **(−17.36, 0, 0)** |
| `b = −2 × 69.4 − 2 × 4 × (−34.7) − 16 × 3.34 = −138.9 + 277.8 − 53.4` | **85.5** |
| `aᵀ(u_1⁰ − u_2⁰) = 0 < b` | constraint active |
| `c = (b − 0) / (2 \|a\|²) = 85.44 / (2 × 301.4)` | **0.142** |
| `u_1 = c a`, `u_2 = −c a` | **(−2.46, 0, 0)**, **(+2.46, 0, 0)** |

Check: `aᵀ(u_1 − u_2) = −17.36 × (−4.92) = 85.4 = b`. Each drone brakes at 2.46 m/s². Here
`ḣ + λ h = −34.7 + 13.4 = −21.4 < 0`, so this state violates the initial-condition requirement: the
correction is still the minimum-norm one, but forward invariance from this state is not guaranteed and
the simulator would log a warning if the filter were switched on here. These values are reproduced in
`src/tests/cbf.test.ts`.

### 9.4 Braking-aware CBF

`brakingPair`. A relative-degree-1 barrier that reserves the distance needed to stop. In scaled units:

```
d  = √(dpᵀ D dp),     d' = dpᵀ D dv / d   (negative when closing),     n = D dp / d
```

When closing (`d' < 0`):

```
h_b  = d − 1 − d'² / (2 a_b) + τ_r d'               (τ_r d' = −τ_r |d'|: reaction distance)
d''  = (dvᵀ D dv − d'²) / d + nᵀ Δu
h_b' = d' − (d'/a_b − τ_r) d''                      (a_b treated as constant)
constraint  h_b' + α h_b ≥ 0
```

With `c0 = τ_r − d' / a_b > 0` and `κ = (dvᵀ D dv − d'²) / d`, this is linear in `Δu`:

```
(c0 n)ᵀ Δu ≥ −d' − c0 κ − α h_b
```

**Reaction time `τ_r`** (a deviation from the spec's Section 8.2, which is the special case `τ_r = 0`).
The spec's barrier assumes the commanded deceleration acts instantly. In the full-physics mode it reaches the
airframe through the first-order acceleration lag `τ_a` (Section 3.2) and the zero-order hold of the control
period, so braking starts about `τ_r = τ_a + Δt/2` late (0.03 + 0.01 s at 50 Hz). Without the reaction term,
`c0 = −d'/a_b → 0` as the pair comes to rest near the boundary, so the constraint barely limits a large
inward nominal input (the reference of a head-on pair keeps pulling through the other drone), and the lagged
airframe overshoots into the ellipsoid. With it, `c0 ≥ τ_r` and the barrier keeps a grip on the input. The
pure double-integrator mode passes `τ_r = 0`, so the Section 13 table is unchanged.

**Sampled-data look-ahead when not closing** (`d' ≥ 0`). The continuous-time constraint is void (no input
term), but the command is held for a whole control period `Δt`, during which an inward nominal input passes
unfiltered. The filter therefore requires the closing speed after one held tick to stay stoppable:

```
d' + Δt (κ + nᵀ Δu) ≥ −v_stop,     v_stop = a_b (√(τ_r² + 2 max(0, d − 1) / a_b) − τ_r)
```

`v_stop` is the largest closing speed that can still be stopped within `d − 1` including the reaction distance
(`√(2 a_b (d − 1))` for `τ_r = 0`). This is linear in `Δu`. Found with T10 (head-on, deadlock breaker off):
without these two terms the braking-aware filter let the pair ratchet into the ellipsoid even at zero latency
(regression tests in `src/tests/cbf.test.ts`).

**Braking capability with effective radius.** `a_b` is the pair's relative braking acceleration in scaled
units (1/s²):

```
a_rel = β · (cap_i(ê) + cap_j(−ê)),     ê = dp / |dp|,     β = braking fraction (default 0.8)
r_eff = |dp| / d                         (metres per scaled unit along dp)
a_b   = a_rel / r_eff
```

`r_eff` is exactly 0.24 μ m for a horizontal approach and 0.60 μ m for a vertical one, and interpolates
correctly for any direction of `dp` (this is the code's answer to the spec's "document the approximation
for vertical approaches"). `cap(ê)` is the largest acceleration along `ê` inside the η thrust budget
(`maxAccelAlong`): solving `|c ê + g e_z| = F` for the larger root `c` gives

```
cap(ê) = −g ê_z + √(g² ê_z² − g² + F²)
```

which is 7.52 m/s² horizontally, 2.55 m/s² straight up and 22.17 m/s² straight down for the CF2.1 (tilt
ignored, see the Note in Section 7). In the pure double-integrator mode `cap = pureAccelLimit`.
Example: head-on at 3 m/s each, 2.5 m apart, pure mode: `a_rel = 0.8 × 15 = 12 m/s²`,
`a_b = 12 / 0.24 = 50 s⁻²`, `d = 10.42`, `d' = −6 / 0.24 = −25 s⁻¹`, so `h_b = 10.42 − 1 − 6.25 = 3.17`
(the 6.25 scaled units are the 1.5 m physical stopping distance `6² / (2 × 12)`). `α`: slider 1 to 15,
default 5.

### 9.5 Obstacle CBFs per primitive

Each obstacle adds one constraint per drone, only when the drone centre is within 1.5 m of the
primitive's surface (planes are always included). Every primitive is a core shape inflated by a radius
`R` (`geometry.ts`); the constraint uses the total radius `R_tot = R + r_d + margin` with `r_d = 0.05 m` and
the gate margin for gate parts, the obstacle margin otherwise (both 0.05 m by default). Arena planes
(floor, ceiling, the four nets) are part of the obstacle set.

`coreClosest(p, prim)` returns the closest point `q` on the core shape, `δ = p − q`, `ρ = |δ|` (signed for
planes and inside boxes), the outward unit normal `n`, the obstacle's velocity and acceleration, and
which relative-velocity components change the distance to first order (`free`):

| Primitive (core shape) | Closest feature | `free` model | Velocity component that changes the distance |
| --- | --- | --- | --- |
| Sphere (pendulum bob) | centre | `full` (point) | `w` |
| Capsule (gate edge, pole, leg, cable) | segment interior / endpoint | `line` with direction `e` / `full` | `w − (wᵀe) e` / `w` |
| Vertical cylinder (pillar), within its height | axis | `xy` | `(w_x, w_y, 0)` |
| Vertical cylinder, beyond an end cap | closest point of the cap disc, `R = 0` | `full` | `w` |
| Box (wall, slider panel), local frame by yaw | face / edge / corner | `face` / `line` / `full` | `(wᵀn) n` / perpendicular to the edge / `w` |
| Plane (net, floor, ceiling) | half-space `nᵀp ≥ d` | `plane` | `nᵀ v` |

Here `w = v − v_obs` and `w⊥` denotes the component in the last column. Moving obstacles: the pendulum
bob follows `θ(t) = θ_A sin(2π t / P + φ)`, with velocity and acceleration from the analytic derivatives
(tangential `L θ̇`, centripetal `L θ̇²`); its cable capsule is given half the bob's velocity and acceleration
(midpoint approximation). The sliding panel moves as `c(t) = c0 + A_s sin(2π t / P + φ) ê`. Both are
deterministic in the race clock.

**Exponential form, round shapes** (`ecbfObstacle`): the closest feature is treated as locally
extended (infinite line, axis or face), which makes these derivatives exact for that feature:

```
h  = ρ² − R_tot²
ḣ  = 2 δᵀ w
ḧ  = 2 |w⊥|² + 2 δᵀ (u − a_obs)
ḧ + 2λ ḣ + λ² h ≥ 0   ⇔   (2δ)ᵀ u ≥ 2 δᵀ a_obs − 2 |w⊥|² − 2λ ḣ − λ² h
```

For a vertical cylinder this is the spec's `h = |p_xy − c_xy|² − (r_o + r_d + margin)²`; for a capsule
`h = dist(p, segment)² − R_tot²` with the gradient along the closest-point direction; for a sphere
`h = |p − c(t)|² − R_tot²` with the obstacle's known velocity in `ḣ`.

**Exponential form, planes:** `h = nᵀp − d − R_tot`, `ḣ = nᵀ v`, `ḧ = nᵀ u`, so
`nᵀ u ≥ −2λ ḣ − λ² h`.

**Braking-aware form** (`brakingObstacle`), in metres: `dist = ρ − R_tot`, `d' = nᵀ w`, capability
`a_b = β · max(0.5, cap(n))` m/s². When approaching (`d' < 0`):

```
h_b = dist − d'² / (2 a_b) + τ_r d'
round shapes: d'' = (|w⊥|² − d'²) / ρ + nᵀ (u − a_obs),   constraint  c0 nᵀ u ≥ −d' − c0 (κ_o − nᵀ a_obs) − α h_b
planes:       d'' = nᵀ u,                                   constraint  c0 nᵀ u ≥ −d' − α h_b
c0 = τ_r − d' / a_b,   κ_o = (|w⊥|² − d'²) / ρ
```

When not approaching (`d' ≥ 0`), the same one-step look-ahead as for pairs:
`d' + Δt (κ_o − nᵀ a_obs + nᵀ u) ≥ −v_stop(dist)` (planes: `κ_o = 0`, `a_obs = 0`).

Obstacles have their own gain (`obstacleLambda`, `obstacleAlpha`). Drone–obstacle interventions are
logged separately from drone–drone ones (M26).

### 9.6 Responsibility

- **Equal** (default): all weights 1 in the QP below.
- **Weights**: `w_i` from the UI, floored at 0.05.
- **Follower only**: for each pair constraint, the leader (larger track progress; without a track, the
  drone further along the pair's mean velocity) keeps its nominal input, and the constraint becomes a
  single-drone constraint on the follower: if `i` leads, `(−a)ᵀ u_j ≥ b − aᵀ u_i⁰`; if `j` leads,
  `aᵀ u_i ≥ b + aᵀ u_j⁰`. This is the limit of an infinite weight on the leader.

### 9.7 Deadlock breaker

A perfectly symmetric head-on gives a symmetric minimum-norm correction along the line of centres, and
the drones can stall nose to nose. Following the perturbation idea of Wang, Ames & Egerstedt 2017,
for each pair constraint that the nominal inputs violate and whose horizontal separation is closing
(`dp_hᵀ dv_h < 0`), a horizontal bias perpendicular to the line of centres (right-hand rule) is added to
the inputs the QP starts from:

```
b = 1.0 m/s² · (dp_y, −dp_x, 0) / |dp_h|
u_i⁰ ← u_i⁰ + b,     u_j⁰ ← u_j⁰ − b
```

Corrections and interventions are still measured against the unbiased `u_nom`. The breaker is off in
the pure double-integrator mode.

### 9.8 Solving

The problem, for drones `i = 1 … N` and constraints `k`, is

```
minimise   Σ_i w_i |u_i − u_i⁰|²
subject to Σ_m g_{k,m}ᵀ u_m ≥ b_k          (pair rows: g_{k,i} = a, g_{k,j} = −a;  obstacle rows: g_{k,i} = a)
```

**Closed form, exactly one constraint** (`closedFormPair`, `closedFormSingle`). Pair: if
`aᵀ(u_i⁰ − u_j⁰) ≥ b` pass through; otherwise, from the KKT conditions
`2 w_i (u_i − u_i⁰) = μ a`, `2 w_j (u_j − u_j⁰) = −μ a` with the constraint active,

```
r = b − aᵀ(u_i⁰ − u_j⁰),     μ' = r / (|a|² (1/w_i + 1/w_j))
u_i = u_i⁰ + (μ'/w_i) a,     u_j = u_j⁰ − (μ'/w_j) a
equal weights:  c = r / (2 |a|²),  u_i = u_i⁰ + c a,  u_j = u_j⁰ − c a
```

Single drone: `u = u⁰ + ((b − aᵀu⁰) / |a|²) a` when violated. The closed form is used only when the
whole constraint set has one row (it is invalid with more).

**Hildreth's algorithm, more than one constraint** (`hildreth`, Hildreth 1957). With `δ = u − u⁰` the rows
become `G δ ≥ r`, `r_k = b_k − g_kᵀ u⁰`. The Lagrangian `Σ w_m |δ_m|² − λᵀ(G δ − r)` gives the stationarity
condition

```
δ_m = (1 / 2w_m) Σ_k λ_k g_{k,m}
```

and the dual problem

```
maximise  rᵀ λ − ½ λᵀ H λ     subject to λ ≥ 0,     H = ½ G W⁻¹ Gᵀ
```

Because `(H λ)_k = g_kᵀ δ(λ)`, exact maximisation along one coordinate with the bound gives the update

```
λ_k ← max(0, λ_k + (r_k − g_kᵀ δ) / H_kk),     H_kk = ½ Σ_m |g_{k,m}|² / w_m
δ_m ← δ_m + (Δλ_k / 2w_m) g_{k,m}             (for the drones in row k)
```

swept over all rows. Dual coordinate ascent on this strictly convex, separable problem converges to the
unique primal optimum. Stopping: `max_k |Δλ_k| √H_kk < 1e−6`, or 100 sweeps. Rows with `H_kk < 1e−14` are
skipped. A row is active when `λ_k > 1e−9`. The tests check that Hildreth equals the closed form for two
drones and satisfies all constraints for random N-drone cases.

### 9.9 Clipping with altitude priority

Each command the solver changed (`|u_safe − u_nom| > 1e−9`) is clipped to the feasible set
`|u + g e_z| ≤ F = η TWR g` and tilt `≤ θ_max` (`clipToFeasible`):

```
f_z = clamp(u_z + g, 0, F)                                       (vertical first: altitude priority)
f_h,max = min(√(F² − f_z²), f_z tan θ_max)
(u_x, u_y) ← (u_x, u_y) · min(1, f_h,max / |(u_x, u_y)|)
u_z = f_z − g
```

In pure mode the norm is clipped instead: `u ← u · min(1, pureAccelLimit / |u|)`. Clipping is recorded per
drone and per tick.

### 9.10 Bookkeeping and feasibility re-check

```
correction_i = |u_safe,i − u_nom,i|          (after clipping)
intervened_i ⇔ correction_i > 0.05 m/s²
```

`pairActive` / `obsActive` attribute an intervention to an active pair or obstacle row. After clipping,
every original constraint is re-evaluated; a residual `b − lhs > 1e−3 (1 + |b|)` marks it infeasible
(and, for pairs, feeds the supervisor). The per-pair barrier value (`h` or `h_b`) and the wall-clock solve
time (`performance.now()`) are logged each tick.

### 9.11 Latency compensation

When enabled, each drone's state is predicted (`sim.ts predict`) from its ground estimate, captured at
`t0 = t̂_capture`, to the time its new command takes effect, `t1 = t_now + τ_c`, using the commands already
sent. The acceleration acting at time `τ` is the intended acceleration of the last command sent at or
before `τ − τ_c` (zero-order hold; before any command, the initial acceleration). The interval
`[t0, t1]` is split at every switch time `t_send + τ_c` and propagated exactly per piece:

```
p ← p + v Δ + ½ u Δ²,     v ← v + u Δ
```

This compensates the sensing delay and sample age (`t_now − t0`) and the command delay together. The
intended acceleration is `u_safe` in normal mode, 0 in hover, and the brake feed-forward in emergency
(last 40 commands kept). The predicted state is used for the constraints, for `u_nom`, for initialising
the filtered reference, and by the supervisor's violation prediction and brake setpoint (the geofence
test uses the ground estimate). Without compensation the latest ground estimate is used throughout.

---

## 10 Supervisor

`supervisor.ts`, `sim.ts`. Modes per drone: `normal`, `hover`, `emergency`, `killed` (plus `crashed`).

- **Geofence.** If the ground estimate leaves `|x| ≤ sx/2 − 0.3`, `|y| ≤ sy/2 − 0.3`, `0.3 ≤ z ≤ sz − 0.3`,
  the drone switches to hover at the projection of its position onto that box (sticky). Scored as gate
  0.5 (Section 13).
- **Stale setpoint.** On an onboard tick, if no packet has arrived for more than 2 control periods (after
  the first `τ_c + 2T`), the drone hovers at its onboard estimate until the next packet arrives.
- **Emergency brake.** Triggered (a) for both drones of every pair the filter's re-check reports infeasible,
  once some pair has been infeasible for 3 consecutive control ticks (one-tick transients are absorbed by
  the margin), or (b) for both drones of a pair (both in normal mode) when a violation is predicted within
  0.1 s while the pair is currently outside (`s ≥ 1`, filter margin): a double-integrator rollout of the
  closing pair under `u_safe`, at 5 ms steps,

  ```
  dp(τ) = dp + dv τ + ½ Δu_safe τ²,    trigger if dp(τ)ᵀ D dp(τ) < 0.98²  for some τ ≤ 0.1 s
  ```

  (threshold 0.98 because a CBF legitimately rides `s = 1` and a constant-input extrapolation dips
  marginally under it). The brake setpoint is `p = p̂`, `v = v̂` and feed-forward
  `a = −a_brake v̂ / |v̂|` with `a_brake = 0.9 √((η TWR g)² − g²)` (90 % of the horizontal limit) and the
  vertical component capped at 3 m/s²; below 0.05 m/s the drone hovers where it stopped. Braking drones
  leave the filter. The trial ends 2.5 s later. Gate 0.5.
- **Kill** (key K): motors off for every drone (ballistic fall, Section 3.6); the trial ends 2 s later.
- **Vicon jump** over 10 cm: rejected, estimate held, event counted (Section 5).
- **Crash detection** (physics rate): drone–drone centre distance `< 0.10 m` (both crash); signed distance
  from the centre to any gate primitive's surface minus `r_d` below 0 (gate strike) or to any other
  obstacle (obstacle hit); `z < 0.025 m` (floor); outside the arena box (arena exit). A crash ends the
  trial 1.5 s later.

---

## 11 Gates, pass detection and the racing line

### 11.1 Gate geometry

`course.ts`. A gate is a regular octagon of tube segments (tube radius `r_t = 0.02 m`) in the plane
normal to its facing direction `n = (cos ψ cos ϑ, sin ψ cos ϑ, sin ϑ)` (yaw `ψ`, pitch `ϑ` for hanging
gates), with in-plane axes `l = (−sin ψ, cos ψ, 0)` and `u = (−sin ϑ cos ψ, −sin ϑ sin ψ, cos ϑ)`. For outer
diameter `D_g` (over the tube):

```
R_c    = D_g / 2 − r_t                (circumradius of the tube centreline)
r_in   = R_c cos(π/8)                 (inscribed radius)
r_clear = r_in − r_t                  (clear opening)
r_pass = max(0.01, r_clear − r_d)     (pass radius for the drone centre)
```

Vertices sit at angles `π/8 + kπ/4`. Default 0.8 m gate: `R_c = 0.380`, `r_in = 0.351`, `r_clear = 0.331`,
`r_pass = 0.281` m. A gate with clear inner diameter `d` needs `D_g = 2((d/2 + r_t) / cos(π/8) + r_t)`, which
is 0.408 m for the 0.30 m pinch ring. Collision primitives: eight capsules (`r_t`), plus for stands a pole
(radius 0.015 m) from below the bottom edge to the floor and four 0.3 m base legs, or for hanging gates
two cables (radius 0.004 m) from the top corners to the ceiling.

### 11.2 Pass detection

`gateCrossing(g, p0, p1, reverse)` on every physics step, with `σ = −1` for a visit against the normal:

```
s0 = σ nᵀ(p0 − c),  s1 = σ nᵀ(p1 − c)          no sign change → no crossing
x  = p0 + (p1 − p0) s0 / (s0 − s1) − c          (plane intersection point)
r  = √(|x|² − (nᵀx)²)                          (radial distance in the gate plane)
r > D_g/2 + 0.6           → ignored (far from the gate)
wrong direction, r < r_pass → miss (wrong way)
right direction, r < r_pass → pass;   r ≥ r_pass → miss (outside)
```

Only the next scheduled visit is tested; if instead the following visit's gate shows a clean pass, the
expected gate is counted as missed ("skipped") and the following one as passed. Visits never reached in
a completed run count as misses. Contact with the frame is a strike (Section 10).

### 11.3 Racing line

`racingLine.ts buildRacingLine`:

1. **Entry and exit.** For each visit, waypoints at `c − 0.4 n`, `c`, `c + 0.4 n` (visit-direction normal),
   so the drone passes straight through; course-defined via points follow. Closed courses start midway
   between the last exit and the first entry; open courses get a run-up point 1.2 m before the first
   entry (initial velocity `target speed` along it) and a stop point 1.2 m after the last exit.
2. **Minimum-jerk fit** (Section 6.5, `r = 3`) with durations `max(0.12 s, length / speed)`; if the
   100 Hz samples fail the feasibility check, all durations are stretched by 1.08 and the spline is
   re-fitted (open splines scale the start velocity accordingly).
3. **Checks** on the dense samples: (a) clearance to non-gate obstacles `< r_d + 0.12 = 0.17 m`; to gate
   primitives `< 0.16 m`, except frame edges while the sample is inside the gate's passage
   (`|nᵀ(p − c)| < 0.45 m` and radial `< r_in`), where `r_d + 0.03 = 0.08 m` suffices; (b) outside the arena
   minus 0.3 m; (c) **unscheduled crossings**: crossing any gate plane within `r_in + 0.1` of its centre
   when no scheduled pass of that gate in that direction is within 0.6 s of that time (the line would fly
   through a gate it should not).
4. **Detours by A\*.** Each offending sample is mapped to its spline segment. A 0.1 m voxel grid marks
   cells occupied by the arena margin (0.3 m), obstacles inflated by `clearance + 0.05` (gate parts by
   0.19 m), and the gate discs themselves (`|along| < 0.08 m`, radial `< r_in + 0.08`) so searches cannot
   shortcut through a gate. A 26-connected A\* (Hart, Nilsson & Raphael 1968) with step cost equal to the
   Euclidean step length and the Euclidean distance as an admissible, consistent heuristic finds a path
   between the segment's waypoints; line-of-sight pruning keeps only the corners, which are inserted as
   free waypoints (fallback: the segment midpoint raised 0.3 m). Re-fit and re-check, up to 6 rounds.
   Raw search paths are kept for the teaching view.

### 11.4 Track from the line

`trackFromLine` turns the line into a planner track (Section 12.1) with lateral half-width 0.5 m and
vertical half-height 0.3 m on open stretches, shrinking to `max(0.02, r_pass − 0.03)` within 0.6 m of a
gate centre (linear ramp between 0.6 and 1.2 m), and near non-gate obstacles to
`max(0.03, distance − r_d − 0.08)`. Offsets inside these limits keep candidates inside the gate openings.

---

## 12 Planner candidates and speed profile

**The planners are simplified stand-ins for the lab's game-theoretic solvers.** They work on a small
discretised strategy space so that the Nash versus Stackelberg difference is genuine and inspectable,
not to reproduce the lab's solvers.

### 12.1 Track and progress

`planners/track.ts`. The centreline is resampled uniformly in arc length (`ds ≈ 0.05 m`); per sample a
tangent `t̂` (central difference), a horizontal left normal `l = normalise(−t̂_y, t̂_x, 0)` and `u = t̂ × l`.
Progress of a drone: find the closest centreline sample in a ±1 m window around the previous match
(so self-crossing tracks are followed on the right branch), refine
`s = s_i + (p − q_i)ᵀ t̂_i`, and add laps: `progress = s + laps · L`, where a lap is added when `s` wraps from
above `0.75 L` to below `0.25 L` (and removed on the reverse wrap). A start just behind the start line
counts as negative progress.

### 12.2 Candidates

`planners/candidates.ts`. A candidate is a lateral (and, for ring circuits, vertical) offset profile
times a speed scale:

- `K = 4` control values per profile from `{−1, −0.5, 0, 0.5, 1}` (fractions of the local half-width
  `w(s)`; vertical values from `{−0.5, 0, 0, 0.5}` of `h(s)`), placed at the centres of `K` equal arc-length
  intervals and joined by cosine blends: with `x = (s / L) K − 0.5`, `i = ⌊x⌋`, `φ = x − i`,
  `value = c_i + (c_{i+1} − c_i)(½ − ½ cos πφ)` (periodic on closed tracks).
- Offset point: `p = τ(s) + l · (profile · w(s)) + u · (vprofile · h(s))`, blended from the drone's start
  lateral offset over `min(1.5 m, 0.3 L)` with the same cosine blend, then two passes of a
  `[¼, ½, ¼]` smoother. On closed tracks the profile is also blended, over the same length before the
  end, into the drone's start lane, so each drone finishes at rest on its own start slot (the finish is
  the last gate pass, which comes before this run-in).
- Speed levels `{0.8, 0.85, 0.9, 0.95, 1.0}`.
- The set of size `M` (default 30, maximum 80) always contains the centreline at full speed, then
  constant offsets (0, ∓0.5, ∓1) from the fastest level down (at most 15 structured members), then
  seeded random profiles, deduplicated.

### 12.3 Speed profile (forward and backward pass)

`speedProfile` on the uniformly resampled path (`ds = 0.05 m`):

```
κ_i = |p_{i+1} − 2 p_i + p_{i−1}| / ds²                     (discrete curvature)
a_max = √((η TWR g)² − g²)                                 (planningAccel, η-limited, tilt ignored)
v_max,i = min(v_cap, √(0.9 a_max / κ_i))                   (lateral limit with 10 % reserve)
a_lon(v, κ) = √(max(0.05 a_max², a_max² − (v² κ)²))        (friction circle, floor ≈ 0.22 a_max)
forward:   v_{i+1} ← min(v_{i+1}, √(v_i² + 2 a_lon(v_i, κ_i) ds))
backward:  v_{i−1} ← min(v_{i−1}, √(v_i² + 2 · 0.95 a_lon(v_i, κ_i) ds))   (5 % braking margin)
```

`v_cap` is the scenario's target speed. Candidates use the open form with `v_0 = v_cap` and end at rest
(open and closed tracks); the closed form wraps for 3 passes. The braking margin absorbs the ≈1 % overshoot
of the piecewise-constant deceleration at a full stop, which would otherwise time-scale the whole candidate.
Speeds are floored at 0.05 m/s and multiplied by the candidate's speed level.

**Time parametrisation** (`pathToTrajectory`): constant acceleration per path segment, so
`t_i = t_{i−1} + 2 ds / (v_i + v_{i−1})`. At 100 Hz, inside segment `j`: `a_T = (v_{j+1} − v_j) / (t_{j+1} − t_j)`,
arc `s = v_j τ + ½ a_T τ²`, speed `v_j + a_T τ`, velocity `speed · t̂`, and acceleration
`a = a_T t̂ + speed² dt̂/ds` with `dt̂/ds` from the neighbouring tangents. The acceleration is then smoothed
with a `[1, 2, 3, 2, 1]/9` kernel. Infeasible candidates are time-scaled down (×0.96 steps) until the
thrust/tilt check passes.

**Validity.** A candidate is discarded if it comes within `r_d + 0.06` of a static obstacle, leaves the
arena minus 0.35 m, misses a scheduled gate (pass detection of Section 11.2 on every second sample), or,
with dynamic obstacles on, comes within `r_d + 0.1` of a moving obstacle at the time it gets there. The
centreline is kept if nothing else survives.

### 12.4 Payoffs and solvers (summary)

`planners/rollout.ts`, `game.ts`, `plan.ts`. Horizon `T = 0.97 × (shortest valid candidate duration)`
(≥ 1 s). Rollouts sample the open-loop candidates every 0.05 s and track progress on the shared track.

```
gap     = s_1(T) − s_2(T)
risk    = Σ 0.05 s over samples with s_scaled < riskMargin      (riskMargin default 1.25; 1 is the strict definition)
payoff_1(i, j) =  gap − P · risk_1,     payoff_2(i, j) = −gap − P · risk_2,     P = 50 m/s
```

Shared responsibility charges both drones the whole risk; follower-only charges the drone with less
progress at each sample (half each when tied). Independent: each drone's fastest valid candidate. Nash:
all pure equilibria (both strategies best responses within 1e−9), tie-break by maximum total progress or
ego-favourable; with none, iterated best response from the independent pair (cap 50). Stackelberg:
`i* = argmax_i payoff_L(i, BR_F(i))`, follower ties broken in the leader's favour (strong Stackelberg).
`N > 2`: Nash by sequential best response over agents, Stackelberg as a priority chain. The chosen cell's
gap is the prediction used by M20.

---

## 13 Metrics and scorecard

`metrics/*.ts`. **Analysis window:** logged control ticks with `t ≤ raceEnd`, where `raceEnd` is the longest
scaled trajectory duration (`metrics/window.ts`). Logs are at the control rate and record the **true**
state; the tracking reference is the **nominal** one, not the filtered one. Tracking series for a drone
stop at the first tick it is killed or crashed. Counters marked "physics rate" are accumulated every
1 ms in `sim.ts`.

Common definitions: `e = p − p_ref`; when `|v_ref| > 0.05 m/s`, `t̂ = v_ref / |v_ref|`, `e_along = eᵀ t̂`,
`e_cross = e − e_along t̂`; otherwise `e_along = 0`, `e_cross = e`.

| ID | Metric | Formula as implemented | Unit | Code |
| --- | --- | --- | --- | --- |
| M1 | Tracking RMSE | `√(mean_k \|e_k\|²)` | m | `tracking.ts` |
| M2 | Max tracking error | `max_k \|e_k\|` | m | `tracking.ts` |
| M3 | Along-track RMS | `√(mean_k e_along,k²)` | m | `tracking.ts` |
| M4 | Cross-track RMS | `√(mean_k \|e_cross,k\|²)` | m | `tracking.ts` |
| M5 | Lap time | mean of times between start-plane crossings; the plane passes through the trajectory's first point with normal along the initial planned velocity; a crossing counts when going from the negative to the non-negative side within 0.3 m of that point, with `nᵀv > 0.5 \|v\|`, more than half a planned lap after the previous one (the first lap is timed from `t = 0`) | s | `sim.ts lapCheck` |
| M6 | Mean / peak speed | `mean_k \|v_k\|`, `max_k \|v_k\|` (true velocity) | m/s | `tracking.ts` |
| M7 | Latency | configured total `L`; measured mean `t_arrival − t_capture` over delivered packets (Section 2) | ms | `sim.ts` |
| M8 | Completion | ring course: 1 if finished, else `passes / (passes + misses + [crashed])`; periodic: `min(1, laps / planned laps)`; otherwise 1, or 0 if crashed | ratio | `tracking.ts` |
| M9 | Feasibility margin | share of planned 100 Hz samples failing the check of Section 7 | ratio | `feasibility.ts` |
| M10 | Collisions | drone–drone contacts (`d < 0.10 m`, once per contact) + gate strikes + obstacle hits, physics rate | count | `sim.ts` |
| M11 | Closest approach | `min s(t)` over pairs and physics ticks while a drone of the pair flies (unit margin) | scaled | `sim.ts` |
| M12 | Violation time | `Σ Δt` over physics ticks and pairs with `s < 1` in the race window, uncrashed drones (overlapping pairs add up) | s | `sim.ts` |
| M13 | Intervention rate | share of window ticks where any drone has `correction > 0.05 m/s²` (also per drone) | ratio | `safety.ts` |
| M14 | Intervention size | mean `correction` over intervened (drone, tick) samples | m/s² | `safety.ts` |
| M15 | Cost of safety | `M1(multi-drone) − M1(same trajectory flown alone)`, per drone; `costOfSafety(multi, solo)`; the solo trial is run by the app layer | m | `safety.ts` |
| M16 | Filter solve time | 99th percentile of non-zero per-tick solve times (linear interpolation at position `(n − 1) · 0.99` of the sorted list) | ms | `safety.ts`, `window.ts` |
| M17 | Planned safety | `min s` between planned trajectories sampled every 0.01 s of scaled time (unit margin) | scaled | `planned.ts` |
| M18 | Win rate | wins / races with a Wilson 95 % interval. Winner per race: on ring courses the first non-crashed finisher; otherwise the non-crashed drone with most progress; none if all crashed | ratio | `racing.ts`, `stats.ts` |
| M19 | Final progress gap | `s_0 − s_1` at the last finite progress inside the window | m | `racing.ts` |
| M20 | Prediction fidelity | per race: predicted winner = winner; ratio: realised gap at the planner's horizon `T` / predicted gap | ratio | `racing.ts`, `RaceTab.tsx` |
| M21 | Overtakes | sign changes of `s_0 − s_1`, with a ±0.05 m dead band (values inside the band keep the previous sign) | count | `racing.ts` |
| M22 | Control effort | `∫ \|f\| dt` at physics rate in the window, `f = a + g e_z` the realised thrust (after saturation and lag, no wind). Planned: trapezoid `∫ \|a_ref k² + g e_z\| dt` over scaled time | m/s | `sim.ts`, `planned.ts` |
| M23 | Gate pass rate | `Σ passes / Σ attempted`, `attempted = passes + misses + strikes` (+ unreached visits in a completed run) | ratio | `safety.ts courseMetrics` |
| M24 | Strikes, misses | counts (a strike is also a collision) | count | `safety.ts` |
| M25 | Obstacle clearance | `min (distanceToPrimitive(p) − r_d)` over physics ticks, flying drones, primitives within 1 m (gates included, planes excluded) | m | `sim.ts` |
| M26 | Obstacle interventions | share of window ticks with an intervention attributed to an obstacle row | ratio | `safety.ts` |
| M27 | Course time, path ratio | time of the final gate pass; flown path length in the window / racing-line length (× laps) | s, ratio | `safety.ts` |

**Note (M22):** the spec defines effort from `u_cmd + g e_z`; the code integrates the realised thrust, which
is what the motors produce after saturation and lag.

### 13.1 Scorecard

`metrics/scorecard.ts`, after the multiplicative gate times weighted average used by the nuPlan
closed-loop score and the CARLA driving score:

```
Score = G · (w_S S + w_V V + w_A A + w_E E) / (w_S + w_V + w_A + w_E)
```

**Gate `G`**, first match wins: 0 for a collision (including strikes and obstacle hits) or a collision end,
leaving the arena, a kill, or any missed gate on a ring course; 0.5 for an emergency brake; 0.5 for a
geofence hover (**Note:** an addition to the spec's list, since the supervisor took over); 0.75 for any
separation violation (`M12 > 0`) without contact; otherwise 1.

**Sub-scores** (V, A, E per drone, then averaged over drones):

```
S = 0.5 · [(1 − M13) + min(1, M11)]           (M11 = ∞ for one drone → 1)
A = max(0, 1 − M1 / 0.30)
E = min(1, planned effort / actual effort)
V = min(1, planned lap time / actual lap time)  if laps were timed, otherwise the fallback chain:
    ring course:  finished → min(1, planned duration / finish time), else passes / attempted
    track:        clamp(progress / planned line length (or track length), 0, 1)
    periodic, no lap completed: M8
    point-to-point: min(1, planned arrival / actual arrival), arrival = first time within 0.15 m of
                    the final reference point; never arrived → share of the distance covered
```

**Provisional live scoring.** During a run, `Simulation.liveLog()` fills the accumulators (effort, path
length, laps, gates; `attempted = passes + misses + strikes`, no unreached visits) from the running state,
shortens the window to `min(raceEnd, t)` and computes the planned effort only up to `t`. `V` is then a
schedule score from the latest tick: being `e_along` metres behind the reference at speed `|v_ref|` is a lag
of `max(0, −e_along) / |v_ref|` seconds, and

```
V_live = min(1, t / (t + lag))
```

The UI labels the result "Live scorecard (provisional)".

**Worked example** (spec Section 12, equal weights, `G = 1`; `src/tests/stats.test.ts`): Strategy 1 with
S 0.94, V 0.87, A 0.70, E 0.87 scores `(0.94 + 0.87 + 0.70 + 0.87) / 4 = 0.845 ≈ 0.85`; Strategy 2 with
S 0.83, V 0.95, A 0.62, E 0.83 scores `0.8075 ≈ 0.81`. A separation violation would multiply either by 0.75.

### 13.2 Ranking stability

`rankingStability`: rank the conditions by score under the reference weights (equal by default; ties by
index). Then sample 200 weight vectors from a flat Dirichlet, drawn as `w_k = −ln U_k` with seeded uniform
`U_k` (normalisation is unnecessary because the score is scale-invariant in the weights), and report the
share of samples for which the full ranking is unchanged.

### 13.3 Statistics

`metrics/stats.ts`.

- **Mean and bootstrap CI** (Efron 1979): `B = 1000` resamples with replacement (seeded), percentile
  interval at 2.5 % and 97.5 % with linear interpolation between order statistics.
- **Wilson score interval** (Wilson 1927), `z = 1.959964`, `p̂ = k/n`:

  ```
  centre = (p̂ + z²/2n) / (1 + z²/n)
  half   = z √(p̂(1 − p̂)/n + z²/4n²) / (1 + z²/n)
  [max(0, centre − half), min(1, centre + half)]
  ```

  7/10 → [0.397, 0.892]; 21/30 → [0.521, 0.833]; 35/50 → [0.562, 0.809].
- **Exact binomial test** (two-sided): `P(i) = C(n, i) p0ⁱ (1 − p0)ⁿ⁻ⁱ` (log-gamma by the Lanczos
  approximation); `p = Σ P(i)` over all `i` with `P(i) ≤ P(k)(1 + 1e−7)`. Example: 8/10 against 0.5 → 0.109.
- **Two-sample permutation test** on `|mean(a) − mean(b)|`: 5000 seeded random relabellings by partial
  Fisher–Yates shuffle, `p = (count(|diff*| ≥ |diff|) + 1) / (5000 + 1)`.
- **Holm correction** (Holm 1979): sort the `m` p-values ascending; the `r`-th smallest (0-based) gets
  `min(1, (m − r) p_(r))`, made monotone by a running maximum; results are returned in input order.

---

## 14 Pure double-integrator verification mode

`system.pureDoubleIntegrator`, used to reproduce the preliminary head-on table of the spec (Section 13).

### 14.1 What the mode changes

- Dynamics: no thrust cone, no lag, no wind; the commanded acceleration is applied directly, clipped to
  the norm `|u| ≤ pureAccelLimit` (7.5 m/s²).
- No onboard controller: on arrival, the setpoint's acceleration becomes the applied acceleration.
- Perfect, instantaneous sensing: the ground estimate is the true state every tick (`τ_s = 0`, no noise);
  all latency is command delay.
- Executor: `u_nom = a_ref` (the coast plan has `a_ref = 0`); the setpoint carries `u_safe`; no reference
  consistency.
- Filter: norm clipping instead of the thrust set; braking capability `pureAccelLimit` per drone; no
  deadlock breaker. Supervisor emergency brake, geofence and stale checks are off; the validator skips
  the arena and feasibility checks.
- Peak braking (reported with the table) is `max (−uᵀv / |v|)` while `|v| > 0.05 m/s` in the race window.

### 14.2 Two discretisations

**`exact`:** the physics loop integrates the zero-order hold exactly every 1 ms,
`p ← p + v Δt + ½ u Δt²`, `v ← v + u Δt`, and the delay is the configured total `τ`.

**`reference` (default for this mode):** the delay is floored to whole control periods and the state is
advanced once per control period by semi-implicit Euler, applied on the last physics tick of the period:

```
τ_c = ⌊τ / T⌋ · T                 (T = 20 ms: 0 ms → 0, 50 ms → 40 ms)
v_{k+1} = v_k + T u_{k−d}
p_{k+1} = p_k + T v_{k+1}  =  p_k + T v_k + T² u_{k−d}          (d = τ_c / T)
```

compared with the exact `p_{k+1} = p_k + T v_k + ½ T² u`. The code documents this as the discretisation of
the preliminary study (`types.ts pureDiscretization`, `sim.ts`), and the Section 13 values are reproduced
with it.

### 14.3 Why the reference discretisation reproduces the table, and why the exact one does not

Two effects make the reference model behave like a system with less latency:

1. **Delay rounding.** 50 ms becomes 40 ms, one control period less of closing before a correction acts.
2. **Semi-implicit Euler leads by half a step.** For a constant `u` applied from step 0, after `n` steps
   `p_n − p_0 − nT v_0 = T² u · n(n + 1)/2`, against `½ u (nT)²` exactly. The difference `½ T u · (nT)` equals
   the exact response to the same input applied `T/2` (10 ms) earlier: positions respond to a braking
   command half a period early.

Together the effective delay is about 20 ms shorter than in the exact model, so closest approaches are
larger and peak braking smaller. The qualitative conclusions are the same in both models. Values from the
current code (closest centre distance; peak braking in brackets):

| Case (50 Hz, limit 7.5 m/s², zero nominal input) | Spec value | `reference` | `exact` |
| --- | --- | --- | --- |
| ECBF λ = 4, 2 m/s each, gap 1.5 m, 0 ms | ≈ 0.224 m, unsafe | 0.224 m (4.82) | 0.207 m (4.82) |
| ECBF λ = 8, 3 m/s each, gap 2.5 m, 50 ms | ≈ 0.240 m, peak ≈ 7.1 | 0.240 m (7.05) | 0.240 m (7.50, saturated) |
| ECBF λ = 12, same case | ≈ 0.183 m, unsafe | 0.183 m (7.50) | 0.099 m (7.50): contact |
| Braking-aware α = 5 with delay prediction, same case | ≈ 0.241 m, peak ≈ 5.0 | 0.241 m (4.98) | 0.241 m (5.22) |
| 3 m/s each, gap 1.5 m, 50 ms (ECBF λ = 8; braking α = 5) | unsafe for every filter | 0.120 m; 0.120 m | 0.099 m; 0.099 m |

"Unsafe" means below 0.24 m, the horizontal ellipsoid radius (`s < 1` on a horizontal line). The last case
is physically impossible: closing at 6 m/s with `2 × 7.5 m/s²` of combined braking needs
`6² / (2 × 15) + 6 × 0.05 + 0.24 = 1.74 m` (braking, delay and ellipsoid), more than the 1.5 m gap. Note
also that in the reference mode positions change only once per control period, so closest approaches are
sampled at 50 Hz. Tests: `src/tests/headon.test.ts` (10 % tolerance).

### 14.4 Verification values at a glance

| Quantity (spec Section 13) | Implemented value | Section |
| --- | --- | --- |
| Usable thrust, horizontal limit, tilt (TWR 1.8, η 0.7) | 12.36 m/s², 7.52 m/s², 37.47° | 7 |
| Figure-8 peak acceleration | `(17/8) A ω²` (= 3.1875 ω² at A = 1.5 m) | 6.3 |
| `ω_max`, lap, mean, peak speed | 1.536 rad/s, 4.09 s, 2.24 m/s, 3.26 m/s | 7 |
| Baseline ω = 0.522 mean speed | 0.76 m/s | 7 |
| CBF worked example | D = diag(17.36, 17.36, 2.78), h = 3.34, ḣ = −34.7, a = (−17.36, 0, 0), b = 85.5, c = 0.142, u = ∓2.46 | 9.3 |
| Head-on table | see 14.3 | 14.3 |
| Wilson intervals | [0.40, 0.89], [0.52, 0.83], [0.56, 0.81] | 13.3 |
| Determinism | identical `hashTrialLog` for the same seed and config | 1 |

---

## 15 References

- A. D. Ames, S. Coogan, M. Egerstedt, G. Notomista, K. Sreenath, P. Tabuada, "Control Barrier Functions:
  Theory and Applications", European Control Conference, 2019. (CBF-QP, ASIF, exponential CBFs,
  actuation limits; Sections 9.1 to 9.8.)
- Q. Nguyen, K. Sreenath, "Exponential Control Barrier Functions for Enforcing High Relative-Degree
  Safety-Critical Constraints", American Control Conference, 2016. (Exponential CBF; Section 9.2.)
- L. Wang, A. D. Ames, M. Egerstedt, "Safety Barrier Certificates for Collisions-Free Multirobot Systems",
  IEEE Transactions on Robotics 33(3), 2017. (Pairwise barrier certificates, deadlock perturbation;
  Section 9.7.)
- C. Hildreth, "A Quadratic Programming Procedure", Naval Research Logistics Quarterly 4(1), 1957.
  (Dual coordinate ascent; Section 9.8.)
- W. Hönig, J. A. Preiss, T. K. S. Kumar, G. S. Sukhatme, N. Ayanian, "Trajectory Planning for Quadrotor
  Swarms", IEEE Transactions on Robotics 34(4), 2018. (Downwash ellipsoid; Section 9.1.)
- J. A. Preiss, W. Hönig, G. S. Sukhatme, N. Ayanian, "Crazyswarm: A Large Nano-Quadcopter Swarm", IEEE
  ICRA, 2017. (Testbed architecture, streamed full-state setpoints, onboard controller; Sections 2, 4.)
- D. Mellinger, V. Kumar, "Minimum Snap Trajectory Generation and Control for Quadrotors", IEEE ICRA, 2011.
  (Position control with feed-forward, attitude from the thrust vector, minimum-derivative splines;
  Sections 1, 4, 6.5.)
- R. Spica, E. Cristofalo, Z. Wang, E. Montijano, M. Schwager, "A Real-Time Game Theoretic Planner for
  Autonomous Two-Player Drone Racing", IEEE Transactions on Robotics 36(5), 2020. (Shared collision
  responsibility, Nash / Stackelberg racing; Section 12.)
- A. Liniger, J. Lygeros, "A Non-Cooperative Game Approach to Autonomous Racing", IEEE Transactions on
  Control Systems Technology 28(3), 2020. (Bimatrix racing games, follower-only responsibility;
  Section 12.)
- V. Pasumarti et al., "Agile Flight Emerges from Multi-Agent Competitive Racing", 2025. (Figure-8 and
  complex circuits used for courses C9 and C10.)
- H. Caesar et al., "nuPlan: A closed-loop ML-based planning benchmark for autonomous vehicles", 2021, and
  A. Dosovitskiy, G. Ros, F. Codevilla, A. López, V. Koltun, "CARLA: An Open Urban Driving Simulator",
  CoRL, 2017. (Multiplicative gate times weighted sub-scores; Section 13.1.)
- T. Flash, N. Hogan, "The coordination of arm movements: an experimentally confirmed mathematical
  model", Journal of Neuroscience 5(7), 1985. (10-15-6 minimum-jerk profile; Section 6.5.)
- P. E. Hart, N. J. Nilsson, B. Raphael, "A Formal Basis for the Heuristic Determination of Minimum Cost
  Paths", IEEE Transactions on Systems Science and Cybernetics 4(2), 1968. (A\*; Section 11.3.)
- G. E. Uhlenbeck, L. S. Ornstein, "On the Theory of the Brownian Motion", Physical Review 36, 1930.
  (Wind process; Section 3.4.)
- E. B. Wilson, "Probable Inference, the Law of Succession, and Statistical Inference", Journal of the
  American Statistical Association 22(158), 1927; B. Efron, "Bootstrap Methods: Another Look at the
  Jackknife", Annals of Statistics 7(1), 1979; S. Holm, "A Simple Sequentially Rejective Multiple Test
  Procedure", Scandinavian Journal of Statistics 6(2), 1979. (Section 13.3.)

---

*Honesty note.* Every model here is idealised: a point-mass quadrotor with a first-order attitude lag,
Gaussian sensing, and simplified planners. The numbers in this document and in the app illustrate the
behaviour of these models; they are not hardware results and should not be quoted as such.
