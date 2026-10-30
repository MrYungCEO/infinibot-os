/**
 * UIControlBus — singleton registry that lets the agent (server-side) drive
 * the browser UI in real time.
 *
 * Each lit-element view that wants to be agent-controllable registers a
 * `ViewController` with this bus. The bus subscribes to `ui.request`
 * gateway events; when one fires, it routes to the matching view, executes
 * the requested action (or reads state), and replies to the server via the
 * regular `ui.response` request channel.
 *
 * Usage in a view component:
 *
 *   connectedCallback() {
 *     super.connectedCallback();
 *     this._busHandle = UIControlBus.register({
 *       viewName: "kanban",
 *       getState: () => ({ boards: this.boards, selected: this.selectedId }),
 *       dispatch: async (action) => {
 *         switch (action.type) {
 *           case "select_card": ...
 *           case "move_card":   ...
 *         }
 *       },
 *     });
 *   }
 *
 *   disconnectedCallback() {
 *     this._busHandle?.unregister();
 *     super.disconnectedCallback();
 *   }
 */

import { withAgentNav } from "./chat/chat-follow-nav";
import type { GatewayBrowserClient, GatewayEventFrame } from "./gateway";

export type ControlAction =
    | { type: string; [key: string]: unknown }
    | { type: "_meta_describe" };

export interface ControlActionResult {
    ok: boolean;
    result?: unknown;
    error?: string;
}

/**
 * Merge a wire-level operation name with its view-specific arguments.
 *
 * `type` is the in-browser action discriminator, but a few public actions also
 * have a legitimate argument named `type` (notably grid.add_panel). The old
 * `{ type: action, ...args }` order let that argument overwrite the operation,
 * turning `add_panel + { type: "canvas" }` into an unknown `canvas` action.
 * Preserve the documented input as `panelType`, then make the operation name
 * authoritative.
 */
export function mergeControlAction(
    action: string,
    args?: Record<string, unknown>,
): ControlAction {
    const merged = { ...args };
    if (action === "add_panel" && merged.panelType === undefined && merged.type !== undefined) {
        merged.panelType = merged.type;
    }
    delete merged.type;
    return { ...merged, type: action };
}

export interface ViewController<S = unknown> {
    /** Unique view name. Lowercase snake_case (e.g. "kanban", "voice_chat"). */
    viewName: string;
    /**
     * Optional human-readable description shown to the agent in list_views.
     * Briefly describe what this view is for and what major actions it
     * supports. The agent reads this verbatim.
     */
    description?: string;
    /**
     * Return the current observable state of this view as a JSON-safe value.
     * Called whenever the agent asks `get_state`. Keep the returned shape
     * stable — it is the agent's primary input.
     */
    getState(): S;
    /**
     * Execute an action against this view. The action shape is
     * controller-defined; document it via `describeActions()`.
     */
    dispatch(action: ControlAction): Promise<ControlActionResult> | ControlActionResult;
    /**
     * Optional: enumerate the actions this controller accepts so the agent
     * can call them without prior knowledge. Returned as a free-form array
     * of `{ type, args, doc }` records.
     */
    describeActions?(): Array<{ type: string; args?: Record<string, unknown>; doc?: string }>;
    /**
     * Optional: for Live Action Mode's cursor/ring overlay, resolve a target
     * for the given action. The overlay uses this to animate a fake cursor
     * flying to the right DOM element before the action fires. Return:
     *   • a CSS selector string — overlay queries the DOM with it.
     *   • a DOMRect / Element — overlay uses the rect directly.
     *   • null/undefined — overlay falls back to the view's bounding box.
     */
    resolveActionTarget?(action: ControlAction):
        | string
        | Element
        | DOMRect
        | null
        | undefined;
}

/** Detail shape for the window-level CustomEvents that fire around every
 *  dispatch. The Live Action Mode overlay (or anything else that wants to
 *  visualize agent activity) can listen to these. */
export interface ControlBusEventDetail {
    view: string;
    action: string;
    args?: Record<string, unknown>;
    result?: ControlActionResult;
    target?: string | Element | DOMRect | null | undefined;
}

export interface RegistrationHandle {
    unregister: () => void;
}

interface UIRequestPayload {
    requestId: string;
    view: string;
    action: string;
    args?: Record<string, unknown>;
    /** WebSocket-unique target; preferred over instanceId for duplicated-tab disambiguation. */
    connId?: string;
    /** Legacy targeting field; matches every tab that shares this sessionStorage id. */
    instanceId?: string;
}

class UIControlBusImpl {
    private controllers = new Map<string, ViewController>();
    private client: GatewayBrowserClient | undefined;
    private unsubscribeFromGateway: (() => void) | undefined;
    private instanceId: string | undefined;
    /**
     * This tab's WebSocket connId, learned from the gateway's ui.my_codename
     * response. Unique per WS even when sessionStorage instanceId is shared
     * across duplicated tabs. Used by handleRequest() to filter dispatches
     * targeted at a specific tab — without it, all duplicated tabs would
     * execute the same dispatch in sync.
     */
    private connId: string | undefined;
    /**
     * User-driven pause flag. While true, every incoming dispatch
     * short-circuits with `{ ok: false, error: "ui paused by user" }`
     * before reaching the view controller. Set via the live-action
     * toast's pause button so the user can halt a runaway agent
     * without disconnecting the WebSocket.
     */
    private paused = false;

    /** True when the user has paused agent UI dispatches. */
    isPaused(): boolean {
        return this.paused;
    }

    /**
     * Toggle the pause gate. Idempotent — calling with the current value
     * is a no-op. Broadcasts a `ui-control:paused-changed` window event
     * so the toast (and any other listener) can re-render without polling.
     */
    setPaused(next: boolean): void {
        if (this.paused === next) return;
        this.paused = next;
        try {
            if (typeof window !== "undefined") {
                window.dispatchEvent(
                    new CustomEvent("ui-control:paused-changed", { detail: { paused: next } }),
                );
            }
        } catch { /* CustomEvent unavailable in some test contexts */ }
    }

    /**
     * Attach to the GatewayBrowserClient. Idempotent — calling twice with
     * the same client is a no-op. Calling with a different client detaches
     * from the previous one.
     */
    attach(client: GatewayBrowserClient, instanceId?: string): void {
        if (this.client === client) return;
        this.detach();
        this.client = client;
        this.instanceId = instanceId;
        // Drop any connId we cached from a previous WS — the new one will
        // have its own. Refreshed by setOwnConnId() once the codename
        // request returns.
        this.connId = undefined;
        this.unsubscribeFromGateway = client.subscribe((evt) => {
            if (evt.event === "ui.request") {
                void this.handleRequest(evt);
            }
        });
    }

    /**
     * Called by app-gateway after `ui.my_codename` returns. Stores the
     * connId so per-tab dispatch filtering (handleRequest) can match on
     * it instead of instanceId. Necessary because duplicated browser tabs
     * share sessionStorage instanceId but always have distinct connIds.
     */
    setOwnConnId(connId: string | undefined): void {
        this.connId = connId;
    }

    detach(): void {
        if (this.unsubscribeFromGateway) {
            this.unsubscribeFromGateway();
            this.unsubscribeFromGateway = undefined;
        }
        this.client = undefined;
    }

    register<S>(controller: ViewController<S>): RegistrationHandle {
        if (!controller.viewName) {
            throw new Error("UIControlBus.register: viewName required");
        }
        this.controllers.set(controller.viewName, controller as ViewController);
        return {
            unregister: () => {
                if (this.controllers.get(controller.viewName) === (controller as ViewController)) {
                    this.controllers.delete(controller.viewName);
                }
            },
        };
    }

    list(): Array<{
        viewName: string;
        description?: string;
        actions: Array<{ type: string; args?: Record<string, unknown>; doc?: string }>;
    }> {
        const out: ReturnType<UIControlBusImpl["list"]> = [];
        for (const [name, c] of this.controllers) {
            out.push({
                viewName: name,
                description: c.description,
                actions: c.describeActions?.() ?? [],
            });
        }
        return out;
    }

    /**
     * Synchronous read of a view's state. Returns undefined if the view is
     * not registered.
     */
    queryState(viewName: string): unknown {
        const c = this.controllers.get(viewName);
        if (!c) return undefined;
        try {
            return c.getState();
        } catch (err) {
            return { _error: (err as Error).message ?? String(err) };
        }
    }

    /**
     * Programmatically dispatch into a registered view from inside another
     * controller. Used by cross-view shortcuts like nav.open_page that need
     * to switch a tab and then trigger a within-view action in one call.
     *
     * Skips the lifecycle CustomEvent emission so chained dispatches don't
     * confuse the Live Action overlay — the top-level public dispatch the
     * agent invoked already raised the action-started/finished pair.
     */
    async dispatchTo(viewName: string, action: ControlAction): Promise<ControlActionResult> {
        const c = this.controllers.get(viewName);
        if (!c) {
            return {
                ok: false,
                error: `view not registered: ${viewName}. Available: ${[...this.controllers.keys()].join(", ") || "(none)"}`,
            };
        }
        try {
            return await c.dispatch(action);
        } catch (err) {
            return { ok: false, error: (err as Error).message ?? String(err) };
        }
    }

    private async handleRequest(evt: GatewayEventFrame): Promise<void> {
        const payload = evt.payload as UIRequestPayload | undefined;
        if (!payload || typeof payload.requestId !== "string") return;

        // Per-tab dispatch filtering. The gateway can scope a ui.request to
        // a specific tab by setting one of two fields in the payload:
        //
        //   connId     — preferred. WebSocket-unique, so two tabs that
        //                share a sessionStorage instanceId (duplicate-tab
        //                gotcha) still get distinct dispatches.
        //   instanceId — legacy/fallback. Matches multiple tabs when they
        //                share an instanceId, which is the bug "open notes
        //                on Alpha moves all my tabs in sync" — kept for
        //                backward compatibility with older agents/tools.
        //
        // If neither field is set, the dispatch is a broadcast and every
        // tab handles it (e.g. nav.switch_tab on all mirrored windows).
        if (payload.connId && this.connId && payload.connId !== this.connId) {
            return;
        }
        if (
            !payload.connId &&
            payload.instanceId &&
            this.instanceId &&
            payload.instanceId !== this.instanceId
        ) {
            return;
        }

        let response: ControlActionResult;
        try {
            response = await this.dispatchInternal(payload);
        } catch (err) {
            response = {
                ok: false,
                error: (err as Error).message ?? String(err),
            };
        }

        await this.sendResponse(payload.requestId, response);
    }

    private async dispatchInternal(payload: UIRequestPayload): Promise<ControlActionResult> {
        const action = payload.action;

        // Built-in meta actions — handled by the bus itself, not by views.
        // `list_views` and `get_state` are read-only introspection so we let
        // them through even while paused (the agent needs to be able to
        // poll state to know if/when the user resumed).
        if (action === "list_views") {
            return { ok: true, result: this.list() };
        }
        if (action === "get_state") {
            const view = (payload.args?.view ?? payload.view) as string;
            if (!view) return { ok: false, error: "view name required for get_state" };
            const c = this.controllers.get(view);
            if (!c) return { ok: false, error: `view not registered: ${view}` };
            try {
                return { ok: true, result: c.getState() };
            } catch (err) {
                return { ok: false, error: (err as Error).message ?? String(err) };
            }
        }
        // Read-only window introspection (local or from another federation
        // node): allowed while paused, like get_state.
        if (payload.view === "window" && (action === "screenshot" || action === "state")) {
            try {
                const capture = await import("./window-capture");
                if (action === "state") return { ok: true, result: capture.windowState() };
                const a = payload.args ?? {};
                return {
                    ok: true,
                    result: await capture.captureWindow({
                        maxWidth: typeof a.maxWidth === "number" ? a.maxWidth : undefined,
                        quality: typeof a.quality === "number" ? a.quality : undefined,
                    }),
                };
            } catch (err) {
                return { ok: false, error: `window ${action} failed: ${(err as Error).message ?? String(err)}` };
            }
        }
        if (payload.view === "window" && action === "focus") {
            try {
                window.focus();
                return { ok: true, result: { focused: true } };
            } catch (err) {
                return { ok: false, error: (err as Error).message ?? String(err) };
            }
        }

        // Pause gate — every state-changing dispatch is blocked until the
        // user resumes. We still raise the lifecycle events so the toast
        // can show "blocked: <action>" feedback in real time.
        if (this.paused) {
            this.emitLifecycleEvent("ui-control:action-started", {
                view: payload.view,
                action,
                args: payload.args,
            });
            const blocked: ControlActionResult = {
                ok: false,
                error: "ui paused by user — resume to allow agent actions",
            };
            this.emitLifecycleEvent("ui-control:action-finished", {
                view: payload.view,
                action,
                args: payload.args,
                result: blocked,
            });
            return blocked;
        }

        // Per-view dispatch.
        const c = this.controllers.get(payload.view);
        if (!c) {
            return {
                ok: false,
                error: `view not registered: ${payload.view}. Available: ${[...this.controllers.keys()].join(", ") || "(none)"}`,
            };
        }
        const fullAction = mergeControlAction(action, payload.args);
        // Ask the view to resolve the visual target BEFORE we dispatch so
        // the Live Action overlay can fly its cursor to the right element
        // in parallel with the underlying action running. Resolver is
        // best-effort — exceptions become a null target.
        let target: ReturnType<NonNullable<ViewController["resolveActionTarget"]>> = undefined;
        try {
            target = c.resolveActionTarget?.(fullAction);
        } catch { /* best-effort */ }
        this.emitLifecycleEvent("ui-control:action-started", {
            view: payload.view,
            action,
            args: payload.args,
            target,
        });
        try {
            // Agent-driven: a tab change inside this dispatch carries the
            // user's chat along (chat/chat-follow-nav.ts).
            const result = await withAgentNav(() => c.dispatch(fullAction));
            this.emitLifecycleEvent("ui-control:action-finished", {
                view: payload.view,
                action,
                args: payload.args,
                target,
                result,
            });
            return result;
        } catch (err) {
            // Surface the controller exception with the view+action context
            // so the agent isn't left interpreting a bare "...is undefined"
            // as "the whole UI dropped." Include the action it tried.
            const message = (err as Error).message ?? String(err);
            const errResult: ControlActionResult = {
                ok: false,
                error: `view "${payload.view}" action "${action}" threw: ${message}`,
            };
            this.emitLifecycleEvent("ui-control:action-finished", {
                view: payload.view,
                action,
                args: payload.args,
                target,
                result: errResult,
            });
            return errResult;
        }
    }

    /** Fire a window-level CustomEvent so any UI component can react to
     *  agent-driven dispatches (e.g. the Live Action overlay). Safe in
     *  non-browser test environments — no-ops when `window` is missing. */
    private emitLifecycleEvent(name: string, detail: ControlBusEventDetail): void {
        try {
            if (typeof window === "undefined") return;
            window.dispatchEvent(new CustomEvent<ControlBusEventDetail>(name, { detail }));
        } catch {
            /* CustomEvent unavailable in some headless test contexts. */
        }
    }

    private async sendResponse(requestId: string, result: ControlActionResult): Promise<void> {
        if (!this.client) return;
        try {
            await this.client.request("ui.response", {
                requestId,
                ok: result.ok,
                payload: result.result,
                error: result.error,
            });
        } catch (err) {
            // Server may have already timed out — non-fatal.
            console.warn("[ui-control] failed to send ui.response:", (err as Error).message);
        }
    }
}

export const UIControlBus = new UIControlBusImpl();

/**
 * Convenience helper for lit-element views. Register in connectedCallback,
 * unregister in disconnectedCallback.
 */
export function attachViewController<S>(controller: ViewController<S>): RegistrationHandle {
    return UIControlBus.register(controller);
}
