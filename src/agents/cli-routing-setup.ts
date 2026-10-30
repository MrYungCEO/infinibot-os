/**
 * Setup helpers for subscription CLI routing, shared by the gateway RPCs
 * (gateway/server-methods/cli-routing.ts) and the `infinibot onboard` wizard
 * (wizard/onboarding-subscription.ts): the config writer, the hosted-cloud
 * gate and the one-turn connection test.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { InfinibotConfig } from "../config/types.infinibot.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { runCliAgent } from "./cli-runner.js";
import {
  getCliProviderInfo,
  resolveCliRoutingAvailability,
  resolveCliRoutingModel,
} from "./cli-routing.js";
import { describeAgentTurnFailure } from "./turn-failure.js";

export type CliRoutingSetParams = {
  enabled?: unknown;
  providers?: unknown;
  models?: unknown;
  fallbackToApi?: unknown;
  tools?: unknown;
  allTraffic?: unknown;
  agentId?: unknown;
  agentEnabled?: unknown;
};

/** Apply a cliRouting.set request to a raw (file) config. Throws on bad input. */
export function applyCliRoutingSet(
  config: InfinibotConfig,
  p: CliRoutingSetParams,
): InfinibotConfig {
  const next: InfinibotConfig = { ...config };
  const routing = { ...next.cliRouting };
  if (p.enabled !== undefined) {
    if (typeof p.enabled !== "boolean") throw new Error("enabled must be a boolean");
    next.cliRoutingEnabled = p.enabled;
  }
  if (p.providers !== undefined) {
    if (!Array.isArray(p.providers)) throw new Error("providers must be an array");
    const ids = p.providers.map((v) => String(v).trim().toLowerCase()).filter(Boolean);
    const configured = Object.keys(next.agents?.defaults?.cliBackends ?? {}).map((k) =>
      k.toLowerCase(),
    );
    for (const id of ids) {
      if (!getCliProviderInfo(id) && !configured.includes(id)) {
        throw new Error(`Unknown CLI provider: ${id}`);
      }
    }
    routing.providers = [...new Set(ids)];
  }
  if (p.models !== undefined) {
    if (!p.models || typeof p.models !== "object" || Array.isArray(p.models)) {
      throw new Error("models must be an object");
    }
    const models = { ...routing.models };
    for (const [k, v] of Object.entries(p.models as Record<string, unknown>)) {
      const model = typeof v === "string" ? v.trim() : "";
      if (model) models[k] = model;
      else delete models[k];
    }
    routing.models = models;
  }
  if (p.fallbackToApi !== undefined) {
    if (typeof p.fallbackToApi !== "boolean") throw new Error("fallbackToApi must be a boolean");
    routing.fallbackToApi = p.fallbackToApi;
  }
  if (p.tools !== undefined) {
    if (typeof p.tools !== "boolean") throw new Error("tools must be a boolean");
    routing.tools = p.tools;
  }
  if (p.allTraffic !== undefined) {
    if (typeof p.allTraffic !== "boolean") throw new Error("allTraffic must be a boolean");
    routing.allTraffic = p.allTraffic;
  }
  if (Object.keys(routing).length) next.cliRouting = routing;
  if (p.agentId !== undefined) {
    const agentId = normalizeAgentId(String(p.agentId));
    const value = p.agentEnabled;
    if (value !== null && typeof value !== "boolean") {
      throw new Error("agentEnabled must be true, false or null");
    }
    const list = Array.isArray(next.agents?.list) ? [...next.agents.list] : [];
    const idx = list.findIndex((a) => a && normalizeAgentId(a.id) === agentId);
    if (idx < 0) {
      if (value === null) return next;
      list.push({ id: agentId, cliRouting: value });
    } else {
      const entry = { ...list[idx]! };
      if (value === null) delete entry.cliRouting;
      else entry.cliRouting = value;
      list[idx] = entry;
    }
    next.agents = { ...next.agents, list };
  }
  return next;
}

/**
 * Local installs and fleet tenant Machines (the workspace's own volume holds
 * the CLIs and their sign-ins); never a shared multi-tenant cloud gateway.
 */
export function cliRoutingAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveCliRoutingAvailability(env).available;
}

const CONNECT_TEST_PROMPT = "Reply with exactly one word: Ready";
const CONNECT_TIMEOUT_MS = 120_000;

/**
 * Prove a CLI answers before routing chats to it: one tiny turn, no tools,
 * no workspace files, nothing persisted. Returns the reply and timing.
 */
export async function testCliProvider(
  cfg: InfinibotConfig,
  provider: string,
  run: typeof runCliAgent = runCliAgent,
): Promise<
  { ok: true; reply: string; ms: number } | { ok: false; code: string; message: string; ms: number }
> {
  const started = Date.now();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "infinibot-cli-connect-"));
  try {
    const result = await run({
      sessionId: `cli-connect-${randomUUID()}`,
      sessionFile: path.join(dir, "session.jsonl"),
      workspaceDir: dir,
      config: { ...cfg, cliRouting: { ...cfg.cliRouting, tools: false } },
      prompt: CONNECT_TEST_PROMPT,
      provider,
      model: resolveCliRoutingModel(cfg, provider),
      timeoutMs: CONNECT_TIMEOUT_MS,
      runId: `cli-connect-${randomUUID()}`,
      recordTranscript: false,
    });
    const reply = result.payloads?.[0]?.text?.trim() ?? "";
    if (!reply) {
      return {
        ok: false,
        code: "subscription_failed",
        message: "It answered with nothing. Try again.",
        ms: Date.now() - started,
      };
    }
    return { ok: true, reply, ms: Date.now() - started };
  } catch (err) {
    const failure = describeAgentTurnFailure(err, { cfg });
    return {
      ok: false,
      code: failure.errorCode ?? "subscription_failed",
      message: failure.errorMessage,
      ms: Date.now() - started,
    };
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
