import { describe, expect, it } from "vitest";
import {
  clearResume,
  loadResume,
  resumeStepIndex,
  resumeStorageKey,
  saveResume,
  serverResume,
  stepsFor,
} from "./saas-onboarding-steps";

const keys = (status: Parameters<typeof stepsFor>[0]) => stepsFor(status).map((s) => s.key);

function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    size: () => m.size,
  };
}

describe("stepsFor", () => {
  it("serves all eight steps from a tenant gateway", () => {
    const steps = stepsFor({ connectors: [{ id: "telegram" }], businessIndustries: [], imports: ["obsidian-zip"] });
    expect(steps.map((s) => s.key)).toEqual(["identity", "keys", "channels", "connect", "business", "import", "voice", "finish"]);
    expect(steps.some((s) => s.locked)).toBe(false);
  });

  it("keeps the gateway-only steps on the serverless backend, locked and skippable", () => {
    const steps = stepsFor({ backend: "netlify-functions", businessIndustries: [] });
    expect(steps.map((s) => s.key)).toEqual(["identity", "keys", "channels", "connect", "business", "import", "voice", "finish"]);
    expect(steps.filter((s) => s.locked).map((s) => s.key)).toEqual(["channels", "connect", "import"]);
    expect(steps.find((s) => s.key === "channels")?.hint).toBe("Hosted plans");
  });

  it("offers the import step only when the gateway serves imports", () => {
    expect(keys({ connectors: [{ id: "telegram" }] })).not.toContain("import");
    expect(keys({ connectors: [{ id: "telegram" }], imports: [] })).not.toContain("import");
    const steps = stepsFor({ connectors: [{ id: "telegram" }], imports: ["notion-zip"] });
    expect(steps.find((s) => s.key === "import")).toMatchObject({ label: "Import notes" });
    expect(steps.find((s) => s.key === "import")?.locked).toBeUndefined();
  });

  it("drops what an older gateway can't serve, without locking anything", () => {
    expect(keys({})).toEqual(["identity", "keys", "voice", "finish"]);
    expect(keys({ connectors: [] })).toEqual(["identity", "keys", "voice", "finish"]);
  });

  it("is never empty, whatever the status looks like", () => {
    for (const status of [{}, { connectors: null }, { backend: "netlify-functions" }, { businessIndustries: "x" }]) {
      const got = keys(status as never);
      expect(got[0]).toBe("identity");
      expect(got).toContain("keys");
      expect(got[got.length - 1]).toBe("finish");
    }
  });
});

describe("resume", () => {
  const steps = stepsFor({ backend: "netlify-functions", businessIndustries: [] });

  it("starts at the top with nothing saved", () => {
    expect(resumeStepIndex(steps, null, { hasChatProvider: false })).toBe(0);
  });

  it("reopens the saved step after a refresh", () => {
    expect(resumeStepIndex(steps, { at: "keys" }, { hasChatProvider: false })).toBe(1);
    expect(resumeStepIndex(steps, { at: "business" }, { hasChatProvider: true })).toBe(4);
  });

  it("never resumes past the keys step without a chat provider", () => {
    expect(resumeStepIndex(steps, { at: "business" }, { hasChatProvider: false })).toBe(1);
    expect(resumeStepIndex(steps, { at: "finish" }, { hasChatProvider: false })).toBe(1);
  });

  it("falls back to the top when the saved step isn't offered here", () => {
    const short = stepsFor({});
    expect(resumeStepIndex(short, { at: "channels" }, { hasChatProvider: true })).toBe(0);
  });

  it("round-trips through storage, per member", () => {
    const store = memoryStorage();
    saveResume(store, "Ada@Example.com", { at: "connect", name: "Atlas" });
    expect(loadResume(store, "ada@example.com")).toEqual({ at: "connect", name: "Atlas" });
    expect(loadResume(store, "bo@example.com")).toBeNull();
    expect(resumeStorageKey(null)).toBe(resumeStorageKey(""));
    clearResume(store, "ada@example.com");
    expect(store.size()).toBe(0);
  });

  it("ignores corrupt or foreign data instead of throwing", () => {
    const store = memoryStorage();
    store.setItem(resumeStorageKey("a@b.c"), "{not json");
    expect(loadResume(store, "a@b.c")).toBeNull();
    store.setItem(resumeStorageKey("a@b.c"), JSON.stringify({ at: "nope" }));
    expect(loadResume(store, "a@b.c")).toBeNull();
    expect(loadResume(null, "a@b.c")).toBeNull();
    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(loadResume(throwing, "a@b.c")).toBeNull();
    expect(() => saveResume(throwing, "a@b.c", { at: "keys" })).not.toThrow();
    expect(() => clearResume(throwing, "a@b.c")).not.toThrow();
  });

  it("reads the progress the serverless backend kept", () => {
    expect(serverResume({ stepData: { progress: { at: "voice", name: "Atlas" } } })).toEqual({ at: "voice", name: "Atlas" });
    expect(serverResume({ stepData: { progress: { at: 3 } } })).toBeNull();
    expect(serverResume({ stepData: null })).toBeNull();
    expect(serverResume({})).toBeNull();
  });
});
