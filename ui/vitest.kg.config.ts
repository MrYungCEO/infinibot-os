import { defineConfig } from "vitest/config";

// Knowledge-graph layout / brain suite (pure logic, node env):
//   pnpm -C ui vitest run --config vitest.kg.config.ts
export default defineConfig({
  test: {
    environment: "node",
    include: [
      "src/ui/components/knowledge-graph-layout-v3.test.ts",
      "src/ui/components/knowledge-graph-model.test.ts",
      "src/ui/components/knowledge-graph-ops.test.ts",
      "src/ui/components/knowledge-graph-brain.test.ts",
      "src/ui/components/knowledge-graph-galaxy.test.ts",
      "src/ui/components/knowledge-graph-sizing.test.ts",
      "src/ui/components/knowledge-graph-consolidate.test.ts",
      "src/ui/components/knowledge-graph-scene.test.ts",
      "src/ui/components/knowledge-graph-map2d.test.ts",
      "src/ui/components/knowledge-graph-repos.test.ts",
      "src/ui/components/knowledge-graph-project-scope.test.ts",
      "src/ui/lib/glow3d/brain-cortex.render-order.test.ts",
    ],
    testTimeout: 60_000,
  },
});
