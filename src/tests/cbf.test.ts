import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../core/defaults';
import { clipToFeasible, maxAccelAlong, saturateThrust } from '../core/dynamics';
import { checkFeasibility, tiltAtLimit, usableThrust } from '../core/feasibility';
import { brakingPair } from '../core/safety/brakingCbf';
import { ecbfPair, pairD, scaledSeparation } from '../core/safety/ecbf';
import { runSafetyFilter, type FilterDrone } from '../core/safety/filter';
import { closedFormPair, hildreth, rowFromConstraint } from '../core/safety/qp';
import { Rng } from '../core/rng';
import { figure8 } from '../core/trajectories/figure8';
import { v3 } from '../core/vec';

const rel = (x: number, t: number, tol = 0.01) => Math.abs(x - t) <= tol * Math.abs(t);

describe('feasibility (Section 5.3)', () => {
  it('TWR 1.8, eta 0.7 -> usable 12.4 m/s^2, horizontal 7.5 m/s^2 at 37.5 deg', () => {
    expect(Math.abs(usableThrust(1.8, 0.7) - 12.4)).toBeLessThan(0.05);
    expect(Math.abs(maxAccelAlong(v3(1, 0, 0), 1.8, 0.7) - 7.5)).toBeLessThan(0.05);
    expect(Math.abs(tiltAtLimit(1.8, 0.7) - 37.5)).toBeLessThan(0.2);
  });
  it('flags figure-8 samples only beyond w_max', () => {
    expect(checkFeasibility(figure8({ A: 1.5, w: 1.5, z0: 1 }), 1, 1.8, 0.7, 60).share).toBe(0);
    expect(checkFeasibility(figure8({ A: 1.5, w: 1.6, z0: 1 }), 1, 1.8, 0.7, 60).share).toBeGreaterThan(0);
  });
  it('thrust cone saturation clamps tilt first, then magnitude', () => {
    const r = saturateThrust(v3(30, 0, 0), 1.8, Math.PI / 3);
    const f = r.f;
    expect(Math.hypot(f.x, f.y, f.z)).toBeLessThanOrEqual(1.8 * 9.81 + 1e-9);
    expect(Math.atan2(f.x, f.z)).toBeCloseTo(Math.PI / 3, 6);
    expect(r.saturated).toBe(true);
    const ok = saturateThrust(v3(1, 0, 0), 1.8, Math.PI / 3);
    expect(ok.saturated).toBe(false);
    expect(ok.a.x).toBeCloseTo(1, 9);
  });
  it('filter clipping keeps altitude and limits the horizontal part to 7.5 m/s^2', () => {
    const r = clipToFeasible(v3(20, 0, 0), 1.8, 0.7, Math.PI / 3);
    expect(r.clipped).toBe(true);
    expect(r.u.z).toBeCloseTo(0, 9);
    expect(Math.abs(r.u.x - 7.52)).toBeLessThan(0.05);
  });
});

describe('CBF worked example (Section 13)', () => {
  // drones at (0,0,1) and (0.5,0,1), velocities (1,0,0) and (-1,0,0), zero nominal input, lambda = 4
  const p1 = v3(0, 0, 1);
  const p2 = v3(0.5, 0, 1);
  const v1 = v3(1, 0, 0);
  const v2 = v3(-1, 0, 0);
  const D = pairD(1);
  const c = ecbfPair(0, 1, p1, v1, p2, v2, D, 4);

  it('D = diag(17.36, 17.36, 2.78)', () => {
    expect(rel(D.x, 17.36)).toBe(true);
    expect(rel(D.y, 17.36)).toBe(true);
    expect(rel(D.z, 2.78)).toBe(true);
  });
  it("h = 3.34, h' = -34.7, a = (-17.36, 0, 0), b = 85.5", () => {
    expect(rel(c.h, 3.34)).toBe(true);
    expect(rel(c.hdot!, -34.7)).toBe(true);
    expect(rel(c.a.x, -17.36)).toBe(true);
    expect(c.a.y).toBe(0);
    expect(c.a.z).toBe(0);
    expect(rel(c.b, 85.5)).toBe(true);
  });
  it('c = 0.142, u1 = (-2.46, 0, 0), u2 = (+2.46, 0, 0)', () => {
    const r = closedFormPair(v3(), v3(), c.a, c.b);
    expect(rel(r.c, 0.142)).toBe(true);
    expect(rel(r.ui.x, -2.46)).toBe(true);
    expect(rel(r.uj.x, 2.46)).toBe(true);
    expect(r.ui.y).toBe(0);
  });
  it('the full filter (closed form path) gives the same result', () => {
    const cfg = defaultConfig().filter;
    cfg.lambda = 4;
    cfg.obstacles = false;
    const drones: FilterDrone[] = [
      { p: p1, v: v1, uNom: v3(), twr: 1.8, active: true, progress: NaN },
      { p: p2, v: v2, uNom: v3(), twr: 1.8, active: true, progress: NaN },
    ];
    const r = runSafetyFilter(drones, [], { cfg, eta: 0.7, thetaMax: Math.PI / 3 });
    expect(rel(r.uSafe[0].x, -2.46)).toBe(true);
    expect(rel(r.uSafe[1].x, 2.46)).toBe(true);
    expect(r.intervened).toEqual([true, true]);
  });
  it('scaled separation of the example is 2.08', () => {
    expect(scaledSeparation(p1, p2, D)).toBeCloseTo(0.5 / 0.24, 6);
  });
});

describe('braking-aware CBF', () => {
  it('no constraint when separating, active when closing fast', () => {
    const D = pairD(1);
    expect(brakingPair(0, 1, v3(0, 0, 1), v3(-1, 0, 0), v3(0.5, 0, 1), v3(1, 0, 0), D, 12, 5).constraint).toBeNull();
    const r = brakingPair(0, 1, v3(0, 0, 1), v3(3, 0, 0), v3(1.0, 0, 1), v3(-3, 0, 0), D, 12, 5);
    expect(r.constraint).not.toBeNull();
    // closing at 6 m/s from 1 m needs more than the 12 m/s^2 budget: h_b < 0
    expect(r.h).toBeLessThan(0);
  });
});

describe('Hildreth QP (Section 8.3)', () => {
  it('equals the closed form for two drones', () => {
    const rng = new Rng(3);
    for (let k = 0; k < 50; k++) {
      const p1 = v3(rng.uniform(-1, 1), rng.uniform(-1, 1), 1 + rng.uniform(-0.5, 0.5));
      const p2 = v3(p1.x + rng.uniform(-0.6, 0.6), p1.y + rng.uniform(-0.6, 0.6), p1.z + rng.uniform(-0.6, 0.6));
      const v1 = v3(rng.uniform(-2, 2), rng.uniform(-2, 2), rng.uniform(-0.5, 0.5));
      const v2 = v3(rng.uniform(-2, 2), rng.uniform(-2, 2), rng.uniform(-0.5, 0.5));
      const u1 = v3(rng.uniform(-3, 3), rng.uniform(-3, 3), rng.uniform(-1, 1));
      const u2 = v3(rng.uniform(-3, 3), rng.uniform(-3, 3), rng.uniform(-1, 1));
      const c = ecbfPair(0, 1, p1, v1, p2, v2, pairD(1), 8);
      const cf = closedFormPair(u1, u2, c.a, c.b);
      const h = hildreth([u1, u2], [1, 1], [rowFromConstraint(c)], 100, 1e-9);
      expect(Math.abs(h.delta[0].x + u1.x - cf.ui.x)).toBeLessThan(1e-6 * (1 + Math.abs(cf.ui.x)));
      expect(Math.abs(h.delta[1].y + u2.y - cf.uj.y)).toBeLessThan(1e-6 * (1 + Math.abs(cf.uj.y)));
      expect(Math.abs(h.delta[0].z + u1.z - cf.ui.z)).toBeLessThan(1e-6 * (1 + Math.abs(cf.ui.z)));
    }
  });

  it('satisfies all pair constraints for random N-drone cases', () => {
    const rng = new Rng(11);
    for (let trial = 0; trial < 40; trial++) {
      const n = 2 + rng.int(5);
      const ps = Array.from({ length: n }, () => v3(rng.uniform(-0.6, 0.6), rng.uniform(-0.6, 0.6), 1 + rng.uniform(-0.3, 0.3)));
      const vs = Array.from({ length: n }, () => v3(rng.uniform(-2, 2), rng.uniform(-2, 2), rng.uniform(-0.5, 0.5)));
      const us = Array.from({ length: n }, () => v3(rng.uniform(-2, 2), rng.uniform(-2, 2), rng.uniform(-1, 1)));
      const cons = [];
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) cons.push(ecbfPair(i, j, ps[i], vs[i], ps[j], vs[j], pairD(1), 8));
      const res = hildreth(us, us.map(() => 1), cons.map(rowFromConstraint), 2000, 1e-10);
      const u = us.map((x, i) => v3(x.x + res.delta[i].x, x.y + res.delta[i].y, x.z + res.delta[i].z));
      for (const c of cons) {
        const lhs = c.a.x * (u[c.i].x - u[c.j].x) + c.a.y * (u[c.i].y - u[c.j].y) + c.a.z * (u[c.i].z - u[c.j].z);
        expect(lhs).toBeGreaterThanOrEqual(c.b - 1e-4 * (1 + Math.abs(c.b)));
      }
    }
  });
});
