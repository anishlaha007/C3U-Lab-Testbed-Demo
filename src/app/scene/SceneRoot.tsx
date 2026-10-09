/** three.js canvas: lights, arena, Vicon cameras, drones, trails and camera controls. */
import { OrbitControls } from '@react-three/drei';
import { Canvas, useFrame } from '@react-three/fiber';
import { engine } from '../engine';
import { Arena } from './Arena';
import { DroneActor } from './DroneActor';
import { Trail } from './Trail';
import { ViconCameras } from './ViconCameras';

function EngineTicker() {
  useFrame((_, dt) => engine.advance(Math.min(dt, 0.1)));
  return null;
}

export function SceneRoot({ dark }: { dark: boolean }) {
  const arena = { sx: 8, sy: 5, sz: 3 };
  const bg = dark ? '#070b14' : '#e8eef5';
  return (
    <Canvas shadows dpr={[1, 2]} camera={{ position: [5.5, 4.2, 6.5], fov: 45, near: 0.02, far: 200 }} gl={{ antialias: true, preserveDrawingBuffer: true }}>
      <color attach="background" args={[bg]} />
      <fog attach="fog" args={[bg, 18, 40]} />
      <ambientLight intensity={dark ? 0.55 : 0.7} />
      <hemisphereLight args={[dark ? '#93c5fd' : '#ffffff', dark ? '#0f172a' : '#cbd5e1', dark ? 0.45 : 0.6]} />
      <directionalLight
        position={[4, 9, 3]}
        intensity={dark ? 1.6 : 1.8}
        castShadow
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-camera-left={-7}
        shadow-camera-right={7}
        shadow-camera-top={7}
        shadow-camera-bottom={-7}
        shadow-camera-far={30}
      />
      <EngineTicker />
      <Arena arena={arena} dark={dark} />
      <ViconCameras arena={arena} />
      <DroneActor index={0} getView={() => engine.view()} color="#38bdf8" scale={3} />
      <Trail getPoints={() => engine.trailPoints(0, 4)} color="#38bdf8" colorBy="speed" vmax={1.2} background={bg} />
      <OrbitControls target={[0, 1, 0]} makeDefault maxPolarAngle={Math.PI * 0.495} />
    </Canvas>
  );
}
