/**
 * Per-drone overlays: reference ghosts (nominal sphere, filtered ring), downwash ellipsoid
 * coloured by separation, intervention arrow, name label, plus the closest-pair separation line.
 */
import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { DRONE_NAMES, ELLIPSOID_RADII } from '../../core/constants';
import { engine } from '../engine';
import { toThreeVec, writeThree } from './frames';
import { labelTexture, textTexture } from './textures';

const tmp = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

export function DroneOverlays({ index, color, ghosts, ellipsoid, arrow, label, scale }: { index: number; color: string; ghosts: boolean; ellipsoid: boolean; arrow: boolean; label: boolean; scale: number }) {
  const nomRef = useRef<THREE.Mesh>(null);
  const filtRef = useRef<THREE.Mesh>(null);
  const ellRef = useRef<THREE.Mesh>(null);
  const ellMat = useRef<THREE.MeshBasicMaterial>(null);
  const arrowRef = useRef<THREE.Group>(null);
  const arrowShaft = useRef<THREE.Mesh>(null);
  const arrowHead = useRef<THREE.Mesh>(null);
  const labelRef = useRef<THREE.Sprite>(null);
  const pulseRef = useRef<THREE.Mesh>(null);
  const pulseMat = useRef<THREE.MeshBasicMaterial>(null);
  const tex = useMemo(() => labelTexture(DRONE_NAMES[index] ?? String(index + 1), color), [index, color]);
  const pulse = useRef(0);

  useFrame((_, dt) => {
    const d = engine.view().drones[index];
    const vis = !!d;
    const p = d ? toThreeVec(d.p, tmp).clone() : new THREE.Vector3();
    if (nomRef.current) {
      nomRef.current.visible = vis && ghosts && !!d?.ref && d.mode < 3;
      if (d?.ref) nomRef.current.position.copy(toThreeVec(d.ref));
    }
    if (filtRef.current) {
      filtRef.current.visible = vis && ghosts && !!d?.refFiltered && d.mode < 3;
      if (d?.refFiltered) filtRef.current.position.copy(toThreeVec(d.refFiltered));
    }
    if (ellRef.current && ellMat.current) {
      ellRef.current.visible = vis && ellipsoid && d.mode < 3;
      ellRef.current.position.copy(p);
      const s = d?.nearestS ?? Infinity;
      ellMat.current.color.set(s < 1 ? '#ef4444' : s < 1.25 ? '#f59e0b' : color);
      ellMat.current.opacity = s < 1.25 ? 0.55 : 0.18;
    }
    if (arrowRef.current && arrowShaft.current && arrowHead.current) {
      const c = d?.correction;
      const mag = c ? Math.hypot(c.x, c.y, c.z) : 0;
      const show = vis && arrow && !!d?.intervened && mag > 0.05 && d.mode < 3;
      arrowRef.current.visible = show;
      if (show && c) {
        const len = Math.min(0.9, 0.06 * mag + 0.05);
        const dir = toThreeVec(c).normalize();
        arrowRef.current.position.copy(p);
        arrowRef.current.quaternion.setFromUnitVectors(UP, dir);
        arrowShaft.current.scale.set(1, len, 1);
        arrowShaft.current.position.set(0, len / 2, 0);
        arrowHead.current.position.set(0, len + 0.03, 0);
      }
    }
    // brief pulse on the drone when the filter intervenes
    if (d?.intervened) pulse.current = 1;
    pulse.current = Math.max(0, pulse.current - dt * 3);
    if (pulseRef.current && pulseMat.current) {
      pulseRef.current.visible = vis && pulse.current > 0.01 && d.mode < 3;
      pulseRef.current.position.copy(p);
      const sc = 0.08 * scale * (1 + 0.6 * (1 - pulse.current));
      pulseRef.current.scale.set(sc, sc, sc);
      pulseMat.current.opacity = 0.45 * pulse.current;
    }
    if (labelRef.current) {
      labelRef.current.visible = vis && label;
      labelRef.current.position.set(p.x, p.y + 0.1 + 0.04 * scale, p.z);
    }
  });

  return (
    <group>
      <mesh ref={nomRef} visible={false}>
        <sphereGeometry args={[0.035, 16, 12]} />
        <meshBasicMaterial color={color} transparent opacity={0.35} depthWrite={false} />
      </mesh>
      <mesh ref={filtRef} visible={false} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[0.05, 0.008, 8, 24]} />
        <meshBasicMaterial color="#fde047" transparent opacity={0.9} depthWrite={false} />
      </mesh>
      {/* single-drone downwash ellipsoid radii (0.12, 0.12, 0.30): two ellipsoids touch at s = 1 */}
      <mesh ref={ellRef} scale={[ELLIPSOID_RADII.x, ELLIPSOID_RADII.z, ELLIPSOID_RADII.y]} visible={false}>
        <sphereGeometry args={[1, 18, 12]} />
        <meshBasicMaterial ref={ellMat} color={color} wireframe transparent opacity={0.2} depthWrite={false} />
      </mesh>
      <group ref={arrowRef} visible={false}>
        <mesh ref={arrowShaft}>
          <cylinderGeometry args={[0.008, 0.008, 1, 8]} />
          <meshBasicMaterial color="#fde047" toneMapped={false} />
        </mesh>
        <mesh ref={arrowHead}>
          <coneGeometry args={[0.025, 0.06, 12]} />
          <meshBasicMaterial color="#fde047" toneMapped={false} />
        </mesh>
      </group>
      <mesh ref={pulseRef} visible={false}>
        <sphereGeometry args={[1, 16, 12]} />
        <meshBasicMaterial ref={pulseMat} color="#fde047" transparent opacity={0} depthWrite={false} toneMapped={false} />
      </mesh>
      <sprite ref={labelRef} scale={[0.09, 0.09, 0.09]} visible={false}>
        <spriteMaterial map={tex} depthTest={false} depthWrite={false} />
      </sprite>
    </group>
  );
}

/** Line between the closest pair with a live distance label. */
export function SeparationLine() {
  const line = useRef<THREE.Line>(null);
  const sprite = useRef<THREE.Sprite>(null);
  const mat = useRef<THREE.SpriteMaterial>(null);
  const last = useRef('');
  const geom = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    return g;
  }, []);
  const lineObj = useMemo(() => new THREE.Line(geom, new THREE.LineDashedMaterial({ color: '#e2e8f0', dashSize: 0.05, gapSize: 0.03, transparent: true, opacity: 0.85 })), [geom]);
  useFrame(() => {
    const view = engine.view();
    const cp = engine.closestPair(view);
    const L = lineObj;
    if (!cp || !line.current) {
      L.visible = false;
      if (sprite.current) sprite.current.visible = false;
      return;
    }
    L.visible = true;
    const a = view.drones[cp.i].p;
    const b = view.drones[cp.j].p;
    const arr = geom.getAttribute('position') as THREE.BufferAttribute;
    writeThree(arr.array as Float32Array, 0, a.x, a.y, a.z);
    writeThree(arr.array as Float32Array, 1, b.x, b.y, b.z);
    arr.needsUpdate = true;
    L.computeLineDistances();
    const color = cp.s < 1 ? '#ef4444' : cp.s < 1.25 ? '#f59e0b' : '#e2e8f0';
    (L.material as THREE.LineDashedMaterial).color.set(color);
    const text = `${(cp.d * 100).toFixed(0)} cm · s ${cp.s.toFixed(2)}`;
    if (sprite.current && mat.current) {
      sprite.current.visible = true;
      sprite.current.position.copy(toThreeVec({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 + 0.12 }));
      if (text + color !== last.current) {
        last.current = text + color;
        const t = textTexture(text, color);
        mat.current.map?.dispose();
        mat.current.map = t.tex;
        mat.current.needsUpdate = true;
        sprite.current.scale.set(0.07 * t.aspect, 0.07, 1);
      }
    }
  });
  return (
    <group>
      <primitive object={lineObj} ref={line} />
      <sprite ref={sprite} visible={false}>
        <spriteMaterial ref={mat} depthTest={false} depthWrite={false} />
      </sprite>
    </group>
  );
}
