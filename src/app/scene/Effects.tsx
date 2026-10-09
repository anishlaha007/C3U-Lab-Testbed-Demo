/** Collision particle bursts (seeded per event so replays look the same). */
import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { Rng } from '../../core/rng';
import { engine } from '../engine';
import { toThreeVec } from './frames';

const N = 60;

export function CollisionBursts() {
  const pointsRef = useRef<THREE.Points>(null);
  const geom = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3 * 4), 3));
    return g;
  }, []);
  useFrame(() => {
    const log = engine.log;
    const pts = pointsRef.current;
    if (!pts) return;
    const t = engine.time;
    const arr = geom.getAttribute('position') as THREE.BufferAttribute;
    const a = arr.array as Float32Array;
    a.fill(-100);
    let slot = 0;
    if (log) {
      for (const e of log.events) {
        if (slot >= 4) break;
        if (!['collision', 'gateStrike', 'obstacleHit'].includes(e.type) || e.drone === undefined) continue;
        const age = t - e.t;
        if (age < 0 || age > 0.9) continue;
        // position of the drone at the event (from the log)
        const k = Math.min(log.t.length - 1, Math.max(0, Math.round(e.t / log.dtLog)));
        const g = log.drones[e.drone];
        const c = toThreeVec({ x: g.px[k], y: g.py[k], z: g.pz[k] });
        const rng = new Rng(Math.floor(e.t * 1000) + e.drone * 7919);
        for (let i = 0; i < N; i++) {
          const dir = new THREE.Vector3(rng.normal(), rng.normal() + 0.5, rng.normal()).normalize();
          const sp = 0.6 + 1.4 * rng.next();
          const p = c.clone().addScaledVector(dir, sp * age);
          p.y -= 4.9 * age * age;
          const j = (slot * N + i) * 3;
          a[j] = p.x;
          a[j + 1] = Math.max(0.01, p.y);
          a[j + 2] = p.z;
        }
        slot++;
      }
    }
    arr.needsUpdate = true;
  });
  return (
    <points ref={pointsRef} geometry={geom} frustumCulled={false}>
      <pointsMaterial color="#fb923c" size={0.035} transparent opacity={0.9} depthWrite={false} toneMapped={false} />
    </points>
  );
}
