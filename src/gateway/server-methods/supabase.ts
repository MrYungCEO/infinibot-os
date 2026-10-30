/**
 * Supabase MCP gateway handlers.
 *
 * Manages the Supabase entry in ~/.infinibot/mcp-servers.json so the hosted
 * Supabase MCP (https://mcp.supabase.com/mcp) is automatically discoverable
 * by claude-coder spawns and the MCP bridge.
 *
 * PAT is stored in the auth-profile store (same as Canva tokens); the resolved
 * value is also written into the mcp-servers.json headers so the bridge can
 * pass it through verbatim to the HTTP MCP server.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { GatewayRequestHandlers, GatewayRequestHandlerOptions } from "./types.js";
import {
  ensureAuthProfileStore,
  loadAuthProfileStore,
  saveAuthProfileStore,
} from "../../agents/auth-profiles.js";
import {
  exportAuthProfilesToEnv,
  clearAuthProfileEnv,
} from "../../agents/auth-profiles/env-export.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("supabase-mcp");

// ── Paths ─────────────────────────────────────────────────────

function resolveStateDir(): string {
  return process.env.INFINIBOT_STATE_DIR
    ? resolve(process.env.INFINIBOT_STATE_DIR)
    : join(homedir(), ".infinibot");
}

function mcpServersPath(): string {
  return join(resolveStateDir(), "mcp-servers.json");
}

// ── mcp-servers.json helpers ──────────────────────────────────

interface McpServersFile {
  mcpServers?: Record<string, unknown>;
}

function readMcpServersFile(): McpServersFile {
  const path = mcpServersPath();
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeMcpServersFile(data: McpServersFile): void {
  const path = mcpServersPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf8");
}

function buildSupabaseEntry(pat: string, projectRef?: string, readOnly?: boolean): object {
  const params = new URLSearchParams();
  if (projectRef?.trim()) params.set("project_ref", projectRef.trim());
  if (readOnly) params.set("read_only", "true");
  const qs = params.toString();
  const url = `https://mcp.supabase.com/mcp${qs ? `?${qs}` : ""}`;
  return {
    type: "http",
    url,
    headers: { Authorization: `Bearer ${pat}` },
    description: "Supabase — list tables, execute SQL, apply migrations, fetch logs",
  };
}

function upsertSupabaseEntry(pat: string, projectRef?: string, readOnly?: boolean): void {
  const file = readMcpServersFile();
  file.mcpServers = file.mcpServers ?? {};
  file.mcpServers["supabase"] = buildSupabaseEntry(pat, projectRef, readOnly);
  writeMcpServersFile(file);
  log.info("wrote supabase entry to mcp-servers.json");
}

function removeSupabaseEntry(): void {
  const file = readMcpServersFile();
  if (!file.mcpServers?.["supabase"]) return;
  delete file.mcpServers["supabase"];
  writeMcpServersFile(file);
  log.info("removed supabase entry from mcp-servers.json");
}

function readSupabaseEntry(): { projectRef?: string; readOnly?: boolean } | null {
  const file = readMcpServersFile();
  const entry = file.mcpServers?.["supabase"] as any;
  if (!entry?.url) return null;
  try {
    const urlObj = new URL(entry.url);
    return {
      projectRef: urlObj.searchParams.get("project_ref") ?? undefined,
      readOnly: urlObj.searchParams.get("read_only") === "true",
    };
  } catch {
    return {};
  }
}

function maskToken(t: string): string {
  if (!t || t.length < 8) return "••••••••";
  return t.slice(0, 6) + "••••" + t.slice(-4);
}

// ── Handlers ──────────────────────────────────────────────────

/** Load current Supabase MCP state (profile + mcp-servers.json). */
async function handleSupabaseMcpLoad(opts: GatewayRequestHandlerOptions): Promise<void> {
  const { respond } = opts;
  try {
    const store = loadAuthProfileStore();
    const cred = store.profiles["supabase:default"] as any;
    const mcpEntry = readSupabaseEntry();
    const connected = !!(cred?.key || cred?.token) && !!mcpEntry;

    respond(true, {
      connected,
      profileId: connected ? "supabase:default" : null,
      maskedPat: cred?.key ? maskToken(cred.key) : cred?.token ? maskToken(cred.token) : null,
      projectRef: mcpEntry?.projectRef ?? null,
      readOnly: mcpEntry?.readOnly ?? false,
      mcpRegistered: !!mcpEntry,
    });
  } catch (err) {
    respond(false, undefined, {
      code: "INTERNAL_ERROR",
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Save PAT + project_ref + read_only. Writes to both auth-store and mcp-servers.json. */
async function handleSupabaseMcpSave(opts: GatewayRequestHandlerOptions): Promise<void> {
  const { params, respond } = opts;
  const pat = (params.pat as string)?.trim();
  const projectRef = (params.projectRef as string | undefined)?.trim() || undefined;
  const readOnly = params.readOnly === true;

  if (!pat) {
    respond(false, undefined, { code: "INVALID_REQUEST", message: "pat is required" });
    return;
  }

  try {
    // 1. Persist PAT to auth-profile store
    const store = ensureAuthProfileStore();
    store.profiles["supabase:default"] = {
      type: "api_key",
      provider: "supabase",
      key: pat,
    };
    saveAuthProfileStore(store);
    exportAuthProfilesToEnv(store, { overwrite: true });

    // 2. Write entry to mcp-servers.json
    upsertSupabaseEntry(pat, projectRef, readOnly);

    respond(true, {
      profileId: "supabase:default",
      maskedPat: maskToken(pat),
      projectRef: projectRef ?? null,
      readOnly,
    });
  } catch (err) {
    respond(false, undefined, {
      code: "INTERNAL_ERROR",
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Remove Supabase MCP config and auth profile. */
async function handleSupabaseMcpDisconnect(opts: GatewayRequestHandlerOptions): Promise<void> {
  const { respond } = opts;
  try {
    const store = ensureAuthProfileStore();
    delete store.profiles["supabase:default"];
    saveAuthProfileStore(store);
    clearAuthProfileEnv("supabase", store);
    removeSupabaseEntry();

    respond(true, { disconnected: true });
  } catch (err) {
    respond(false, undefined, {
      code: "INTERNAL_ERROR",
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Test the stored PAT by listing Supabase projects via the Management API. */
async function handleSupabaseMcpTest(opts: GatewayRequestHandlerOptions): Promise<void> {
  const { respond } = opts;
  try {
    const store = loadAuthProfileStore();
    const cred = store.profiles["supabase:default"] as any;
    const pat = cred?.key || cred?.token;

    if (!pat) {
      respond(true, { valid: false, message: "No PAT found — save credentials first." });
      return;
    }

    const r = await fetch("https://api.supabase.com/v1/projects", {
      headers: { Authorization: `Bearer ${pat}` },
    });

    if (r.ok) {
      const projects = (await r.json()) as Array<{ id: string; name: string; region: string }>;
      const mcpEntry = readSupabaseEntry();
      const scopedRef = mcpEntry?.projectRef;
      const activeProject = scopedRef ? projects.find((p) => p.id === scopedRef) : projects[0];
      respond(true, {
        valid: true,
        message: `Connected · ${projects.length} project${projects.length !== 1 ? "s" : ""}`,
        projectCount: projects.length,
        projectName: activeProject?.name ?? null,
        projectRef: activeProject?.id ?? null,
        projects: projects.slice(0, 5).map((p) => ({ id: p.id, name: p.name, region: p.region })),
      });
    } else {
      const text = await r.text().catch(() => "");
      respond(true, {
        valid: false,
        message: `Supabase API returned HTTP ${r.status}${text ? `: ${text.slice(0, 120)}` : ""}`,
      });
    }
  } catch (err) {
    respond(true, {
      valid: false,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

export const supabaseHandlers: GatewayRequestHandlers = {
  "supabase.mcp.load": handleSupabaseMcpLoad,
  "supabase.mcp.save": handleSupabaseMcpSave,
  "supabase.mcp.disconnect": handleSupabaseMcpDisconnect,
  "supabase.mcp.test": handleSupabaseMcpTest,
};
