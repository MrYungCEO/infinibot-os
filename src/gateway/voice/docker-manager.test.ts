import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the helpers docker-manager composes so preflight/ensure logic is
// deterministic regardless of the host's real Docker/GPU state.
const mockCheckDocker = vi.fn();
const mockResolveComposeFile = vi.fn<[], string | null>();
const mockEnsureVoiceEnvFile = vi.fn();

vi.mock("./docker-check.js", () => ({
  checkDocker: (...a: unknown[]) => mockCheckDocker(...a),
  DOCKER_INSTALL_URL: "https://docs.docker.com/get-docker/",
}));
vi.mock("../kokoro-bootstrap.js", () => ({
  resolveComposeFile: () => mockResolveComposeFile(),
}));
vi.mock("./docker-install.js", () => ({
  ensureVoiceEnvFile: () => mockEnsureVoiceEnvFile(),
}));

import { VOICE_SERVICES, isVoiceServiceName, composeEnv, preflight } from "./docker-manager.js";

describe("docker-manager pure helpers", () => {
  it("isVoiceServiceName guards the known service set", () => {
    expect(isVoiceServiceName("kokoro")).toBe(true);
    expect(isVoiceServiceName("speaches")).toBe(true);
    expect(isVoiceServiceName("voice-agent")).toBe(true);
    expect(isVoiceServiceName("bogus")).toBe(false);
    expect(isVoiceServiceName(42)).toBe(false);
    expect(isVoiceServiceName(undefined)).toBe(false);
  });

  it("VOICE_SERVICES catalog encodes the GPU/creds gating", () => {
    const byName = Object.fromEntries(VOICE_SERVICES.map((s) => [s.name, s]));
    expect(byName.kokoro.requiresGpu).toBeFalsy();
    expect(byName.kokoro.requiresCreds).toBeFalsy();
    expect(byName.speaches.requiresGpu).toBe(true);
    expect(byName.livekit.requiresCreds).toBe(true);
    expect(byName["voice-agent"].requiresCreds).toBe(true);
  });

  it("composeEnv injects LiveKit placeholders so the compose file parses", () => {
    const prevKey = process.env.LIVEKIT_API_KEY;
    const prevSecret = process.env.LIVEKIT_API_SECRET;
    delete process.env.LIVEKIT_API_KEY;
    delete process.env.LIVEKIT_API_SECRET;
    try {
      const env = composeEnv();
      expect(env.LIVEKIT_API_KEY).toBeTruthy();
      expect(env.LIVEKIT_API_SECRET).toBeTruthy();
    } finally {
      if (prevKey !== undefined) process.env.LIVEKIT_API_KEY = prevKey;
      if (prevSecret !== undefined) process.env.LIVEKIT_API_SECRET = prevSecret;
    }
  });
});

describe("docker-manager preflight gating", () => {
  beforeEach(() => {
    mockResolveComposeFile.mockReturnValue("C:/app/docker-compose.voice.yaml");
    mockEnsureVoiceEnvFile.mockReturnValue(true);
  });
  afterEach(() => vi.clearAllMocks());

  it("reports not-ok and no runnable services when Docker is unavailable", async () => {
    mockCheckDocker.mockResolvedValue({ available: false, cliPresent: true, daemonRunning: false });
    const r = await preflight();
    expect(r.ok).toBe(false);
    expect(r.runnable).toEqual([]);
    expect(r.notes.some((n) => /daemon/i.test(n))).toBe(true);
  });

  it("excludes GPU-only services (speaches) when no GPU is present", async () => {
    mockCheckDocker.mockResolvedValue({ available: true, cliPresent: true, daemonRunning: true });
    const r = await preflight();
    // Kokoro (no gpu/creds) is always runnable when docker is up + creds ready.
    expect(r.runnable).toContain("kokoro");
    if (!r.gpu.present) {
      expect(r.runnable).not.toContain("speaches");
      expect(r.notes.some((n) => /GPU/i.test(n))).toBe(true);
    }
  });
});
