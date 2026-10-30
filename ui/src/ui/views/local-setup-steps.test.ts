import { describe, expect, it } from "vitest";
import {
  blockedNote,
  canContinue,
  canFinish,
  loadLocalResume,
  resumeIndex,
  saveLocalResume,
  stepsForMode,
  type GateState,
} from "./local-setup-steps";

const base: GateState = { mode: "standalone", hasModel: false, masterUrl: "", linkVerified: false, satelliteSaved: false };

function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

describe("local setup steps", () => {
  it("standalone walks keys → channels → voice; no billing/plan step", () => {
    expect(stepsForMode("standalone").map((s) => s.key)).toEqual(["mode", "keys", "channels", "voice", "finish"]);
  });

  it("satellite skips every BYOK step (the master supplies models)", () => {
    const keys = stepsForMode("satellite").map((s) => s.key);
    expect(keys).toEqual(["mode", "master", "pair", "share", "finish"]);
    expect(keys).not.toContain("keys");
  });

  it("gates keys on a connected model, pairing on a verified link", () => {
    expect(canContinue("keys", base)).toBe(false);
    expect(blockedNote("keys", base)).toMatch(/model provider/);
    expect(canContinue("keys", { ...base, hasModel: true })).toBe(true);
    expect(canContinue("channels", base)).toBe(true);
    expect(canContinue("voice", base)).toBe(true);
    const sat = { ...base, mode: "satellite" as const };
    expect(canContinue("master", sat)).toBe(false);
    expect(canContinue("master", { ...sat, masterUrl: "10.0.0.2:18789" })).toBe(true);
    expect(canContinue("pair", sat)).toBe(false);
    expect(blockedNote("pair", sat)).toMatch(/Test the link/);
    expect(canContinue("pair", { ...sat, linkVerified: true })).toBe(true);
  });

  it("finish needs a model (standalone) or a verified/saved link (satellite)", () => {
    expect(canFinish(base)).toBe(false);
    expect(canFinish({ ...base, hasModel: true })).toBe(true);
    expect(canFinish({ ...base, mode: "satellite", hasModel: true })).toBe(false);
    expect(canFinish({ ...base, mode: "satellite", satelliteSaved: true })).toBe(true);
  });

  it("resumes where the user left off, but never past an unmet gate or onto finish", () => {
    const store = memoryStorage();
    saveLocalResume(store, { mode: "standalone", at: "voice" });
    const saved = loadLocalResume(store);
    const steps = stepsForMode("standalone");
    expect(resumeIndex(steps, saved, base)).toBe(1); // stuck at keys: no model yet
    expect(resumeIndex(steps, saved, { ...base, hasModel: true })).toBe(3);
    saveLocalResume(store, { mode: "standalone", at: "finish" });
    expect(resumeIndex(steps, loadLocalResume(store), { ...base, hasModel: true })).toBe(3);
    store.setItem("infinibot.localSetup.v1", "{bad json");
    expect(loadLocalResume(store)).toBeNull();
    saveLocalResume(store, { mode: "satellite", at: "keys" as never });
    expect(loadLocalResume(store)).toBeNull();
  });
});
