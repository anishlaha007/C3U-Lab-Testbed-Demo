/** Vicon camera props on the ceiling truss, each with a ring of red strobe LEDs. */
import { useMemo } from 'react';
import * as THREE from 'three';
import type { ArenaConfig } from '../../core/types';
import { toThreeVec } from './frames';

export function viconCameraPositions(arena: ArenaConfig, count = 10) {
  const { sx, sy, sz } = arena;
  const hx = sx / 2 - 0.05;
  const hy = sy / 2 - 0.05;
  const per = 2 * (sx + sy);
  const out: { x: number; y: number; z: number }[] = [];
  for (let k = 0; k < count; k++) {
    let s = ((k + 0.5) / count) * per;
    let x: number;
    let y: number;
    if (s < sx) {
      x = -hx + (s / sx) * 2 * hx;
      y = hy;
    } else if ((s -= sx) < sy) {
      x = hx;
      y = hy - (s / sy) * 2 * hy;
    } else if ((s -= sy) < sx) {
      x = hx - (s / sx) * 2 * hx;
      y = -hy;
    } else {
      s -= sx;
      x = -hx;
      y = -hy + (s / sy) * 2 * hy;
    }
    out.push({ x, y, z: sz + 0.02 });
  }
  return out;
}

export function ViconCameras({ arena, count = 10, frustums = false }: { arena: ArenaConfig; count?: number; frustums?: boolean }) {
  const cams = useMemo(() => {
    const target = toThreeVec({ x: 0, y: 0, z: 0.8 });
    return viconCameraPositions(arena, count).map((p) => {
      const pos = toThreeVec(p);
      const m = new THREE.Matrix4().lookAt(pos, target, new THREE.Vector3(0, 1, 0));
      const q = new THREE.Quaternion().setFromRotationMatrix(m);
      const dist = pos.distanceTo(target);
      return { pos, q, dist };
    });
  }, [arena, count]);
  return (
    <group>
      {cams.map((c, i) => (
        <group key={i} position={c.pos} quaternion={c.q}>
          {/* body: camera looks along local -Z */}
          <mesh castShadow>
            <boxGeometry args={[0.1, 0.09, 0.14]} />
            <meshStandardMaterial color="#1f2937" metalness={0.5} roughness={0.5} />
          </mesh>
          <mesh position={[0, 0, -0.08]} rotation={[Math.PI / 2, 0, 0]}>
            <cylinderGeometry args={[0.032, 0.032, 0.03, 20]} />
            <meshStandardMaterial color="#0f172a" metalness={0.8} roughness={0.2} />
          </mesh>
          <mesh position={[0, 0, -0.096]}>
            <torusGeometry args={[0.04, 0.007, 8, 24]} />
            <meshStandardMaterial color="#ef4444" emissive="#ff2020" emissiveIntensity={2.2} toneMapped={false} />
          </mesh>
          {frustums && (
            <mesh position={[0, 0, -c.dist / 2]} rotation={[Math.PI / 2, 0, 0]}>
              <coneGeometry args={[c.dist * 0.55, c.dist, 4, 1, true]} />
              <meshBasicMaterial color="#ef4444" wireframe transparent opacity={0.07} />
            </mesh>
          )}
        </group>
      ))}
    </group>
  );
}
