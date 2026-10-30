/**
 * <community-manager-shell> — the /community page (community-manager plugin).
 *
 *   Header      server, member count, mode pill (Setup / Shadow / Live / Paused),
 *               Pause switch (stops every autonomous action), health dot
 *   Overview    KPI strip, live activity feed, lead queue, mod queue (approvals), chart
 *   Leads / Moderation / Tickets / Campaigns / Analytics
 *   Setup       the 10-step wizard (<community-setup-wizard>), also at ?step=<n>
 *
 * Light DOM (styles.ts). Polls status + the activity feed every 5 s while visible.
 */

import { LitElement, html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";

import {
  LEAD_STAGES,
  OFFER_LABELS,
  type Activity,
  type ActivityKind,
  type AnalyticsSummary,
  type Campaign,
  type Lead,
  type LeadStage,
  type ModAction,
  type StatusResponse,
  type TeamMember,
  type Ticket,
  type TicketState,
} from "../../../../../extensions/community-manager/src/contract.js";
import { icon, type IconName } from "../../icons.js";
import { CommunityApi, type GatewayCallable, type PendingApproval } from "./api.js";
import { clock, compact, healthTone, modeLabel, parseStep, relTime, slaLabel, sparkPoints, withStep } from "./logic.js";
import { ensureCommunityStyles } from "./styles.js";
import "./wizard.js";

type View = "overview" | "leads" | "moderation" | "tickets" | "campaigns" | "analytics" | "setup";
const VIEWS: Array<{ id: View; label: string; icon: IconName }> = [
  { id: "overview", label: "Overview", icon: "layoutGrid" },
  { id: "leads", label: "Leads", icon: "target" },
  { id: "moderation", label: "Moderation", icon: "shieldCheck" },
  { id: "tickets", label: "Tickets", icon: "inbox" },
  { id: "campaigns", label: "Campaigns", icon: "calendar" },
  { id: "analytics", label: "Analytics", icon: "chart" },
  { id: "setup", label: "Setup", icon: "settings" },
];
const POLL_MS = 5_000;
const FEED_FILTERS: Array<{ id: "all" | ActivityKind; label: string }> = [
  { id: "all", label: "All" },
  { id: "join", label: "Joins" },
  { id: "verify", label: "Verify" },
  { id: "lead", label: "Leads" },
  { id: "mod", label: "Mod" },
  { id: "ticket", label: "Tickets" },
];

/** Primary + secondary offer chips (every lead has both — no dead ends). */
function offerTags(l: Lead) {
  const primary = l.primaryOffer ?? l.offer;
  return html`<span class="cmx-offer ${primary}" title=${l.routeReason ?? ""}>${OFFER_LABELS[primary]}</span>${l.secondaryOffer
    ? html` <span class="cmx-offer2">+ ${OFFER_LABELS[l.secondaryOffer]}</span>`
    : nothing}`;
}

@customElement("community-manager-shell")
export class CommunityManagerShell extends LitElement {
  @property({ attribute: false }) client: GatewayCallable | null = null;

  @state() private view: View = "overview";
  @state() private status: StatusResponse | null = null;
  @state() private activity: Activity[] = [];
  @state() private leads: Lead[] = [];
  @state() private team: TeamMember[] = [];
  @state() private mod: { pending: ModAction[]; approvals: PendingApproval[]; recent: ModAction[] } = { pending: [], approvals: [], recent: [] };
  @state() private tickets: Ticket[] = [];
  @state() private campaigns: Campaign[] = [];
  @state() private analytics: AnalyticsSummary | null = null;
  @state() private feedFilter: "all" | ActivityKind = "all";
  @state() private error: string | null = null;
  @state() private toast: string | null = null;
  @state() private now = Date.now();
  @state() private draft = { title: "", content: "", when: "" };

  private api: CommunityApi | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;

  protected createRenderRoot() {
    ensureCommunityStyles();
    return this;
  }

  connectedCallback(): void {
    super.connectedCallback();
    if (parseStep(location.search)) this.view = "setup";
    this.timer = setInterval(() => {
      this.now = Date.now();
      if (document.visibilityState === "visible" && this.view !== "setup") void this.refresh(false);
    }, POLL_MS);
    window.addEventListener("popstate", this.onPop);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this.timer) clearInterval(this.timer);
    window.removeEventListener("popstate", this.onPop);
  }

  private onPop = () => {
    if (parseStep(location.search)) this.view = "setup";
  };

  protected willUpdate(changed: PropertyValues<this>): void {
    if (changed.has("client") && this.client) {
      this.api = new CommunityApi(this.client);
      void this.refresh(true);
    }
  }

  private async refresh(full: boolean): Promise<void> {
    const api = this.api;
    if (!api) return;
    try {
      const [status, feed] = await Promise.all([api.status(), api.activity()]);
      this.status = status;
      this.activity = feed.items;
      this.error = null;
      if (full && status.mode === "setup" && !parseStep(location.search) && this.view === "overview") {
        // First visit before go-live: land on the wizard.
        this.setView("setup");
      }
      const [leads, mod] = await Promise.all([api.leads(), api.modQueue()]);
      this.leads = leads.leads;
      this.mod = mod;
      if (full || this.view === "tickets") this.tickets = (await api.tickets()).tickets;
      if (full || this.view === "campaigns") this.campaigns = (await api.campaigns()).campaigns;
      if (full || this.view === "analytics" || this.view === "overview") this.analytics = await api.analytics(14);
      if (full) this.team = (await api.setupState()).team;
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    }
  }

  private setView(view: View) {
    this.view = view;
    const step = view === "setup" ? (parseStep(location.search) ?? Math.min(10, Math.max(1, this.status?.setupStep ?? 1))) : null;
    history.replaceState(history.state, "", withStep(location.href, step));
    if (view !== "setup") void this.refresh(true);
  }

  private flash(msg: string) {
    this.toast = msg;
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => (this.toast = null), 3500);
  }

  private async act(label: string, fn: () => Promise<unknown>) {
    try {
      await fn();
      this.flash(label);
      await this.refresh(true);
    } catch (err) {
      this.flash(`Failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── render ────────────────────────────────────────────────────────────

  render() {
    const s = this.status;
    const mode = modeLabel(s);
    const tone = s ? healthTone(s.health) : "warn";
    const pending = s?.kpis.pendingApprovals ?? 0;
    return html`
      <div class="cmx" data-testid="community-shell">
        <header class="cmx-head">
          <div class="cmx-brand">
            <div class="cmx-mark">${icon("community")}</div>
            <div style="min-width:0">
              <h1>Community${s?.guild?.name ? html` · ${s.guild.name}` : nothing}</h1>
              <p>${s?.guild ? html`${compact(s.guild.memberCount)} members · account <span class="cmx-mono">${s.accountId}</span>` : "Discord Community Manager — not connected yet"}</p>
            </div>
          </div>
          <div class="cmx-head-actions">
            <span class="cmx-pill cmx-tone-${mode.tone}" data-testid="mode-pill"><span class="cmx-dot"></span>${mode.label}</span>
            <span class="cmx-pill" title=${(s?.health ?? []).map((h) => `${h.label}: ${h.detail}`).join("\n")}><span class="cmx-dot ${tone}"></span>Health</span>
            ${s && s.mode !== "setup"
              ? html`<button class="cmx-btn ${s.paused ? "ok" : "danger"}" data-testid="pause-toggle"
                  @click=${() => this.act(s.paused ? "Resumed" : "Paused — no autonomous actions", () => this.api!.pause(!s.paused))}>
                  ${icon(s.paused ? "play" : "pause")} ${s.paused ? "Resume agent" : "Pause agent"}</button>`
              : nothing}
          </div>
        </header>

        ${this.error ? html`<div class="cmx-banner fail">${icon("alert")}<span>${this.error}</span></div>` : nothing}
        ${s && !s.connection.discordPluginEnabled && s.mode !== "setup"
          ? html`<div class="cmx-banner warn">${icon("alert")}<span>The Discord channel plugin is off, so no Discord events reach the Community Manager. Turn on Discord in Plugins (needs one gateway restart).</span></div>`
          : nothing}

        <nav class="cmx-tabs" role="tablist">
          ${VIEWS.map(
            (v) => html`<button class="cmx-tab ${this.view === v.id ? "on" : ""}" role="tab" data-view=${v.id} @click=${() => this.setView(v.id)}>
              ${icon(v.icon)} ${v.label}
              ${v.id === "moderation" && pending ? html`<span class="cmx-badge">${pending}</span>` : nothing}
              ${v.id === "leads" && s?.kpis.hotLeadsOpen ? html`<span class="cmx-badge">${s.kpis.hotLeadsOpen}</span>` : nothing}
            </button>`,
          )}
        </nav>

        ${this.view === "setup"
          ? html`<community-setup-wizard .client=${this.client} @community-changed=${() => this.refresh(true)} @community-done=${() => this.setView("overview")}></community-setup-wizard>`
          : html`${this.renderKpis()} ${this.renderView()}`}
        ${this.toast ? html`<div class="cmx-toast" role="status">${this.toast}</div>` : nothing}
      </div>
    `;
  }

  private renderKpis() {
    const k = this.status?.kpis;
    const tile = (label: string, value: string, cls = "") => html`<div class="cmx-kpi ${cls}"><b>${value}</b><span>${label}</span></div>`;
    return html`<section class="cmx-kpis" data-testid="kpis">
      ${tile("Joins today", compact(k?.joinsToday))}
      ${tile("Verified", k?.verifiedPct === null || k?.verifiedPct === undefined ? "—" : `${k.verifiedPct}%`)}
      ${tile("Active today", compact(k?.activeToday))}
      ${tile("Msgs today", compact(k?.messagesToday))}
      ${tile("Hot leads", compact(k?.hotLeadsOpen), "gold")}
      ${tile("Open leads", compact(k?.leadsOpen))}
      ${tile("Offer assigned", k?.offerAssignedPct === null || k?.offerAssignedPct === undefined ? "—" : `${k.offerAssignedPct}%`, k?.offerAssignedPct !== null && k?.offerAssignedPct !== undefined && k.offerAssignedPct < 100 ? "alert" : "")}
      ${tile("Open tickets", compact(k?.ticketsOpen))}
      ${tile("Approvals", compact(k?.pendingApprovals), k?.pendingApprovals ? "alert" : "")}
    </section>`;
  }

  private renderView(): TemplateResult {
    switch (this.view) {
      case "leads":
        return this.renderLeads(false);
      case "moderation":
        return html`<div class="cmx-col">${this.renderModQueue()}${this.renderModLog()}</div>`;
      case "tickets":
        return this.renderTickets();
      case "campaigns":
        return this.renderCampaigns();
      case "analytics":
        return this.renderAnalytics(true);
      default:
        return html`<div class="cmx-grid">
          <div class="cmx-col feed-col">${this.renderFeed()}</div>
          <div class="cmx-col">${this.renderLeads(true)}${this.renderModQueue()}${this.renderAnalytics(false)}</div>
        </div>`;
    }
  }

  private renderFeed() {
    const items = this.feedFilter === "all" ? this.activity : this.activity.filter((a) => a.kind === this.feedFilter);
    return html`<section class="cmx-panel" data-testid="activity-feed">
      <div class="cmx-panel-h"><h2>${icon("activity")} Live activity</h2>
        <div class="cmx-filters">${FEED_FILTERS.map((f) => html`<button class="cmx-chip ${this.feedFilter === f.id ? "on" : ""}" @click=${() => (this.feedFilter = f.id)}>${f.label}</button>`)}</div>
      </div>
      ${items.length
        ? html`<ul class="cmx-feed">${items.slice(0, 80).map(
            (a) => html`<li><time title=${new Date(a.ts).toLocaleString()}>${clock(a.ts)}</time><span class="cmx-kind ${a.kind}">${a.kind}</span><span class=${a.dry ? "dry" : ""}>${a.text}</span></li>`,
          )}</ul>`
        : html`<div class="cmx-empty">No activity yet. Joins, verifications, leads and moderation show up here as they happen.</div>`}
    </section>`;
  }

  private renderLeads(compactView: boolean) {
    const leads = compactView ? this.leads.filter((l) => l.stage !== "converted" && l.stage !== "lost").slice(0, 8) : this.leads;
    const team = this.team.filter((t) => t.active);
    return html`<section class="cmx-panel" data-testid="lead-queue">
      <div class="cmx-panel-h"><h2>${icon("target")} Lead queue</h2><span class="cmx-note">${this.leads.length} total · hot ≥ 60</span></div>
      ${leads.length
        ? html`
          <table class="cmx-table collapse">
            <thead><tr><th>Score</th><th>Member</th><th>Offer · next step</th><th>Stage</th><th>Owner</th><th>SLA</th><th></th></tr></thead>
            <tbody>${leads.map((l) => {
              const sla = slaLabel(l.stage === "new" ? l.slaDueAt : null, this.now);
              return html`<tr>
                <td><span class="cmx-score ${l.tier}" title=${l.breakdown.map((b) => `${b.questionId}: ${b.answer} (+${b.contribution.toFixed(1)})`).join("\n")}>${l.score}</span></td>
                <td>@${l.username}<div class="cmx-note">${relTime(l.createdAt, this.now)}</div></td>
                <td>${offerTags(l)}<div class="cmx-cta" title=${l.cta}>${l.cta.split("\n")[0]}</div></td>
                <td><select class="cmx-select" style="min-height:32px;padding:4px 8px" @change=${(e: Event) => this.act("Stage updated", () => this.api!.updateLead(l.id, { stage: (e.target as HTMLSelectElement).value as LeadStage }))}>
                  ${LEAD_STAGES.map((st) => html`<option value=${st} ?selected=${st === l.stage}>${st.replace("_", " ")}</option>`)}</select></td>
                <td>${team.length
                  ? html`<select class="cmx-select" style="min-height:32px;padding:4px 8px" @change=${(e: Event) => this.act("Assigned", () => this.api!.updateLead(l.id, { assigneeId: (e.target as HTMLSelectElement).value }))}>
                      <option value="" ?selected=${!l.assigneeId}>—</option>
                      ${team.map((t) => html`<option value=${t.discordId} ?selected=${t.discordId === l.assigneeId}>${t.name}</option>`)}</select>`
                  : l.assigneeName ?? "—"}</td>
                <td class=${sla.late ? "cmx-late" : "cmx-mono"}>${sla.text}</td>
                <td>${l.stage === "new" ? html`<button class="cmx-btn sm" @click=${() => this.act("Marked contacted", () => this.api!.updateLead(l.id, { stage: "contacted" }))}>Contacted</button>` : nothing}</td>
              </tr>`;
            })}</tbody>
          </table>
          <div class="cmx-cards">${leads.map((l) => {
            const sla = slaLabel(l.stage === "new" ? l.slaDueAt : null, this.now);
            return html`<div class="cmx-card">
              <span class="cmx-score ${l.tier}">${l.score}</span>
              <div><b>@${l.username}</b> ${offerTags(l)}
                <div class="cmx-cta">${l.cta.split("\n")[0]}</div>
                <div class="meta">${l.stage.replace("_", " ")} · ${l.assigneeName ?? "unassigned"}</div></div>
              <span class=${sla.late ? "cmx-late" : "cmx-mono"}>${sla.text}</span>
              ${l.stage === "new" ? html`<div class="acts"><button class="cmx-btn sm" @click=${() => this.act("Marked contacted", () => this.api!.updateLead(l.id, { stage: "contacted" }))}>Contacted</button></div>` : nothing}
            </div>`;
          })}</div>`
        : html`<div class="cmx-empty">No leads yet. Every member who finishes the intake lands here with a score, a primary + secondary offer and the next step they were given.</div>`}
    </section>`;
  }

  private renderModQueue() {
    const { approvals } = this.mod;
    return html`<section class="cmx-panel" data-testid="mod-queue">
      <div class="cmx-panel-h"><h2>${icon("shieldCheck")} Mod queue</h2><span class="cmx-note">${approvals.length} waiting for approval</span></div>
      ${approvals.length
        ? approvals.map(
            (a) => html`<div class="cmx-appr">
              <div class="cmx-appr-main"><b>${a.title}</b><span>${a.summary}</span></div>
              <button class="cmx-btn sm ok" @click=${() => this.act("Approved", () => this.api!.resolveApproval(a.id, "approve"))}>${icon("check")} Approve</button>
              <button class="cmx-btn sm danger" @click=${() => this.act("Denied", () => this.api!.resolveApproval(a.id, "deny"))}>${icon("x")} Deny</button>
            </div>`,
          )
        : html`<div class="cmx-empty">Nothing to approve. Bans, kicks, timeouts over 1 h, DMs to more than 25 people and @everyone posts wait here (and on Telegram).</div>`}
    </section>`;
  }

  private renderModLog() {
    const rows = this.mod.recent;
    return html`<section class="cmx-panel">
      <div class="cmx-panel-h"><h2>${icon("scrollText")} Moderation log</h2></div>
      ${rows.length
        ? html`<table class="cmx-table"><thead><tr><th>When</th><th>Action</th><th>Member</th><th>Rule</th><th>Status</th></tr></thead>
            <tbody>${rows.map((m) => html`<tr><td>${relTime(m.ts, this.now)}</td><td>${m.action}</td><td>${m.targetName ? `@${m.targetName}` : "—"}</td><td><span class="cmx-mono">${m.rule}</span><div class="cmx-note">${m.reason}</div></td><td>${m.status.replace("_", " ")}</td></tr>`)}</tbody></table>`
        : html`<div class="cmx-empty">No moderation actions yet.</div>`}
    </section>`;
  }

  private renderTickets() {
    const states: TicketState[] = ["open", "waiting_member", "waiting_staff", "resolved", "closed"];
    return html`<section class="cmx-panel" data-testid="tickets">
      <div class="cmx-panel-h"><h2>${icon("inbox")} Tickets</h2><span class="cmx-note">Opened from the Get help button as private threads under #support</span></div>
      ${this.tickets.length
        ? html`<table class="cmx-table"><thead><tr><th>Opened</th><th>Member</th><th>Category</th><th>Thread</th><th>State</th></tr></thead>
            <tbody>${this.tickets.map((t) => html`<tr><td>${relTime(t.createdAt, this.now)}</td><td>@${t.username}</td><td>${t.category}</td>
              <td>${t.threadId ? html`<span class="cmx-mono">#${t.threadId.slice(-6)}</span>` : "—"}</td>
              <td><select class="cmx-select" style="min-height:32px;padding:4px 8px" @change=${(e: Event) => this.act("Ticket updated", () => this.api!.updateTicket(t.id, (e.target as HTMLSelectElement).value as TicketState))}>
                ${states.map((st) => html`<option value=${st} ?selected=${st === t.state}>${st.replace("_", " ")}</option>`)}</select></td></tr>`)}</tbody></table>`
        : html`<div class="cmx-empty">No tickets yet.</div>`}
    </section>`;
  }

  private renderCampaigns() {
    const d = this.draft;
    const pingsEveryone = /@(everyone|here)\b/.test(d.content);
    return html`<div class="cmx-grid">
      <section class="cmx-panel" data-testid="campaign-composer">
        <div class="cmx-panel-h"><h2>${icon("calendar")} Schedule a post</h2></div>
        <div class="cmx-panel-b" style="display:flex;flex-direction:column;gap:10px">
          <label><span class="cmx-label">Title</span><input class="cmx-input" .value=${d.title} @input=${(e: Event) => (this.draft = { ...d, title: (e.target as HTMLInputElement).value })} /></label>
          <label><span class="cmx-label">Message (posted in #announcements)</span><textarea class="cmx-textarea" .value=${d.content} @input=${(e: Event) => (this.draft = { ...d, content: (e.target as HTMLTextAreaElement).value })}></textarea></label>
          <label><span class="cmx-label">When</span><input class="cmx-input" type="datetime-local" .value=${d.when} @input=${(e: Event) => (this.draft = { ...d, when: (e.target as HTMLInputElement).value })} /></label>
          ${pingsEveryone ? html`<div class="cmx-banner warn">${icon("alert")}<span>Pings @everyone — it will wait for your approval before posting.</span></div>` : nothing}
          <div><button class="cmx-btn primary" ?disabled=${!d.title.trim() || !d.content.trim()}
            @click=${() => this.act("Scheduled", async () => {
              await this.api!.createCampaign({ title: d.title, content: d.content, scheduleAt: d.when ? new Date(d.when).getTime() : Date.now() });
              this.draft = { title: "", content: "", when: "" };
            })}>${icon("send")} Schedule</button></div>
        </div>
      </section>
      <section class="cmx-panel">
        <div class="cmx-panel-h"><h2>${icon("clock")} Scheduled</h2></div>
        ${this.campaigns.length
          ? html`<table class="cmx-table"><thead><tr><th>When</th><th>Title</th><th>Status</th><th></th></tr></thead>
              <tbody>${this.campaigns.map((c) => html`<tr><td>${new Date(c.scheduleAt).toLocaleString()}</td><td>${c.title}${c.pingsEveryone ? html` <span class="cmx-offer">@everyone</span>` : nothing}</td><td>${c.status.replace("_", " ")}</td>
                <td>${c.status === "scheduled" || c.status === "pending_approval" ? html`<button class="cmx-btn sm" @click=${() => this.act("Cancelled", () => this.api!.cancelCampaign(c.id))}>Cancel</button>` : nothing}</td></tr>`)}</tbody></table>`
          : html`<div class="cmx-empty">No scheduled posts.</div>`}
      </section>
    </div>`;
  }

  private renderAnalytics(full: boolean) {
    const a = this.analytics;
    const days = a?.days ?? [];
    const W = 600;
    const H = 110;
    const msgs = sparkPoints(days.map((d) => d.messages), W, H);
    const active = sparkPoints(days.map((d) => d.active), W, H);
    const joins = sparkPoints(days.map((d) => d.joins), W, H);
    const maxLeads = Math.max(1, ...(a?.funnel ?? []).map((f) => f.leads));
    return html`<section class="cmx-panel" data-testid="analytics">
      <div class="cmx-panel-h"><h2>${icon("chart")} Messages · active members · joins (14 days)</h2></div>
      <svg class="cmx-chart" viewBox="0 0 ${W} ${H + 10}" preserveAspectRatio="none" role="img" aria-label="Messages, active members and joins per day">
        ${[0.25, 0.5, 0.75].map((f) => html`<line x1="0" x2=${W} y1=${H * f} y2=${H * f} stroke="rgba(255,255,255,.06)" />`)}
        <polyline points=${msgs} fill="none" stroke="var(--cmx-gold)" stroke-width="2" vector-effect="non-scaling-stroke" />
        <polyline points=${active} fill="none" stroke="#7dd3fc" stroke-width="2" vector-effect="non-scaling-stroke" />
        <polyline points=${joins} fill="none" stroke="#4ade80" stroke-width="2" stroke-dasharray="4 3" vector-effect="non-scaling-stroke" />
        ${days.map((d, i) => {
          const x = days.length > 1 ? (i * W) / (days.length - 1) : W / 2;
          const max = Math.max(1, ...days.map((v) => v.messages));
          return d.messages ? html`<circle cx=${x} cy=${H - (d.messages / max) * H} r="3" fill="var(--cmx-gold)" />` : nothing;
        })}
      </svg>
      <div class="cmx-legend"><span><i style="background:var(--cmx-gold)"></i>Messages</span><span><i style="background:#7dd3fc"></i>Active</span><span><i style="background:#4ade80"></i>Joins</span></div>
      ${full
        ? html`<div class="cmx-panel-b"><div class="cmx-label">Leads by offer</div><div class="cmx-funnel">
            ${(a?.funnel ?? []).map((f) => html`<div class="cmx-bar"><span>${OFFER_LABELS[f.offer]}</span><div class="cmx-bar-track"><div class="cmx-bar-fill" style="width:${(f.leads / maxLeads) * 100}%"></div></div><b>${f.leads}</b></div>`)}
            </div>
            <p class="cmx-note">Tiers: ${a?.tiers.hot ?? 0} hot · ${a?.tiers.warm ?? 0} warm · ${a?.tiers.nurture ?? 0} nurture</p></div>`
        : nothing}
    </section>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "community-manager-shell": CommunityManagerShell;
  }
}
