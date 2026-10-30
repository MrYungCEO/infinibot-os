import { defineConfig } from "vitest/config";

// Node-only config for the world-engine primitives (pure logic, no DOM).
// Run: npx vitest run --config vitest.engine.config.ts
export default defineConfig({
  test: {
    include: ["src/ui/views/agent-ops/iso/engine/**/*.test.ts"],
    environment: "node",
    browser: { enabled: false } as any,
  },
});
