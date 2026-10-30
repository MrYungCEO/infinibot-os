/**
 * <community-setup-wizard> — the 10-step Community Manager setup at
 * /community?step=<n> (plan §4). Every step saves as it goes (resumable) and
 * shows a health strip. The bot token is typed into a password field and
 * sent to `setup.validateToken` / `setup.saveToken`; it is never read back.
 *
 * Events: `community-changed` after a save, `community-done` after go-live.
 */

import { LitElement, html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";

import {
  CHANNEL_PURPOSES,
  LIVE_MODULE_LABELS,
  LIVE_MODULES,
  OFFER_LABELS,
  ROLE_PURPOSES,
  ROUTED_OFFERS,
  type GuildDiscovery,
  type GuildSummary,
  type HealthCheck,
  type IntakeQuestion,
  type LiveModule,
  type ModPreset,
  type Offer,
  type Settings,
  type StatusResponse,
  type TeamMember,
  type TestRunResult,
  type TokenValidation,
} from "../../../../../extensions/community-manager/src/contract.js";
import { icon } from "../../icons.js";
import { renderWelcomeDm, routingMatrix } from "../../../../../extensions/community-manager/src/routing.js";
import { CommunityApi, type GatewayCallable } from "./api.js";
import { parseList, parseStep, stepStates, weightTotal, withStep, WIZARD_STEPS, type WizardStepN } from "./logic.js";

const PRESET_COPY: Record<ModPreset, { title: string; body: string }> = {
  relaxed: { title: "Relaxed", body: "Accounts older than 1 day verify straight away. Raid alert at 20 joins/min. Invite links allowed." },
  standard: { title: "Standard", body: "Accounts younger than 7 days get a manual check. Raid alert at 10 joins/min. Invite links removed." },
  strict: { title: "Strict", body: "Recommended for the revival. Accounts younger than 30 days get a manual check, raid alert at 6 joins/min, invite links removed." },
};
const OFFERS: Offer[] = ["infinibot", "kinglyvault", "kinglyvault-plugins", "pulse", "none"];
/** Compact names for the narrow per-answer picker (full label is the option title). */
const OFFER_SHORT: Record<Offer, string> = {
  infinibot: "InfiniBot",
  kinglyvault: "KV · Learn",
  "kinglyvault-plugins": "KV · Plugins",
  pulse: "Gold Desk",
  none: "No preference",
};

@customElement("community-setup-wizard")
export class CommunitySetupWizard extends LitElement {
  @property({ attribute: false }) client: GatewayCallable | null = null;

  @state() private step: WizardStepN = 1;
  @state() private settings: Settings | null = null;
  @state() private status: StatusResponse | null = null;
  @state() private team: TeamMember[] = [];
  @state() private busy = false;
  @state() private err: string | null = null;
  @state() private notice: string | null = null;

  // step-local state
  @state() private tokenInput = "";
  @state() private validation: (TokenValidation & { source?: string }) | null = null;
  @state() private needsRestart = false;
  @state() private guilds: GuildSummary[] | null = null;
  @state() private discovery: GuildDiscovery | null = null;
  @state() private channelMap: Settings["channelMap"] = {};
  @state() private roleMap: Settings["roleMap"] = {};
  @state() private trading: string[] = [];
  @state() private questions: IntakeQuestion[] = [];
  @state() private welcomeDm = "";
  @state() private offerLinks: Settings["offerLinks"] = {};
  @state() private preset: ModPreset = "strict";
  @state() private claimsText = "";
  @state() private domainsText = "";
  @state() private disclaimer = "";
  @state() private repostEvery = 50;
  @state() private regionsText = "";
  @state() private testRun: TestRunResult | null = null;
  @state() private issues: string[] = [];

  private api: CommunityApi | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;

  protected createRenderRoot() {
    return this;
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.stopPoll();
  }

  protected willUpdate(changed: PropertyValues<this>): void {
    if (changed.has("client") && this.client) {
      this.api = new CommunityApi(this.client);
      void this.load();
    }
  }

  private async load(): Promise<void> {
    if (!this.api) return;
    try {
      const st = await this.api.setupState();
      this.settings = st.settings;
      this.status = st.status;
      this.team = st.team;
      this.hydrate(st.settings);
      const fromUrl = parseStep(location.search);
      await this.go(fromUrl ?? (Math.min(10, Math.max(1, st.settings.setupStep)) as WizardStepN), false);
    } catch (err) {
      this.err = err instanceof Error ? err.message : String(err);
    }
  }

  private hydrate(s: Settings) {
    this.channelMap = { ...s.channelMap };
    this.roleMap = { ...s.roleMap };
    this.trading = [...s.compliance.tradingChannelIds];
    this.questions = structuredClone(s.questions);
    this.welcomeDm = s.welcomeDm;
    this.offerLinks = { ...(s.offerLinks ?? {}) };
    this.preset = s.moderation.preset;
    this.claimsText = s.moderation.extraBannedClaims.join("\n");
    this.domainsText = s.moderation.extraScamDomains.join("\n");
    this.disclaimer = s.compliance.disclaimer;
    this.repostEvery = s.compliance.repostEvery;
    this.regionsText = s.compliance.blockedRegions.join(", ");
    this.testRun = s.testRun;
  }

  private async go(step: WizardStepN, push = true) {
    this.stopPoll();
    this.err = null;
    this.notice = null;
    this.issues = [];
    this.step = step;
    if (push) history.replaceState(history.state, "", withStep(location.href, step));
    else history.replaceState(history.state, "", withStep(location.href, step));
    const api = this.api;
    if (!api) return;
    try {
      if ((step === 1 || step === 2) && this.status?.connection.tokenConfigured && !this.validation) {
        this.validation = await api.validateToken();
      }
      if (step === 2) {
        await this.loadGuilds();
        this.poll = setInterval(() => void this.loadGuilds(), 3000);
      }
      if (step === 3) await this.loadGuilds();
      if (step === 3 || step === 4) {
        if (this.settings?.guildId) this.discovery = await api.discovery();
      }
    } catch (err) {
      this.err = err instanceof Error ? err.message : String(err);
    }
  }

  private stopPoll() {
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
  }

  private async loadGuilds() {
    try {
      this.guilds = (await this.api!.guilds()).guilds;
    } catch (err) {
      this.guilds = null;
      this.err = err instanceof Error ? err.message : String(err);
    }
  }

  private async run(fn: () => Promise<void>) {
    this.busy = true;
    this.err = null;
    try {
      await fn();
      this.dispatchEvent(new CustomEvent("community-changed", { bubbles: true, composed: true }));
    } catch (err) {
      this.err = err instanceof Error ? err.message : String(err);
    } finally {
      this.busy = false;
    }
  }

  private async reloadState() {
    const st = await this.api!.setupState();
    this.settings = st.settings;
    this.status = st.status;
    this.team = st.team;
  }

  // ── chrome ──────────────────────────────────────────────────────────────

  render() {
    if (!this.settings) {
      return html`<div class="cmx-panel"><div class="cmx-empty">${this.err ? html`<span class="cmx-err">${this.err}</span>` : "Loading setup…"}</div></div>`;
    }
    const states = stepStates(this.settings, this.status, this.step);
    return html`<div class="cmx-wiz" data-testid="community-wizard" data-step=${this.step}>
      <ol class="cmx-steps">
        ${WIZARD_STEPS.map(
          (s, i) => html`<li class=${states[i]}><button @click=${() => this.go(s.n)} aria-current=${s.n === this.step ? "step" : "false"}>
            <span class="num">${states[i] === "done" ? icon("check") : s.n}</span><span class="lbl">${s.label}</span></button></li>`,
        )}
      </ol>
      <section class="cmx-panel"><div class="cmx-panel-b cmx-step">
        ${this.renderStep()}
        ${this.err ? html`<div class="cmx-banner fail">${icon("alert")}<span>${this.err}</span></div>` : nothing}
        ${this.notice ? html`<div class="cmx-banner">${icon("checkCircle")}<span>${this.notice}</span></div>` : nothing}
        ${this.issues.length ? html`<div class="cmx-banner warn">${icon("alert")}<span>${this.issues.join(" ")}</span></div>` : nothing}
        <div class="cmx-nav">
          <button class="cmx-btn" ?disabled=${this.step === 1} @click=${() => this.go((this.step - 1) as WizardStepN)}>${icon("arrowLeft")} Back</button>
          ${this.step < 10 ? html`<button class="cmx-btn" @click=${() => this.go((this.step + 1) as WizardStepN)}>Skip for now ${icon("arrowRight")}</button>` : nothing}
        </div>
      </div></section>
    </div>`;
  }

  private head(kicker: string, title: string, body: string | TemplateResult) {
    return html`<div class="cmx-step-h"><div><div class="cmx-kicker">${kicker}</div><h2>${title}</h2><p>${body}</p></div></div>`;
  }

  private health(checks: HealthCheck[]) {
    if (!checks.length) return nothing;
    return html`<div class="cmx-health" data-testid="health-strip">${checks.map(
      (c) => html`<span class="cmx-check ${c.state}" title=${c.detail}>${icon(c.state === "ok" ? "checkCircle" : c.state === "warn" ? "alertCircle" : "xCircle")}<b>${c.label}</b><small>${c.detail}</small></span>`,
    )}</div>`;
  }

  private renderStep(): TemplateResult {
    switch (this.step) {
      case 1: return this.stepConnect();
      case 2: return this.stepInvite();
      case 3: return this.stepServer();
      case 4: return this.stepMapping();
      case 5: return this.stepIntake();
      case 6: return this.stepModeration();
      case 7: return this.stepTeam();
      case 8: return this.stepCompliance();
      case 9: return this.stepTest();
      default: return this.stepLive();
    }
  }

  // ── 1. Connect bot ──────────────────────────────────────────────────────

  private stepConnect() {
    const v = this.validation;
    const saved = this.status?.connection.tokenConfigured;
    return html`
      ${this.head("Step 1 of 10", "Connect your Discord bot", "Create the bot once in the Discord Developer Portal, then paste its token here. The token is stored in your gateway config and never shown again.")}
      <ol class="cmx-guide">
        <li>Open <a href="https://discord.com/developers/applications" target="_blank" rel="noopener">discord.com/developers/applications</a> → <b>New Application</b> (e.g. "YCS Community Manager").</li>
        <li><b>Bot</b> tab → turn <b>Public Bot</b> off → under <b>Privileged Gateway Intents</b> turn on <b>Server Members</b> and <b>Message Content</b> (leave Presence off).</li>
        <li><b>Reset Token</b> → copy it → paste below.</li>
      </ol>
      ${saved ? html`<div class="cmx-banner">${icon("lock")}<span>A token is saved for account <span class="cmx-mono">${this.settings!.accountId}</span>. Paste a new one only to replace it.</span>
        <button class="cmx-btn sm" ?disabled=${this.busy} @click=${() => this.run(async () => { this.validation = await this.api!.validateToken(); })}>${icon("refresh")} Re-check</button></div>` : nothing}
      <div class="cmx-row">
        <label class="grow"><span class="cmx-label">Bot token</span>
          <input class="cmx-input" type="password" autocomplete="off" spellcheck="false" placeholder=${saved ? "•••••••• saved — paste to replace" : "Paste the bot token"}
            data-testid="token-input" .value=${this.tokenInput} @input=${(e: Event) => (this.tokenInput = (e.target as HTMLInputElement).value)} /></label>
        <button class="cmx-btn" ?disabled=${this.busy || !this.tokenInput.trim()} @click=${() => this.run(async () => { this.validation = await this.api!.validateToken(this.tokenInput.trim()); })}>${icon("shieldCheck")} Check</button>
        <button class="cmx-btn primary" ?disabled=${this.busy || !this.tokenInput.trim()} @click=${() => this.saveToken(false)}>${icon("save")} Save & continue</button>
      </div>
      ${this.needsRestart ? html`<div class="cmx-banner warn" data-testid="needs-restart">${icon("alert")}<span>The Discord channel plugin is off, so saving the token now restarts the gateway (running agents and coder runs stop). Turn on Discord in Plugins during a planned restart, then save — or save and restart now.</span>
        <button class="cmx-btn sm danger" ?disabled=${this.busy || !this.tokenInput.trim()} @click=${() => { if (confirm("Save the token and restart the gateway now?")) this.saveToken(true); }}>${icon("refresh")} Save and restart</button></div>` : nothing}
      ${v?.bot ? html`<div class="cmx-bot" data-testid="bot-identity">
          ${v.bot.avatarUrl ? html`<img src=${v.bot.avatarUrl} alt="" />` : html`<span class="ph">${icon("bot")}</span>`}
          <div><b>${v.bot.globalName ?? v.bot.username}</b> <span class="meta">@${v.bot.username} · id <span class="cmx-mono">${v.bot.id}</span>${v.application ? html` · app flags <span class="cmx-mono">${v.application.flags}</span>` : nothing}</span></div></div>` : nothing}
      ${v ? this.health(v.checks) : nothing}
      ${v?.error ? html`<div class="cmx-err">${v.error}</div>` : nothing}
    `;
  }

  private saveToken(allowRestart: boolean) {
    void this.run(async () => {
      const r = await this.api!.saveToken(this.tokenInput.trim(), allowRestart);
      this.validation = r;
      this.needsRestart = r.needsRestart === true;
      if (r.saved) {
        this.tokenInput = "";
        await this.reloadState();
        this.notice = `Saved. Connected as ${r.bot?.username}.`;
        if (r.ok) await this.go(2);
      }
    });
  }

  // ── 2. Invite bot ───────────────────────────────────────────────────────

  private stepInvite() {
    const url = this.validation?.inviteUrl;
    const count = this.guilds?.length ?? 0;
    return html`
      ${this.head("Step 2 of 10", "Invite the bot to your server", "Open the link, pick your server and approve. You need Manage Server on that server. The link asks for setup permissions (no Administrator); you can trim Manage Channels after setup.")}
      ${url ? html`<div class="cmx-row"><input class="cmx-input grow cmx-mono" readonly .value=${url} data-testid="invite-url" />
          <a class="cmx-btn primary" href=${url} target="_blank" rel="noopener">${icon("externalLink")} Open invite link</a>
          <button class="cmx-btn" @click=${() => { void navigator.clipboard?.writeText(url); this.notice = "Invite link copied."; }}>${icon("copy")} Copy</button></div>`
        : html`<div class="cmx-banner warn">${icon("alert")}<span>Connect the bot in step 1 first — the invite link uses its application id.</span></div>`}
      ${this.health([
        { id: "poll", label: "Bot servers", state: count ? "ok" : "warn", detail: count ? `In ${count} server(s)` : "Waiting for a server… (checking every 3 s)" },
      ])}
      ${count ? html`<div><button class="cmx-btn primary" @click=${() => this.go(3)}>Server found — continue ${icon("arrowRight")}</button></div>` : nothing}
    `;
  }

  // ── 3. Pick server ──────────────────────────────────────────────────────

  private stepServer() {
    const sel = this.settings!.guildId;
    return html`
      ${this.head("Step 3 of 10", "Pick the server", "Choose the server the Community Manager runs. Messages there are routed to the Community agent, never your main agent.")}
      ${this.guilds?.length
        ? html`<div class="cmx-guilds">${this.guilds.map((g) => html`<button class="cmx-guild ${g.id === sel ? "sel" : ""}" ?disabled=${this.busy} data-testid="guild-card"
            @click=${() => this.run(async () => {
              const r = await this.api!.selectGuild(g.id);
              this.settings = r.settings;
              this.discovery = await this.api!.discovery();
              this.notice = `${g.name} selected and bound to the Community agent.`;
            })}>
            <span class="gi">${g.iconUrl ? html`<img src=${g.iconUrl} alt="" />` : g.name.slice(0, 2).toUpperCase()}</span>
            <span><b>${g.name}</b><span>${g.memberCount?.toLocaleString("en-US") ?? "?"} members · ${g.admin ? "bot is admin" : g.missingPermissions.length ? `missing ${g.missingPermissions.length} permission(s)` : "permissions OK"}</span></span>
          </button>`)}</div>`
        : html`<div class="cmx-empty">The bot isn't in any server yet — use the invite link in step 2.</div>`}
      ${sel && this.guilds ? (() => {
        const g = this.guilds.find((x) => x.id === sel);
        const checks: HealthCheck[] = g
          ? [
              { id: "members", label: "Members", state: "ok", detail: g.memberCount?.toLocaleString("en-US") ?? "?" },
              { id: "perms", label: "Permissions", state: g.missingPermissions.length ? "fail" : g.admin ? "warn" : "ok", detail: g.missingPermissions.length ? `Missing: ${g.missingPermissions.join(", ")}` : g.admin ? "Administrator — works, but least privilege is safer" : "All required permissions" },
            ]
          : [];
        return this.health([...checks, ...(this.discovery?.checks ?? [])]);
      })() : nothing}
      ${sel ? html`<div><button class="cmx-btn primary" @click=${() => this.go(4)}>Continue ${icon("arrowRight")}</button></div>` : nothing}
    `;
  }

  // ── 4. Channels & roles ─────────────────────────────────────────────────

  private stepMapping() {
    const d = this.discovery;
    if (!d) return html`${this.head("Step 4 of 10", "Channels and roles", "Pick a server first.")}`;
    const text = d.channels.filter((c) => c.type === 0 || c.type === 5 || c.type === "text" || c.type === "announcement");
    const missing = [...CHANNEL_PURPOSES.filter((p) => p.required && !this.channelMap[p.id]).map((p) => p.label), ...ROLE_PURPOSES.filter((r) => r.required && !this.roleMap[r.id]).map((r) => r.label)];
    return html`
      ${this.head("Step 4 of 10", "Channels and roles", "Map your existing channels and roles to what the Community Manager does. Tag trading channels so the Pulse risk disclaimer is attached there.")}
      ${this.health([
        ...d.checks,
        { id: "mapped", label: "Required mappings", state: missing.length ? "fail" : "ok", detail: missing.length ? `Still needed: ${missing.join(", ")}` : "All mapped" },
      ])}
      <div class="cmx-label">Channels</div>
      <div class="cmx-map">${CHANNEL_PURPOSES.map((p) => html`<label class="cmx-map-item"><span class="cmx-label">${p.label}${p.required ? " *" : ""}</span>
        <select class="cmx-select" data-purpose=${p.id} @change=${(e: Event) => (this.channelMap = { ...this.channelMap, [p.id]: (e.target as HTMLSelectElement).value || undefined })}>
          <option value="">— not mapped —</option>
          ${text.map((c) => html`<option value=${c.id} ?selected=${this.channelMap[p.id] === c.id}>#${c.name}</option>`)}
        </select><small>${p.hint}</small></label>`)}</div>
      <div class="cmx-label">Roles</div>
      <div class="cmx-map">${ROLE_PURPOSES.map((r) => html`<label class="cmx-map-item"><span class="cmx-label">${r.label}${r.required ? " *" : ""}</span>
        <select class="cmx-select" @change=${(e: Event) => (this.roleMap = { ...this.roleMap, [r.id]: (e.target as HTMLSelectElement).value || undefined })}>
          <option value="">— not mapped —</option>
          ${d.roles.filter((x) => !x.managed).map((x) => html`<option value=${x.id} ?selected=${this.roleMap[r.id] === x.id}>${x.name}${x.aboveBot ? " (above bot)" : ""}</option>`)}
        </select></label>`)}</div>
      <div class="cmx-label">Trading channels (Pulse / Gold Desk — compliance: trading)</div>
      <div class="cmx-offers">${text.map((c) => html`<button class="cmx-chip ${this.trading.includes(c.id) ? "on" : ""}" @click=${() => (this.trading = this.trading.includes(c.id) ? this.trading.filter((x) => x !== c.id) : [...this.trading, c.id])}>#${c.name}</button>`)}</div>
      <div><button class="cmx-btn primary" ?disabled=${this.busy} @click=${() => this.run(async () => {
        const r = await this.api!.saveMapping({ channelMap: this.channelMap, roleMap: this.roleMap, tradingChannelIds: this.trading });
        this.settings = r.settings;
        this.issues = r.issues;
        if (!r.issues.length) await this.go(5);
      })}>${icon("save")} Save mapping</button></div>
    `;
  }

  // ── 5. Questionnaire ────────────────────────────────────────────────────

  private stepIntake() {
    const total = weightTotal(this.questions);
    const first = this.questions[0];
    const set = (qi: number, patch: Partial<IntakeQuestion>) => {
      this.questions = this.questions.map((q, i) => (i === qi ? { ...q, ...patch } : q));
    };
    const setOpt = (qi: number, oi: number, patch: Record<string, unknown>) => {
      set(qi, { options: this.questions[qi]!.options.map((o, j) => (j === oi ? { ...o, ...patch } : o)) });
    };
    return html`
      ${this.head("Step 5 of 10", "Onboarding questionnaire", "After Verify, members answer these as Discord select menus. Each answer has points (0–100); weights add up to 100 and give the lead score. Hot ≥ 60 goes straight to an onboarder.")}
      ${this.health([
        { id: "weights", label: "Weights", state: total === 100 ? "ok" : "fail", detail: `${total} / 100` },
        { id: "count", label: "Questions", state: this.questions.length <= 5 ? "ok" : "fail", detail: `${this.questions.length} (max 5)` },
      ])}
      <div class="cmx-split">
        <div class="cmx-col">${this.questions.map((q, qi) => html`<div class="cmx-q">
          <div class="cmx-q-h"><input class="cmx-input" .value=${q.label} @input=${(e: Event) => set(qi, { label: (e.target as HTMLInputElement).value })} />
            <input class="cmx-input" type="number" min="0" max="100" title="Weight" .value=${String(q.weight)} @input=${(e: Event) => set(qi, { weight: Number((e.target as HTMLInputElement).value) })} /></div>
          ${q.options.map((o, oi) => html`<div class="cmx-opt">
            <input class="cmx-input" .value=${o.label} @input=${(e: Event) => setOpt(qi, oi, { label: (e.target as HTMLInputElement).value })} />
            <input class="cmx-input" type="number" min="0" max="100" title="Points" .value=${String(o.points)} @input=${(e: Event) => setOpt(qi, oi, { points: Number((e.target as HTMLInputElement).value) })} />
            <select class="cmx-select" title=${o.offer ? `Interest → ${OFFER_LABELS[o.offer]}` : "Not an interest answer"} @change=${(e: Event) => setOpt(qi, oi, { offer: ((e.target as HTMLSelectElement).value || undefined) as Offer | undefined })}>
              <option value="">— none</option>${OFFERS.map((of) => html`<option value=${of} title=${OFFER_LABELS[of]} ?selected=${o.offer === of}>${OFFER_SHORT[of]}</option>`)}
            </select></div>`)}
        </div>`)}</div>
        <div class="cmx-col">
          <label><span class="cmx-label">Welcome DM ({name} = member name, {offers} = default route)</span><textarea class="cmx-textarea" .value=${this.welcomeDm} @input=${(e: Event) => (this.welcomeDm = (e.target as HTMLTextAreaElement).value)}></textarea></label>
          <div class="cmx-label">Welcome DM preview</div>
          <div class="cmx-preview" data-testid="welcome-preview"><span class="who">Community Manager</span><span class="bot">BOT</span>
            <div style="margin-top:4px;white-space:pre-line">${renderWelcomeDm(this.welcomeDm, "maya", { channelMap: this.channelMap, offerLinks: this.offerLinks })}</div></div>
          <div class="cmx-label">After Verify</div>
          <div class="cmx-preview"><span class="who">Community Manager</span><span class="bot">BOT</span>
            <div style="margin-top:4px">You're verified! A few quick questions so we can point you to the right place.<br /><b>${first?.label ?? ""}</b></div>
            <div class="sel"><span>${first?.label ?? "Select…"}</span>${icon("chevronDown")}</div></div>
          ${this.renderRoutingMatrix()}
          <div class="cmx-label">Offer links (optional, https only — shown next to the channel in every next step)</div>
          ${ROUTED_OFFERS.map((o) => html`<label class="cmx-link-row"><span class="cmx-offer ${o}">${OFFER_LABELS[o]}</span>
            <input class="cmx-input" type="url" placeholder="Owner to fill" .value=${this.offerLinks[o] ?? ""} @input=${(e: Event) => (this.offerLinks = { ...this.offerLinks, [o]: (e.target as HTMLInputElement).value.trim() })} /></label>`)}
        </div>
      </div>
      <div class="cmx-row"><span class="cmx-weights ${total === 100 ? "good" : "bad"}">Weights: ${total} / 100</span>
        <button class="cmx-btn primary" ?disabled=${this.busy} @click=${() => this.run(async () => {
          const r = await this.api!.saveQuestions(this.questions, this.welcomeDm, this.offerLinks);
          this.settings = r.settings;
          this.issues = r.issues;
          if (!r.issues.length) await this.go(6);
        })}>${icon("save")} Save questions</button></div>
    `;
  }

  /** Who goes where with the questions as edited — every row has a primary + secondary offer. */
  private renderRoutingMatrix() {
    const rows = routingMatrix(this.questions, this.settings ? { channelMap: this.channelMap, offerLinks: this.offerLinks, compliance: this.settings.compliance } : null);
    return html`<div class="cmx-label">Who goes where (no dead ends)</div>
      <div class="cmx-matrix" data-testid="routing-matrix">${rows.map((r) => html`<div class="cmx-matrix-row ${r.id === "fallback" ? "fallback" : ""}">
        <span class="who">${r.who}</span>
        <span class="offers"><span class="cmx-offer ${r.route.primaryOffer}">${OFFER_LABELS[r.route.primaryOffer]}</span><span class="cmx-offer2">+ ${OFFER_LABELS[r.route.secondaryOffer]}</span></span>
        <span class="cta">${r.route.cta.split("\n")[0]}</span></div>`)}</div>`;
  }

  // ── 6. Moderation ───────────────────────────────────────────────────────

  private stepModeration() {
    return html`
      ${this.head("Step 6 of 10", "Moderation preset", "Scam links and banned financial claims are deleted in seconds and the author is quarantined for 1 hour. Bans, kicks and longer timeouts always wait for your approval.")}
      <div class="cmx-presets">${(["relaxed", "standard", "strict"] as ModPreset[]).map((p) => html`<button class="cmx-preset ${this.preset === p ? "sel" : ""}" @click=${() => (this.preset = p)}><b>${PRESET_COPY[p].title}</b><span>${PRESET_COPY[p].body}</span></button>`)}</div>
      ${this.health([
        { id: "ladder", label: "Escalation", state: "ok", detail: "warn → delete → 1 h timeout (auto) · 24 h / kick / ban (approval)" },
        { id: "claims", label: "Banned claims", state: "ok", detail: `12 built in + ${parseList(this.claimsText).length} yours` },
        { id: "domains", label: "Scam domains", state: "ok", detail: `6 built in + lookalike check + ${parseList(this.domainsText).length} yours` },
      ])}
      <div class="cmx-row">
        <label class="grow"><span class="cmx-label">Extra banned phrases (one per line)</span><textarea class="cmx-textarea" .value=${this.claimsText} @input=${(e: Event) => (this.claimsText = (e.target as HTMLTextAreaElement).value)}></textarea></label>
        <label class="grow"><span class="cmx-label">Extra scam domains (one per line)</span><textarea class="cmx-textarea" .value=${this.domainsText} @input=${(e: Event) => (this.domainsText = (e.target as HTMLTextAreaElement).value)}></textarea></label>
      </div>
      <div><button class="cmx-btn primary" ?disabled=${this.busy} @click=${() => this.run(async () => {
        const r = await this.api!.savePreset({ preset: this.preset, extraBannedClaims: parseList(this.claimsText), extraScamDomains: parseList(this.domainsText) });
        this.settings = r.settings;
        await this.go(7);
      })}>${icon("save")} Save preset</button></div>
    `;
  }

  // ── 7. Team ─────────────────────────────────────────────────────────────

  private stepTeam() {
    const set = (i: number, patch: Partial<TeamMember>) => (this.team = this.team.map((t, j) => (j === i ? { ...t, ...patch } : t)));
    const onboarders = this.team.filter((t) => t.active && t.role !== "moderator");
    return html`
      ${this.head("Step 7 of 10", "Team", "Add onboarders and moderators by Discord user id (Developer Mode → right-click → Copy User ID). Hot leads go to the least-busy active onboarder who handles that offer.")}
      ${this.health([{ id: "onboarders", label: "Onboarders", state: onboarders.length ? "ok" : "warn", detail: onboarders.length ? `${onboarders.length} active` : "None yet — hot leads will be unassigned" }])}
      ${this.team.map((t, i) => html`<div class="cmx-team-row">
        <input class="cmx-input cmx-mono" placeholder="Discord user id" .value=${t.discordId} @input=${(e: Event) => set(i, { discordId: (e.target as HTMLInputElement).value.trim() })} />
        <input class="cmx-input" placeholder="Name" .value=${t.name} @input=${(e: Event) => set(i, { name: (e.target as HTMLInputElement).value })} />
        <select class="cmx-select" @change=${(e: Event) => set(i, { role: (e.target as HTMLSelectElement).value as TeamMember["role"] })}>
          ${(["onboarder", "moderator", "manager"] as const).map((r) => html`<option value=${r} ?selected=${t.role === r}>${r}</option>`)}</select>
        <div class="cmx-offers">${OFFERS.filter((o) => o !== "none").map((o) => html`<button class="cmx-chip ${t.offers.includes(o) ? "on" : ""}" @click=${() => set(i, { offers: t.offers.includes(o) ? t.offers.filter((x) => x !== o) : [...t.offers, o] })}>${OFFER_LABELS[o]}</button>`)}</div>
        <button class="cmx-btn sm" title="Remove" @click=${() => (this.team = this.team.filter((_, j) => j !== i))}>${icon("trash")}</button>
      </div>`)}
      <div class="cmx-row">
        <button class="cmx-btn" @click=${() => (this.team = [...this.team, { discordId: "", name: "", role: "onboarder", offers: [], active: true }])}>${icon("personPlus")} Add member</button>
        <button class="cmx-btn primary" ?disabled=${this.busy} @click=${() => this.run(async () => {
          this.team = (await this.api!.saveTeam(this.team)).team;
          await this.reloadState();
          await this.go(8);
        })}>${icon("save")} Save team</button>
      </div>
    `;
  }

  // ── 8. Compliance ───────────────────────────────────────────────────────

  private stepCompliance() {
    const tagged = this.settings!.compliance.tradingChannelIds.length;
    return html`
      ${this.head("Step 8 of 10", "Compliance (Pulse / Gold Desk)", "The disclaimer is footed onto every bot message in trading channels and re-posted every N messages. The bot refuses to send banned claims. This text is a draft — have it legally reviewed before Pulse channels go live.")}
      ${this.health([
        { id: "tagged", label: "Trading channels", state: tagged ? "ok" : "warn", detail: tagged ? `${tagged} tagged` : "None tagged (step 4)" },
        { id: "disclaimer", label: "Disclaimer", state: this.disclaimer.trim() ? "ok" : "fail", detail: this.disclaimer.trim() ? `${this.disclaimer.trim().length} chars` : "Empty" },
        { id: "regions", label: "Blocked regions", state: parseList(this.regionsText).length ? "ok" : "warn", detail: parseList(this.regionsText).length ? parseList(this.regionsText).join(", ") : "Owner to decide" },
      ])}
      <label><span class="cmx-label">Risk disclaimer</span><textarea class="cmx-textarea" .value=${this.disclaimer} @input=${(e: Event) => (this.disclaimer = (e.target as HTMLTextAreaElement).value)}></textarea></label>
      <div class="cmx-row">
        <label style="min-width:200px"><span class="cmx-label">Re-post every N messages</span><input class="cmx-input" type="number" min="5" max="500" .value=${String(this.repostEvery)} @input=${(e: Event) => (this.repostEvery = Number((e.target as HTMLInputElement).value))} /></label>
        <label class="grow"><span class="cmx-label">Blocked regions (comma separated)</span><input class="cmx-input" .value=${this.regionsText} @input=${(e: Event) => (this.regionsText = (e.target as HTMLInputElement).value)} /></label>
      </div>
      <div><button class="cmx-btn primary" ?disabled=${this.busy || !this.disclaimer.trim()} @click=${() => this.run(async () => {
        const r = await this.api!.savePreset({ preset: this.preset, compliance: { disclaimer: this.disclaimer, repostEvery: this.repostEvery, blockedRegions: parseList(this.regionsText) } });
        this.settings = r.settings;
        await this.go(9);
      })}>${icon("save")} Save compliance</button></div>
    `;
  }

  // ── 9. Test run ─────────────────────────────────────────────────────────

  private stepTest() {
    const r = this.testRun;
    return html`
      ${this.head("Step 9 of 10", "Test run", "Walks the whole flow with your real settings in a sandbox — nothing is sent to Discord: join → welcome DM → Verify → questions → lead → onboarder thread → scam message → ban approval → banned claim → disclaimer → ticket → @everyone gate → pause.")}
      ${r ? this.health([{ id: "result", label: "Result", state: r.ok ? "ok" : "fail", detail: `${r.steps.filter((x) => x.ok).length} / ${r.steps.length} passed · ${new Date(r.at).toLocaleString()}` }]) : nothing}
      <div><button class="cmx-btn primary" ?disabled=${this.busy} data-testid="run-test" @click=${() => this.run(async () => {
        this.testRun = await this.api!.testRun();
        await this.reloadState();
      })}>${icon("play")} ${r ? "Run again" : "Run test"}</button></div>
      ${r ? html`<ul class="cmx-steprun">${r.steps.map((s) => html`<li class=${s.ok ? "ok" : "fail"}>${icon(s.ok ? "checkCircle" : "xCircle")}<b>${s.label}</b><span>${s.detail}</span></li>`)}</ul>` : nothing}
      ${r?.ok ? html`<div><button class="cmx-btn" @click=${() => this.go(10)}>Continue ${icon("arrowRight")}</button></div>` : nothing}
    `;
  }

  // ── 10. Go live ─────────────────────────────────────────────────────────

  private stepLive() {
    const s = this.settings!;
    const conn = this.status?.connection;
    const checks: HealthCheck[] = [
      { id: "token", label: "Bot connected", state: conn?.tokenConfigured ? "ok" : "fail", detail: conn?.tokenConfigured ? "Token saved" : "Step 1" },
      { id: "server", label: "Server", state: s.guildId ? "ok" : "fail", detail: s.guildName ?? "Step 3" },
      { id: "mapping", label: "Mapping", state: s.channelMap["start-here"] && s.roleMap.verified ? "ok" : "fail", detail: s.channelMap["start-here"] ? "Done" : "Step 4" },
      { id: "test", label: "Test run", state: s.testRun?.ok ? "ok" : "fail", detail: s.testRun?.ok ? "Passed" : "Step 9" },
      { id: "discord", label: "Discord channel plugin", state: conn?.discordPluginEnabled ? "ok" : "warn", detail: conn?.discordPluginEnabled ? "On" : "Off — enable Discord in Plugins (one gateway restart) so events arrive" },
    ];
    return html`
      ${this.head("Step 10 of 10", "Go live", "Start in Shadow for 24–48 h: the Community Manager logs everything it would do and touches nothing. Switch to Live when the log looks right. Pause stops everything at once.")}
      ${this.health(checks)}
      <div class="cmx-modes">
        <button class="cmx-preset ${s.mode === "shadow" ? "sel" : ""}" ?disabled=${this.busy} data-testid="go-shadow" @click=${() => this.goLive("shadow")}>
          <b>${icon("eye")} Shadow</b><span>Log only. Recommended first for the revival.</span></button>
        <button class="cmx-preset ${s.mode === "live" ? "sel" : ""}" ?disabled=${this.busy} data-testid="go-live" @click=${() => this.goLive("live")}>
          <b>${icon("rocket")} Live</b><span>Acts on Discord: roles, welcome DMs, deletions, threads. Posts the Verify panel in #start-here.</span></button>
      </div>
      ${s.mode === "shadow"
        ? html`<div class="cmx-livemods" data-testid="live-modules">
            <b>Live while in Shadow</b>
            <span class="cmx-note">Turn on single modules (for example the welcome greeting) while everything else keeps logging only.</span>
            <div class="cmx-livemods-row">
              ${LIVE_MODULES.map((m) => {
                const on = (s.liveModules ?? []).includes(m);
                return html`<button class="cmx-btn ${on ? "ok" : ""}" ?disabled=${this.busy} aria-pressed=${on ? "true" : "false"}
                  data-testid="live-module-${m}" @click=${() => this.toggleLiveModule(m)}>${on ? "● " : "○ "}${LIVE_MODULE_LABELS[m]}</button>`;
              })}
            </div>
          </div>`
        : nothing}
      <p class="cmx-note">Current mode: <b>${s.mode}</b>${s.paused ? " (paused)" : ""}${s.mode === "shadow" && s.liveModules?.length
        ? html` · live: <b>${s.liveModules.map((m) => LIVE_MODULE_LABELS[m]).join(", ")}</b>`
        : nothing}.</p>
    `;
  }

  private toggleLiveModule(m: LiveModule) {
    void this.run(async () => {
      const cur = this.settings?.liveModules ?? [];
      const next = cur.includes(m) ? cur.filter((x) => x !== m) : [...cur, m];
      const r = await this.api!.liveModules(next);
      await this.reloadState();
      this.notice = r.liveModules.length ? `Live in Shadow: ${r.liveModules.map((x) => LIVE_MODULE_LABELS[x]).join(", ")}.` : "Shadow logs everything.";
      this.dispatchEvent(new CustomEvent("community-changed", { bubbles: true, composed: true }));
    });
  }

  private goLive(mode: "shadow" | "live") {
    void this.run(async () => {
      const r = await this.api!.goLive(mode, mode === "live");
      if (!r.ok) {
        this.issues = r.blockers ?? [];
        return;
      }
      await this.reloadState();
      this.notice = mode === "live" ? `Live${r.verifyPanelPosted ? " — Verify panel posted." : "."}` : "Shadow mode on — watch the activity feed.";
      this.dispatchEvent(new CustomEvent("community-done", { bubbles: true, composed: true }));
    });
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "community-setup-wizard": CommunitySetupWizard;
  }
}
