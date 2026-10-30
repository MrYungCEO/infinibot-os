/**
 * <robovoice-link> — this install's link to a Robovoice organization.
 *
 * "Link to Robovoice" runs the device-code sign-in (robovoice.link.start →
 * show the code + approval link → poll robovoice.link.status); once approved
 * the plugin makes this install a Robovoice LOCATION with its own edge device
 * and syncs the linked agents as characters there.
 *
 *   variant="compact"  status line + Link button (voice-provider card)
 *   variant="full"     org, location, device, credits, agents with Call /
 *                      Add buttons, Sync / Unlink / Sign out (Robovoice page)
 */

import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { awaitGatewayClient, getGatewayClient } from "../gateway-client.js";

type Credits =
  | {
      available: true;
      orgName?: string;
      availableCredits: number;
      heldCredits?: number;
      creditsPerSecond?: number;
      creditUsd?: number;
      availableUsd: number;
      lowBalance?: boolean;
    }
  | { available: false; reason: string };

export type LinkStatus = {
  linked: boolean;
  signedIn: boolean;
  apiBase: string;
  org?: { id: string; name: string };
  userEmail?: string;
  location?: { id?: string; name?: string; dashboardUrl?: string };
  device?: { id?: string; name?: string; state?: string; lastSeenAt?: string | null };
  unlinkedAt?: string;
  agents: Array<{ agentId: string; name: string; characterId?: string; managed: boolean; error?: string }>;
  credits?: Credits;
  mcp?: { status?: string; url?: string | null; error?: string };
  remoteError?: string;
  secretsEncrypted: boolean;
  pending: null | {
    userCode: string;
    verificationUriComplete: string;
    status: "pending" | "linking" | "linked" | "error";
    error?: string;
    expiresAt: number;
  };
  desktop?: { installed: boolean; running: boolean };
};

type AgentRow = {
  id: string;
  name: string;
  description?: string;
  emoji?: string;
  linked: boolean;
  characterId: string | null;
  managed: boolean | null;
  error: string | null;
};

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** "≈ 40 min" of standard voice for the available credits. */
export function creditMinutes(c: Credits | undefined): string | null {
  if (!c || !c.available || !c.creditsPerSecond) return null;
  const min = c.availableCredits / c.creditsPerSecond / 60;
  return min >= 120 ? `≈ ${(min / 60).toFixed(1)} h` : `≈ ${Math.floor(min)} min`;
}

@customElement("robovoice-link")
export class RobovoiceLink extends LitElement {
  @property() variant: "compact" | "full" = "full";
  @state() private status: LinkStatus | null = null;
  @state() private agents: AgentRow[] = [];
  @state() private busy: string | null = null;
  @state() private note: { text: string; error?: boolean; href?: string } | null = null;
  @state() private error: string | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;

  static styles = css`
    :host { display: block; color: var(--c-text, #e8e6e3); font-size: 13px; }
    .card {
      border: 1px solid var(--g-line, rgba(255, 255, 255, 0.08)); border-radius: 12px; padding: 16px 18px;
      background: var(--g-surface, rgba(255, 255, 255, 0.02)); min-width: 0;
    }
    h2 { font-size: 14px; margin: 0; font-weight: 600; }
    .kicker { font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--c-text-2, #9ca3af); }
    .muted { color: var(--c-text-2, #9ca3af); }
    .ok { color: #34d399; }
    .err { color: #f87171; }
    .warn { color: #fbbf24; }
    .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    .between { justify-content: space-between; }
    .dot { width: 9px; height: 9px; border-radius: 50%; background: #6b7280; flex-shrink: 0; display: inline-block; }
    .dot.ok { background: #34d399; box-shadow: 0 0 8px rgba(52, 211, 153, 0.6); }
    .dot.warn { background: #fbbf24; }
    button, a.btn {
      font: inherit; font-size: 12px; font-weight: 600; cursor: pointer; border-radius: 8px; padding: 7px 14px; min-height: 34px;
      border: 1px solid var(--c-accent, #d4af37); background: var(--c-accent, #d4af37); color: #111; text-decoration: none;
      display: inline-flex; align-items: center; box-sizing: border-box;
    }
    button.ghost, a.btn.ghost { background: transparent; color: var(--c-accent, #d4af37); }
    button.small { min-height: 28px; padding: 4px 10px; }
    button:disabled { opacity: 0.55; cursor: default; }
    .facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 200px), 1fr)); gap: 12px; margin: 14px 0; }
    .fact { min-width: 0; }
    .fact .v { font-weight: 600; margin-top: 2px; overflow-wrap: anywhere; }
    .fact a { color: var(--c-accent, #d4af37); }
    .big { font-size: 22px; font-weight: 700; }
    .code {
      font-family: var(--font-mono, ui-monospace, monospace); font-size: 24px; letter-spacing: 0.12em; font-weight: 700;
      padding: 8px 14px; border-radius: 10px; border: 1px dashed rgba(212, 175, 55, 0.6); background: rgba(212, 175, 55, 0.06);
    }
    .pending { margin-top: 12px; padding: 12px; border-radius: 10px; border: 1px solid rgba(212, 175, 55, 0.35); display: grid; gap: 10px; }
    table { width: 100%; border-collapse: collapse; margin-top: 6px; }
    th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid var(--g-line, rgba(255, 255, 255, 0.06)); vertical-align: middle; }
    th { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--c-text-2, #9ca3af); font-weight: 500; }
    td.name { min-width: 0; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .mono { font-family: var(--font-mono, ui-monospace, monospace); font-size: 12px; word-break: break-all; }
    .actions { display: flex; gap: 6px; justify-content: flex-end; flex-wrap: wrap; }
    .compact { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-top: 12px; padding-top: 12px;
      border-top: 1px solid var(--g-line, rgba(255, 255, 255, 0.08)); }
    .compact .txt { flex: 1; min-width: 180px; }
    @media (max-width: 640px) {
      .hide-sm { display: none; }
      th, td { padding: 8px 4px; }
      td.name { max-width: 120px; }
    }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    void this.load();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  private async rpc<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const client = getGatewayClient() ?? (await awaitGatewayClient(15_000));
    if (!client) throw new Error("gateway not connected");
    return client.request<T>(method, params);
  }

  async load(remote = true): Promise<void> {
    try {
      this.status = await this.rpc<LinkStatus>("robovoice.link.status", { remote });
      this.error = null;
      if (this.variant === "full") {
        const r = await this.rpc<{ agents: AgentRow[] }>("robovoice.agents.list");
        this.agents = r.agents ?? [];
      }
      if (this.status.pending && (this.status.pending.status === "pending" || this.status.pending.status === "linking")) {
        this.schedulePoll();
      }
    } catch (err) {
      this.error = errText(err);
    }
  }

  private schedulePoll(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(async () => {
      this.pollTimer = null;
      const before = this.status?.pending?.status;
      await this.load(false);
      const now = this.status?.pending?.status;
      if (now === "linked" && before !== "linked") {
        this.note = { text: this.status?.org?.name ? `Linked to ${this.status.org.name}.` : "Linked to Robovoice." };
        await this.load(true);
        this.dispatchEvent(new CustomEvent("robovoice-linked", { bubbles: true, composed: true }));
      } else if (now === "error") {
        this.note = { text: this.status?.pending?.error ?? "Sign-in failed", error: true };
      }
    }, 2000);
  }

  private async act(key: string, fn: () => Promise<unknown>, done?: string): Promise<void> {
    if (this.busy) return;
    this.busy = key;
    this.note = null;
    try {
      await fn();
      if (done) this.note = { text: done };
      await this.load(true);
    } catch (err) {
      this.note = { text: errText(err), error: true };
    } finally {
      this.busy = null;
    }
  }

  private startLink(): Promise<void> {
    return this.act("link", async () => {
      const p = await this.rpc<{ verificationUriComplete: string }>("robovoice.link.start", {});
      // Opening from the click keeps the popup-blocker happy.
      window.open(p.verificationUriComplete, "_blank", "noopener");
    });
  }

  private async call(agentId: string): Promise<void> {
    // Open the tab inside the click so it isn't blocked, then point it at the call.
    const tab = window.open("about:blank", "_blank");
    await this.act(`call:${agentId}`, async () => {
      const c = await this.rpc<{ mode: string; url?: string; device?: { name: string }; fellBackToCloud?: boolean }>(
        "robovoice.call.start",
        { agentId, mode: "auto" },
      );
      if (c.url) {
        if (tab) tab.location.href = c.url;
        this.note = { text: `Call link for ${agentId}${c.fellBackToCloud ? " (cloud — Robovoice Desktop not online)" : ""}:`, href: c.url };
      } else {
        tab?.close();
        this.note = { text: `Robovoice Desktop "${c.device?.name ?? ""}" is starting the call with ${agentId}.` };
      }
    });
    if (this.note?.error) tab?.close();
  }

  render() {
    if (this.error && !this.status) {
      return this.variant === "compact" ? nothing : html`<div class="card"><h2>Robovoice account</h2><div class="err">${this.error}</div></div>`;
    }
    if (!this.status) {
      return this.variant === "compact" ? nothing : html`<div class="card"><div class="muted">Loading Robovoice link…</div></div>`;
    }
    return this.variant === "compact" ? this.renderCompact() : this.renderFull();
  }

  private renderPending() {
    const p = this.status?.pending;
    if (!p || (p.status !== "pending" && p.status !== "linking")) return nothing;
    return html`<div class="pending" data-testid="rv-link-pending">
      <div class="muted">${p.status === "linking" ? "Approved — creating your location…" : "Approve this code in Robovoice (signed in as an org admin):"}</div>
      <div class="row"><span class="code">${p.userCode}</span>
        <a class="btn ghost" href=${p.verificationUriComplete} target="_blank" rel="noopener">Open approval page</a>
        <button class="ghost small" @click=${() => this.act("cancel", () => this.rpc("robovoice.link.cancel"))}>Cancel</button>
      </div>
    </div>`;
  }

  private renderCompact() {
    const s = this.status!;
    const linked = s.linked;
    return html`<div class="compact" data-testid="rv-link-compact">
      <span class="dot ${linked ? "ok" : s.unlinkedAt ? "warn" : ""}"></span>
      <div class="txt">
        ${linked
          ? html`<b>${s.org?.name}</b> <span class="muted">· ${s.location?.name ?? "—"}} · cloud voice free</span>`
          : s.unlinkedAt
            ? html`<span class="muted">Robovoice device retired — location kept in ${s.org?.name ?? "your org"}.</span>`
            : html`<span class="muted">Optional, free cloud voice: link this InfiniBot to your Robovoice org and it becomes a location with its agents. No credits needed.</span>`}
      </div>
      ${linked ? nothing : html`<button id="rv-link-btn-compact" ?disabled=${this.busy !== null} @click=${() => this.startLink()}>${this.busy === "link" ? "Starting…" : s.unlinkedAt ? "Relink" : "Link to Robovoice"}</button>`}
      ${this.renderPending()}
      ${this.note ? html`<div class=${this.note.error ? "err" : "ok"} style="flex-basis:100%;">${this.note.text}</div>` : nothing}
    </div>`;
  }

  private renderFull() {
    const s = this.status!;
    return html`<section class="card" data-testid="rv-account">
      <div class="row between">
        <div>
          <div class="kicker">Robovoice account</div>
          <div class="row" style="margin-top:4px;">
            <span class="dot ${s.linked ? "ok" : s.unlinkedAt ? "warn" : ""}"></span>
            <h2 data-testid="rv-link-state">${s.linked ? `Linked to ${s.org?.name}` : s.unlinkedAt ? "Unlinked (location kept)" : "Not linked"}</h2>
          </div>
        </div>
        <div class="row">
          ${s.linked
            ? html`
                <button id="rv-sync" class="ghost" ?disabled=${this.busy !== null} @click=${() => this.act("sync", () => this.rpc("robovoice.link.sync"), "Agents synced.")}>${this.busy === "sync" ? "Syncing…" : "Sync agents"}</button>
                <button id="rv-unlink" class="ghost" ?disabled=${this.busy !== null}
                  @click=${() => confirm("Retire this install's Robovoice device? The location and its agents stay in your org.") && this.act("unlink", () => this.rpc("robovoice.unlink"), "Device retired. The location stays in your org.")}>Unlink</button>`
            : html`<button id="rv-link-btn" ?disabled=${this.busy !== null} @click=${() => this.startLink()}>${this.busy === "link" ? "Starting…" : s.unlinkedAt ? "Relink" : "Link to Robovoice"}</button>`}
          ${s.signedIn ? html`<button class="ghost" ?disabled=${this.busy !== null} @click=${() => confirm("Sign out of Robovoice on this install? The device is retired and the saved sign-in removed.") && this.act("logout", () => this.rpc("robovoice.logout"), "Signed out.")}>Sign out</button>` : nothing}
        </div>
      </div>
      ${this.renderPending()}
      ${s.org || s.linked
        ? html`<div class="facts">
            <div class="fact"><div class="kicker">Organization</div><div class="v">${s.org?.name ?? "—"}</div>${s.userEmail ? html`<div class="muted">${s.userEmail}</div>` : nothing}</div>
            <div class="fact"><div class="kicker">Location</div><div class="v">${s.location?.dashboardUrl ? html`<a href=${s.location.dashboardUrl} target="_blank" rel="noopener">${s.location.name}</a>` : (s.location?.name ?? "—")}</div></div>
            <div class="fact"><div class="kicker">Edge device</div><div class="v mono">${s.device?.id ?? "—"}</div>${s.device?.state ? html`<div class="muted">${s.device.state}</div>` : nothing}</div>
            <div class="fact"><div class="kicker">Cloud voice</div>
              <div class="v" data-testid="rv-link-free">Free</div>
              <div class="muted">No credits or top-ups</div>
            </div>
          </div>`
        : html`<div class="muted" style="margin-top:10px;">Sign in with your Robovoice organization: this install becomes a location (“InfiniBot · this computer”) with its own device, and your agents become callable characters there. Cloud voice is free — no credits needed.</div>`}
      ${s.remoteError ? html`<div class="warn">${s.remoteError}</div>` : nothing}
      ${!s.secretsEncrypted ? html`<div class="warn">Robovoice credentials on this install are not encrypted (install key unavailable).</div>` : nothing}
      ${s.linked ? this.renderAgents() : nothing}
      ${this.note
        ? html`<div class=${this.note.error ? "err" : "ok"} style="margin-top:10px;" data-testid="rv-link-note">${this.note.text}
            ${this.note.href ? html`<a class="mono" href=${this.note.href} target="_blank" rel="noopener">${this.note.href}</a>` : nothing}</div>`
        : nothing}
    </section>`;
  }

  private renderAgents() {
    const desktop = this.status?.desktop;
    return html`
      <div class="row between" style="margin-top:6px;">
        <div class="kicker">Agents at this location</div>
        <span class="muted">${desktop?.running ? "Robovoice Desktop running — calls use its local pipeline" : "Calls use Robovoice cloud"}</span>
      </div>
      <table data-testid="rv-link-agents">
        <thead><tr><th>Agent</th><th class="hide-sm">Robovoice character</th><th></th></tr></thead>
        <tbody>
          ${this.agents.map(
            (a) => html`<tr data-agent=${a.id}>
              <td class="name">${a.emoji ?? ""} ${a.name} <span class="muted">${a.id}</span></td>
              <td class="hide-sm">${a.linked
                ? a.characterId
                  ? html`<span class="mono">${a.characterId}</span>${a.managed === false ? html` <span class="muted">(existing)</span>` : nothing}`
                  : html`<span class="warn">${a.error ?? "not synced"}</span>`
                : html`<span class="muted">—</span>`}</td>
              <td><div class="actions">
                ${a.linked && a.characterId
                  ? html`<button class="small" ?disabled=${this.busy !== null} @click=${() => this.call(a.id)}>${this.busy === `call:${a.id}` ? "Calling…" : "Call"}</button>`
                  : nothing}
                ${a.linked
                  ? a.id === "main" && this.agents.filter((x) => x.linked).length === 1
                    ? nothing
                    : html`<button class="ghost small" ?disabled=${this.busy !== null} @click=${() => this.act(`unlink:${a.id}`, () => this.rpc("robovoice.agents.unlink", { agentId: a.id }))}>Remove</button>`
                  : html`<button class="ghost small" ?disabled=${this.busy !== null} @click=${() => this.act(`link:${a.id}`, () => this.rpc("robovoice.agents.link", { agentId: a.id, create: true }), `${a.name} added to Robovoice.`)}>${this.busy === `link:${a.id}` ? "Adding…" : "Add"}</button>`}
              </div></td>
            </tr>`,
          )}
        </tbody>
      </table>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "robovoice-link": RobovoiceLink;
  }
}
