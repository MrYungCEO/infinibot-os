import { defineConfig } from "vitest/config";

// Node-only config for pure-math tests (no browser/DOM required)
export default defineConfig({
  test: {
    include: ["src/**/layout-engine.test.ts"],
    environment: "node",
    browser: { enabled: false } as any,
  },
});
