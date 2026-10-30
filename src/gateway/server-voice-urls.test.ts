import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mocked deps: the node selection (voice.json) and the config URLs (federation).
const mockResolveVoiceNode = vi.fn<[], "local" | "master">();
const mockLoadConfig = vi.fn<[], { voice?: Record<string, unknown> }>();

vi.mock("./voice/config.js", () => ({
  resolveVoiceNode: () => mockResolveVoiceNode(),
}));
vi.mock("../config/io.js", () => ({
  loadConfig: () => mockLoadConfig(),
}));

import { resolveVoiceUrlsForNode, resolveReachableVoiceUrl } from "./server-voice-urls.js";

/** Make fetch resolve ok for the given reachable base URLs, reject for the rest. */
function stubFetch(reachable: Set<string>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const url = String(input);
      const base = url.replace(/\/v1\/models$/, "");
      if (reachable.has(base)) return { ok: true } as Response;
      throw new Error("unreachable");
    }),
  );
}

describe("server-voice-urls node routing + fallback", () => {
  beforeEach(() => {
    // Default: standalone (no federation URLs → localhost everywhere).
    mockLoadConfig.mockReturnValue({ voice: {} });
    mockResolveVoiceNode.mockReturnValue("master");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("resolveVoiceUrlsForNode('local') always returns localhost endpoints", () => {
    mockLoadConfig.mockReturnValue({
      voice: { kokoroUrl: "http://192.0.2.37:8882", speachesUrl: "http://192.0.2.37:8002" },
    });
    const local = resolveVoiceUrlsForNode("local");
    expect(local.kokoro).toBe("http://localhost:8882");
    expect(local.speaches).toBe("http://localhost:8002");
  });

  it("resolveVoiceUrlsForNode('master') returns the configured federation URLs", () => {
    mockLoadConfig.mockReturnValue({
      voice: { kokoroUrl: "http://192.0.2.37:8882", speachesUrl: "http://192.0.2.37:8002" },
    });
    const master = resolveVoiceUrlsForNode("master");
    expect(master.kokoro).toBe("http://192.0.2.37:8882");
    expect(master.speaches).toBe("http://192.0.2.37:8002");
  });

  it("uses the preferred node when it is reachable (no fallback)", async () => {
    mockResolveVoiceNode.mockReturnValue("master");
    mockLoadConfig.mockReturnValue({ voice: { kokoroUrl: "http://192.0.2.37:8882" } });
    stubFetch(new Set(["http://192.0.2.37:8882", "http://localhost:8882"]));

    const r = await resolveReachableVoiceUrl("kokoro");
    expect(r.url).toBe("http://192.0.2.37:8882");
    expect(r.node).toBe("master");
    expect(r.fellBack).toBe(false);
  });

  it("falls back to the other node when the preferred is down", async () => {
    // Satellite preferring master, but master Kokoro is down; local is up.
    mockResolveVoiceNode.mockReturnValue("master");
    mockLoadConfig.mockReturnValue({ voice: { kokoroUrl: "http://192.0.2.37:8882" } });
    stubFetch(new Set(["http://localhost:8882"])); // only local answers

    const r = await resolveReachableVoiceUrl("kokoro");
    expect(r.preferred).toBe("master");
    expect(r.node).toBe("local");
    expect(r.url).toBe("http://localhost:8882");
    expect(r.fellBack).toBe(true);
  });

  it("prefers local and uses it directly when selected", async () => {
    mockResolveVoiceNode.mockReturnValue("local");
    mockLoadConfig.mockReturnValue({ voice: { kokoroUrl: "http://192.0.2.37:8882" } });
    stubFetch(new Set(["http://localhost:8882", "http://192.0.2.37:8882"]));

    const r = await resolveReachableVoiceUrl("kokoro");
    expect(r.node).toBe("local");
    expect(r.url).toBe("http://localhost:8882");
    expect(r.fellBack).toBe(false);
  });

  it("does NOT fall back on a standalone (both nodes resolve to the same localhost URL)", async () => {
    mockResolveVoiceNode.mockReturnValue("master");
    mockLoadConfig.mockReturnValue({ voice: {} }); // no federation URLs → localhost
    stubFetch(new Set()); // nothing reachable

    const r = await resolveReachableVoiceUrl("kokoro");
    // preferred URL returned as-is so the caller surfaces a clear upstream error.
    expect(r.url).toBe("http://localhost:8882");
    expect(r.fellBack).toBe(false);
  });
});
