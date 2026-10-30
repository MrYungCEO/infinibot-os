import { describe, expect, it } from "vitest";
import { FIRST_COURSE, USE_CASES, normalizeUseCases, planFor, useCaseTrackBoost } from "./use-cases";
import { parseProfile, parseProgress, loadLocalProfile, saveLocalProfile, loadProgress, saveProgress, shouldAutoOpenOnboarding, markOnboardingAutoOpened, PROFILE_KEY } from "./profile";
import { decidePlugin, defaultEnableSet } from "./plugin-gating";
import { HEARD_THRESHOLD, IDLE_MIC, levelFromBytes, micErrorMessage, micHeard } from "./mic-test";
import { createTelegramTestBackend, isTelegramTestMode } from "./telegram-test-backend";

class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
}

describe("use-case catalogue", () => {
  it("covers every use case the owner asked for, with plain titles and no emoji", () => {
    const ids = USE_CASES.map((u) => u.id);
    for (const want of ["business", "content", "coding", "assistant", "research", "trading", "voice", "phones", "media"]) {
      expect(ids).toContain(want);
    }
    const emoji = /\p{Extended_Pictographic}/u;
    for (const u of USE_CASES) {
      expect(emoji.test(u.title + u.blurb)).toBe(false);
      expect(u.tasks.length).toBeGreaterThan(0);
    }
  });

  it("normalizes ids: known only, catalogue order, no duplicates", () => {
    expect(normalizeUseCases(["media", "nope", "business", "media", 3])).toEqual(["business", "media"]);
  });

  it("plans two use cases: chat course first, both use cases' top items early", () => {
    const plan = planFor(["business", "content"]);
    expect(plan.courses[0]).toBe(FIRST_COURSE);
    expect(plan.courses.slice(1, 3)).toEqual(["projects", "content-studio"]);
    expect(plan.plugins).toEqual(["business-agency", "content-studio", "products", "flypic"]);
    expect(plan.dashboard).toBe("executive");
    expect(new Set(plan.courses).size).toBe(plan.courses.length);
    expect(plan.tasks.length).toBeLessThanOrEqual(6);
  });

  it("falls back to 'just exploring' when nothing is picked and filters to what exists", () => {
    const plan = planFor([], { tracks: new Set(["chat-models", "getting-started"]), plugins: new Set() });
    expect(plan.courses).toEqual(["chat-models", "getting-started"]);
    expect(plan.plugins).toEqual([]);
  });

  it("boosts earlier courses more", () => {
    const b = useCaseTrackBoost(["trading"]);
    expect(b.get(FIRST_COURSE)!).toBeGreaterThan(b.get("infinitrade")!);
    expect(b.get("solatrix")).toBeGreaterThan(0);
  });
});

describe("profile + progress persistence", () => {
  it("round-trips through storage and sanitizes", () => {
    const s = new MemStorage();
    saveLocalProfile({ useCases: ["coding", "voice"], courses: ["chat-models"], plugins: ["infinicode"], agents: [], voice: "local", updatedAt: 5 }, s);
    expect(loadLocalProfile(s)).toMatchObject({ useCases: ["coding", "voice"], voice: "local", updatedAt: 5 });
    s.setItem(PROFILE_KEY, "{broken");
    expect(loadLocalProfile(s)).toBeNull();
    expect(parseProfile({ useCases: ["bogus"], voice: "x" })).toMatchObject({ useCases: [], courses: [] });
  });

  it("resumes on the saved step and ignores unknown steps", () => {
    const s = new MemStorage();
    saveProgress({ step: "voice", done: ["usecases", "model"], skipped: ["channels", "nope" as never] }, s);
    expect(loadProgress(s)).toEqual({ step: "voice", done: ["usecases", "model"], skipped: ["channels"], finishedAt: null });
    expect(parseProgress({ step: "elsewhere" })).toBeNull();
  });

  it("auto-opens onboarding once, only for untouched browsers", () => {
    const s = new MemStorage();
    expect(shouldAutoOpenOnboarding(s)).toBe(true);
    markOnboardingAutoOpened(s);
    expect(shouldAutoOpenOnboarding(s)).toBe(false);
    const t = new MemStorage();
    saveProgress({ step: "model", done: [], skipped: [] }, t);
    expect(shouldAutoOpenOnboarding(t)).toBe(false);
  });
});

describe("plugin gating", () => {
  it("enables installed free plugins, never paid ones", () => {
    const free = decidePlugin("flypic", { id: "flypic", name: "FlyPic", enabled: false, listing: { tagline: "Images" } }, undefined);
    expect(free.action).toBe("enable");
    expect(free.badges).toContain("free");
    const paid = decidePlugin("infinitrade", { id: "infinitrade", name: "Infinitrade", enabled: false }, { pricing: { model: "paid", includedPlans: ["pro"] }, priceLabel: "$29" });
    expect(paid.action).toBe("buy");
    expect(paid.badges).toContain("pro");
    expect(paid.note).toMatch(/PRO/);
    const owned = decidePlugin("infinitrade", { id: "infinitrade", enabled: false }, { pricing: { model: "paid", includedPlans: ["pro"] } }, { entitlements: new Set(["pro"]) });
    expect(owned.action).toBe("enable");
    expect(defaultEnableSet([free, paid, owned])).toEqual(new Set(["flypic", "infinitrade"]));
  });

  it("has no desktop-only plugins: droid-swarm is a paid plugin like the rest", () => {
    // plugins.list row shape after the desktop-only concept was removed.
    const row = { id: "droid-swarm", name: "Droid Swarm", enabled: false, paid: true, priceLabel: "$49", entitled: false };
    const locked = decidePlugin("droid-swarm", row, undefined);
    expect(locked.badges).not.toContain("desktop" as never);
    expect(locked.badges).toContain("paid");
    expect(locked.action).toBe("buy");
    expect(locked.note).toMatch(/\$49/);
    const owned = decidePlugin("droid-swarm", { ...row, entitled: true }, undefined);
    expect(owned.action).toBe("enable");
    expect(owned.note).toBeNull();
    // Legacy fields from an older gateway are ignored, not turned into a lock.
    expect(decidePlugin("droid-swarm", { ...row, entitled: true, desktopOnly: true, platforms: ["desktop"] }, undefined, { hosted: true }).action).toBe("enable");
  });

  it("on a hosted workspace only the cloud decision rules a plugin out", () => {
    const cloud = { status: "self-host-only", loadable: false, reason: "Runs on self-hosted InfiniBot." };
    const d = decidePlugin("droid-swarm", { id: "droid-swarm", enabled: false, cloud }, undefined, { hosted: true });
    expect(d.action).toBe("unavailable");
    expect(d.note).toBe("Runs on self-hosted InfiniBot.");
  });

  it("handles already-on, not-installed and plan-locked plugins", () => {
    expect(decidePlugin("x", { id: "x", enabled: true }, undefined).action).toBe("on");
    expect(decidePlugin("x", undefined, { id: "x", pricing: { model: "free" } }).action).toBe("install");
    expect(decidePlugin("x", { id: "x", enabled: false, cloud: { status: "locked", reason: "Pro plan" } }, undefined).action).toBe("buy");
  });
});

describe("mic test helpers", () => {
  it("maps silence to 0 and loud input to a high level", () => {
    expect(levelFromBytes(new Uint8Array(64).fill(128))).toBe(0);
    const loud = Uint8Array.from({ length: 64 }, (_, i) => (i % 2 ? 230 : 26));
    expect(levelFromBytes(loud)).toBeGreaterThan(0.9);
  });

  it("knows when it heard you", () => {
    expect(micHeard({ ...IDLE_MIC, peak: HEARD_THRESHOLD })).toBe(true);
    expect(micHeard(IDLE_MIC)).toBe(false);
  });

  it("explains permission errors in plain language", () => {
    expect(micErrorMessage({ name: "NotAllowedError" })).toMatch(/blocked the microphone/);
    expect(micErrorMessage({ name: "NotFoundError" })).toMatch(/No microphone/);
  });
});

describe("telegram test backend", () => {
  it("is only on with ?telegramTest=1", () => {
    expect(isTelegramTestMode("?telegramTest=1")).toBe(true);
    expect(isTelegramTestMode("?x=1")).toBe(false);
  });

  it("walks create → verify → find → confirm → test without a network", async () => {
    const b = createTelegramTestBackend();
    expect(await b.call("summary")).toMatchObject({ ok: true, connected: false });
    expect(await b.call("verify", { token: "nope" })).toMatchObject({ ok: false });
    const v = (await b.call<{ sessionId: string }>("verify", { token: "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ" })) as { ok: true; sessionId: string };
    expect(v.ok).toBe(true);
    await b.call("capture.start", { sessionId: v.sessionId, mode: "dm" });
    await b.call("capture.status", { sessionId: v.sessionId });
    const found = await b.call<{ owner: unknown }>("capture.status", { sessionId: v.sessionId });
    expect(found).toMatchObject({ ok: true, capture: { status: "found" } });
    expect(await b.call("confirm", { sessionId: v.sessionId })).toMatchObject({ ok: true, summary: { connected: true, running: true } });
    expect(await b.call("test", { sessionId: v.sessionId })).toMatchObject({ ok: true });
  });
});
