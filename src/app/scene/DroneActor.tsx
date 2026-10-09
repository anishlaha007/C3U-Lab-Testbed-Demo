/** Drone placed and oriented from the engine view each frame; tumbles after a crash or kill. */
import { useFrame } from '@react-three/fiber';
import { useRef } from 'react';
import * as THREE from 'three';
import { engine } from '../engine';
import { DroneModel, type DroneModelHandle } from './DroneModel';
import { attitudeQuaternion, toThreeVec, writeThree } from './frames';

const tumbleQ = new THREE.Quaternion();

export function DroneActor({ index, color, scale }: { index: number; color: string; scale: number }) {
  const model = useRef<DroneModelHandle>(null);
  const q = useRef(new THREE.Quaternion());
  const pos = useRef(new Float32Array(3));
  useFrame((_, dt) => {
    const m = model.current;
    if (!m) return;
    const d = engine.view().drones[index];
    if (!d) {
      m.group.visible = false;
      return;
    }
    m.group.visible = true;
    writeThree(pos.current, 0, d.p.x, d.p.y, Math.max(d.mode >= 3 ? 0.012 : -1, d.p.z));
    m.group.position.set(pos.current[0], pos.current[1], pos.current[2]);
    attitudeQuaternion(d.f, d.yaw, q.current);
    if (d.tumble) {
      const ax = toThreeVec(d.tumble);
      const ang = ax.length();
      if (ang > 1e-6) {
        tumbleQ.setFromAxisAngle(ax.normalize(), ang);
        q.current.premultiply(tumbleQ);
      }
    }
    m.group.quaternion.copy(q.current);
    const playing = engine.playing || engine.replayPlaying;
    if (d.mode < 3 && playing) m.spin(Math.min(0.9, dt * (40 + 260 * d.thrust01)));
    m.setLed(d.mode >= 3 ? 0 : d.intervened ? 6 : 3);
  });
  return <DroneModel ref={model} color={color} scale={scale} />;
}
