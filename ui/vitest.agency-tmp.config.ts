import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

// TEMPORARY override config (not committed) — same as vitest.config.ts but
// launches chromium with --no-sandbox so it can spawn in this sandboxed env.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    browser: {
      enabled: true,
      provider: playwright({
        launchOptions: {
          args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
        },
      }),
      instances: [{ browser: "chromium", name: "chromium" }],
      headless: true,
      ui: false,
    },
  },
});
