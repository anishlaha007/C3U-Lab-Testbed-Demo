/**
 * Race track model (Section 7.1): a centreline tau(s) parametrised by arc length s, with a
 * lateral half-width w(s) and a vertical half-height h(s). Progress of a drone = arc length of
 * its closest centreline point plus laps times the lap length.
 *
 * The closest-point search is windowed around the previous match so self-crossing tracks (the
 * figure-8 circuit) are followed continuously.
 */
import { cross, v3, type Vec3 } from '../vec';

export interface Track {
  id: string;
  closed: boolean;
  /** Resampled centreline points (uniform spacing ds). */
  pts: Vec3[];
  s: Float64Array;
  ds: number;
  length: number;
  tangent: Vec3[];
  /** Horizontal unit vector to the left of the tangent. */
  lateral: Vec3[];
  /** Unit vector completing the frame (mostly +z). */
  up: Vec3[];
  halfWidth: Float64Array;
  halfHeight: Float64Array;
}

export interface TrackOptions {
  id?: string;
  closed: boolean;
  ds?: number;
  halfWidth?: (s: number, p: Vec3) => number;
  halfHeight?: (s: number, p: Vec3) => number;
}

/** Build a track from a dense polyline (resampled uniformly in arc length). */
export function makeTrack(points: Vec3[], opts: TrackOptions): Track {
  const ds = opts.ds ?? 0.05;
  const src = opts.closed && dist3(points[0], points[points.length - 1]) > 1e-9 ? [...points, points[0]] : points;
  // cumulative length of the source polyline
  const cum = [0];
  for (let i = 1; i < src.length; i++) cum.push(cum[i - 1] + dist3(src[i], src[i - 1]));
  const total = cum[cum.length - 1];
  const n = Math.max(2, Math.round(total / ds) + (opts.closed ? 0 : 1));
  const step = opts.closed ? total / n : total / (n - 1);
  const pts: Vec3[] = [];
  let k = 0;
  for (let i = 0; i < n; i++) {
    const si = i * step;
    while (k < cum.length - 2 && cum[k + 1] < si) k++;
    const seg = cum[k + 1] - cum[k];
    const f = seg > 0 ? (si - cum[k]) / seg : 0;
    pts.push(v3(src[k].x + (src[k + 1].x - src[k].x) * f, src[k].y + (src[k + 1].y - src[k].y) * f, src[k].z + (src[k + 1].z - src[k].z) * f));
  }
  const s = new Float64Array(n);
  for (let i = 0; i < n; i++) s[i] = i * step;
  const tangent: Vec3[] = [];
  const lateral: Vec3[] = [];
  const up: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    const a = opts.closed ? pts[(i - 1 + n) % n] : pts[Math.max(0, i - 1)];
    const b = opts.closed ? pts[(i + 1) % n] : pts[Math.min(n - 1, i + 1)];
    let t = v3(b.x - a.x, b.y - a.y, b.z - a.z);
    const tn = Math.hypot(t.x, t.y, t.z) || 1;
    t = v3(t.x / tn, t.y / tn, t.z / tn);
    let l = v3(-t.y, t.x, 0);
    const ln = Math.hypot(l.x, l.y);
    l = ln > 1e-6 ? v3(l.x / ln, l.y / ln, 0) : i > 0 ? lateral[i - 1] : v3(0, 1, 0);
    const u = cross(t, l);
    tangent.push(t);
    lateral.push(l);
    up.push(u);
  }
  const halfWidth = new Float64Array(n);
  const halfHeight = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    halfWidth[i] = opts.halfWidth ? opts.halfWidth(s[i], pts[i]) : 0.5;
    halfHeight[i] = opts.halfHeight ? opts.halfHeight(s[i], pts[i]) : 0;
  }
  return { id: opts.id ?? 'track', closed: opts.closed, pts, s, ds: step, length: opts.closed ? total : total, tangent, lateral, up, halfWidth, halfHeight };
}

function dist3(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/** Interpolated track frame at arc length s (wraps for closed tracks). */
export function trackAt(tr: Track, s: number): { p: Vec3; t: Vec3; l: Vec3; u: Vec3; w: number; h: number; idx: number } {
  const n = tr.pts.length;
  let ss = s;
  if (tr.closed) ss = ((s % tr.length) + tr.length) % tr.length;
  else ss = Math.max(0, Math.min(tr.length, s));
  const x = ss / tr.ds;
  let i = Math.floor(x);
  let f = x - i;
  let j: number;
  if (tr.closed) {
    i = i % n;
    j = (i + 1) % n;
  } else {
    if (i >= n - 1) {
      i = n - 2;
      f = 1;
    }
    j = i + 1;
  }
  const lerp = (a: Vec3, b: Vec3) => v3(a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f, a.z + (b.z - a.z) * f);
  return {
    p: lerp(tr.pts[i], tr.pts[j]),
    t: lerp(tr.tangent[i], tr.tangent[j]),
    l: lerp(tr.lateral[i], tr.lateral[j]),
    u: lerp(tr.up[i], tr.up[j]),
    w: tr.halfWidth[i] + (tr.halfWidth[j] - tr.halfWidth[i]) * f,
    h: tr.halfHeight[i] + (tr.halfHeight[j] - tr.halfHeight[i]) * f,
    idx: i,
  };
}

/** Closest centreline index to p, searching a window around `hint` (or globally if hint < 0). */
export function closestIndex(tr: Track, p: Vec3, hint = -1, window = 1.5): number {
  const n = tr.pts.length;
  let best = -1;
  let bestD = Infinity;
  const check = (i: number) => {
    const q = tr.pts[i];
    const d = (q.x - p.x) ** 2 + (q.y - p.y) ** 2 + (q.z - p.z) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  };
  if (hint < 0) {
    for (let i = 0; i < n; i++) check(i);
    return best;
  }
  const w = Math.max(2, Math.round(window / tr.ds));
  for (let k = -w; k <= w; k++) {
    let i = hint + k;
    if (tr.closed) i = ((i % n) + n) % n;
    else if (i < 0 || i >= n) continue;
    check(i);
  }
  return best;
}

/** Arc length of the projection of p onto the segment around index i (sub-sample accuracy). */
export function refineS(tr: Track, p: Vec3, i: number): number {
  const n = tr.pts.length;
  const t = tr.tangent[i];
  const q = tr.pts[i];
  let s = tr.s[i] + ((p.x - q.x) * t.x + (p.y - q.y) * t.y + (p.z - q.z) * t.z);
  if (!tr.closed) s = Math.max(0, Math.min(tr.length, s));
  else if (i === 0 && s < 0) s += tr.length;
  else if (i === n - 1 && s > tr.length) s -= tr.length;
  return s;
}

/** Lateral and vertical offset of p from the centreline at index i. */
export function offsetsAt(tr: Track, p: Vec3, i: number): { lat: number; vert: number } {
  const q = tr.pts[i];
  const d = v3(p.x - q.x, p.y - q.y, p.z - q.z);
  return { lat: d.x * tr.lateral[i].x + d.y * tr.lateral[i].y + d.z * tr.lateral[i].z, vert: d.x * tr.up[i].x + d.y * tr.up[i].y + d.z * tr.up[i].z };
}

/**
 * Continuous progress along a track: s + laps * L. Windowed search keeps it on the right branch
 * of self-crossing tracks; lap increments when s wraps from the end to the start.
 */
export class ProgressTracker {
  private idx = -1;
  private laps = 0;
  private lastS = 0;
  progress = 0;
  constructor(private readonly tr: Track, initial?: Vec3, initialIndex?: number) {
    if (initialIndex !== undefined) this.idx = initialIndex;
    if (initial) {
      this.update(initial);
      // a start just behind the start line counts as negative progress, not a full lap
      if (tr.closed && this.lastS > 0.5 * tr.length) {
        this.laps = -1;
        this.progress = this.lastS - tr.length;
      }
    }
  }
  update(p: Vec3): number {
    const tr = this.tr;
    this.idx = closestIndex(tr, p, this.idx, 1.0);
    const s = refineS(tr, p, this.idx);
    if (tr.closed) {
      if (this.lastS > 0.75 * tr.length && s < 0.25 * tr.length) this.laps++;
      else if (this.lastS < 0.25 * tr.length && s > 0.75 * tr.length && this.laps > 0) this.laps--;
    }
    this.lastS = s;
    this.progress = s + this.laps * tr.length;
    return this.progress;
  }
  get index(): number {
    return this.idx;
  }
}
