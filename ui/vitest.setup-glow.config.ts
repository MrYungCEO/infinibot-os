import { defineConfig } from "vitest/config";

// "Needs setup" glow suite (controllers/nav-setup-status.ts + the sidebar /
// banner render). Node environment with a tiny globals shim:
//   pnpm -C ui vitest run --config vitest.setup-glow.config.ts
export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./test-support/node-dom-shim.ts"],
    include: [
      "src/ui/controllers/nav-setup-status.test.ts",
      "src/ui/views/nav-sidebar-setup-glow.test.ts",
    ],
  },
});
