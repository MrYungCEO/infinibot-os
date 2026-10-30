/**
 * Regression: project attachments vanished on a federation satellite.
 *
 * `kanban.projects.content.uploadAttachment` writes the file bytes, the
 * converted markdown, and the DB row into THIS node's state dir — but
 * `kanban.projects.content.get` used to be blanket-proxied to master, which
 * knows nothing about them. The row was in the local DB and the file was on
 * local disk, yet the Files tab always rendered empty.
 *
 * These cases pin the split: notes/badges come from master, attachments are
 * always served locally.
 */

import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

// The satellite context is the thing under test — drive it directly.
const satelliteState = { connected: false, masterContent: {} as Record<string, unknown> };

vi.mock("../../federation/satellite-context.js", () => ({
  getConnectedSatellite: () => (satelliteState.connected ? ({} as never) : null),
  proxyToMaster: async (_method: string, _params: Record<string, unknown>) => ({
    success: true,
    data: satelliteState.masterContent,
  }),
  proxyMethodsToMaster: (handlers: unknown) => handlers,
}));

let stateDir: string;

vi.mock("../../config/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/paths.js")>();
  return { ...actual, resolveStateDir: () => stateDir };
});

const PROJECT_ID = "proj-satellite-files";

async function loadHandlers() {
  const mod = await import("./kanban.js");
  return mod.kanbanHandlers;
}

/** Invoke a handler and resolve with its `respond(...)` payload. */
function call(
  handlers: Awaited<ReturnType<typeof loadHandlers>>,
  method: string,
  params: Record<string, unknown>,
): Promise<{ ok: boolean; data?: any; error?: any }> {
  return new Promise((resolve, reject) => {
    const handler = handlers[method];
    if (!handler) return reject(new Error(`no handler for ${method}`));
    void handler({
      params,
      respond: (ok: boolean, data?: unknown, error?: unknown) =>
        resolve({ ok, data: data as any, error }),
    } as never);
  });
}

describe("project attachments on a federation satellite", () => {
  beforeEach(async () => {
    stateDir = mkdtempSync(join(tmpdir(), "infinibot-sat-att-"));
    satelliteState.connected = false;
    satelliteState.masterContent = {};
    vi.resetModules();
    const { getKanbanStore } = await import("../../tasks/store.js");
    getKanbanStore(stateDir);
  });

  afterEach(() => {
    // better-sqlite3 keeps the handle open for the process lifetime, and
    // Windows refuses to unlink a mapped file. Cleanup is best-effort; the OS
    // reaps the temp dir.
    try {
      rmSync(stateDir, { recursive: true, force: true });
    } catch {
      /* locked by the still-open sqlite handle */
    }
  });

  it("returns an uploaded attachment from content.get while connected to master", async () => {
    const handlers = await loadHandlers();

    const upload = await call(handlers, "kanban.projects.content.uploadAttachment", {
      projectId: PROJECT_ID,
      name: "brief.txt",
      content: Buffer.from("Project brief for the agent to read.\n").toString("base64"),
      mimeType: "text/plain",
    });
    expect(upload.ok).toBe(true);
    expect(upload.data.markdownPath).toBeTruthy();

    // The file AND its markdown conversion land in this node's state dir.
    expect(existsSync(join(stateDir, "files", upload.data.path))).toBe(true);
    const mdAbs = join(stateDir, "files", upload.data.markdownPath);
    expect(existsSync(mdAbs)).toBe(true);
    expect(readFileSync(mdAbs, "utf8")).toContain("Project brief");

    // Now behave like a connected satellite: master owns notes/badges and has
    // no idea this file exists.
    satelliteState.connected = true;
    satelliteState.masterContent = {
      notes: [{ id: "n1", projectId: PROJECT_ID, title: "master note" }],
      badges: [{ id: "b1", projectId: PROJECT_ID, label: "master badge" }],
      attachments: [],
    };

    const content = await call(handlers, "kanban.projects.content.get", {
      projectId: PROJECT_ID,
    });
    expect(content.ok).toBe(true);
    // The regression: this used to be 0 because master's empty list won.
    expect(content.data.attachments).toHaveLength(1);
    expect(content.data.attachments[0].name).toBe("brief.txt");
    // …while notes and badges still come from master.
    expect(content.data.notes[0].title).toBe("master note");
    expect(content.data.badges[0].label).toBe("master badge");
  });

  it("falls back to the fully local content when master is unreachable", async () => {
    const handlers = await loadHandlers();
    await call(handlers, "kanban.projects.content.uploadAttachment", {
      projectId: PROJECT_ID,
      name: "notes.md",
      content: Buffer.from("# Heading\n").toString("base64"),
      mimeType: "text/markdown",
    });

    const content = await call(handlers, "kanban.projects.content.get", {
      projectId: PROJECT_ID,
    });
    expect(content.ok).toBe(true);
    expect(content.data.attachments).toHaveLength(1);
  });

  it("keeps the attachment write path local — uploadAttachment is never proxied", async () => {
    const handlers = await loadHandlers();
    satelliteState.connected = true;

    const upload = await call(handlers, "kanban.projects.content.uploadAttachment", {
      projectId: PROJECT_ID,
      name: "local.txt",
      content: Buffer.from("bytes stay on this node").toString("base64"),
      mimeType: "text/plain",
    });
    expect(upload.ok).toBe(true);
    expect(existsSync(join(stateDir, "files", upload.data.path))).toBe(true);

    // And the agent-facing local store sees it, which is how the kanban tool
    // (`list_files` / `get_file`) reads attachments.
    const { getKanbanStore } = await import("../../tasks/store.js");
    const rows = getKanbanStore(stateDir).getProjectAttachments(PROJECT_ID);
    expect(rows.map((r) => r.name)).toContain("local.txt");
  });
});
