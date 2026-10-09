/**
 * Shared types of the simulation core. Pure data, no behaviour.
 */
import type { DronePresetId } from './constants';
import type { Vec3 } from './vec';

export type { Vec3 } from './vec';

// ---------------------------------------------------------------------------------------------
// Trajectories
// ---------------------------------------------------------------------------------------------

/** Metadata columns of the lab's trajectory file standard (Section 5.1). */
export interface TrajectoryMeta {
  run_id: string;
  drone_id: number;
  strategy: string;
  solver: string;
  dynamics_model: string;
  d_min_assumed: number;
  track_id: string;
  sample_period: number;
  created: string;
}

/**
 * A trajectory sampled at a fixed period (100 Hz by default): t, x, y, z, vx, vy, vz, ax, ay, az, yaw.
 * Typed arrays so trajectories can be transferred to and from workers cheaply.
 */
export interface Trajectory {
  meta: TrajectoryMeta;
  t: Float64Array;
  x: Float64Array;
  y: Float64Array;
  z: Float64Array;
  vx: Float64Array;
  vy: Float64Array;
  vz: Float64Array;
  ax: Float64Array;
  ay: Float64Array;
  az: Float64Array;
  yaw: Float64Array;
  /** Planned lap period at time scale 1 (s), if the trajectory is periodic. */
  lapPeriod?: number;
  /** Number of laps contained in the trajectory. */
  laps?: number;
}

/** Full-state setpoint streamed to a drone (position, velocity, acceleration, yaw). */
export interface Setpoint {
  p: Vec3;
  v: Vec3;
  a: Vec3;
  yaw: number;
}

// ---------------------------------------------------------------------------------------------
// Courses, gates and obstacles (Section 5.2b)
// ---------------------------------------------------------------------------------------------

export interface Gate {
  id: string;
  /** Centre of the octagon (m). */
  center: Vec3;
  /** Facing direction (rad): the pass direction is the gate normal (cos yaw, sin yaw, 0) rotated by pitch. */
  yaw: number;
  /** Tilt (rad) about the gate's horizontal axis; only for hanging gates (up to 45 deg). */
  pitch: number;
  /** Outer diameter of the octagon (m), 0.45 to 1.2 typical. */
  diameter: number;
  color: string;
  mount: 'stand' | 'hanging';
}

export interface GateVisit {
  gate: number;
  /** Pass the gate against its normal. */
  reverse?: boolean;
}

export type Obstacle =
  | { kind: 'pillar'; id: string; x: number; y: number; radius: number; height: number }
  | { kind: 'box'; id: string; center: Vec3; size: Vec3; yaw: number; label?: 'box' | 'wall' | 'banner' }
  | {
      kind: 'pendulum';
      id: string;
      pivot: Vec3;
      length: number;
      bobRadius: number;
      /** Swing amplitude (rad). */
      amplitude: number;
      period: number;
      phase: number;
      /** Direction of the swing plane (rad about z). */
      swingYaw: number;
    }
  | {
      kind: 'slider';
      id: string;
      center: Vec3;
      size: Vec3;
      yaw: number;
      /** Travel half-amplitude along the panel's local x axis (m). */
      travel: number;
      period: number;
      phase: number;
    };

export type CourseId = 'C1' | 'C2' | 'C3' | 'C4' | 'C5' | 'C6' | 'C7' | 'C8' | 'C9' | 'C10' | 'C11' | 'C12' | 'none';

export interface Course {
  id: CourseId | string;
  name: string;
  difficulty: number;
  description: string;
  gates: Gate[];
  obstacles: Obstacle[];
  sequence: GateVisit[];
  /** Closed circuit (the racing line loops). */
  closed: boolean;
  laps: number;
  /** Recommended arena size (m). */
  arena: { sx: number; sy: number; sz: number };
  /** Target speed used for time allocation (m/s). */
  targetSpeed: number;
}

// ---------------------------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------------------------

export interface ArenaConfig {
  sx: number;
  sy: number;
  sz: number;
}

export interface DroneConfig {
  preset: DronePresetId;
  color: string;
  /** Manual start position; null = automatic (trajectory start). */
  start: Vec3 | null;
}

export type TrajectoryType =
  | 'figure8'
  | 'circle'
  | 'splitS'
  | 'pinch'
  | 'intersection'
  | 'headon'
  | 'antipodal'
  | 'random'
  | 'raceTrack'
  | 'ringCircuit'
  | 'imported';

export interface ScenarioParams {
  preset: string;
  type: TrajectoryType;
  /** Figure-8 amplitude A (m). */
  A: number;
  /** Angular rate w (rad/s) for figure-8 and circle. */
  w: number;
  /** Flight height (m). */
  z0: number;
  /** Phase offset applied to drone 1's figure-8 / circle (rad). */
  phase: number;
  laps: number;
  radius: number;
  /** Pinch ring inner diameter (m). */
  ringInnerDiameter: number;
  /** Pinch start offset (m, longitudinal stagger of drone 1). */
  startOffset: number;
  /** Intersection phase offset between the two drones (rad). */
  phaseOffset: number;
  /** Head-on closing speed of each drone (m/s). */
  headonSpeed: number;
  /** Head-on start gap (m). */
  headonGap: number;
  /** Head-on preliminary-study variant: coast with zero planned acceleration (pure DI tests). */
  headonCoast: boolean;
  /** Target speed for spline-based trajectories (m/s). */
  targetSpeed: number;
  /** Speed multiplier k: t -> t / k. */
  timeScale: number;
}

export interface CourseParams {
  courseId: CourseId;
  dynamicObstacles: boolean;
  /** Random course generator (C11). */
  random: {
    seed: number;
    difficulty: number;
    gateCount: number;
    spacing: number;
    turnAngle: number;
    heightVariation: number;
    gateSize: number;
    obstacleDensity: number;
    dynamic: boolean;
  };
  /** Forest pillar count (C6). */
  pillarCount: number;
  /** User-built course (C12). */
  custom: Course | null;
}

export type ControllerType = 'mellinger' | 'pid';

export interface SystemConfig {
  /** Total latency (s), split into sensing and command delay. */
  totalLatency: number;
  /** Share of the total latency attributed to sensing (default 0.4). */
  latencySplit: number;
  /** Advanced: override the split with explicit tau_s / tau_c. */
  advancedLatency: boolean;
  tauS: number;
  tauC: number;
  fVicon: number;
  fCtrl: 50 | 100;
  fOnboard: number;
  /** Vicon position noise sigma (m). */
  viconNoise: number;
  /** Wind (OU acceleration) sigma (m/s^2). */
  windSigma: number;
  windTau: number;
  /** Thrust-to-weight loss over a 7-minute flight (fraction). */
  batterySag: number;
  controller: ControllerType;
  mode: 'streamed' | 'uploaded';
  eta: number;
  thetaMaxDeg: number;
  tauA: number;
  markerSwap: boolean;
  /** Probability that a streamed setpoint packet is lost. */
  packetLoss: number;
  /** Test mode: acceleration lag off, onboard controller bypassed, pure command delay. */
  pureDoubleIntegrator: boolean;
  /** Acceleration limit used in pure double-integrator mode (m/s^2). */
  pureAccelLimit: number;
  /**
   * Discretisation of the pure double-integrator mode: 'reference' reproduces the preliminary
   * study (semi-implicit Euler at the control period, delay rounded down to whole control
   * periods); 'exact' integrates the zero-order hold exactly at 1 ms with the exact delay.
   */
  pureDiscretization: 'reference' | 'exact';
}

export type FilterType = 'ecbf' | 'braking';
export type Responsibility = 'equal' | 'follower' | 'weights';

export interface FilterConfig {
  enabled: boolean;
  type: FilterType;
  lambda: number;
  alpha: number;
  marginMultiplier: number;
  latencyCompensation: boolean;
  responsibility: Responsibility;
  weights: number[];
  /** Fraction of the horizontal limit each drone is assumed to brake at (braking-aware CBF). */
  brakingFraction: number;
  obstacles: boolean;
  obstacleMargin: number;
  obstacleLambda: number;
  obstacleAlpha: number;
  /** Extra margin around gate frame edges (m) on top of the obstacle margin. */
  gateMargin: number;
  /** Supervisor emergency brake on infeasible / imminent violation. */
  emergencyBrake: boolean;
  /**
   * Symmetric-deadlock breaker: for closing pairs in conflict, bias the nominal inputs by a small
   * right-hand-rule term so that one drone yields (after Wang, Ames, Egerstedt 2017).
   */
  deadlockBreaker: boolean;
  /** Supervisor geofence hover. */
  geofence: boolean;
}

export type SolverType = 'independent' | 'nash' | 'stackelberg';

export interface PlannerConfig {
  solver: SolverType;
  leader: number;
  tieBreak: 'maxTotal' | 'ego';
  M: number;
  responsibility: 'shared' | 'follower';
  penalty: number;
  replan: boolean;
  replanDt: number;
}

export interface SimConfig {
  arena: ArenaConfig;
  drones: DroneConfig[];
  scenario: ScenarioParams;
  course: CourseParams;
  planner: PlannerConfig;
  system: SystemConfig;
  filter: FilterConfig;
  seed: number;
  /** Seconds simulated after the last trajectory ends (settling). */
  extraTime: number;
  /** Allow running even if the validator's feasibility check fails. */
  flyAnyway: boolean;
}

// ---------------------------------------------------------------------------------------------
// Logs and events
// ---------------------------------------------------------------------------------------------

export type SimEventType =
  | 'intervention'
  | 'violation'
  | 'overtake'
  | 'emergency'
  | 'collision'
  | 'gatePass'
  | 'gateMiss'
  | 'gateStrike'
  | 'obstacleHit'
  | 'geofence'
  | 'arenaExit'
  | 'stale'
  | 'viconJump'
  | 'markerSwap'
  | 'kill'
  | 'lap'
  | 'ecbfInitWarning'
  | 'finish'
  | 'end';

export interface SimEvent {
  t: number;
  type: SimEventType;
  drone?: number;
  other?: number;
  gate?: number;
  detail?: string;
}

/** Per-drone time series, logged at the ground control rate. */
export interface DroneLog {
  px: number[];
  py: number[];
  pz: number[];
  vx: number[];
  vy: number[];
  vz: number[];
  /** Nominal reference (the planned trajectory at the race clock). */
  rx: number[];
  ry: number[];
  rz: number[];
  rvx: number[];
  rvy: number[];
  rvz: number[];
  /** Reference actually sent (filtered / blended). */
  fx: number[];
  fy: number[];
  fz: number[];
  /** Nominal and safe accelerations of the filter. */
  unx: number[];
  uny: number[];
  unz: number[];
  usx: number[];
  usy: number[];
  usz: number[];
  /** Specific thrust vector produced (m/s^2), drives tilt and effort. */
  thx: number[];
  thy: number[];
  thz: number[];
  /** 1 if the filter changed u by more than the threshold (any constraint). */
  intervened: number[];
  /** 1 if a drone-obstacle constraint was active. */
  obsIntervened: number[];
  /** 1 if a drone-drone constraint was active. */
  pairIntervened: number[];
  /** Correction norm |u_safe - u_nom|. */
  correction: number[];
  /** Progress along the track (m), NaN if no track. */
  progress: number[];
  /** Thrust-to-weight ratio left (battery sag). */
  twr: number[];
  /** Supervisor mode code: 0 normal, 1 hover, 2 emergency, 3 killed, 4 crashed. */
  mode: number[];
}

export interface PairLog {
  i: number;
  j: number;
  /** Scaled separation s = sqrt(dp^T D dp). */
  s: number[];
  /** Euclidean centre distance. */
  d: number[];
  /** Barrier value used by the filter (h for ECBF or h_b for braking-aware). */
  h: number[];
}

export interface GateStats {
  passes: number;
  misses: number;
  strikes: number;
  attempted: number;
  /** Time of the last clean pass of the final gate (course completion), NaN if not completed. */
  finishTime: number;
  /** Gate passes (sequence index, time). */
  passTimes: { k: number; t: number }[];
}

export interface TrialSummary {
  endReason: 'completed' | 'collision' | 'kill' | 'emergency' | 'arenaExit' | 'timeout' | 'invalid';
  endTime: number;
  /** Race-window end (trajectory end), s. */
  raceEnd: number;
  /** Minimum Euclidean centre distance over all pairs (physics rate). */
  minCentreDistance: number;
  /** Minimum scaled separation over all pairs (physics rate, unit margin). */
  minScaledSeparation: number;
  /** Total time with s < 1 (physics rate). */
  violationTime: number;
  collisions: number;
  emergencies: number;
  geofenceEvents: number;
  arenaExits: number;
  staleEvents: number;
  viconJumps: number;
  killed: boolean;
  /** Peak braking acceleration per drone (max |u| along -v), pure DI tests. */
  peakBraking: number[];
  /** Minimum drone-surface to obstacle-surface distance (m), Infinity if no obstacles. */
  obstacleClearance: number;
  gates: GateStats[];
  /** Measured Vicon-capture-to-command-arrival latency (s), mean. */
  measuredLatency: number;
  /** Laps completed per drone (start-plane crossings). */
  lapTimes: number[][];
  lapsCompleted: number[];
  /** Flown path length per drone in the analysis window (m). */
  pathLength: number[];
  /** Control effort integral of |f| dt per drone (m/s). */
  effort: number[];
  ecbfInitWarnings: number;
  /** Filter clipped commands (ticks). */
  clippedTicks: number;
  /** Number of control ticks in the analysis window. */
  ctrlTicks: number;
}

export interface PlannedInfo {
  /** Planned lap time per drone (s) (scaled), NaN if not periodic. */
  lapTime: number[];
  /** Laps contained in each planned trajectory (0 if not periodic). */
  laps: number[];
  /** Planned arrival time at the final point per drone (s, scaled). */
  arrival: number[];
  /** Planned effort per drone (integral |a_ref + g e_z| dt) (m/s). */
  effort: number[];
  /** Share of planned samples failing the thrust/tilt check (M9). */
  feasibilityFail: number[];
  /** Minimum planned scaled separation (M17). */
  minPlannedSeparation: number;
  /** Planned duration (s). */
  duration: number;
  /** Racing-line length (m) for path ratio (M27). */
  lineLength: number;
  /** Prediction from the planner (M20). */
  predictedGap?: number;
  predictedWinner?: number;
}

export interface TrialLog {
  seed: number;
  configHash: string;
  nDrones: number;
  dtLog: number;
  t: number[];
  drones: DroneLog[];
  pairs: PairLog[];
  /** Filter solve time per tick (ms); excluded from the determinism hash. */
  solveMs: number[];
  clipped: number[];
  events: SimEvent[];
  summary: TrialSummary;
  planned: PlannedInfo;
  /** Track length (m) if a track is defined. */
  trackLength: number;
}
