import { describe, expect, it } from "vitest";

import {
  probeBackgroundStart,
  spawnCoderWithFallback,
  type SpawnAttemptOutcome,
} from "./spawn-with-fallback.js";

const never = new Promise<void>(() => {});
const resolved = Promise.resolve();

describe("spawnCoderWithFallback", () => {
  it("returns immediately when the primary launches", async () => {
    const seen: string[] = [];
    const result = await spawnCoderWithFallback<string>({
      primary: "claude-code",
      fallback: "opencode",
      attempt: async (backend) => {
        seen.push(backend);
        return { ok: true, session: `session:${backend}` };
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.backendUsed).toBe("claude-code");
      expect(result.session).toBe("session:claude-code");
    }
    expect(seen).toEqual(["claude-code"]); // fallback never attempted
    expect(result.attempts).toHaveLength(1);
  });

  it("retries once with the fallback on a launch failure", async () => {
    const result = await spawnCoderWithFallback<string>({
      primary: "claude-code",
      fallback: "opencode",
      attempt: async (backend): Promise<SpawnAttemptOutcome<string>> => {
        if (backend === "claude-code") {
          return { ok: false, error: "binary missing", exitCode: null };
        }
        return { ok: true, session: `session:${backend}` };
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.backendUsed).toBe("opencode");
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0]).toMatchObject({ backend: "claude-code", ok: false });
    expect(result.attempts[1]).toMatchObject({ backend: "opencode", ok: true });
  });

  it("fails when there is no fallback configured", async () => {
    const result = await spawnCoderWithFallback<string>({
      primary: "claude-code",
      attempt: async () => ({ ok: false, error: "boom" }),
    });
    expect(result.ok).toBe(false);
    expect(result.attempts).toHaveLength(1);
    if (!result.ok) expect(result.error).toBe("boom");
  });

  it("fails when both primary and fallback fail to launch", async () => {
    const result = await spawnCoderWithFallback<string>({
      primary: "claude-code",
      fallback: "codex",
      attempt: async (backend) => ({ ok: false, error: `${backend} failed` }),
    });
    expect(result.ok).toBe(false);
    expect(result.attempts).toHaveLength(2);
    if (!result.ok) expect(result.error).toBe("codex failed");
  });
});

describe("probeBackgroundStart", () => {
  it("reports started when first output arrives", async () => {
    const probe = await probeBackgroundStart(
      { pid: 1234, finalPromise: never as Promise<{ exitCode: number | null }> },
      { graceMs: 50, firstOutput: resolved },
    );
    expect(probe.started).toBe(true);
  });

  it("reports started when the grace window elapses with the process alive", async () => {
    const probe = await probeBackgroundStart(
      { pid: 1234, finalPromise: never as Promise<{ exitCode: number | null }> },
      { graceMs: 20, firstOutput: never },
    );
    expect(probe.started).toBe(true);
  });

  it("reports launch failure when the process exits non-zero before output", async () => {
    const probe = await probeBackgroundStart(
      { pid: 1234, finalPromise: Promise.resolve({ exitCode: 1 }) },
      { graceMs: 1000, firstOutput: never },
    );
    expect(probe.started).toBe(false);
    expect(probe.exitCode).toBe(1);
  });

  it("treats a trivially fast clean exit as started", async () => {
    const probe = await probeBackgroundStart(
      { pid: 1234, finalPromise: Promise.resolve({ exitCode: 0 }) },
      { graceMs: 1000, firstOutput: never },
    );
    expect(probe.started).toBe(true);
  });

  it("reports launch failure when there is no pid", async () => {
    const probe = await probeBackgroundStart(
      { pid: undefined, finalPromise: Promise.resolve({ exitCode: null }) },
      { graceMs: 50, firstOutput: never },
    );
    expect(probe.started).toBe(false);
  });
});
