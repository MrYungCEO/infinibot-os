/**
 * Grid view-controller for the UI Control Bus.
 *
 * Registers as `"grid"` and exposes panel-aware verbs the voice agent uses
 * when running in Grid Live Action mode (see A2's grid-live-action-prompt).
 *
 * Verbs (one-line catalog — keep in sync with describeActions):
 *   list_panels                  enumerate panels on the active canvas
 *   list_voice_panels            filter list_panels to type=voice
 *   get_panel_state              read one panel + scroll/form snapshot
 *   refresh_panel                fire infinibot:grid-panel-refresh
 *   scroll_panel                 scroll a panel's [data-grid-scroll] target
 *   focus_panel                  bring a panel to front (z-index bump)
 *   add_panel                    create a panel of the requested type
 *   remove_panel                 drop a panel from the active canvas
 *   edit_in_panel                dispatch infinibot:grid-panel-edit
 *   set_voice_injection_mode     swap a voice panel's prompt mode
 *
 * Each panel-targeted verb sets `agentControl.pendingOp` on dispatch and
 * clears it on resolve so the panel renderer can show a spinner / chip
 * (see A1's renderPanelHeader).
 *
 * Coordination notes:
 *   - Reads/writes `host.masonryGridState`. The renderer (A1) re-renders
 *     when we mutate via the exported state-update functions.
 *   - Imports `setGridVoiceInjectionMode` from A1's controller; if A1 has
 *     not yet exported it the import will fail at runtime/compile and A1
 *     will land the export shortly.
 *   - Dispatches three window events that the panel renderers (A3) listen
 *     for: infinibot:grid-panel-refresh, -edit, -scroll.
 *
 * Replaces the older inline `grid` registration in control-bus-app-views.ts.
 * That block remains for back-compat with the existing verbs (list_panels,
 * switch_canvas, add_session_panel, spawn_session, send_to_session,
 * remove_panel, focus_panel, add_activity_panel) — this file's
 * registration runs *after* it so the richer controller wins by name.
 */

import type { AppViewState } from "./app-view-state";
import {
    attachViewController,
    type ControlAction,
    type ControlActionResult,
    type RegistrationHandle,
} from "./control-bus";
import * as mgridCtrl from "./controllers/masonry-grid";

const PANEL_TYPES = [
    "voice",
    "group_chat",
    "workflow_builder",
    "projects",
    "tasks",
    "kanban",
    "activity",
    "database",
    "terminal",
    "session",
    "canvas",
    "chart",
    "video",
    "gpu",
] as const;
type AddablePanelType = (typeof PANEL_TYPES)[number];

const PANEL_REFRESH_EVENT = "infinibot:grid-panel-refresh";
const PANEL_EDIT_EVENT = "infinibot:grid-panel-edit";
const PANEL_SCROLL_EVENT = "infinibot:grid-panel-scroll";

/** Window-event detail shapes the renderers (A3) listen for. */
interface GridPanelEditDetail {
    panelId: string;
    op: string;
    args: Record<string, unknown>;
}
interface GridPanelScrollDetail {
    panelId: string;
    to: "top" | "bottom" | number;
    smooth: boolean;
}

function dispatchWindowEvent<D>(name: string, detail: D): void {
    try {
        if (typeof window === "undefined") return;
        window.dispatchEvent(new CustomEvent<D>(name, { detail }));
    } catch {
        /* non-browser test env — events not observable */
    }
}

function snapshotPanel(p: mgridCtrl.GridPanel) {
    return {
        panelId: p.id,
        type: p.type,
        title: p.title,
        scope:
            p.kanbanProjectId ??
            p.databaseId ??
            (p.terminalSessionId ?? undefined) ??
            p.groupId ??
            (p.sessionKey || undefined),
        x: p.x,
        y: p.y,
        w: p.width,
        h: p.height,
        zIndex: p.zIndex,
        minimized: p.minimized,
        maximized: p.maximized,
    };
}

/**
 * Read the panels of the currently-active canvas. Returns an empty array
 * (not undefined) when the grid state hasn't been initialized yet, so the
 * agent's list_panels call still returns something parseable.
 */
function activePanels(host: AppViewState): mgridCtrl.GridPanel[] {
    const g = host.masonryGridState;
    if (!g) return [];
    const active = g.canvases?.find((c) => c.id === g.activeCanvasId);
    return active?.panels ?? g.panels ?? [];
}

function findPanel(host: AppViewState, panelId: string): mgridCtrl.GridPanel | undefined {
    return activePanels(host).find((p) => p.id === panelId);
}

function requestUpdate(host: AppViewState): void {
    (host as unknown as { requestUpdate?: () => void }).requestUpdate?.();
}

function ensureGridState(
    host: AppViewState,
): mgridCtrl.MasonryGridState | { error: string } {
    const g = host.masonryGridState;
    if (!g) {
        return {
            error:
                "grid not initialized — open the Grid tab first (the renderer hydrates state lazily on mount).",
        };
    }
    return g;
}

/**
 * Wrap a panel-targeted op so we briefly mark `agentControl.pendingOp` on
 * the panel. The renderer shows a spinner while the verb is in flight.
 * Clears the flag whether the op resolves or throws.
 */
async function withAgentPending<T>(
    host: AppViewState,
    panelId: string,
    opName: string,
    work: () => Promise<T> | T,
): Promise<T> {
    const g = host.masonryGridState;
    if (g) {
        try {
            host.masonryGridState = mgridCtrl.setAgentControlPending(g, panelId, opName);
            requestUpdate(host);
        } catch {
            /* state update is best-effort — never block the real work */
        }
    }
    try {
        return await work();
    } finally {
        const g2 = host.masonryGridState;
        if (g2) {
            try {
                host.masonryGridState = mgridCtrl.clearAgentControlPending(g2, panelId);
                requestUpdate(host);
            } catch {
                /* idem */
            }
        }
    }
}

function findScrollTarget(panelId: string): HTMLElement | null {
    if (typeof document === "undefined") return null;
    return document.querySelector<HTMLElement>(`[data-grid-scroll="${panelId}"]`);
}

/* ─── action handlers ─────────────────────────────────────────────────── */

interface GridActionContext {
    host: AppViewState;
    args: Record<string, unknown>;
}

async function opListPanels({ host }: GridActionContext): Promise<ControlActionResult> {
    return {
        ok: true,
        result: {
            activeCanvasId: host.masonryGridState?.activeCanvasId,
            panels: activePanels(host).map(snapshotPanel),
        },
    };
}

async function opListVoicePanels({ host }: GridActionContext): Promise<ControlActionResult> {
    return {
        ok: true,
        result: {
            activeCanvasId: host.masonryGridState?.activeCanvasId,
            panels: activePanels(host)
                .filter((p) => p.type === "voice")
                .map((p) => ({
                    ...snapshotPanel(p),
                    voiceConfig: p.voiceConfig,
                })),
        },
    };
}

async function opGetPanelState({ host, args }: GridActionContext): Promise<ControlActionResult> {
    const panelId = String(args.panelId ?? "");
    if (!panelId) return { ok: false, error: "panelId required" };
    const panel = findPanel(host, panelId);
    if (!panel) return { ok: false, error: `panel not found: ${panelId}` };

    let scroll: { scrollTop: number; scrollHeight: number; clientHeight: number } | undefined;
    const el = findScrollTarget(panelId);
    if (el) {
        scroll = {
            scrollTop: el.scrollTop,
            scrollHeight: el.scrollHeight,
            clientHeight: el.clientHeight,
        };
    }
    return {
        ok: true,
        result: {
            panel: {
                ...snapshotPanel(panel),
                voiceConfig: panel.voiceConfig,
                kanbanProjectId: panel.kanbanProjectId,
                databaseId: panel.databaseId,
                terminalSessionId: panel.terminalSessionId,
                terminalCli: panel.terminalCli,
                terminalCwd: panel.terminalCwd,
                terminalNodeId: panel.terminalNodeId ?? panel.nodeId,
                sessionKey: panel.sessionKey || undefined,
                groupDatabaseId: panel.groupDatabaseId,
                messageDatabaseId: panel.messageDatabaseId,
                workflowDatabaseId: panel.workflowDatabaseId,
                groupId: panel.groupId,
                needsRefresh: panel.needsRefresh,
                agentControl: panel.agentControl,
            },
            scroll,
        },
    };
}

async function opRefreshPanel({ host, args }: GridActionContext): Promise<ControlActionResult> {
    const panelId = String(args.panelId ?? "");
    if (!panelId) return { ok: false, error: "panelId required" };
    const g = ensureGridState(host);
    if ("error" in g) return { ok: false, error: g.error };
    return withAgentPending(host, panelId, "refresh_panel", () => {
        const next = mgridCtrl.refreshPanel(g, panelId);
        host.masonryGridState = next;
        requestUpdate(host);
        return { ok: true, result: { refreshedAt: Date.now(), panelId } } as ControlActionResult;
    });
}

async function opScrollPanel({ host, args }: GridActionContext): Promise<ControlActionResult> {
    const panelId = String(args.panelId ?? "");
    if (!panelId) return { ok: false, error: "panelId required" };
    const to = args.to as "top" | "bottom" | number | undefined;
    if (to === undefined) return { ok: false, error: "to required ('top'|'bottom'|number)" };
    const smooth = args.smooth !== false;

    return withAgentPending(host, panelId, "scroll_panel", () => {
        // Dispatch a window event so renderers managing their own scroll
        // containers (A3) can react too. We then attempt the direct DOM
        // path; whichever resolves the visible scroll first wins.
        dispatchWindowEvent<GridPanelScrollDetail>(PANEL_SCROLL_EVENT, { panelId, to, smooth });

        const el = findScrollTarget(panelId);
        if (!el) {
            return {
                ok: true,
                result: {
                    panelId,
                    eventDispatched: true,
                    note: "no [data-grid-scroll] target in DOM; relied on event dispatch",
                },
            } as ControlActionResult;
        }
        let target: number;
        if (to === "top") target = 0;
        else if (to === "bottom") target = el.scrollHeight;
        else target = Math.max(0, Math.floor(to));
        try {
            el.scrollTo({ top: target, behavior: smooth ? "smooth" : "auto" });
        } catch {
            el.scrollTop = target;
        }
        return {
            ok: true,
            result: { panelId, scrollTop: el.scrollTop, target },
        } as ControlActionResult;
    });
}

async function opFocusPanel({ host, args }: GridActionContext): Promise<ControlActionResult> {
    const panelId = String(args.panelId ?? "");
    if (!panelId) return { ok: false, error: "panelId required" };
    const g = ensureGridState(host);
    if ("error" in g) return { ok: false, error: g.error };
    return withAgentPending(host, panelId, "focus_panel", () => {
        host.masonryGridState = mgridCtrl.focusPanel(g, panelId);
        requestUpdate(host);
        return { ok: true, result: { panelId } } as ControlActionResult;
    });
}

async function opRemovePanel({ host, args }: GridActionContext): Promise<ControlActionResult> {
    const panelId = String(args.panelId ?? "");
    if (!panelId) return { ok: false, error: "panelId required" };
    const g = ensureGridState(host);
    if ("error" in g) return { ok: false, error: g.error };
    // No pending wrapper — the panel is gone after this, so a clear() call
    // on a non-existent panel would be a no-op anyway.
    host.masonryGridState = mgridCtrl.removePanel(g, panelId);
    requestUpdate(host);
    return { ok: true, result: { panelId } };
}

async function opAddPanel({ host, args }: GridActionContext): Promise<ControlActionResult> {
    const type = (typeof args.panelType === "string" ? args.panelType : "") as AddablePanelType;
    if (!PANEL_TYPES.includes(type)) {
        return {
            ok: false,
            error: `unknown panel type: ${type}. Valid: ${PANEL_TYPES.join(", ")}`,
        };
    }
    const g = ensureGridState(host);
    if ("error" in g) return { ok: false, error: g.error };
    const options = (args.options as Record<string, unknown> | undefined) ?? {};

    let next: mgridCtrl.MasonryGridState;
    switch (type) {
        case "group_chat":
            next = mgridCtrl.addGroupChatPanel(g, {
                title: options.title as string | undefined,
                groupDatabaseId: options.groupDatabaseId as string | undefined,
                messageDatabaseId: options.messageDatabaseId as string | undefined,
                groupId: options.groupId as string | undefined,
            });
            break;
        case "workflow_builder":
            next = mgridCtrl.addWorkflowBuilderPanel(g, {
                title: options.title as string | undefined,
                workflowDatabaseId: options.workflowDatabaseId as string | undefined,
                groupDatabaseId: options.groupDatabaseId as string | undefined,
                messageDatabaseId: options.messageDatabaseId as string | undefined,
                groupId: options.groupId as string | undefined,
            });
            break;
        case "voice":
            next = mgridCtrl.addVoicePanel(g, {
                title: options.title as string | undefined,
                voiceConfig: options.voiceConfig as mgridCtrl.VoicePanelConfig | undefined,
            });
            break;
        case "projects":
            next = mgridCtrl.addProjectsPanel(g, {
                title: options.title as string | undefined,
                projectId: (options.projectId as string | null | undefined) ?? null,
            });
            break;
        case "tasks":
            next = mgridCtrl.addTasksPanel(g, {
                title: options.title as string | undefined,
                projectId: (options.projectId as string | null | undefined) ?? null,
            });
            break;
        case "kanban":
            next = mgridCtrl.addKanbanPanel(
                g,
                (options.title as string | undefined) ?? "🗂️ Kanban",
                (options.projectId as string | null | undefined) ?? null,
            );
            break;
        case "activity":
            next = mgridCtrl.addActivityPanel(
                g,
                (options.title as string | undefined) ?? "⚡ Agent Feed",
            );
            break;
        case "database":
            next = mgridCtrl.addDatabasePanel(
                g,
                (options.title as string | undefined) ?? "📚 Database",
                (options.databaseId as string | null | undefined) ?? null,
            );
            break;
        case "terminal":
            next = mgridCtrl.addTerminalPanel(
                g,
                (options.title as string | undefined) ?? "▶ Terminal",
                (options.cli as "claude" | "opencode" | "gemini" | "codex" | "grok" | "shell" | undefined) ??
                    "shell",
                (options.cwd as string | undefined) ?? "",
                (options.terminalNodeId as string | undefined) ??
                    (options.nodeId as string | undefined) ??
                    "local",
            );
            break;
        case "session": {
            const sessionKey = String(options.sessionKey ?? "");
            if (!sessionKey) {
                return { ok: false, error: "options.sessionKey required for type=session" };
            }
            next = mgridCtrl.addPanel(
                g,
                sessionKey,
                (options.title as string | undefined) ?? sessionKey,
            );
            break;
        }
        case "canvas":
            next = mgridCtrl.addCanvasPanel(
                g,
                (options.title as string | undefined) ?? "Canvas",
            );
            break;
        case "chart":
            next = mgridCtrl.addChartPanel(
                g,
                (options.title as string | undefined) ?? "Chart",
                (options.chartType as string | undefined) ?? "line",
            );
            break;
        case "video":
            next = mgridCtrl.addVideoPanel(
                g,
                (options.title as string | undefined) ?? "Video Feed",
            );
            break;
        case "gpu":
            next = mgridCtrl.addGpuPanel(
                g,
                (options.title as string | undefined) ?? "GPU Animations",
            );
            break;
        default:
            return { ok: false, error: `unhandled panel type: ${type}` };
    }
    // The controller helpers update the legacy top-level panel fields. Keep
    // the active canvas copy in lock-step so list_panels/get_panel_state see
    // the newly-added panel immediately (not only after a storage reload).
    next = {
        ...next,
        canvases: next.canvases.map((canvas) =>
            canvas.id === next.activeCanvasId
                ? {
                    ...canvas,
                    panels: next.panels,
                    activePanel: next.activePanel,
                    maxZIndex: next.maxZIndex,
                }
                : canvas,
        ),
    };
    host.masonryGridState = next;
    requestUpdate(host);
    return { ok: true, result: { panelId: next.activePanel, type } };
}

async function opEditInPanel({ host, args }: GridActionContext): Promise<ControlActionResult> {
    const panelId = String(args.panelId ?? "");
    const innerOp = String(args.op ?? "");
    if (!panelId) return { ok: false, error: "panelId required" };
    if (!innerOp) return { ok: false, error: "op required" };
    if (!findPanel(host, panelId)) {
        return { ok: false, error: `panel not found: ${panelId}` };
    }
    const innerArgs = (args.args as Record<string, unknown> | undefined) ?? {};

    return withAgentPending(host, panelId, `edit:${innerOp}`, () => {
        dispatchWindowEvent<GridPanelEditDetail>(PANEL_EDIT_EVENT, {
            panelId,
            op: innerOp,
            args: innerArgs,
        });
        // We can't synchronously know whether a renderer consumed the
        // event; A3's renderers may resolve their own follow-up via the
        // window event. Return `dispatched` so the agent knows the verb
        // landed and can poll get_panel_state if it needs confirmation.
        return {
            ok: true,
            result: { dispatched: true, panelId, op: innerOp },
        } as ControlActionResult;
    });
}

async function opSetVoiceInjectionMode(
    { host, args }: GridActionContext,
): Promise<ControlActionResult> {
    const panelId = String(args.panelId ?? "");
    const mode = String(args.mode ?? "") as "default" | "grid" | "custom";
    if (!panelId) return { ok: false, error: "panelId required" };
    if (!["default", "grid", "custom"].includes(mode)) {
        return { ok: false, error: `invalid mode: ${mode}. Valid: default, grid, custom` };
    }
    const customPrompt = args.customPrompt as string | undefined;
    const g = ensureGridState(host);
    if ("error" in g) return { ok: false, error: g.error };

    // setGridVoiceInjectionMode is owned by A1. We reference it via the
    // namespace import so if A1 ships the export later this call lights up
    // without any further edits here. If A1 hasn't landed it yet, the
    // function reference is undefined and we surface a clear error.
    const fn = (mgridCtrl as unknown as {
        setGridVoiceInjectionMode?: (
            state: mgridCtrl.MasonryGridState,
            panelId: string,
            mode: "default" | "grid" | "custom",
            customPrompt?: string,
        ) => mgridCtrl.MasonryGridState;
    }).setGridVoiceInjectionMode;
    if (typeof fn !== "function") {
        return {
            ok: false,
            error:
                "setGridVoiceInjectionMode not exported by masonry-grid controller yet — A1 will land it.",
        };
    }
    return withAgentPending(host, panelId, "set_voice_injection_mode", () => {
        host.masonryGridState = fn(g, panelId, mode, customPrompt);
        requestUpdate(host);
        return { ok: true, result: { panelId, mode } } as ControlActionResult;
    });
}

/* ─── controller registration ─────────────────────────────────────────── */

const GRID_ACTIONS: Array<{ type: string; args?: Record<string, unknown>; doc: string }> = [
    {
        type: "list_panels",
        doc: "Enumerate panels on the active canvas. Returns { panels: [{ panelId, type, title, scope, x, y, w, h, zIndex, minimized, maximized }] }. Use first to discover panelIds before any other verb.",
    },
    {
        type: "list_voice_panels",
        doc: "Like list_panels but filtered to type=voice. Includes voiceConfig (injectionMode, customPrompt, wakeWord, ttsProvider). Use to find the active voice panel quickly.",
    },
    {
        type: "get_panel_state",
        args: { panelId: "string" },
        doc: "Return the panel object plus a snapshot of its scroll position and (type-specific) scope. Pair with refresh_panel when the agent wants to verify a refresh landed.",
    },
    {
        type: "refresh_panel",
        args: { panelId: "string" },
        doc: "Fire infinibot:grid-panel-refresh so the panel's renderer re-fetches its data. Returns { refreshedAt }.",
    },
    {
        type: "scroll_panel",
        args: {
            panelId: "string",
            to: "'top' | 'bottom' | number (pixels)",
            smooth: "boolean? default true",
        },
        doc: "Scroll the panel's [data-grid-scroll] element. Also dispatches infinibot:grid-panel-scroll for renderers that own their scroll containers.",
    },
    {
        type: "focus_panel",
        args: { panelId: "string" },
        doc: "Bring a panel to the front (z-index bump).",
    },
    {
        type: "add_panel",
        args: {
            panelType: "'group_chat' | 'workflow_builder' | 'voice' | 'projects' | 'tasks' | 'kanban' | 'activity' | 'database' | 'terminal' | 'session' | 'canvas' | 'chart' | 'video' | 'gpu' (legacy alias: type)",
            options: "object? type-specific: { title?, groupDatabaseId?, messageDatabaseId?, workflowDatabaseId?, groupId?, projectId?, databaseId?, sessionKey?, cli?, cwd?, nodeId?, terminalNodeId?, chartType?, voiceConfig? }",
        },
        doc: "Create a panel of the requested type on the active canvas. Returns { panelId, type }. For type=session, options.sessionKey is required.",
    },
    {
        type: "remove_panel",
        args: { panelId: "string" },
        doc: "Remove a panel from the active canvas.",
    },
    {
        type: "edit_in_panel",
        args: { panelId: "string", op: "string", args: "object?" },
        doc: "Dispatch infinibot:grid-panel-edit to the panel's renderer. The renderer (A3) is responsible for interpreting `op` and `args` in its own DSL. Returns { dispatched: true } — poll get_panel_state for confirmation.",
    },
    {
        type: "set_voice_injection_mode",
        args: {
            panelId: "string",
            mode: "'default' | 'grid' | 'custom'",
            customPrompt: "string? (used only when mode='custom')",
        },
        doc: "Swap a voice panel's live-action injection prompt. 'grid' uses the grid live-action prompt, 'default' uses the assistant default, 'custom' uses customPrompt verbatim.",
    },
];

/**
 * Register the grid view-controller against the global UIControlBus. Called
 * from registerAppViewControllers in control-bus-app-views.ts; the host
 * reference is captured so getState / dispatch see live grid state.
 */
export function registerGridController(host: AppViewState): RegistrationHandle {
    return attachViewController({
        viewName: "grid",
        description:
            "Multi-panel masonry grid. Panels are independently positionable windows (group_chat, workflow_builder, voice, projects, tasks, kanban, activity, database, terminal, session, canvas, chart, video, gpu). Voice-agent Grid Live Action mode drives the user's panels via list_panels → refresh_panel / scroll_panel / focus_panel / add_panel / remove_panel / edit_in_panel / get_panel_state / list_voice_panels / set_voice_injection_mode.",
        getState: () => {
            const g = host.masonryGridState;
            const active = g?.canvases?.find((c) => c.id === g.activeCanvasId);
            return {
                ready: !!g,
                activeCanvasId: g?.activeCanvasId,
                gridMode: g?.gridMode,
                canvases: (g?.canvases ?? []).map((c) => ({
                    id: c.id,
                    name: c.name,
                    icon: c.icon,
                    panelCount: c.panels.length,
                    activePanel: c.activePanel,
                })),
                panels: (active?.panels ?? []).map(snapshotPanel),
            };
        },
        describeActions: () => GRID_ACTIONS,
        dispatch: async (action: ControlAction): Promise<ControlActionResult> => {
            const a = action as Record<string, unknown>;
            const ctx: GridActionContext = { host, args: a };
            switch (a.type) {
                case "list_panels":
                    return opListPanels(ctx);
                case "list_voice_panels":
                    return opListVoicePanels(ctx);
                case "get_panel_state":
                    return opGetPanelState(ctx);
                case "refresh_panel":
                    return opRefreshPanel(ctx);
                case "scroll_panel":
                    return opScrollPanel(ctx);
                case "focus_panel":
                    return opFocusPanel(ctx);
                case "add_panel":
                    return opAddPanel(ctx);
                case "remove_panel":
                    return opRemovePanel(ctx);
                case "edit_in_panel":
                    return opEditInPanel(ctx);
                case "set_voice_injection_mode":
                    return opSetVoiceInjectionMode(ctx);
                default:
                    return {
                        ok: false,
                        error:
                            `unknown grid op: ${String(a.type)}. Run ui_control list_views to see the current verb catalog.`,
                    };
            }
        },
    });
}

// Re-export event names so renderers can import them from a single source.
export {
    PANEL_EDIT_EVENT,
    PANEL_REFRESH_EVENT,
    PANEL_SCROLL_EVENT,
};
