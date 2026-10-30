import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, html, nothing } from "lit";
import type { GatewayBrowserClient } from "../gateway";
import type { AppViewState } from "../app-view-state";
import {
  openSubagentDetailModal,
  closeSubagentDetailModal,
  isSubagentDetailOpen,
  renderSubagentDetailModal,
} from "./subagent-detail-modal";

// ── Test doubles ─────────────────────────────────────────────────────────────

function makeStubClient(
  response: unknown,
  handlers?: Record<string, unknown>,
): GatewayBrowserClient {
  return {
    request: (m: string, _p?: unknown) => {
      if (handlers && m in handlers) {
        const h = handlers[m];
        return Promise.resolve(typeof h === "function" ? h() : h);
      }
      return Promise.resolve(response);
    },
    subscribe: () => () => {},
  } as unknown as GatewayBrowserClient;
}

function makeStubState(): AppViewState {
  return {
    requestUpdate: () => {},
    setTab: () => {},
  } as unknown as AppViewState;
}

// happy-path payload returned by the stub gateway client.
const FAKE_DETAIL = {
  ok: true,
  run: {
    runId: "run_abc123",
    task: "Investigate the modal wiring across the activity page.",
    label: "modal-investigator",
    workdir: "/tmp/wd",
    createdAt: Date.now() - 60_000,
    startedAt: Date.now() - 55_000,
    endedAt: Date.now() - 5_000,
    outcome: { status: "ok" } as { status: string; error?: string },
    requesterSessionKey: "main",
    filesTouched: [
      { path: "/repo/foo.ts", action: "edited", at: Date.now() - 10_000 },
      { path: "/repo/bar.ts", action: "created", at: Date.now() - 9_000 },
    ],
  },
  project: { id: "p1", name: "Project Alpha", href: "#/projects" },
  task: { id: "t1", title: "Wire modal", status: "in_progress", href: "#/projects" },
  tasks: [
    {
      id: "t1",
      title: "Wire modal",
      status: "in_progress",
      priority: "high",
      projectId: "p1",
      projectName: "Project Alpha",
      href: "#/projects",
    },
    {
      id: "t2",
      title: "Document modal",
      status: "todo",
      projectId: "p1",
      projectName: "Project Alpha",
      href: "#/projects",
    },
  ],
  contentPages: [
    {
      id: "pg1",
      name: "Studio Landing",
      surface: "web",
      status: "live",
      updatedAt: Date.now() - 60_000,
      handle: "studio",
      href: "#/content-pages",
    },
  ],
};

// A running (no endedAt) detail payload so Live Session tab is available.
const FAKE_RUNNING_DETAIL = {
  ok: true,
  source: "live" as const,
  run: {
    runId: "run_running_001",
    task: "A running task.",
    label: "live-runner",
    workdir: "/tmp/live",
    createdAt: Date.now() - 30_000,
    startedAt: Date.now() - 28_000,
    // No endedAt — agent is live
    requesterSessionKey: "agent:coder:subagent:live001",
    coderBackend: "claude-code" as const,
  },
  tasks: [],
  contentPages: [],
};

// Stub responses for the live-session RPCs.
const STUB_TRANSCRIPT = { ok: true, turns: [
  { role: "user", text: "Hello agent" },
  { role: "assistant", text: "On it!" },
], total: 2 };
const STUB_CAPABILITIES = {
  ok: true,
  backend: "claude-code",
  paused: false,
  supports: { pause: true, send: true, edit: true, fork: false },
};

function makeLiveClient(): GatewayBrowserClient {
  return makeStubClient(FAKE_RUNNING_DETAIL, {
    "subagents.detail": FAKE_RUNNING_DETAIL,
    "sessions.transcript": STUB_TRANSCRIPT,
    "sessions.capabilities": STUB_CAPABILITIES,
    "sessions.send": { ok: true },
    "sessions.pause": { ok: true, paused: true },
    "sessions.resume": { ok: true, paused: false },
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("subagent-detail-modal", () => {
  beforeEach(() => {
    closeSubagentDetailModal(() => {});
  });

  it("starts closed", () => {
    expect(isSubagentDetailOpen()).toBe(false);
    expect(renderSubagentDetailModal(makeStubState(), makeStubClient(FAKE_DETAIL))).toBe(nothing);
  });

  it("opens via openSubagentDetailModal and reports open state", () => {
    openSubagentDetailModal({
      client: makeStubClient(FAKE_DETAIL),
      requestUpdate: () => {},
      sessionKey: "agent:main:subagent:abc",
    });
    expect(isSubagentDetailOpen()).toBe(true);
  });

  it("is a no-op when called with no runId and no sessionKey", () => {
    openSubagentDetailModal({
      client: makeStubClient(FAKE_DETAIL),
      requestUpdate: () => {},
    });
    expect(isSubagentDetailOpen()).toBe(false);
  });

  it("renders a loading skeleton before the detail RPC resolves", () => {
    const root = document.createElement("div");
    document.body.append(root);

    let updateCount = 0;
    openSubagentDetailModal({
      client: {
        request: () => new Promise(() => {}),
        subscribe: () => () => {},
      } as unknown as GatewayBrowserClient,
      requestUpdate: () => { updateCount++; },
      runId: "run_loading",
    });

    render(renderSubagentDetailModal(makeStubState(), makeStubClient(FAKE_DETAIL)), root);
    expect(root.querySelector(".sadm-loading")).toBeTruthy();
    expect(updateCount).toBeGreaterThan(0);

    root.remove();
  });

  it("closes via closeSubagentDetailModal and restores body overflow", () => {
    document.body.style.overflow = "";
    openSubagentDetailModal({
      client: makeStubClient(FAKE_DETAIL),
      requestUpdate: () => {},
      sessionKey: "agent:main:subagent:xyz",
    });
    expect(document.body.style.overflow).toBe("hidden");
    expect(isSubagentDetailOpen()).toBe(true);
    closeSubagentDetailModal(() => {});
    expect(isSubagentDetailOpen()).toBe(false);
    expect(document.body.style.overflow).toBe("");
  });

  it("renders task rows and content-page rows once detail data has loaded", async () => {
    const root = document.createElement("div");
    document.body.append(root);

    let updateCount = 0;
    const rerender = () => {
      render(
        isSubagentDetailOpen()
          ? renderSubagentDetailModal(makeStubState(), makeStubClient(FAKE_DETAIL))
          : html``,
        root,
      );
      updateCount++;
    };

    openSubagentDetailModal({
      client: makeStubClient(FAKE_DETAIL),
      requestUpdate: rerender,
      runId: "run_abc123",
    });

    // Initial loading render.
    rerender();
    expect(root.querySelector(".sadm-loading")).toBeTruthy();

    // Let the resolved Promise from the stub client flush.
    await new Promise((r) => setTimeout(r, 0));
    rerender();

    // Header is present.
    expect(root.querySelector(".sadm-title")?.textContent).toContain("modal-investigator");
    // Overview tab renders task + page rows.
    const taskRows = root.querySelectorAll(".sadm-row");
    expect(taskRows.length).toBeGreaterThanOrEqual(2 + 1); // 2 tasks + 1 page
    expect(root.textContent ?? "").toContain("Wire modal");
    expect(root.textContent ?? "").toContain("Studio Landing");
    expect(updateCount).toBeGreaterThan(1);

    closeSubagentDetailModal(() => {});
    root.remove();
  });

  it("renders the tab strip for a completed run (Overview + History visible)", async () => {
    const root = document.createElement("div");
    document.body.append(root);

    const rerender = () => {
      render(
        isSubagentDetailOpen()
          ? renderSubagentDetailModal(makeStubState(), makeStubClient(FAKE_DETAIL))
          : html``,
        root,
      );
    };

    openSubagentDetailModal({
      client: makeStubClient(FAKE_DETAIL),
      requestUpdate: rerender,
      runId: "run_abc123",
    });
    rerender();
    await new Promise((r) => setTimeout(r, 0));
    rerender();

    // Completed runs only show Overview + History (no live tabs).
    const tabs = root.querySelectorAll(".sadm-tab");
    const tabLabels = [...tabs].map((t) => t.textContent?.trim() ?? "");
    expect(tabLabels).toContain("Overview");
    expect(tabLabels).toContain("History");
    // Live Session tab must NOT appear for completed runs.
    expect(tabLabels).not.toContain("Live Session");

    closeSubagentDetailModal(() => {});
    root.remove();
  });

  it("renders Live Session tab strip entry for a running agent", async () => {
    const root = document.createElement("div");
    document.body.append(root);

    let capturedRerender: (() => void) | null = null;
    const rerender = () => {
      render(
        isSubagentDetailOpen()
          ? renderSubagentDetailModal(makeStubState(), makeLiveClient())
          : html``,
        root,
      );
    };
    capturedRerender = rerender;

    openSubagentDetailModal({
      client: makeLiveClient(),
      requestUpdate: rerender,
      runId: "run_running_001",
    });
    rerender();
    await new Promise((r) => setTimeout(r, 0));
    rerender();

    const tabs = root.querySelectorAll(".sadm-tab");
    const tabLabels = [...tabs].map((t) => (t.textContent ?? "").trim().replace(/\s+/g, " "));
    expect(tabLabels.some((l) => l.includes("Live Session"))).toBe(true);
    expect(tabLabels.some((l) => l.includes("Tool Calls"))).toBe(true);
    expect(tabLabels.some((l) => l.includes("Output"))).toBe(true);

    closeSubagentDetailModal(() => {});
    root.remove();
  });

  it("Live Session tab renders transcript and composer when supports.send is true", async () => {
    const root = document.createElement("div");
    document.body.append(root);

    const rerender = () => {
      render(
        isSubagentDetailOpen()
          ? renderSubagentDetailModal(makeStubState(), makeLiveClient())
          : html``,
        root,
      );
    };

    openSubagentDetailModal({
      client: makeLiveClient(),
      requestUpdate: rerender,
      runId: "run_running_001",
      tab: "live" as const,
    });
    rerender();

    // Wait for all async RPCs.
    await new Promise((r) => setTimeout(r, 20));
    rerender();

    // Transcript area exists.
    expect(root.querySelector(".sadm-transcript")).toBeTruthy();
    // Composer is present (agent supports send).
    expect(root.querySelector(".sadm-composer-input")).toBeTruthy();
    // Pause button visible (supports.pause).
    expect(root.textContent ?? "").toMatch(/Pause/i);

    closeSubagentDetailModal(() => {});
    root.remove();
  });

  it("Send button is disabled when composerText is empty", async () => {
    const root = document.createElement("div");
    document.body.append(root);

    const rerender = () => {
      render(
        isSubagentDetailOpen()
          ? renderSubagentDetailModal(makeStubState(), makeLiveClient())
          : html``,
        root,
      );
    };

    openSubagentDetailModal({
      client: makeLiveClient(),
      requestUpdate: rerender,
      runId: "run_running_001",
      tab: "live" as const,
    });
    rerender();
    await new Promise((r) => setTimeout(r, 20));
    rerender();

    const sendBtn = root.querySelector<HTMLButtonElement>(".sadm-send-btn");
    expect(sendBtn).toBeTruthy();
    expect(sendBtn?.disabled).toBe(true);

    closeSubagentDetailModal(() => {});
    root.remove();
  });

  it("renders an archived banner + chip and skips per-file detail when source:archive", async () => {
    const ARCHIVED_DETAIL = {
      ok: true,
      source: "archive" as const,
      run: {
        runId: "run_archived_001",
        task: "Investigate an archive-only run.",
        label: "archive-walker",
        workdir: "/tmp/wd-archived",
        createdAt: Date.now() - 60 * 60_000,
        startedAt: Date.now() - 60 * 60_000,
        endedAt: Date.now() - 30 * 60_000,
        outcome: { status: "ok" },
        requesterSessionKey: "main",
        filesTouchedCount: 12,
        filesTouchedSample: [
          "/repo/alpha.ts",
          "/repo/beta.ts",
        ],
        coderBackend: "claude-code",
      },
      project: undefined,
      task: undefined,
      tasks: [],
      contentPages: [],
    };

    const root = document.createElement("div");
    document.body.append(root);

    const rerender = () => {
      render(
        isSubagentDetailOpen()
          ? renderSubagentDetailModal(makeStubState(), makeStubClient(ARCHIVED_DETAIL))
          : html``,
        root,
      );
    };

    openSubagentDetailModal({
      client: makeStubClient(ARCHIVED_DETAIL),
      requestUpdate: rerender,
      runId: "run_archived_001",
    });
    rerender();
    await new Promise((r) => setTimeout(r, 0));
    rerender();

    // Archived chip + banner are visible.
    expect(root.textContent ?? "").toContain("ARCHIVED");
    expect(root.querySelector(".sadm-archived-banner")?.textContent ?? "").toMatch(
      /live progress no longer available/i,
    );

    // Cancel button should NOT be present — archive entries are terminal.
    expect(root.textContent ?? "").not.toContain("Cancel run");

    // File rows come from the sample (action defaults to "edited").
    expect(root.textContent ?? "").toContain("alpha.ts");
    expect(root.textContent ?? "").toContain("beta.ts");
    // Total count from archive surfaces as a badge.
    expect(root.textContent ?? "").toContain("12 TOTAL");

    closeSubagentDetailModal(() => {});
    root.remove();
  });

  it("clicking a file row opens the diff drawer with diff body, stats, and actions", async () => {
    const root = document.createElement("div");
    document.body.append(root);

    const DIFF_PATCH = [
      "@@ -1,3 +1,4 @@",
      " context line",
      "-removed line",
      "+added line one",
      "+added line two",
    ].join("\n");
    const fileDiffClient = makeStubClient(FAKE_DETAIL, {
      "subagents.detail": FAKE_DETAIL,
      "files.diff": {
        ok: true,
        path: "/repo/foo.ts",
        absPath: "/repo/foo.ts",
        status: "modified",
        binary: false,
        added: 2,
        removed: 1,
        before: "x",
        after: "y",
        patch: DIFF_PATCH,
        truncated: false,
      },
    });

    const rerender = () => {
      render(
        isSubagentDetailOpen()
          ? renderSubagentDetailModal(makeStubState(), fileDiffClient)
          : html``,
        root,
      );
    };

    openSubagentDetailModal({
      client: fileDiffClient,
      requestUpdate: rerender,
      runId: "run_abc123",
    });
    rerender();
    await new Promise((r) => setTimeout(r, 0));
    rerender();

    // Files-touched rows are now clickable.
    const fileRow = root.querySelector<HTMLElement>(".sadm-file-row-click");
    expect(fileRow).toBeTruthy();

    // Click → fetch files.diff → drawer renders.
    fileRow!.click();
    await new Promise((r) => setTimeout(r, 0));
    rerender();

    // Drawer is mounted.
    const drawer = root.querySelector(".sadm-fd");
    expect(drawer).toBeTruthy();
    // Status badge reflects "Modified".
    expect(root.querySelector(".sadm-fd-badge")?.textContent?.trim()).toBe("Modified");
    // ±line stats are shown.
    expect(root.querySelector(".sadm-fd-add-c")?.textContent ?? "").toContain("2");
    expect(root.querySelector(".sadm-fd-del-c")?.textContent ?? "").toContain("1");
    // Diff body rendered the add/del lines.
    expect(root.querySelectorAll(".sadm-fd-add").length).toBeGreaterThanOrEqual(2);
    expect(root.querySelectorAll(".sadm-fd-del").length).toBeGreaterThanOrEqual(1);
    // Action row: Revert / Accept / Open / Copy patch.
    const actionText = root.querySelector(".sadm-fd-actions")?.textContent ?? "";
    expect(actionText).toMatch(/Revert/);
    expect(actionText).toMatch(/Accept/);
    expect(actionText).toMatch(/Copy patch/);

    closeSubagentDetailModal(() => {});
    root.remove();
  });

  it("shows a Delete action (not Revert) for a created file", async () => {
    const root = document.createElement("div");
    document.body.append(root);

    const createdClient = makeStubClient(FAKE_DETAIL, {
      "subagents.detail": FAKE_DETAIL,
      "files.diff": {
        ok: true,
        path: "/repo/bar.ts",
        status: "created",
        binary: false,
        added: 10,
        removed: 0,
        before: null,
        after: "new file contents\nline two",
        patch: "",
        truncated: false,
      },
    });
    const rerender = () => {
      render(
        isSubagentDetailOpen()
          ? renderSubagentDetailModal(makeStubState(), createdClient)
          : html``,
        root,
      );
    };
    openSubagentDetailModal({ client: createdClient, requestUpdate: rerender, runId: "run_abc123" });
    rerender();
    await new Promise((r) => setTimeout(r, 0));
    rerender();

    // Click the second file row (bar.ts, the created one).
    const rows = root.querySelectorAll<HTMLElement>(".sadm-file-row-click");
    expect(rows.length).toBeGreaterThanOrEqual(2);
    rows[1].click();
    await new Promise((r) => setTimeout(r, 0));
    rerender();

    const actionText = root.querySelector(".sadm-fd-actions")?.textContent ?? "";
    expect(actionText).toMatch(/Delete/);
    expect(actionText).not.toMatch(/Revert/);
    // Created badge + full-content add lines.
    expect(root.querySelector(".sadm-fd-badge")?.textContent?.trim()).toBe("Created");
    expect(root.querySelectorAll(".sadm-fd-add").length).toBeGreaterThanOrEqual(2);

    closeSubagentDetailModal(() => {});
    root.remove();
  });

  it("Escape keydown closes the modal", () => {
    openSubagentDetailModal({
      client: makeStubClient(FAKE_DETAIL),
      requestUpdate: () => {},
      runId: "run_esc",
    });
    expect(isSubagentDetailOpen()).toBe(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(isSubagentDetailOpen()).toBe(false);
  });

  it("subscribe is called on open and unsubscribe fires on close for running agents", async () => {
    const unsub = vi.fn();
    const subscribeSpy = vi.fn(() => unsub);
    const client = {
      request: (m: string) => {
        if (m === "subagents.detail") return Promise.resolve(FAKE_RUNNING_DETAIL);
        if (m === "sessions.transcript") return Promise.resolve(STUB_TRANSCRIPT);
        if (m === "sessions.capabilities") return Promise.resolve(STUB_CAPABILITIES);
        return Promise.resolve({ ok: true });
      },
      subscribe: subscribeSpy,
    } as unknown as GatewayBrowserClient;

    let rerenderCount = 0;
    const rerender = () => rerenderCount++;

    openSubagentDetailModal({ client, requestUpdate: rerender, runId: "run_running_001" });
    await new Promise((r) => setTimeout(r, 20));

    expect(subscribeSpy).toHaveBeenCalledTimes(1);
    closeSubagentDetailModal(rerender);
    expect(unsub).toHaveBeenCalledTimes(1);
  });
});
