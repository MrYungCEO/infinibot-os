import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PluginRecord } from "../../plugins/registry.js";
import { grantTestPluginEntitlements } from "../../test-utils/plugin-entitlements.js";
import {
  buildCatalog,
  purchaseUrls,
  readOnboardingProfile,
  recommendFor,
  safeReturnUrl,
} from "./plugins-catalog.js";

const rec = (id: string, extra: Partial<PluginRecord> = {}): PluginRecord =>
  ({
    id,
    name: id,
    origin: "bundled",
    enabled: false,
    status: "disabled",
    category: "apps",
    ...extra,
  }) as PluginRecord;

let dir: string;
const saved = { ...process.env };
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ib-cat-"));
  process.env.INFINIBOT_STATE_DIR = dir;
  delete process.env.INFINIBOT_DESKTOP;
  delete process.env.SAAS_MODE;
  delete process.env.FLEET_TENANT_ID;
});
afterEach(() => {
  process.env = { ...saved };
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("plugins.catalog (v1 shape)", () => {
  it("returns the stable top-level shape onboarding reads", () => {
    const c = buildCatalog([rec("flypic"), rec("content-studio"), rec("droid-swarm")]);
    expect(Object.keys(c).sort()).toEqual(
      [
        "account",
        "categories",
        "counts",
        "generatedAt",
        "kinglyVault",
        "plugins",
        "profile",
        "recommended",
        "version",
      ].sort(),
    );
    expect(c.version).toBe(1);
    const p = c.plugins.find((x) => x.id === "flypic")!;
    expect(Object.keys(p).sort()).toEqual(
      [
        "access",
        "adds",
        "badges",
        "category",
        "cover",
        "description",
        "detailRoute",
        "enabled",
        "icon",
        "id",
        "loaded",
        "name",
        "publisher",
        "recommended",
        "status",
        "tagline",
        "tags",
        "updateAvailable",
        "version",
      ].sort(),
    );
    expect(p.access).toMatchObject({
      status: "locked-purchase",
      loadable: false,
      price: { label: "$19" },
    });
    expect(p.badges).toEqual(expect.arrayContaining(["paid", "locked"]));
    const droid = c.plugins.find((x) => x.id === "droid-swarm")!;
    expect(droid.badges).toEqual(expect.arrayContaining(["paid", "locked"]));
    expect(droid.badges).not.toContain("desktop");
    expect(droid.access.requires).toEqual({ purchase: true });
    expect(droid.access.price?.label).toBe("$49");
    expect(JSON.stringify(c)).not.toMatch(/desktopOnly|locked-desktop/);
    expect(c.plugins.find((x) => x.id === "content-studio")!.badges).toEqual([]);
    expect(c.counts).toMatchObject({ installed: 3, locked: 2, paid: 2 });
    expect(c.account).toEqual({ linked: false, email: null, state: "none" });
  });

  it("owned plugins carry owned / pro badges", () => {
    const revoke = grantTestPluginEntitlements("*");
    try {
      const p = buildCatalog([rec("flypic")]).plugins[0];
      expect(p.access.loadable).toBe(true);
      expect(p.badges).toEqual(expect.arrayContaining(["paid", "pro", "owned"]));
    } finally {
      revoke();
    }
  });

  it("lists what a plugin adds (pages with nav labels, agents, tools)", () => {
    const r = rec("x", {
      contributes: {
        nav: [{ tab: "x-home", label: "X Home" }],
        pages: [{ tab: "x-home", route: "/x" }],
        agents: ["agents/a.json"],
        tools: ["x_tool"],
        panels: [],
      } as never,
    });
    expect(buildCatalog([r]).plugins[0].adds).toEqual({
      pages: [{ tab: "x-home", label: "X Home", route: "/x" }],
      agents: ["agents/a.json"],
      tools: 1,
      panels: 0,
    });
  });
});

describe("recommendations from the onboarding profile", () => {
  it("falls back to defaults without a profile", () => {
    expect(readOnboardingProfile().source).toBe("default");
    const r = recommendFor(readOnboardingProfile(), ["business-agency", "flypic", "x"]);
    expect([...r.keys()]).toEqual(["business-agency", "flypic"]);
  });
  it("reads onboarding's saved profile (onboarding/profile.json)", () => {
    fs.mkdirSync(path.join(dir, "onboarding"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "onboarding", "profile.json"),
      JSON.stringify({ useCases: ["trading"], plugins: ["solatrix"] }),
    );
    const prof = readOnboardingProfile();
    expect(prof).toMatchObject({
      source: "onboarding",
      useCases: ["trading"],
      plugins: ["solatrix"],
    });
    const c = buildCatalog([rec("infinitrade"), rec("solatrix"), rec("flypic")]);
    expect(c.recommended[0]).toBe("solatrix");
    expect(c.recommended).toContain("infinitrade");
    expect(c.recommended).not.toContain("flypic");
  });
  it("ignores a malformed profile", () => {
    fs.mkdirSync(path.join(dir, "onboarding"), { recursive: true });
    fs.writeFileSync(path.join(dir, "onboarding", "profile.json"), "{nope");
    expect(readOnboardingProfile().source).toBe("default");
  });
});

describe("purchase URLs", () => {
  it("builds KinglyVault buy / link URLs with a safe return", () => {
    const u = purchaseUrls(
      { id: "flypic", returnUrl: "http://127.0.0.1:18789/plugins#x", state: "abcdef012345" },
      { INFINIBOT_KINGLYVAULT_URL: "https://kv.test" } as NodeJS.ProcessEnv,
    );
    expect(u.buy).toBe(
      "https://kv.test/infinibot/plugins/flypic?buy=1&return=http%3A%2F%2F127.0.0.1%3A18789%2Fplugins&state=abcdef012345",
    );
    expect(u.link).toContain("/infinibot/link?");
    expect(safeReturnUrl("javascript:alert(1)")).toBeNull();
    expect(purchaseUrls({ id: "../x" }).buy).toBeNull();
  });
});
