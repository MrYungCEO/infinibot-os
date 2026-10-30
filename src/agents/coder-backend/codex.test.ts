/**
 * Smoke tests for CodexCliBackend.
 *
 * Mirrors the shape of any opencode.test.ts that might exist.
 * These tests are intentionally lightweight: they verify static contracts
 * (capabilities shape, install-status shape, registry routing) without
 * actually spawning the Codex binary.
 *
 * COORDINATION: codex-backend
 */

import { describe, it, expect, beforeEach } from "vitest";
import { CodexCliBackend, CODEX_EXEC_STDIO, buildCodexArgsForTest } from "./codex.js";
import type { CLIAgentConfig } from "../types/agent-types.js";
import { createCoderBackend, _clearBackendCache } from "./registry.js";

// ── getCapabilities ────────────────────────────────────────────────────────

describe("CodexCliBackend.getCapabilities()", () => {
  it("returns id = 'codex'", () => {
    const caps = new CodexCliBackend().getCapabilities();
    expect(caps.id).toBe("codex");
  });

  it("has a non-empty displayName", () => {
    const caps = new CodexCliBackend().getCapabilities();
    expect(typeof caps.displayName).toBe("string");
    expect(caps.displayName.length).toBeGreaterThan(0);
  });

  it("supportsStreamJson = true (codex exec --json emits JSONL)", () => {
    expect(new CodexCliBackend().getCapabilities().supportsStreamJson).toBe(true);
  });

  it("supportsMcpConfig = true (profiles + global config.toml)", () => {
    expect(new CodexCliBackend().getCapabilities().supportsMcpConfig).toBe(true);
  });

  it("supportsSessionResume = true (codex exec resume <id>)", () => {
    expect(new CodexCliBackend().getCapabilities().supportsSessionResume).toBe(true);
  });

  it("supportsParallelSessions = true", () => {
    expect(new CodexCliBackend().getCapabilities().supportsParallelSessions).toBe(true);
  });

  it("modelFormat = 'name' (bare model name, e.g. 'gpt-4o')", () => {
    expect(new CodexCliBackend().getCapabilities().modelFormat).toBe("name");
  });
});

describe("CodexCliBackend process launch", () => {
  const baseConfig: CLIAgentConfig = {
    id: "test-codex",
    name: "Test Codex",
    type: "cli",
    cliCommand: "codex",
    autoApprove: true,
    timeoutMinutes: 1,
  };

  it("ignores stdin so codex exec does not wait for extra input forever", () => {
    expect(CODEX_EXEC_STDIO).toEqual(["ignore", "pipe", "pipe"]);
  });

  it("adds JSON output and approval bypass for auto-approved spawns", () => {
    const args = buildCodexArgsForTest(baseConfig, "do work", { model: "gpt-5" }, "test-profile");

    expect(args).toContain("--json");
    expect(args).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(args.slice(0, 2)).toEqual(["--model", "gpt-5"]);
    expect(args.at(-1)).toBe("do work");
  });

  it("keeps operator approval/sandbox args and does not add the bypass over them", () => {
    const args = buildCodexArgsForTest(
      {
        ...baseConfig,
        cliArgs: ["--approval-policy", "on-request", "--sandbox=workspace-write", "--foo", "bar"],
      },
      "task",
    );

    expect(args).toContain("--approval-policy");
    expect(args).toContain("on-request");
    expect(args).toContain("--sandbox=workspace-write");
    expect(args).toContain("--foo");
    expect(args).toContain("bar");
    expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  it("drops a bypass flag smuggled via cliArgs when autoApprove is false", () => {
    const args = buildCodexArgsForTest(
      {
        ...baseConfig,
        autoApprove: false,
        cliArgs: ["--dangerously-bypass-approvals-and-sandbox", "--json"],
      },
      "task",
    );

    expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(args.filter((a) => a === "--json")).toHaveLength(1);
  });

  it("does not force bypass when autoApprove is false", () => {
    const args = buildCodexArgsForTest({ ...baseConfig, autoApprove: false }, "task");

    expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  });
});

// ── checkInstalled ─────────────────────────────────────────────────────────

describe("CodexCliBackend.checkInstalled()", () => {
  it("resolves to an object with installed: boolean", async () => {
    const result = await new CodexCliBackend().checkInstalled();
    expect(typeof result.installed).toBe("boolean");
  });

  it("provides installHint when not installed", async () => {
    const result = await new CodexCliBackend().checkInstalled();
    if (!result.installed) {
      expect(typeof result.installHint).toBe("string");
      expect(result.installHint).toContain("@openai/codex");
    }
  });

  it("provides version string when installed", async () => {
    const result = await new CodexCliBackend().checkInstalled();
    if (result.installed) {
      expect(typeof result.version).toBe("string");
      expect((result.version ?? "").length).toBeGreaterThan(0);
    }
  });
});

// ── Registry routing ───────────────────────────────────────────────────────

describe("registry.createCoderBackend('codex')", () => {
  beforeEach(() => {
    _clearBackendCache();
  });

  it("returns a CodexCliBackend instance", () => {
    const backend = createCoderBackend("codex");
    expect(backend).toBeInstanceOf(CodexCliBackend);
  });

  it("returns the same singleton on subsequent calls", () => {
    const a = createCoderBackend("codex");
    const b = createCoderBackend("codex");
    expect(a).toBe(b);
  });

  it("id property equals 'codex'", () => {
    expect(createCoderBackend("codex").id).toBe("codex");
  });
});

// ── MCP list on fresh (non-existent) config ────────────────────────────────

describe("CodexCliBackend MCP management", () => {
  it("listInstalledMcps() resolves to an array even if config doesn't exist", async () => {
    const result = await new CodexCliBackend().listInstalledMcps();
    expect(Array.isArray(result)).toBe(true);
  });
});
