// Shared helper: keep a project row's "Project directory" file-link in sync
// with its `projectDirectory` field. Called from both the kanban MCP tool
// (src/agents/tools/kanban-tool.ts) and the gateway server method
// (src/gateway/server-methods/kanban.ts) so every code path that sets a
// project directory results in a clickable link on the project row.

import { getDatabasesStore } from "./store.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("project-directory-link");

export function ensureProjectDirectoryLink(
  projectId: string,
  directory: string | null | undefined,
): void {
  const dir = (directory || "").trim();
  if (!dir) return;
  try {
    const dbStore = getDatabasesStore();
    const existing = dbStore.listLinksForRow(projectId);
    if (existing.some((l) => l.targetKind === "file" && l.targetId === dir)) return;
    dbStore.linkRow({
      rowId: projectId,
      targetKind: "file",
      targetId: dir,
      label: "Project directory",
    });
    log.info("Linked project to local directory", { projectId, directory: dir });
  } catch (err: any) {
    log.warn("Failed to link project directory (continuing)", {
      projectId,
      directory: dir,
      error: err?.message,
    });
  }
}
