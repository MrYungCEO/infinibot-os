import { afterEach, describe, expect, it, vi } from "vitest";

let mockedConfig: Record<string, unknown> = {};
vi.mock("../../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/config.js")>();
  return { ...actual, loadConfig: () => mockedConfig };
});

import { resolveCliBackendConfig } from "../cli-backends.js";
import { allowCoderBypassFlag } from "./approval-policy.js";
import { buildCodexArgsForTest } from "./codex.js";
import { buildGeminiArgsForTest } from "./gemini.js";
import type { CLIAgentConfig } from "../types/agent-types.js";

const base: CLIAgentConfig = {
  id: "t",
  name: "t",
  type: "cli",
  cliCommand: "codex",
  autoApprove: true,
  timeoutMinutes: 1,
};

describe('tools.coder.autoApprove="never" at the flag emission points', () => {
  afterEach(() => {
    mockedConfig = {};
  });

  it("default config keeps the bypass for auto-approved (operator) spawns", () => {
    expect(allowCoderBypassFlag(true)).toBe(true);
    expect(buildCodexArgsForTest(base, "task")).toContain(
      "--dangerously-bypass-approvals-and-sandbox",
    );
  });

  it("never suppresses codex, gemini and claude-cli bypass flags", () => {
    mockedConfig = { tools: { coder: { autoApprove: "never" } } };
    expect(allowCoderBypassFlag(true)).toBe(false);
    expect(buildCodexArgsForTest(base, "task")).not.toContain(
      "--dangerously-bypass-approvals-and-sandbox",
    );
    const gemini = buildGeminiArgsForTest({ ...base, cliCommand: "gemini" }, "task");
    expect(gemini.join(" ")).not.toContain("yolo");
    const claude = resolveCliBackendConfig("claude-cli", mockedConfig as never);
    expect(claude?.config.args).not.toContain("--dangerously-skip-permissions");
    expect(claude?.config.resumeArgs).not.toContain("--dangerously-skip-permissions");
  });

  it("cli backends drop bypass flags for untrusted origins, keep them for operators", () => {
    // Built-in chat backends never bypass: codex runs read-only, claude has no
    // built-in tools. An operator override that adds the flag keeps it for
    // trusted turns only.
    const builtin = resolveCliBackendConfig("codex-cli", {} as never);
    expect(builtin?.config.args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(builtin?.config.args).toContain("read-only");
    const cfg = {
      agents: {
        defaults: {
          cliBackends: {
            "codex-cli": {
              command: "codex",
              args: [
                "exec",
                "--sandbox",
                "workspace-write",
                "--dangerously-bypass-approvals-and-sandbox",
              ],
            },
          },
        },
      },
    } as never;
    const trusted = resolveCliBackendConfig("codex-cli", cfg);
    expect(trusted?.config.args).toContain("--dangerously-bypass-approvals-and-sandbox");
    const untrusted = resolveCliBackendConfig("codex-cli", cfg, { trustedOrigin: false });
    expect(untrusted?.config.args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(untrusted?.config.args).toContain("--sandbox");
  });
});

describe("hosted SaaS: no coder permission bypass, whatever the config says", () => {
  const saved = process.env.SAAS_MODE;
  afterEach(() => {
    mockedConfig = {};
    if (saved === undefined) delete process.env.SAAS_MODE;
    else process.env.SAAS_MODE = saved;
  });

  it('tenant config "always" cannot re-enable the bypass flags in SaaS mode', () => {
    process.env.SAAS_MODE = "1";
    mockedConfig = { tools: { coder: { autoApprove: "always" } } };
    expect(allowCoderBypassFlag(true)).toBe(false);
    expect(buildCodexArgsForTest(base, "p")).not.toContain(
      "--dangerously-bypass-approvals-and-sandbox",
    );
    const claude = resolveCliBackendConfig("claude-cli", mockedConfig as never);
    expect(claude?.config.args).not.toContain("--dangerously-skip-permissions");
  });
});
