/**
 * Periodic reconciliation of locally-recorded spend against provider
 * billing APIs. The actual provider API integrations are stubs — see
 * the per-provider sections for what is wired vs. left as TODO. The
 * dispatcher and cursor/state machinery is complete so adding a real
 * fetch only requires filling in the body.
 */

import { createSubsystemLogger } from "../logging/subsystem.js";
import { getCreditStore } from "./store.js";
import type { ProviderSyncCursor } from "./types.js";

const log = createSubsystemLogger("credits");

export type SyncableProvider = "anthropic" | "openai" | "google" | "opencode" | "ollama-cloud";

const SUPPORTED: SyncableProvider[] = ["anthropic", "openai", "google", "opencode", "ollama-cloud"];

export interface SyncResult {
  provider: SyncableProvider;
  status: ProviderSyncCursor["status"];
  reconciledTotalUsd?: number;
  localTotalUsd?: number;
  deltaUsd?: number;
  message?: string;
}

export async function syncProvider(provider: SyncableProvider): Promise<SyncResult> {
  const result = await runProviderSync(provider);
  const store = getCreditStore();
  store.upsertSyncCursor({
    provider,
    lastSyncAt: Date.now(),
    lastReconciledTotalUsd: result.reconciledTotalUsd,
    status: result.status,
    message: result.message,
  });
  return result;
}

export async function syncAll(): Promise<SyncResult[]> {
  const out: SyncResult[] = [];
  for (const p of SUPPORTED) {
    try {
      out.push(await syncProvider(p));
    } catch (e) {
      log.warn("sync-failed", { provider: p, err: String(e) });
      out.push({ provider: p, status: "error", message: String(e) });
    }
  }
  return out;
}

export function listProviderCursors(): ProviderSyncCursor[] {
  const cursors = getCreditStore().listSyncCursors();
  const have = new Set(cursors.map((c) => c.provider));
  for (const p of SUPPORTED) {
    if (!have.has(p)) {
      cursors.push({ provider: p, status: detectProviderStatus(p), message: undefined });
    }
  }
  return cursors;
}

function localTotalForProvider(provider: string, sinceTs: number): number {
  const store = getCreditStore();
  const row = store.db
    .prepare(
      `SELECT COALESCE(SUM(cost_usd),0) AS total FROM credit_entries WHERE provider = ? AND timestamp >= ?`,
    )
    .get(provider, sinceTs) as { total: number };
  return Number(row?.total ?? 0);
}

function monthStartTs(): number {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).getTime();
}

function detectProviderStatus(provider: SyncableProvider): ProviderSyncCursor["status"] {
  switch (provider) {
    case "anthropic":
      return process.env.ANTHROPIC_ADMIN_API_KEY ? "configured" : "missing-credentials";
    case "openai":
      return process.env.OPENAI_ADMIN_KEY ? "configured" : "missing-credentials";
    case "google":
      return process.env.GOOGLE_CLOUD_BILLING_KEY ? "configured" : "missing-credentials";
    case "opencode":
      return process.env.OPENCODE_ZEN_API_KEY ? "configured" : "missing-credentials";
    case "ollama-cloud":
      return process.env.OLLAMA_CLOUD_API_KEY ? "configured" : "missing-credentials";
    default:
      return "unsupported";
  }
}

async function runProviderSync(provider: SyncableProvider): Promise<SyncResult> {
  const status = detectProviderStatus(provider);
  if (status !== "configured") {
    return {
      provider,
      status,
      message: `No credentials configured for ${provider}. Set the relevant *_ADMIN_API_KEY env var to enable reconciliation.`,
    };
  }
  const localTotal = localTotalForProvider(provider, monthStartTs());

  // Each provider's admin API call lives here. Currently stubs that report
  // the local total back so the UI shows a "we don't know yet" delta.
  switch (provider) {
    case "anthropic":
      // TODO: GET https://api.anthropic.com/v1/organizations/usage_report
      // with ANTHROPIC_ADMIN_API_KEY — parse `cost.total_usd` per workspace.
      return {
        provider,
        status: "ok",
        localTotalUsd: localTotal,
        message: "Anthropic admin-usage fetch not yet implemented; local-only total reported.",
      };
    case "openai":
      // TODO: GET https://api.openai.com/v1/organization/usage with OPENAI_ADMIN_KEY.
      return {
        provider,
        status: "ok",
        localTotalUsd: localTotal,
        message: "OpenAI admin-usage fetch not yet implemented; local-only total reported.",
      };
    case "google":
      // TODO: Cloud Billing API — Gemini usage is reported as part of Vertex.
      return {
        provider,
        status: "ok",
        localTotalUsd: localTotal,
        message: "Google billing fetch not yet implemented; local-only total reported.",
      };
    case "opencode":
      // TODO: hit opencode-zen account endpoint once we have one.
      return {
        provider,
        status: "ok",
        localTotalUsd: localTotal,
        message: "OpenCode usage fetch not yet implemented; local-only total reported.",
      };
    case "ollama-cloud":
      return {
        provider,
        status: "ok",
        localTotalUsd: localTotal,
        message: "Ollama Cloud usage fetch not yet implemented; local-only total reported.",
      };
  }
}
