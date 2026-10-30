/**
 * Shared helpers for the InfiniBot visual-verification suite.
 *
 * The control UI is gated behind (1) a gateway-password screen and (2) an
 * optional "pick a profile" picker. Both are bypassed headlessly by seeding
 * localStorage["infinibot.control.settings.v1"] BEFORE the app boots, then
 * dismissing the profile gate if it appears. See
 * memory/screenshot_infinibot_ui_headless.md for the canonical pattern.
 *
 * NOTE: the control UI ships ZERO `data-testid` attributes today (verified via
 * grep). Specs therefore lean on custom-element tag names (`agency-world-viz`,
 * `world-timeline-scrubber`, …) and visible text/role selectors. Where a
 * data-testid would materially harden a check, the spec leaves a `TODO(testid)`
 * comment naming the element to annotate later — we do NOT inject testids into
 * off-limits files owned by other in-flight agents.
 */
import { type Page } from "@playwright/test";

export const SETTINGS_KEY = "infinibot.control.settings.v1";

/** Base http URL of the gateway-served control UI (default localhost:18789). */
export function gatewayBaseUrl(): string {
  const raw = process.env.VERIFY_GATEWAY_URL || "http://localhost:18789";
  // Accept ws:// / wss:// forms too and normalise to http(s) for navigation.
  return raw.replace(/^ws:/, "http:").replace(/^wss:/, "https:").replace(/\/$/, "");
}

/** ws:// form of the gateway URL, used for the seeded UiSettings.gatewayUrl. */
export function gatewayWsUrl(): string {
  const http = gatewayBaseUrl();
  return http.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
}

/**
 * Seed the control-UI settings into localStorage so the password gate is
 * satisfied on first paint. The password is read from VERIFY_GATEWAY_PASSWORD
 * (injected by scripts/verify-ui.sh, which reads it from ~/.infinibot/
 * infinibot.json → gateway.auth.password). Never hardcode it here.
 */
export async function seedAuth(page: Page): Promise<void> {
  const password = process.env.VERIFY_GATEWAY_PASSWORD || "";
  const settings = {
    gatewayUrl: gatewayWsUrl(),
    token: "",
    password,
    sessionKey: "main",
    lastActiveSessionKey: "main",
  };
  // addInitScript runs before any page script on every navigation in this
  // context, so the gate never flashes even across in-app route changes.
  await page.addInitScript(
    ([key, value]) => {
      try {
        window.localStorage.setItem(key as string, value as string);
      } catch {
        /* storage may be unavailable in some sandboxes; gate fallback handles it */
      }
    },
    [SETTINGS_KEY, JSON.stringify(settings)] as const,
  );
}

/** Dismiss the optional profile picker ("Continue as … →", class `.gate-skip`). */
export async function dismissProfileGate(page: Page): Promise<void> {
  // The gate is opt-in; on single-profile installs it never renders. Poll
  // briefly, click if present, otherwise move on.
  const skip = page.locator("button.gate-skip");
  for (let i = 0; i < 10; i++) {
    if (await skip.count().catch(() => 0)) {
      await skip.first().click().catch(() => {});
      return;
    }
    await page.waitForTimeout(150);
    // Bail early once the real app shell is up.
    if (await page.locator("agency-world-viz, .app-shell, main").count().catch(() => 0)) return;
  }
}

/**
 * Navigate to a path-based control-UI route, satisfy both auth gates, and wait
 * for the app shell to settle. Returns once the page is ready to screenshot.
 */
export async function gotoSurface(page: Page, path: string): Promise<void> {
  await seedAuth(page);
  const url = `${gatewayBaseUrl()}${path.startsWith("/") ? path : `/${path}`}`;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await dismissProfileGate(page);
  // <infinibot-app> is the always-present Lit root — the canonical "the control
  // UI booted" signal across every path-based route.
  await page.locator("infinibot-app").first().waitFor({ state: "attached", timeout: 20_000 }).catch(() => {});
  // Give the WS client + Lit render a beat to mount the active view.
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(1200);
  await settleAnimations(page);
}

/**
 * Quiet a page for deterministic screenshots: disable CSS animations /
 * transitions and stop the canvas RAF churn that the world map runs, so diffs
 * reflect real layout/style changes rather than animation phase.
 */
export async function settleAnimations(page: Page): Promise<void> {
  await page.addStyleTag({
    content: `*, *::before, *::after {
      animation-duration: 0s !important;
      animation-delay: 0s !important;
      transition-duration: 0s !important;
      transition-delay: 0s !important;
      caret-color: transparent !important;
    }`,
  }).catch(() => {});
  // Let one more frame paint, then freeze requestAnimationFrame so the world-map
  // canvas (and any other RAF-driven surface) holds a stable frame — otherwise
  // Playwright's 2-stable-frame screenshot check never converges and times out.
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    const w = window as unknown as { __rafFrozen?: boolean };
    if (w.__rafFrozen) return;
    w.__rafFrozen = true;
    window.requestAnimationFrame = (() => 0) as typeof window.requestAnimationFrame;
  }).catch(() => {});
  await page.waitForTimeout(200);
}

/** True when running against the Expo web build instead of the control UI. */
export function mobileWebDir(): string {
  return process.env.VERIFY_MOBILE_WEB_DIR || "mobile/dist";
}
