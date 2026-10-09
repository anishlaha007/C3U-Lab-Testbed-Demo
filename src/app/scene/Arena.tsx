/** Arena: floor with 0.5 m grid, translucent safety nets, ceiling truss and an axes gizmo. */
import { Grid } from '@react-three/drei';
import { useMemo } from 'react';
import * as THREE from 'three';
import type { ArenaConfig } from '../../core/types';
import { toThree } from './frames';

function makeNetTexture(dark: boolean): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, 64, 64);
  g.strokeStyle = dark ? 'rgba(148,163,184,0.55)' : 'rgba(51,65,85,0.45)';
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(0, 0);
  g.lineTo(64, 64);
  g.moveTo(64, 0);
  g.lineTo(0, 64);
  g.stroke();
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}

function Beam({ from, to, r = 0.03, color = '#64748b' }: { from: [number, number, number]; to: [number, number, number]; r?: number; color?: string }) {
  const { pos, quat, len } = useMemo(() => {
    const a = new THREE.Vector3(...from);
    const b = new THREE.Vector3(...to);
    const d = b.clone().sub(a);
    const len = d.length();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize());
    return { pos: a.add(b).multiplyScalar(0.5), quat: q, len };
  }, [from, to]);
  return (
    <mesh position={pos} quaternion={quat} castShadow>
      <boxGeometry args={[r * 2, len, r * 2]} />
      <meshStandardMaterial color={color} metalness={0.6} roughness={0.4} />
    </mesh>
  );
}

export function Arena({ arena, dark, showNets = true }: { arena: ArenaConfig; dark: boolean; showNets?: boolean }) {
  const { sx, sy, sz } = arena;
  const hx = sx / 2;
  const hy = sy / 2;
  const net = useMemo(() => makeNetTexture(dark), [dark]);
  const walls = useMemo(() => {
    // each wall: centre (core), width, normal yaw
    return [
      // rotY makes each plane's front face point into the arena, so walls between an outside
      // camera and the arena are back-face culled and do not veil the view.
      { c: { x: hx, y: 0, z: sz / 2 }, w: sy, rotY: -Math.PI / 2 },
      { c: { x: -hx, y: 0, z: sz / 2 }, w: sy, rotY: Math.PI / 2 },
      { c: { x: 0, y: hy, z: sz / 2 }, w: sx, rotY: 0 },
      { c: { x: 0, y: -hy, z: sz / 2 }, w: sx, rotY: Math.PI },
    ];
  }, [hx, hy, sz, sx, sy]);

  const trussColor = dark ? '#475569' : '#94a3b8';
  const corners: [number, number][] = [
    [hx, hy],
    [-hx, hy],
    [-hx, -hy],
    [hx, -hy],
  ];
  return (
    <group>
      {/* floor */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.001, 0]} receiveShadow>
        <planeGeometry args={[sx + 3, sy + 3]} />
        <meshStandardMaterial color={dark ? '#0d1424' : '#dfe6ee'} roughness={0.95} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.0005, 0]} receiveShadow>
        <planeGeometry args={[sx, sy]} />
        <meshStandardMaterial color={dark ? '#18233a' : '#f8fafc'} roughness={0.9} />
      </mesh>
      <Grid
        args={[sx, sy]}
        position={[0, 0.002, 0]}
        cellSize={0.5}
        cellThickness={0.6}
        cellColor={dark ? '#1e293b' : '#cbd5e1'}
        sectionSize={1}
        sectionThickness={1.1}
        sectionColor={dark ? '#334155' : '#94a3b8'}
        fadeDistance={60}
        infiniteGrid={false}
      />
      {/* nets */}
      {showNets &&
        walls.map((w, i) => {
          const tex = net.clone();
          tex.needsUpdate = true;
          tex.repeat.set(w.w / 0.25, sz / 0.25);
          return (
            <mesh key={i} position={toThree(w.c)} rotation={[0, w.rotY, 0]}>
              <planeGeometry args={[w.w, sz]} />
              <meshBasicMaterial map={tex} transparent opacity={dark ? 0.3 : 0.4} side={THREE.FrontSide} depthWrite={false} />
            </mesh>
          );
        })}
      {/* posts and truss */}
      {corners.map(([x, y], i) => (
        <Beam key={`p${i}`} from={toThree({ x, y, z: 0 })} to={toThree({ x, y, z: sz + 0.1 })} r={0.035} color={trussColor} />
      ))}
      {corners.map(([x, y], i) => {
        const [x2, y2] = corners[(i + 1) % 4];
        return <Beam key={`t${i}`} from={toThree({ x, y, z: sz + 0.1 })} to={toThree({ x: x2, y: y2, z: sz + 0.1 })} r={0.03} color={trussColor} />;
      })}
      <Beam from={toThree({ x: -hx, y: 0, z: sz + 0.1 })} to={toThree({ x: hx, y: 0, z: sz + 0.1 })} r={0.025} color={trussColor} />
      <AxesGizmo />
    </group>
  );
}

/** Axes gizmo at the origin in the core frame: x red, y green, z blue. */
export function AxesGizmo({ size = 0.5 }: { size?: number }) {
  const axes = [
    { d: { x: 1, y: 0, z: 0 }, c: '#ef4444' },
    { d: { x: 0, y: 1, z: 0 }, c: '#22c55e' },
    { d: { x: 0, y: 0, z: 1 }, c: '#3b82f6' },
  ];
  return (
    <group position={[0, 0.01, 0]}>
      {axes.map((a, i) => {
        const dir = new THREE.Vector3(...toThree(a.d));
        const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
        const mid = dir.clone().multiplyScalar(size / 2);
        const tip = dir.clone().multiplyScalar(size);
        return (
          <group key={i}>
            <mesh position={mid} quaternion={q}>
              <cylinderGeometry args={[0.008, 0.008, size, 8]} />
              <meshBasicMaterial color={a.c} />
            </mesh>
            <mesh position={tip} quaternion={q}>
              <coneGeometry args={[0.025, 0.07, 12]} />
              <meshBasicMaterial color={a.c} />
            </mesh>
          </group>
        );
      })}
    </group>
  );
}
