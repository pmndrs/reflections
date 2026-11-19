// useReflections: the React Three Fiber glue for `Reflections` (@pmndrs/reflections/three).
//
// It lives in the example first. If it proves useful it could become an `@pmndrs/reflections/react`
// entry; today it is about thirty lines on top of the package's `Reflections.create`.
//
//   function Effects() {
//     const reflections = useReflections({ preset: 'default' });   // null until built
//     return null;
//   }
//
// While the object is being built (it is async: the cube-array check, the probe bake, the BVH) the
// hook draws the scene the plain way, so the canvas is never blank. Once it is ready it draws every
// frame through `reflections.render(camera)`. `enabled: false` waits (for an environment that is
// still loading, say); changing `options` does not rebuild it: use `key` on the component for that.
import { useEffect, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import type * as THREE from 'three/webgpu';
import { Reflections, type ReflectionsOptions } from '@pmndrs/reflections/three';

export function useReflections(options: ReflectionsOptions & { enabled?: boolean } = {}) {
  const { renderer, scene } = useThree() as unknown as { renderer: THREE.WebGPURenderer; scene: THREE.Scene };
  const [reflections, setReflections] = useState<Reflections | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const enabled = options.enabled ?? true;

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let made: Reflections | null = null;
    Reflections.create(renderer, scene, optionsRef.current).then((r) => {
      if (cancelled) r.dispose(); else { made = r; setReflections(r); }
    }, (e) => console.error('useReflections:', e));
    return () => { cancelled = true; made?.dispose(); setReflections(null); };
  }, [renderer, scene, enabled]);

  // A job in the 'render' phase takes over R3F's own render call; this draws the frame instead.
  useFrame(({ renderer, scene, camera }) => {
    if (reflections) reflections.render(camera);
    else (renderer as THREE.WebGPURenderer).render(scene, camera);
  }, { phase: 'render' });

  return reflections;
}
