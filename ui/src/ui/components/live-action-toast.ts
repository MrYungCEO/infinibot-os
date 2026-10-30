import { LitElement, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import type { ControlBusEventDetail } from "../control-bus";
import { UIControlBus } from "../control-bus";

/**
 * Live Action Toast — top-left pill that surfaces every agent UI-control
 * action while Live Action Mode is engaged. Listens for the lifecycle
 * events the `UIControlBus` emits around each dispatch:
 *
 *   window 'ui-control:action-started'  → show pulsing toast
 *   window 'ui-control:action-finished' → flip to success/error, fade out
 *
 * The toast does NOT animate a fake cursor (that's a deeper feature for
 * Phase 3). For now the user gets immediate "I see the agent is doing X"
 * feedback without any cursor choreography. The pill stays visible while
 * the action is in flight, then auto-dismisses ~1.2s after completion.
 *
 * Mounted globally at the app root (see app-render.ts) so it floats above
 * any tab content — including the kanban view the agent is operating on.
 */

interface ActiveToast {
    view: string;
    action: string;
    text: string;
    status: "running" | "success" | "error";
}

@customElement("live-action-toast")
export class LiveActionToast extends LitElement {
    @state() private active: ActiveToast | null = null;
    @state() private paused = false;
    private fadeTimer: ReturnType<typeof setTimeout> | null = null;
    private startedHandler = (evt: Event) => this.onStarted(evt as CustomEvent<ControlBusEventDetail>);
    private finishedHandler = (evt: Event) => this.onFinished(evt as CustomEvent<ControlBusEventDetail>);
    private pauseChangedHandler = (evt: Event) => {
        const next = (evt as CustomEvent<{ paused: boolean }>).detail?.paused ?? false;
        this.paused = next;
    };

    // Render in light DOM so the global stylesheet styles apply.
    createRenderRoot() {
        return this;
    }

    connectedCallback(): void {
        super.connectedCallback();
        window.addEventListener("ui-control:action-started", this.startedHandler);
        window.addEventListener("ui-control:action-finished", this.finishedHandler);
        window.addEventListener("ui-control:paused-changed", this.pauseChangedHandler);
        // Catch up to the bus's current pause state on mount so a toast
        // that gets re-mounted (tab switch, hot reload) still reflects
        // the user's choice instead of resetting to "running".
        this.paused = UIControlBus.isPaused();
    }

    disconnectedCallback(): void {
        window.removeEventListener("ui-control:action-started", this.startedHandler);
        window.removeEventListener("ui-control:action-finished", this.finishedHandler);
        window.removeEventListener("ui-control:paused-changed", this.pauseChangedHandler);
        if (this.fadeTimer) clearTimeout(this.fadeTimer);
        super.disconnectedCallback();
    }

    private togglePause = () => {
        const next = !this.paused;
        UIControlBus.setPaused(next);
        // Optimistic local update — the event listener will reconcile if
        // some other tab also flipped the flag.
        this.paused = next;
        // While paused, keep the toast visible even after the in-flight
        // action's fade-out fires. Resuming clears that pin.
        if (this.fadeTimer && next) {
            clearTimeout(this.fadeTimer);
            this.fadeTimer = null;
        }
    };

    private prettify(view: string, action: string, args?: Record<string, unknown>): string {
        // Friendly humanization for the most common actions. Falls back to
        // "view · action" for anything not enumerated. Adding a case here
        // is the cheapest way to make a new action feel polished.
        const a = args ?? {};
        const truncate = (s: unknown, n = 40) => {
            const v = typeof s === "string" ? s : String(s ?? "");
            return v.length > n ? v.slice(0, n - 1) + "…" : v;
        };
        if (view === "kanban") {
            switch (action) {
                case "select_project":
                    return a.projectId ? `Opening project` : `Back to gallery`;
                case "set_gallery_filter":
                    return `Filtering projects: ${a.filter ?? "all"}`;
                case "set_gallery_search":
                    return `Searching: "${truncate(a.query, 24)}"`;
                case "toggle_gallery_view":
                    return `Switching view`;
                case "refresh":
                    return `Refreshing projects`;
                case "create_task":
                    return `Creating task: ${truncate(a.title, 30)}`;
                case "update_task_status":
                    return `Moving task to ${a.status ?? "?"}`;
            }
        }
        if (view === "voice_chat") {
            switch (action) {
                case "connect": return `Connecting voice`;
                case "disconnect": return `Disconnecting voice`;
                case "send_text": return `Sending: "${truncate(a.text, 28)}"`;
                case "open_settings": return `Opening voice settings`;
                case "close_settings": return `Closing voice settings`;
            }
        }
        if (action === "switch_tab") {
            return `Switching to ${a.tab ?? "tab"}`;
        }
        return `${view} · ${action}`;
    }

    private onStarted(evt: CustomEvent<ControlBusEventDetail>): void {
        const { view, action, args } = evt.detail;
        if (this.fadeTimer) {
            clearTimeout(this.fadeTimer);
            this.fadeTimer = null;
        }
        this.active = {
            view,
            action,
            text: this.prettify(view, action, args),
            status: "running",
        };
    }

    private onFinished(evt: CustomEvent<ControlBusEventDetail>): void {
        if (!this.active) return;
        const { view, action, result } = evt.detail;
        // Only react to the finish event matching the toast we're showing —
        // out-of-order events from rapid concurrent dispatches shouldn't
        // overwrite each other's status.
        if (this.active.view !== view || this.active.action !== action) return;
        const ok = result?.ok !== false;
        this.active = {
            ...this.active,
            status: ok ? "success" : "error",
            text: ok ? this.active.text : `${this.active.text} — ${result?.error ?? "failed"}`,
        };
        this.fadeTimer = setTimeout(() => {
            this.active = null;
            this.fadeTimer = null;
        }, 1400);
    }

    render() {
        // Keep the toast mounted while paused so the resume button stays
        // reachable even after the last in-flight action fades.
        if (!this.active && !this.paused) return nothing;
        const klass = ["live-action-toast"];
        if (this.paused) klass.push("is-paused");
        else if (this.active?.status === "success") klass.push("is-success");
        else if (this.active?.status === "error") klass.push("is-error");
        const text = this.paused
            ? this.active
                ? `Paused — ${this.active.text}`
                : "Agent paused"
            : this.active?.text ?? "";
        return html`
            <div class="${klass.join(" ")}">
                <span class="lat-dot" aria-hidden="true"></span>
                <span class="lat-text">${text}</span>
                <button
                    type="button"
                    class="lat-pause-btn"
                    title=${this.paused ? "Resume agent UI actions" : "Pause agent UI actions"}
                    aria-pressed=${this.paused ? "true" : "false"}
                    aria-label=${this.paused ? "Resume agent" : "Pause agent"}
                    @click=${this.togglePause}
                >${this.paused ? "▶ Resume" : "⏸ Pause"}</button>
            </div>
        `;
    }
}
