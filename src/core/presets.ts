/**
 * Scenario presets T1-T14 (Section 11): each preset configures a full SimConfig.
 */
import { DRONE_COLORS } from './constants';
import { cloneConfig, defaultConfig, defaultDrone } from './defaults';
import type { CourseId, SimConfig } from './types';

export interface ScenarioPreset {
  id: string;
  name: string;
  setup: string;
  expect: string;
  apply: (c: SimConfig) => void;
}

function drones(c: SimConfig, n: number): void {
  c.drones = Array.from({ length: n }, (_, i) => ({ ...defaultDrone(i), preset: c.drones[i]?.preset ?? 'CF21', color: DRONE_COLORS[i % DRONE_COLORS.length] }));
}

function course(c: SimConfig, id: CourseId, n: number): void {
  drones(c, n);
  c.scenario.type = 'ringCircuit';
  c.course.courseId = id;
  c.scenario.timeScale = 1;
}

export const SCENARIO_PRESETS: ScenarioPreset[] = [
  {
    id: 'T1',
    name: 'T1 Baseline figure-8',
    setup: '1 drone, A = 1.5 m, w = 0.52 rad/s (12.0 s lap, 0.76 m/s mean)',
    expect: 'Tracking error of about 2 cm or less (Crazyswarm’s published baseline was under 2 cm).',
    apply: (c) => {
      drones(c, 1);
      c.scenario.type = 'figure8';
      c.scenario.A = 1.5;
      c.scenario.w = 0.522;
      c.scenario.laps = 2;
    },
  },
  {
    id: 'T2',
    name: 'T2 Aggressive figure-8',
    setup: '1 drone, w = 1.54 rad/s (thrust limit for CF2.1 at eta 0.7)',
    expect: 'Error grows, cross-track dominates in the tight lobes; red segments if pushed past the limit.',
    apply: (c) => {
      drones(c, 1);
      c.scenario.type = 'figure8';
      c.scenario.A = 1.5;
      c.scenario.w = 1.54;
      c.scenario.laps = 3;
      c.flyAnyway = true;
    },
  },
  {
    id: 'T3',
    name: 'T3 Split-S dive',
    setup: '1 drone through two stacked rings (centres at 0.6 m and 1.6 m)',
    expect: 'Thrust and tilt limits in the vertical plane.',
    apply: (c) => {
      drones(c, 1);
      c.scenario.type = 'splitS';
      c.scenario.targetSpeed = 1.6;
      c.scenario.laps = 2;
      c.flyAnyway = true;
    },
  },
  {
    id: 'T4',
    name: 'T4 Pinch',
    setup: '2 drones, approach lanes 0.6 m apart converging on a 0.30 m ring 2.5 m ahead',
    expect: 'Who goes first; Nash and Stackelberg differ; the filter resolves conflicts.',
    apply: (c) => {
      drones(c, 2);
      c.scenario.type = 'pinch';
      c.scenario.ringInnerDiameter = 0.3;
      c.scenario.startOffset = 0;
      c.scenario.targetSpeed = 1.6;
      c.planner.solver = 'nash';
    },
  },
  {
    id: 'T5',
    name: 'T5 Intersection',
    setup: '2 drones on one figure-8, phase offset pi (both reach the centre together twice per lap)',
    expect: 'Repeated conflicts at the centre; interventions every half lap.',
    apply: (c) => {
      drones(c, 2);
      c.scenario.type = 'intersection';
      c.scenario.w = 0.78;
      c.scenario.phaseOffset = Math.PI;
      c.scenario.laps = 2;
    },
  },
  {
    id: 'T6',
    name: 'T6 Head-on',
    setup: '2 drones closing at 2 m/s each from a 2.5 m gap, 25 ms latency',
    expect: 'Reproduces the preliminary results table (use the pure double-integrator mode for the exact numbers).',
    apply: (c) => {
      drones(c, 2);
      c.scenario.type = 'headon';
      c.scenario.headonSpeed = 2;
      c.scenario.headonGap = 2.5;
    },
  },
  {
    id: 'T7',
    name: 'T7 Antipodal swap',
    setup: '4 drones (2 to 6) on a 1.5 m circle, each flying to the opposite point',
    expect: 'N-drone QP filter; everyone gets through without collision.',
    apply: (c) => {
      drones(c, 4);
      c.scenario.type = 'antipodal';
      c.scenario.targetSpeed = 1.5;
    },
  },
  {
    id: 'T8',
    name: 'T8 Random crossing stress',
    setup: '4 drones (2 to 6), seeded random waypoints through the centre region',
    expect: 'Intervention rate and safety vs drone count.',
    apply: (c) => {
      drones(c, 4);
      c.scenario.type = 'random';
      c.scenario.targetSpeed = 1.4;
    },
  },
  {
    id: 'T9',
    name: 'T9 Race loop',
    setup: '2 drones on the 6 m x 3 m oval with 4 gates (one is the narrow pinch ring)',
    expect: 'Milestone 3 racing with all planner conditions.',
    apply: (c) => {
      drones(c, 2);
      c.scenario.type = 'raceTrack';
      c.scenario.laps = 1;
      c.planner.solver = 'nash';
    },
  },
  {
    id: 'T10',
    name: 'T10 Latency stress',
    setup: 'Head-on at 3 m/s, 80 ms total latency, latency compensation off (toggle it on to compare)',
    expect: 'The filter fails without compensation at high latency and holds with it (within physics limits).',
    apply: (c) => {
      drones(c, 2);
      c.scenario.type = 'headon';
      c.scenario.headonSpeed = 3;
      c.scenario.headonGap = 2.5;
      c.system.totalLatency = 0.08;
      c.filter.latencyCompensation = false;
      c.filter.type = 'ecbf';
      c.filter.lambda = 12;
      c.filter.deadlockBreaker = false;
    },
  },
  {
    id: 'T11',
    name: 'T11 Filter off',
    setup: 'T5 intersection with the safety filter disabled',
    expect: 'Collisions, gate factor G = 0: the case for the filter.',
    apply: (c) => {
      drones(c, 2);
      c.scenario.type = 'intersection';
      c.scenario.w = 0.78;
      c.scenario.phaseOffset = Math.PI;
      c.scenario.laps = 2;
      c.filter.enabled = false;
    },
  },
  {
    id: 'T12',
    name: 'T12 Ring course (C9 figure-8 circuit)',
    setup: '1 or 2 drones on any ring course C1 to C12, any planner, filter on or off',
    expect: 'Gate passes and strikes, obstacle avoidance, racing through hard layouts.',
    apply: (c) => {
      course(c, 'C9', 2);
      c.planner.solver = 'nash';
    },
  },
  {
    id: 'T13',
    name: 'T13 Obstacle forest',
    setup: 'C6 Forest with 2 drones, pillar density slider, filter on or off',
    expect: 'Drone-obstacle vs drone-drone interventions; collisions without the filter.',
    apply: (c) => {
      course(c, 'C6', 2);
      c.course.pillarCount = 10;
    },
  },
  {
    id: 'T14',
    name: 'T14 Gauntlet timing',
    setup: 'C7 with a swinging pendulum and a sliding panel, latency slider',
    expect: 'Whether the filter keeps up with moving obstacles at higher delay.',
    apply: (c) => {
      course(c, 'C7', 1);
      c.course.dynamicObstacles = true;
    },
  },
];

export function presetById(id: string): ScenarioPreset | undefined {
  return SCENARIO_PRESETS.find((p) => p.id === id);
}

/** Fresh config for a preset (from defaults, keeping the seed). */
export function presetConfig(id: string, seed = 1): SimConfig {
  const c = cloneConfig(defaultConfig());
  c.seed = seed;
  const p = presetById(id);
  if (p) {
    p.apply(c);
    c.scenario.preset = id;
  }
  return c;
}
