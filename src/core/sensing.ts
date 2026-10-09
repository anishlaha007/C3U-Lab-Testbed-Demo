/**
 * Ground-side sensing (Section 4.4): Vicon sampling with Gaussian noise, sensing latency via a
 * timestamped queue, jump rejection, and a low-pass filtered finite-difference velocity.
 * Also the onboard state estimate: true state delayed slightly plus small noise.
 */
import { VICON_JUMP_LIMIT } from './constants';
import { DelayQueue } from './time';
import { v3, type Vec3 } from './vec';

export interface ViconSample {
  /** Capture time (s). */
  t: number;
  /** Drone identity the sample is attributed to (may be swapped by the marker-swap fault). */
  id: number;
  p: Vec3;
}

/** Ground estimator for one drone. */
export class GroundEstimator {
  p: Vec3;
  v: Vec3;
  /** Capture time of the latest accepted sample. */
  tCapture: number;
  initialised = false;
  rejected = 0;
  private consecutiveRejects = 0;
  private readonly alphaFor: (dt: number) => number;

  constructor(p0: Vec3, v0: Vec3, cutoffHz = 20) {
    this.p = { ...p0 };
    this.v = { ...v0 };
    this.tCapture = 0;
    this.initialised = true;
    const wc = 2 * Math.PI * cutoffHz;
    this.alphaFor = (dt) => Math.exp(-wc * dt);
  }

  /** Feed a Vicon sample. Returns false if the sample was rejected as a jump. */
  update(s: ViconSample, jumpCheck: boolean): boolean {
    const dt = s.t - this.tCapture;
    if (dt <= 0) return true;
    const dx = s.p.x - this.p.x;
    const dy = s.p.y - this.p.y;
    const dz = s.p.z - this.p.z;
    // jump test against the prediction from the current estimate
    const px = this.p.x + this.v.x * dt;
    const py = this.p.y + this.v.y * dt;
    const pz = this.p.z + this.v.z * dt;
    const jump = Math.hypot(s.p.x - px, s.p.y - py, s.p.z - pz);
    if (jumpCheck && jump > VICON_JUMP_LIMIT && this.consecutiveRejects < 5) {
      this.rejected++;
      this.consecutiveRejects++;
      // hold the last estimate (propagate with the last velocity so it does not freeze)
      return false;
    }
    this.consecutiveRejects = 0;
    const a = this.alphaFor(dt);
    this.v = v3(a * this.v.x + (1 - a) * (dx / dt), a * this.v.y + (1 - a) * (dy / dt), a * this.v.z + (1 - a) * (dz / dt));
    this.p = { ...s.p };
    this.tCapture = s.t;
    return true;
  }
}

export interface OnboardSample {
  p: Vec3;
  v: Vec3;
}

/** Onboard estimate = true state delayed by a small amount (FIFO) + noise. */
export class OnboardEstimator {
  private q = new DelayQueue<OnboardSample>();
  latest: OnboardSample;
  constructor(p0: Vec3, v0: Vec3, private readonly delay: number) {
    this.latest = { p: { ...p0 }, v: { ...v0 } };
  }
  push(t: number, sample: OnboardSample): void {
    this.q.push(t, this.delay, sample);
  }
  read(t: number): OnboardSample {
    const s = this.q.popLatest(t);
    if (s) this.latest = s;
    return this.latest;
  }
}
