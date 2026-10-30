import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetQueueStoreForTests, getQueueStore } from "../../queue/store.js";
import { getQueueOrchestrator, resetQueueOrchestratorForTests } from "../../queue/orchestrator.js";
import { FakeRunner, fakeAvailability } from "../../queue/test-helpers.js";

async function call(handlers: any, method: string, params: unknown) {
  let out: { ok: boolean; payload?: any; error?: any } = { ok: false };
  await handlers[method]({
    params,
    client: null,
    respond: (ok: boolean, payload?: unknown, error?: unknown) => {
      out = { ok, payload, error };
    },
  });
  return out;
}

describe("queue.* RPCs", () => {
  let handlers: any;
  const runner = new FakeRunner();
  const work = mkdtempSync(join(tmpdir(), "queue-rpc-work-"));

  beforeAll(async () => {
    resetQueueOrchestratorForTests();
    resetQueueStoreForTests();
    getQueueStore(mkdtempSync(join(tmpdir(), "queue-rpc-state-")));
    getQueueOrchestrator(
      { runner, availability: fakeAvailability({ gemini: "not-installed" }) },
      { tickMs: 999_999, retryBackoffMs: { base: 0, max: 0 } },
    );
    handlers = (await import("./queue.js")).queueHandlers;
  });

  it("validates params against the schema", async () => {
    const bad = [
      ["queue.enqueue", { phaseSpec: [] }],
      ["queue.enqueue", { phaseSpec: [{ brief: "no name" }] }],
      ["queue.enqueue", { phaseSpec: [{ name: "p", gateCriteria: [{ type: "bogus" }] }] }],
      ["queue.enqueue", { phaseSpec: [{ name: "p" }], isolation: "sometimes" }],
      ["queue.enqueue", { phaseSpec: [{ name: "p", maxAttempts: 0 }] }],
      ["queue.enqueue", { phaseSpec: [{ name: "p" }], extra: 1 }],
      ["queue.list", { status: "nope" }],
      ["queue.reorder", { id: "x", priority: 1.5 }],
      ["queue.get", {}],
    ] as const;
    for (const [m, p] of bad) {
      const r = await call(handlers, m, p);
      expect(r.ok, `${m} ${JSON.stringify(p)}`).toBe(false);
      expect(r.error.code).toBe("INVALID_PARAMS");
    }
    const rel = await call(handlers, "queue.enqueue", {
      phaseSpec: [{ name: "p" }],
      workdir: "relative/dir",
    });
    expect(rel.error.message).toMatch(/absolute/);
    const dep = await call(handlers, "queue.enqueue", {
      phaseSpec: [{ name: "p" }],
      dependsOn: ["missing-id"],
    });
    expect(dep.error.code).toBe("NOT_FOUND");
  });

  it("full control flow: enqueue → run → pause/resume → retry → cancel, with attempts + events + logs", async () => {
    runner.script("codex", { kind: "hang" });
    const created = await call(handlers, "queue.enqueue", {
      title: "RPC flow",
      briefMd: "brief",
      workdir: work,
      idempotencyKey: "rpc-flow-1",
      phaseSpec: [
        {
          name: "build",
          brief: "b",
          agent: "codex",
          model: "openai/gpt-5",
          gateCriteria: [{ type: "shell", command: "true" }],
        },
        { name: "docs", brief: "d", agent: "gemini" },
      ],
    });
    expect(created.ok).toBe(true);
    const id = created.payload.id;
    const again = await call(handlers, "queue.enqueue", {
      idempotencyKey: "rpc-flow-1",
      phaseSpec: [{ name: "x" }],
    });
    expect([again.payload.id, again.payload.deduped]).toEqual([id, true]);

    const orch = getQueueOrchestrator();
    await orch.tick();
    let got = await call(handlers, "queue.get", { id: id.slice(0, 8) });
    expect(got.payload.entry.status).toBe("running");
    expect(got.payload.entry.currentAttempt).toMatchObject({
      agent: "codex",
      model: "gpt-5",
      modelRequested: "openai/gpt-5",
    });

    const logs = await call(handlers, "queue.logs", { id });
    expect(logs.payload.text).toContain("fake output");

    // Force pause stops the hung attempt (uncounted), resume re-dispatches on the same session.
    expect((await call(handlers, "queue.pause", { id, force: true })).payload.entry.status).toBe(
      "paused",
    );
    expect(runner.kills).toHaveLength(1);
    expect((await call(handlers, "queue.resume", { id })).payload.entry.status).toBe("queued");
    await orch.tick(); // phase 1 resumed (verified default)
    await orch.tick(); // settles → phase 2 (gemini unavailable) → blocked
    await orch.tick();
    got = await call(handlers, "queue.get", { id });
    expect(got.payload.entry.status).toBe("blocked");
    expect(got.payload.entry.blockedKind).toBe("backend_unavailable");
    expect(got.payload.attempts.map((a: any) => a.outcome)).toEqual(["interrupted", "passed"]);
    expect(got.payload.attempts[1].resumedSession).toBe(got.payload.attempts[0].sessionId);
    expect(got.payload.events.map((e: any) => e.kind)).toEqual(
      expect.arrayContaining([
        "queue.entry.created",
        "queue.entry.paused",
        "queue.entry.resumed",
        "queue.phase.completed",
        "queue.entry.blocked",
      ]),
    );

    // Retry with a fallback isn't possible via RPC params; skip the phase instead (audited).
    const adv = await call(handlers, "queue.advance", { id, reason: "docs done by hand" });
    expect(adv.payload.entry.status).toBe("done");
    const cannot = await call(handlers, "queue.cancel", { id });
    expect(cannot.ok).toBe(false);
    const retried = await call(handlers, "queue.retry", { id, fromPhase: 0, instruction: "again" });
    expect(retried.payload.entry).toMatchObject({
      status: "queued",
      currentPhaseIdx: 0,
      pendingInstruction: "again",
    });
    const canceled = await call(handlers, "queue.cancel", { id, reason: "enough" });
    expect(canceled.payload.entry.status).toBe("canceled");

    const list = await call(handlers, "queue.list", { status: ["canceled"] });
    expect(list.payload.entries.map((e: any) => e.id)).toContain(id);
    expect(list.payload).toMatchObject({ paused: false, maxConcurrent: expect.any(Number) });
    const metrics = await call(handlers, "queue.metrics", {});
    expect(metrics.payload.byAgent.find((a: any) => a.agent === "codex")).toMatchObject({
      passed: 1,
    });

    expect((await call(handlers, "queue.setPaused", { paused: true })).payload.paused).toBe(true);
    expect((await call(handlers, "queue.list", {})).payload.paused).toBe(true);
    await call(handlers, "queue.setPaused", { paused: false });
    expect(
      (await call(handlers, "queue.reorder", { id, priority: 7 })).payload.entry.priority,
    ).toBe(7);
  });

  it("is registered, scoped and advertised", async () => {
    const { listGatewayMethods, GATEWAY_EVENTS } = await import("../server-methods-list.js");
    const { coreGatewayHandlers, handleGatewayRequest } = await import("../server-methods.js");
    const { QUEUE_READ_METHODS, QUEUE_WRITE_METHODS } = await import("./queue.js");
    for (const m of [...QUEUE_READ_METHODS, ...QUEUE_WRITE_METHODS]) {
      expect(listGatewayMethods()).toContain(m);
      expect(coreGatewayHandlers[m]).toBeTypeOf("function");
    }
    expect(GATEWAY_EVENTS).toEqual(
      expect.arrayContaining(["queue.changed", "queue.entry.blocked", "queue.phase.completed"]),
    );
    const ask = async (method: string, scopes: string[]) => {
      let res: { ok: boolean; error?: any } = { ok: false };
      await handleGatewayRequest({
        req: { type: "req", id: "1", method, params: {} },
        client: { connect: { role: "operator", scopes } } as any,
        isWebchatConnect: () => false,
        context: {} as any,
        respond: (ok: boolean, _p?: unknown, error?: unknown) => {
          res = { ok, error };
        },
      } as any);
      return res;
    };
    expect((await ask("queue.list", ["operator.read"])).ok).toBe(true);
    const denied = await ask("queue.enqueue", ["operator.read"]);
    expect(denied.error?.message).toMatch(/operator.write/);
  });
});
