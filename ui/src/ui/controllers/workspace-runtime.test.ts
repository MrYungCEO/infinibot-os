import { describe, expect, it, vi } from "vitest";

import {
  attachSelectedElementToAgent,
  createInitialWorkspaceState,
  getPreviewUrl,
  loadWorkspaces,
  openActiveWorkspaceExplicitly,
  selectWorkspace,
  shouldAutoStartRuntime,
  loadAgentHistory,
  revertWorkspaceVersionAction,
  sendAgentMessage,
  toggleWorkspaceCommandPalette,
  toggleWorkspaceOverflow,
} from "./workspace.js";

describe("workspace live preview URL", () => {
  it("uses the authenticated runtime proxy and preserves an in-app route", () => {
    const state = createInitialWorkspaceState();
    state.previewRoute = "/docs/getting-started";
    state.runtimeServer = {
      directoryId: "project one",
      projectRoot: "/tmp/project",
      appPath: "/tmp/project",
      kind: "vite",
      packageManager: "pnpm",
      port: 43123,
      previewPath: "/api/workspace/dev/project%20one/",
      status: "ready",
      startedAt: Date.now(),
      updatedAt: Date.now(),
      lastActivityAt: Date.now(),
      idleTimeoutMs: 1_800_000,
      tmuxSession: "ib-workspace-project-one",
      logPath: "/tmp/project.log",
      command: "pnpm dev",
      error: null,
    };

    expect(getPreviewUrl(state)).toBe(
      "/api/workspace/dev/project%20one/docs/getting-started",
    );
  });

  it("keeps an explicit operator URL as the highest priority", () => {
    const state = createInitialWorkspaceState();
    state.devUrl = "http://127.0.0.1:4173/app?mode=preview";
    state.previewNonce = 42;
    state.runtimeServer = {
      directoryId: "fixture",
      projectRoot: "/tmp/project",
      appPath: "/tmp/project",
      kind: "vite",
      packageManager: "pnpm",
      port: 43123,
      previewPath: "/api/workspace/dev/fixture/",
      status: "ready",
      startedAt: Date.now(),
      updatedAt: Date.now(),
      lastActivityAt: Date.now(),
      idleTimeoutMs: 1_800_000,
      tmuxSession: "ib-workspace-fixture",
      logPath: "/tmp/project.log",
      command: "pnpm dev",
      error: null,
    };

    expect(getPreviewUrl(state)).toBe("http://127.0.0.1:4173/app?mode=preview&_n=42");
  });

  it("opens and closes the workspace overflow and command palette", () => {
    const workspace = createInitialWorkspaceState();
    const host = { workspaceState: workspace, requestUpdate() {} } as never;

    toggleWorkspaceOverflow(host, true);
    toggleWorkspaceCommandPalette(host, true);
    expect(workspace.overflowOpen).toBe(true);
    expect(workspace.commandPaletteOpen).toBe(true);

    toggleWorkspaceOverflow(host, false);
    toggleWorkspaceCommandPalette(host, false);
    expect(workspace.overflowOpen).toBe(false);
    expect(workspace.commandPaletteOpen).toBe(false);
  });

  it("attaches a selected preview element to the agent composer", () => {
    const workspace = createInitialWorkspaceState();
    workspace.selectedElement = {
      selector: "main > section.hero",
      tag: "section",
      text: "Ship your next idea",
      html: '<section class="hero">Ship your next idea</section>',
      source: "src/App.tsx:18",
      screenshotPath: "/tmp/selection.png",
    };
    const host = { workspaceState: workspace, requestUpdate() {} } as never;

    attachSelectedElementToAgent(host);

    expect(workspace.agentInput).toContain("main > section.hero");
    expect(workspace.agentInput).toContain("src/App.tsx:18");
    expect(workspace.agentInput).toContain("/tmp/selection.png");
  });

  it("creates a checkpoint before sending a native workspace-agent turn", async () => {
    const workspace = createInitialWorkspaceState();
    workspace.workspaces = [{ id: "fixture", name: "Fixture", path: "/tmp/fixture" }];
    workspace.selectedId = "fixture";
    workspace.agentSessionKey = "agent:main:workspace-fixture";
    workspace.agentInput = "Make the hero more premium";
    const host = { workspaceState: workspace, requestUpdate() {} } as never;
    const request = vi.fn(async (method: string) => method === "workspace.version.list" ? { versions: [] } : {});

    await sendAgentMessage(host, { request } as never);

    expect(request.mock.calls[0]?.[0]).toBe("workspace.version.create");
    expect(request.mock.calls.some(([method]) => method === "chat.send")).toBe(true);
  });

  it("loads a streamed chat transcript once, including an empty-session guard", async () => {
    const workspace = createInitialWorkspaceState();
    workspace.agentSessionKey = "agent:main:workspace-fixture";
    const host = { workspaceState: workspace, requestUpdate() {} } as never;
    const request = vi.fn(async (method: string) => method === "sessions.list"
      ? { defaults: { modelProvider: "ollama", model: "qwen3:latest" } }
      : {
          messages: [
            { role: "user", content: [{ type: "text", text: "Polish the hero" }], timestamp: 1 },
            { role: "assistant", content: "Working through the visual hierarchy", timestamp: 2 },
          ],
        });

    await loadAgentHistory(host, { request } as never);

    expect(workspace.agentMessages.map((message) => message.text)).toEqual([
      "Polish the hero",
      "Working through the visual hierarchy",
    ]);
    expect(workspace.agentHistoryLoaded).toBe(true);
    expect(workspace.agentLoading).toBe(false);
    expect(workspace.agentDefaultModel).toBe("ollama/qwen3:latest");
  });

  it("wires checkpoint revert through the workspace RPC", async () => {
    const workspace = createInitialWorkspaceState();
    workspace.workspaces = [{ id: "fixture", name: "Fixture", path: "/tmp/fixture" }];
    workspace.selectedId = "fixture";
    const host = { workspaceState: workspace, requestUpdate() {} } as never;
    const request = vi.fn(async () => ({}));

    await revertWorkspaceVersionAction(host, { request } as never, "checkpoint-1");

    expect(request).toHaveBeenCalledWith("workspace.version.revert", {
      directoryId: "fixture",
      versionId: "checkpoint-1",
    });
    expect(request.mock.calls.some(([method]) => method === "files.tree")).toBe(true);
  });
});

describe("workspace runtime auto-start gating", () => {
  function fakeClient() {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const client = {
      request: vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
        calls.push({ method, params });
        switch (method) {
          case "directories.list":
            return [
              { id: "restored", path: "/tmp/restored", name: "Restored" },
              { id: "other", path: "/tmp/other", name: "Other" },
            ];
          case "workspace.dev.detect":
            return { kind: "expo-web", missingDependencies: false, appPath: "/tmp/x" };
          case "workspace.dev.status":
            return null;
          case "workspace.dev.start":
            return { record: { status: "stopped" } };
          case "files.roots.list":
            return { roots: [] };
          default:
            return {};
        }
      }),
    };
    const starts = () => calls.filter((c) => c.method === "workspace.dev.start");
    return { client: client as never, calls, starts };
  }

  function host() {
    const workspace = createInitialWorkspaceState();
    workspace.runtimeAutoStart = true;
    return { workspace, state: { workspaceState: workspace, requestUpdate() {} } as never };
  }

  it("does not auto-start the project restored on page load", async () => {
    const { workspace, state } = host();
    const { client, starts, calls } = fakeClient();
    await loadWorkspaces(state, client);
    expect(workspace.selectedId).toBe("restored");
    expect(calls.some((c) => c.method === "workspace.dev.detect")).toBe(true);
    expect(starts()).toHaveLength(0);
  });

  it("auto-starts a project explicitly selected this session when the setting is on", async () => {
    const { workspace, state } = host();
    const { client, starts } = fakeClient();
    await loadWorkspaces(state, client);
    await selectWorkspace(state, client, "other", { explicit: true });
    expect(workspace.selectedId).toBe("other");
    expect(starts()).toHaveLength(1);
    expect(starts()[0]!.params.directoryId).toBe("other");
  });

  it("does not auto-start an explicit selection when the setting is off", async () => {
    const { workspace, state } = host();
    workspace.runtimeAutoStart = false;
    const { client, starts } = fakeClient();
    workspace.workspaces = [{ id: "other", path: "/tmp/other", name: "Other" }];
    await selectWorkspace(state, client, "other", { explicit: true });
    expect(starts()).toHaveLength(0);
  });

  it("clicking the already-active restored project counts as an explicit open", async () => {
    const { state } = host();
    const { client, starts } = fakeClient();
    await loadWorkspaces(state, client);
    expect(starts()).toHaveLength(0);
    await openActiveWorkspaceExplicitly(state, client);
    expect(starts()).toHaveLength(1);
    expect(starts()[0]!.params.directoryId).toBe("restored");
  });

  it("shouldAutoStartRuntime requires setting + explicit open + runnable project", () => {
    const ws = createInitialWorkspaceState();
    ws.runtimeAutoStart = true;
    const detection = { kind: "vite", missingDependencies: false } as never;
    expect(shouldAutoStartRuntime(ws, "p", detection, null)).toBe(false);
    ws.runtimeExplicitIds.push("p");
    expect(shouldAutoStartRuntime(ws, "p", detection, null)).toBe(true);
    expect(
      shouldAutoStartRuntime(ws, "p", detection, { status: "ready" } as never),
    ).toBe(false);
    expect(
      shouldAutoStartRuntime(ws, "p", { kind: "vite", missingDependencies: true } as never, null),
    ).toBe(false);
  });
});
