import { describe, expect, it } from "vitest";
import { resolveBrowserConfig } from "./config.js";
import {
  applyHostedBrowserConfig,
  assertBrowserSessionAvailable,
  BrowserSessionLimitError,
  countBrowserSessions,
  hostedBrowserSessionCap,
} from "./hosted.js";

const HOSTED = {
  FLEET_TENANT_ID: "t-1",
  FLEET_TENANT_PLAN: "business",
  FLEET_HOSTED_BROWSER: "1",
  INFINIBOT_BROWSER_EXECUTABLE: "/usr/local/bin/chromium-headless-shell",
};

describe("hosted browser config", () => {
  it("is untouched off the fleet", () => {
    const resolved = resolveBrowserConfig({ headless: false });
    expect(applyHostedBrowserConfig(resolved, {})).toBe(resolved);
    expect(hostedBrowserSessionCap({})).toBeNull();
  });

  it("pins headless + the bundled Chromium + one managed profile, sandbox on", () => {
    const resolved = resolveBrowserConfig({ headless: false, enabled: false });
    const out = applyHostedBrowserConfig(resolved, HOSTED);
    expect(out).toMatchObject({
      enabled: true,
      headless: true,
      noSandbox: false,
      attachOnly: false,
      executablePath: "/usr/local/bin/chromium-headless-shell",
      defaultProfile: "clawd",
    });
    // No Chrome-extension relay profile: there is no desktop Chrome on a Machine.
    expect(Object.keys(out.profiles)).toEqual(["clawd"]);
  });

  it("falls back to --no-sandbox only when the entrypoint found no user namespaces", () => {
    const out = applyHostedBrowserConfig(resolveBrowserConfig({}), {
      ...HOSTED,
      INFINIBOT_BROWSER_NO_SANDBOX: "1",
    });
    expect(out.noSandbox).toBe(true);
  });
});

describe("browser session cap", () => {
  const page = (url: string) => ({ url, type: "page" });

  it("follows the plan (business = 4) and ignores the blank placeholder tab + workers", () => {
    expect(hostedBrowserSessionCap(HOSTED)).toBe(4);
    expect(
      countBrowserSessions([
        page("about:blank"),
        page("https://a"),
        { url: "x", type: "service_worker" },
      ]),
    ).toBe(1);
  });

  it("refuses the tab past the cap with an actionable message", () => {
    const env = { ...HOSTED, FLEET_TENANT_PLAN: "starter" };
    expect(() => assertBrowserSessionAvailable([page("about:blank")], env)).not.toThrow();
    expect(() => assertBrowserSessionAvailable([page("https://a")], env)).toThrow(
      BrowserSessionLimitError,
    );
    expect(() => assertBrowserSessionAvailable([page("https://a")], env)).toThrow(
      /allows 1 open browser tab/,
    );
  });

  it("no cap for owner/unlimited plans or off the fleet", () => {
    const tabs = Array.from({ length: 20 }, (_, i) => page(`https://${i}`));
    expect(() =>
      assertBrowserSessionAvailable(tabs, { ...HOSTED, FLEET_TENANT_PLAN: "ceo" }),
    ).not.toThrow();
    expect(() => assertBrowserSessionAvailable(tabs, {})).not.toThrow();
  });
});
