/**
 * Camera modes: Orbit (default), Follow (F cycles drones), Top-down (T), Chase, Side, FPV (V,
 * first-person with a wide lens) and Auto-cinematic (cuts between gates). Transitions are smoothed.
 */
import { OrbitControls } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { gateFrame } from '../../core/course';
import { engine } from '../engine';
import { useStore } from '../store';
import { LABEL_LAYER, toThreeVec } from './frames';

const tmpPos = new THREE.Vector3();
const tmpLook = new THREE.Vector3();

export function CameraRig() {
  const camera = useStore((s) => s.camera);
  const follow = useStore((s) => s.followIndex);
  const { camera: cam } = useThree();
  const controls = useRef<OrbitControlsImpl>(null);
  const look = useRef(new THREE.Vector3(0, 1, 0));
  const cine = useRef({ gate: -2, pos: new THREE.Vector3(5, 3, 5), lastCut: 0, idx: 0 });
  // the user's orbit view, saved when leaving orbit and flown back to on return (otherwise the
  // camera would stay wherever FPV or chase left it, e.g. inside a drone)
  const orbitPose = useRef({ pos: new THREE.Vector3(5.5, 4.2, 6.5), target: new THREE.Vector3(0, 1, 0) });
  const prevMode = useRef(camera);
  const returning = useRef<{ t: number } | null>(null);

  useEffect(() => {
    const persp = cam as THREE.PerspectiveCamera;
    persp.fov = camera === 'fpv' ? 100 : camera === 'chase' ? 70 : 45;
    persp.near = camera === 'fpv' ? 0.01 : 0.02;
    persp.updateProjectionMatrix();
    if (camera === 'fpv') cam.layers.disable(LABEL_LAYER);
    else cam.layers.enable(LABEL_LAYER);
    const prev = prevMode.current;
    if (prev === 'orbit' && camera !== 'orbit' && controls.current) {
      orbitPose.current.pos.copy(cam.position);
      orbitPose.current.target.copy(controls.current.target);
    }
    if (camera === 'orbit' && prev !== 'orbit') returning.current = { t: 0 };
    prevMode.current = camera;
  }, [camera, cam]);

  useFrame((_, dt) => {
    if (camera === 'orbit') {
      const c = controls.current;
      const r = returning.current;
      if (c && r) {
        r.t += dt;
        const k = 1 - Math.exp(-dt * 6);
        cam.position.lerp(orbitPose.current.pos, k);
        c.target.lerp(orbitPose.current.target, k);
        if (r.t > 1.5 || cam.position.distanceTo(orbitPose.current.pos) < 0.01) {
          cam.position.copy(orbitPose.current.pos);
          c.target.copy(orbitPose.current.target);
          returning.current = null;
        }
        c.update();
      }
      if (c) look.current.copy(c.target);
      return;
    }
    const view = engine.view();
    const n = view.drones.length;
    const d = n ? view.drones[Math.min(follow, n - 1)] : null;
    const arena = engine.build?.arena ?? { sx: 8, sy: 5, sz: 3 };
    let snap = false;
    if (camera === 'top') {
      tmpPos.set(0, Math.max(arena.sx, arena.sy) * 1.25 + 2, 0.01);
      tmpLook.set(0, 0, 0);
    } else if (!d) {
      tmpPos.set(5.5, 4.2, 6.5);
      tmpLook.set(0, 1, 0);
    } else {
      const p = toThreeVec(d.p);
      const vel = toThreeVec(d.v);
      const sp = vel.length();
      const fwd = sp > 0.15 ? vel.clone().normalize() : new THREE.Vector3(Math.cos(d.yaw), 0, -Math.sin(d.yaw));
      const fwdH = new THREE.Vector3(fwd.x, 0, fwd.z);
      if (fwdH.lengthSq() < 1e-6) fwdH.set(1, 0, 0);
      fwdH.normalize();
      if (camera === 'follow') {
        tmpPos.copy(p).addScaledVector(fwdH, -1.6).add(new THREE.Vector3(0, 0.9, 0));
        tmpLook.copy(p);
      } else if (camera === 'chase') {
        tmpPos.copy(p).addScaledVector(fwdH, -0.55).add(new THREE.Vector3(0, 0.18, 0));
        tmpLook.copy(p).addScaledVector(fwdH, 1.0);
      } else if (camera === 'side') {
        const side = new THREE.Vector3(-fwdH.z, 0, fwdH.x);
        tmpPos.copy(p).addScaledVector(side, 2.2).add(new THREE.Vector3(0, 0.3, 0));
        tmpLook.copy(p);
      } else if (camera === 'fpv') {
        // first person: just ahead of the drone body, looking along the velocity
        tmpPos.copy(p).addScaledVector(fwd, 0.06).add(new THREE.Vector3(0, 0.03, 0));
        tmpLook.copy(p).addScaledVector(fwd, 2.0);
        snap = true;
      } else if (camera === 'cinematic') {
        const c = cine.current;
        const course = engine.build?.course;
        // leader = drone with the most progress through the gates
        const lead = view.drones.reduce((best, x, i) => (x.mode < 3 && (best < 0 || x.nextGate > view.drones[best].nextGate) ? i : best), -1);
        const L = lead >= 0 ? view.drones[lead] : d;
        const Lp = toThreeVec(L.p);
        if (course && L.nextGate >= 0) {
          if (L.nextGate !== c.gate) {
            c.gate = L.nextGate;
            const g = course.gates[L.nextGate];
            const f = gateFrame(g);
            // viewpoint just past the gate, off to the side and slightly above
            const vp = { x: g.center.x + f.n.x * 1.4 + f.l.x * 1.1, y: g.center.y + f.n.y * 1.4 + f.l.y * 1.1, z: Math.min(arena.sz - 0.2, g.center.z + 0.5) };
            c.pos.copy(toThreeVec(vp));
            snap = true;
          }
        } else if (engine.time - c.lastCut > 4 || c.gate !== -1) {
          c.gate = -1;
          c.lastCut = engine.time;
          c.idx = (c.idx + 1) % 4;
          const vps = [
            { x: arena.sx / 2 - 0.4, y: arena.sy / 2 - 0.4, z: 2.2 },
            { x: -arena.sx / 2 + 0.4, y: arena.sy / 2 - 0.4, z: 1.2 },
            { x: -arena.sx / 2 + 0.4, y: -arena.sy / 2 + 0.4, z: 2.4 },
            { x: arena.sx / 2 - 0.4, y: -arena.sy / 2 + 0.4, z: 0.8 },
          ];
          c.pos.copy(toThreeVec(vps[c.idx]));
          snap = true;
        }
        tmpPos.copy(c.pos);
        tmpLook.copy(Lp);
      }
    }
    const k = snap ? 1 : 1 - Math.exp(-dt * (camera === 'chase' ? 10 : 5));
    cam.position.lerp(tmpPos, k);
    look.current.lerp(tmpLook, camera === 'fpv' || camera === 'chase' ? 1 : k);
    cam.lookAt(look.current);
  });

  return <OrbitControls ref={controls} enabled={camera === 'orbit'} target={[0, 1, 0]} makeDefault maxPolarAngle={Math.PI * 0.495} minDistance={0.3} maxDistance={40} />;
}
