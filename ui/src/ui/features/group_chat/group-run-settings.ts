/**
 * <ib-group-run-settings> — the group's "Models & thinking" sheet.
 *
 * The same <webchat-model-picker> the 1:1 chat uses (model catalog, allowlist
 * add, inline provider connect, thinking levels), once for the whole group and
 * once per member as an override. Presentational: emits `settings-change`
 * ({ agentId?: string, patch }) and `close`; the host calls groupchat.update.
 */
import { LitElement, css, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../../gateway";
import { icons } from "../../icons";
import "../../components/webchat-model-picker";
import type { GroupRunSettingsPatch } from "../../../../../src/shared/group-chat/settings.js";
import { agentHue, initials, THINKING_LABELS, shortModel, type GroupDescription, type GroupMemberInfo } from "./logic";

export type GroupSettingsChange = { agentId?: string; patch: GroupRunSettingsPatch | null };

const SOURCE_LABEL = { member: "Override", group: "Group", agent: "Agent default" } as const;

@customElement("ib-group-run-settings")
export class GroupRunSettingsSheet extends LitElement {
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;
  @property({ type: Boolean }) connected = false;
  @property({ attribute: false }) group: GroupDescription | null = null;
  @property({ attribute: false }) members: GroupMemberInfo[] = [];
  /** agents.list default model per agent id ("provider/model"). */
  @property({ attribute: false }) agentModels: Record<string, string | null> = {};
  @property({ type: Boolean }) mobile = false;
  @property() error: string | null = null;

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("keydown", this.onKey);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener("keydown", this.onKey);
  }

  private onKey = (e: KeyboardEvent) => {
    // The picker closes itself on Escape first; only close the sheet when no menu is open.
    if (e.key === "Escape" && !e.defaultPrevented) this.close();
  };

  private close() {
    this.dispatchEvent(new CustomEvent("close", { bubbles: true, composed: true }));
  }

  private change(detail: GroupSettingsChange) {
    this.dispatchEvent(new CustomEvent<GroupSettingsChange>("settings-change", { detail, bubbles: true, composed: true }));
  }

  private avatar(m: GroupMemberInfo) {
    return m.avatarUrl
      ? html`<img class="rs-av" src=${m.avatarUrl} alt="" />`
      : html`<span class="rs-av" style="--h:${agentHue(m.id)}" aria-hidden="true">${initials(m.name)}</span>`;
  }

  render() {
    const g = this.group;
    if (!g) return nothing;
    const s = g.settings ?? {};
    return html`
      <div class="rs-backdrop" @click=${() => this.close()}></div>
      <section class="rs" role="dialog" aria-modal="true" aria-label="Models and thinking">
        <header class="rs-head">
          <span class="rs-head-ico">${icons.sliders}</span>
          <div class="rs-head-txt">
            <h2>Models &amp; thinking</h2>
            <p>Set once for the whole group, or override one member. Every member's next turn uses it.</p>
          </div>
          <button class="rs-x" aria-label="Close" @click=${() => this.close()}>${icons.x}</button>
        </header>

        <div class="rs-row rs-row--group" data-testid="rs-group">
          <span class="rs-av rs-av--group" aria-hidden="true">${icons.users}</span>
          <div class="rs-row-txt">
            <span class="rs-name">Whole group</span>
            <span class="rs-sub">${s.model ? shortModel(s.model) : "Each agent's own model"} · ${s.thinkingLevel ? `${THINKING_LABELS[s.thinkingLevel] ?? s.thinkingLevel} thinking` : "default thinking"}</span>
          </div>
          <webchat-model-picker
            compact
            align="end"
            .client=${this.client}
            .connected=${this.connected}
            .value=${s.model ?? null}
            .defaultModel=${null}
            .defaultLabel=${"Each agent's own"}
            .overridden=${Boolean(s.model)}
            .thinkingLevel=${s.thinkingLevel ?? null}
            .mobile=${this.mobile}
            @model-select=${(e: CustomEvent<{ model: string | null }>) => this.change({ patch: { model: e.detail.model } })}
            @thinking-select=${(e: CustomEvent<{ level: string | null }>) => this.change({ patch: { thinkingLevel: e.detail.level } })}
          ></webchat-model-picker>
        </div>

        <div class="rs-label">Per member</div>
        <div class="rs-list">
          ${this.members.map((m) => {
            const eff = g.effective?.[m.id];
            const own = g.memberSettings?.[m.id];
            const effModel = eff?.model ?? this.agentModels[m.id] ?? null;
            return html`<div class="rs-row" data-testid=${`rs-member-${m.id}`}>
              ${this.avatar(m)}
              <div class="rs-row-txt">
                <span class="rs-name">${m.name} <em>@${m.id}</em></span>
                <span class="rs-sub">
                  <span class="rs-src rs-src--${eff?.source.model ?? "agent"}">${SOURCE_LABEL[eff?.source.model ?? "agent"]}</span>
                  ${effModel ? shortModel(effModel) : "default model"}
                  · ${eff?.thinkingLevel ? THINKING_LABELS[eff.thinkingLevel] ?? eff.thinkingLevel : "default"} thinking
                </span>
              </div>
              <webchat-model-picker
                compact
                align="end"
                .client=${this.client}
                .connected=${this.connected}
                .value=${own?.model ?? eff?.model ?? this.agentModels[m.id] ?? null}
                .defaultModel=${eff?.source.model === "group" ? null : (this.agentModels[m.id] ?? null)}
                .defaultLabel=${eff?.source.model === "group" ? "Use the group's model" : "Agent default"}
                .overridden=${Boolean(own?.model)}
                .thinkingLevel=${own?.thinkingLevel ?? null}
                .mobile=${this.mobile}
                @model-select=${(e: CustomEvent<{ model: string | null }>) => this.change({ agentId: m.id, patch: { model: e.detail.model } })}
                @thinking-select=${(e: CustomEvent<{ level: string | null }>) => this.change({ agentId: m.id, patch: { thinkingLevel: e.detail.level } })}
              ></webchat-model-picker>
              ${own
                ? html`<button class="rs-reset" title=${`Use the group settings for ${m.name}`} aria-label=${`Reset ${m.name} to the group settings`} @click=${() => this.change({ agentId: m.id, patch: null })}>${icons.refresh}</button>`
                : html`<span class="rs-reset rs-reset--ghost" aria-hidden="true"></span>`}
            </div>`;
          })}
        </div>
        ${this.error ? html`<div class="rs-error" role="alert">${this.error}</div>` : nothing}
        <footer class="rs-foot">
          <span class="rs-tip">${icons.terminal}<span>Or type <code>/model</code>, <code>/think</code> or <code>/mode</code> in the composer — add <code>@agent</code> for one member.</span></span>
          <button class="rs-btn" @click=${() => this.close()}>Done</button>
        </footer>
      </section>
    `;
  }

  static styles = css`
    :host { position: fixed; inset: 0; z-index: 10000; display: grid; place-items: center; padding: 16px; box-sizing: border-box; overflow-y: auto; overscroll-behavior: contain; color: var(--text); font-family: var(--glass-font, var(--font-body, inherit)); }
    .rs-backdrop { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.55); backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px); }
    /* No overflow clip: the pickers' dropdowns extend past the card; the host scrolls. */
    .rs { position: relative; width: min(640px, 100%); box-sizing: border-box; display: flex; flex-direction: column; gap: 12px; padding: 18px; border-radius: var(--g-radius, 14px); background: linear-gradient(180deg, color-mix(in srgb, var(--g-primary, var(--accent)) 5%, var(--glass-solid, var(--bg-elevated, #16181d))), var(--glass-solid, var(--bg-elevated, #16181d))); border: 1px solid var(--g-border, var(--border)); box-shadow: 0 24px 60px rgba(0, 0, 0, 0.45), inset 0 1px 0 rgba(255, 255, 255, 0.04); }
    .rs-head { display: flex; align-items: flex-start; gap: 12px; }
    .rs-head-ico { width: 38px; height: 38px; flex: none; display: grid; place-items: center; border-radius: 10px; background: color-mix(in srgb, var(--g-primary, var(--accent)) 16%, transparent); color: var(--g-primary, var(--accent)); }
    .rs-head-ico svg { width: 18px; height: 18px; }
    .rs-head-txt { flex: 1; min-width: 0; }
    .rs-head h2 { margin: 0; font-size: 18px; }
    .rs-head p { margin: 2px 0 0; font-size: 13px; color: var(--muted); }
    .rs-x { width: 36px; height: 36px; display: grid; place-items: center; border-radius: 8px; border: none; background: transparent; color: var(--muted); cursor: pointer; }
    .rs-x svg { width: 18px; height: 18px; }
    .rs-label { font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--muted); margin-top: 4px; }
    .rs-list { display: flex; flex-direction: column; gap: 6px; }
    .rs-row { position: relative; display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 12px; border: 1px solid var(--g-border, var(--border)); background: var(--g-surface, var(--card)); }
    .rs-row--group { border-color: color-mix(in srgb, var(--g-primary, var(--accent)) 40%, var(--g-border, var(--border))); }
    .rs-av { width: 34px; height: 34px; flex: none; border-radius: 50%; display: grid; place-items: center; font-size: 12px; font-weight: 700; color: #fff; background: hsl(var(--h, 210) 55% 42%); object-fit: cover; }
    .rs-av--group { background: color-mix(in srgb, var(--g-primary, var(--accent)) 22%, transparent); color: var(--g-primary, var(--accent)); }
    .rs-av--group svg { width: 16px; height: 16px; }
    .rs-row-txt { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
    .rs-name { font-size: 14px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .rs-name em { font-style: normal; font-weight: 400; font-size: 12px; color: var(--muted); }
    .rs-sub { font-size: 12px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .rs-src { display: inline-block; font-size: 10px; letter-spacing: 0.06em; text-transform: uppercase; padding: 1px 6px; margin-right: 4px; border-radius: 999px; border: 1px solid var(--g-border, var(--border)); }
    .rs-src--member { color: var(--g-primary, var(--accent)); border-color: color-mix(in srgb, var(--g-primary, var(--accent)) 50%, transparent); }
    .rs-reset { width: 32px; height: 32px; flex: none; display: grid; place-items: center; border-radius: 8px; border: 1px solid var(--g-border, var(--border)); background: transparent; color: var(--muted); cursor: pointer; }
    .rs-reset:hover { color: var(--text); }
    .rs-reset svg { width: 14px; height: 14px; }
    .rs-reset--ghost { visibility: hidden; }
    webchat-model-picker { flex: none; max-width: 46%; }
    .rs-error { color: var(--danger, #e5484d); font-size: 13px; }
    .rs-foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
    .rs-tip { display: inline-flex; align-items: center; gap: 8px; font-size: 12px; color: var(--muted); min-width: 0; flex: 1 1 260px; }
    .rs-tip svg { width: 14px; height: 14px; flex: none; color: var(--g-primary, var(--accent)); }
    .rs-tip code { font-size: 11px; padding: 1px 5px; border-radius: 5px; background: var(--g-surface, var(--card)); border: 1px solid var(--g-border, var(--border)); }
    .rs-btn { min-height: 40px; padding: 0 18px; border-radius: 10px; border: 1px solid var(--g-primary, var(--accent)); background: var(--g-primary, var(--accent)); color: var(--accent-foreground, #111); font: inherit; font-size: 14px; font-weight: 600; cursor: pointer; }
    @media (max-width: 800px) {
      :host { padding: 68px 8px 8px; place-items: start center; }
      .rs { padding: 14px; }
      .rs-row { flex-wrap: wrap; }
      webchat-model-picker { max-width: none; flex: 1 1 100%; order: 3; }
    }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "ib-group-run-settings": GroupRunSettingsSheet;
  }
}
