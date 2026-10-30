import { afterEach, describe, expect, it, vi } from "vitest";

import { openSignInWindow } from "../controllers/cli-routing";
import { CliSetupRunner, installFailureMessage } from "./cli-setup";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("installFailureMessage", () => {
  it("never shows a bare exit code as the message", () => {
    expect(installFailureMessage("Google account", "npm install failed (exit -1)")).toBe(
      "We couldn't get Google account ready on this computer. Click Try again.",
    );
    expect(installFailureMessage("ChatGPT", undefined)).toMatch(/Click Try again\.$/);
  });

  it("keeps the gateway's plain reason + next step", () => {
    const e =
      "InfiniBot couldn't download Node.js, which it needs to set this up (fetch failed). Check your internet connection and click Try again.";
    expect(installFailureMessage("Claude", e)).toBe(`We couldn't get Claude ready on this computer. ${e}`);
  });
});

describe("openSignInWindow", () => {
  it("desktop app: hands the URL to the main process (default browser), never window.open", () => {
    const openExternal = vi.fn(async () => ({ ok: true }));
    const open = vi.fn();
    vi.stubGlobal("api", { openExternal });
    vi.stubGlobal("window", { open });
    expect(openSignInWindow("https://accounts.google.com/o/oauth2/v2/auth?x=1")).toBe(true);
    expect(openExternal).toHaveBeenCalledWith("https://accounts.google.com/o/oauth2/v2/auth?x=1");
    expect(open).not.toHaveBeenCalled();
  });

  it("web: opens a new tab; false when blocked; refuses non-http URLs", () => {
    const tab = { opener: {} };
    const open = vi.fn(() => tab);
    vi.stubGlobal("window", { open });
    expect(openSignInWindow("https://auth.openai.com/codex/device")).toBe(true);
    expect(open).toHaveBeenCalledTimes(1);
    expect(tab.opener).toBeNull();
    vi.stubGlobal("window", { open: () => null });
    expect(openSignInWindow("https://claude.ai/login")).toBe(false);
    expect(openSignInWindow("javascript:alert(1)")).toBe(false);
  });
});

describe("Google account no longer allowed for Gemini CLI", () => {
  it("offers the API-key fix and hands off to the key panel", () => {
    const onUseApiKey = vi.fn();
    const google = { id: "gemini-cli", account: "Google account", signInLabel: "Sign in with Google" };
    const model = { backend: () => google, logins: {}, installs: {}, cancelLogin: vi.fn() };
    const host = { requestUpdate: vi.fn(), addController: vi.fn() };
    const runner = new CliSetupRunner(host as never, model as never, null, { onUseApiKey });
    const err = (runner as any).connectError(google, {
      ok: false,
      code: "subscription_unsupported",
      message: "Google no longer lets free Google accounts use Gemini CLI.",
      ms: 5000,
    });
    expect(err.fix).toEqual({ id: "apikey", label: "Use a Gemini API key" });
    expect(err.message).toContain("no longer lets free Google accounts");
    runner.backendId = "gemini-cli";
    runner.fix("apikey");
    expect(onUseApiKey).toHaveBeenCalledWith(google);
  });
});
