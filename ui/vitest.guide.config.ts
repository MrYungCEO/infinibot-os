import { defineConfig } from "vitest/config";

// UI target registry + guide executor logic (node environment):
//   pnpm -C ui vitest run --config vitest.guide.config.ts
// Regenerate src/ui-targets/generated/nav-targets.json:
//   UPDATE_UI_TARGETS=1 pnpm -C ui vitest run --config vitest.guide.config.ts
export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./test-support/node-dom-shim.ts"],
    include: ["src/ui/guide/*.test.ts"],
  },
});
