import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

// Requires Playwright Chromium:
//   pnpm -C ui exec playwright install chromium
//   pnpm -C ui vitest run --config vitest.browser.config.ts
export default defineConfig({
  test: {
    include: [
      "src/**/*.browser.test.ts",
      "src/ui/components/proactive-modal.test.ts",
      "src/ui/components/subagent-detail-modal.test.ts",
      "src/ui/components/subagent-history-feed.test.ts",
      "src/ui/views/chat.test.ts",
    ],
    browser: {
      enabled: true,
      // PLAYWRIGHT_CHROMIUM_PATH=/opt/google/chrome/chrome runs the suite on an
      // installed Chrome when Playwright's own Chromium isn't downloaded.
      provider: playwright(
        process.env.PLAYWRIGHT_CHROMIUM_PATH
          ? { launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } }
          : {},
      ),
      instances: [{ browser: "chromium", name: "chromium" }],
      headless: true,
      ui: false,
    },
  },
});
