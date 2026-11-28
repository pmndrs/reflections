// Visualizes a ReflectionProbes set: a mirror sphere at each capture position, the outline of each
// influence volume and, where it differs, the outline of each projection volume. The volumes are
// world-space boxes, so the helper draws in world space whatever its parent's transform; an
// `oriented` probe's boxes are drawn turned by its world rotation (T23, W108).
// Port of ReflectionProbesHelper.js from three.js PR #35046 (Ben Houston), as of 706ccdf2b8.
// (The sphere sits at the capture point, which differs from the box centre with `originOffset`.)

import * as THREE from 'three/webgpu';
import { probeOrigin, probeWorldOffset, probeWorldRotation, probeWorldScale, type ReflectionProbe, type ReflectionProbes } from './ReflectionProbes';

const _position = new THREE.Vector3();
const _size = new THREE.Vector3();
const _scale = new THREE.Vector3();
const _offset = new THREE.Vector3();
const _rotation = new THREE.Quaternion();

/** A box outline centred at `center`, `size` along its own axes, turned by `rotation` (Box3Helper keeps its quaternion). */
function boxOutline(center: THREE.Vector3, size: THREE.Vector3, rotation: THREE.Quaternion, color: THREE.ColorRepresentation) {
  const helper = new THREE.Box3Helper(new THREE.Box3().setFromCenterAndSize(center, size), color);
  helper.quaternion.copy(rotation);
  return helper;
}

export class ReflectionProbesHelper extends THREE.Object3D {
  readonly probes: ReflectionProbes;
  /** The mirror material of the probe spheres. */
  readonly material = new THREE.MeshStandardMaterial({ metalness: 1, roughness: 0 });
  /** Colour of the influence volumes. */
  color: THREE.ColorRepresentation;
  /** Colour of the projection volumes, drawn when `projectionSize` or `projectionOffset` is set. */
  projectionColor: THREE.ColorRepresentation;
  private readonly geometry: THREE.SphereGeometry;

  constructor(probes: ReflectionProbes, sphereSize = 0.25, color: THREE.ColorRepresentation = 0xffff00, projectionColor: THREE.ColorRepresentation = 0x00ffff) {
    super();
    (this as { type: string }).type = 'ReflectionProbesHelper';
    this.probes = probes;
    this.color = color;
    this.projectionColor = projectionColor;
    this.geometry = new THREE.SphereGeometry(sphereSize, 32, 16);
    this.update();
  }

  /** Rebuilds the spheres and volumes. Call after adding, removing or moving probes. */
  update() {
    this.clear();
    this.probes.updateWorldMatrix(true, true);
    for (const child of this.probes.children) {
      const probe = child as ReflectionProbe;
      if (probe.isReflectionProbe !== true) continue;
      probe.getWorldPosition(_position);
      probeWorldScale(probe, _scale);
      // axis-aligned unless the probe is oriented (T23)
      if (probe.oriented === true) probeWorldRotation(probe, _rotation); else _rotation.identity();
      const sphere = new THREE.Mesh(this.geometry, this.material);
      probeOrigin(probe, sphere.position); // the capture point (the box centre unless originOffset is set)
      _size.copy(probe.influenceSize).multiply(_scale);
      this.add(sphere, boxOutline(_position, _size, _rotation, this.color));
      if (probe.projectionSize !== null || probe.projectionOffset.lengthSq() > 0) {
        _size.copy(probe.projectionSize ?? probe.influenceSize).multiply(_scale);
        _position.add(probe.oriented === true ? probeWorldOffset(probe, probe.projectionOffset, _offset) : _scale.multiply(probe.projectionOffset));
        this.add(boxOutline(_position, _size, _rotation, this.projectionColor));
      }
    }
  }

  updateMatrixWorld(force?: boolean) {
    // the volumes are axis-aligned in world space, so ignore the parent's transform
    this.matrixWorld.identity();
    for (const child of this.children) child.updateMatrixWorld(force);
  }

  updateWorldMatrix(updateParents: boolean, updateChildren: boolean) {
    if (updateParents === true && this.parent !== null) this.parent.updateWorldMatrix(true, false);
    this.matrixWorld.identity();
    if (updateChildren === true) for (const child of this.children) child.updateWorldMatrix(false, true);
  }

  clear() {
    for (const child of [...this.children]) {
      if ((child as THREE.Box3Helper).isLineSegments) (child as THREE.Box3Helper).dispose();
      this.remove(child);
    }
    return this;
  }

  dispose() {
    this.clear();
    this.geometry.dispose();
    this.material.dispose();
  }
}
