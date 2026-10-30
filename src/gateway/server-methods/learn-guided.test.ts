/**
 * learn.guided.* handlers: owner fallback identity, plugin-enabled gating over
 * the wire, server-side quiz grading (answer keys never sent), progress sync
 * and certificate minting.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { PluginRecord, PluginRegistry } from "../../plugins/registry.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { CORE_TRACKS } from "../../learn/guided/core/index.js";
import { parseLearnContribution } from "../../learn/guided/validate.js";
import { learnGuidedHandlers } from "./learn-guided.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const stateDir = path.join(os.tmpdir(), `learn-guided-gw-${randomUUID()}`);
let prevState: string | undefined;

const demoLearn = parseLearnContribution("demo", {
  tracks: [
    {
      id: "demo",
      title: "Demo",
      summary: "S",
      overview: "An overview that is long enough.",
      level: "beginner",
      walkthroughs: [
        {
          id: "one",
          title: "One",
          summary: "S",
          estMinutes: 1,
          steps: [{ id: "a", title: "A", body: "B", target: ".a" }],
        },
      ],
      quiz: [
        { id: "q1", prompt: "?", options: ["no", "yes"], answer: 1 },
        { id: "q2", prompt: "?", options: ["yes", "no"], answer: 0 },
      ],
      badge: { id: "demo-mastery", label: "Demo mastery" },
    },
  ],
});
if (!demoLearn.ok) throw new Error(demoLearn.error);

function registry(enabled: boolean): PluginRegistry {
  const record = {
    id: "demo",
    name: "Demo",
    enabled,
    status: enabled ? "loaded" : "disabled",
    manifestVersion: 2,
    contributes: {
      nav: [],
      pages: [],
      rpc: [],
      rpcAliases: [],
      http: [],
      services: [],
      agents: [],
      tools: [],
      panels: [],
      mcpServers: [],
      learn: demoLearn.ok ? demoLearn.learn : undefined,
    },
    catalog: { items: [], importers: [] },
  } as unknown as PluginRecord;
  return {
    plugins: [record],
    tools: [],
    hooks: [],
    typedHooks: [],
    channels: [],
    providers: [],
    gatewayHandlers: {},
    httpHandlers: [],
    httpRoutes: [],
    cliRegistrars: [],
    services: [],
    commands: [],
    diagnostics: [],
  };
}

async function call(method: string, params: Record<string, unknown> = {}) {
  let out: { ok: boolean; payload?: unknown; error?: { code: string; message: string } } = {
    ok: false,
  };
  await learnGuidedHandlers[method]!({
    params,
    client: null,
    respond: (ok: boolean, payload?: unknown, error?: { code: string; message: string }) => {
      out = { ok, payload, error };
    },
  } as unknown as GatewayRequestHandlerOptions);
  return out as {
    ok: boolean;
    payload: Record<string, unknown>;
    error?: { code: string; message: string };
  };
}

beforeAll(() => {
  prevState = process.env.INFINIBOT_STATE_DIR;
  fs.mkdirSync(stateDir, { recursive: true });
  process.env.INFINIBOT_STATE_DIR = stateDir;
});
afterAll(() => {
  if (prevState === undefined) delete process.env.INFINIBOT_STATE_DIR;
  else process.env.INFINIBOT_STATE_DIR = prevState;
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe("learn.guided RPCs", () => {
  it("catalog lists enabled-plugin tracks with quiz keys stripped", async () => {
    setActivePluginRegistry(registry(true));
    const res = await call("learn.guided.catalog");
    expect(res.ok).toBe(true);
    const tracks = res.payload.tracks as { id: string; pluginId?: string; quiz: object[] }[];
    const demo = tracks.find((t) => t.id === "demo");
    expect(demo?.pluginId).toBe("demo");
    expect(demo?.quiz.every((q) => !("answer" in q))).toBe(true);
    expect(tracks.filter((t) => !t.pluginId).length).toBe(CORE_TRACKS.length);
    expect(res.payload.plugins).toEqual([
      expect.objectContaining({ id: "demo", trackIds: ["demo"] }),
    ]);
  });

  it("hides a disabled plugin's tracks and refuses progress on them", async () => {
    setActivePluginRegistry(registry(false));
    const res = await call("learn.guided.catalog");
    expect((res.payload.tracks as { id: string }[]).some((t) => t.id === "demo")).toBe(false);
    const upd = await call("learn.guided.progress.update", {
      trackId: "demo",
      walkthroughId: "one",
      event: "complete",
    });
    expect(upd).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });

  it("records progress for the owner (no users) and grades the quiz on the server", async () => {
    setActivePluginRegistry(registry(true));
    expect(
      (
        await call("learn.guided.progress.update", {
          trackId: "demo",
          walkthroughId: "one",
          event: "step",
          stepId: "nope",
        })
      ).ok,
    ).toBe(false);
    const step = await call("learn.guided.progress.update", {
      trackId: "demo",
      walkthroughId: "one",
      event: "step",
      stepId: "a",
      done: true,
    });
    expect(step.ok).toBe(true);
    const done = await call("learn.guided.progress.update", {
      trackId: "demo",
      walkthroughId: "one",
      event: "complete",
    });
    expect(
      done.payload.progress as { userId: string; walkthroughs: Record<string, { status: string }> },
    ).toMatchObject({
      userId: "_owner",
      walkthroughs: { "demo/one": { status: "completed" } },
    });
    const fail = await call("learn.guided.quiz.submit", { trackId: "demo", answers: [0, 1] });
    expect(fail.payload).toMatchObject({ score: 0, passed: false });
    const pass = await call("learn.guided.quiz.submit", { trackId: "demo", answers: [1, 0] });
    expect(pass.payload).toMatchObject({ score: 2, total: 2, passed: true });
    const badges = pass.payload.badges as { trackId: string; mastery: boolean }[];
    expect(badges).toContainEqual(expect.objectContaining({ trackId: "demo", mastery: true }));
    // Same identity from a fresh read (another device / reconnect).
    const again = await call("learn.guided.progress.get");
    expect(
      (again.payload.progress as { quizzes: Record<string, { passed: boolean }> }).quizzes.demo
        ?.passed,
    ).toBe(true);
  });

  it("prefs are allow-listed and size-capped; certificates only when awarded", async () => {
    expect(
      (await call("learn.guided.prefs.set", { key: "missionsDismissed", value: true })).ok,
    ).toBe(true);
    expect((await call("learn.guided.prefs.set", { key: "evil", value: 1 })).ok).toBe(false);
    expect(
      (await call("learn.guided.prefs.set", { key: "touched", value: "x".repeat(9000) })).ok,
    ).toBe(false);
    const cert = await call("learn.guided.certificate", { tier: "master" });
    expect(cert).toMatchObject({ ok: false, error: { code: "NOT_AWARDED" } });
  });
});
