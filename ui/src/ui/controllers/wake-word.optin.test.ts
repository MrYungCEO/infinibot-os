import { beforeEach, describe, expect, it, vi } from "vitest";

function memoryStorage(seed: Record<string, string> = {}): Storage {
  const m = new Map<string, string>(Object.entries(seed));
  return {
    get length() { return m.size; },
    clear: () => m.clear(),
    getItem: (k) => (m.has(k) ? m.get(k)! : null),
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  };
}

const OPT_IN_KEY = "infinibot.wakeWord.micOptIn.v1";
let getUserMedia: ReturnType<typeof vi.fn>;

function setup(seed: Record<string, string> = {}, gum?: () => Promise<unknown>) {
  vi.resetModules();
  const storage = memoryStorage(seed);
  vi.stubGlobal("localStorage", storage);
  getUserMedia = vi.fn(gum ?? (async () => { throw Object.assign(new Error("Requested device not found"), { name: "NotFoundError" }); }));
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  vi.stubGlobal("window", { setTimeout, clearTimeout, setInterval, clearInterval, addEventListener() {}, dispatchEvent() { return true; } });
  vi.stubGlobal("document", { addEventListener() {} });
  return storage;
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

describe("wake word microphone opt-in", () => {
  beforeEach(() => vi.spyOn(console, "log").mockImplementation(() => {}));

  it("does not open the mic on a fresh browser even when panels register enabled", async () => {
    const storage = setup();
    const ww = await import("./wake-word");
    expect(ww.isWakeWordOptedIn()).toBe(false);
    expect(storage.getItem(OPT_IN_KEY)).toBe("0");
    ww.registerPanelWakeWord({ panelId: "p1", enabled: true, wakeWord: "hey infinibot", callback: () => {} });
    await flush();
    expect(getUserMedia).not.toHaveBeenCalled();
    // A later reload must not auto-opt-in from the entries registration just wrote.
    vi.resetModules();
    const again = await import("./wake-word");
    expect(again.isWakeWordOptedIn()).toBe(false);
  });

  it("keeps an existing install listening (migrates stored enabled wake words)", async () => {
    setup({ "infinibot-panel-wake-words": JSON.stringify({ p1: { enabled: true, word: "hey infinibot" } }) });
    const ww = await import("./wake-word");
    expect(ww.isWakeWordOptedIn()).toBe(true);
  });

  it("stops retrying after NotFoundError until the user retries", async () => {
    setup({ [OPT_IN_KEY]: "1" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ww = await import("./wake-word");
    ww.registerPanelWakeWord({ panelId: "p1", enabled: true, wakeWord: "hey a", callback: () => {} });
    await flush();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    // More registrations / phrase changes used to retrigger capture forever.
    ww.registerPanelWakeWord({ panelId: "p2", enabled: true, wakeWord: "hey b", callback: () => {} });
    ww.updatePanelWakeWord("p1", { wakeWord: "hey c" });
    await flush();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(ww.getWakeWordStatus().blocked).toBe("No microphone found");
    expect(warn).toHaveBeenCalledTimes(1);
    ww.resetWakeErrors();
    await flush();
    expect(getUserMedia).toHaveBeenCalledTimes(2);
  });

  it("turning the master listener on opts in", async () => {
    setup();
    const ww = await import("./wake-word");
    ww.setWakeSettings({ enabled: true });
    expect(ww.isWakeWordOptedIn()).toBe(true);
    ww.setWakeWordOptIn(false);
    expect(ww.isWakeWordOptedIn()).toBe(false);
  });
});
