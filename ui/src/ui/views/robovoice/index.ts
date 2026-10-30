/**
 * Robovoice — settings page for the first-party `robovoice` plugin
 * (manifest v2 page, builtin "robovoice"; plugin-gated in plugin-host.ts).
 *
 * Sections: voice provider status/switch, Robovoice account link (device-code
 * sign-in → this install becomes a Robovoice location; agents, calls, credits),
 * connection (deployment, URL, edge device + secrets), InfiniBot agent →
 * Robovoice character mapping, effective
 * pipelines with self-host-only safety labels, cloud credit usage, and the
 * MCP endpoint Robovoice characters use to reach InfiniBot tools.
 * Every call goes through the plugin's robovoice.* RPCs.
 */

import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../../gateway.js";
import { awaitGatewayClient, getGatewayClient } from "../../gateway-client.js";
import type { GatewayAgentRow } from "../../types.js";
import "../../components/robovoice-link.js";
import "../../components/robovoice-agent-voice.js";
import type { VoiceAgentsPayload } from "../../components/robovoice-agent-voice.js";
import "./pipeline-editor.js";

type SecretState = { set: boolean; source?: "stored" | "config" | "env"; hint?: string };
type Settings = {
  deployment: "self-hosted" | "cloud";
  baseUrl: string;
  deviceId?: string;
  locationId?: string;
  expressive?: boolean;
  defaultCharacterId?: string;
  characterMap: Record<string, string>;
  wakeWord?: { engine?: string; model?: string };
  mcpTools?: string[];
  mcpPublicUrl?: string;
  link?: { orgName?: string; locationName?: string; deviceId?: string; unlinkedAt?: string };
};
type SettingsView = {
  settings: Settings;
  secrets: { deviceKey: SecretState; edgeToken: SecretState };
  legacyUrl: string | null;
};
type Character = { id: string; name: string; description?: string; tts_provider?: string; language?: string };
type Stage = { provider?: string | null; model?: string | null; state?: string | null };
type Pipeline = { character_id?: string | null; mode?: string; stt?: Stage; llm?: Stage; tts?: Stage; resolved?: boolean };
type SafetyFlag = { code: string; subject: string; message: string };
type Credits =
  | {
      available: true;
      orgName?: string;
      balanceUsd: number;
      heldUsd: number;
      availableUsd: number;
      availableCredits: number;
      heldCredits?: number;
      creditUsd?: number;
      creditsPerSecond?: number;
      monthMinutes?: number;
      monthChargeUsd?: number;
      lowBalance?: boolean;
    }
  | { available: false; reason: string };

type VoiceLlmStatus = {
  publicUrl: string | null;
  baseUrl: string | null;
  locationId: string | null;
  token: { hint: string } | null;
  bound: boolean;
  agents: string[];
  ownerCallerEmails: string[];
  turns: Array<{ at: string; agentId: string; backend: string; trust: string; ok: boolean; firstTokenMs: number | null; totalMs: number; error?: string }>;
  summary: { turns: number; ok: number; firstTokenP50Ms: number | null };
};

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

@customElement("robovoice-view")
export class RobovoiceView extends LitElement {
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;
  @property({ attribute: false }) state: unknown = null;

  @state() private view: SettingsView | null = null;
  @state() private form: Partial<Settings> = {};
  @state() private secretDraft: { deviceKey: string; edgeToken: string } = { deviceKey: "", edgeToken: "" };
  @state() private characters: Character[] = [];
  @state() private charactersError: string | null = null;
  @state() private agents: GatewayAgentRow[] = [];
  @state() private pipelines: Pipeline[] = [];
  @state() private safety: { flags: SafetyFlag[]; cloudViolation: boolean } = { flags: [], cloudViolation: false };
  @state() private credits: Credits | null = null;
  @state() private testResult: { ok: boolean; text: string } | null = null;
  @state() private saving = false;
  @state() private note: { text: string; error?: boolean } | null = null;
  @state() private loadError: string | null = null;
  @state() private voiceAgents: VoiceAgentsPayload | null = null;
  @state() private voiceLlm: VoiceLlmStatus | null = null;
  @state() private ownerEmailsDraft: string | null = null;
  private loadAttempts = 0;

  static styles = css`
    :host {
      display: block; padding: 20px clamp(12px, 3vw, 28px) 48px; font-size: 13px;
      /* Page-local aliases onto the real theme tokens (dark + light). */
      --c-text: var(--text); --c-text-2: var(--muted); --g-line: var(--border);
      --g-surface: var(--card); --c-accent: var(--accent);
      color: var(--c-text, #e8e6e3);
      min-height: 100%; box-sizing: border-box;
      background:
        radial-gradient(70% 420px at 50% -10%, color-mix(in srgb, var(--glass-gold, var(--g-primary)) 18%, transparent), transparent 72%),
        transparent;
    }
    .section-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin: 6px 0 -4px; }
    .section-head h2 { font-size: 16px; margin: 0; font-weight: 600; color: var(--text-strong); }
    .rows-head { display: grid; grid-template-columns: minmax(120px, 1.1fr) auto minmax(150px, 1fr) minmax(150px, 1.2fr) minmax(110px, 0.8fr); gap: 10px; padding-bottom: 6px; border-bottom: 1px solid var(--g-line); }
    .rows-head span { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--c-text-2); }
    @media (max-width: 760px) { .rows-head { display: none; } }
    .kv { display: grid; grid-template-columns: max-content 1fr; gap: 6px 14px; align-items: baseline; }
    .wrap { max-width: 1080px; margin: 0 auto; display: grid; gap: 16px; }
    h1 { font-size: 22px; margin: 0; font-weight: 700; letter-spacing: -0.01em; }
    .sub { color: var(--c-text-2, #9ca3af); margin-top: 4px; }
    .grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(min(100%, 420px), 1fr)); }
    .card {
      border: 1px solid var(--glass-stroke, var(--g-line, rgba(255, 255, 255, 0.08))); border-radius: var(--glass-radius-lg, 20px); padding: 18px 20px;
      background: var(--glass-sheen, linear-gradient(180deg, rgba(255,255,255,.07), transparent 34%)), var(--glass-2, var(--g-surface, rgba(255, 255, 255, 0.02))); min-width: 0;
      box-shadow: var(--glass-specular, inset 0 1px 0 rgba(255,255,255,.07)), var(--glass-elev-2, 0 18px 48px rgba(0,0,0,.28));
      backdrop-filter: var(--glass-blur, blur(18px) saturate(135%));
    }
    .card h2 { font-size: 14px; margin: 0 0 12px; font-weight: 600; }
    .kicker { font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--c-text-2, #9ca3af); }
    .field { display: grid; gap: 4px; margin-bottom: 10px; }
    .field label { font-size: 12px; color: var(--c-text-2, #9ca3af); }
    input, select {
      font: inherit; color: inherit; background: color-mix(in srgb, var(--glass-base, #090806) 76%, transparent); border: 1px solid var(--glass-stroke, var(--g-line, rgba(255, 255, 255, 0.12)));
      border-radius: var(--glass-radius-sm, 10px); padding: 9px 11px; min-height: 42px; width: 100%; box-sizing: border-box;
    }
    .seg { display: inline-flex; border: 1px solid var(--g-line, rgba(255, 255, 255, 0.12)); border-radius: 999px; overflow: hidden; }
    .seg button { border: 0; border-radius: 0; background: transparent; color: var(--c-text-2, #9ca3af); }
    .seg button.on { background: var(--c-accent, #d4af37); color: #111; }
    button {
      font: inherit; font-size: 12px; font-weight: 650; cursor: pointer; border-radius: var(--glass-radius-sm, 10px); padding: 8px 14px; min-height: 40px;
      border: 1px solid var(--glass-gold-hi, var(--c-accent, #d4af37)); background: var(--glass-gold-fill, var(--c-accent, #d4af37)); color: var(--glass-ink, #111);
      box-shadow: inset 0 1px 0 rgba(255,255,255,.36), 0 8px 22px color-mix(in srgb, var(--c-accent, #d4af37) 18%, transparent);
    }
    button.ghost { background: transparent; color: var(--c-accent, #d4af37); }
    button:disabled { opacity: 0.55; cursor: default; }
    .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    .muted { color: var(--c-text-2, #9ca3af); }
    .ok { color: #34d399; }
    .err { color: #f87171; }
    .warn { color: #fbbf24; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid var(--g-line, rgba(255, 255, 255, 0.06)); vertical-align: middle; }
    th { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--c-text-2, #9ca3af); font-weight: 500; }
    .agent { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .agent span.name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .chip { font-size: 11px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--g-line, rgba(255,255,255,0.15)); white-space: nowrap; }
    .chip.flag { border-color: rgba(251, 191, 36, 0.45); color: #fbbf24; background: rgba(251, 191, 36, 0.08); }
    .stage { display: grid; grid-template-columns: 44px 1fr auto; gap: 8px; padding: 4px 0; align-items: baseline; }
    .stage b { font-size: 11px; color: var(--c-text-2, #9ca3af); font-weight: 500; }
    .mono { font-family: var(--font-mono, ui-monospace, monospace); font-size: 12px; word-break: break-all; }
    .big { font-size: 26px; font-weight: 700; }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 12px; }
    @media (max-width: 640px) {
      .hide-sm { display: none; }
      th, td { padding: 8px 4px; }
      :host { padding: 12px 10px 32px; }
      .card { padding: 15px; border-radius: var(--glass-radius, 14px); }
      button, input, select { min-height: 44px; }
    }
    :is(button, input, select):focus-visible { outline: none; box-shadow: var(--glass-focus-ring, 0 0 0 3px color-mix(in srgb, var(--g-primary) 35%, transparent)); }
    :host-context([data-theme="light"]) input,
    :host-context([data-theme="light"]) select { background: rgba(255,255,255,.72); }
    @media (prefers-reduced-transparency: reduce) {
      .card { backdrop-filter: none; background: var(--glass-solid, var(--g-surface)); }
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { animation-duration: .001ms !important; animation-iteration-count: 1 !important; transition-duration: .001ms !important; }
    }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    void this.loadAll();
  }

  private async rpc<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const client = this.client ?? getGatewayClient();
    if (!client) throw new Error("gateway not connected");
    return client.request<T>(method, params);
  }

  private async loadAll(): Promise<void> {
    // A direct load of /robovoice mounts this view before the gateway
    // WebSocket is up — wait for the client instead of erroring.
    if (!this.client && !getGatewayClient()) {
      try {
        await awaitGatewayClient(15_000);
      } catch {
        this.loadError = "Gateway not connected — waiting to reconnect.";
        setTimeout(() => void this.loadAll(), 3000);
        return;
      }
    }
    try {
      this.view = await this.rpc<SettingsView>("robovoice.settings.get");
      this.form = { ...this.view.settings };
      this.loadError = null;
    } catch (err) {
      this.loadError = errText(err);
      // Socket may still be handshaking right after a (re)load — retry a few times.
      if (this.loadAttempts++ < 5) setTimeout(() => void this.loadAll(), 2000);
      return;
    }
    void this.loadAgents();
    void this.loadRemote();
    void this.loadVoice();
  }

  private async loadAgents(): Promise<void> {
    try {
      const res = await this.rpc<{ agents?: GatewayAgentRow[] }>("agents.list");
      this.agents = res.agents ?? [];
    } catch {
      this.agents = [];
    }
  }

  /** Everything that needs the Robovoice deployment itself. */
  /** Voice agents + the InfiniBot voice-LLM callback (robovoice.voiceAgents.list / voiceLlm.status). */
  private async loadVoice(): Promise<void> {
    const [agents, llm] = await Promise.allSettled([
      this.rpc<VoiceAgentsPayload>("robovoice.voiceAgents.list"),
      this.rpc<VoiceLlmStatus>("robovoice.voiceLlm.status"),
    ]);
    if (agents.status === "fulfilled") this.voiceAgents = agents.value;
    if (llm.status === "fulfilled") this.voiceLlm = llm.value;
    // Then each voice agent's real voice from Robovoice (a few seconds).
    try {
      this.voiceAgents = await this.rpc<VoiceAgentsPayload>("robovoice.voiceAgents.list", { remote: true });
    } catch {
      if (this.voiceAgents) this.voiceAgents = { ...this.voiceAgents, agents: this.voiceAgents.agents.map((a) => ({ ...a, robovoice: null })) };
    }
  }

  private async rotateVoiceToken(): Promise<void> {
    try {
      const r = await this.rpc<VoiceLlmStatus & { syncError?: string | null }>("robovoice.voiceLlm.rotate");
      this.voiceLlm = r;
      this.note = r.syncError ? { text: `Token rotated; sync failed: ${r.syncError}`, error: true } : { text: "Voice-LLM token rotated and re-sent to Robovoice." };
    } catch (err) {
      this.note = { text: errText(err), error: true };
    }
  }

  private async saveOwnerEmails(): Promise<void> {
    const list = (this.ownerEmailsDraft ?? "").split(/[\s,]+/).map((e) => e.trim()).filter(Boolean);
    try {
      this.view = await this.rpc<SettingsView>("robovoice.settings.set", { ownerCallerEmails: list });
      this.ownerEmailsDraft = null;
      await this.loadVoice();
    } catch (err) {
      this.note = { text: errText(err), error: true };
    }
  }

  private async loadRemote(): Promise<void> {
    const [chars, pipe, credits] = await Promise.allSettled([
      this.rpc<{ characters: Character[]; error?: string }>("robovoice.characters.list"),
      this.rpc<{ pipelines: Pipeline[]; safety: { flags: SafetyFlag[]; cloudViolation: boolean }; error?: string }>("robovoice.pipeline.get"),
      this.rpc<Credits>("robovoice.credits.get"),
    ]);
    if (chars.status === "fulfilled") {
      this.characters = chars.value.characters ?? [];
      this.charactersError = chars.value.error ?? null;
    } else this.charactersError = errText(chars.reason);
    if (pipe.status === "fulfilled") {
      this.pipelines = pipe.value.pipelines ?? [];
      this.safety = pipe.value.safety ?? { flags: [], cloudViolation: false };
    }
    this.credits = credits.status === "fulfilled" ? credits.value : null;
  }

  private async save(): Promise<void> {
    this.saving = true;
    this.note = null;
    try {
      const f = this.form;
      this.view = await this.rpc<SettingsView>("robovoice.settings.set", {
        deployment: f.deployment,
        baseUrl: f.baseUrl ?? "",
        deviceId: f.deviceId ?? "",
        locationId: f.locationId ?? "",
        expressive: f.expressive === true,
        wakeWord: f.wakeWord ?? {},
      });
      const secretPatch: Record<string, string> = {};
      if (this.secretDraft.deviceKey.trim()) secretPatch.deviceKey = this.secretDraft.deviceKey.trim();
      if (this.secretDraft.edgeToken.trim()) secretPatch.edgeToken = this.secretDraft.edgeToken.trim();
      if (Object.keys(secretPatch).length) {
        this.view = await this.rpc<SettingsView>("robovoice.secrets.set", secretPatch);
        this.secretDraft = { deviceKey: "", edgeToken: "" };
      }
      this.form = { ...this.view.settings };
      this.note = { text: "Saved." };
      await this.loadRemote();
    } catch (err) {
      this.note = { text: errText(err), error: true };
    } finally {
      this.saving = false;
    }
  }

  private async clearSecret(key: "deviceKey" | "edgeToken"): Promise<void> {
    try {
      this.view = await this.rpc<SettingsView>("robovoice.secrets.set", { [key]: null });
    } catch (err) {
      this.note = { text: errText(err), error: true };
    }
  }

  private async test(): Promise<void> {
    this.testResult = null;
    try {
      const r = await this.rpc<{ ok: boolean; health?: string; characters?: number; error?: string }>("robovoice.test", {
        baseUrl: this.form.baseUrl ?? "",
      });
      this.testResult = r.ok
        ? { ok: true, text: `Connected · health ${r.health} · ${r.characters} characters` }
        : { ok: false, text: r.error ?? `Robovoice health: ${r.health ?? "unknown"}` };
    } catch (err) {
      this.testResult = { ok: false, text: errText(err) };
    }
  }

  private async setMapping(agentId: string, characterId: string): Promise<void> {
    try {
      const r = await this.rpc<{ characterMap: Record<string, string> }>("robovoice.mapping.set", {
        agentId,
        characterId: characterId || null,
      });
      if (this.view) this.view = { ...this.view, settings: { ...this.view.settings, characterMap: r.characterMap } };
      void this.loadRemote();
    } catch (err) {
      this.note = { text: errText(err), error: true };
    }
  }

  private async setDefaultCharacter(id: string): Promise<void> {
    try {
      this.view = await this.rpc<SettingsView>("robovoice.settings.set", { defaultCharacterId: id });
      void this.loadRemote();
    } catch (err) {
      this.note = { text: errText(err), error: true };
    }
  }

  private async saveMcpUrl(): Promise<void> {
    try {
      const url = (this.form.mcpPublicUrl ?? "").trim();
      if (url) {
        const u = new URL(url);
        if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("URL must be http(s)");
      }
      this.view = await this.rpc<SettingsView>("robovoice.settings.set", { mcpPublicUrl: url || null });
      if (this.view.settings.link && !this.view.settings.link.unlinkedAt) {
        const r = await this.rpc<{ mcp?: { status?: string; error?: string } }>("robovoice.link.sync");
        this.note = { text: `Agent tools: ${r.mcp?.status ?? "saved"}${r.mcp?.error ? ` — ${r.mcp.error}` : ""}`, error: r.mcp?.status === "error" };
      } else this.note = { text: "Saved; applied when you link to Robovoice." };
    } catch (err) {
      this.note = { text: errText(err), error: true };
    }
  }

  render() {
    if (this.loadError) {
      return html`<div class="wrap"><div class="card"><h2>Robovoice</h2><div class="err">${this.loadError}</div></div></div>`;
    }
    if (!this.view) return html`<div class="wrap"><div class="muted">Loading Robovoice…</div></div>`;
    return html`
      <div class="wrap">
        <div data-learn-id="robovoice-header">
          <div class="kicker">Voice provider plugin</div>
          <h1>Robovoice</h1>
          <div class="sub">Your InfiniBot agents talk through Robovoice characters: pick where Robovoice runs, map agents to characters, and watch credits.</div>
        </div>
        <robovoice-link variant="full" @robovoice-linked=${() => void this.loadAll()}></robovoice-link>
        <div class="section-head" id="rv-pipeline-section">
          <h2>Location pipeline</h2>
          <span class="muted">Speech-to-text → language model → voice for calls at your Robovoice location</span>
        </div>
        <rv-pipeline-editor @rv-pipeline-saved=${() => void this.loadRemote()}></rv-pipeline-editor>
        ${this.renderVoiceAgents()}
        ${this.renderVoiceLlm()}
        <div class="grid">
          ${this.renderConnection()} ${this.renderCredits()}
        </div>
        ${this.renderMapping()}
        <div class="grid">${this.renderPipelines()} ${this.renderMcp()}</div>
      </div>
    `;
  }

  private renderVoiceAgents() {
    const d = this.voiceAgents;
    return html`
      <section class="card" data-testid="rv-voice-agents">
        <div class="row" style="justify-content:space-between;margin-bottom:8px;">
          <h2 style="margin:0;">Voice agents</h2>
          <span class="muted">${d?.linked ? `Characters at ${d.location ?? "your location"} · synced by agent id` : "Link to Robovoice to sync agents"}</span>
        </div>
        <div class="muted" style="margin-bottom:10px;">
          Turn an InfiniBot agent into a Robovoice location agent. Its model step is InfiniBot itself: the gateway agent or a CLI agent.
        </div>
        ${!d
          ? html`<div class="muted">Loading…</div>`
          : html`<div class="rows-head"><span>Agent</span><span>Voice</span><span>Answers via</span><span>TTS voice</span><span>Status</span></div>
              ${d.agents.map(
                (a) => html`<robovoice-agent-voice variant="row" agent-id=${a.id} .payload=${d}
                  @robovoice-agent-changed=${(e: CustomEvent<VoiceAgentsPayload>) => {
                    this.voiceAgents = e.detail;
                    void this.loadVoice();
                    void this.shadowRoot?.querySelector("rv-pipeline-editor")?.load();
                  }}></robovoice-agent-voice>`,
              )}`}
      </section>`;
  }

  private renderVoiceLlm() {
    const v = this.voiceLlm;
    const s = this.view!.settings;
    const emails = this.ownerEmailsDraft ?? (v?.ownerCallerEmails ?? []).join(", ");
    return html`
      <section class="card" data-testid="rv-voice-llm">
        <div class="row" style="justify-content:space-between;margin-bottom:8px;">
          <h2 style="margin:0;">InfiniBot as the voice LLM</h2>
          <span class="chip ${v?.bound ? "" : "flag"}">${v?.bound ? "Bound at the location" : "Not bound"}</span>
        </div>
        <div class="muted" style="margin-bottom:10px;">
          Robovoice's voice agent calls this gateway for each turn (OpenAI-compatible, streamed) with a token scoped to your location. It never gets the gateway password. Callers are treated as untrusted unless Robovoice vouches for a signed-in owner below.
        </div>
        <div class="kv">
          <span class="muted">Public gateway URL</span>
          <span class="mono">${s.mcpPublicUrl ?? "not set — set it under “InfiniBot tools for Robovoice” below"}</span>
          <span class="muted">Callback base URL</span>
          <span class="mono" data-testid="rv-voice-llm-url">${v?.baseUrl ?? "—"}</span>
          <span class="muted">Location token</span>
          <span class="mono">${v?.token?.hint ?? "minted on the next sync"}</span>
          <span class="muted">InfiniBot answers for</span>
          <span>${v?.agents.length ? v.agents.join(", ") : "—"}</span>
          <span class="muted">First token (p50)</span>
          <span data-testid="rv-voice-llm-p50">${v?.summary.firstTokenP50Ms != null ? `${v.summary.firstTokenP50Ms} ms over ${v.summary.ok} turn${v.summary.ok === 1 ? "" : "s"}` : "no turns yet"}</span>
        </div>
        <div class="field" style="margin-top:12px;max-width:520px;">
          <label for="rv-owner-emails">Owner caller emails (Robovoice-verified callers treated as the owner)</label>
          <div class="row">
            <input id="rv-owner-emails" style="flex:1;min-width:200px;" placeholder="you@example.com" .value=${emails}
              @input=${(e: Event) => (this.ownerEmailsDraft = (e.target as HTMLInputElement).value)} />
            <button class="ghost" ?disabled=${this.ownerEmailsDraft === null} @click=${() => void this.saveOwnerEmails()}>Save</button>
          </div>
        </div>
        <div class="row" style="margin-top:4px;">
          <button class="ghost" id="rv-rotate-voice-token" ?disabled=${!v?.locationId} @click=${() => void this.rotateVoiceToken()}>Rotate token</button>
        </div>
        ${v?.turns.length
          ? html`<table style="margin-top:12px;">
              <thead><tr><th>When</th><th>Agent</th><th>Backend</th><th class="hide-sm">Caller</th><th>First token</th><th class="hide-sm">Total</th></tr></thead>
              <tbody>
                ${v.turns.slice(0, 6).map(
                  (t) => html`<tr>
                    <td class="muted">${new Date(t.at).toLocaleTimeString()}</td>
                    <td>${t.agentId}</td>
                    <td class="mono">${t.backend}</td>
                    <td class="hide-sm">${t.trust}</td>
                    <td class=${t.ok ? "" : "err"}>${t.ok ? `${t.firstTokenMs ?? "—"} ms` : (t.error ?? "failed")}</td>
                    <td class="hide-sm muted">${t.totalMs} ms</td>
                  </tr>`,
                )}
              </tbody>
            </table>`
          : nothing}
      </section>`;
  }

  private renderConnection() {
    const f = this.form;
    const sec = this.view!.secrets;
    const secretField = (key: "deviceKey" | "edgeToken", label: string, help: string) => html`
      <div class="field" data-learn-id="robovoice-secret-${key}">
        <label for="rv-${key}">${label}</label>
        <input
          id="rv-${key}"
          type="password"
          autocomplete="off"
          placeholder=${sec[key].set ? `Saved ${sec[key].hint ?? ""}${sec[key].source === "env" ? " (from env)" : sec[key].source === "config" ? " (from plugin settings)" : ""}` : help}
          .value=${this.secretDraft[key]}
          @input=${(e: Event) => (this.secretDraft = { ...this.secretDraft, [key]: (e.target as HTMLInputElement).value })}
        />
        ${sec[key].set && sec[key].source === "stored"
          ? html`<div><button class="ghost" style="min-height:26px;padding:3px 10px;" @click=${() => this.clearSecret(key)}>Remove saved ${label.toLowerCase()}</button></div>`
          : nothing}
      </div>`;
    return html`
      <section class="card" data-testid="rv-connection" data-learn-id="robovoice-connection">
        <h2>Connection</h2>
        ${this.view!.settings.link && !this.view!.settings.link.unlinkedAt
          ? html`<div class="muted" style="margin-bottom:10px;">Set by your Robovoice link (${this.view!.settings.link.orgName} · ${this.view!.settings.link.locationName}). Edit only for a self-hosted stack.</div>`
          : nothing}
        <div class="field">
          <label>Where Robovoice runs</label>
          <div class="seg" role="group" data-learn-id="robovoice-deployment">
            ${(["self-hosted", "cloud"] as const).map(
              (d) => html`<button id="rv-deploy-${d}" class=${f.deployment === d ? "on" : ""} @click=${() => (this.form = { ...f, deployment: d })}>
                ${d === "cloud" ? "Robovoice cloud" : "Self-hosted"}
              </button>`,
            )}
          </div>
        </div>
        <div class="field">
          <label for="rv-url">Robovoice URL</label>
          <input
            id="rv-url"
            data-learn-id="robovoice-url"
            type="url"
            placeholder=${f.deployment === "cloud" ? "https://robovoice.io" : "http://<robovoice-host>:3011"}
            .value=${f.baseUrl ?? ""}
            @input=${(e: Event) => (this.form = { ...this.form, baseUrl: (e.target as HTMLInputElement).value })}
          />
          ${this.view!.legacyUrl && !this.view!.settings.baseUrl
            ? html`<span class="muted">Using legacy voice.robovoiceUrl: ${this.view!.legacyUrl}</span>`
            : nothing}
        </div>
        <div class="field">
          <label for="rv-device">Edge device id</label>
          <input id="rv-device" data-learn-id="robovoice-device-id" placeholder="infinibot-gateway" .value=${f.deviceId ?? ""}
            @input=${(e: Event) => (this.form = { ...this.form, deviceId: (e.target as HTMLInputElement).value })} />
        </div>
        ${secretField("deviceKey", "Device key", "HMAC device key from Robovoice")}
        ${f.deployment === "cloud" ? secretField("edgeToken", "Edge token", "rve_… from `robovoice login`") : nothing}
        <div class="field">
          <label for="rv-location">Location (optional — pipeline overrides)</label>
          <input id="rv-location" data-learn-id="robovoice-location" placeholder="Robovoice location id" .value=${f.locationId ?? ""}
            @input=${(e: Event) => (this.form = { ...this.form, locationId: (e.target as HTMLInputElement).value })} />
        </div>
        <div class="field">
          <label><input type="checkbox" style="width:auto;min-height:0;" .checked=${f.expressive === true}
            @change=${(e: Event) => (this.form = { ...this.form, expressive: (e.target as HTMLInputElement).checked })} />
            Expressive voice tier (premium rate on cloud)</label>
        </div>
        <div class="row">
          <button id="rv-save" data-learn-id="robovoice-save" ?disabled=${this.saving} @click=${() => this.save()}>${this.saving ? "Saving…" : "Save"}</button>
          <button id="rv-test" data-learn-id="robovoice-test" class="ghost" @click=${() => this.test()}>Test connection</button>
        </div>
        ${this.testResult ? html`<div class=${this.testResult.ok ? "ok" : "err"} style="margin-top:8px;" data-testid="rv-test-result">${this.testResult.text}</div>` : nothing}
        ${this.note ? html`<div class=${this.note.error ? "err" : "ok"} style="margin-top:8px;">${this.note.text}</div>` : nothing}
      </section>`;
  }

  /** Cloud voice is free: usage is shown in minutes only (measured for fair use) — never credits or a top-up. */
  private renderCredits() {
    const c = this.credits;
    const cloud = this.view!.settings.deployment === "cloud";
    const minutes = c && c.available && c.monthMinutes !== undefined ? c.monthMinutes : null;
    return html`
      <section class="card" data-testid="rv-credits" data-learn-id="robovoice-credits">
        <h2>Usage</h2>
        <div class="stats">
          <div><div class="kicker">Cloud voice</div><div class="big">Free</div><div class="muted">No credits or top-ups</div></div>
          ${cloud && minutes !== null
            ? html`<div><div class="kicker">This month</div><div class="big">${minutes}</div><div class="muted">minutes</div></div>`
            : nothing}
        </div>
        <div class="muted" style="margin-top:10px;">Usage is measured to keep cloud voice fair for everyone. If it's ever busy, switch back to local voice in one click on the Voice page.</div>
      </section>`;
  }

  private renderMapping() {
    const s = this.view!.settings;
    const chars = this.characters;
    const agents = this.agents.length ? this.agents : [{ id: "main", name: "Main" } as GatewayAgentRow];
    const nameOf = (id: string) => chars.find((c) => c.id === id)?.name ?? id;
    return html`
      <section class="card" data-testid="rv-mapping" data-learn-id="robovoice-mapping">
        <div class="row" style="justify-content:space-between;margin-bottom:8px;">
          <h2 style="margin:0;">Character mapping</h2>
          <span class="muted">${chars.length} Robovoice character${chars.length === 1 ? "" : "s"}</span>
        </div>
        ${this.charactersError ? html`<div class="err" style="margin-bottom:8px;">${this.charactersError}</div>` : nothing}
        <div class="field" style="max-width:420px;">
          <label for="rv-default">Default character (agents without a mapping)</label>
          <select id="rv-default" data-learn-id="robovoice-default-character" @change=${(e: Event) => this.setDefaultCharacter((e.target as HTMLSelectElement).value)}>
            <option value="" ?selected=${!s.defaultCharacterId}>Robovoice decides (active character)</option>
            ${chars.map((c) => html`<option value=${c.id} ?selected=${s.defaultCharacterId === c.id}>${c.name}</option>`)}
          </select>
        </div>
        <table data-learn-id="robovoice-mapping-table">
          <thead><tr><th>InfiniBot agent</th><th>Robovoice character</th><th class="hide-sm">Voice</th></tr></thead>
          <tbody>
            ${agents.map((a) => {
              const mapped = s.characterMap[a.id] ?? "";
              const ch = chars.find((c) => c.id === mapped);
              return html`<tr data-agent=${a.id}>
                <td><div class="agent">${a.identity?.emoji ?? ""}<span class="name">${a.identity?.name ?? a.name ?? a.id}</span></div></td>
                <td>
                  <select aria-label="Character for ${a.id}" @change=${(e: Event) => this.setMapping(a.id, (e.target as HTMLSelectElement).value)}>
                    <option value="" ?selected=${!mapped}>Default${s.defaultCharacterId ? ` (${nameOf(s.defaultCharacterId)})` : ""}</option>
                    ${chars.map((c) => html`<option value=${c.id} ?selected=${mapped === c.id}>${c.name}</option>`)}
                    ${mapped && !ch ? html`<option value=${mapped} selected>${mapped} (missing)</option>` : nothing}
                  </select>
                </td>
                <td class="hide-sm muted">${ch?.tts_provider ?? (mapped ? "—" : "")}${ch?.language ? ` · ${ch.language}` : ""}</td>
              </tr>`;
            })}
          </tbody>
        </table>
      </section>`;
  }

  private renderPipelines() {
    const flags = this.safety.flags;
    const stage = (label: string, st?: Stage) => html`<div class="stage"><b>${label}</b>
      <span class="mono">${st?.provider ?? "—"}${st?.model ? ` · ${st.model}` : ""}</span>
      <span class="chip">${st?.state ?? "n/a"}</span></div>`;
    return html`
      <section class="card" data-testid="rv-pipelines" data-learn-id="robovoice-pipelines">
        <h2>Pipelines</h2>
        <div class="muted" style="margin-bottom:10px;">Effective STT → LLM → TTS for mapped characters${this.view!.settings.locationId ? " at your location" : ""}. Edit pipelines in the Robovoice dashboard.</div>
        ${flags.length
          ? html`<div class="${this.safety.cloudViolation ? "err" : "warn"}" style="margin-bottom:10px;">
              ${this.safety.cloudViolation
                ? "Non-commercial models are in use on a cloud deployment — switch these voices/wake words before charging for calls."
                : "Self-host only models in use:"}
              <div class="row" style="margin-top:6px;">${flags.map((f) => html`<span class="chip flag" title=${f.message}>Self-host only · ${f.subject}</span>`)}</div>
            </div>`
          : nothing}
        ${this.pipelines.length === 0
          ? html`<div class="muted">No pipelines to show yet — connect Robovoice and map a character.</div>`
          : this.pipelines.map(
              (p) => html`<div style="padding:8px 0;border-top:1px solid var(--g-line, rgba(255,255,255,0.06));">
                <div style="font-weight:600;margin-bottom:4px;">${this.characters.find((c) => c.id === p.character_id)?.name ?? p.character_id}
                  <span class="muted" style="font-weight:400;">· ${p.mode ?? "livekit"}</span></div>
                ${stage("STT", p.stt)} ${stage("LLM", p.llm)} ${stage("TTS", p.tts)}
              </div>`,
            )}
      </section>`;
  }

  private renderMcp() {
    const origin = typeof location !== "undefined" ? location.origin : "";
    const tools = this.view!.settings.mcpTools;
    const ww = this.form.wakeWord ?? {};
    return html`
      <section class="card" data-testid="rv-mcp" data-learn-id="robovoice-mcp">
        <h2>InfiniBot tools for Robovoice</h2>
        <div class="muted">Per agent (linked accounts): each Robovoice character gets its own MCP server
          <span class="mono">${this.view!.settings.mcpPublicUrl ?? "<public URL>"}/plugins/robovoice/agent-mcp</span> with a token scoped to that agent,
          so a call to an agent runs that agent's tools. The gateway tool is never exposed.</div>
        <div class="field" style="margin-top:10px;">
          <label for="rv-mcp-url">Public URL Robovoice reaches this gateway on (tunnel / Tailscale Funnel)</label>
          <div class="row">
            <input id="rv-mcp-url" style="flex:1;min-width:200px;" placeholder="https://<host>.ts.net" .value=${this.form.mcpPublicUrl ?? ""}
              @input=${(e: Event) => (this.form = { ...this.form, mcpPublicUrl: (e.target as HTMLInputElement).value })} />
            <button class="ghost" @click=${() => this.saveMcpUrl()}>Save + sync</button>
          </div>
        </div>
        <div class="muted" style="margin-top:6px;">Manual setup (self-hosted, gateway token auth): <span class="mono">${origin}/plugins/robovoice/mcp</span></div>
        <div class="muted">Tools exposed: ${(tools ?? []).length ? tools!.join(", ") : "default curated set (notes, kanban, research, workflows, sessions_spawn, claude_coder, …)"}.</div>
        <div class="field" style="margin-top:14px;">
          <label for="rv-ww">Robovoice wake-word model (for the commercial-safety label)</label>
          <input id="rv-ww" data-learn-id="robovoice-wake-word" placeholder="e.g. models/hey_jarvis.onnx" .value=${ww.model ?? ""}
            @input=${(e: Event) => (this.form = { ...this.form, wakeWord: { engine: "openwakeword", model: (e.target as HTMLInputElement).value } })} />
          <span class="muted">openWakeWord's bundled weights (hey_jarvis, alexa…) are non-commercial: self-host only.</span>
        </div>
      </section>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "robovoice-view": RobovoiceView;
  }
}
