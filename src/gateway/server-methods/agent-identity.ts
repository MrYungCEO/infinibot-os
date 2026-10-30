/**
 * agent.identity.* — Read/write per-agent identity files (SOUL.md, MEMORY.md,
 * USER.md, AGENTS.md, IDENTITY.md, TOOLS.md, HEARTBEAT.md) so the control UI
 * can manage them and import bundles from other moltbot/infinibot systems.
 *
 * Files live under each agent's workspace directory, resolved via
 * resolveAgentWorkspaceDir(). The file allowlist mirrors federation/identity-sync
 * so anything you edit here will auto-sync to satellites if federation is on.
 */

import { readFile, writeFile, mkdir, stat, unlink, copyFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { loadConfig } from "../../config/config.js";
import {
  listAgentIds,
  resolveAgentConfig,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../../agents/agent-scope.js";
import { IDENTITY_FILES } from "../../federation/identity-sync.js";
import { getFederationSatellite } from "../../federation/index.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

const ALLOWED_FILES = new Set<string>(IDENTITY_FILES);

/**
 * Files the operator UI may READ but never WRITE or DELETE. SOUL.md is the
 * agent's own self-defining document — operators editing it from the
 * outside short-circuits the agent's sovereignty over its own values.
 * The agent itself (and federation/identity-sync from a master node) can
 * still write the file via the underlying filesystem; this guard only
 * applies to the agent.identity.files.write/delete RPCs that the WebUI
 * uses. Reads stay open so the operator can review what the agent is
 * carrying.
 */
const READ_ONLY_FROM_UI = new Set<string>(["SOUL.md"]);

function isReadOnlyFromUi(filename: string): boolean {
  return READ_ONLY_FROM_UI.has(filename);
}

/**
 * Resolve a target path under the agent's workspace, ensuring the result stays
 * inside the workspace and that the filename is in the identity allowlist.
 * Returns null if the input is unsafe.
 */
function safeIdentityPath(workspace: string, filename: string): string | null {
  if (typeof filename !== "string" || filename.length === 0) return null;
  if (!ALLOWED_FILES.has(filename)) return null;
  const target = resolve(workspace, filename);
  const root = resolve(workspace) + sep;
  if (!(target + sep).startsWith(root)) return null;
  return target;
}

interface FileMeta {
  filename: string;
  exists: boolean;
  size: number;
  modified: number; // epoch ms
}

async function statFile(workspace: string, filename: string): Promise<FileMeta> {
  try {
    const s = await stat(join(workspace, filename));
    return { filename, exists: true, size: s.size, modified: s.mtimeMs };
  } catch {
    return { filename, exists: false, size: 0, modified: 0 };
  }
}

async function readFileSafe(workspace: string, filename: string): Promise<string | null> {
  try {
    return await readFile(join(workspace, filename), "utf-8");
  } catch {
    return null;
  }
}

export const agentIdentityHandlers: GatewayRequestHandlers = {
  /**
   * List configured agents with their workspace path and a count of identity
   * files present on disk. Used to populate the agent picker in the UI.
   */
  "agent.identity.agents.list": async ({ respond }) => {
    try {
      const cfg = loadConfig();
      const ids = listAgentIds(cfg);
      const defaultId = resolveDefaultAgentId(cfg);
      const agents = await Promise.all(
        ids.map(async (id) => {
          const cfgEntry = resolveAgentConfig(cfg, id);
          const workspace = resolveAgentWorkspaceDir(cfg, id);
          const present = await Promise.all(IDENTITY_FILES.map((f) => statFile(workspace, f)));
          return {
            id,
            name: cfgEntry?.name || id,
            workspace,
            isDefault: id === defaultId,
            filesPresent: present.filter((f) => f.exists).length,
            filesTotal: IDENTITY_FILES.length,
          };
        }),
      );
      respond(true, { agents, defaultAgentId: defaultId });
    } catch (e) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, (e as Error).message));
    }
  },

  /**
   * List identity files for one agent with metadata. Returns one entry per
   * filename in IDENTITY_FILES so the UI can render the full set even when a
   * file is missing on disk (lets the user create it via write).
   */
  "agent.identity.files.list": async ({ params, respond }) => {
    try {
      const p = params as { agentId?: string };
      const cfg = loadConfig();
      const agentId = (p.agentId || resolveDefaultAgentId(cfg)).trim();
      const workspace = resolveAgentWorkspaceDir(cfg, agentId);
      const files = await Promise.all(
        IDENTITY_FILES.map(async (f) => ({
          ...(await statFile(workspace, f)),
          readOnly: isReadOnlyFromUi(f),
        })),
      );
      respond(true, { agentId, workspace, files });
    } catch (e) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, (e as Error).message));
    }
  },

  /**
   * Read a single identity file's contents. Returns null content when the
   * file does not exist so the UI can show an "empty" editor instead of an
   * error.
   */
  "agent.identity.files.read": async ({ params, respond }) => {
    try {
      const p = params as { agentId?: string; filename?: string };
      const cfg = loadConfig();
      const agentId = (p.agentId || resolveDefaultAgentId(cfg)).trim();
      const workspace = resolveAgentWorkspaceDir(cfg, agentId);
      const target = safeIdentityPath(workspace, p.filename || "");
      if (!target) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `invalid filename: ${p.filename}`),
        );
        return;
      }
      const content = await readFileSafe(workspace, p.filename!);
      const meta = await statFile(workspace, p.filename!);
      respond(true, { agentId, content, ...meta });
    } catch (e) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, (e as Error).message));
    }
  },

  /**
   * Write a single identity file. When `backup` is true and the file already
   * exists, the previous version is copied to <filename>.bak before overwrite.
   * The mode controls how the new content is combined with what's there:
   *   replace — overwrite verbatim
   *   append  — append to end (with leading newline if needed)
   */
  "agent.identity.files.write": async ({ params, respond }) => {
    try {
      const p = params as {
        agentId?: string;
        filename?: string;
        content?: string;
        mode?: "replace" | "append";
        backup?: boolean;
      };
      if (typeof p.content !== "string") {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "content must be a string"),
        );
        return;
      }
      const cfg = loadConfig();
      const agentId = (p.agentId || resolveDefaultAgentId(cfg)).trim();
      const workspace = resolveAgentWorkspaceDir(cfg, agentId);
      const target = safeIdentityPath(workspace, p.filename || "");
      if (!target) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `invalid filename: ${p.filename}`),
        );
        return;
      }
      if (isReadOnlyFromUi(p.filename!)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `${p.filename} is read-only from the operator UI to preserve agent sovereignty over its own self-definition. The agent itself (and federation sync from a master node) can still rewrite it.`,
          ),
        );
        return;
      }

      await mkdir(workspace, { recursive: true });

      const existing = await readFileSafe(workspace, p.filename!);
      if (p.backup && existing != null) {
        try {
          await copyFile(target, target + ".bak");
        } catch {
          // best effort
        }
      }

      let next = p.content;
      if (p.mode === "append" && existing != null && existing.length > 0) {
        const joiner = existing.endsWith("\n") ? "" : "\n";
        next = existing + joiner + p.content;
      }

      await writeFile(target, next, "utf-8");
      const meta = await statFile(workspace, p.filename!);
      respond(true, { agentId, ...meta });
    } catch (e) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, (e as Error).message));
    }
  },

  /**
   * Delete an identity file. Optional `backup` keeps a .bak copy before unlink.
   */
  "agent.identity.files.delete": async ({ params, respond }) => {
    try {
      const p = params as { agentId?: string; filename?: string; backup?: boolean };
      const cfg = loadConfig();
      const agentId = (p.agentId || resolveDefaultAgentId(cfg)).trim();
      const workspace = resolveAgentWorkspaceDir(cfg, agentId);
      const target = safeIdentityPath(workspace, p.filename || "");
      if (!target) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `invalid filename: ${p.filename}`),
        );
        return;
      }
      if (isReadOnlyFromUi(p.filename!)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `${p.filename} is read-only from the operator UI. Delete it from the agent itself if you really want to wipe the agent's self-definition.`,
          ),
        );
        return;
      }
      if (p.backup) {
        try {
          await copyFile(target, target + ".bak");
        } catch {}
      }
      try {
        await unlink(target);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      respond(true, { agentId, filename: p.filename, deleted: true });
    } catch (e) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, (e as Error).message));
    }
  },

  /**
   * Export all identity files for an agent as a single JSON bundle. The shape
   * is { agentId, exportedAt, files: { filename: content } } — symmetric with
   * what the import handler accepts.
   */
  "agent.identity.bundle.export": async ({ params, respond }) => {
    try {
      const p = params as { agentId?: string };
      const cfg = loadConfig();
      const agentId = (p.agentId || resolveDefaultAgentId(cfg)).trim();
      const workspace = resolveAgentWorkspaceDir(cfg, agentId);
      const files: Record<string, string> = {};
      for (const filename of IDENTITY_FILES) {
        const content = await readFileSafe(workspace, filename);
        if (content != null) files[filename] = content;
      }
      respond(true, {
        agentId,
        workspace,
        exportedAt: Date.now(),
        version: 1,
        files,
      });
    } catch (e) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, (e as Error).message));
    }
  },

  /**
   * Import a bundle. `actions` is a per-file map deciding what to do with each
   * incoming filename: "replace" | "skip" | "append". Files not in the
   * IDENTITY_FILES allowlist are dropped. Returns a per-file result so the UI
   * can render success/failure for each entry.
   *
   * When `autoBackup` is true, every file that gets replaced or appended-to
   * has its previous content copied to <filename>.bak first.
   */
  "agent.identity.bundle.import": async ({ params, respond }) => {
    try {
      const p = params as {
        agentId?: string;
        files?: Record<string, string>;
        actions?: Record<string, "replace" | "skip" | "append">;
        autoBackup?: boolean;
      };
      if (!p.files || typeof p.files !== "object") {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "files object required"));
        return;
      }
      const cfg = loadConfig();
      const agentId = (p.agentId || resolveDefaultAgentId(cfg)).trim();
      const workspace = resolveAgentWorkspaceDir(cfg, agentId);
      await mkdir(workspace, { recursive: true });

      const actions = p.actions || {};
      const autoBackup = p.autoBackup ?? true;
      const results: Array<{
        filename: string;
        status: "written" | "skipped" | "rejected" | "error";
        error?: string;
        bytes?: number;
      }> = [];

      for (const [filename, content] of Object.entries(p.files)) {
        if (!ALLOWED_FILES.has(filename)) {
          results.push({ filename, status: "rejected", error: "not an identity file" });
          continue;
        }
        if (typeof content !== "string") {
          results.push({ filename, status: "rejected", error: "content must be a string" });
          continue;
        }
        const action = actions[filename] || "replace";
        if (action === "skip") {
          results.push({ filename, status: "skipped" });
          continue;
        }
        const target = safeIdentityPath(workspace, filename);
        if (!target) {
          results.push({ filename, status: "rejected", error: "unsafe path" });
          continue;
        }
        try {
          const existing = await readFileSafe(workspace, filename);
          if (autoBackup && existing != null) {
            try {
              await copyFile(target, target + ".bak");
            } catch {}
          }
          let next = content;
          if (action === "append" && existing != null && existing.length > 0) {
            const joiner = existing.endsWith("\n") ? "" : "\n";
            next = existing + joiner + content;
          }
          await writeFile(target, next, "utf-8");
          results.push({ filename, status: "written", bytes: Buffer.byteLength(next, "utf-8") });
        } catch (err) {
          results.push({ filename, status: "error", error: (err as Error).message });
        }
      }

      respond(true, { agentId, workspace, results, importedAt: Date.now() });
    } catch (e) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, (e as Error).message));
    }
  },

  /**
   * In federation satellite mode, ask the master to push a fresh identity
   * sync. The actual file write happens through the existing identity-sync
   * channel, so this is a fire-and-forget trigger; the UI should refresh the
   * file list shortly after.
   *
   * When `peerUrl` is supplied, this method instead instructs the caller to
   * pull from that arbitrary gateway URL — that flow is implemented entirely
   * in the UI client (it opens a transient WebSocket and calls
   * agent.identity.bundle.export there), so we just echo the URL back.
   */
  "agent.identity.federation.pull": async ({ params, respond }) => {
    try {
      const p = params as { peerUrl?: string };
      const cfg = loadConfig();
      const mode = cfg.federation?.mode ?? "standalone";

      if (p.peerUrl && p.peerUrl.trim()) {
        respond(true, {
          mode,
          delegateToClient: true,
          peerUrl: p.peerUrl.trim(),
          message: "Open a client connection to peerUrl and call agent.identity.bundle.export.",
        });
        return;
      }

      if (mode === "master") {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "this gateway is the federation master — there's nothing to pull from",
          ),
        );
        return;
      }

      if (mode !== "satellite") {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "federation is not enabled — set federation.mode to 'satellite' or pass peerUrl",
          ),
        );
        return;
      }

      // Send a `identity.sync.request` to the master. The master responds
      // by pushing a fresh `identity.sync` payload through the existing
      // channel, which writes the files to this satellite's workspace via
      // IdentitySyncManager.handleIdentitySync. We don't await the
      // round-trip here; the UI refreshes the file list after a short delay.
      const satellite = getFederationSatellite();
      if (!satellite) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INTERNAL_ERROR,
            "satellite mode is configured but no FederationSatellite instance is running",
          ),
        );
        return;
      }
      const queued = await satellite.requestIdentitySync();
      if (!queued) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INTERNAL_ERROR,
            "could not send request — satellite is not currently connected to master",
          ),
        );
        return;
      }
      respond(true, {
        mode,
        delegateToClient: false,
        requested: true,
        message: "Identity sync requested from master. Refresh the file list in a moment.",
        masterUrl: cfg.federation?.masterUrl ?? null,
      });
    } catch (e) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, (e as Error).message));
    }
  },
};
