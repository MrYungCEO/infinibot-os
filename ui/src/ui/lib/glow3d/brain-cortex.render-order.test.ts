import * as THREE from "three";
import { describe, expect, test } from "vitest";
import { BrainCortex } from "./brain-cortex";

// three.js renders every opaque object before any transparent one, whatever its
// renderOrder. The cortex depth pre-pass must therefore be "transparent" so it
// runs after the links (renderOrder 5) — otherwise links inside the brain vanish.
describe("BrainCortex render order", () => {
  test("depth pre-pass sits in the transparent list after the links", () => {
    const uniforms = {
      uTime: { value: 0 },
      uFogNear: { value: 0 },
      uFogFar: { value: 1 },
      uFogColor: { value: new THREE.Color() },
      uMotion: { value: 1 },
    };
    const cortex = new BrainCortex(uniforms, { detail: 12 });
    const depthMeshes = cortex.group.children.filter(
      (o): o is THREE.Mesh => o instanceof THREE.Mesh && (o.material as THREE.Material).colorWrite === false,
    );
    expect(depthMeshes.length).toBeGreaterThan(0);
    for (const m of depthMeshes) {
      expect((m.material as THREE.Material).transparent).toBe(true);
      expect(m.renderOrder).toBeGreaterThan(5);
    }
  });
});
