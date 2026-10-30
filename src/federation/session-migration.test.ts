/**
 * Tests for the Session Migration orchestrator.
 *
 * Exercises the validate → transfer → verify → cleanup lifecycle against an
 * injected mock {@link MigrationDeps}, so no live peer-mesh is required.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  SessionMigrationManager,
  type MigrationDeps,
  type TransferAck,
  type VerifyAck,
  type LocalSessionInfo,
} from "./session-migration.js";
import type { MigrationRequest } from "./types.js";

const baseRequest: MigrationRequest = {
  sessionKey: "agent:coder:abc123",
  sourceNodeId: "node-a",
  targetNodeId: "node-b",
  reason: "load balancing",
  priority: "normal",
};

/** A fully-wired happy-path deps double; individual fields overridable per test. */
function makeDeps(overrides: Partial<MigrationDeps> = {}): MigrationDeps & {
  setDraining: ReturnType<typeof vi.fn>;
  deleteLocalSession: ReturnType<typeof vi.fn>;
  updateRemoteRegistry: ReturnType<typeof vi.fn>;
  sendTransfer: ReturnType<typeof vi.fn>;
  sendVerify: ReturnType<typeof vi.fn>;
} {
  const local: LocalSessionInfo = { exists: true, agentId: "coder", messageCount: 2 };

  const transferAck: TransferAck = {
    success: true,
    newSessionKey: "agent:coder:migrated-1",
    messageCount: 2,
    agentId: "coder",
  };

  const deps = {
    describeLocalSession: vi.fn(async () => local),
    isTargetReachable: vi.fn(() => true),
    targetHasCapacity: vi.fn(() => true),
    sendTransfer: vi.fn(async () => transferAck),
    // Echo the assertion nonce back so the round-trip check passes.
    sendVerify: vi.fn(
      async (_target, payload): Promise<VerifyAck> => ({
        success: true,
        live: true,
        sessionKey: payload.sessionKey,
        agentId: payload.assertion.expectedAgentId,
        messageCount: payload.assertion.expectedMessageCount,
        echo: payload.assertion.nonce,
      }),
    ),
    setDraining: vi.fn(),
    deleteLocalSession: vi.fn(async () => {}),
    updateRemoteRegistry: vi.fn(),
    ...overrides,
  };

  return deps as unknown as ReturnType<typeof makeDeps>;
}

describe("SessionMigrationManager", () => {
  let deps: ReturnType<typeof makeDeps>;
  let manager: SessionMigrationManager;

  beforeEach(() => {
    deps = makeDeps();
    manager = new SessionMigrationManager(deps);
  });

  it("completes the full lifecycle on the happy path", async () => {
    const result = await manager.migrateSession(baseRequest);

    expect(result.success).toBe(true);
    expect(result.newSessionKey).toBe("agent:coder:migrated-1");
    expect(result.stepsCompleted).toEqual([
      "initiated",
      "validating",
      "serializing",
      "transferring",
      "restoring",
      "verifying",
      "cleanup",
      "completed",
    ]);
    expect(result.transferStats?.stateSize).toBeGreaterThan(0);
  });

  it("runs validation, transfer, verify and cleanup in order", async () => {
    await manager.migrateSession(baseRequest);

    expect(deps.describeLocalSession).toHaveBeenCalledWith(baseRequest.sessionKey);
    expect(deps.isTargetReachable).toHaveBeenCalledWith("node-b");
    expect(deps.targetHasCapacity).toHaveBeenCalledWith("node-b", "coder");
    expect(deps.sendTransfer).toHaveBeenCalledTimes(1);
    expect(deps.sendVerify).toHaveBeenCalledTimes(1);

    // Source drains before the target goes live, then is torn down on success.
    expect(deps.setDraining).toHaveBeenCalledWith(baseRequest.sessionKey, true);
    expect(deps.deleteLocalSession).toHaveBeenCalledWith(baseRequest.sessionKey);
    expect(deps.updateRemoteRegistry).toHaveBeenCalledWith(
      expect.objectContaining({
        originalSessionKey: baseRequest.sessionKey,
        newSessionKey: "agent:coder:migrated-1",
        targetNodeId: "node-b",
      }),
    );
  });

  it("emits a completed event", async () => {
    const completed = vi.fn();
    manager.on("completed", completed);

    await manager.migrateSession(baseRequest);

    expect(completed).toHaveBeenCalledTimes(1);
  });

  it("keeps the source session when keepOriginal is set", async () => {
    await manager.migrateSession(baseRequest, { keepOriginal: true });
    expect(deps.deleteLocalSession).not.toHaveBeenCalled();
  });

  // --- Validation rules ---

  it("rejects when the source session does not exist locally", async () => {
    deps.describeLocalSession = vi.fn(async () => null);
    await expect(manager.migrateSession(baseRequest)).rejects.toThrow(/not found/);
    expect(deps.sendTransfer).not.toHaveBeenCalled();
  });

  it("rejects when the target peer is unreachable", async () => {
    deps.isTargetReachable = vi.fn(() => false);
    await expect(manager.migrateSession(baseRequest)).rejects.toThrow(/not reachable/);
  });

  it("rejects when the target has no capacity", async () => {
    deps.targetHasCapacity = vi.fn(() => false);
    await expect(manager.migrateSession(baseRequest)).rejects.toThrow(/no capacity/);
  });

  it("rejects source === target", async () => {
    await expect(
      manager.migrateSession({ ...baseRequest, targetNodeId: "node-a" }),
    ).rejects.toThrow(/cannot be the same/);
  });

  it("rejects a second concurrent migration of the same session", async () => {
    // Hold the transfer open so the first migration stays in flight.
    let release!: () => void;
    deps.sendTransfer = vi.fn(
      () =>
        new Promise<TransferAck>((resolve) => {
          release = () =>
            resolve({
              success: true,
              newSessionKey: "agent:coder:migrated-1",
              messageCount: 2,
              agentId: "coder",
            });
        }),
    );

    const first = manager.migrateSession(baseRequest);
    // Let the first reach the transfer step.
    await new Promise((r) => setTimeout(r, 10));

    expect(manager.isSessionMigrating(baseRequest.sessionKey)).toBe(true);
    await expect(manager.migrateSession(baseRequest)).rejects.toThrow(/already being migrated/);

    release();
    await first;
    expect(manager.isSessionMigrating(baseRequest.sessionKey)).toBe(false);
  });

  // --- Verification failure → rollback ---

  it("keeps the source live and clears draining when verification fails", async () => {
    deps.sendVerify = vi.fn(async () => ({
      success: false,
      live: false,
      error: "not live",
    }));

    await expect(manager.migrateSession(baseRequest)).rejects.toThrow(/not live/);

    // Draining was set true (transfer), then cleared false (rollback).
    expect(deps.setDraining).toHaveBeenNthCalledWith(1, baseRequest.sessionKey, true);
    expect(deps.setDraining).toHaveBeenLastCalledWith(baseRequest.sessionKey, false);
    // Source is NOT deleted on a failed verification.
    expect(deps.deleteLocalSession).not.toHaveBeenCalled();
  });

  it("fails when the verify ping nonce does not round-trip", async () => {
    deps.sendVerify = vi.fn(async () => ({
      success: true,
      live: true,
      echo: "wrong-nonce",
    }));

    await expect(manager.migrateSession(baseRequest)).rejects.toThrow(/round-trip/);
    expect(deps.deleteLocalSession).not.toHaveBeenCalled();
  });

  it("fails on message-count parity mismatch", async () => {
    deps.sendVerify = vi.fn(
      async (_t, payload): Promise<VerifyAck> => ({
        success: true,
        live: true,
        echo: payload.assertion.nonce,
        messageCount: 999,
      }),
    );

    await expect(manager.migrateSession(baseRequest)).rejects.toThrow(/parity/);
  });

  // --- Transfer failure ---

  it("propagates a transfer rejection and rolls back", async () => {
    deps.sendTransfer = vi.fn(async () => ({ success: false, error: "target refused" }));

    await expect(manager.migrateSession(baseRequest)).rejects.toThrow(/target refused/);
    expect(deps.setDraining).toHaveBeenLastCalledWith(baseRequest.sessionKey, false);
    expect(deps.sendVerify).not.toHaveBeenCalled();
  });

  it("emits a failed event on error", async () => {
    deps.isTargetReachable = vi.fn(() => false);
    const failed = vi.fn();
    manager.on("failed", failed);

    await expect(manager.migrateSession(baseRequest)).rejects.toThrow();
    expect(failed).toHaveBeenCalledTimes(1);
  });
});
