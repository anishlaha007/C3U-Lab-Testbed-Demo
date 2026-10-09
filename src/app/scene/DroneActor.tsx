/** Drone placed and oriented from the engine view each frame. */
import { useFrame } from '@react-three/fiber';
import { useRef } from 'react';
import * as THREE from 'three';
import type { SceneView } from '../view';
import { DroneModel, type DroneModelHandle } from './DroneModel';
import { attitudeQuaternion, writeThree } from './frames';

export function DroneActor({ index, getView, color, scale }: { index: number; getView: () => SceneView; color: string; scale: number }) {
  const model = useRef<DroneModelHandle>(null);
  const q = useRef(new THREE.Quaternion());
  const pos = useRef(new Float32Array(3));
  useFrame((_, dt) => {
    const m = model.current;
    if (!m) return;
    const d = getView().drones[index];
    if (!d) {
      m.group.visible = false;
      return;
    }
    m.group.visible = true;
    writeThree(pos.current, 0, d.p.x, d.p.y, d.p.z);
    m.group.position.set(pos.current[0], pos.current[1], pos.current[2]);
    attitudeQuaternion(d.f, d.yaw, q.current);
    m.group.quaternion.copy(q.current);
    m.spin(Math.min(0.9, dt * (40 + 260 * d.thrust01)));
  });
  return <DroneModel ref={model} color={color} scale={scale} />;
}
