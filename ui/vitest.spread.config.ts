import { defineConfig } from "vitest/config";

// Node-only config for the mesh agent-spread logic (pure, no DOM/Pixi).
// Run: npx vitest run --config vitest.spread.config.ts
export default defineConfig({
  test: {
    include: ["src/ui/views/agent-ops/iso/agent-spread.test.ts"],
    environment: "node",
    browser: { enabled: false } as any,
  },
});
