/**
 * Executor (Section 6): samples the drone's trajectory on the shared race clock and keeps the
 * streamed reference consistent with the safety filter.
 *
 * Reference modes per drone:
 *  - nominal:   send the planned setpoint (p_nom, v_nom, a_nom).
 *  - filtered:  the filter changed the command. The executor integrates the safe feed-forward
 *               acceleration (a_nom + correction) into its own reference (p_f, v_f), so the
 *               onboard position loop does not fight the filter, and sends the feed-forward that
 *               makes the onboard law produce exactly u_safe.
 *  - blending:  the filter has been idle for 0.3 s; the offset to the nominal reference decays
 *               with a first-order time constant of 0.5 s (kinematically consistent setpoint),
 *               then the mode returns to nominal.
 */
import { feedbackTerm, onboardLaw } from './onboard';
import { sampleScaled } from './trajectories/common';
import type { ControllerType, Setpoint, Trajectory } from './types';
import { v3, type Vec3 } from './vec';

export const IDLE_BEFORE_BLEND = 0.3;
export const BLEND_TAU = 0.5;

export type RefMode = 'nominal' | 'filtered' | 'blending';

export class Executor {
  mode: RefMode = 'nominal';
  /** Filtered reference state. */
  pf: Vec3 = v3();
  vf: Vec3 = v3();
  /** Blend offset (reference - nominal). */
  dp: Vec3 = v3();
  idle = 0;
  /** Last setpoint sent. */
  last: Setpoint | null = null;

  constructor(
    readonly traj: Trajectory,
    readonly k: number,
    readonly controller: ControllerType,
    /** Pure double-integrator mode: u_nom is the planned acceleration only. */
    readonly pure = false,
  ) {}

  nominal(tRace: number): Setpoint {
    return sampleScaled(this.traj, tRace, this.k);
  }

  /** Reference that would be sent this tick without a new intervention. */
  candidate(tRace: number): Setpoint {
    const nom = this.nominal(tRace);
    if (this.mode === 'filtered') return { p: { ...this.pf }, v: { ...this.vf }, a: nom.a, yaw: nom.yaw };
    if (this.mode === 'blending') return this.blended(nom);
    return nom;
  }

  /**
   * First-order blend back to the nominal reference: offset d(t) = d0 exp(-t / tau), sent as a
   * kinematically consistent setpoint (p_nom + d, v_nom - d / tau, a_nom + d / tau^2).
   */
  private blended(nom: Setpoint): Setpoint {
    const k1 = 1 / BLEND_TAU;
    const k2 = k1 * k1;
    return {
      p: v3(nom.p.x + this.dp.x, nom.p.y + this.dp.y, nom.p.z + this.dp.z),
      v: v3(nom.v.x - k1 * this.dp.x, nom.v.y - k1 * this.dp.y, nom.v.z - k1 * this.dp.z),
      a: v3(nom.a.x + k2 * this.dp.x, nom.a.y + k2 * this.dp.y, nom.a.z + k2 * this.dp.z),
      yaw: nom.yaw,
    };
  }

  /** Nominal acceleration for the filter: what the onboard law would command for the candidate reference. */
  uNominal(cand: Setpoint, pHat: Vec3, vHat: Vec3): Vec3 {
    if (this.pure) return { ...cand.a };
    return onboardLaw(this.controller, cand, pHat, vHat);
  }

  /**
   * Produce the setpoint to stream after filtering.
   * @param pRef state used to (re)initialise the filtered reference (estimate, predicted if
   *   compensating latency)
   */
  update(tRace: number, dt: number, cand: Setpoint, uSafe: Vec3, intervened: boolean, pHat: Vec3, vHat: Vec3, pRef: Vec3, vRef: Vec3): Setpoint {
    const nom = this.nominal(tRace);
    let sp: Setpoint;
    if (this.pure) {
      sp = { p: cand.p, v: cand.v, a: { ...uSafe }, yaw: cand.yaw };
      this.last = sp;
      return sp;
    }
    if (intervened) {
      if (this.mode !== 'filtered') {
        this.pf = { ...pRef };
        this.vf = { ...vRef };
        this.mode = 'filtered';
      }
      this.idle = 0;
    } else if (this.mode === 'filtered') {
      this.idle += dt;
      if (this.idle >= IDLE_BEFORE_BLEND) {
        this.mode = 'blending';
        this.dp = v3(this.pf.x - nom.p.x, this.pf.y - nom.p.y, this.pf.z - nom.p.z);
      }
    }

    if (this.mode === 'filtered') {
      // Feed-forward a_ff = u_safe - Kp (p_f - p) - Kd (v_f - v), so the onboard law produces
      // exactly u_safe. The reference integrates a_ff (= a_nom + correction), not u_safe: the
      // feedback part belongs to the drone, and integrating it into the reference would make the
      // reference run away from a lagging drone.
      const fb = feedbackTerm(this.controller, this.pf, this.vf, pHat, vHat);
      const aff = v3(uSafe.x - fb.x, uSafe.y - fb.y, uSafe.z - fb.z);
      sp = { p: { ...this.pf }, v: { ...this.vf }, a: aff, yaw: nom.yaw };
      this.pf = v3(this.pf.x + this.vf.x * dt + 0.5 * aff.x * dt * dt, this.pf.y + this.vf.y * dt + 0.5 * aff.y * dt * dt, this.pf.z + this.vf.z * dt + 0.5 * aff.z * dt * dt);
      this.vf = v3(this.vf.x + aff.x * dt, this.vf.y + aff.y * dt, this.vf.z + aff.z * dt);
    } else if (this.mode === 'blending') {
      sp = this.blended(nom);
      const decay = Math.exp(-dt / BLEND_TAU);
      this.dp = v3(this.dp.x * decay, this.dp.y * decay, this.dp.z * decay);
      if (Math.hypot(this.dp.x, this.dp.y, this.dp.z) < 1e-3) this.mode = 'nominal';
    } else {
      sp = nom;
    }
    this.last = sp;
    return sp;
  }

  /** Filtered reference position for display (null in nominal mode). */
  filteredRef(tRace: number): Vec3 | null {
    if (this.mode === 'filtered') return { ...this.pf };
    if (this.mode === 'blending') {
      const nom = this.nominal(tRace);
      return v3(nom.p.x + this.dp.x, nom.p.y + this.dp.y, nom.p.z + this.dp.z);
    }
    return null;
  }
}
