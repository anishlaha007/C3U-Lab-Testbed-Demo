/** Fading trail ribbon, coloured by drone or by speed. */
import { Line } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { writeThree } from './frames';

export interface TrailPoint {
  x: number;
  y: number;
  z: number;
  speed: number;
}

/** Turbo-like colour map for speed (0 .. vmax). */
export function speedColor(speed: number, vmax: number, out = new THREE.Color()): THREE.Color {
  const t = Math.min(1, Math.max(0, speed / vmax));
  // simple 4-stop gradient: blue -> cyan -> yellow -> red
  const stops = [
    [0.15, 0.3, 0.95],
    [0.1, 0.85, 0.9],
    [0.98, 0.85, 0.15],
    [0.95, 0.2, 0.15],
  ];
  const x = t * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const f = x - i;
  return out.setRGB(
    stops[i][0] + (stops[i + 1][0] - stops[i][0]) * f,
    stops[i][1] + (stops[i + 1][1] - stops[i][1]) * f,
    stops[i][2] + (stops[i + 1][2] - stops[i][2]) * f,
  );
}

const MAX_POINTS = 400;

export function Trail({
  getPoints,
  color,
  colorBy,
  vmax,
  background,
  width = 2.5,
}: {
  getPoints: () => TrailPoint[];
  color: string;
  colorBy: 'drone' | 'speed';
  vmax: number;
  background: string;
  width?: number;
}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ref = useRef<any>(null);
  const init = useMemo(() => {
    const pts: [number, number, number][] = [];
    for (let i = 0; i < MAX_POINTS; i++) pts.push([0, -10, 0]);
    return pts;
  }, []);
  const tmp = useMemo(() => ({ c: new THREE.Color(), bg: new THREE.Color(), base: new THREE.Color() }), []);
  useFrame(() => {
    const line = ref.current;
    if (!line) return;
    const pts = getPoints();
    const n = Math.min(MAX_POINTS, pts.length);
    const start = pts.length - n;
    const pos = new Float32Array(MAX_POINTS * 3);
    const col = new Float32Array(MAX_POINTS * 3);
    tmp.bg.set(background);
    tmp.base.set(color);
    for (let k = 0; k < MAX_POINTS; k++) {
      const src = pts[Math.min(pts.length - 1, start + Math.min(k, n - 1))] ?? { x: 0, y: 0, z: -10, speed: 0 };
      writeThree(pos, k, src.x, src.y, src.z);
      const age = n > 1 ? Math.min(k, n - 1) / (n - 1) : 1; // 0 oldest, 1 newest
      if (colorBy === 'speed') speedColor(src.speed, vmax, tmp.c);
      else tmp.c.copy(tmp.base);
      tmp.c.lerp(tmp.bg, 1 - Math.pow(age, 0.8));
      col[3 * k] = tmp.c.r;
      col[3 * k + 1] = tmp.c.g;
      col[3 * k + 2] = tmp.c.b;
    }
    line.geometry.setPositions(pos);
    line.geometry.setColors(col);
    line.visible = n > 1;
  });
  return <Line ref={ref} points={init} vertexColors={init.map(() => [1, 1, 1] as [number, number, number])} lineWidth={width} />;
}
