import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { parseManifestV2 } from "../../src/plugins/manifest-v2.js";
import { resolveDiscordPrivilegedIntentsFromFlags } from "../../src/discord/probe.js";
import { normalizeDiscordToken } from "../../src/discord/token.js";
import { ApprovalGate, needsApproval, type ApprovalsLike } from "./src/approval-gate.js";
import {
  assertCompliantOutbound,
  classifyMessage,
  detectBannedClaim,
  detectScam,
  OutboundBlockedError,
  withDisclaimer,
} from "./src/compliance.js";
import { RPC, RPC_SCOPES, ROUTED_OFFERS, type IntakeQuestion, type Offer, type Settings } from "./src/contract.js";
import { DEFAULT_ROUTE, renderWelcomeDm, routeOffer, routingMatrix } from "./src/routing.js";
import { DEFAULT_QUESTIONS, DEFAULT_DISCLAIMER, DEFAULT_WELCOME_DM } from "./src/defaults.js";
import { greetingPost, isClosedDmError, LEGACY_DEFAULT_WELCOME_DM } from "./src/greeting.js";
import { CommunityEngine, type DiscordPort } from "./src/engine.js";
import { createCommunityHandlers } from "./src/rpc.js";
import { pickAssignee, scoreLead, tierFor, validateQuestions } from "./src/scoring.js";
import { inviteUrl, missingPermissions, redactToken, runTestRun, sandboxRest, validateToken } from "./src/setup.js";
import { CommunityStore } from "./src/store.js";
import { createConfigWriter } from "./src/token-config.js";

// A syntactically valid but fake bot token (never a real one in tests).
const TOKEN = "MTQwMDAwMDAwMDAwMDAwMDAwMA.GaBcDe.abcdefghijklmnopqrstuvwxyz0123456789AB";
const GUILD = "900000000000000001";
const BOT_ID = "1400000000000000000";
const MEMBERS_AND_CONTENT = (1 << 14) | (1 << 18);

function fakeApprovals() {
  const created: Array<{ id: string; title: string; sourceRef?: Record<string, string> }> = [];
  const listeners: Array<(e: { type: string; record: { id: string; status: string; sourceRef?: Record<string, string> } }) => void> = [];
  const status = new Map<string, string>();
  const api: ApprovalsLike = {
    create(input) {
      const id = `ap_${created.length + 1}`;
      created.push({ id, title: input.title, sourceRef: input.sourceRef });
      status.set(id, "pending");
      return { id, status: "pending" };
    },
    get: (id) => (status.has(id) ? { id, status: status.get(id)! } : null),
    onEvent(l) {
      listeners.push(l);
      return () => {};
    },
  };
  const resolve = (id: string, approved: boolean) => {
    status.set(id, approved ? "approved" : "denied");
    const rec = created.find((c) => c.id === id)!;
    for (const l of listeners) l({ type: "resolved", record: { id, status: approved ? "approved" : "denied", sourceRef: rec.sourceRef } });
  };
  return { api, created, resolve };
}

function liveSettings(store: CommunityStore, patch: Partial<Settings> = {}): Settings {
  return store.saveSettings({
    guildId: GUILD,
    guildName: "Test Guild",
    mode: "live",
    channelMap: { "start-here": "1001", support: "1002", "onboarding-desk": "1003", "mod-log": "1004", announcements: "1005" },
    roleMap: { unverified: "2001", verified: "2002", "interest-pulse": "2003", "interest-infinibot": "2004", "interest-kinglyvault": "2005" },
    compliance: { ...store.getSettings().compliance, tradingChannelIds: ["1009"], repostEvery: 3 },
    ...patch,
  });
}

function makeEngine(store: CommunityStore, approvals: ApprovalsLike | null = fakeApprovals().api) {
  const { rest, calls } = sandboxRest();
  const alerts: string[] = [];
  const engine = new CommunityEngine({
    store,
    rest,
    gate: new ApprovalGate(approvals),
    token: () => TOKEN,
    alertOwner: async (a) => void alerts.push(a.title),
    snowflakeToMs: () => Date.now() - 365 * 86_400_000,
    dmPacingMs: [0, 0],
  });
  return { engine, calls, alerts };
}

const answersFor = (pick: (opts: typeof DEFAULT_QUESTIONS[number]["options"]) => string) =>
  Object.fromEntries(DEFAULT_QUESTIONS.map((q) => [q.id, pick(q.options)]));

describe("lead scoring + routing", () => {
  it("default questions validate (weights add up to 100, ≤ 5 questions)", () => {
    expect(validateQuestions(DEFAULT_QUESTIONS)).toEqual([]);
    expect(DEFAULT_QUESTIONS.reduce((n, q) => n + q.weight, 0)).toBe(100);
  });

  it("scores the weighted sum and tiers it (hot ≥ 60, warm 30–59, nurture < 30)", () => {
    const best = scoreLead(DEFAULT_QUESTIONS, answersFor((o) => [...o].sort((a, b) => b.points - a.points)[0]!.value));
    expect(best.complete).toBe(true);
    expect(best.tier).toBe("hot");
    expect(best.offer).toBe("infinibot");
    expect(best.route.secondaryOffer).toBe("kinglyvault-plugins");
    expect(best.roles).toEqual(["interest-infinibot"]);
    // 30*90 + 15*100 + 30*100 + 15*85 + 10*100 = 9475 / 100 = 94.75
    expect(best.score).toBe(95);

    const trader = scoreLead(DEFAULT_QUESTIONS, { goal: "trading", now: "business", budget: "200+", trading: "active", age: "yes" });
    expect(trader.offer).toBe("pulse");
    expect(trader.route.secondaryOffer).toBe("kinglyvault");
    // 21 + 13.5 + 30 + 12.75 + 10 = 87.25
    expect(trader.score).toBe(87);

    const kv = scoreLead(DEFAULT_QUESTIONS, { goal: "learn", now: "student", budget: "lt20", trading: "never", age: "yes" });
    expect(kv.offer).toBe("kinglyvault");
    expect(kv.route.secondaryOffer).toBe("infinibot");
    expect(kv.score).toBe(46); // 22.5 + 3 + 7.5 + 3 + 10
    expect(kv.tier).toBe("warm");

    const lurker = scoreLead(DEFAULT_QUESTIONS, { goal: "network", now: "student", budget: "0", trading: "never", age: "no" });
    expect(lurker.tier).toBe("nurture");
    // Networking / low score is not a dead end: default route InfiniBot free + KinglyVault free.
    expect(lurker.offer).toBe("infinibot");
    expect(lurker.route).toMatchObject({ secondaryOffer: "kinglyvault", reason: "default" });
    expect([tierFor(60), tierFor(59), tierFor(30), tierFor(29)]).toEqual(["hot", "warm", "warm", "nurture"]);
  });

  it("flags broken questionnaires", () => {
    const bad = DEFAULT_QUESTIONS.map((q) => ({ ...q, weight: 10 }));
    expect(validateQuestions(bad).map((i) => i.message).join(" ")).toMatch(/add up to 50/);
    const dup = [{ ...DEFAULT_QUESTIONS[0]!, weight: 100, options: [{ value: "a", label: "A", points: 1 }, { value: "a", label: "B", points: 2 }] }];
    expect(validateQuestions(dup).map((i) => i.message).join(" ")).toMatch(/Duplicate option/);
    expect(validateQuestions([...DEFAULT_QUESTIONS, { ...DEFAULT_QUESTIONS[0]!, id: "six" }]).some((i) => /At most 5/.test(i.message))).toBe(true);
  });

  it("routes to the least-loaded active onboarder who covers the offer", () => {
    const team = [
      { discordId: "1", name: "Ari", role: "onboarder" as const, offers: ["pulse" as const], active: true, openLeads: 3, lastAssignedAt: 1 },
      { discordId: "2", name: "Jo", role: "onboarder" as const, offers: ["pulse" as const, "infinibot" as const], active: true, openLeads: 1, lastAssignedAt: 5 },
      { discordId: "3", name: "Sam", role: "onboarder" as const, offers: ["pulse" as const], active: false, openLeads: 0, lastAssignedAt: 0 },
      { discordId: "4", name: "Mod", role: "moderator" as const, offers: [], active: true, openLeads: 0, lastAssignedAt: 0 },
    ];
    expect(pickAssignee(team, "pulse")?.name).toBe("Jo");
    expect(pickAssignee(team, "kinglyvault")).toBeNull();
    expect(pickAssignee([{ ...team[0]!, openLeads: 1, lastAssignedAt: 1 }, team[1]!], "pulse")?.name).toBe("Ari");
  });

  it("intake → lead in the queue with score, offer tag, assignee, onboarder thread and owner ping", async () => {
    const store = new CommunityStore(":memory:");
    liveSettings(store);
    store.saveTeam([{ discordId: "3001", name: "Ari", role: "onboarder", offers: ["pulse"], active: true }]);
    const { engine, calls, alerts } = makeEngine(store);
    const base = { accountId: "ycs", guildId: GUILD };
    const user = { id: "5001", username: "maya" };
    await engine.handleEvent({ kind: "member_add", ...base, user, joinedAt: null });
    expect(calls.map((c) => c.fn)).toEqual(["assignRole", "sendDM"]); // Unverified role + one welcome DM
    const v = await engine.handleEvent({ kind: "component", ...base, channelId: "1001", user, customId: "cm:a=verify", values: [] });
    expect(v?.components).toBeTruthy();
    expect(calls.some((c) => c.fn === "assignRole" && c.args[1] === "2002")).toBe(true);
    expect(calls.some((c) => c.fn === "removeRole" && c.args[1] === "2001")).toBe(true);
    const answers = { goal: "trading", now: "agency", budget: "200+", trading: "active", age: "yes" };
    let reply = null;
    for (const [q, a] of Object.entries(answers)) {
      reply = await engine.handleEvent({ kind: "component", ...base, channelId: "1001", user, customId: `cmsel:q=${q}`, values: [a] });
    }
    expect(reply?.content).toMatch(/onboarder will reach out/);
    expect(reply?.content).toMatch(/Gold Desk/);
    const [lead] = store.listLeads();
    expect(lead).toMatchObject({ memberId: "5001", offer: "pulse", primaryOffer: "pulse", secondaryOffer: "kinglyvault", tier: "hot", score: 89, assigneeName: "Ari", stage: "new" });
    expect(lead!.slaDueAt).toBeGreaterThan(Date.now());
    expect(lead!.threadId).toMatch(/^sandbox-thread/);
    expect(calls.some((c) => c.fn === "assignRole" && c.args[1] === "2003")).toBe(true); // Pulse interest role
    expect(calls.some((c) => c.fn === "createPrivateThread" && c.args[0] === "1003")).toBe(true);
    expect(alerts).toEqual(["Hot lead: maya"]);
    // A second join of the same member never re-sends the welcome DM.
    const dms = calls.filter((c) => c.fn === "sendDM").length;
    await engine.handleEvent({ kind: "member_add", ...base, user, joinedAt: null });
    expect(calls.filter((c) => c.fn === "sendDM").length).toBe(dms);
  });
});

// ── No dead ends (owner rule: "everyone is directed somewhere, there should never be no offer") ──

/** Every combination of answers, including "not answered" for each question. */
function* everyAnswerCombo(questions: IntakeQuestion[]): Generator<Record<string, string>> {
  const choices = questions.map((q) => [undefined, ...q.options.map((o) => o.value), "garbage-value"]);
  const idx = choices.map(() => 0);
  while (true) {
    const answers: Record<string, string> = {};
    questions.forEach((q, i) => {
      const v = choices[i]![idx[i]!];
      if (v !== undefined) answers[q.id] = v;
    });
    yield answers;
    let k = 0;
    while (k < idx.length && ++idx[k]! === choices[k]!.length) idx[k++] = 0;
    if (k === idx.length) return;
  }
}

/** Seeded PRNG so the random questionnaires are reproducible. */
function rng(seed: number) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
const OFFER_TAGS: Array<Offer | undefined> = [undefined, "infinibot", "kinglyvault", "kinglyvault-plugins", "pulse", "none"];

function randomQuestionnaire(r: () => number): IntakeQuestion[] {
  const n = 1 + Math.floor(r() * 5);
  return Array.from({ length: n }, (_, qi) => {
    const gate = (["age", "region", "capital", undefined] as const)[Math.floor(r() * 4)];
    const opts = 2 + Math.floor(r() * 4);
    return {
      id: gate && r() < 0.5 ? gate : `q${qi}`,
      label: gate === "age" ? "Are you 18 or older?" : `Question ${qi}`,
      type: "single" as const,
      weight: Math.floor(r() * 50),
      gate: r() < 0.5 ? gate : undefined,
      options: Array.from({ length: opts }, (_, oi) => ({
        value: ["yes", "no", "under-18", "us", "blocked", `v${oi}`][Math.floor(r() * 6)]! + oi,
        label: ["Yes", "No, I'm under 18", "Maybe", "$100+ funded", "No money", ""][Math.floor(r() * 6)]!,
        points: Math.floor(r() * 101),
        offer: OFFER_TAGS[Math.floor(r() * OFFER_TAGS.length)],
        pass: r() < 0.3 ? r() < 0.5 : undefined,
      })),
    };
  });
}

function expectRouted(route: ReturnType<typeof routeOffer>, ctx: unknown) {
  const where = JSON.stringify(ctx);
  expect(ROUTED_OFFERS, where).toContain(route.primaryOffer);
  expect(ROUTED_OFFERS, where).toContain(route.secondaryOffer);
  expect(route.secondaryOffer, where).not.toBe(route.primaryOffer);
  expect(route.cta.trim().length, where).toBeGreaterThan(20);
  expect(route.cta, where).toMatch(/#|<#\d+>/); // a concrete place to go
  expect(route.cta.toLowerCase(), where).not.toMatch(/no offer|disqualified|not eligible/);
  // Hard age gate: without a confirmed 18+, Gold Desk / Pulse is never an offer.
  if (route.gates.age !== "pass") {
    expect(route.primaryOffer, where).not.toBe("pulse");
    expect(route.secondaryOffer, where).not.toBe("pulse");
  }
}

describe("offer routing: no dead ends", () => {
  it("every answer combination of the default intake (incl. empty, under-18, low score) gets primary + secondary + CTA", () => {
    let n = 0;
    for (const answers of everyAnswerCombo(DEFAULT_QUESTIONS)) {
      for (const blockedRegions of [[], ["us"]]) {
        const s = scoreLead(DEFAULT_QUESTIONS, answers, { channelMap: {}, offerLinks: {}, compliance: { ...defaultCompliance(), blockedRegions } });
        expectRouted(s.route, answers);
        expect(s.offer).toBe(s.route.primaryOffer);
        if (s.route.gates.age !== "pass") expect(s.roles).not.toContain("interest-pulse");
        n++;
      }
    }
    expect(n).toBe(7 * 7 * 7 * 6 * 4 * 2); // every combo, both region settings
  });

  it("under-18 or unknown age + 'Learn to trade' → KinglyVault free trading education + InfiniBot, never Pulse", () => {
    const base = { goal: "trading", now: "agency", budget: "200+", trading: "active" };
    for (const answers of [{ ...base, age: "no" }, { ...base }, { ...base, age: "garbage" }]) {
      const s = scoreLead(DEFAULT_QUESTIONS, answers);
      expect(s.route).toMatchObject({ primaryOffer: "kinglyvault", secondaryOffer: "infinibot" });
      expect(s.route.reason).toMatch(/^trading-(under-18|age-unknown)$/);
      expect(s.route.cta).toMatch(/Free trading education on KinglyVault/);
      expect(s.roles).not.toContain("interest-pulse");
    }
    // The live YCS questionnaire has no explicit gate tags: the age gate is inferred from the question.
    const untagged = DEFAULT_QUESTIONS.map(({ gate: _g, ...q }) => ({ ...q, options: q.options.map(({ pass: _p, ...o }) => o) }));
    expect(scoreLead(untagged, { ...base, age: "no" }).route.primaryOffer).toBe("kinglyvault");
    expect(scoreLead(untagged, { ...base, age: "yes" }).route.primaryOffer).toBe("pulse");
    expect(scoreLead(untagged, { ...base, trading: "learning-no-capital", age: "yes" }).route).toMatchObject({ primaryOffer: "kinglyvault", reason: "trading-not-funded" });
  });

  it("the matrix: AI → InfiniBot+Plugins, learn → KV+InfiniBot, qualified trader → Gold Desk+KV, unknown → InfiniBot free+KV free", () => {
    const q = DEFAULT_QUESTIONS;
    const r = (a: Record<string, string>) => routeOffer(q, a);
    expect(r({ goal: "ai" })).toMatchObject({ primaryOffer: "infinibot", secondaryOffer: "kinglyvault-plugins" });
    expect(r({ goal: "learn" })).toMatchObject({ primaryOffer: "kinglyvault", secondaryOffer: "infinibot" });
    expect(r({ goal: "plugins" })).toMatchObject({ primaryOffer: "kinglyvault-plugins", secondaryOffer: "infinibot" });
    expect(r({ goal: "trading", trading: "learning-capital", age: "yes" })).toMatchObject({ primaryOffer: "pulse", secondaryOffer: "kinglyvault" });
    expect(r({ goal: "trading", trading: "learning-capital", age: "yes" }).cta).toMatch(/risk disclosure/);
    expect(r({})).toMatchObject(DEFAULT_ROUTE);
    expect(r({ goal: "network" })).toMatchObject(DEFAULT_ROUTE);
    expect(routeOffer(null, null)).toMatchObject(DEFAULT_ROUTE);
    expect(routeOffer([], {})).toMatchObject(DEFAULT_ROUTE);
    // A configured region question that fails blocks Gold Desk.
    const withRegion: IntakeQuestion[] = [...q.slice(0, 4), { id: "region", label: "Where do you live?", type: "single", weight: 10, options: [{ value: "ok", label: "Allowed country", points: 50 }, { value: "xx", label: "XX", points: 50 }] }];
    const blocked = routeOffer(withRegion, { goal: "trading", trading: "active", region: "xx" }, { channelMap: {}, offerLinks: {}, compliance: { ...defaultCompliance(), blockedRegions: ["xx"] } });
    expect(blocked.primaryOffer).toBe("kinglyvault"); // and no age question at all → unknown age anyway
  });

  it("2,000 random questionnaires × random answers never produce a lead without an offer and a CTA", () => {
    const r = rng(20261023);
    for (let i = 0; i < 2000; i++) {
      const qs = randomQuestionnaire(r);
      const answers: Record<string, string> = {};
      for (const q of qs) if (r() < 0.8) answers[q.id] = r() < 0.9 ? q.options[Math.floor(r() * q.options.length)]!.value : "nope";
      expectRouted(scoreLead(qs, answers).route, { qs, answers });
    }
  });

  it("CTAs use mapped channels and owner links only (nothing invented)", () => {
    const route = routeOffer(DEFAULT_QUESTIONS, { goal: "ai" }, { channelMap: { "offer-infinibot": "777" }, offerLinks: { infinibot: "https://example.test/ib" }, compliance: defaultCompliance() });
    expect(route.cta).toContain("<#777> · https://example.test/ib");
    expect(route.cta).toContain("#vault-start-here"); // unmapped → the server's channel name, no link
    expect(route.cta).not.toMatch(/\$\d/); // never a price
  });

  it("the store refuses a lead without a routed offer + CTA, and legacy 'none' rows read as the default route", () => {
    const store = new CommunityStore(":memory:");
    const base = { guildId: GUILD, memberId: "1", username: "x", score: 0, tier: "nurture" as const, breakdown: [], stage: "new" as const, assigneeId: null, assigneeName: null, slaDueAt: null, threadId: null, routeReason: "default" };
    expect(() => store.createLead({ ...base, primaryOffer: "infinibot", secondaryOffer: "kinglyvault", cta: " " })).toThrow(/CTA/);
    store.db.prepare("INSERT INTO cm_leads (id, guild_id, member_id, username, offer, score, tier, breakdown, stage, created_at, updated_at) VALUES ('old', ?, '2', 'legacy', 'none', 5, 'nurture', '[]', 'new', 1, 1)").run(GUILD);
    const legacy = store.getLead("old")!;
    expect(legacy).toMatchObject({ primaryOffer: "infinibot", secondaryOffer: "kinglyvault", offer: "infinibot" });
    expect(legacy.cta).toMatch(/InfiniBot/);
  });

  it("end to end: under-18 trader, empty intake and low-score member all leave with an offer in Discord", async () => {
    const store = new CommunityStore(":memory:");
    liveSettings(store);
    store.saveTeam([{ discordId: "3001", name: "Ari", role: "onboarder", offers: ["pulse", "kinglyvault"], active: true }]);
    const { engine, calls } = makeEngine(store);
    const base = { accountId: "ycs", guildId: GUILD };
    const cases: Array<[string, Record<string, string>, RegExp]> = [
      ["teen", { goal: "trading", now: "student", budget: "200+", trading: "active", age: "no" }, /Free trading education on KinglyVault/],
      ["lurker", { goal: "network", now: "student", budget: "0", trading: "never", age: "no" }, /Start free with InfiniBot/],
      ["kv", { goal: "learn", now: "job", budget: "lt20", trading: "never", age: "yes" }, /Learn free on KinglyVault/],
    ];
    for (const [i, [name, answers, ctaRe]] of cases.entries()) {
      const user = { id: `60${i}`, username: name };
      await engine.handleEvent({ kind: "member_add", ...base, user, joinedAt: null });
      const dm = calls.filter((c) => c.fn === "sendDM").at(-1)!;
      expect(String(dm.args[1])).toMatch(/Start free with InfiniBot[\s\S]*KinglyVault/); // welcome DM carries the default route
      await engine.handleEvent({ kind: "component", ...base, channelId: "1001", user, customId: "cm:a=verify", values: [] });
      let reply = null;
      for (const [q, a] of Object.entries(answers)) {
        reply = await engine.handleEvent({ kind: "component", ...base, channelId: "1001", user, customId: `cmsel:q=${q}`, values: [a] });
      }
      expect(reply?.content).toMatch(ctaRe);
      expect(reply?.content).toMatch(/Also for you:/);
      const lead = store.listLeads().find((l) => l.username === name)!;
      expect(ROUTED_OFFERS).toContain(lead.primaryOffer);
      expect(lead.cta).toMatch(ctaRe);
    }
    expect(store.listLeads().find((l) => l.username === "teen")).toMatchObject({ primaryOffer: "kinglyvault", secondaryOffer: "infinibot", routeReason: "trading-under-18" });
    // The teen never got the trading interest role.
    expect(calls.some((c) => c.fn === "assignRole" && c.args[0] === "600" && c.args[1] === "2003")).toBe(false);
  });

  it("the live YCS questionnaire (10-23 snapshot, no gate tags): every combo routed, minors and unfunded never reach Gold Desk", () => {
    const live = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "test-fixtures/ycs-live-questions-2026-10-23.json"), "utf8")) as IntakeQuestion[];
    let n = 0;
    for (const answers of everyAnswerCombo(live)) {
      const s = scoreLead(live, answers);
      expectRouted(s.route, answers);
      if (s.route.primaryOffer === "pulse") {
        expect(answers.age, JSON.stringify(answers)).toBe("yes");
        expect(["ready-100", "active"], JSON.stringify(answers)).toContain(answers.trading);
      }
      n++;
    }
    expect(n).toBe(8 * 4 * 7 * 6 * 7); // every combo incl. unanswered + garbage per question
    const r = (a: Record<string, string>) => routeOffer(live, a);
    expect(r({ goal: "trading", age: "yes", trading: "ready-100" }).primaryOffer).toBe("pulse");
    expect(r({ goal: "trading", age: "no", trading: "active" })).toMatchObject({ primaryOffer: "kinglyvault", secondaryOffer: "infinibot", reason: "trading-under-18" });
    expect(r({ goal: "trading", age: "no", trading: "active" }).cta).toMatch(/Free trading education on KinglyVault/);
    expect(r({ goal: "trading", age: "yes", trading: "never" })).toMatchObject({ primaryOffer: "kinglyvault", reason: "trading-not-funded" });
    expect(r({ goal: "trading", trading: "active" })).toMatchObject({ primaryOffer: "kinglyvault", reason: "trading-age-unknown" });
    expect(r({ goal: "trading", age: "yes", trading: "learning-no-capital" }).primaryOffer).toBe("kinglyvault");
    expect(r({ goal: "trading", age: "yes", trading: "region-unsure" }).primaryOffer).toBe("kinglyvault");
    // The 10-22 config that tagged the "Learn to trade" goal as Pulse: an under-18 answer still never reaches Pulse.
    const old = live.map((q) => (q.id === "goal" ? { ...q, options: q.options.map((o) => (o.value === "trading" ? { ...o, offer: "pulse" as const } : o)) } : q));
    expect(routeOffer(old, { goal: "trading", age: "no", trading: "active" })).toMatchObject({ primaryOffer: "kinglyvault", reason: "trading-under-18" });
    expect(scoreLead(old, { goal: "trading", age: "no", trading: "active" }).roles).not.toContain("interest-pulse");
    for (const row of routingMatrix(live).filter((x) => x.id === "trade-minor" || x.id === "trade-unfunded")) {
      expect(row.route.cta, row.id).toMatch(/Free trading education on KinglyVault/);
    }
    // The wizard preview matrix on the live questionnaire: unfunded traders are not shown as Gold Desk.
    expect(Object.fromEntries(routingMatrix(live).map((r) => [r.id, `${r.route.primaryOffer}+${r.route.secondaryOffer}`]))).toEqual({
      ai: "infinibot+kinglyvault-plugins",
      learn: "kinglyvault+infinibot",
      "trade-ok": "pulse+kinglyvault",
      "trade-minor": "kinglyvault+infinibot",
      "trade-unfunded": "kinglyvault+infinibot",
      fallback: "infinibot+kinglyvault",
    });
  });

  it("the who-goes-where matrix has every segment plus an explicit fallback row, all with offers", () => {
    const rows = routingMatrix(DEFAULT_QUESTIONS);
    expect(rows.map((r) => [r.id, r.route.primaryOffer, r.route.secondaryOffer])).toEqual([
      ["ai", "infinibot", "kinglyvault-plugins"],
      ["learn", "kinglyvault", "infinibot"],
      ["plugins", "kinglyvault-plugins", "infinibot"],
      ["trade-ok", "pulse", "kinglyvault"],
      ["trade-minor", "kinglyvault", "infinibot"],
      ["trade-unfunded", "kinglyvault", "infinibot"],
      ["fallback", "infinibot", "kinglyvault"],
    ]);
    for (const r of rows) expectRouted(r.route, r.id);
  });

  it("welcome DM: {offers} places the default route; templates without it get it appended", () => {
    expect(renderWelcomeDm("Hi {name}!", "maya")).toMatch(/^Hi maya!\n\nNot sure where to start\? Start free with InfiniBot/);
    const owner = "Welcome {name}! InfiniBot (#infinibot-start-here) and KinglyVault for free courses (#vault-start-here).";
    expect(renderWelcomeDm(owner, "maya")).toBe(owner.replace("{name}", "maya")); // already routes: not repeated
    expect(renderWelcomeDm("Hi {name}! {offers} Bye", "maya")).toMatch(/Hi maya! Not sure where to start\?[\s\S]*KinglyVault[\s\S]* Bye$/);
  });
});

function defaultCompliance() {
  return new CommunityStore(":memory:").getSettings().compliance;
}

describe("compliance", () => {
  it("catches scam links, lookalikes and scam phrases", () => {
    expect(detectScam("claim https://discord-nitro.gift/xyz")?.rule).toBe("scam-domain");
    expect(detectScam("login at https://dlscord-app.com/login")?.rule).toBe("lookalike-domain");
    expect(detectScam("get FREE NITRO now")?.rule).toBe("scam-phrase");
    expect(detectScam("see https://discord.com/channels/1/2")).toBeNull();
    expect(detectScam("https://evil.example/x", ["evil.example"])?.rule).toBe("scam-domain");
  });

  it("catches banned financial claims and return promises", () => {
    expect(detectBannedClaim("This is GUARANTEED PROFIT bro")?.match).toBe("guaranteed profit");
    expect(detectBannedClaim("we make 20% per month")?.rule).toBe("return-promise");
    expect(detectBannedClaim("dm me for signals")).not.toBeNull();
    expect(detectBannedClaim("we had a good month")).toBeNull();
    expect(classifyMessage("join discord.gg/abc", { blockInvites: true })?.kind).toBe("invite");
    expect(classifyMessage("join discord.gg/abc", { blockInvites: false })).toBeNull();
  });

  it("footers the disclaimer and never sends a banned claim", () => {
    const out = withDisclaimer("Market recap", DEFAULT_DISCLAIMER);
    expect(out).toContain(DEFAULT_DISCLAIMER);
    expect(withDisclaimer(out, DEFAULT_DISCLAIMER)).toBe(out);
    expect(() => assertCompliantOutbound(out, { disclaimer: DEFAULT_DISCLAIMER })).not.toThrow();
    expect(() => assertCompliantOutbound("Risk-free 100% win rate!")).toThrow(OutboundBlockedError);
  });

  it("puts the disclaimer on bot posts in trading channels and re-posts it every N messages", async () => {
    const store = new CommunityStore(":memory:");
    liveSettings(store);
    const { engine, calls } = makeEngine(store);
    await engine.post(store.getSettings(), "1009", "Gold Desk update");
    expect(String(calls.at(-1)!.args[1])).toContain(DEFAULT_DISCLAIMER);
    await engine.post(store.getSettings(), "1005", "General update");
    expect(String(calls.at(-1)!.args[1])).not.toContain(DEFAULT_DISCLAIMER);
    for (let i = 0; i < 3; i += 1) {
      await engine.handleEvent({ kind: "message", accountId: "ycs", guildId: GUILD, channelId: "1009", messageId: `m${i}`, author: { id: "7", username: "t" }, content: "nice chart" });
    }
    expect(calls.filter((c) => c.fn === "sendMessage" && c.args[0] === "1009" && c.args[1] === DEFAULT_DISCLAIMER)).toHaveLength(1);
    await expect(engine.post(store.getSettings(), "1005", "guaranteed returns every week")).rejects.toThrow(OutboundBlockedError);
  });
});

describe("approval gate", () => {
  it("gates bans, kicks, long timeouts, mass DMs and @everyone", () => {
    expect(needsApproval({ action: "ban" })).toBe(true);
    expect(needsApproval({ action: "kick" })).toBe(true);
    expect(needsApproval({ action: "timeout", durationMs: 60 * 60_000 })).toBe(false);
    expect(needsApproval({ action: "timeout", durationMs: 61 * 60_000 })).toBe(true);
    expect(needsApproval({ action: "mass_dm", recipients: 25 })).toBe(false);
    expect(needsApproval({ action: "mass_dm", recipients: 26 })).toBe(true);
    expect(needsApproval({ action: "announce_everyone" })).toBe(true);
    expect(needsApproval({ action: "warn" })).toBe(false);
  });

  it("a scam message is deleted + quarantined at once, but the ban waits for approval", async () => {
    const store = new CommunityStore(":memory:");
    liveSettings(store);
    const ap = fakeApprovals();
    const { engine, calls } = makeEngine(store, ap.api);
    engine.start(() => () => {}, 0);
    await engine.handleEvent({ kind: "message", accountId: "ycs", guildId: GUILD, channelId: "1006", messageId: "m1", author: { id: "6001", username: "x1" }, content: "free nitro https://discord-nitro.gift/a" });
    const fns = calls.map((c) => c.fn);
    expect(fns).toContain("deleteMessage");
    expect(fns).toContain("timeoutMember");
    expect(fns).not.toContain("banMember");
    expect(ap.created.map((c) => c.title)).toEqual(["Ban @x1?"]);
    const pending = store.listModActions({ status: "pending_approval" });
    expect(pending).toHaveLength(1);

    ap.resolve(ap.created[0]!.id, true);
    await new Promise((r) => setTimeout(r, 10));
    expect(calls.filter((c) => c.fn === "banMember")).toHaveLength(1);
    expect(store.getModAction(pending[0]!.id)?.status).toBe("approved");
    engine.stop();
  });

  it("a denied (or expired) approval never runs the action", async () => {
    const store = new CommunityStore(":memory:");
    const s = liveSettings(store);
    const ap = fakeApprovals();
    const { engine, calls } = makeEngine(store, ap.api);
    engine.start(() => () => {}, 0);
    const rec = await engine.moderate(s, { action: "kick", targetId: "6002", targetName: "y", durationMs: null, rule: "agent", reason: "spam" });
    expect(rec.status).toBe("pending_approval");
    ap.resolve(ap.created[0]!.id, false);
    await new Promise((r) => setTimeout(r, 10));
    expect(calls.some((c) => c.fn === "kickMember")).toBe(false);
    expect(store.getModAction(rec.id)?.status).toBe("denied");
    engine.stop();
  });

  it("with no approval system, gated actions are denied by default", async () => {
    const store = new CommunityStore(":memory:");
    const s = liveSettings(store);
    const { engine, calls } = makeEngine(store, null);
    const rec = await engine.moderate(s, { action: "ban", targetId: "6003", targetName: "z", durationMs: null, rule: "agent", reason: "x" });
    expect(rec.status).toBe("denied");
    expect(calls).toHaveLength(0);
  });

  it("@everyone posts and big DM batches go through approval", async () => {
    const store = new CommunityStore(":memory:");
    const s = liveSettings(store);
    const ap = fakeApprovals();
    const { engine, calls } = makeEngine(store, ap.api);
    engine.start(() => () => {}, 0);
    await expect(engine.post(s, "1005", "@everyone hi")).rejects.toThrow(/approval/);
    store.createCampaign({ title: "Launch", content: "@everyone we launch", channelId: "1005", scheduleAt: Date.now() - 1, status: "scheduled", pingsEveryone: true });
    await engine.tick();
    expect(calls.filter((c) => c.fn === "sendMessage")).toHaveLength(0);
    expect(store.listCampaigns()[0]!.status).toBe("pending_approval");
    ap.resolve(ap.created[0]!.id, true);
    await new Promise((r) => setTimeout(r, 10));
    const sent = calls.filter((c) => c.fn === "sendMessage");
    expect(sent).toHaveLength(1);
    expect((sent[0]!.args[2] as { allowedMentions: { parse: string[] } }).allowedMentions.parse).toContain("everyone");

    const ids = Array.from({ length: 30 }, (_, i) => String(7000000 + i));
    const dm = await engine.requestMassDm(s, ids, "Event tonight");
    expect(dm.status).toBe("pending_approval");
    expect(calls.some((c) => c.fn === "sendDM")).toBe(false);
    engine.stop();
  });

  it("shadow mode and pause take no Discord actions", async () => {
    const store = new CommunityStore(":memory:");
    liveSettings(store, { mode: "shadow" });
    const { engine, calls } = makeEngine(store);
    const base = { accountId: "ycs", guildId: GUILD };
    await engine.handleEvent({ kind: "member_add", ...base, user: { id: "8001", username: "a" }, joinedAt: null });
    await engine.handleEvent({ kind: "message", ...base, channelId: "1006", messageId: "m", author: { id: "8002", username: "b" }, content: "https://discord-nitro.gift/z" });
    expect(calls).toHaveLength(0);
    expect(store.listActivity().some((a) => a.dry && /\[shadow\] would delete/.test(a.text))).toBe(true);

    store.saveSettings({ mode: "live", paused: true });
    await engine.handleEvent({ kind: "member_add", ...base, user: { id: "8003", username: "c" }, joinedAt: null });
    const r = await engine.handleEvent({ kind: "component", ...base, channelId: "1001", user: { id: "8003", username: "c" }, customId: "cm:a=verify", values: [] });
    expect(r?.content).toMatch(/paused/);
    expect(calls).toHaveLength(0);
  });

  it("ignores other servers, other accounts and setup mode", async () => {
    const store = new CommunityStore(":memory:");
    liveSettings(store);
    const { engine, calls } = makeEngine(store);
    await engine.handleEvent({ kind: "member_add", accountId: "ycs", guildId: "1", user: { id: "9", username: "x" }, joinedAt: null });
    await engine.handleEvent({ kind: "member_add", accountId: "default", guildId: GUILD, user: { id: "9", username: "x" }, joinedAt: null });
    store.saveSettings({ mode: "setup" });
    await engine.handleEvent({ kind: "member_add", accountId: "ycs", guildId: GUILD, user: { id: "9", username: "x" }, joinedAt: null });
    expect(calls).toHaveLength(0);
  });
});

// ── Per-module live list + new-member greeting ─────────────────────────────

const WELCOME = "1562870906890616902";
const greetMap = {
  "start-here": "1562870938486182020",
  welcome: WELCOME,
  introductions: "1562870913769144460",
  support: "1562870916348907581",
  faq: "1562870946610552832",
  lives: "1562871015606976724",
  "onboarding-desk": "1003",
  "mod-log": "1004",
  announcements: "1005",
};

function greetingOnly(store: CommunityStore, patch: Partial<Settings> = {}): Settings {
  return liveSettings(store, { mode: "shadow", liveModules: ["greeting"], channelMap: greetMap, ...patch });
}

const join = (id: string, username = `u${id}`) =>
  ({ kind: "member_add", accountId: "ycs", guildId: GUILD, user: { id, username }, joinedAt: null }) as const;

describe("liveModules + welcome greeting", () => {
  it("greeting acts LIVE while moderation, roles and disclaimers still only shadow-log", async () => {
    const store = new CommunityStore(":memory:");
    greetingOnly(store);
    const { engine, calls } = makeEngine(store);
    await engine.handleEvent(join("8101", "newbie"));
    await engine.handleEvent({ kind: "message", accountId: "ycs", guildId: GUILD, channelId: "1006", messageId: "m1", author: { id: "8102", username: "spam" }, content: "free nitro https://discord-nitro.gift/z" });

    // Exactly the public greeting + the welcome DM reached Discord.
    expect(calls.map((c) => c.fn)).toEqual(["sendMessage", "sendDM"]);
    expect(calls[0]!.args[0]).toBe(WELCOME);
    // No Unverified role (Verify is not running), no delete / timeout / ban.
    expect(calls.some((c) => ["assignRole", "deleteMessage", "timeoutMember", "banMember"].includes(c.fn))).toBe(false);
    const acts = store.listActivity();
    expect(acts.some((a) => a.dry && /\[shadow\] would give @newbie the Unverified role/.test(a.text))).toBe(true);
    expect(acts.some((a) => a.dry && /\[shadow\] would delete/.test(a.text))).toBe(true);
    expect(store.listModActions()).not.toContainEqual(expect.objectContaining({ status: "done" }));
    expect(store.getMember(GUILD, "8101")?.welcomedAt).toBeTruthy();
  });

  it("no liveModules = the old global behaviour (shadow touches nothing, live does everything)", async () => {
    const store = new CommunityStore(":memory:");
    liveSettings(store, { mode: "shadow", channelMap: greetMap });
    expect(store.getSettings().liveModules).toEqual([]);
    const { engine, calls } = makeEngine(store);
    await engine.handleEvent(join("8201"));
    expect(calls).toHaveLength(0);
    expect(store.listActivity().some((a) => a.dry && /\[shadow\] would greet @u8201/.test(a.text))).toBe(true);

    store.saveSettings({ mode: "live" });
    await engine.handleEvent(join("8202"));
    expect(calls.map((c) => c.fn).sort()).toEqual(["assignRole", "sendDM", "sendMessage"]);

    // pause beats liveModules
    store.saveSettings({ mode: "shadow", liveModules: ["greeting"], paused: true });
    await engine.handleEvent(join("8203"));
    expect(calls).toHaveLength(3);
  });

  it("public greeting: embed with the 3 steps + link buttons, mentions only the new member, < 600 chars", async () => {
    const store = new CommunityStore(":memory:");
    greetingOnly(store, { guildName: "YungCEO SOCIETY💰" });
    const { engine, calls } = makeEngine(store);
    await engine.handleEvent(join("8301", "ash"));
    const [content, opts] = [calls[0]!.args[1] as string, calls[0]!.args[2] as any];
    expect(content).toBe("Welcome <@8301>! 👋");
    expect(opts.allowedMentions).toEqual({ parse: [], users: ["8301"] });
    const d = opts.embed.description as string;
    expect(d).toContain("① Read <#1562870938486182020>");
    expect(d).toMatch(/InfiniBot\*\* = your AI operating system, \*\*KinglyVault\*\* = learn \+ plugins/);
    expect(d).toContain("② Say hi in <#1562870913769144460>");
    expect(d).toContain("③ Questions? <#1562870916348907581> / <#1562870946610552832>. Lives happen in <#1562871015606976724>.");
    expect(content.length + opts.embed.title.length + d.length).toBeLessThan(600);
    const buttons = opts.components[0].components;
    expect(buttons).toEqual([
      { type: 2, style: 5, label: "InfiniBot", url: "https://infinibotos.com" },
      { type: 2, style: 5, label: "KinglyVault", url: "https://kinglyvault.com" },
    ]);
    expect(JSON.stringify(opts)).not.toMatch(/everyone|roles/);
  });

  it("allowedMentions stays users-only even if a username or owner link carries @everyone", () => {
    const p = greetingPost({ channelMap: greetMap, offerLinks: {}, guildName: "@everyone @here <@&123>" }, [{ id: "1" }, { id: "2" }]);
    expect(p.allowedMentions).toEqual({ parse: [], users: ["1", "2"] });
  });

  it("batches a join burst: > 5 joins a minute → one combined post, every member still DM'd once", async () => {
    const store = new CommunityStore(":memory:");
    greetingOnly(store);
    const { engine, calls } = makeEngine(store);
    for (let i = 0; i < 30; i += 1) await engine.handleEvent(join(String(8400 + i)));
    const posts = () => calls.filter((c) => c.fn === "sendMessage");
    expect(posts()).toHaveLength(5); // the first five are greeted one by one
    expect(calls.filter((c) => c.fn === "sendDM")).toHaveLength(30);
    expect(await engine.flushGreetings()).toBe(25);
    expect(posts()).toHaveLength(6);
    const combined = posts()[5]!;
    expect(combined.args[1]).toMatch(/^Welcome <@8405> .* and 5 more! 👋$/);
    expect((combined.args[2] as any).allowedMentions.users).toHaveLength(20);
    expect((combined.args[2] as any).allowedMentions.parse).toEqual([]);
    expect(await engine.flushGreetings()).toBe(0);
    engine.stop();
  });

  it("welcome DM: 3 steps + links + help line, no 'press Verify'; closed DMs (403) are skipped silently", async () => {
    const store = new CommunityStore(":memory:");
    greetingOnly(store, { guildName: "Young CEO Society" });
    const { rest, calls } = sandboxRest();
    const closed = new Proxy(rest, {
      get: (t, p: string) =>
        p === "sendDM"
          ? async (_o: unknown, userId: string, ...rest2: unknown[]) => {
              calls.push({ fn: "sendDM", args: [userId, ...rest2] });
              if (userId === "8502") throw new Error('Discord API error 403: {"message": "Cannot send messages to this user", "code": 50007}');
              return { id: "dm", channelId: "dmc" };
            }
          : (t as any)[p],
    }) as DiscordPort;
    const engine = new CommunityEngine({ store, rest: closed, gate: new ApprovalGate(null), token: () => TOKEN, snowflakeToMs: () => Date.now() - 365 * 86_400_000 });
    await engine.handleEvent(join("8501", "open"));
    await engine.handleEvent(join("8502", "closed"));
    const dm = calls.find((c) => c.fn === "sendDM" && c.args[0] === "8501")!;
    const text = dm.args[1] as string;
    expect(text).toMatch(/^Welcome to Young CEO Society, open! 👋/);
    expect(text).toContain("① Read <#1562870938486182020>");
    expect(text).toContain("② Say hi in <#1562870913769144460>");
    expect(text).toMatch(/Need help\? Reply here or open a ticket/);
    expect(text).not.toMatch(/verify/i);
    expect((dm.args[2] as any).components[0].components.map((b: any) => b.url)).toEqual(["https://infinibotos.com", "https://kinglyvault.com"]);
    // Closed DM: no failure in the feed, marked welcomed so it is never retried.
    expect(store.listActivity().some((a) => /failed to send @closed/.test(a.text))).toBe(false);
    expect(store.getMember(GUILD, "8502")?.welcomedAt).toBeTruthy();
    await engine.handleEvent(join("8502", "closed"));
    expect(calls.filter((c) => c.fn === "sendDM" && c.args[0] === "8502")).toHaveLength(1);
    // Other DM errors are still reported.
    expect(isClosedDmError(new Error("Discord API error 500: boom"))).toBe(false);
  });

  it("full Live keeps the owner's DM template; the old 'press Verify' default is never sent", async () => {
    const store = new CommunityStore(":memory:");
    liveSettings(store, { channelMap: greetMap, welcomeDm: "Hi {name}! InfiniBot + KinglyVault await." });
    const { engine, calls } = makeEngine(store);
    await engine.handleEvent(join("8601", "zed"));
    expect(calls.find((c) => c.fn === "sendDM")!.args[1]).toBe("Hi zed! InfiniBot + KinglyVault await.");
    store.saveSettings({ welcomeDm: LEGACY_DEFAULT_WELCOME_DM });
    await engine.handleEvent(join("8602", "yan"));
    expect(calls.filter((c) => c.fn === "sendDM")[1]!.args[1]).not.toMatch(/press \*\*Verify/);
    expect(DEFAULT_WELCOME_DM).not.toMatch(/Verify/);
  });

  it("control.liveModules RPC validates, saves hot (no restart) and status reports it", async () => {
    const { store, handlers } = harness();
    liveSettings(store, { mode: "shadow" });
    expect((await call(handlers, RPC.liveModules, { modules: ["nope"] })).ok).toBe(false);
    expect((await call(handlers, RPC.liveModules, {})).ok).toBe(false);
    const r = await call(handlers, RPC.liveModules, { modules: ["greeting"] });
    expect(r.ok).toBe(true);
    expect(r.payload).toMatchObject({ mode: "shadow", paused: false, liveModules: ["greeting"] });
    // channels merge into the map (unknown purposes and bad ids dropped), existing entries kept
    const m = await call(handlers, RPC.liveModules, { modules: ["greeting"], channels: { introductions: "1562870913769144460", lives: "1562871015606976724", bogus: "123456", faq: "x" } });
    expect(m.payload.channelMap).toEqual({ ...store.getSettings().channelMap });
    expect(m.payload.channelMap).toMatchObject({ "start-here": "1001", introductions: "1562870913769144460", lives: "1562871015606976724" });
    expect(m.payload.channelMap.bogus).toBeUndefined();
    expect(m.payload.channelMap.faq).toBeUndefined();
    expect(store.getSettings().liveModules).toEqual(["greeting"]);
    const st = await call(handlers, RPC.status);
    expect(st.payload.liveModules).toEqual(["greeting"]);
    expect(st.payload.health.find((h: any) => h.id === "mode").detail).toBe("shadow · live: Welcome greeting");
    expect((await call(handlers, RPC.liveModules, { modules: [] })).payload.liveModules).toEqual([]);
    store.saveSettings({ mode: "setup" });
    expect((await call(handlers, RPC.liveModules, { modules: ["greeting"] })).ok).toBe(false);
  });
});

// ── Token handling + wizard API ─────────────────────────────────────────────

function fakeDiscord(opts: { flags?: number; rejectToken?: boolean; guildPerms?: string } = {}): DiscordPort {
  const { rest } = sandboxRest();
  const overrides: Record<string, unknown> = {
    getCurrentUser: async (t: string) => {
      if (opts.rejectToken) throw new Error(`Discord API error 401: {"message": "401: Unauthorized", "echo": "${t}"}`);
      return { id: BOT_ID, username: "Infini", globalName: "Infini", avatar: "abc", bot: true };
    },
    getCurrentApplication: async () => ({ id: BOT_ID, name: "Infini", flags: opts.flags ?? MEMBERS_AND_CONTENT, botPublic: false, botRequireCodeGrant: false, approximateGuildCount: 1 }),
    listBotGuilds: async () => [
      { id: GUILD, name: "Young CEO Society", icon: null, owner: false, permissions: opts.guildPerms ?? "8", memberCount: 15204 },
    ],
    listChannels: async () => [{ id: "1001", name: "start-here", type: 0, position: 0 }],
    listRoles: async () => [
      { id: GUILD, name: "@everyone", position: 0, managed: false, color: 0, permissions: "0", mentionable: false },
      { id: "2001", name: "Unverified", position: 1, managed: false, color: 0, permissions: "0", mentionable: false },
      { id: "2999", name: "Infini", position: 5, managed: true, color: 0, permissions: "0", mentionable: false },
      { id: "2050", name: "Owner", position: 9, managed: false, color: 0, permissions: "8", mentionable: false },
    ],
    getMember: async () => ({ id: BOT_ID, username: "Infini", discriminator: "0", nick: null, roles: ["2999"], joinedAt: "", avatar: null }),
  };
  return new Proxy(overrides, { get: (t, p: string) => (p in t ? t[p] : (rest as Record<string, unknown>)[p]) }) as unknown as DiscordPort;
}

function fakeConfig(initial: Record<string, any> = { plugins: { entries: { discord: { enabled: true } } } }) {
  let cfg: Record<string, any> = structuredClone(initial);
  const writes: Array<Record<string, any>> = [];
  const writer = createConfigWriter({
    loadConfig: () => structuredClone(cfg),
    writeConfigFile: async (next) => {
      cfg = structuredClone(next);
      writes.push(structuredClone(next));
    },
    resolveAccount: (c, id) => {
      const a = c.channels?.discord?.accounts?.[id] ?? {};
      return { enabled: a.enabled !== false, token: normalizeDiscordToken(a.token) ?? "", tokenSource: a.token ? "config" : "none", guildMembersIntent: a.intents?.guildMembers === true };
    },
    accountId: () => "ycs",
  });
  return { writer, writes, get: () => cfg };
}

async function call(handlers: Record<string, any>, method: string, params: Record<string, unknown> = {}) {
  let out: { ok: boolean; payload?: any; error?: any } = { ok: false };
  await handlers[method]!({ params, respond: (ok: boolean, payload?: unknown, error?: unknown) => (out = { ok, payload, error }) });
  return out;
}

function harness(rest = fakeDiscord()) {
  const store = new CommunityStore(":memory:");
  const config = fakeConfig();
  const engine = new CommunityEngine({ store, rest, gate: new ApprovalGate(null), token: () => config.writer.token() });
  const handlers = createCommunityHandlers({
    store: () => store,
    engine: () => engine,
    rest,
    config: config.writer,
    normalizeToken: normalizeDiscordToken,
    intentsFromFlags: resolveDiscordPrivilegedIntentsFromFlags,
    pro: () => ({ unlocked: true, source: "admin:owner" }),
    pendingApprovals: () => [],
    listening: () => true,
  });
  return { store, config, handlers };
}

describe("token handling (never leaked)", () => {
  it("validation reports the bot identity + intents and never echoes the token", async () => {
    const res = await validateToken(`Bot ${TOKEN}`, { rest: fakeDiscord(), normalize: normalizeDiscordToken, intentsFromFlags: resolveDiscordPrivilegedIntentsFromFlags });
    expect(res.ok).toBe(true);
    expect(res.bot?.username).toBe("Infini");
    expect(res.application?.intents).toEqual({ guildMembers: "enabled", messageContent: "enabled", presence: "disabled" });
    expect(res.inviteUrl).toBe(`https://discord.com/oauth2/authorize?client_id=${BOT_ID}&scope=bot+applications.commands&permissions=19095693552886`);
    expect(JSON.stringify(res)).not.toContain(TOKEN);
    expect(JSON.stringify(res)).not.toContain(TOKEN.split(".")[2]!);
  });

  it("missing intents block the step with a how-to", async () => {
    const res = await validateToken(TOKEN, { rest: fakeDiscord({ flags: 0 }), normalize: normalizeDiscordToken, intentsFromFlags: resolveDiscordPrivilegedIntentsFromFlags });
    expect(res.ok).toBe(false);
    expect(res.checks.find((c) => c.id === "intent-members")?.state).toBe("fail");
    expect(res.checks.find((c) => c.id === "intent-content")?.detail).toMatch(/Message Content/);
  });

  it("a rejected token's Discord error is redacted", async () => {
    const res = await validateToken(TOKEN, { rest: fakeDiscord({ rejectToken: true }), normalize: normalizeDiscordToken, intentsFromFlags: resolveDiscordPrivilegedIntentsFromFlags });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/rejected/);
    expect(JSON.stringify(res)).not.toContain(TOKEN);
    expect(redactToken(`oops ${TOKEN} oops`, TOKEN)).toBe("oops [redacted] oops");
    expect(redactToken(`leak ${TOKEN}`, null)).toBe("leak [redacted]");
    expect((await validateToken("not-a-token", { rest: fakeDiscord(), normalize: normalizeDiscordToken, intentsFromFlags: resolveDiscordPrivilegedIntentsFromFlags })).ok).toBe(false);
  });

  it("saveToken writes channels.discord.accounts.ycs.token + guildMembers intent, and no response contains it", async () => {
    const h = harness();
    const saved = await call(h.handlers, RPC.saveToken, { token: TOKEN });
    expect(saved.ok).toBe(true);
    expect(saved.payload.saved).toBe(true);
    const cfg = h.config.get();
    expect(cfg.channels.discord.accounts.ycs).toMatchObject({ token: TOKEN, enabled: true, intents: { guildMembers: true }, name: "Infini" });
    expect(cfg.channels.discord.token).toBeUndefined();
    expect(cfg.channels.discord.botToken).toBeUndefined();
    expect(cfg.plugins).toEqual({ entries: { discord: { enabled: true } } }); // plugins.* untouched (it would restart the gateway)
    for (const method of [RPC.status, RPC.setupState, RPC.validateToken, RPC.guilds, RPC.analytics]) {
      const r = await call(h.handlers, method);
      expect(JSON.stringify(r), method).not.toContain(TOKEN);
    }
    expect(JSON.stringify(saved)).not.toContain(TOKEN);
    expect(JSON.stringify(h.store.getSettings())).not.toContain(TOKEN);
    expect(() => h.store.saveSettings({ botToken: TOKEN } as never)).toThrow(/not allowed/);
  });

  it("refuses to save while the Discord plugin is off (the write would restart the gateway)", async () => {
    const store = new CommunityStore(":memory:");
    const config = fakeConfig({});
    const rest = fakeDiscord();
    const handlers = createCommunityHandlers({
      store: () => store,
      engine: () => new CommunityEngine({ store, rest, gate: new ApprovalGate(null), token: () => null }),
      rest,
      config: config.writer,
      normalizeToken: normalizeDiscordToken,
      intentsFromFlags: resolveDiscordPrivilegedIntentsFromFlags,
      pro: () => ({ unlocked: false, source: null }),
      pendingApprovals: () => [],
      listening: () => false,
    });
    const r = await call(handlers, RPC.saveToken, { token: TOKEN });
    expect(r.payload).toMatchObject({ saved: false, needsRestart: true });
    expect(config.writes).toHaveLength(0);
    const forced = await call(handlers, RPC.saveToken, { token: TOKEN, allowRestart: true });
    expect(forced.payload.saved).toBe(true);
    expect(JSON.stringify([r, forced])).not.toContain(TOKEN);
  });

  it("an invalid token is not saved", async () => {
    const h = harness(fakeDiscord({ rejectToken: true }));
    const r = await call(h.handlers, RPC.saveToken, { token: TOKEN });
    expect(r.payload.saved).toBe(false);
    expect(h.config.writes).toHaveLength(0);
  });
});

describe("wizard API", () => {
  it("walks token → guilds → bind → mapping → questions → preset → team → test run → go live", async () => {
    const h = harness(fakeDiscord({ guildPerms: "19095693552870" }));
    expect((await call(h.handlers, RPC.guilds)).ok).toBe(false); // no token yet
    await call(h.handlers, RPC.saveToken, { token: TOKEN });

    const guilds = await call(h.handlers, RPC.guilds);
    expect(guilds.payload.guilds[0]).toMatchObject({ id: GUILD, name: "Young CEO Society", memberCount: 15204, admin: false, missingPermissions: [] });

    const sel = await call(h.handlers, RPC.selectGuild, { guildId: GUILD });
    expect(sel.ok).toBe(true);
    expect(h.config.get().bindings).toEqual([{ agentId: "community", match: { channel: "discord", accountId: "ycs", guildId: GUILD } }]);
    await call(h.handlers, RPC.selectGuild, { guildId: GUILD });
    expect(h.config.get().bindings).toHaveLength(1);

    const disc = await call(h.handlers, RPC.discovery);
    expect(disc.payload.botRolePosition).toBe(5);
    expect(disc.payload.checks.find((c: { id: string }) => c.id === "role-position").state).toBe("warn"); // Owner sits above
    expect(disc.payload.roles.find((r: { name: string }) => r.name === "Owner").aboveBot).toBe(true);

    const partial = await call(h.handlers, RPC.saveMapping, { channelMap: { "start-here": "1001" }, roleMap: {} });
    expect(partial.payload.issues.length).toBeGreaterThan(0);
    const full = await call(h.handlers, RPC.saveMapping, {
      channelMap: { "start-here": "1001", support: "1002", "onboarding-desk": "1003", "mod-log": "1004", announcements: "1005", bogus: "nope" },
      roleMap: { unverified: "2001", verified: "2002" },
      tradingChannelIds: ["1009"],
    });
    expect(full.payload.issues).toEqual([]);
    expect(full.payload.settings.compliance.tradingChannelIds).toEqual(["1009"]);

    const badQ = await call(h.handlers, RPC.saveQuestions, { questions: DEFAULT_QUESTIONS.map((q) => ({ ...q, weight: 1 })) });
    expect(badQ.payload.issues.length).toBeGreaterThan(0);
    expect((await call(h.handlers, RPC.saveQuestions, { questions: DEFAULT_QUESTIONS })).payload.issues).toEqual([]);

    expect((await call(h.handlers, RPC.savePreset, { preset: "standard", extraBannedClaims: ["moonshot guaranteed"] })).payload.settings.moderation).toMatchObject({ preset: "standard", minAccountAgeDays: 7 });
    expect((await call(h.handlers, RPC.saveTeam, { team: [{ discordId: "3001", name: "Ari", role: "onboarder", offers: ["pulse", "bogus"] }, { discordId: "x" }] })).payload.team).toHaveLength(1);

    const blocked = await call(h.handlers, RPC.goLive, { mode: "live" });
    expect(blocked.payload.ok).toBe(false);
    expect(blocked.payload.blockers.join(" ")).toMatch(/test run/);

    const run = await call(h.handlers, RPC.testRun);
    expect(run.payload.steps.filter((s: { ok: boolean }) => !s.ok)).toEqual([]);
    expect(run.payload.ok).toBe(true);

    const live = await call(h.handlers, RPC.goLive, { mode: "shadow" });
    expect(live.payload.ok).toBe(true);
    expect(live.payload.settings.mode).toBe("shadow");

    const paused = await call(h.handlers, RPC.pause, { paused: true });
    expect(paused.payload).toEqual({ paused: true, mode: "shadow" });
    const status = await call(h.handlers, RPC.status);
    expect(status.payload).toMatchObject({ mode: "shadow", paused: true, guild: { id: GUILD }, connection: { tokenConfigured: true, guildMembersIntent: true } });
  });

  it("simulate feeds a synthetic member through the engine in Shadow mode only", async () => {
    const h = harness();
    expect((await call(h.handlers, RPC.simulate, { kind: "member" })).ok).toBe(false); // setup mode
    liveSettings(h.store, { mode: "shadow" });
    const r = await call(h.handlers, RPC.simulate, { kind: "member", username: "maya", answers: { goal: "trading", now: "agency", budget: "200+", trading: "active", age: "yes" } });
    expect(r.ok).toBe(true);
    expect(h.store.listLeads()[0]).toMatchObject({ username: "maya", offer: "pulse", tier: "hot" });
    expect(h.store.listActivity().some((a) => a.text.includes("[simulated]"))).toBe(true);
    h.store.saveSettings({ mode: "live" });
    expect((await call(h.handlers, RPC.simulate, { kind: "join" })).ok).toBe(false);
  });

  it("test run reports each step, never touches Discord, and fails when mapping is missing", async () => {
    const store = new CommunityStore(":memory:");
    const res = await runTestRun({ ...store.getSettings(), roleMap: { verified: "2002" } }, []);
    expect(res.steps.map((s) => s.id)).toEqual(["welcome", "verify", "intake", "lead", "onboarder-thread", "scam", "ban-approval", "claims", "disclaimer", "ticket", "everyone", "pause"]);
    expect(res.ok).toBe(true);
  });

  it("permission diff + invite URL", () => {
    expect(missingPermissions("8")).toEqual([]);
    expect(missingPermissions("0")).toContain("Moderate Members");
    expect(missingPermissions("19095693552870")).toEqual([]);
    expect(inviteUrl("123")).toContain("permissions=19095693552886");
  });
});

describe("manifest", () => {
  const raw = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "infinibot.plugin.json"), "utf-8"));
  it("parses and declares every RPC the plugin registers, with the planned scopes", () => {
    const res = parseManifestV2("community-manager", raw);
    expect(res.ok, res.ok ? "" : res.error).toBe(true);
    if (!res.ok) return;
    const h = harness();
    expect(res.fields.contributes.rpc.map((r) => r.method).sort()).toEqual(Object.keys(h.handlers).sort());
    for (const r of res.fields.contributes.rpc) expect(r.scope).toBe(RPC_SCOPES[r.method as keyof typeof RPC_SCOPES]);
    expect(res.fields.contributes.pages[0]).toMatchObject({ tab: "community", route: "/community", builtin: "community" });
    expect(res.fields.contributes.agents).toEqual(["agents/roster.json"]);
  });

  it("roster agent has the planned tool allowlist and no exec/coder tools", () => {
    const roster = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "agents/roster.json"), "utf-8"));
    const agent = roster.agents[0];
    expect(agent.id).toBe("community");
    expect(agent.toolsAllow).toEqual(expect.arrayContaining(["community", "request_approval", "wait_approval", "telegram_send"]));
    expect(agent.toolsAllow.some((t: string) => /exec|coder|bash/.test(t))).toBe(false);
  });
});
