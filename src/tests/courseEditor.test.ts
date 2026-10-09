import { describe, expect, it } from 'vitest';
import {
  addGate,
  addObstacle,
  addVisit,
  cloneCourse,
  deleteGate,
  gateNumbers,
  moveVisit,
  parseCourseJson,
  runChecks,
  snap,
  templateCourse,
  toggleReverse,
  type LineOptions,
} from '../app/panels/courseEditorUtils';
import { defaultConfig } from '../core/defaults';
import type { CourseId } from '../core/types';

const cfg = defaultConfig();
const opts = (speed = 1.6): LineOptions => ({ speed, eta: 0.7, thetaMaxDeg: 60, arena: { sx: 9, sy: 8, sz: 3.2 }, twr: 1.8 });

describe('course editor checks', () => {
  it('library courses validate without errors', () => {
    for (const id of ['C1', 'C2', 'C5', 'C9'] as CourseId[]) {
      const c = templateCourse(id, cfg);
      const r = runChecks(c, opts());
      expect(r.issues.filter((i) => i.level === 'error'), id).toEqual([]);
      expect(r.line.collisions, id).toBe(0);
    }
  });

  it('flags a gate pushed into the net and a pillar inside a gate opening', () => {
    const c = templateCourse('C1', cfg);
    const bad = cloneCourse(c);
    bad.gates[0].center.x = 4.3; // arena half-length 4.5 m: the frame reaches the net
    const r = runChecks(bad, opts());
    expect(r.issues.some((i) => i.level !== 'info' && i.sel?.t === 'gate' && i.sel.i === 0)).toBe(true);

    const blocked = cloneCourse(c);
    const g = blocked.gates[1];
    const k = addObstacle(blocked, 'pillar', g.center.x, g.center.y, opts().arena);
    expect(blocked.obstacles[k].kind).toBe('pillar');
    const r2 = runChecks(blocked, opts());
    expect(r2.issues.some((i) => i.level === 'error')).toBe(true);
  });

  it('a speed beyond the thrust limit is reported as a slow-down', () => {
    const r = runChecks(templateCourse('C2', cfg), opts(4));
    expect(r.line.scale).toBeGreaterThan(1);
    expect(r.line.issues.some((i) => /too fast|Impossible/.test(i.text))).toBe(true);
  });
});

describe('course editing', () => {
  it('sequence editing: repeat and reverse visits, reorder, delete', () => {
    const c = templateCourse('C1', cfg);
    const n = c.sequence.length;
    addVisit(c, 0);
    expect(c.sequence).toHaveLength(n + 1);
    expect(gateNumbers(c)[0]).toBe(`1/${n + 1}`);
    toggleReverse(c, n);
    expect(c.sequence[n].reverse).toBe(true);
    moveVisit(c, n, -1);
    expect(c.sequence[n - 1].gate).toBe(0);
    const before = c.gates.length;
    deleteGate(c, 0);
    expect(c.gates).toHaveLength(before - 1);
    // visits of the deleted gate are gone and the others are re-indexed
    expect(c.sequence.every((v) => v.gate >= 0 && v.gate < c.gates.length)).toBe(true);
  });

  it('new gates snap to the 0.1 m grid', () => {
    const c = templateCourse('default', cfg);
    const i = addGate(c, snap(1.234), snap(-0.871), 'stand');
    expect(c.gates[i].center.x).toBeCloseTo(1.2, 9);
    expect(c.gates[i].center.y).toBeCloseTo(-0.9, 9);
  });

  it('JSON round trip and tolerant loading', () => {
    const c = templateCourse('C9', cfg);
    const back = parseCourseJson(JSON.stringify(c));
    expect('course' in back).toBe(true);
    if ('course' in back) {
      expect(back.course.gates).toHaveLength(c.gates.length);
      expect(back.course.sequence).toEqual(c.sequence);
    }
    expect('error' in parseCourseJson('{"not": "a course"}')).toBe(true);
    expect('error' in parseCourseJson('not json')).toBe(true);
  });
});
