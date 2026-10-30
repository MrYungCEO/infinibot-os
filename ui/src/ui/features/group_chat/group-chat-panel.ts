/**
 * <ib-group-chat-panel> — Grid panel host: a group picker (plus "new group")
 * around <ib-group-chat>. Same data as the Chat page; the selected group is
 * reported via `group-select` so the Grid can persist it on the panel.
 */
import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../../gateway";
import type { AgentsListResult, GatewayAgentRow, GatewaySessionRow, SessionsListResult } from "../../types";
import { icons } from "../../icons";
import { GROUP_CHAT_PREFIX } from "../../../../../src/shared/group-chat/keys.js";
import "./group-chat-view";
import "./group-chat-dialog";
import type { GroupDialogValue } from "./group-chat-dialog";
import { isSecureSessionKey, SecureModeController } from "../../secure-mode";

@customElement("ib-group-chat-panel")
export class GroupChatPanel extends LitElement {
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;
  @property({ type: Boolean }) connected = true;
  @property() groupKey: string | null = null;
  @property() initialTab: "chat" | "workflows" = "chat";

  @state() private groups: GatewaySessionRow[] = [];
  @state() private agents: GatewayAgentRow[] = [];
  @state() private creating = false;
  @state() private createBusy = false;
  @state() private createError: string | null = null;
  /** Create dialog opens with "Secure group" preselected. */
  @state() private createSecure = false;
  private secureWasActive = false;
  private secureMode = new SecureModeController(this, {
    onChange: () => {
      // Secure groups appear / disappear from the picker as Secure Mode flips.
      if (this.secureMode.active !== this.secureWasActive) {
        this.secureWasActive = this.secureMode.active;
        if (this.client && this.connected) void this.load();
      }
    },
  });
  private loadedFor: GatewayBrowserClient | null = null;

  protected willUpdate(changed: PropertyValues): void {
    if ((changed.has("client") || changed.has("connected")) && this.client && this.connected && this.loadedFor !== this.client) {
      this.loadedFor = this.client;
      void this.load();
    }
    if (changed.has("groupKey") && this.groupKey && this.initialTab === "workflows") {
      try {
        const k = `infinibot.groupchat.view.${this.groupKey}`;
        const v = JSON.parse(localStorage.getItem(k) || "{}") as Record<string, unknown>;
        localStorage.setItem(k, JSON.stringify({ ...v, tab: "workflows" }));
      } catch {
        /* ignore */
      }
    }
  }

  private async load() {
    if (!this.client) return;
    try {
      const [s, a] = await Promise.all([
        this.client.request<SessionsListResult>("sessions.list", { sessionPrefixes: [GROUP_CHAT_PREFIX], limit: 100, includeDerivedTitles: true }),
        this.client.request<AgentsListResult>("agents.list", {}),
      ]);
      this.secureWasActive = this.secureMode.active;
      // Secure groups are hidden while Secure Mode is off (except the open one).
      this.groups = (Array.isArray(s?.sessions) ? s.sessions : []).filter(
        (g) => !isSecureSessionKey(g.key) || this.secureMode.active || g.key === this.groupKey,
      );
      this.agents = Array.isArray(a?.agents) ? a.agents : [];
      if (!this.groupKey && this.groups[0]) this.select(this.groups[0].key);
    } catch (err) {
      console.warn("[group-chat-panel] load failed", err);
    }
  }

  private select(key: string) {
    this.groupKey = key;
    this.dispatchEvent(new CustomEvent("group-select", { detail: { key }, bubbles: true, composed: true }));
  }

  private async create(v: GroupDialogValue) {
    if (!this.client) return;
    this.createBusy = true;
    this.createError = null;
    try {
      const res = await this.client.request<{ key: string }>("groupchat.create", v);
      this.creating = false;
      await this.load();
      this.select(res.key);
    } catch (err) {
      this.createError = String((err as Error)?.message ?? err).replace(/^Error:\s*/, "");
    } finally {
      this.createBusy = false;
    }
  }

  render() {
    return html`
      <div class="gp">
        <div class="gp-bar">
          <select
            aria-label="Group chat"
            @change=${(e: Event) => this.select((e.target as HTMLSelectElement).value)}
          >
            ${this.groups.length === 0 ? html`<option value="">No group chats yet</option>` : nothing}
            ${this.groups.map((g) => html`<option value=${g.key} ?selected=${g.key === this.groupKey}>${isSecureSessionKey(g.key) ? "[Secure] " : ""}${g.label || g.derivedTitle || "Group chat"}</option>`)}
          </select>
          ${this.client?.supports?.("groupchat.create") === false
            ? nothing
            : html`<button class="gp-btn" @click=${() => {
                this.createSecure = false;
                this.creating = true;
              }}>${icons.plus}<span>New group</span></button>`}
        </div>
        ${this.groupKey
          ? html`<ib-group-chat compact @secure-group-new=${() => {
              this.createSecure = true;
              this.creating = true;
            }} .client=${this.client} .connected=${this.connected} .sessionKey=${this.groupKey} .agents=${this.agents}></ib-group-chat>`
          : html`<div class="gp-empty">Create a group chat to talk to several agents at once.</div>`}
        ${this.creating
          ? html`<ib-group-chat-dialog
              .initial=${{ secure: this.createSecure }}
              .agents=${this.agents}
              .client=${this.client}
              .connected=${this.connected}
              .busy=${this.createBusy}
              .error=${this.createError}
              @cancel=${() => (this.creating = false)}
              @submit=${(e: CustomEvent<GroupDialogValue>) => void this.create(e.detail)}
            ></ib-group-chat-dialog>`
          : nothing}
      </div>
    `;
  }

  static styles = css`
    :host { display: block; height: 100%; min-height: 0; color: var(--text); font-family: var(--glass-font, var(--font-body, inherit)); }
    .gp { display: flex; flex-direction: column; height: 100%; min-height: 0; }
    .gp-bar { display: flex; gap: 8px; padding: 8px 10px; border-bottom: 1px solid var(--g-border, var(--border)); }
    .gp-bar select { flex: 1; min-width: 0; font: inherit; font-size: 13px; color: var(--text); background: var(--g-surface, var(--card)); border: 1px solid var(--g-border, var(--border)); border-radius: 8px; min-height: 34px; padding: 0 8px; }
    .gp-btn { display: inline-flex; align-items: center; gap: 6px; font: inherit; font-size: 13px; color: var(--text); background: var(--g-surface, var(--card)); border: 1px solid var(--g-border, var(--border)); border-radius: 8px; min-height: 34px; padding: 0 10px; cursor: pointer; }
    .gp-btn svg { width: 14px; height: 14px; }
    ib-group-chat { flex: 1; min-height: 0; }
    .gp-empty { padding: 24px; text-align: center; color: var(--muted); }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "ib-group-chat-panel": GroupChatPanel;
  }
}
