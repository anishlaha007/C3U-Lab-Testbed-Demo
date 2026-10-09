/**
 * Phase-1 engine: one drone kinematically following the T1 figure-8. Replaced by the full
 * multi-rate simulation in phase 2.
 */
import { G } from '../core/constants';
import { figure8 } from '../core/trajectories/figure8';
import { sampleTrajectory } from '../core/trajectories/common';
import type { SceneView } from './view';

class KinematicEngine {
  t = 0;
  playing = true;
  simSpeed = 1;
  traj = figure8({ A: 1.5, w: 0.522, z0: 1.0, laps: 100 });
  trail: { x: number; y: number; z: number }[] = [];

  advance(dtWall: number) {
    if (!this.playing) return;
    this.t += dtWall * this.simSpeed;
  }

  view(): SceneView {
    const sp = sampleTrajectory(this.traj, this.t);
    const f = { x: sp.a.x, y: sp.a.y, z: sp.a.z + G };
    return {
      t: this.t,
      tRace: this.t,
      drones: [
        {
          p: sp.p,
          v: sp.v,
          f,
          yaw: sp.yaw,
          thrust01: Math.hypot(f.x, f.y, f.z) / (1.8 * G),
          color: '#38bdf8',
          ref: sp.p,
          refFiltered: null,
          correction: { x: 0, y: 0, z: 0 },
          intervened: false,
          nearestS: Infinity,
          mode: 0,
          tumble: null,
          nextGate: -1,
          twr01: 1,
          speed: Math.hypot(sp.v.x, sp.v.y, sp.v.z),
        },
      ],
    };
  }

  trailPoints(_i: number, seconds: number): { x: number; y: number; z: number; speed: number }[] {
    const out = [];
    const n = 90;
    for (let k = n; k >= 0; k--) {
      const tt = this.t - (k / n) * seconds;
      if (tt < 0) continue;
      const sp = sampleTrajectory(this.traj, tt);
      out.push({ ...sp.p, speed: Math.hypot(sp.v.x, sp.v.y, sp.v.z) });
    }
    return out;
  }
}

export const engine = new KinematicEngine();
