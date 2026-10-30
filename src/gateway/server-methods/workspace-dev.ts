import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { resolveStateDir } from "../../config/paths.js";
import { getDirectoryStore } from "../../directories/store.js";
import { getWorkspaceDevServerManager } from "../../workspace/dev-server-manager.js";
import {
  createWorkspaceVersion,
  diffWorkspaceVersion,
  listWorkspaceVersions,
  revertWorkspaceVersion,
} from "../../workspace/versions.js";
import {
  listWorkspaceTemplates,
  scaffoldWorkspaceTemplate,
  type WorkspaceTemplateId,
} from "../../workspace/templates.js";
import type { GatewayRequestHandlers } from "./types.js";

function localEntry(directoryId: unknown) {
  if (typeof directoryId !== "string" || !directoryId) throw new Error("directoryId is required");
  const entry = getDirectoryStore(resolveStateDir()).get(directoryId);
  if (!entry) throw new Error("Workspace directory was not found");
  if (entry.peerId) throw new Error("Workspace dev servers can only run for local directories");
  const resolved = path.resolve(entry.path);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory())
    throw new Error("Workspace directory does not exist on this host");
  return { ...entry, path: resolved };
}

function error(respond: Parameters<GatewayRequestHandlers[string]>[0]["respond"], err: unknown) {
  respond(false, undefined, {
    code: "WORKSPACE_DEV_ERROR",
    message: err instanceof Error ? err.message : String(err),
  });
}

function gitBranch(workdir: string): string | null {
  try {
    const value = execFileSync("git", ["branch", "--show-current"], {
      cwd: workdir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
    }).trim();
    return value || null;
  } catch {
    return null;
  }
}

export const workspaceDevHandlers: GatewayRequestHandlers = {
  "workspace.dev.detect": async ({ params, respond }) => {
    try {
      const entry = localEntry(params.directoryId);
      const detected = getWorkspaceDevServerManager().detect(
        entry.path,
        entry.id,
        typeof params.appPath === "string" ? params.appPath : undefined,
      );
      respond(true, { ...detected, gitBranch: gitBranch(detected.appPath ?? entry.path) });
    } catch (err) {
      error(respond, err);
    }
  },
  "workspace.dev.start": async ({ params, respond }) => {
    try {
      const entry = localEntry(params.directoryId);
      respond(
        true,
        await getWorkspaceDevServerManager().start({
          directoryId: entry.id,
          projectPath: entry.path,
          appPath: typeof params.appPath === "string" ? params.appPath : undefined,
          install: params.install === true,
          idleTimeoutMs:
            typeof params.idleTimeoutMs === "number" ? params.idleTimeoutMs : undefined,
        }),
      );
    } catch (err) {
      error(respond, err);
    }
  },
  "workspace.dev.stop": async ({ params, respond }) => {
    try {
      localEntry(params.directoryId);
      respond(true, await getWorkspaceDevServerManager().stop(params.directoryId as string));
    } catch (err) {
      error(respond, err);
    }
  },
  "workspace.dev.restart": async ({ params, respond }) => {
    try {
      const entry = localEntry(params.directoryId);
      respond(
        true,
        await getWorkspaceDevServerManager().restart({
          directoryId: entry.id,
          projectPath: entry.path,
          appPath: typeof params.appPath === "string" ? params.appPath : undefined,
          install: params.install === true,
        }),
      );
    } catch (err) {
      error(respond, err);
    }
  },
  "workspace.dev.status": async ({ params, respond }) => {
    try {
      localEntry(params.directoryId);
      const manager = getWorkspaceDevServerManager();
      await manager.reconcile();
      respond(true, manager.get(params.directoryId as string));
    } catch (err) {
      error(respond, err);
    }
  },
  "workspace.dev.list": async ({ respond }) => {
    try {
      const manager = getWorkspaceDevServerManager();
      await manager.reconcile();
      respond(true, { servers: manager.list() });
    } catch (err) {
      error(respond, err);
    }
  },
  "workspace.dev.stopAll": async ({ respond }) => {
    try {
      respond(true, { stopped: await getWorkspaceDevServerManager().stopAll() });
    } catch (err) {
      error(respond, err);
    }
  },
  "workspace.dev.logs": async ({ params, respond }) => {
    try {
      localEntry(params.directoryId);
      respond(
        true,
        getWorkspaceDevServerManager().logs(
          params.directoryId as string,
          typeof params.cursor === "number" ? params.cursor : 0,
        ),
      );
    } catch (err) {
      error(respond, err);
    }
  },
  "workspace.templates.list": async ({ respond }) =>
    respond(true, { templates: listWorkspaceTemplates() }),
  "workspace.templates.scaffold": async ({ params, respond }) => {
    try {
      const entry = localEntry(params.directoryId);
      respond(
        true,
        scaffoldWorkspaceTemplate(
          entry.path,
          params.templateId as WorkspaceTemplateId,
          params.overwrite === true,
        ),
      );
    } catch (err) {
      error(respond, err);
    }
  },
  "workspace.version.create": async ({ params, respond }) => {
    try {
      const entry = localEntry(params.directoryId);
      respond(
        true,
        createWorkspaceVersion(
          entry.path,
          entry.id,
          typeof params.description === "string" ? params.description : "Workspace checkpoint",
        ),
      );
    } catch (err) {
      error(respond, err);
    }
  },
  "workspace.version.list": async ({ params, respond }) => {
    try {
      const entry = localEntry(params.directoryId);
      respond(true, { versions: listWorkspaceVersions(entry.id) });
    } catch (err) {
      error(respond, err);
    }
  },
  "workspace.version.diff": async ({ params, respond }) => {
    try {
      const entry = localEntry(params.directoryId);
      respond(true, diffWorkspaceVersion(entry.path, entry.id, String(params.versionId ?? "")));
    } catch (err) {
      error(respond, err);
    }
  },
  "workspace.version.revert": async ({ params, respond }) => {
    try {
      const entry = localEntry(params.directoryId);
      respond(true, revertWorkspaceVersion(entry.path, entry.id, String(params.versionId ?? "")));
    } catch (err) {
      error(respond, err);
    }
  },
  "workspace.inspector.save": async ({ params, respond }) => {
    try {
      const entry = localEntry(params.directoryId);
      const raw = typeof params.dataUrl === "string" ? params.dataUrl : "";
      const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(raw);
      if (!match) throw new Error("A PNG data URL is required");
      const data = Buffer.from(match[1], "base64");
      if (data.length > 5 * 1024 * 1024) throw new Error("Inspector screenshot exceeds 5 MB");
      const dir = path.join(resolveStateDir(), "workspace-inspector", entry.id);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `selection-${Date.now()}.png`);
      fs.writeFileSync(file, data, { mode: 0o600 });
      respond(true, { path: file });
    } catch (err) {
      error(respond, err);
    }
  },
};
