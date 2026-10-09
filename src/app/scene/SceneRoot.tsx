/** three.js canvas: lights, arena, cameras, course, drones, trails, overlays and camera rig. */
import { Canvas, useFrame } from '@react-three/fiber';
import { EffectComposer, Vignette } from '@react-three/postprocessing';
import { LensDistortionEffect } from 'postprocessing';
import { useMemo, useSyncExternalStore } from 'react';
import * as THREE from 'three';
import { engine } from '../engine';
import { useStore } from '../store';
import { Arena } from './Arena';
import { CameraRig } from './CameraRig';
import { CourseView } from './CourseView';
import { DroneActor } from './DroneActor';
import { DroneOverlays, SeparationLine } from './DroneOverlays';
import { CollisionBursts } from './Effects';
import { PlannedPath, Polyline, RacingLine } from './Paths';
import { Trail } from './Trail';
import { ViconCameras } from './ViconCameras';

function EngineTicker() {
  const bump = useStore((s) => s.bump);
  useFrame((state, dt) => {
    engine.frame(Math.min(dt, 0.1));
    // re-render the panels at about 8 Hz while something moves
    const ud = state.scene.userData as { lastBump?: number };
    const now = state.clock.elapsedTime;
    if ((engine.playing || engine.replayPlaying) && now - (ud.lastBump ?? 0) > 0.125) {
      ud.lastBump = now;
      bump();
    }
  });
  return null;
}

export function useEngineGeneration(): number {
  return useSyncExternalStore(
    (cb) => engine.subscribe(cb),
    () => engine.generation,
  );
}

function SceneContent({ dark }: { dark: boolean }) {
  const gen = useEngineGeneration();
  const visuals = useStore((s) => s.visuals);
  const config = useStore((s) => s.config);
  const hoverCell = useStore((s) => s.hoverCell);
  const plan = useStore((s) => s.plan);
  const build = engine.build;
  const arena = build?.arena ?? config.arena;
  const bg = dark ? '#070b14' : '#e8eef5';
  const n = build?.trajectories.length ?? 0;
  const colors = Array.from({ length: n }, (_, i) => config.drones[i]?.color ?? '#94a3b8');
  const vmax = trailSpeedMax();
  const hoverPreviews =
    hoverCell && plan && plan.candidates.length >= 2
      ? [plan.candidates[0][hoverCell[0]]?.preview, plan.candidates[1][hoverCell[1]]?.preview]
      : null;
  return (
    <group key={gen}>
      <Arena arena={arena} dark={dark} showNets={visuals.nets} />
      <ViconCameras arena={arena} frustums={visuals.frustums} />
      {build?.course && <CourseView course={build.course} ceiling={arena.sz + 0.1} dynamicOn={config.course.dynamicObstacles} />}
      {build?.track && visuals.racingLine && <RacingLine track={build.track} />}
      {visuals.searchPath && build?.searchPaths?.map((p, i) => <Polyline key={`sp${i}`} pts={p} color="#f472b6" opacity={0.45} dashed />)}
      {visuals.commandedPath &&
        build?.trajectories.map((tr, i) => <PlannedPath key={`pp${i}`} traj={tr} color={colors[i]} feas={engine.validation?.feasibility[i]} />)}
      {hoverPreviews?.map((p, i) => (p ? <Polyline key={`hv${i}`} pts={p} color={colors[i]} width={2.5} opacity={0.8} /> : null))}
      {Array.from({ length: n }, (_, i) => (
        <group key={`d${i}`}>
          <DroneActor index={i} color={colors[i]} scale={visuals.exaggerate} />
          <DroneOverlays index={i} color={colors[i]} ghosts={visuals.ghosts} ellipsoid={visuals.ellipsoids && n > 1} arrow={visuals.arrows} label={visuals.labels} scale={visuals.exaggerate} />
          {visuals.trails && <Trail getPoints={() => engine.trailPoints(i, visuals.trailLength)} color={colors[i]} colorBy={visuals.trailColor} vmax={vmax} background={bg} />}
        </group>
      ))}
      {visuals.separation && n > 1 && <SeparationLine />}
      <CollisionBursts />
    </group>
  );
}

/** Highest planned speed of the current build: the top of the trail speed colour map. */
export function trailSpeedMax(): number {
  const build = engine.build;
  return build ? Math.max(1, ...build.trajectories.map((tr) => maxSpeed(tr) * build.k)) : 2;
}

/**
 * FPV lens: barrel distortion so the first-person view reads like real drone-racing footage. The
 * focal length 1 / (1 + k) keeps the edge midpoints on the frame edges; the corners fall outside
 * the source image and are masked, which together with the vignette gives the round fisheye look.
 * Mounted only in FPV, so the other views render without a post-processing pass.
 */
function FpvLens() {
  const k = 0.3;
  const lens = useMemo(() => new LensDistortionEffect({ distortion: new THREE.Vector2(k, k), principalPoint: new THREE.Vector2(0, 0), focalLength: new THREE.Vector2(1 / (1 + k), 1 / (1 + k)) }), []);
  return (
    <EffectComposer multisampling={4}>
      <primitive object={lens} />
      <Vignette offset={0.25} darkness={0.65} />
    </EffectComposer>
  );
}

function maxSpeed(tr: { vx: Float64Array; vy: Float64Array; vz: Float64Array }): number {
  let m = 0;
  for (let i = 0; i < tr.vx.length; i += 5) m = Math.max(m, Math.hypot(tr.vx[i], tr.vy[i], tr.vz[i]));
  return m;
}

export function SceneRoot({ dark }: { dark: boolean }) {
  const bg = dark ? '#070b14' : '#e8eef5';
  const fpv = useStore((s) => s.camera === 'fpv');
  // the course editor is a full-screen modal: stop rendering (and the simulation clock) behind it
  const paused = useStore((s) => s.editorOpen);
  return (
    <Canvas frameloop={paused ? 'never' : 'always'} shadows dpr={[1, 2]} camera={{ position: [5.5, 4.2, 6.5], fov: 45, near: 0.02, far: 200 }} gl={{ antialias: true, preserveDrawingBuffer: true }}>
      <color attach="background" args={[bg]} />
      <fog attach="fog" args={[bg, 20, 45]} />
      <ambientLight intensity={dark ? 0.55 : 0.7} />
      <hemisphereLight args={[dark ? '#93c5fd' : '#ffffff', dark ? '#0f172a' : '#cbd5e1', dark ? 0.45 : 0.6]} />
      <directionalLight
        position={[4, 9, 3]}
        intensity={dark ? 1.6 : 1.8}
        castShadow
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-camera-left={-8}
        shadow-camera-right={8}
        shadow-camera-top={8}
        shadow-camera-bottom={-8}
        shadow-camera-far={30}
      />
      <EngineTicker />
      <SceneContent dark={dark} />
      <CameraRig />
      {fpv && <FpvLens />}
    </Canvas>
  );
}
