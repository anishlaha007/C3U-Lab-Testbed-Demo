/**
 * Low-poly Crazyflie: X frame (92 mm motor diagonal), PCB body, four motors with spinning props
 * and a coloured LED. Built in the three.js body frame: +X forward, +Y up (thrust), +Z right.
 */
import { forwardRef, useImperativeHandle, useRef } from 'react';
import * as THREE from 'three';

export interface DroneModelHandle {
  group: THREE.Group;
  /** Advance prop rotation by the given angle (rad). */
  spin(angle: number): void;
  setLed(intensity: number): void;
}

const ARM = 0.046; // centre to motor (m)
const PROP_R = 0.0235;

export const DroneModel = forwardRef<DroneModelHandle, { color: string; scale: number; ghost?: boolean }>(function DroneModel(
  { color, scale, ghost = false },
  ref,
) {
  const group = useRef<THREE.Group>(null!);
  const props = useRef<THREE.Group[]>([]);
  const led = useRef<THREE.MeshStandardMaterial>(null!);
  useImperativeHandle(ref, () => ({
    get group() {
      return group.current;
    },
    spin(angle: number) {
      props.current.forEach((p, i) => {
        if (p) p.rotation.y += i % 2 === 0 ? angle : -angle;
      });
    },
    setLed(intensity: number) {
      if (led.current) led.current.emissiveIntensity = intensity;
    },
  }));
  const motors = [0, 1, 2, 3].map((k) => {
    const ang = Math.PI / 4 + (k * Math.PI) / 2;
    return [Math.cos(ang) * ARM, Math.sin(ang) * ARM] as const;
  });
  const opacity = ghost ? 0.35 : 1;
  return (
    <group ref={group}>
      <group scale={scale}>
        {/* X frame arms */}
        {[Math.PI / 4, -Math.PI / 4].map((r, i) => (
          <mesh key={i} rotation={[0, r, 0]} castShadow>
            <boxGeometry args={[ARM * 2, 0.0025, 0.004]} />
            <meshStandardMaterial color="#d4d4d8" roughness={0.6} transparent={ghost} opacity={opacity} />
          </mesh>
        ))}
        {/* PCB body */}
        <mesh position={[0, 0.0015, 0]} castShadow>
          <boxGeometry args={[0.034, 0.0018, 0.034]} />
          <meshStandardMaterial color="#14532d" roughness={0.5} transparent={ghost} opacity={opacity} />
        </mesh>
        {/* battery */}
        <mesh position={[0, -0.004, 0]} castShadow>
          <boxGeometry args={[0.03, 0.006, 0.016]} />
          <meshStandardMaterial color="#334155" roughness={0.4} transparent={ghost} opacity={opacity} />
        </mesh>
        {/* markers */}
        {[
          [0.012, 0.012],
          [-0.012, 0.01],
          [0.004, -0.013],
        ].map(([x, z], i) => (
          <mesh key={`m${i}`} position={[x, 0.009, z]}>
            <sphereGeometry args={[0.0035, 10, 8]} />
            <meshStandardMaterial color="#e5e7eb" roughness={0.2} metalness={0.3} />
          </mesh>
        ))}
        {/* LED */}
        <mesh position={[0.016, 0.004, 0]}>
          <sphereGeometry args={[0.004, 10, 8]} />
          <meshStandardMaterial ref={led} color={color} emissive={color} emissiveIntensity={3} toneMapped={false} />
        </mesh>
        {motors.map(([x, z], k) => (
          <group key={k} position={[x, 0, z]}>
            <mesh castShadow>
              <cylinderGeometry args={[0.0042, 0.0042, 0.012, 10]} />
              <meshStandardMaterial color="#111827" metalness={0.6} roughness={0.3} transparent={ghost} opacity={opacity} />
            </mesh>
            <group
              position={[0, 0.0075, 0]}
              ref={(g) => {
                if (g) props.current[k] = g;
              }}
            >
              <mesh>
                <boxGeometry args={[PROP_R * 2, 0.0008, 0.005]} />
                <meshStandardMaterial color={k < 2 ? color : '#e5e7eb'} transparent opacity={ghost ? 0.25 : 0.85} />
              </mesh>
              {/* motion blur disc */}
              <mesh rotation={[-Math.PI / 2, 0, 0]}>
                <circleGeometry args={[PROP_R, 20]} />
                <meshBasicMaterial color={color} transparent opacity={0.12} side={THREE.DoubleSide} depthWrite={false} />
              </mesh>
            </group>
          </group>
        ))}
      </group>
    </group>
  );
});
