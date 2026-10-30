/**
 * glow3d camera tweens — eased fly-to / fit moves for an OrbitControls
 * camera. Call `update(now)` every frame; it returns true while a tween is
 * in flight (so on-demand renderers know to keep drawing).
 */

import * as THREE from "three";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

const easeInOut = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export class CameraTween {
  private from = { pos: new THREE.Vector3(), target: new THREE.Vector3() };
  private to = { pos: new THREE.Vector3(), target: new THREE.Vector3() };
  private start = 0;
  private duration = 0;
  private active = false;
  private readonly tmp = new THREE.Vector3();

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly controls: OrbitControls,
  ) {}

  get isActive(): boolean {
    return this.active;
  }

  /** Camera→target distance of the pose being tweened to (or the current one). */
  targetDistance(): number {
    return this.active
      ? this.to.pos.distanceTo(this.to.target)
      : this.camera.position.distanceTo(this.controls.target);
  }

  /** Look at `target` from `distance` along the current view direction. */
  flyTo(target: THREE.Vector3, distance: number, ms = 900): void {
    const dir = this.tmp.copy(this.camera.position).sub(this.controls.target);
    if (dir.lengthSq() < 1e-6) dir.set(0, 0.35, 1);
    dir.normalize();
    const pos = dir.multiplyScalar(distance).add(target);
    this.animate(pos, target, ms);
  }

  /** Frame a bounding sphere so it fills ~`fill` of the viewport height. */
  fitSphere(center: THREE.Vector3, radius: number, ms = 900, fill = 0.78, dir?: THREE.Vector3): void {
    const fov = (this.camera.fov * Math.PI) / 180;
    const aspect = Math.max(0.3, this.camera.aspect);
    // Fit the sphere in both the vertical and horizontal frustum.
    const vDist = radius / Math.sin(fov / 2);
    const hFov = 2 * Math.atan(Math.tan(fov / 2) * aspect);
    const hDist = radius / Math.sin(hFov / 2);
    const distance = Math.max(this.controls.minDistance + 1, (Math.max(vDist, hDist) / fill) * 0.92);
    const d = (dir ?? this.tmp.copy(this.camera.position).sub(this.controls.target)).clone();
    if (d.lengthSq() < 1e-6) d.set(0, 0.35, 1);
    d.normalize();
    const pos = d.multiplyScalar(Math.min(distance, this.controls.maxDistance - 1)).add(center);
    this.animate(pos, center, ms);
  }

  /**
   * Frame a point cloud exactly: the camera backs off along `dir` until every
   * point (padded by `pad`) sits inside the frustum, with `fill` of the view
   * used. Unlike `fitSphere`, a flat disc seen from a low angle doesn't waste
   * the vertical space, so overviews come out noticeably closer.
   * `points` is an `[x,y,z,…]` buffer; `count` points are used.
   */
  fitPoints(points: Float32Array, count: number, ms = 900, fill = 0.85, pad = 10, dir?: THREE.Vector3): void {
    if (count <= 0) return;
    const center = new THREE.Vector3();
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i < count; i++) {
      const x = points[i * 3], y = points[i * 3 + 1], z = points[i * 3 + 2];
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); z0 = Math.min(z0, z);
      x1 = Math.max(x1, x); y1 = Math.max(y1, y); z1 = Math.max(z1, z);
    }
    center.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    const d = (dir ?? this.tmp.copy(this.camera.position).sub(this.controls.target)).clone();
    if (d.lengthSq() < 1e-6) d.set(0, 0.35, 1);
    d.normalize();
    // Camera basis for a camera looking along -d with world up.
    const forward = d.clone().negate();
    const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0));
    if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
    right.normalize();
    const up = new THREE.Vector3().crossVectors(right, forward).normalize();
    const fov = (this.camera.fov * Math.PI) / 180;
    const tanV = Math.tan(fov / 2) * fill;
    const tanH = tanV * Math.max(0.3, this.camera.aspect);
    let need = 0;
    const p = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
      p.set(points[i * 3], points[i * 3 + 1], points[i * 3 + 2]).sub(center);
      const lx = Math.abs(p.dot(right)) + pad;
      const ly = Math.abs(p.dot(up)) + pad;
      const lz = p.dot(d); // + = toward the camera
      need = Math.max(need, lx / tanH + lz, ly / tanV + lz);
    }
    const distance = Math.min(this.controls.maxDistance - 1, Math.max(this.controls.minDistance + 1, need));
    const pos = d.multiplyScalar(distance).add(center);
    this.animate(pos, center, ms);
  }

  /** Jump without animation. */
  set(pos: THREE.Vector3, target: THREE.Vector3): void {
    this.active = false;
    this.camera.position.copy(pos);
    this.controls.target.copy(target);
    this.controls.update();
  }

  private animate(pos: THREE.Vector3, target: THREE.Vector3, ms: number): void {
    this.from.pos.copy(this.camera.position);
    this.from.target.copy(this.controls.target);
    this.to.pos.copy(pos);
    this.to.target.copy(target);
    if (ms <= 0) {
      this.set(pos, target);
      return;
    }
    this.start = performance.now();
    this.duration = ms;
    this.active = true;
  }

  cancel(): void {
    this.active = false;
  }

  update(now: number): boolean {
    if (!this.active) return false;
    const t = Math.min(1, (now - this.start) / this.duration);
    const k = easeInOut(t);
    this.camera.position.lerpVectors(this.from.pos, this.to.pos, k);
    this.controls.target.lerpVectors(this.from.target, this.to.target, k);
    if (t >= 1) this.active = false;
    return true;
  }
}
