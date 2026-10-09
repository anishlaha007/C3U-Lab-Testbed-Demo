/**
 * Onboard position controllers (Section 4.3), running at 100 Hz on the drone.
 *
 * Mellinger-like (default): a_cmd = a_ref + Kp (p_ref - p_hat) + Kd (v_ref - v_hat)
 *   (acceleration feed-forward; attitude dynamics are folded into the acceleration lag).
 * PID-like baseline: a_cmd = Kp e_p + Kd e_v + Ki \int e_p  (no feed-forward), used in
 *   Milestone 1 to show the value of feed-forward.
 */
import { MELLINGER_GAINS, PID_GAINS } from './constants';
import type { ControllerType, Setpoint } from './types';
import { v3, type Vec3 } from './vec';

export class OnboardController {
  private integ: Vec3 = v3();
  constructor(readonly type: ControllerType) {}

  reset(): void {
    this.integ = v3();
  }

  compute(sp: Setpoint, pHat: Vec3, vHat: Vec3, dt: number): Vec3 {
    const ex = sp.p.x - pHat.x;
    const ey = sp.p.y - pHat.y;
    const ez = sp.p.z - pHat.z;
    const evx = sp.v.x - vHat.x;
    const evy = sp.v.y - vHat.y;
    const evz = sp.v.z - vHat.z;
    if (this.type === 'mellinger') {
      const { kp, kd } = MELLINGER_GAINS;
      return v3(
        sp.a.x + kp.x * ex + kd.x * evx,
        sp.a.y + kp.y * ey + kd.y * evy,
        sp.a.z + kp.z * ez + kd.z * evz,
      );
    }
    const { kp, kd, ki, iLimit } = PID_GAINS;
    const lim = (x: number) => Math.max(-iLimit, Math.min(iLimit, x));
    this.integ = v3(lim(this.integ.x + ex * dt), lim(this.integ.y + ey * dt), lim(this.integ.z + ez * dt));
    return v3(
      kp.x * ex + kd.x * evx + ki.x * this.integ.x,
      kp.y * ey + kd.y * evy + ki.y * this.integ.y,
      kp.z * ez + kd.z * evz + ki.z * this.integ.z,
    );
  }
}

/**
 * The ground station's model of the onboard law, used to (a) predict the nominal acceleration
 * u_nom fed to the safety filter and (b) invert the law so the drone executes u_safe.
 */
export function onboardLaw(type: ControllerType, sp: Setpoint, pHat: Vec3, vHat: Vec3): Vec3 {
  const { kp, kd } = type === 'mellinger' ? MELLINGER_GAINS : PID_GAINS;
  const ff = type === 'mellinger' ? 1 : 0;
  return v3(
    ff * sp.a.x + kp.x * (sp.p.x - pHat.x) + kd.x * (sp.v.x - vHat.x),
    ff * sp.a.y + kp.y * (sp.p.y - pHat.y) + kd.y * (sp.v.y - vHat.y),
    ff * sp.a.z + kp.z * (sp.p.z - pHat.z) + kd.z * (sp.v.z - vHat.z),
  );
}

/** Feedback part of the law for a reference (p, v): Kp (p - pHat) + Kd (v - vHat). */
export function feedbackTerm(type: ControllerType, p: Vec3, v: Vec3, pHat: Vec3, vHat: Vec3): Vec3 {
  const { kp, kd } = type === 'mellinger' ? MELLINGER_GAINS : PID_GAINS;
  return v3(
    kp.x * (p.x - pHat.x) + kd.x * (v.x - vHat.x),
    kp.y * (p.y - pHat.y) + kd.y * (v.y - vHat.y),
    kp.z * (p.z - pHat.z) + kd.z * (v.z - vHat.z),
  );
}
