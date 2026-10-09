/**
 * Ring gates (octagonal PVC frames on stands or hanging from the truss) and obstacles, with
 * sequence numbers, next-gate glow per drone and pass / strike flashes.
 */
import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { gateFrame, GATE_TUBE_R, LEG_SPAN, pendulumState, POLE_R, sliderState } from '../../core/course';
import type { Course, Gate, Obstacle } from '../../core/types';
import type { Vec3 } from '../../core/vec';
import { engine } from '../engine';
import { toThreeVec, onLabelLayer } from './frames';
import { hazardTexture, labelTexture } from './textures';

const UP = new THREE.Vector3(0, 1, 0);

function Tube({ a, b, r, color, emissive, emissiveIntensity = 0, opacity = 1 }: { a: Vec3; b: Vec3; r: number; color: string; emissive?: string; emissiveIntensity?: number; opacity?: number }) {
  const { pos, quat, len } = useMemo(() => {
    const A = toThreeVec(a);
    const B = toThreeVec(b);
    const d = B.clone().sub(A);
    return { pos: A.clone().add(B).multiplyScalar(0.5), quat: new THREE.Quaternion().setFromUnitVectors(UP, d.clone().normalize()), len: d.length() };
  }, [a, b]);
  return (
    <mesh position={pos} quaternion={quat} castShadow>
      <cylinderGeometry args={[r, r, len, 10]} />
      <meshStandardMaterial color={color} emissive={emissive ?? color} emissiveIntensity={emissiveIntensity} roughness={0.45} metalness={0.05} transparent={opacity < 1} opacity={opacity} />
    </mesh>
  );
}

function GateMesh({ gate, index, number, ceiling }: { gate: Gate; index: number; number: string; ceiling: number }) {
  const f = useMemo(() => gateFrame(gate), [gate]);
  const glowRef = useRef<THREE.Group>(null);
  const flashRef = useRef<THREE.MeshBasicMaterial>(null);
  const flashState = useRef({ until: -1, color: '#22c55e', lastEvents: 0 });
  const glowMats = useRef<THREE.MeshBasicMaterial[]>([]);

  useFrame(({ clock }) => {
    const view = engine.view();
    // next-gate glow (first drone targeting this gate)
    const d = view.drones.findIndex((x) => x.nextGate === index && x.mode < 3);
    if (glowRef.current) {
      glowRef.current.visible = d >= 0;
      if (d >= 0) {
        const pulse = 0.35 + 0.25 * Math.sin(clock.elapsedTime * 6);
        glowMats.current.forEach((m) => {
          m.color.set(view.drones[d].color);
          m.opacity = pulse;
        });
      }
    }
    // pass / strike flash from new events
    const log = engine.log;
    const st = flashState.current;
    if (log && log.events.length !== st.lastEvents) {
      for (let k = st.lastEvents; k < log.events.length; k++) {
        const e = log.events[k];
        if (e.gate !== index) continue;
        if (e.type === 'gatePass') st.color = '#22c55e';
        else if (e.type === 'gateStrike' || e.type === 'gateMiss') st.color = '#ef4444';
        else continue;
        st.until = engine.time + 0.6;
      }
      st.lastEvents = log.events.length;
    }
    if (log && log.events.length < st.lastEvents) st.lastEvents = 0;
    if (flashRef.current) {
      const on = engine.time < st.until && engine.time > st.until - 0.7;
      flashRef.current.opacity = on ? 0.55 * ((st.until - engine.time) / 0.6) : 0;
      flashRef.current.color.set(st.color);
    }
  });

  const centre = toThreeVec(gate.center);
  const upQ = useMemo(() => {
    // orient a disc in the gate plane with its local +Y along the gate's up axis
    const m = new THREE.Matrix4().makeBasis(toThreeVec(f.l).normalize(), toThreeVec(f.u).normalize(), toThreeVec(f.n).normalize());
    return new THREE.Quaternion().setFromRotationMatrix(m);
  }, [f]);
  const bottom = { x: gate.center.x - (f.rIn + GATE_TUBE_R) * f.u.x, y: gate.center.y - (f.rIn + GATE_TUBE_R) * f.u.y, z: gate.center.z - (f.rIn + GATE_TUBE_R) * f.u.z };
  const top = { x: gate.center.x + (f.rIn + GATE_TUBE_R) * f.u.x, y: gate.center.y + (f.rIn + GATE_TUBE_R) * f.u.y, z: gate.center.z + (f.rIn + GATE_TUBE_R) * f.u.z };
  const tex = useMemo(() => labelTexture(number, gate.color), [number, gate.color]);
  return (
    <group>
      {/* frame edges */}
      {f.verts.map((v, k) => (
        <Tube key={k} a={v} b={f.verts[(k + 1) % 8]} r={GATE_TUBE_R} color={gate.color} emissiveIntensity={0.15} />
      ))}
      {/* corner connectors */}
      {f.verts.map((v, k) => (
        <mesh key={`c${k}`} position={toThreeVec(v)} castShadow>
          <sphereGeometry args={[GATE_TUBE_R * 1.45, 12, 10]} />
          <meshStandardMaterial color="#4b5563" roughness={0.6} />
        </mesh>
      ))}
      {/* next-gate glow */}
      <group ref={glowRef} position={centre} quaternion={upQ} visible={false}>
        <mesh rotation={[0, 0, Math.PI / 8]}>
          <torusGeometry args={[f.Rc * 1.02, GATE_TUBE_R * 2.2, 8, 8]} />
          <meshBasicMaterial ref={(m) => m && (glowMats.current[0] = m)} transparent opacity={0.4} depthWrite={false} toneMapped={false} />
        </mesh>
      </group>
      {/* pass / strike flash: translucent disc */}
      <mesh position={centre} quaternion={upQ}>
        <circleGeometry args={[f.rClear, 8, Math.PI / 8]} />
        <meshBasicMaterial ref={flashRef} transparent opacity={0} side={THREE.DoubleSide} depthWrite={false} toneMapped={false} />
      </mesh>
      {/* stand or cables */}
      {gate.mount === 'stand' ? (
        <>
          {bottom.z > 0.05 && <Tube a={bottom} b={{ x: bottom.x, y: bottom.y, z: 0.02 }} r={POLE_R} color="#9ca3af" />}
          <Tube a={{ x: bottom.x - 0.05 * f.l.x, y: bottom.y - 0.05 * f.l.y, z: bottom.z }} b={{ x: bottom.x + 0.05 * f.l.x, y: bottom.y + 0.05 * f.l.y, z: bottom.z }} r={POLE_R * 1.4} color="#4b5563" />
          {[0, 1, 2, 3].map((k) => {
            const ang = gate.yaw + Math.PI / 4 + (k * Math.PI) / 2;
            return <Tube key={`l${k}`} a={{ x: bottom.x, y: bottom.y, z: 0.02 }} b={{ x: bottom.x + (LEG_SPAN / 2) * Math.cos(ang), y: bottom.y + (LEG_SPAN / 2) * Math.sin(ang), z: 0.02 }} r={POLE_R} color="#6b7280" />;
          })}
        </>
      ) : (
        [1, 2].map((k) => <Tube key={`cab${k}`} a={f.verts[k]} b={{ x: f.verts[k].x, y: f.verts[k].y, z: ceiling }} r={0.004} color="#cbd5e1" />)
      )}
      {/* number badge above the gate */}
      <sprite position={toThreeVec({ x: top.x, y: top.y, z: top.z + 0.16 })} scale={[0.2, 0.2, 0.2]} onUpdate={onLabelLayer}>
        <spriteMaterial map={tex} depthWrite={false} />
      </sprite>
    </group>
  );
}

function PillarMesh({ o }: { o: Extract<Obstacle, { kind: 'pillar' }> }) {
  const tex = useMemo(() => {
    const t = hazardTexture().clone();
    t.needsUpdate = true;
    t.repeat.set(Math.max(1, Math.round((2 * Math.PI * o.radius) / 0.2)), Math.max(1, Math.round(o.height / 0.2)));
    return t;
  }, [o.radius, o.height]);
  return (
    <mesh position={toThreeVec({ x: o.x, y: o.y, z: o.height / 2 })} castShadow receiveShadow>
      <cylinderGeometry args={[o.radius, o.radius, o.height, 24]} />
      <meshStandardMaterial map={tex} roughness={0.7} />
    </mesh>
  );
}

function BoxMesh({ o }: { o: Extract<Obstacle, { kind: 'box' }> }) {
  const color = o.label === 'banner' ? '#7c3aed' : o.label === 'wall' ? '#64748b' : '#a16207';
  return (
    <mesh position={toThreeVec(o.center)} rotation={[0, o.yaw, 0]} castShadow receiveShadow>
      <boxGeometry args={[o.size.x, o.size.z, o.size.y]} />
      <meshStandardMaterial color={color} roughness={0.8} transparent={o.label === 'banner'} opacity={o.label === 'banner' ? 0.85 : 1} />
    </mesh>
  );
}

function PendulumMesh({ o, dynamicOn }: { o: Extract<Obstacle, { kind: 'pendulum' }>; dynamicOn: boolean }) {
  const bob = useRef<THREE.Mesh>(null);
  const cable = useRef<THREE.Mesh>(null);
  useFrame(() => {
    const s = pendulumState(o, dynamicOn ? engine.time : 0);
    const B = toThreeVec(s.bob);
    const P = toThreeVec(o.pivot);
    if (bob.current) bob.current.position.copy(B);
    if (cable.current) {
      const d = B.clone().sub(P);
      cable.current.position.copy(P.clone().add(B).multiplyScalar(0.5));
      cable.current.quaternion.setFromUnitVectors(UP, d.clone().normalize());
      cable.current.scale.set(1, d.length(), 1);
    }
  });
  return (
    <group>
      <mesh ref={cable}>
        <cylinderGeometry args={[0.006, 0.006, 1, 6]} />
        <meshStandardMaterial color="#cbd5e1" />
      </mesh>
      <mesh ref={bob} castShadow>
        <sphereGeometry args={[o.bobRadius, 24, 18]} />
        <meshStandardMaterial map={hazardTexture()} roughness={0.5} />
      </mesh>
    </group>
  );
}

function SliderMesh({ o, dynamicOn }: { o: Extract<Obstacle, { kind: 'slider' }>; dynamicOn: boolean }) {
  const ref = useRef<THREE.Mesh>(null);
  useFrame(() => {
    const s = sliderState(o, dynamicOn ? engine.time : 0);
    if (ref.current) ref.current.position.copy(toThreeVec(s.c));
  });
  const tex = useMemo(() => {
    const t = hazardTexture().clone();
    t.needsUpdate = true;
    t.repeat.set(Math.max(1, Math.round(o.size.x / 0.25)), Math.max(1, Math.round(o.size.z / 0.25)));
    return t;
  }, [o.size.x, o.size.z]);
  return (
    <group>
      {/* rail */}
      <mesh position={toThreeVec({ x: o.center.x, y: o.center.y, z: o.center.z + o.size.z / 2 + 0.03 })} rotation={[0, o.yaw, 0]}>
        <boxGeometry args={[o.size.x + 2 * o.travel, 0.03, 0.04]} />
        <meshStandardMaterial color="#475569" />
      </mesh>
      <mesh ref={ref} rotation={[0, o.yaw, 0]} castShadow>
        <boxGeometry args={[o.size.x, o.size.z, o.size.y]} />
        <meshStandardMaterial map={tex} roughness={0.6} />
      </mesh>
    </group>
  );
}

/** Sequence number labels: a gate visited twice shows both numbers. */
function gateNumbers(course: Course): string[] {
  const nums: string[][] = course.gates.map(() => []);
  course.sequence.forEach((v, k) => nums[v.gate]?.push(String(k + 1)));
  return nums.map((n) => (n.length ? n.join('/') : '–'));
}

export function CourseView({ course, ceiling, dynamicOn }: { course: Course; ceiling: number; dynamicOn: boolean }) {
  const numbers = useMemo(() => gateNumbers(course), [course]);
  return (
    <group>
      {course.gates.map((g, i) => (
        <GateMesh key={g.id + i} gate={g} index={i} number={numbers[i]} ceiling={ceiling} />
      ))}
      {course.obstacles.map((o) => {
        switch (o.kind) {
          case 'pillar':
            return <PillarMesh key={o.id} o={o} />;
          case 'box':
            return <BoxMesh key={o.id} o={o} />;
          case 'pendulum':
            return <PendulumMesh key={o.id} o={o} dynamicOn={dynamicOn} />;
          case 'slider':
            return <SliderMesh key={o.id} o={o} dynamicOn={dynamicOn} />;
        }
      })}
    </group>
  );
}
