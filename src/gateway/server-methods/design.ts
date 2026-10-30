/**
 * Design page — gateway RPCs.
 *
 * design.projects.list / get / create / update / delete
 * design.skills.list
 * design.designsystems.list
 * design.messages.list
 * design.messages.send             — kicks off claude_coder, returns runId
 * design.runtime.get               — UI polls this for "is the agent still working?"
 * design.artifacts.list / rescan
 * design.artifacts.setPreview      — manually pick the iframe target
 */

import { randomUUID } from "crypto";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";

import { ErrorCodes, errorShape } from "../protocol/index.js";
import { STATE_DIR } from "../../config/paths.js";
import type { GatewayRequestHandlers } from "./types.js";

import { getDesignStore } from "../../design/store.js";
import { listDesignSkills } from "../../design/skills-registry.js";
import { listDesignSystems } from "../../design/design-systems.js";
import { rescanArtifacts } from "../../design/artifacts.js";
import {
  resolve as resolvePath,
  join as joinPath,
  dirname as dirnameOf,
  sep as pathSep,
} from "node:path";
import { statSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { sendUserMessage, getRuntime } from "../../design/runner.js";
import { autoFillFromFolder } from "../../design/auto-fill.js";
import type { DesignProject, DesignBrief } from "../../design/types.js";

const DEFAULT_MODEL = "anthropic:claude-sonnet-4-6";

function projectWorkspaceDir(projectId: string): string {
  return join(STATE_DIR, "design-projects", projectId);
}

function ensureWorkspace(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function readBusinessId(params: unknown): string | null {
  const p = (params ?? {}) as Record<string, unknown>;
  if (typeof p.businessId === "string" && p.businessId) return p.businessId;
  // Fall back to business.json. Three steps:
  //   1. honor the user's explicit `activeBusinessId` if set,
  //   2. else pick the FIRST profile in `businesses[]`,
  //   3. else give up.
  // Without step 2 a user can create a business in the Business tab, see
  // it listed, but get "businessId required" here when nothing was ever
  // marked active.
  try {
    const fs = require("node:fs") as typeof import("node:fs");
    const pth = require("node:path") as typeof import("node:path");
    const file = pth.join(STATE_DIR, "business.json");
    if (!fs.existsSync(file)) return null;
    const data = JSON.parse(fs.readFileSync(file, "utf-8")) as {
      activeBusinessId?: string;
      businesses?: Array<{ id?: string }>;
    };
    if (data.activeBusinessId) return data.activeBusinessId;
    const first = data.businesses?.find((b) => typeof b.id === "string" && b.id);
    return first?.id ?? null;
  } catch {
    return null;
  }
}

export const designHandlers: GatewayRequestHandlers = {
  // ── Projects ───────────────────────────────────────────────

  "design.projects.list": async ({ params, respond }) => {
    try {
      const businessId = readBusinessId(params);
      if (!businessId) {
        respond(true, { projects: [] });
        return;
      }
      const store = getDesignStore(STATE_DIR);
      respond(true, { projects: store.listProjects(businessId), businessId });
    } catch (e) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, String(e)));
    }
  },

  "design.projects.get": async ({ params, respond }) => {
    try {
      const id = (params as { id?: string })?.id;
      if (!id) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "id required"));
        return;
      }
      const project = getDesignStore(STATE_DIR).getProject(id);
      if (!project) {
        respond(false, undefined, errorShape(ErrorCodes.NOT_FOUND, "Project not found"));
        return;
      }
      respond(true, { project, runtime: getRuntime(id) });
    } catch (e) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, String(e)));
    }
  },

  "design.projects.create": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as Record<string, unknown>;
      const businessId = readBusinessId(params);
      if (!businessId) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "businessId required (or set active business)"),
        );
        return;
      }
      const id = randomUUID();
      // Two creation modes:
      //   1. Fresh workspace under ${stateDir}/design-projects/<id>/ (default)
      //   2. Adopt an existing folder — Claude Coder spawns into the
      //      user's chosen dir, artifacts are indexed in place. Useful
      //      for picking up a half-done draft or operating on a real
      //      project tree.
      const requestedDir =
        typeof p.workspaceDir === "string" && p.workspaceDir.trim()
          ? resolvePath(p.workspaceDir.trim())
          : null;
      let workspaceDir: string;
      let adoptedExisting = false;
      if (requestedDir) {
        try {
          const stat = statSync(requestedDir);
          if (!stat.isDirectory()) {
            respond(
              false,
              undefined,
              errorShape(
                ErrorCodes.INVALID_REQUEST,
                `workspaceDir is not a directory: ${requestedDir}`,
              ),
            );
            return;
          }
        } catch {
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.INVALID_REQUEST, `workspaceDir not accessible: ${requestedDir}`),
          );
          return;
        }
        workspaceDir = requestedDir;
        adoptedExisting = true;
      } else {
        workspaceDir = projectWorkspaceDir(id);
        ensureWorkspace(workspaceDir);
      }
      const now = Date.now();
      const project: DesignProject = {
        id,
        businessId,
        name: typeof p.name === "string" && p.name ? p.name : "Untitled design",
        kind: (typeof p.kind === "string" ? p.kind : "prototype") as DesignProject["kind"],
        brief: (p.brief as DesignBrief) ?? null,
        activeSkillId: typeof p.activeSkillId === "string" ? p.activeSkillId : null,
        activeDesignSystemId:
          typeof p.activeDesignSystemId === "string" ? p.activeDesignSystemId : null,
        modelId: typeof p.modelId === "string" && p.modelId ? p.modelId : DEFAULT_MODEL,
        workspaceDir,
        lastActiveAt: now,
        createdAt: now,
        updatedAt: now,
      };
      const stored = getDesignStore(STATE_DIR).upsertProject(project);
      // When adopting an existing folder, scan it immediately so the
      // file list + iframe preview populate before the first send.
      let artifactCount = 0;
      if (adoptedExisting) {
        try {
          const arts = rescanArtifacts(STATE_DIR, stored.id, workspaceDir);
          artifactCount = arts.length;
        } catch (err) {
          console.warn(`[design] initial rescan on adopted folder failed: ${String(err)}`);
        }
      }
      respond(true, { project: stored, adoptedExisting, artifactCount });
    } catch (e) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, String(e)));
    }
  },

  "design.projects.update": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as Record<string, unknown>;
      const id = typeof p.id === "string" ? p.id : null;
      if (!id) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "id required"));
        return;
      }
      const store = getDesignStore(STATE_DIR);
      const existing = store.getProject(id);
      if (!existing) {
        respond(false, undefined, errorShape(ErrorCodes.NOT_FOUND, "Project not found"));
        return;
      }
      const merged: DesignProject = {
        ...existing,
        name: typeof p.name === "string" ? p.name : existing.name,
        kind: typeof p.kind === "string" ? (p.kind as DesignProject["kind"]) : existing.kind,
        brief: p.brief !== undefined ? (p.brief as DesignBrief | null) : existing.brief,
        activeSkillId:
          p.activeSkillId !== undefined
            ? (p.activeSkillId as string | null)
            : existing.activeSkillId,
        activeDesignSystemId:
          p.activeDesignSystemId !== undefined
            ? (p.activeDesignSystemId as string | null)
            : existing.activeDesignSystemId,
        modelId: typeof p.modelId === "string" ? p.modelId : existing.modelId,
      };
      const stored = store.upsertProject(merged);
      respond(true, { project: stored });
    } catch (e) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, String(e)));
    }
  },

  "design.projects.delete": async ({ params, respond }) => {
    try {
      const id = (params as { id?: string })?.id;
      if (!id) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "id required"));
        return;
      }
      // Drop the row; leave the workspace dir for forensics (user can delete manually).
      const ok = getDesignStore(STATE_DIR).deleteProject(id);
      respond(true, { deleted: ok });
    } catch (e) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, String(e)));
    }
  },

  // ── Skills / Systems ──────────────────────────────────────

  "design.skills.list": async ({ respond }) => {
    try {
      respond(true, { skills: listDesignSkills(STATE_DIR) });
    } catch (e) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, String(e)));
    }
  },

  "design.designsystems.list": async ({ respond }) => {
    try {
      respond(true, { systems: listDesignSystems(STATE_DIR) });
    } catch (e) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, String(e)));
    }
  },

  // ── Messages ──────────────────────────────────────────────

  "design.messages.list": async ({ params, respond }) => {
    try {
      const projectId = (params as { projectId?: string })?.projectId;
      if (!projectId) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "projectId required"));
        return;
      }
      respond(true, { messages: getDesignStore(STATE_DIR).listMessages(projectId) });
    } catch (e) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, String(e)));
    }
  },

  "design.messages.send": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as Record<string, unknown>;
      const projectId = typeof p.projectId === "string" ? p.projectId : null;
      const content = typeof p.content === "string" ? p.content : "";
      if (!projectId || !content.trim()) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "projectId and content required"),
        );
        return;
      }
      const project = getDesignStore(STATE_DIR).getProject(projectId);
      if (!project) {
        respond(false, undefined, errorShape(ErrorCodes.NOT_FOUND, "Project not found"));
        return;
      }
      const result = sendUserMessage({
        stateDir: STATE_DIR,
        project,
        userContent: content,
        modelOverride: typeof p.modelOverride === "string" ? p.modelOverride : undefined,
      });
      respond(true, {
        userMessage: result.userMessage,
        runId: result.runId,
        runtime: getRuntime(projectId),
      });
    } catch (e) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, String(e)));
    }
  },

  // ── Runtime ───────────────────────────────────────────────

  "design.runtime.get": async ({ params, respond }) => {
    try {
      const id = (params as { id?: string })?.id;
      if (!id) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "id required"));
        return;
      }
      respond(true, { runtime: getRuntime(id) });
    } catch (e) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, String(e)));
    }
  },

  // ── Artifacts ─────────────────────────────────────────────

  "design.artifacts.list": async ({ params, respond }) => {
    try {
      const projectId = (params as { projectId?: string })?.projectId;
      if (!projectId) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "projectId required"));
        return;
      }
      respond(true, { artifacts: getDesignStore(STATE_DIR).listArtifacts(projectId) });
    } catch (e) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, String(e)));
    }
  },

  "design.artifacts.rescan": async ({ params, respond }) => {
    try {
      const projectId = (params as { projectId?: string })?.projectId;
      if (!projectId) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "projectId required"));
        return;
      }
      const project = getDesignStore(STATE_DIR).getProject(projectId);
      if (!project) {
        respond(false, undefined, errorShape(ErrorCodes.NOT_FOUND, "Project not found"));
        return;
      }
      const artifacts = rescanArtifacts(STATE_DIR, projectId, project.workspaceDir);
      respond(true, { artifacts });
    } catch (e) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, String(e)));
    }
  },

  // ── Filesystem navigator (browser folder picker) ────────
  //
  // Read-only directory listing for the in-modal folder picker. Returns
  // only subdirectories — files are filtered out so the picker stays
  // focused on "pick a folder". Hidden entries (".git", "node_modules",
  // dotfiles) hide by default; pass showHidden=true to override.
  //
  // Path normalization: empty path → user home; `~` expands; relative
  // paths resolve against home. The response carries the canonical
  // absolute path so the client doesn't have to do its own resolution.
  "design.fs.listDir": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as Record<string, unknown>;
      const showHidden = p.showHidden === true;
      let raw = typeof p.path === "string" ? p.path.trim() : "";
      if (!raw || raw === "~") raw = homedir();
      else if (raw.startsWith("~/") || raw.startsWith("~\\")) {
        raw = joinPath(homedir(), raw.slice(2));
      }
      const abs = resolvePath(raw);
      let stat;
      try {
        stat = statSync(abs);
      } catch {
        respond(false, undefined, errorShape(ErrorCodes.NOT_FOUND, `path not accessible: ${abs}`));
        return;
      }
      if (!stat.isDirectory()) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `not a directory: ${abs}`),
        );
        return;
      }
      const entries: Array<{ name: string; path: string; hidden: boolean }> = [];
      try {
        const items = readdirSync(abs, { withFileTypes: true });
        for (const e of items) {
          if (!e.isDirectory()) continue;
          const hidden = e.name.startsWith(".") || e.name === "node_modules";
          if (hidden && !showHidden) continue;
          entries.push({ name: e.name, path: joinPath(abs, e.name), hidden });
          if (entries.length >= 400) break;
        }
      } catch (err) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INTERNAL_ERROR, `cannot read ${abs}: ${String(err)}`),
        );
        return;
      }
      entries.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
      // Build a breadcrumb chain back to the platform root.
      const parts: Array<{ label: string; path: string }> = [];
      let cur = abs;
      for (let i = 0; i < 40; i++) {
        const parent = dirnameOf(cur);
        const label = cur.split(pathSep).filter(Boolean).pop() ?? (cur === pathSep ? "/" : cur);
        parts.unshift({ label, path: cur });
        if (parent === cur) break;
        cur = parent;
      }
      respond(true, {
        path: abs,
        parent: dirnameOf(abs),
        atRoot: dirnameOf(abs) === abs,
        home: homedir(),
        breadcrumb: parts,
        entries,
      });
    } catch (e) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INTERNAL_ERROR, e instanceof Error ? e.message : String(e)),
      );
    }
  },

  // ── Auto-fill from folder (load-mode helper) ────────────

  "design.autoFill": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as Record<string, unknown>;
      const folder = typeof p.workspaceDir === "string" ? p.workspaceDir.trim() : "";
      const model = typeof p.modelId === "string" && p.modelId ? p.modelId : DEFAULT_MODEL;
      if (!folder) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "workspaceDir required"));
        return;
      }
      const result = await autoFillFromFolder(STATE_DIR, folder, model);
      respond(true, result);
    } catch (e) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INTERNAL_ERROR, e instanceof Error ? e.message : String(e)),
      );
    }
  },

  "design.artifacts.setPreview": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as Record<string, unknown>;
      const projectId = typeof p.projectId === "string" ? p.projectId : null;
      const artifactId = typeof p.artifactId === "string" ? p.artifactId : null;
      if (!projectId || !artifactId) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "projectId + artifactId required"),
        );
        return;
      }
      getDesignStore(STATE_DIR).setPreviewArtifact(projectId, artifactId);
      respond(true, { ok: true });
    } catch (e) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, String(e)));
    }
  },
};
