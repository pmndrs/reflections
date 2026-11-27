// React Three Fiber: the engine page. The two rooms of engines/three (examples/shared/rooms.ts), written as JSX, with the
// same features through the `useReflections` hook (examples/r3f/src/useReflections.ts): one probe per room plus one in
// the doorway (as JSX too), screen-space reflections, the denoiser, and the ray-traced fallback on a switch.
//
// Needs: @react-three/fiber >= 10.0.0-alpha.6 (WebGPURenderer by default), react 19, three >= 0.187.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { Canvas, extend, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { ReflectionProbe, ReflectionProbes, createReflectionsRenderer, type Reflections } from '@pmndrs/reflections/three';
import { FfxReflectionDenoiser } from 'denoiser/ffx';
import { useReflections } from '../../r3f/src/useReflections';
import { mountShell } from '../../shell';

mountShell('engines/r3f');

// The probe classes as JSX elements.
const Probes = extend(ReflectionProbes);
const Probe = extend(ReflectionProbe);

type V3 = [number, number, number];
const VIEWS: Record<string, { pos: V3; target: V3 }> = {
  default: { pos: [0, 2.3, 8.5], target: [0, 2.05, 0] },
  ball: { pos: [-3.0, 1.6, 3.85], target: [-4.6, 0.3, 0.8] },
  table: { pos: [-1.3, 0.55, 2.3], target: [-4.2, 0.45, -0.2] },
  stale: { pos: [-2.9, 2.2, 3.7], target: [-4.8, 0.4, -1.5] },
  doorway: { pos: [6.6, 1.5, 1.9], target: [-4.0, 0.9, -0.4] },
  explore: { pos: [-6.2, 2.1, 3.1], target: [1.0, 1.0, -0.8] },
};

/** A shadowed mesh with a standard material (rooms.ts's `add` + `std`). */
function M({ children, color, roughness = 1, metalness = 0, cast = true, receive = true, ...props }: {
  children: ReactNode; color: number; roughness?: number; metalness?: number; cast?: boolean; receive?: boolean; position?: V3; rotation?: V3; userData?: object;
}) {
  return (
    <mesh castShadow={cast} receiveShadow={receive} {...props}>
      {children}
      <meshStandardMaterial color={color} roughness={roughness} metalness={metalness} />
    </mesh>
  );
}

/** Ben Houston's two rooms (three.js #35046), as in examples/shared/rooms.ts. */
function Rooms({ time }: { time: React.RefObject<number> }) {
  const knot = useRef<THREE.Mesh>(null);
  const ball = useRef<THREE.Mesh>(null);
  useFrame(() => {
    const t = time.current;
    knot.current!.rotation.y = t * 0.5;
    const phase = (t + 2.2) * 0.35;
    ball.current!.position.set(5.6 * Math.sin(phase), 1.2, 1.4 * Math.sin(2 * phase));
  });
  const gap = 1.25, side = 4 - gap;
  return (
    <>
      {/* the shell (x -8 to 8, z -4 to 4, y 0 to 5), the polished floor, the red and blue end walls */}
      <mesh position={[0, 2.5, 0]} receiveShadow>
        <boxGeometry args={[16, 5, 8]} />
        <meshStandardMaterial color={0xcccccc} side={THREE.BackSide} />
      </mesh>
      <M color={0x5c5650} roughness={0.12} cast={false} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.002, 0]}><planeGeometry args={[16, 8]} /></M>
      <M color={0xdd2200} cast={false} receive={false} rotation={[0, Math.PI / 2, 0]} position={[-7.99, 2.5, 0]}><planeGeometry args={[8, 5]} /></M>
      <M color={0x0044ff} cast={false} receive={false} rotation={[0, -Math.PI / 2, 0]} position={[7.99, 2.5, 0]}><planeGeometry args={[8, 5]} /></M>
      {/* the dividing wall with its doorway */}
      <M color={0xcccccc} position={[0, 2.5, -(gap + side / 2)]}><boxGeometry args={[0.3, 5, side]} /></M>
      <M color={0xcccccc} position={[0, 2.5, gap + side / 2]}><boxGeometry args={[0.3, 5, side]} /></M>
      <M color={0xcccccc} position={[0, 4.4, 0]}><boxGeometry args={[0.3, 1.2, gap * 2]} /></M>
      {/* left room: columns, a table with a gold sphere, steps */}
      {[-6, -2, 2, 6].flatMap((x) => [-2.5, 2.5].map((z) => (
        <M key={`${x},${z}`} color={0xeeeeee} position={[x, 2, z]}><cylinderGeometry args={[0.3, 0.3, 4, 16]} /></M>
      )))}
      <M color={0x886644} position={[-4, 1, 0]}><boxGeometry args={[2.4, 0.12, 1.4]} /></M>
      {[-5.05, -2.95].flatMap((x) => [-0.55, 0.55].map((z) => (
        <M key={`${x},${z}`} color={0x886644} receive={false} position={[x, 0.5, z]}><boxGeometry args={[0.1, 1, 0.1]} /></M>
      )))}
      <M color={0xffd700} roughness={0.4} metalness={0.3} position={[-4, 1.41, 0]}><sphereGeometry args={[0.35, 32, 32]} /></M>
      <M color={0xeeeeee} position={[-7, 0.25, 0]}><boxGeometry args={[1.5, 0.5, 1]} /></M>
      <M color={0xeeeeee} position={[-7, 0.5, 0]}><boxGeometry args={[1, 1, 1]} /></M>
      <M color={0xeeeeee} position={[-7, 0.75, 0]}><boxGeometry args={[0.5, 1.5, 1]} /></M>
      {/* right room: a plinth with a turning knot, a cone */}
      <M color={0xeeeeee} position={[4, 0.6, 0]}><boxGeometry args={[0.8, 1.2, 0.8]} /></M>
      <mesh ref={knot} position={[4, 1.65, 0]} castShadow receiveShadow>
        <torusKnotGeometry args={[0.3, 0.1, 64, 16]} />
        <meshStandardMaterial color={0xff44aa} roughness={0.5} metalness={0.2} />
      </mesh>
      <M color={0xeeeeee} position={[6.5, 1.25, -1.5]}><coneGeometry args={[0.4, 2.5, 5]} /></M>
      {/* a point light in each room */}
      {([[0xffaa44, -4], [0x88bbff, 4]] as const).map(([color, x]) => (
        <pointLight key={x} color={color} intensity={30} position={[x, 4.5, 0]} castShadow shadow-mapSize={[256, 256]} shadow-radius={12} shadow-bias={-0.002} />
      ))}
      {/* the mirror ball, kept out of the probe captures */}
      <mesh ref={ball} castShadow receiveShadow userData={{ reflectionProbeExclude: true }}>
        <sphereGeometry args={[0.54, 48, 32]} />
        <meshStandardMaterial color={0xffffff} roughness={0} metalness={1} />
      </mesh>
    </>
  );
}

interface Controls { ssr: boolean; rt: boolean; animate: boolean; view: string }

/** The probes as JSX: one per room, one in the doorway (rooms.ts's volumes); baked once the rooms are mounted. */
function RoomProbes({ onBaked }: { onBaked: (p: ReflectionProbes) => void }) {
  const { renderer, scene } = useThree() as unknown as { renderer: THREE.WebGPURenderer; scene: THREE.Scene };
  const probes = useRef<ReflectionProbes>(null);
  useEffect(() => {
    probes.current!.bake(renderer, scene, { near: 0.05, far: 60 });
    onBaked(probes.current!);
  }, [renderer, scene, onBaked]);
  // rooms.ts's volumes after floorProbe(): influence boxes reach 0.6 m below the floor, capture points and projection
  // boxes stay where the volumes were given (originOffset / projectionOffset)
  return (
    <Probes ref={probes}>
      <Probe args={[8.4, 5.8, 8.4]} position={[-4, 2.3, 0]} originOffset={[0, 0.2, 0]} projectionOffset={[0, 0.2, 0]} projectionSize={new THREE.Vector3(8, 5, 8)} />
      <Probe args={[8.4, 5.8, 8.4]} position={[4, 2.3, 0]} originOffset={[0, 0.2, 0]} projectionOffset={[0, 0.2, 0]} projectionSize={new THREE.Vector3(8, 5, 8)} />
      <Probe args={[2.4, 4.4, 2.5]} position={[0, 1.6, 0]} originOffset={[0, 0.3, 0]} projectionOffset={[0, 0.3, 0]} projectionSize={new THREE.Vector3(16, 3.8, 8)} />
    </Probes>
  );
}

/** Reflections through the hook; remounted (a `key`) when ray tracing switches, since that is fixed at creation. */
function Effects({ probes, controls, onReady }: { probes: ReflectionProbes; controls: Controls; onReady: (r: Reflections) => void }) {
  const reflections = useReflections({
    probes,
    rayTracing: controls.rt,
    denoiser: (device, { roughnessThreshold }) => new FfxReflectionDenoiser(device, { roughnessThreshold: roughnessThreshold ** 2 }),
  });
  useEffect(() => { if (reflections) onReady(reflections); }, [reflections, onReady]);
  useEffect(() => { if (reflections) setScreenSpace(reflections, controls.ssr); }, [reflections, controls.ssr]);
  return null;
}

/** The compare switch: off = no screen-space march, every reflection from the probes (or the rays). */
function setScreenSpace(reflections: Reflections, on: boolean) {
  const s = reflections.ssr.settings;
  if (on === (s.maxTraversalIntersections !== 0)) return;
  if (on) delete s.maxTraversalIntersections; else s.maxTraversalIntersections = 0;
  reflections.hybrid.resetHistory();
}

const orbit: { current: OrbitControls | null } = { current: null };
function setCameraView(camera: THREE.Camera, view: string) {
  const v = VIEWS[view] ?? VIEWS.default;
  camera.position.set(...v.pos);
  orbit.current?.target.set(...v.target);
  orbit.current?.update();
}

function Orbit({ view }: { view: string }) {
  const { camera, renderer } = useThree();
  useEffect(() => {
    const c = (orbit.current = new OrbitControls(camera, renderer.domElement as HTMLElement));
    c.enableDamping = true;
    return () => { c.dispose(); orbit.current = null; };
  }, [camera, renderer]);
  useEffect(() => setCameraView(camera, view), [camera, view]);
  useFrame(() => orbit.current?.update());
  return null;
}

/** The headless driver (scripts/run-headless.mjs): set once the reflections exist. */
function Driver({ reflections, time, setControls }: { reflections: Reflections | null; time: React.RefObject<number>; setControls: (f: (c: Controls) => Controls) => void }) {
  const state = useThree();
  useEffect(() => {
    if (!reflections) return;
    const draw = () => { state.advance(performance.now()); };
    (window as unknown as { __p: unknown }).__p = {
      stop() { paused.current = true; state.setFrameloop('never'); for (let i = 0; i < 60; i++) draw(); },
      async shot(n = 1) { for (let i = 0; i < n; i++) draw(); return (state.renderer.domElement as HTMLCanvasElement).toDataURL('image/png'); },
      // applied here and now (React state lands later), then the denoiser's history settles
      setCompare(on: boolean) { setScreenSpace(reflections, !on); setControls((c) => ({ ...c, ssr: !on })); for (let i = 0; i < 60; i++) draw(); },
      setView(view: string) { setCameraView(state.camera, view); reflections.hybrid.resetHistory(); setControls((c) => ({ ...c, view })); },
      setTime(t: number) { time.current = t; },
      info: () => ({ ready: true, probes: reflections.probes?.bakedProbes.length ?? 0, rt: !!reflections.trace }),
    };
  }, [reflections, state, time, setControls]);
  return null;
}

function App() {
  const [controls, setControls] = useState<Controls>({ ssr: true, rt: new URLSearchParams(location.search).get('rt') === '1', animate: true, view: 'default' });
  const [probes, setProbes] = useState<ReflectionProbes | null>(null);
  const [reflections, setReflections] = useState<Reflections | null>(null);
  const time = useRef(0);
  const set = (k: keyof Controls) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setControls((c) => ({ ...c, [k]: e.target instanceof HTMLInputElement ? e.target.checked : e.target.value }));
  return (
    <>
      <Canvas
        renderer={async (defaults) => {
          const renderer = await createReflectionsRenderer({ ...(defaults as object), antialias: false });
          renderer.shadowMap.enabled = true;
          renderer.shadowMap.type = THREE.PCFShadowMap;
          return renderer;
        }}
        camera={{ position: VIEWS.default.pos, fov: 50, near: 0.05, far: 60 }}
        scene={{ background: new THREE.Color(0x111111) }}
      >
        <Clock time={time} animate={controls.animate} />
        <Rooms time={time} />
        <RoomProbes onBaked={setProbes} />
        {probes && <Effects key={String(controls.rt)} probes={probes} controls={controls} onReady={setReflections} />}
        <Orbit view={controls.view} />
        <Driver reflections={reflections} time={time} setControls={setControls} />
      </Canvas>
      <div id="panel">
        <label className="check compare"><input type="checkbox" checked={controls.ssr} onChange={set('ssr')} /> Screen space</label>
        <label className="check"><input type="checkbox" checked={controls.rt} onChange={set('rt')} /> Ray-traced fallback</label>
        <label className="check"><input type="checkbox" checked={controls.animate} onChange={set('animate')} /> Animate</label>
        <label>View <select value={controls.view} onChange={set('view')}>{Object.keys(VIEWS).map((v) => <option key={v}>{v}</option>)}</select></label>
      </div>
      <pre id="status">
        {reflections
          ? `React Three Fiber: ${reflections.probes?.bakedProbes.length ?? 0} probes, screen space${reflections.trace ? ', ray-traced fallback' : ''}, FFX denoiser; drag to orbit`
          : 'baking the probes, building the reflections...'}
      </pre>
    </>
  );
}

/** The rooms' animation clock (seconds), advanced while Animate is on (and the driver has not stopped the page). */
const paused = { current: false };
function Clock({ time, animate }: { time: React.RefObject<number>; animate: boolean }) {
  useFrame((_, dt) => { if (animate && !paused.current) time.current += Math.min(dt, 0.05); });
  return null;
}

createRoot(document.getElementById('root')!).render(<App />);
