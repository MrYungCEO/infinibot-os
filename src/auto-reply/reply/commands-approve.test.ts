import { describe, expect, it, vi } from "vitest";

import type { InfinibotConfig } from "../../config/config.js";
import type { MsgContext } from "../templating.js";
import { buildCommandContext, handleCommands } from "./commands.js";
import { parseInlineDirectives } from "./directive-handling.js";
import { callGateway } from "../../gateway/call.js";

vi.mock("../../gateway/call.js", () => ({
  callGateway: vi.fn(),
}));

function buildParams(
  commandBody: string,
  cfg: InfinibotConfig,
  ctxOverrides?: Partial<MsgContext>,
) {
  const ctx = {
    Body: commandBody,
    CommandBody: commandBody,
    CommandSource: "text",
    CommandAuthorized: true,
    Provider: "whatsapp",
    Surface: "whatsapp",
    ...ctxOverrides,
  } as MsgContext;

  const command = buildCommandContext({
    ctx,
    cfg,
    isGroup: false,
    triggerBodyNormalized: commandBody.trim().toLowerCase(),
    commandAuthorized: true,
  });

  return {
    ctx,
    cfg,
    command,
    directives: parseInlineDirectives(commandBody),
    elevated: { enabled: true, allowed: true, failures: [] },
    sessionKey: "agent:main:main",
    workspaceDir: "/tmp",
    defaultGroupActivation: () => "mention",
    resolvedVerboseLevel: "off" as const,
    resolvedReasoningLevel: "off" as const,
    resolveDefaultThinkingLevel: async () => undefined,
    provider: "whatsapp",
    model: "test-model",
    contextTokens: 0,
    isGroup: false,
  };
}

describe("/approve command", () => {
  it("rejects invalid usage", async () => {
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as InfinibotConfig;
    const params = buildParams("/approve", cfg);
    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("Usage: /approve");
  });

  it("resolves a unified approval (with note) via approvals.resolve", async () => {
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as InfinibotConfig;
    const params = buildParams("/approve abc approve ship it after 5pm", cfg, { SenderId: "123" });

    const mockCallGateway = vi.mocked(callGateway);
    mockCallGateway.mockReset();
    mockCallGateway.mockResolvedValueOnce({
      ok: true,
      record: { status: "approved", title: "Deploy gateway" },
    });

    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("approved: Deploy gateway");
    expect(mockCallGateway).toHaveBeenCalledTimes(1);
    expect(mockCallGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "approvals.resolve",
        params: expect.objectContaining({
          id: "abc",
          action: "approve",
          note: "ship it after 5pm",
          via: "chat",
        }),
      }),
    );
  });

  it("reports an already-resolved approval instead of re-deciding", async () => {
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as InfinibotConfig;
    const params = buildParams("/approve abc deny", cfg, { SenderId: "123" });
    const mockCallGateway = vi.mocked(callGateway);
    mockCallGateway.mockReset();
    mockCallGateway.mockResolvedValueOnce({
      ok: false,
      error: "already_resolved",
      record: { status: "approved", decidedBy: "@owner" },
    });
    const result = await handleCommands(params);
    expect(result.reply?.text).toContain("Already approved by @owner");
    expect(mockCallGateway).toHaveBeenCalledTimes(1);
  });

  it("falls back to the legacy exec path for ids the registry doesn't know", async () => {
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as InfinibotConfig;
    const params = buildParams("/approve abc allow-once", cfg, { SenderId: "123" });

    const mockCallGateway = vi.mocked(callGateway);
    mockCallGateway.mockReset();
    mockCallGateway.mockResolvedValueOnce({ ok: false, error: "not_found", record: null });
    mockCallGateway.mockResolvedValueOnce({ ok: true });

    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("Exec approval allow-once submitted");
    expect(mockCallGateway).toHaveBeenLastCalledWith(
      expect.objectContaining({
        method: "exec.approval.resolve",
        params: { id: "abc", decision: "allow-once" },
      }),
    );
  });
});
