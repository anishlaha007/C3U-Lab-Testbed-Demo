/** Default configuration of a trial (every field documented in types.ts). */
import { DRONE_COLORS, ETA_DEFAULT, TAU_A_DEFAULT } from './constants';
import type { DroneConfig, SimConfig, SystemConfig } from './types';

export function defaultDrone(i: number): DroneConfig {
  return { preset: 'CF21', color: DRONE_COLORS[i % DRONE_COLORS.length], start: null };
}

export function defaultConfig(): SimConfig {
  return {
    arena: { sx: 8, sy: 5, sz: 3 },
    drones: [defaultDrone(0)],
    scenario: {
      preset: 'T1',
      type: 'figure8',
      A: 1.5,
      w: 0.522,
      z0: 1.0,
      phase: 0,
      laps: 2,
      radius: 1.2,
      ringInnerDiameter: 0.3,
      startOffset: 0,
      phaseOffset: Math.PI,
      headonSpeed: 2,
      headonGap: 2.5,
      headonCoast: false,
      targetSpeed: 2.0,
      timeScale: 1,
    },
    course: {
      courseId: 'none',
      dynamicObstacles: true,
      random: {
        seed: 7,
        difficulty: 3,
        gateCount: 6,
        spacing: 2.0,
        turnAngle: 70,
        heightVariation: 0.5,
        gateSize: 0.8,
        obstacleDensity: 0.3,
        dynamic: false,
      },
      pillarCount: 10,
      custom: null,
    },
    planner: {
      solver: 'nash',
      leader: 0,
      tieBreak: 'maxTotal',
      M: 30,
      responsibility: 'shared',
      penalty: 50,
      replan: false,
      replanDt: 0.5,
      swapStarts: false,
    },
    system: {
      totalLatency: 0.025,
      latencySplit: 0.4,
      advancedLatency: false,
      tauS: 0.01,
      tauC: 0.015,
      fVicon: 200,
      fCtrl: 50,
      fOnboard: 100,
      viconNoise: 0.0005,
      windSigma: 0,
      windTau: 1.0,
      batterySag: 0,
      controller: 'mellinger',
      mode: 'streamed',
      eta: ETA_DEFAULT,
      thetaMaxDeg: 60,
      tauA: TAU_A_DEFAULT,
      markerSwap: false,
      packetLoss: 0,
      pureDoubleIntegrator: false,
      pureAccelLimit: 7.5,
      pureDiscretization: 'reference',
    },
    filter: {
      enabled: true,
      type: 'ecbf',
      lambda: 8,
      alpha: 5,
      marginMultiplier: 1,
      latencyCompensation: true,
      responsibility: 'equal',
      weights: [1, 1, 1, 1, 1, 1],
      brakingFraction: 0.8,
      obstacles: true,
      obstacleMargin: 0.05,
      obstacleLambda: 8,
      obstacleAlpha: 5,
      gateMargin: 0.05,
      emergencyBrake: true,
      deadlockBreaker: true,
      geofence: true,
    },
    seed: 1,
    extraTime: 1.0,
    flyAnyway: false,
  };
}

/** Sensing and command delays (s) from the system configuration. */
export function latencies(sys: SystemConfig): { tauS: number; tauC: number } {
  if (sys.advancedLatency) return { tauS: Math.max(0, sys.tauS), tauC: Math.max(0, sys.tauC) };
  return { tauS: sys.totalLatency * sys.latencySplit, tauC: sys.totalLatency * (1 - sys.latencySplit) };
}

/** Pad or trim drone configs to n. */
export function dronesFor(cfg: SimConfig, n: number): DroneConfig[] {
  const out = cfg.drones.slice(0, n);
  while (out.length < n) out.push(defaultDrone(out.length));
  return out;
}

/** Deep clone of a config (plain JSON data). */
export function cloneConfig(c: SimConfig): SimConfig {
  return JSON.parse(JSON.stringify(c)) as SimConfig;
}
