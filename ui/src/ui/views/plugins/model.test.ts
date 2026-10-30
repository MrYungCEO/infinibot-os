import { describe, expect, it } from "vitest";
import type { PermissionState, PluginSummary } from "./api.js";
import { generatedCover } from "./covers.js";
import { applyPlanChannelLocks, cardStatus as cardStatusCloud, cloudBlock, primaryAction as primaryActionCloud } from "./model.js";
import {
  DEFAULT_QUERY,
  applyQuery,
  cardStatus,
  categoryOf,
  configChanges,
  describePermission,
  filterCounts,
  groupSections,
  isInstalled,
  permissionStatusLabel,
  permissionSummary,
  primaryAction,
  sortPermissionsByRisk,
} from "./model.js";

const P = (over: Partial<PluginSummary>): PluginSummary =>
  ({
    id: "x",
    name: "X",
    origin: "bundled",
    source: "/x/index.ts",
    enabled: false,
    status: "disabled",
    tier: "first-party",
    ...over,
  }) as PluginSummary;

const omniclinic = P({
  id: "omniclinic",
  name: "OmniClinic",
  enabled: true,
  status: "loaded",
  category: "apps",
  listing: { tagline: "Doctor AI OS", tags: ["research", "clinic"], screenshots: [], links: {} },
  contributes: { nav: [{ tab: "omniclinic", label: "OmniClinic" }], pages: [], rpc: [], http: [] },
});
const telegram = P({ id: "telegram", name: "Telegram", enabled: true, status: "loaded", category: "channels", channels: ["telegram"], setup: { needed: true, reason: "No account connected yet", target: "channels" } });
const discord = P({ id: "discord", name: "Discord", category: "channels", channels: ["discord"] });
const lobster = P({ id: "lobster", name: "Lobster", category: "developer", origin: "global", tier: "community" });
const all = [omniclinic, telegram, discord, lobster];

describe("plugins marketplace model", () => {
  it("installed = on, or added by the owner; available = bundled + off", () => {
    expect(isInstalled(omniclinic)).toBe(true);
    expect(isInstalled(discord)).toBe(false);
    expect(isInstalled(lobster)).toBe(true);
    expect(filterCounts(all)).toEqual({ all: 4, installed: 3, enabled: 2, available: 1 });
  });

  it("filters by status, search terms (name, tags, tagline), category and tier", () => {
    expect(applyQuery(all, { ...DEFAULT_QUERY, filter: "available" }).map((p) => p.id)).toEqual(["discord"]);
    expect(applyQuery(all, { ...DEFAULT_QUERY, q: "clinic research" }).map((p) => p.id)).toEqual(["omniclinic"]);
    expect(applyQuery(all, { ...DEFAULT_QUERY, q: "doctor" }).map((p) => p.id)).toEqual(["omniclinic"]);
    expect(applyQuery(all, { ...DEFAULT_QUERY, category: "channels" }).map((p) => p.id)).toEqual(["telegram", "discord"]);
    expect(applyQuery(all, { ...DEFAULT_QUERY, tiers: ["community"] }).map((p) => p.id)).toEqual(["lobster"]);
    expect(applyQuery(all, { ...DEFAULT_QUERY, q: "nothing-matches" })).toEqual([]);
  });

  it("sorts: recommended puts enabled first-party first; name is A–Z", () => {
    expect(applyQuery(all, DEFAULT_QUERY).map((p) => p.id)).toEqual(["omniclinic", "telegram", "discord", "lobster"]);
    expect(applyQuery(all, { ...DEFAULT_QUERY, sort: "name" }).map((p) => p.id)).toEqual(["discord", "lobster", "omniclinic", "telegram"]);
    expect(applyQuery(all, { ...DEFAULT_QUERY, sort: "status" })[0]?.id).toBe("telegram");
  });

  it("groups into store sections in category order, first-party apps titled as such", () => {
    const s = groupSections(applyQuery(all, DEFAULT_QUERY));
    expect(s.map((x) => [x.id, x.title])).toEqual([
      ["apps", "First-party apps"],
      ["channels", "Channels"],
      ["developer", "Developer"],
    ]);
  });

  it("card status + primary action come from real state", () => {
    expect(cardStatus(omniclinic)).toMatchObject({ kind: "on" });
    expect(primaryAction(omniclinic)).toEqual({ kind: "open", label: "Open", tab: "omniclinic" });
    expect(cardStatus(telegram)).toMatchObject({ kind: "setup", label: "Needs setup" });
    expect(primaryAction(telegram)).toMatchObject({ kind: "channels", label: "Set up" });
    expect(primaryAction(discord)).toMatchObject({ kind: "enable" });
    expect(cardStatus(discord, true)).toMatchObject({ kind: "applying" });
    expect(cardStatus(P({ status: "error", error: "boom", enabled: true }))).toMatchObject({ kind: "error", detail: "boom" });
    expect(primaryAction(P({ enabled: true, status: "loaded" }))).toMatchObject({ kind: "details", label: "Configure" });
    expect(cardStatus(P({ enabled: true, status: "loaded", updateAvailable: "2.0.0" }))).toMatchObject({ kind: "update" });
  });

  it("describes permissions in plain English with a risk level", () => {
    expect(describePermission({ category: "exec" })).toMatchObject({ title: "Run commands on this machine", risk: "high" });
    expect(describePermission({ category: "network", value: "api.example.com" })).toMatchObject({ title: "Connect to api.example.com", risk: "low" });
    expect(describePermission({ category: "network", value: "*" }).risk).toBe("medium");
    expect(describePermission({ category: "secrets", value: "OPENAI_KEY" }).risk).toBe("high");
    expect(describePermission({ category: "fs", value: "~" }).risk).toBe("high");
    expect(describePermission({ category: "fs", value: "~/data" }).risk).toBe("medium");
    const perms: PermissionState[] = [
      { key: "exec", category: "exec", consent: "", granted: true, dependents: [] },
      { key: "network:a", category: "network", value: "a", consent: "", granted: false, dependents: [] },
    ];
    expect(permissionSummary(perms)).toEqual({ requested: 2, granted: 1, high: 1 });
    expect(sortPermissionsByRisk([perms[1]!, perms[0]!]).map((p) => p.key)).toEqual(["exec", "network:a"]);
  });

  it("labels an un-granted gated permission 'Off by default', a user-revoked one 'Revoked'", () => {
    expect(permissionStatusLabel({ category: "gated", granted: false, defaultOff: true })).toBe("Off by default");
    expect(permissionStatusLabel({ category: "gated", granted: false })).toBe("Off by default");
    expect(permissionStatusLabel({ category: "gated", granted: true, defaultOff: true })).toBe("Granted");
    expect(permissionStatusLabel({ category: "network", granted: false })).toBe("Revoked");
    expect(permissionStatusLabel({ category: "exec", granted: true })).toBe("Granted");
    expect(describePermission({ category: "gated", value: "orders", label: "Place live orders" })).toMatchObject({
      title: "Place live orders",
      risk: "high",
    });
  });

  it("settings diff counts real changes; secrets only when a new value is typed", () => {
    const saved = { offline: false, feed: 30, token: { __secret: true, set: true }, nested: { a: 1, b: 2 } };
    expect(configChanges(saved, { ...saved })).toEqual([]);
    expect(configChanges(saved, { ...saved, offline: true, feed: 45 }, ["token"])).toEqual(["feed", "offline"]);
    expect(configChanges(saved, { ...saved, token: "new-secret" }, ["token"])).toEqual(["token"]);
    expect(configChanges(saved, { ...saved, token: "" }, ["token"])).toEqual([]);
    expect(configChanges(saved, { ...saved, nested: { a: 1, b: 3 } })).toEqual(["nested.b"]);
    expect(configChanges(saved, { ...saved, extra: "x" })).toEqual(["extra"]);
  });

  it("infers a category on older gateways that don't send one", () => {
    const old = (o: Partial<PluginSummary>) => P({ category: undefined, ...o });
    expect(categoryOf(old({ description: "InfiniBot Telegram channel plugin" }))).toBe("channels");
    expect(categoryOf(old({ description: "InfiniBot Gemini CLI OAuth provider plugin" }))).toBe("integrations");
    expect(categoryOf(old({ contributes: { nav: [], pages: [{ tab: "x", route: "/x" }], rpc: [], http: [] } }))).toBe("apps");
    expect(categoryOf(old({ description: "Typed workflow tool" }))).toBe("developer");
    expect(categoryOf(old({ category: "apps", description: "channel" }))).toBe("apps");
  });

  it("generated covers are deterministic, inert SVG with no external references", () => {
    const a = generatedCover("telegram", "channels");
    expect(a).toBe(generatedCover("telegram", "channels"));
    expect(a).not.toBe(generatedCover("discord", "channels"));
    const svg = decodeURIComponent(a.split(",")[1] ?? "");
    expect(a.startsWith("data:image/svg+xml")).toBe(true);
    expect(svg).not.toMatch(/<script|href=|url\(http|<image/i);
  });
});

// ── Hosted cloud plan / availability ──────────────────────────────────────

describe("cloud plugin status", () => {
  const base = { id: "flypic", name: "FlyPic", enabled: false, status: "disabled", origin: "bundled", source: "" } as never as import("./api.js").PluginSummary;
  it("locked plugins ask for an upgrade; coming-soon / self-host can't be enabled", () => {
    const locked = { ...base, cloud: { status: "locked", loadable: false, plan: "free", reason: "Not included in your plan (free). Upgrade to use it." } } as typeof base;
    expect(cardStatusCloud(locked)).toMatchObject({ kind: "locked", label: "Upgrade to unlock" });
    expect(primaryActionCloud(locked)).toMatchObject({ kind: "details", label: "Upgrade" });
    const soon = { ...base, cloud: { status: "coming-soon", loadable: false, plan: null } } as typeof base;
    expect(cardStatusCloud(soon).kind).toBe("soon");
    expect(primaryActionCloud(soon).kind).toBe("details");
    const selfHost = { ...base, cloud: { status: "self-host-only", loadable: false, plan: null } } as typeof base;
    expect(cardStatusCloud(selfHost).kind).toBe("selfhost");
  });
  it("allowed (or self-hosted, no cloud field) plugins behave as before", () => {
    const allowed = { ...base, cloud: { status: "allowed", loadable: true, plan: "pro" } } as typeof base;
    expect(cloudBlock(allowed)).toBeNull();
    expect(primaryActionCloud(allowed)).toMatchObject({ kind: "enable" });
    expect(cloudBlock(base)).toBeNull();
    expect(cardStatusCloud(base).kind).toBe("off");
  });
});

describe("plan channel locks (hosted Free: no Telegram, no Slack)", () => {
  const off = P({ id: "telegram", name: "Telegram", category: "channels", channels: ["telegram"] });
  const slack = P({ id: "slack", name: "Slack", category: "channels", channels: ["slack"], enabled: true, status: "loaded" });
  const soon = P({ id: "slack", channels: ["slack"], cloud: { status: "coming-soon", loadable: false, plan: "free" } });
  it("[] (paid / self-hosted) leaves the list untouched", () => {
    const list = [off, discord];
    expect(applyPlanChannelLocks(list, [])).toBe(list);
  });
  it("locks channel plugins the plan leaves out, with the upgrade as the primary action", () => {
    const [t, d] = applyPlanChannelLocks([off, discord], ["telegram", "slack"]);
    expect(t.cloud).toMatchObject({ status: "locked", loadable: false, lockedChannel: "telegram", plan: "free" });
    expect(cardStatusCloud(t)).toMatchObject({ kind: "locked", label: "Upgrade to unlock" });
    expect(primaryActionCloud(t)).toEqual({ kind: "upgrade", label: "Upgrade" });
    expect(d).toBe(discord);
  });
  it("an enabled one (downgrade) is locked too, never switched off by the UI", () => {
    const [s] = applyPlanChannelLocks([slack], ["slack"]);
    expect(s.enabled).toBe(true);
    expect(s.cloud?.lockedChannel).toBe("slack");
  });
  it("keeps a coming-soon / self-host decision from the server", () => {
    expect(applyPlanChannelLocks([soon], ["slack"])[0]).toBe(soon);
  });
});
