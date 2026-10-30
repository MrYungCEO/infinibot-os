import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetApprovalRegistry,
  getApprovalRequest,
  resolveApprovalRequest,
} from "../../autonomy/approval-registry.js";
import { ExecApprovalManager } from "../exec-approval-manager.js";
import { createExecApprovalHandlers } from "./exec-approval.js";

const noop = () => {};

function harness() {
  const manager = new ExecApprovalManager();
  const forwarder = {
    handleRequested: vi.fn(async () => {}),
    handleResolved: vi.fn(async () => {}),
    stop: vi.fn(),
  };
  const handlers = createExecApprovalHandlers(manager, { forwarder });
  const broadcasts: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const context = {
    broadcast: (event: string, payload: Record<string, unknown>) =>
      broadcasts.push({ event, payload }),
  } as never;
  const respond = vi.fn();
  const request = handlers["exec.approval.request"]({
    params: {
      command: "fly deploy -a infinibot-gateway FLY_API_TOKEN=fo1_abcdefghijklmnopqrstuvwxyz",
      cwd: "/srv",
      host: "gateway",
      agentId: "main",
      timeoutMs: 60_000,
    },
    respond,
    context,
    client: null,
    req: { id: "r1", type: "req", method: "exec.approval.request" },
    isWebchatConnect: noop,
  } as never) as Promise<void>;
  const id = (broadcasts.find((b) => b.event === "exec.approval.requested")?.payload.id ??
    "") as string;
  return { manager, handlers, broadcasts, context, respond, request, id, forwarder };
}

beforeEach(() => _resetApprovalRegistry());
afterEach(() => _resetApprovalRegistry());

describe("exec approvals ⇄ unified registry", () => {
  it("mirrors the exec request into the registry under the same id (redacted)", async () => {
    const h = harness();
    const rec = getApprovalRequest(h.id)!;
    expect(rec).toMatchObject({ source: "exec", status: "pending", resumable: false });
    expect(rec.options).toContain("approve-always");
    expect(rec.details).toContain("fly deploy -a infinibot-gateway");
    expect(rec.details).not.toContain("fo1_abcdefghijklmnopqrstuvwxyz");
    resolveApprovalRequest(h.id, { action: "deny", via: "ui" });
    await h.request;
  });

  it("a Telegram 'Always' tap unblocks the exec with allow-always + broadcasts once", async () => {
    const h = harness();
    const res = resolveApprovalRequest(h.id, {
      action: "approve-always",
      by: "@boss",
      via: "telegram",
    });
    expect(res.ok).toBe(true);
    await h.request;
    expect(h.respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ id: h.id, decision: "allow-always" }),
      undefined,
    );
    const resolved = h.broadcasts.filter((b) => b.event === "exec.approval.resolved");
    expect(resolved).toHaveLength(1);
    expect(resolved[0].payload).toMatchObject({ decision: "allow-always", resolvedBy: "@boss" });
    expect(h.forwarder.handleResolved).toHaveBeenCalledTimes(1);
  });

  it("exec.approval.resolve (Discord/UI/CLI) closes the unified record; a later Telegram tap loses", async () => {
    const h = harness();
    const resolveRespond = vi.fn();
    await h.handlers["exec.approval.resolve"]({
      params: { id: h.id, decision: "deny" },
      respond: resolveRespond,
      context: h.context,
      client: {
        connect: { client: { id: "discord-exec-approvals", displayName: "Discord approvals" } },
      },
      req: { id: "r2", type: "req", method: "exec.approval.resolve" },
      isWebchatConnect: noop,
    } as never);
    await h.request;
    expect(resolveRespond).toHaveBeenCalledWith(true, { ok: true }, undefined);
    expect(getApprovalRequest(h.id)).toMatchObject({ status: "denied", decidedVia: "discord" });
    expect(h.respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ decision: "deny" }),
      undefined,
    );
    expect(resolveApprovalRequest(h.id, { action: "approve", via: "telegram" })).toMatchObject({
      ok: false,
      error: "already_resolved",
    });

    // And a second exec.approval.resolve reports the winner instead of silently succeeding.
    const again = vi.fn();
    await h.handlers["exec.approval.resolve"]({
      params: { id: h.id, decision: "allow-once" },
      respond: again,
      context: h.context,
      client: null,
      req: { id: "r3", type: "req", method: "exec.approval.resolve" },
      isWebchatConnect: noop,
    } as never);
    expect(again.mock.calls[0][0]).toBe(false);
    expect(String(again.mock.calls[0][2]?.message)).toContain("already denied");
  });
});
