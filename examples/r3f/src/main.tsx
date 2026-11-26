// React Three Fiber + @pmndrs/reflections. R3F v10 renders with WebGPURenderer by default; the
// `renderer` prop takes a factory, which is where the reflection passes' device limits go.
//
// Needs: @react-three/fiber >= 10.0.0-alpha.6 (the alpha tag), react 19, three >= 0.187.
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { createReflectionsRenderer } from '@pmndrs/reflections/three';
// Optional, but glossy reflections are noisy without it. In your project: `import { FfxReflectionDenoiser } from 'denoiser/ffx'`
// (`denoiser` ^2.0.0 from npm).
import { FfxReflectionDenoiser } from 'denoiser/ffx';
import { useReflections } from './useReflections';

const q = new URLSearchParams(location.search);
const Ffx = q.get('denoise') !== '0' ? FfxReflectionDenoiser : null;

/** Your scene: plain R3F. */
function Scene() {
  const { renderer, scene } = useThree() as unknown as { renderer: THREE.WebGPURenderer; scene: THREE.Scene };
  const knot = useRef<THREE.Mesh>(null);
  const [envReady, setEnvReady] = useState(false);

  // A room environment as lighting and backdrop (a probe captured from the scene sees the backdrop).
  useEffect(() => {
    scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
    scene.background = scene.environment;
    setEnvReady(true);
  }, [renderer, scene]);

  // Reflections: one hook. `enabled` waits for the environment (the probe bakes what the scene shows).
  const reflections = useReflections({
    enabled: envReady,
    preset: q.get('preset') === 'performance' ? 'performance' : 'default',
    rayTracing: q.get('rt') === '1',
    denoiser: Ffx && ((device, { roughnessThreshold }) => new Ffx(device, { roughnessThreshold: roughnessThreshold ** 2 })),
  });

  // headless driver (scripts/run-headless.mjs, section `r3f`)
  const state = useThree();
  const flags = useRef({ on: true, paused: false });
  useEffect(() => {
    (window as unknown as { __p: unknown }).__p = {
      stop() { flags.current.paused = true; state.setFrameloop('never'); },
      setOn(v: boolean) { flags.current.on = v; },
      async shot(n = 1) {
        const canvas = state.renderer.domElement as HTMLCanvasElement;
        for (let i = 0; i < n; i++) { if (flags.current.on && reflections) reflections.render(state.camera); else (renderer as THREE.WebGPURenderer).render(scene, state.camera); }
        return canvas.toDataURL('image/png');
      },
      info: () => ({ ready: !!reflections, denoiser: !!reflections?.hybrid.denoiser, probes: !!reflections?.probes, rt: !!reflections?.trace }),
    };
    // `useReflections` already draws every frame; the page's own switch is only for the check
  }, [reflections, renderer, scene, state]);
  useFrame((_, dt) => { if (knot.current && !flags.current.paused) knot.current.rotation.y += dt * 0.4; });

  return (
    <>
      <directionalLight position={[3, 6, 2]} intensity={1.6} />
      <mesh rotation-x={-Math.PI / 2}>
        <circleGeometry args={[6, 64]} />
        <meshStandardMaterial color={0x20242b} roughness={0.08} />
      </mesh>
      <mesh position={[-1.3, 0.7, 0]}>
        <sphereGeometry args={[0.7, 64, 32]} />
        <meshStandardMaterial color={0xffc766} roughness={0.18} metalness={1} />
      </mesh>
      <mesh position={[0.5, 0.5, -0.8]} rotation-y={0.5}>
        <boxGeometry />
        <meshStandardMaterial color={0xd22c2c} roughness={0.4} />
      </mesh>
      <mesh ref={knot} position={[1.9, 0.75, 0.9]}>
        <torusKnotGeometry args={[0.45, 0.15, 160, 24]} />
        <meshStandardMaterial color={0xffffff} roughness={0.05} metalness={1} />
      </mesh>
      <mesh position={[-0.2, 0.63, 1.6]}>
        <capsuleGeometry args={[0.28, 0.7, 8, 24]} />
        <meshStandardMaterial color={0x1fb7a6} roughness={0.25} metalness={0.1} />
      </mesh>
      <Orbit />
    </>
  );
}

function Orbit() {
  const { camera, renderer } = useThree();
  useEffect(() => {
    const c = new OrbitControls(camera, renderer.domElement as HTMLElement);
    c.target.set(0, 0.6, 0.3);
    c.enableDamping = true;
    return () => c.dispose();
  }, [camera, renderer]);
  return null;
}

createRoot(document.getElementById('root')!).render(
  <Canvas
    renderer={(defaults) => createReflectionsRenderer({ ...(defaults as object), antialias: false })}
    camera={{ position: [3.4, 2.2, 4.6], fov: 45 }}
  >
    <Scene />
  </Canvas>,
);
