import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  BrowserExtensionGovernance,
  sensitiveBrowserAction,
  siteRuleMatches,
} from "./extension-governance.js";

const dirs: string[] = [];

function registry(): BrowserExtensionGovernance {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "infinibot-browser-extension-"));
  dirs.push(dir);
  return new BrowserExtensionGovernance(path.join(dir, "state.json"));
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("browser extension pairing", () => {
  it("exchanges a one-time code for a durable token and never returns its hash", () => {
    const r = registry();
    const pairing = r.createPairingCode("Work Chrome");
    const paired = r.pair({ code: pairing.code, extensionId: "abcdefghijklmnop" });

    expect(paired.profile.name).toBe("Work Chrome");
    expect(r.authenticate(paired.token)?.id).toBe(paired.profile.id);
    expect(JSON.stringify(r.status())).not.toContain(paired.token);
    expect(() => r.pair({ code: pairing.code })).toThrow(/invalid or expired/i);
  });

  it("rejects unknown tokens and supports revocation", () => {
    const r = registry();
    const pairing = r.createPairingCode();
    const paired = r.pair({ code: pairing.code });
    expect(r.authenticate("wrong")).toBeNull();
    expect(r.revoke(paired.profile.id)).toBe(true);
    expect(r.authenticate(paired.token)).toBeNull();
  });
});

describe("browser site policy", () => {
  it("matches exact hosts and wildcard subdomains without suffix confusion", () => {
    expect(siteRuleMatches("example.com", "https://example.com/a")).toBe(true);
    expect(siteRuleMatches("*.example.com", "https://app.example.com")).toBe(true);
    expect(siteRuleMatches("example.com", "https://evil-example.com")).toBe(false);
  });

  it("evaluates first-match allow/ask/block rules and the kill switch", () => {
    const r = registry();
    r.setRules(
      [
        { pattern: "blocked.example", decision: "block" },
        { pattern: "*.trusted.example", decision: "allow" },
      ],
      "ask",
    );
    expect(r.decisionForUrl("https://blocked.example")).toBe("block");
    expect(r.decisionForUrl("https://app.trusted.example")).toBe("allow");
    expect(r.decisionForUrl("https://other.example")).toBe("ask");
    r.setKillSwitch(true);
    expect(r.isKilled()).toBe(true);
  });
});

describe("browser tab locks", () => {
  it("prevents two runs controlling one tab and lets the owner release it", () => {
    const r = registry();
    r.lockTab("target-1", "run-a", "profile-a");
    expect(() => r.lockTab("target-1", "run-b", "profile-a")).toThrow(/another agent run/i);
    expect(r.unlockTab("target-1", "run-b")).toBe(false);
    expect(r.unlockTab("target-1", "run-a")).toBe(true);
    expect(() => r.lockTab("target-1", "run-b", "profile-a")).not.toThrow();
  });
});

describe("sensitive browser actions", () => {
  it("requires approval for JavaScript and risky human-side effects", () => {
    expect(sensitiveBrowserAction({ action: "evaluate", code: "document.title" })).toMatch(
      /JavaScript/,
    );
    expect(sensitiveBrowserAction({ action: "click", text: "Place order" })).toMatch(/purchase/);
    expect(sensitiveBrowserAction({ action: "type", text: "2FA verification code" })).toMatch(
      /verification/,
    );
    expect(sensitiveBrowserAction({ action: "click", text: "Read more" })).toBeNull();
  });
});
