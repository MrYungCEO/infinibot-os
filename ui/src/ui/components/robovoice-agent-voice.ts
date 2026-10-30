/**
 * <robovoice-agent-voice> — one InfiniBot agent's voice settings on its
 * Robovoice location (Robovoice plugin):
 *
 *   Voice agent     toggle: the agent is (or isn't) a character at the linked
 *                   Robovoice location (create/update/remove, idempotent by agent id)
 *   Answers with    InfiniBot (Robovoice calls back into this gateway) or the
 *                   location's own LLM
 *   Backend         the gateway agent, or a CLI agent (Claude Code / Codex /
 *                   OpenCode / Gemini)
 *   Voice           read from Robovoice: the TTS provider + voice + language the
 *                   agent's character really uses at the location (never a
 *                   built-in catalogue); changed in the Pipeline editor
 *   Test turn       runs one voice turn through the same path the callback uses
 *                   and shows the first-token time
 *
 * Changes save immediately (robovoice.voiceAgent.set → sync). Variants:
 * "card" (Agents page Voice slot) and "row" (the Robovoice page list).
 */

import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { awaitGatewayClient, getGatewayClient } from "../gateway-client.js";

export type VoiceAgentRow = {
  id: string;
  name: string;
  description?: string;
  emoji?: string;
  voiceAgent: boolean;
  characterId: string | null;
  syncedAt: string | null;
  error: string | null;
  llm: "infinibot" | "robovoice";
  llmBackend: string;
  /** Voice override picked on this install (null = none); what Robovoice runs is `robovoice`. */
  ttsProvider: string | null;
  voice: string | null;
  language?: string | null;
  llmModel: string | null;
  /**
   * The agent's voice as Robovoice runs it (robovoice.voiceAgents.list
   * { remote: true }). undefined = not fetched yet; null = no character or
   * Robovoice didn't answer (see voicesError).
   */
  robovoice?: RobovoiceVoice | null;
};

export type RobovoiceVoice = {
  stt: { provider: string | null; model: string | null };
  llm: { provider: string | null; model: string | null };
  tts: { provider: string | null; voice: string | null };
  language: string | null;
  characterName: string | null;
};

export type VoiceAgentsPayload = {
  linked: boolean;
  location: string | null;
  publicUrl: string | null;
  agents: VoiceAgentRow[];
  syncError?: string | null;
  /** Robovoice voice lookup failed (remote list only). */
  voicesError?: string | null;
};

export const VOICE_BACKENDS: Array<{ id: string; label: string }> = [
  { id: "gateway", label: "Gateway agent" },
  { id: "claude-code", label: "Claude Code CLI" },
  { id: "codex", label: "Codex CLI" },
  { id: "opencode", label: "OpenCode CLI" },
  { id: "gemini", label: "Gemini CLI" },
];

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

@customElement("robovoice-agent-voice")
export class RobovoiceAgentVoice extends LitElement {
  @property({ attribute: "agent-id" }) agentId = "";
  @property() variant: "card" | "row" = "card";
  /** Pre-fetched list (the Robovoice page passes one list to every row). */
  @property({ attribute: false }) payload: VoiceAgentsPayload | null = null;

  @state() private data: VoiceAgentsPayload | null = null;
  @state() private busy = false;
  @state() private note: { text: string; error?: boolean } | null = null;
  @state() private test: { text: string; firstTokenMs: number | null; totalMs: number; backend: string } | null = null;
  @state() private unavailable: string | null = null;

  static styles = css`
    :host { display: block; color: var(--text); font-size: 13px; }
    .card { border: 1px solid var(--border); border-radius: 14px; background: var(--card); padding: 16px 18px; display: grid; gap: 14px; }
    .head { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
    h3 { margin: 0; font-size: 14px; font-weight: 600; color: var(--text-strong); }
    .sub { color: var(--muted); font-size: 12px; }
    .grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(min(100%, 200px), 1fr)); }
    .cap { display: block; margin-bottom: 6px; font-size: 11px; font-weight: 600; letter-spacing: 0.07em; text-transform: uppercase; color: var(--muted); }
    select {
      font: inherit; color: var(--text-strong); width: 100%; min-height: 36px; box-sizing: border-box;
      background: var(--bg-elevated); border: 1px solid var(--border); border-radius: 10px; padding: 7px 10px;
    }
    select:disabled { opacity: 0.6; }
    .seg { display: inline-flex; border: 1px solid var(--border); border-radius: 999px; overflow: hidden; }
    .seg button { font: inherit; font-size: 12px; border: 0; background: transparent; color: var(--muted); padding: 7px 12px; min-height: 34px; cursor: pointer; }
    .seg button.on { background: var(--accent); color: var(--accent-foreground); font-weight: 600; }
    .switch { display: inline-flex; align-items: center; gap: 10px; cursor: pointer; user-select: none; min-height: 34px; }
    .switch input { position: absolute; opacity: 0; width: 1px; height: 1px; }
    .track { width: 38px; height: 22px; border-radius: 999px; background: var(--border-strong); position: relative; transition: background 0.15s; flex-shrink: 0; }
    .track::after { content: ""; position: absolute; top: 3px; left: 3px; width: 16px; height: 16px; border-radius: 50%; background: var(--text-strong); transition: transform 0.15s; }
    .switch input:checked + .track { background: var(--accent); }
    .switch input:checked + .track::after { transform: translateX(16px); background: var(--accent-foreground); }
    .switch input:focus-visible + .track { outline: 2px solid var(--accent); outline-offset: 2px; }
    .chip { font-size: 11px; padding: 2px 9px; border-radius: 999px; border: 1px solid var(--border); color: var(--muted); white-space: nowrap; }
    .chip.on { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 45%, transparent); background: color-mix(in srgb, var(--ok) 10%, transparent); }
    .chip.err { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 45%, transparent); }
    button.ghost { font: inherit; font-size: 12px; font-weight: 600; border-radius: 10px; padding: 6px 12px; min-height: 34px; cursor: pointer; border: 1px solid var(--accent); background: transparent; color: var(--accent); }
    button:disabled { opacity: 0.55; cursor: default; }
    .mono { font-family: var(--mono); font-size: 11px; color: var(--muted); overflow-wrap: anywhere; }
    .ok { color: var(--ok); font-size: 12px; }
    .err { color: var(--danger); font-size: 12px; }
    .testout { border-left: 2px solid var(--accent); padding: 6px 10px; font-size: 12px; background: color-mix(in srgb, var(--accent) 6%, transparent); border-radius: 0 8px 8px 0; }
    /* row variant */
    .row { display: grid; grid-template-columns: minmax(120px, 1.1fr) auto minmax(150px, 1fr) minmax(150px, 1.2fr) minmax(110px, 0.8fr); gap: 10px; align-items: center; padding: 10px 0; border-bottom: 1px solid var(--border); }
    .who { display: flex; gap: 8px; align-items: center; min-width: 0; }
    .who .n { font-weight: 600; color: var(--text-strong); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .voicepair { display: grid; grid-template-columns: 1fr; gap: 6px; }
    .voice { font-family: var(--mono); font-size: 12px; color: var(--text-strong); overflow-wrap: anywhere; }
    .skel { display: block; height: 16px; width: min(180px, 100%); border-radius: 6px; background: linear-gradient(90deg, color-mix(in srgb, var(--border) 55%, transparent) 0%, color-mix(in srgb, var(--border) 95%, transparent) 50%, color-mix(in srgb, var(--border) 55%, transparent) 100%); background-size: 200% 100%; animation: skel 1.4s ease-in-out infinite; }
    @keyframes skel { 0% { background-position: 100% 0; } 100% { background-position: -100% 0; } }
    @media (prefers-reduced-motion: reduce) { .skel { animation: none; } }
    @media (max-width: 760px) {
      .row { grid-template-columns: 1fr auto; }
      .row .wide { grid-column: 1 / -1; }
    }
  `;

  private async rpc<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    let client = getGatewayClient();
    if (!client) client = await awaitGatewayClient(15_000);
    return client.request<T>(method, params);
  }

  connectedCallback(): void {
    super.connectedCallback();
    if (!this.payload) void this.load();
  }

  protected willUpdate(changed: Map<string, unknown>): void {
    if (changed.has("payload") && this.payload) this.data = this.payload;
  }

  async load(): Promise<void> {
    try {
      this.data = await this.rpc<VoiceAgentsPayload>("robovoice.voiceAgents.list", { remote: true });
      this.unavailable = null;
    } catch (e) {
      // Plugin off / not installed: the slot says so instead of erroring.
      this.unavailable = errText(e);
    }
  }

  private get row(): VoiceAgentRow | null {
    return this.data?.agents.find((a) => a.id === this.agentId) ?? null;
  }

  private async set(patch: Record<string, unknown>) {
    this.busy = true;
    this.note = null;
    try {
      const r = await this.rpc<VoiceAgentsPayload & { syncError?: string | null }>("robovoice.voiceAgent.set", { agentId: this.agentId, ...patch });
      this.data = r;
      this.note = r.syncError ? { text: `Saved locally — sync failed: ${r.syncError}`, error: true } : { text: r.linked ? "Saved · synced to Robovoice" : "Saved — applies when this install is linked" };
      this.dispatchEvent(new CustomEvent("robovoice-agent-changed", { detail: r, bubbles: true, composed: true }));
      // The write answers without Robovoice's voices; re-read them (card owns its data).
      if (!this.payload) void this.load();
    } catch (e) {
      this.note = { text: errText(e), error: true };
    } finally {
      this.busy = false;
    }
  }

  private async runTest() {
    this.busy = true;
    this.test = null;
    this.note = null;
    try {
      this.test = await this.rpc("robovoice.voiceLlm.test", { agentId: this.agentId, message: "Introduce yourself in one short sentence." });
    } catch (e) {
      this.note = { text: errText(e), error: true };
    } finally {
      this.busy = false;
    }
  }

  private statusChip(a: VoiceAgentRow) {
    if (a.error) return html`<span class="chip err" title=${a.error}>Sync error</span>`;
    if (!a.voiceAgent) return html`<span class="chip">Not a voice agent</span>`;
    return html`<span class="chip on" title=${a.characterId ?? ""}>${a.characterId ? "Location agent" : "Pending sync"}</span>`;
  }

  /** The voice Robovoice really uses for this agent — read-only; edited in the Pipeline editor. */
  private voiceControls(a: VoiceAgentRow, compact = false) {
    const rv = a.robovoice;
    const cap = (t: string) => (compact ? nothing : html`<span class="cap">${t}</span>`);
    let body;
    if (!a.voiceAgent || !a.characterId) {
      body = html`<span class="sub" data-testid="rv-agent-voice-none">No Robovoice character — turn on Voice agent to give it one.</span>`;
    } else if (rv === undefined) {
      body = html`<span class="skel" data-testid="rv-agent-voice-loading" aria-label="Loading voice from Robovoice"></span>`;
    } else if (rv === null) {
      body = html`<span class="err" data-testid="rv-agent-voice-error">Couldn't read the voice from Robovoice${this.data?.voicesError ? `: ${this.data.voicesError}` : ""}</span>`;
    } else {
      const parts = [rv.tts.provider, rv.tts.voice, rv.language].filter((x): x is string => Boolean(x));
      body = html`<span class="voice" data-testid="rv-agent-voice-real" title="From Robovoice${rv.characterName ? ` · character ${rv.characterName}` : ""}">
        ${parts.length ? parts.join(" · ") : html`<span class="sub">Robovoice reports no voice for this character</span>`}</span>`;
    }
    return html`<div class=${compact ? "voicepair" : "grid"}>
      <div>${cap("Voice (from Robovoice)")}${body}
        ${compact ? nothing : html`<div class="sub" style="margin-top:6px;">Change it in the Voice page › Pipeline (agent scope) — it saves to Robovoice.</div>`}
      </div>
    </div>`;
  }

  private backendSelect(a: VoiceAgentRow) {
    return html`<select aria-label="LLM backend for ${a.id}" ?disabled=${this.busy || a.llm !== "infinibot"}
      @change=${(e: Event) => void this.set({ llmBackend: (e.target as HTMLSelectElement).value })}>
      ${VOICE_BACKENDS.map((b) => html`<option value=${b.id} ?selected=${a.llmBackend === b.id}>${b.label}</option>`)}
    </select>`;
  }

  render() {
    if (this.unavailable) {
      return html`<div class="card"><h3>Voice</h3><div class="sub">Turn on the Robovoice plugin to make this agent a Robovoice voice agent.</div></div>`;
    }
    const a = this.row;
    if (!this.data) return html`<div class="sub">Loading voice settings…</div>`;
    if (!a) return html`<div class="sub">Unknown agent ${this.agentId}.</div>`;
    return this.variant === "row" ? this.renderRow(a) : this.renderCard(a);
  }

  private renderRow(a: VoiceAgentRow) {
    return html`<div class="row" data-agent=${a.id}>
      <div class="who">${a.emoji ?? ""}<span class="n">${a.name}</span></div>
      <label class="switch" title="Voice agent at the Robovoice location">
        <input type="checkbox" aria-label="Voice agent ${a.id}" .checked=${a.voiceAgent} ?disabled=${this.busy}
          @change=${(e: Event) => void this.set({ enabled: (e.target as HTMLInputElement).checked })} />
        <span class="track"></span>
      </label>
      <div class="wide">
        ${a.llm === "infinibot" ? this.backendSelect(a) : html`<span class="chip">Location's LLM</span>`}
      </div>
      <div class="wide">${this.voiceControls(a, true)}</div>
      <div class="wide">${this.statusChip(a)}</div>
    </div>`;
  }

  private renderCard(a: VoiceAgentRow) {
    const d = this.data!;
    return html`<section class="card" data-testid="robovoice-agent-voice" data-agent=${a.id}>
      <div class="head">
        <div>
          <h3>Voice</h3>
          <div class="sub">${d.linked ? html`Robovoice location <b>${d.location ?? "—"}</b>` : "Robovoice — link this install to make agents callable"}</div>
        </div>
        ${this.statusChip(a)}
      </div>
      <label class="switch">
        <input type="checkbox" id="rv-agent-voice-toggle" .checked=${a.voiceAgent} ?disabled=${this.busy}
          @change=${(e: Event) => void this.set({ enabled: (e.target as HTMLInputElement).checked })} />
        <span class="track"></span>
        <span>Voice agent — ${a.name} answers calls at the Robovoice location</span>
      </label>
      <div class="grid">
        <div>
          <span class="cap">Answers with</span>
          <div class="seg" role="group" aria-label="LLM step">
            <button class=${a.llm === "infinibot" ? "on" : ""} ?disabled=${this.busy} @click=${() => void this.set({ llm: "infinibot" })}>InfiniBot</button>
            <button class=${a.llm === "robovoice" ? "on" : ""} ?disabled=${this.busy} @click=${() => void this.set({ llm: "robovoice" })}>Location's LLM</button>
          </div>
        </div>
        <label>
          <span class="cap">InfiniBot backend</span>
          ${this.backendSelect(a)}
        </label>
      </div>
      ${this.voiceControls(a)}
      ${a.llm === "infinibot"
        ? html`<div class="mono">LLM step: ${a.llmModel}${d.publicUrl ? "" : " · set the public gateway URL on the Robovoice page so Robovoice can reach it"}</div>`
        : nothing}
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
        <button class="ghost" id="rv-agent-test" ?disabled=${this.busy || a.llm !== "infinibot"} @click=${() => void this.runTest()}>Test turn</button>
        ${this.note ? html`<span class=${this.note.error ? "err" : "ok"} role="status">${this.note.text}</span>` : nothing}
      </div>
      ${this.test
        ? html`<div class="testout" data-testid="rv-agent-test-out">
            <div>${this.test.text}</div>
            <div class="mono">first token ${this.test.firstTokenMs ?? "—"} ms · total ${this.test.totalMs} ms · ${this.test.backend}</div>
          </div>`
        : nothing}
    </section>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "robovoice-agent-voice": RobovoiceAgentVoice;
  }
}
