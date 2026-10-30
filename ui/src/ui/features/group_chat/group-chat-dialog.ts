/**
 * <ib-group-chat-dialog> — create a group chat or edit its members / mode,
 * plus the group's model + thinking level (the 1:1 <webchat-model-picker>).
 * Purely presentational: emits `submit` / `cancel`; the host does the RPC.
 */
import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../../gateway";
import type { GatewayAgentRow } from "../../types";
import type { RepoInfo } from "../../../../../src/shared/group-chat/context.js";
import type { GroupChatBinding } from "../../../../../src/shared/group-chat/types.js";
import "./group-context-ui";
import "../../components/webchat-model-picker";
import type { GroupRunSettings } from "../../../../../src/shared/group-chat/settings.js";
import { icons } from "../../icons";
import { agentHue, initials, MODE_LABELS, type GroupDescription } from "./logic";
import { SecureModeController } from "../../secure-mode/store";
import "../../secure-mode/secure-toggle";

export type GroupDialogValue = {
  title: string;
  members: string[];
  mode: GroupDescription["mode"];
  moderatorId: string;
  /** Shared repo / project / purpose. `null` = cleared in the edit dialog. */
  binding: GroupChatBinding | null;
  /** Group-wide model / thinking (empty = each agent's own defaults). */
  settings?: GroupRunSettings;
  /** Create as a Secure Mode group (local models, no network tools, RAM transcripts). */
  secure?: boolean;
};

@customElement("ib-group-chat-dialog")
export class GroupChatDialog extends LitElement {
  @property({ attribute: false }) agents: GatewayAgentRow[] = [];
  @property({ type: Boolean }) connected = false;
  @property({ attribute: false }) initial: Partial<GroupDialogValue> | null = null;
  @property() heading = "New group chat";
  @property() submitLabel = "Create group";
  @property({ type: Boolean }) busy = false;
  @property() error: string | null = null;
  /** For the project picker in the shared-workspace fields and the model picker's catalog (models.list). */
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;
  /** Live git state of the bound repo (edit dialog). */
  @property({ attribute: false }) repo: RepoInfo | null = null;
  /** Offer the "Secure group" switch (create dialog only; a group's lane is fixed). */
  @property({ type: Boolean }) secureOption = true;

  @state() private groupName = "";
  @state() private members: string[] = [];
  @state() private mode: GroupDescription["mode"] = "everyone";
  @state() private moderatorId = "";
  @state() private filter = "";
  @state() private binding: GroupChatBinding = {};
  @state() private settings: GroupRunSettings = {};
  @state() private secure = false;
  private secureMode = new SecureModeController(this);

  connectedCallback(): void {
    super.connectedCallback();
    const i = this.initial ?? {};
    this.groupName = i.title ?? "";
    this.members = [...(i.members ?? [])];
    this.mode = i.mode ?? "everyone";
    this.moderatorId = i.moderatorId ?? "";
    this.binding = { ...(i.binding ?? {}) };
    this.settings = { ...(i.settings ?? {}) };
    this.secure = i.secure === true;
    window.addEventListener("keydown", this.onKey);
    void this.updateComplete.then(() => this.renderRoot.querySelector<HTMLInputElement>(".gd-title")?.focus());
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener("keydown", this.onKey);
  }

  private onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") this.cancel();
  };

  private cancel() {
    this.dispatchEvent(new CustomEvent("cancel", { bubbles: true, composed: true }));
  }

  private toggle(id: string) {
    this.members = this.members.includes(id) ? this.members.filter((m) => m !== id) : [...this.members, id];
  }

  private submit(e?: Event) {
    e?.preventDefault();
    if (this.members.length === 0 || this.busy) return;
    const moderatorId = this.members.includes(this.moderatorId) ? this.moderatorId : this.members[0];
    this.dispatchEvent(
      new CustomEvent<GroupDialogValue>("submit", {
        detail: {
          title: this.groupName.trim(),
          members: this.members,
          mode: this.mode,
          moderatorId,
          binding: Object.keys(this.binding).length ? this.binding : null,
          ...(this.settings.model || this.settings.thinkingLevel ? { settings: { ...this.settings } } : {}),
          ...(this.secureOption && this.secure && this.secureMode.active ? { secure: true } : {}),
        },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private name(a: GatewayAgentRow) {
    return a.identity?.name || a.name || a.id;
  }

  render() {
    const f = this.filter.trim().toLowerCase();
    const list = this.agents.filter((a) => !f || a.id.includes(f) || this.name(a).toLowerCase().includes(f));
    const chosen = this.members.map((id) => this.agents.find((a) => a.id === id) ?? ({ id } as GatewayAgentRow));
    return html`
      <div class="gd-backdrop" @click=${() => this.cancel()}></div>
      <form class="gd" role="dialog" aria-modal="true" aria-label=${this.heading} @submit=${(e: Event) => this.submit(e)}>
        <header class="gd-head">
          <span class="gd-head-ico">${icons.users}</span>
          <h2>${this.heading}</h2>
          <button type="button" class="gd-x" aria-label="Close" @click=${() => this.cancel()}>${icons.x}</button>
        </header>
        <label class="gd-field">
          <span>Name</span>
          <input
            class="gd-title"
            placeholder="e.g. Launch crew (optional)"
            maxlength="120"
            .value=${this.groupName}
            @input=${(e: Event) => (this.groupName = (e.target as HTMLInputElement).value)}
          />
        </label>
        <div class="gd-field">
          <span>Agents <em>${this.members.length} selected — order sets who speaks first</em></span>
          ${chosen.length
            ? html`<div class="gd-chosen">
                ${chosen.map(
                  (a, i) => html`<span class="gd-pill">
                    <b>${i + 1}</b>${this.name(a)}
                    <button type="button" aria-label=${`Remove ${this.name(a)}`} @click=${() => this.toggle(a.id)}>${icons.x}</button>
                  </span>`,
                )}
              </div>`
            : nothing}
          ${this.agents.length > 8
            ? html`<input class="gd-filter" placeholder="Search agents" .value=${this.filter} @input=${(e: Event) => (this.filter = (e.target as HTMLInputElement).value)} />`
            : nothing}
          <div class="gd-agents" role="listbox" aria-multiselectable="true">
            ${list.map((a) => {
              const on = this.members.includes(a.id);
              const url = a.identity?.avatarUrl;
              return html`<button
                type="button"
                role="option"
                aria-selected=${on ? "true" : "false"}
                class="gd-agent ${on ? "gd-agent--on" : ""}"
                @click=${() => this.toggle(a.id)}
              >
                ${url
                  ? html`<img class="gd-av" src=${url} alt="" />`
                  : html`<span class="gd-av" style="--h:${agentHue(a.id)}">${initials(this.name(a))}</span>`}
                <span class="gd-agent-txt"><span class="gd-agent-name">${this.name(a)}</span><span class="gd-agent-id">@${a.id}</span></span>
                <span class="gd-check">${on ? icons.check : nothing}</span>
              </button>`;
            })}
            ${list.length === 0 ? html`<div class="gd-none">No agents found</div>` : nothing}
          </div>
        </div>
        <div class="gd-field">
          <span>Who replies</span>
          <div class="gd-modes" role="radiogroup">
            ${(Object.keys(MODE_LABELS) as GroupDescription["mode"][]).map(
              (m) => html`<label class="gd-mode ${this.mode === m ? "gd-mode--on" : ""}">
                <input type="radio" name="mode" .checked=${this.mode === m} @change=${() => (this.mode = m)} />
                <span class="gd-mode-label">${MODE_LABELS[m].label}</span>
                <span class="gd-mode-hint">${MODE_LABELS[m].hint}</span>
              </label>`,
            )}
          </div>
          <span class="gd-tip">Tip: @mention an agent in any message to have just them answer.</span>
        </div>
        ${this.mode === "moderator" && this.members.length
          ? html`<label class="gd-field">
              <span>Moderator (lead)</span>
              <select @change=${(e: Event) => (this.moderatorId = (e.target as HTMLSelectElement).value)}>
                ${chosen.map((a) => html`<option value=${a.id} ?selected=${(this.moderatorId || this.members[0]) === a.id}>${this.name(a)}</option>`)}
              </select>
            </label>`
          : nothing}
        <ib-group-binding-fields
          .client=${this.client}
          .value=${this.binding}
          .repo=${this.repo}
          @binding-change=${(e: CustomEvent<GroupChatBinding>) => (this.binding = e.detail)}
        ></ib-group-binding-fields>
        ${this.client
          ? html`<div class="gd-field gd-field--model">
              <!-- Sheet mode: the dialog scrolls (overflow:auto) and would clip a dropdown. -->
              <span>Model &amp; thinking <em>for every member — override one later from the sliders button</em></span>
              <webchat-model-picker
                compact
                mobile
                .client=${this.client}
                .connected=${this.connected}
                .value=${this.settings.model ?? null}
                .defaultModel=${null}
                .defaultLabel=${"Agent defaults"}
                .overridden=${Boolean(this.settings.model)}
                .thinkingLevel=${this.settings.thinkingLevel ?? null}
                @model-select=${(e: CustomEvent<{ model: string | null }>) => {
                  const { model: _m, ...rest } = this.settings;
                  this.settings = e.detail.model ? { ...rest, model: e.detail.model } : rest;
                }}
                @thinking-select=${(e: CustomEvent<{ level: string | null }>) => {
                  const { thinkingLevel: _t, ...rest } = this.settings;
                  this.settings = e.detail.level ? { ...rest, thinkingLevel: e.detail.level } : rest;
                }}
              ></webchat-model-picker>
            </div>`
          : nothing}
        ${this.secureOption && this.secureMode.state.supported !== false
          ? html`<div class="gd-field gd-secure ${this.secure && this.secureMode.active ? "gd-secure--on" : ""}">
              <span>Secure group <em>${this.secureMode.active
                ? "local models only · encrypted · network tools off"
                : "turn on Secure Mode first (top bar badge or any Secure Mode switch)"}</em></span>
              <ib-secure-toggle
                compact
                mode="custom"
                label="Secure group"
                data-secure-surface="group-create"
                .on=${this.secure && this.secureMode.active}
                .disabled=${!this.secureMode.active}
                .note=${this.secureMode.active ? null : "Secure Mode is off"}
                @secure-toggle=${(e: CustomEvent<{ on: boolean }>) => (this.secure = e.detail.on)}
              ></ib-secure-toggle>
            </div>`
          : nothing}
        ${this.error ? html`<div class="gd-error" role="alert">${this.error}</div>` : nothing}
        <footer class="gd-foot">
          <button type="button" class="gd-btn" @click=${() => this.cancel()}>Cancel</button>
          <button type="submit" class="gd-btn gd-btn--primary" ?disabled=${this.members.length === 0 || this.busy}>
            ${this.busy ? "Saving…" : this.submitLabel}
          </button>
        </footer>
      </form>
    `;
  }

  static styles = css`
    :host { position: fixed; inset: 0; z-index: 10000; display: grid; place-items: center; padding: 16px; box-sizing: border-box; color: var(--text); font-family: var(--glass-font, var(--font-body, inherit)); }
    .gd-backdrop { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.55); backdrop-filter: blur(3px); }
    .gd { position: relative; width: min(560px, 100%); max-height: 100%; overflow: auto; overscroll-behavior: contain; box-sizing: border-box; display: flex; flex-direction: column; gap: 14px; padding: 18px; border-radius: var(--g-radius, 14px); background: var(--glass-solid, var(--bg-elevated, #16181d)); border: 1px solid var(--g-border, var(--border)); box-shadow: 0 24px 60px rgba(0, 0, 0, 0.45); }
    .gd-head { display: flex; align-items: center; gap: 10px; }
    .gd-head h2 { margin: 0; font-size: 18px; flex: 1; }
    .gd-head-ico svg { width: 20px; height: 20px; color: var(--g-primary, var(--accent)); }
    .gd-x { width: 36px; height: 36px; display: grid; place-items: center; border-radius: 8px; border: none; background: transparent; color: var(--muted); cursor: pointer; }
    .gd-x svg { width: 18px; height: 18px; }
    .gd-field { display: flex; flex-direction: column; gap: 6px; font-size: 13px; color: var(--muted); }
    .gd-secure { padding: 10px 12px; border-radius: 12px; border: 1px dashed var(--g-border, var(--border)); }
    .gd-secure ib-secure-toggle { align-self: flex-start; }
    .gd-secure--on { border-style: solid; border-color: var(--ib-secure-ring, rgba(52, 211, 153, 0.5)); background: var(--ib-secure-soft, rgba(52, 211, 153, 0.13)); }
    .gd-field em { font-style: normal; opacity: 0.8; margin-left: 6px; }
    .gd-field input, .gd-field select { font: inherit; font-size: 15px; color: var(--text); background: var(--g-surface, var(--card)); border: 1px solid var(--g-border, var(--border)); border-radius: 10px; padding: 9px 12px; min-height: 42px; box-sizing: border-box; }
    .gd-chosen { display: flex; flex-wrap: wrap; gap: 6px; }
    .gd-pill { display: inline-flex; align-items: center; gap: 6px; padding: 3px 4px 3px 10px; border-radius: 999px; background: color-mix(in srgb, var(--g-primary, var(--accent)) 16%, transparent); color: var(--text); font-size: 13px; }
    .gd-pill b { font-size: 11px; opacity: 0.7; }
    .gd-pill button { width: 24px; height: 24px; display: grid; place-items: center; border: none; border-radius: 50%; background: transparent; color: inherit; cursor: pointer; }
    .gd-pill svg { width: 13px; height: 13px; }
    .gd-agents { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 6px; max-height: 260px; overflow: auto; }
    .gd-agent { display: flex; align-items: center; gap: 10px; min-height: 48px; padding: 6px 10px; border-radius: 10px; border: 1px solid var(--g-border, var(--border)); background: var(--g-surface, var(--card)); color: var(--text); font: inherit; text-align: left; cursor: pointer; }
    .gd-agent--on { border-color: var(--g-primary, var(--accent)); background: color-mix(in srgb, var(--g-primary, var(--accent)) 10%, var(--g-surface, var(--card))); }
    .gd-av { width: 32px; height: 32px; flex: none; border-radius: 50%; display: grid; place-items: center; font-size: 12px; font-weight: 700; color: #fff; background: hsl(var(--h, 210) 55% 42%); object-fit: cover; }
    .gd-agent-txt { display: flex; flex-direction: column; min-width: 0; flex: 1; }
    .gd-agent-name { font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .gd-agent-id { font-size: 12px; color: var(--muted); }
    .gd-check { width: 18px; height: 18px; color: var(--g-primary, var(--accent)); }
    .gd-check svg { width: 18px; height: 18px; }
    .gd-none { padding: 12px; color: var(--muted); }
    .gd-modes { display: grid; gap: 6px; }
    .gd-mode { display: grid; grid-template-columns: auto 1fr; column-gap: 10px; align-items: center; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--g-border, var(--border)); cursor: pointer; }
    .gd-mode--on { border-color: var(--g-primary, var(--accent)); }
    .gd-mode input { grid-row: span 2; accent-color: var(--g-primary, var(--accent)); width: 16px; height: 16px; }
    .gd-mode-label { color: var(--text); font-size: 14px; font-weight: 600; }
    .gd-mode-hint { font-size: 12px; }
    .gd-tip { font-size: 12px; }
    .gd-field--model { position: relative; }
    .gd-field--model webchat-model-picker { align-self: flex-start; }
    .gd-error { color: var(--danger, #e5484d); font-size: 13px; }
    .gd-foot { display: flex; justify-content: flex-end; gap: 8px; }
    .gd-btn { min-height: 42px; padding: 0 18px; border-radius: 10px; border: 1px solid var(--g-border, var(--border)); background: transparent; color: var(--text); font: inherit; font-size: 14px; cursor: pointer; }
    .gd-btn--primary { background: var(--g-primary, var(--accent)); border-color: var(--g-primary, var(--accent)); color: var(--accent-foreground, #111); font-weight: 600; }
    .gd-btn[disabled] { opacity: 0.5; cursor: not-allowed; }
    .gd-filter { margin-bottom: 4px; }
    /* Phones: the app's top bar stacks above page content, keep the sheet clear of it. */
    @media (max-width: 800px) {
      :host { padding: 68px 10px 10px; place-items: start center; }
      .gd { padding: 14px; }
      .gd-agents { grid-template-columns: 1fr; max-height: 34vh; }
    }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "ib-group-chat-dialog": GroupChatDialog;
  }
}
