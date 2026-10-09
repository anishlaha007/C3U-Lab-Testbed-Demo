/** Planned (commanded) paths with infeasible segments in red, and the racing line. */
import { Line } from '@react-three/drei';
import { useMemo } from 'react';
import type { FeasibilityResult } from '../../core/feasibility';
import type { Track } from '../../core/planners/track';
import type { Trajectory } from '../../core/types';
import type { Vec3 } from '../../core/vec';
import { toThree } from './frames';

export function PlannedPath({ traj, color, feas, dashed = true }: { traj: Trajectory; color: string; feas?: FeasibilityResult; dashed?: boolean }) {
  const { pts, colors } = useMemo(() => {
    const n = traj.t.length;
    const stride = Math.max(1, Math.floor(n / 600));
    const pts: [number, number, number][] = [];
    const colors: [number, number, number][] = [];
    const base = hexToRgb(color);
    for (let i = 0; i < n; i += stride) {
      pts.push(toThree({ x: traj.x[i], y: traj.y[i], z: traj.z[i] }));
      let bad = false;
      if (feas) for (let k = i; k < Math.min(n, i + stride); k++) bad = bad || feas.flags[k] === 1;
      colors.push(bad ? [0.95, 0.15, 0.15] : base);
    }
    return { pts, colors };
  }, [traj, color, feas]);
  if (pts.length < 2) return null;
  return <Line points={pts} vertexColors={colors} lineWidth={1.6} dashed={dashed} dashSize={0.06} gapSize={0.04} transparent opacity={0.75} />;
}

export function RacingLine({ track, color = '#a3e635' }: { track: Track; color?: string }) {
  const pts = useMemo(() => {
    const out: [number, number, number][] = track.pts.filter((_, i) => i % 2 === 0).map((p) => toThree(p));
    if (track.closed && out.length) out.push(out[0]);
    return out;
  }, [track]);
  return <Line points={pts} color={color} lineWidth={3} transparent opacity={0.35} />;
}

export function Polyline({ pts, color, width = 1.5, opacity = 0.5, dashed = false }: { pts: Vec3[]; color: string; width?: number; opacity?: number; dashed?: boolean }) {
  const p3 = useMemo(() => pts.map((p) => toThree(p)), [pts]);
  if (p3.length < 2) return null;
  return <Line points={p3} color={color} lineWidth={width} transparent opacity={opacity} dashed={dashed} dashSize={0.05} gapSize={0.05} />;
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const v = h.length === 3 ? h.split('').map((c) => c + c).join('') : h.padEnd(6, '0');
  return [parseInt(v.slice(0, 2), 16) / 255, parseInt(v.slice(2, 4), 16) / 255, parseInt(v.slice(4, 6), 16) / 255];
}
