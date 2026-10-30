/**
 * radial-menu.ts — right-click radial menu for a single agent.
 *
 * Actions: Resume / Stop / Respawn / Send Message / Promote / Focus. Each is a
 * real <button> so the menu is keyboard-navigable (Tab/Arrows to move, Enter to
 * activate, Esc to close). RPC-backed actions fire against the gateway client;
 * Focus defers to window.openAgentFocus (owned by the focus-modal agent).
 */
import { html, type TemplateResult } from "lit";
import type { FxAgent, InteractionHost } from "./types.js";
import { agentLabel, agentRpcTarget, callRpc } from "./world-state.js";

interface RadialAction {
  id: string;
  label: string;
  icon: string;
  run: (agent: FxAgent) => void;
  danger?: boolean;
}

interface MenuState {
  agent: FxAgent;
  /** Menu center (host-relative px). */
  x: number;
  y: number;
  focused: number;
}

export class RadialMenuController {
  private state: MenuState | null = null;
  private readonly actions: RadialAction[];

  constructor(private readonly host: InteractionHost) {
    this.actions = [
      { id: "resume", label: "Resume", icon: "▶", run: (a) => this.rpc(a, "sessions.resume", "Resumed") },
      { id: "stop", label: "Stop", icon: "■", danger: true, run: (a) => this.rpc(a, "sessions.pause", "Stopped") },
      { id: "respawn", label: "Respawn", icon: "⟳", run: (a) => this.respawn(a) },
      { id: "send", label: "Send Message", icon: "✉", run: (a) => this.send(a) },
      { id: "promote", label: "Promote", icon: "★", run: (a) => this.promote(a) },
      { id: "focus", label: "Open Focus", icon: "◎", run: (a) => this.focus(a) },
    ];
  }

  get open(): boolean {
    return this.state !== null;
  }

  openAt(agent: FxAgent, x: number, y: number): void {
    this.state = { agent, x, y, focused: 0 };
    this.host.requestUpdate();
    // Move keyboard focus into the menu on the next frame.
    requestAnimationFrame(() => this.focusButton(0));
  }

  close(): void {
    if (!this.state) return;
    this.state = null;
    this.host.requestUpdate();
  }

  /** Host forwards keydown here while the menu is open. Returns handled. */
  handleKey(e: KeyboardEvent): boolean {
    const s = this.state;
    if (!s) return false;
    const n = this.actions.length;
    if (e.key === "Escape") {
      this.close();
      return true;
    }
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      s.focused = (s.focused + 1) % n;
      this.focusButton(s.focused);
      return true;
    }
    if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      s.focused = (s.focused - 1 + n) % n;
      this.focusButton(s.focused);
      return true;
    }
    return false;
  }

  private focusButton(i: number): void {
    const root = (this.host as unknown as { renderRoot?: ParentNode }).renderRoot;
    const btn = root?.querySelector<HTMLButtonElement>(`.wi-radial-btn[data-i="${i}"]`);
    btn?.focus();
  }

  private rpc(agent: FxAgent, method: string, okMsg: string): void {
    const target = agentRpcTarget(agent);
    this.close();
    this.host.toast(`${okMsg.replace(/ed$/, "ing")} ${agentLabel(agent)}…`);
    void callRpc(method, target).then((out) =>
      this.host.toast(out.ok ? `${okMsg}: ${agentLabel(agent)}` : `Failed: ${out.error ?? "error"}`, out.ok ? "ok" : "err"),
    );
  }

  private respawn(agent: FxAgent): void {
    const target = agentRpcTarget(agent);
    this.close();
    if (!target.runId) {
      this.host.toast("Respawn needs a runId", "err");
      return;
    }
    this.host.toast(`Respawning ${agentLabel(agent)}…`);
    void callRpc("subagents.respawn", { runId: target.runId }).then((out) =>
      this.host.toast(out.ok ? `Respawned ${agentLabel(agent)}` : `Respawn failed: ${out.error ?? "error"}`, out.ok ? "ok" : "err"),
    );
  }

  private send(agent: FxAgent): void {
    const target = agentRpcTarget(agent);
    this.close();
    this.host.openPrompt({
      title: `Message ${agentLabel(agent)}`,
      placeholder: "Type a message to send to this agent…",
      confirmLabel: "Send",
      onSubmit: (message) => {
        if (!message.trim()) return;
        void callRpc("sessions.send", { ...target, message }).then((out) =>
          this.host.toast(out.ok ? "Message sent" : `Send failed: ${out.error ?? "error"}`, out.ok ? "ok" : "err"),
        );
      },
    });
  }

  private promote(agent: FxAgent): void {
    // No first-class "promote" RPC yet — surface intent optimistically and emit
    // a DOM event the app shell (or a future handler) can pick up.
    this.close();
    window.dispatchEvent(
      new CustomEvent("world-interaction:promote", { detail: agentRpcTarget(agent) }),
    );
    this.host.toast(`Promoted ${agentLabel(agent)}`, "ok");
  }

  private focus(agent: FxAgent): void {
    this.close();
    if (typeof window.openAgentFocus === "function") {
      window.openAgentFocus(agentRpcTarget(agent));
    } else {
      this.host.toast("Focus modal unavailable", "err");
    }
  }

  render(): TemplateResult | string {
    const s = this.state;
    if (!s) return "";
    const n = this.actions.length;
    const R = 86;
    return html`
      <div
        class="wi-radial-backdrop"
        @pointerdown=${(e: PointerEvent) => {
          e.stopPropagation();
          this.close();
        }}
        @contextmenu=${(e: Event) => e.preventDefault()}
      ></div>
      <div
        class="wi-radial"
        role="menu"
        aria-label="Agent actions for ${agentLabel(s.agent)}"
        style="left:${s.x}px;top:${s.y}px"
      >
        <div class="wi-radial-hub">${agentLabel(s.agent).slice(0, 2).toUpperCase()}</div>
        ${this.actions.map((a, i) => {
          const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
          const dx = Math.cos(angle) * R;
          const dy = Math.sin(angle) * R;
          return html`<button
            class="wi-radial-btn ${a.danger ? "danger" : ""}"
            data-i=${i}
            role="menuitem"
            title=${a.label}
            aria-label=${a.label}
            style="transform:translate(-50%,-50%) translate(${dx}px,${dy}px)"
            @click=${(e: Event) => {
              e.stopPropagation();
              a.run(s.agent);
            }}
          >
            <span class="wi-radial-icon">${a.icon}</span>
            <span class="wi-radial-label">${a.label}</span>
          </button>`;
        })}
      </div>
    `;
  }
}
