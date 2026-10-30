import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetKokoroBootstrapForTests,
  ensureKokoroRunning,
  getLastKokoroStatus,
} from "./kokoro-bootstrap.js";

vi.mock("./server-voice-urls.js", () => ({
  resolveVoiceUrls: () => ({
    kokoro: "http://localhost:8882",
    speaches: "http://localhost:8002",
    livekit: "ws://localhost:7882",
    livekitExternal: "ws://localhost:7882",
  }),
}));

// Control the canonical voice.json mode independently of the legacy file so the
// gating fix (mode==="docker" → Kokoro selected) is deterministic and these
// tests never touch the real ~/.infinibot/voice.json.
const voiceJsonState: { mode: "cloud" | "native" | "docker" | null } = { mode: null };
vi.mock("./voice/config.js", () => ({
  loadVoiceConfig: () => (voiceJsonState.mode ? { mode: voiceJsonState.mode } : null),
}));

// Control isKokoroSelected() by stubbing the fs reads it performs.
const fsState: { selected: boolean } = { selected: true };
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: (p: string) => (p.endsWith("voice-settings.json") ? true : actual.existsSync(p)),
    readFileSync: ((p: string, ...rest: unknown[]) =>
      p.endsWith("voice-settings.json")
        ? JSON.stringify({
            tts_provider: fsState.selected ? "kokoro" : "elevenlabs",
          })
        : (actual.readFileSync as never)(p, ...rest)) as typeof actual.readFileSync,
  };
});

function okFetch() {
  return vi.fn(async () => ({ ok: true })) as unknown as typeof fetch;
}

describe("ensureKokoroRunning", () => {
  beforeEach(() => {
    __resetKokoroBootstrapForTests();
    voiceJsonState.mode = null; // default: no voice.json → fall back to legacy file
  });
  afterEach(() => {
    __resetKokoroBootstrapForTests();
    vi.restoreAllMocks();
  });

  it("is a no-op when Kokoro is not the selected provider", async () => {
    fsState.selected = false;
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);

    const status = await ensureKokoroRunning();

    expect(status.selected).toBe(false);
    expect(status.ready).toBe(false);
    expect(status.startedByUs).toBe(false);
    // Must not even probe the endpoint when not selected.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats voice.json mode=docker as Kokoro-selected even if the legacy file disagrees", async () => {
    // The wizard-provisioned Docker install writes voice.json (mode=docker), not
    // the legacy voice-settings.json — this is the silent-skip fix.
    fsState.selected = false; // legacy file says elevenlabs
    voiceJsonState.mode = "docker"; // canonical says docker
    vi.stubGlobal("fetch", okFetch());

    const status = await ensureKokoroRunning();

    expect(status.selected).toBe(true);
    expect(status.ready).toBe(true);
  });

  it("does NOT select Kokoro when voice.json mode is cloud/native", async () => {
    fsState.selected = false;
    voiceJsonState.mode = "cloud";
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);

    const status = await ensureKokoroRunning();

    expect(status.selected).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports ready without launching the container when already healthy", async () => {
    fsState.selected = true;
    vi.stubGlobal("fetch", okFetch());

    const status = await ensureKokoroRunning();

    expect(status.selected).toBe(true);
    expect(status.ready).toBe(true);
    expect(status.startedByUs).toBe(false);
    expect(getLastKokoroStatus()?.ready).toBe(true);
  });

  it("caches the first ensure result (idempotent per process)", async () => {
    fsState.selected = true;
    vi.stubGlobal("fetch", okFetch());
    const a = await ensureKokoroRunning();
    const b = await ensureKokoroRunning();
    expect(a).toBe(b);
  });
});
