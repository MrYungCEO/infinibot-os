/**
 * glow3d node shapes — low-poly, flat-shaded "icon" geometries so a node's
 * silhouette says what it is (a gem for a project, a stack of pages for a
 * note, an orb with an orbiting ring for an agent…). Every geometry is
 * centred and fits a unit sphere, so the instance scale stays "radius".
 *
 * One InstancedMesh per shape (see GlowNodes): N shapes = N draws.
 */

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

export const NODE_SHAPES = {
  orb: 0,
  gem: 1,
  block: 2,
  pages: 3,
  report: 4,
  media: 5,
  agent: 6,
  person: 7,
  chip: 8,
  neuron: 9,
  lens: 10,
} as const;
export type NodeShapeId = (typeof NODE_SHAPES)[keyof typeof NODE_SHAPES];

/** Flat-shaded, uv-less, non-indexed (so different primitives merge). */
function prep(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const ng = g.index ? g.toNonIndexed() : g;
  ng.deleteAttribute("uv");
  ng.computeVertexNormals();
  return ng;
}

function box(w: number, h: number, d: number, x = 0, y = 0, z = 0): THREE.BufferGeometry {
  return prep(new THREE.BoxGeometry(w, h, d).translate(x, y, z));
}

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const g = mergeGeometries(parts.map(prep), false);
  if (!g) throw new Error("glow3d: shape merge failed");
  return g;
}

/** Build the geometry for a shape (unit-ish radius). */
export function shapeGeometry(id: number, detail: [number, number] = [16, 12]): THREE.BufferGeometry {
  switch (id) {
    case NODE_SHAPES.gem: {
      // Brilliant-cut crystal: pointed pavilion, flat table, 8 facets.
      const pts = [
        new THREE.Vector2(0.001, -1.05),
        new THREE.Vector2(0.95, 0.12),
        new THREE.Vector2(0.62, 0.55),
        new THREE.Vector2(0.001, 0.55),
      ];
      return prep(new THREE.LatheGeometry(pts, 8));
    }
    case NODE_SHAPES.block: {
      // Checkbox key: a block with a raised square face.
      return merge([new THREE.BoxGeometry(1.25, 1.25, 1.1), new THREE.BoxGeometry(0.86, 0.86, 0.16).translate(0, 0, 0.62)]);
    }
    case NODE_SHAPES.pages: {
      // Stack of thin page cards, slightly fanned.
      return merge([
        new THREE.BoxGeometry(1.3, 1.7, 0.07).translate(-0.1, -0.08, -0.18),
        new THREE.BoxGeometry(1.3, 1.7, 0.07).translate(0, 0, 0),
        new THREE.BoxGeometry(1.3, 1.7, 0.07).translate(0.1, 0.08, 0.18),
      ]);
    }
    case NODE_SHAPES.report: {
      // Page slab with a bar chart standing off the front face.
      return merge([
        new THREE.BoxGeometry(1.4, 1.8, 0.12),
        new THREE.BoxGeometry(0.24, 0.5, 0.16).translate(-0.38, -0.5, 0.12),
        new THREE.BoxGeometry(0.24, 0.85, 0.16).translate(0, -0.33, 0.12),
        new THREE.BoxGeometry(0.24, 1.2, 0.16).translate(0.38, -0.15, 0.12),
      ]);
    }
    case NODE_SHAPES.media: {
      // Film/frame tile: border, inset panel, play triangle.
      const tri = new THREE.CylinderGeometry(0.3, 0.3, 0.1, 3).rotateX(Math.PI / 2).rotateZ(-Math.PI / 2).translate(0.04, 0, 0.1);
      return merge([
        new THREE.BoxGeometry(1.8, 0.18, 0.2).translate(0, 0.62, 0),
        new THREE.BoxGeometry(1.8, 0.18, 0.2).translate(0, -0.62, 0),
        new THREE.BoxGeometry(0.18, 1.06, 0.2).translate(-0.81, 0, 0),
        new THREE.BoxGeometry(0.18, 1.06, 0.2).translate(0.81, 0, 0),
        new THREE.BoxGeometry(1.46, 1.06, 0.05),
        tri,
      ]);
    }
    case NODE_SHAPES.agent: {
      // Robot core: orb plus a tilted orbiting ring.
      return merge([
        new THREE.IcosahedronGeometry(0.66, 1),
        new THREE.TorusGeometry(1.08, 0.075, 4, 28).rotateX(1.15).rotateZ(0.35),
      ]);
    }
    case NODE_SHAPES.person: {
      // Person capsule: body + head.
      return merge([
        new THREE.CapsuleGeometry(0.42, 0.62, 3, 8).translate(0, -0.38, 0),
        new THREE.IcosahedronGeometry(0.34, 1).translate(0, 0.66, 0),
      ]);
    }
    case NODE_SHAPES.chip: {
      // System/core: hexagonal prism chip with pins.
      const parts: THREE.BufferGeometry[] = [new THREE.CylinderGeometry(0.95, 0.95, 0.38, 6)];
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2 + Math.PI / 6;
        parts.push(new THREE.BoxGeometry(0.12, 0.12, 0.3).translate(Math.cos(a) * 0.95, 0, Math.sin(a) * 0.95));
      }
      return merge(parts);
    }
    case NODE_SHAPES.neuron: {
      // Memory/knowledge: a neuron star — soma with dendrite spikes.
      const parts: THREE.BufferGeometry[] = [new THREE.IcosahedronGeometry(0.5, 1)];
      const up = new THREE.Vector3(0, 1, 0);
      const q = new THREE.Quaternion();
      const n = 10;
      for (let k = 0; k < n; k++) {
        const y = 1 - (2 * (k + 0.5)) / n;
        const r = Math.sqrt(1 - y * y);
        const t = k * 2.399963;
        const d = new THREE.Vector3(Math.cos(t) * r, y, Math.sin(t) * r);
        q.setFromUnitVectors(up, d);
        const cone = new THREE.ConeGeometry(0.11, 0.6, 4).applyQuaternion(q);
        cone.translate(d.x * 0.72, d.y * 0.72, d.z * 0.72);
        parts.push(cone);
      }
      return merge(parts);
    }
    case NODE_SHAPES.lens: {
      // Research: magnifier — lens ring and handle.
      return merge([
        new THREE.TorusGeometry(0.62, 0.13, 5, 22).translate(-0.2, 0.2, 0),
        new THREE.CylinderGeometry(0.1, 0.12, 0.75, 6).rotateZ(Math.PI / 4).translate(0.46, -0.46, 0),
        new THREE.CircleGeometry(0.5, 16).translate(-0.2, 0.2, 0),
      ]);
    }
    default:
      return new THREE.SphereGeometry(1, detail[0], detail[1]);
  }
}
