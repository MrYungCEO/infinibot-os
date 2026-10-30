import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetApprovalRegistry,
  createApproval,
  createApprovalRequest,
  getApproval,
  getApprovalRequest,
  listApprovalRequests,
  loadApprovalRegistry,
  onApprovalEvent,
  readApprovalAudit,
  resolveApproval,
  resolveApprovalRequest,
  waitForApprovalRequest,
  type ApprovalEvent,
} from "./approval-registry.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "approvals-test-"));
  _resetApprovalRegistry({ dir });
});

afterEach(() => {
  vi.useRealTimers();
  _resetApprovalRegistry();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("approval registry lifecycle", () => {
  it("creates a pending request and emits requested/resolved events", () => {
    const events: ApprovalEvent[] = [];
    onApprovalEvent((e) => {
      events.push(e);
    });
    const rec = createApprovalRequest({
      source: "orchestrator",
      title: "fly deploy infinibot-gateway",
      summary: "billable deploy",
      details: "fly deploy -a infinibot-gateway",
      risk: "high",
      requester: { label: "MCP orchestrator", sessionKey: "agent:main:mcp-1" },
    });
    expect(rec.status).toBe("pending");
    expect(rec.options).toEqual(expect.arrayContaining(["approve", "deny"]));
    expect(listApprovalRequests().map((r) => r.id)).toEqual([rec.id]);

    const res = resolveApprovalRequest(rec.id, {
      action: "approve",
      note: "go",
      by: "@owner",
      via: "telegram",
    });
    expect(res.ok).toBe(true);
    const after = getApprovalRequest(rec.id)!;
    expect(after.status).toBe("approved");
    expect(after.decision).toBe("approved");
    expect(after.note).toBe("go");
    expect(after.decidedVia).toBe("telegram");
    expect(events.map((e) => e.type)).toEqual(["requested", "resolved"]);
    expect(listApprovalRequests()).toHaveLength(0);
  });

  it("first resolution wins across surfaces; later ones get already_resolved", () => {
    const onResolve = vi.fn();
    const rec = createApprovalRequest({ source: "custom", title: "x", onResolve });
    const first = resolveApprovalRequest(rec.id, { action: "deny", by: "web", via: "ui" });
    const second = resolveApprovalRequest(rec.id, {
      action: "approve",
      by: "@owner",
      via: "telegram",
    });
    const third = resolveApprovalRequest(rec.id, { action: "approve", by: "cli", via: "cli" });
    expect(first.ok).toBe(true);
    expect(second).toMatchObject({ ok: false, error: "already_resolved" });
    expect(third).toMatchObject({ ok: false, error: "already_resolved" });
    expect(getApprovalRequest(rec.id)!.status).toBe("denied");
    expect(getApprovalRequest(rec.id)!.decidedVia).toBe("ui");
    expect(onResolve).toHaveBeenCalledTimes(1);
  });

  it("rejects options the request didn't offer", () => {
    const rec = createApprovalRequest({ source: "custom", title: "x" });
    expect(
      resolveApprovalRequest(rec.id, { action: "redirect", note: "n", via: "ui" }),
    ).toMatchObject({
      ok: false,
      error: "option_not_allowed",
    });
    expect(resolveApprovalRequest(rec.id, { action: "approve-always", via: "ui" })).toMatchObject({
      ok: false,
      error: "option_not_allowed",
    });
    expect(getApprovalRequest(rec.id)!.status).toBe("pending");
  });

  it("unknown ids return not_found", () => {
    expect(resolveApprovalRequest("nope", { action: "approve", via: "ui" })).toMatchObject({
      ok: false,
      error: "not_found",
    });
  });

  it("expiry DENIES (never approves) and fires the source callback", () => {
    vi.useFakeTimers();
    const onResolve = vi.fn();
    const rec = createApprovalRequest({
      source: "orchestrator",
      title: "restart gateway",
      timeoutMs: 60_000,
      onResolve,
    });
    vi.advanceTimersByTime(59_999);
    expect(getApprovalRequest(rec.id)!.status).toBe("pending");
    vi.advanceTimersByTime(2);
    const after = getApprovalRequest(rec.id)!;
    expect(after.status).toBe("denied");
    expect(after.decidedVia).toBe("system");
    expect(after.reason).toBe("expired");
    expect(onResolve).toHaveBeenCalledWith(expect.objectContaining({ status: "denied" }));
  });

  it("waitForApprovalRequest resolves on decision or returns pending after waitMs", async () => {
    const rec = createApprovalRequest({ source: "custom", title: "x" });
    const pending = await waitForApprovalRequest(rec.id, 10);
    expect(pending?.status).toBe("pending");
    const p = waitForApprovalRequest(rec.id, 5_000);
    resolveApprovalRequest(rec.id, { action: "approve", via: "ui" });
    expect((await p)?.status).toBe("approved");
    expect(await waitForApprovalRequest("missing", 1)).toBeNull();
  });
});

describe("redaction + truncation", () => {
  it("redacts secrets in details/summary/notes and truncates long details", () => {
    const secret = "sk-abcdefghijklmnopqrstuvwxyz0123456789";
    const rec = createApprovalRequest({
      source: "exec",
      title: "deploy",
      summary: `uses ${secret}`,
      details: `FLY_API_TOKEN=fo1_supersecretvalue123456789 fly deploy\n${"x".repeat(20_000)}`,
    });
    expect(rec.details).not.toContain("fo1_supersecretvalue123456789");
    // Fully masked — no leading/trailing characters of the secret survive.
    expect(rec.details).toContain("FLY_API_TOKEN=***");
    expect(rec.details).not.toContain("fo1_su");
    expect(rec.summary).not.toContain(secret);
    expect(rec.summary).not.toContain("sk-abc");
    expect(rec.details.length).toBeLessThanOrEqual(8_000);
    expect(rec.details).toContain("[truncated");
    resolveApprovalRequest(rec.id, {
      action: "approve",
      note: `here is the key ghp_abcdefghijklmnopqrstuvwxyz0123`,
      via: "ui",
    });
    expect(getApprovalRequest(rec.id)!.note).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123");
    // Nothing secret reaches disk either.
    const onDisk = fs.readFileSync(path.join(dir, "approvals.json"), "utf8");
    expect(onDisk).not.toContain("fo1_supersecretvalue123456789");
    expect(onDisk).not.toContain(secret);
  });
});

describe("persistence across a gateway restart", () => {
  it("keeps resumable requests pending, closes non-resumable + expired ones as denied", () => {
    let now = 1_000_000;
    _resetApprovalRegistry({ dir, now: () => now });
    const resumable = createApprovalRequest({
      source: "orchestrator",
      title: "deploy",
      timeoutMs: 600_000,
    });
    const ephemeral = createApprovalRequest({
      source: "exec",
      title: "rm -rf build",
      timeoutMs: 600_000,
      resumable: false,
    });
    const shortLived = createApprovalRequest({
      source: "custom",
      title: "short",
      timeoutMs: 10_000,
    });
    const decided = createApprovalRequest({ source: "custom", title: "done" });
    resolveApprovalRequest(decided.id, { action: "approve", by: "@owner", via: "telegram" });

    // "Restart": drop all in-memory state, keep the directory, advance time.
    now += 60_000;
    _resetApprovalRegistry({ dir, now: () => now });
    loadApprovalRegistry();

    expect(getApprovalRequest(resumable.id)!.status).toBe("pending");
    expect(getApprovalRequest(ephemeral.id)).toMatchObject({
      status: "denied",
      reason: "gateway_restart",
      decidedVia: "system",
    });
    expect(getApprovalRequest(shortLived.id)).toMatchObject({
      status: "denied",
      reason: "expired",
    });
    expect(getApprovalRequest(decided.id)).toMatchObject({
      status: "approved",
      decidedBy: "@owner",
    });

    // Still resolvable after the restart (e.g. a Telegram tap on the old card).
    expect(resolveApprovalRequest(resumable.id, { action: "approve", via: "telegram" }).ok).toBe(
      true,
    );
  });

  it("re-arms expiry timers for restored pending requests", () => {
    vi.useFakeTimers();
    const rec = createApprovalRequest({ source: "orchestrator", title: "x", timeoutMs: 30_000 });
    _resetApprovalRegistry({ dir });
    loadApprovalRegistry();
    expect(getApprovalRequest(rec.id)!.status).toBe("pending");
    vi.advanceTimersByTime(31_000);
    expect(getApprovalRequest(rec.id)).toMatchObject({ status: "denied", reason: "expired" });
  });

  it("writes an audit trail of every request + resolution", () => {
    const rec = createApprovalRequest({ source: "orchestrator", title: "deploy" });
    resolveApprovalRequest(rec.id, {
      action: "deny",
      note: "not now",
      by: "@owner",
      via: "telegram",
    });
    const audit = readApprovalAudit();
    expect(audit.map((e) => e.event)).toEqual(["requested", "resolved"]);
    expect(audit[1]).toMatchObject({
      id: rec.id,
      status: "denied",
      by: "@owner",
      via: "telegram",
      note: "not now",
    });
    expect(typeof audit[1].ts).toBe("string");
  });
});

describe("legacy autopilot API", () => {
  it("createApproval/resolveApproval/getApproval keep their contract", async () => {
    const { record, promise } = createApproval({
      title: "Autonomous task",
      summary: "refactor",
      context: "touches 12 files",
      criticality: "critical",
    });
    expect(record.criticality).toBe("critical");
    expect(record.context).toBe("touches 12 files");
    expect(resolveApproval(record.id, "approved", "@owner")).toBe(true);
    expect(resolveApproval(record.id, "denied", "@owner")).toBe(false);
    const done = await promise;
    expect(done.status).toBe("approved");
    expect(getApproval(record.id)!.decision).toBe("approved");
  });
});

describe("resolver policy (money-moving approvals)", () => {
  const make = (saasOwnerOfTenant?: string) =>
    createApprovalRequest({
      source: "tool-gate",
      title: "BUY BONK",
      resolverPolicy: {
        approveVia: ["telegram", "ui"],
        ...(saasOwnerOfTenant ? { saasOwnerOfTenant } : {}),
      },
    });

  it("refuses approve without a verified actor, from agents and from chat/CLI connections", () => {
    const rec = make();
    expect(resolveApprovalRequest(rec.id, { action: "approve", via: "ui" })).toMatchObject({
      ok: false,
      error: "not_authorized",
    });
    for (const clientMode of ["backend", "cli", "node", undefined]) {
      const r = resolveApprovalRequest(rec.id, {
        action: "approve",
        via: "ui",
        actor: { kind: "rpc", clientMode },
      });
      expect(r).toMatchObject({ ok: false, error: "not_authorized" });
    }
    expect(
      resolveApprovalRequest(rec.id, {
        action: "approve",
        via: "system",
        actor: { kind: "in-process" },
      }).ok,
    ).toBe(false);
    expect(getApprovalRequest(rec.id)?.status).toBe("pending");
    expect(readApprovalAudit(50).some((e) => e.event === "resolve_rejected")).toBe(true);
  });

  it("allows the Telegram operator callback and an interactive UI session", () => {
    const a = make();
    expect(
      resolveApprovalRequest(a.id, {
        action: "approve",
        via: "telegram",
        actor: { kind: "telegram-callback" },
      }).ok,
    ).toBe(true);
    const b = make();
    expect(
      resolveApprovalRequest(b.id, {
        action: "approve",
        via: "ui",
        actor: { kind: "rpc", clientMode: "webchat" },
      }).ok,
    ).toBe(true);
  });

  it("deny is always allowed (the safe direction)", () => {
    const rec = make("t_1");
    expect(
      resolveApprovalRequest(rec.id, {
        action: "deny",
        via: "cli",
        actor: { kind: "rpc", clientMode: "cli" },
      }).ok,
    ).toBe(true);
  });

  it("SaaS: only the Clerk-authenticated owner of that tenant", () => {
    const rec = make("t_1");
    const ui = (x: Record<string, string>) => ({ kind: "rpc" as const, clientMode: "ui", ...x });
    expect(
      resolveApprovalRequest(rec.id, {
        action: "approve",
        via: "ui",
        actor: ui({ authMethod: "token", saasTenantId: "t_1", saasRole: "owner" }),
      }).ok,
    ).toBe(false);
    expect(
      resolveApprovalRequest(rec.id, {
        action: "approve",
        via: "ui",
        actor: ui({ authMethod: "clerk", saasTenantId: "t_2", saasRole: "owner" }),
      }).ok,
    ).toBe(false);
    expect(
      resolveApprovalRequest(rec.id, {
        action: "approve",
        via: "ui",
        actor: ui({ authMethod: "clerk", saasTenantId: "t_1", saasRole: "member" }),
      }).ok,
    ).toBe(false);
    expect(
      resolveApprovalRequest(rec.id, {
        action: "approve",
        via: "ui",
        actor: ui({ authMethod: "clerk", saasTenantId: "t_1", saasRole: "owner" }),
      }).ok,
    ).toBe(true);
  });

  it("the policy survives a restart", () => {
    const rec = make("t_1");
    _resetApprovalRegistry({ dir });
    loadApprovalRegistry();
    expect(getApprovalRequest(rec.id)?.resolverPolicy).toEqual({
      approveVia: ["telegram", "ui"],
      saasOwnerOfTenant: "t_1",
    });
    expect(
      resolveApprovalRequest(rec.id, {
        action: "approve",
        via: "ui",
        actor: { kind: "rpc", clientMode: "backend" },
      }).ok,
    ).toBe(false);
  });

  it("requests without a policy keep the legacy behaviour", () => {
    const rec = createApprovalRequest({ source: "orchestrator", title: "legacy" });
    expect(resolveApprovalRequest(rec.id, { action: "approve", via: "chat" }).ok).toBe(true);
  });
});
