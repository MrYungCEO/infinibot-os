/**
 * <rv-pipeline-editor> — a Robovoice location's voice pipeline, edited from
 * InfiniBot. A 1:1 port of Robovoice's location Pipeline page
 * (Robovoice-Prod frontend/app/l/[slug]/pipeline → components/dashboard/tabs/
 * pipeline-tab.tsx in location scope, + CharacterPipeline from characters-tab.tsx
 * for an agent scope), in Robovoice's own look (pipeline-styles.ts: its
 * dark tokens, glass cards, stage tints, meters, selects and menus translated
 * from the Tailwind source), driven only by the account's real data through robovoice.pipeline.config.get / .set and robovoice.pipeline.catalog.get:
 *
 *   access note     what this role may change at the location
 *   sticky bar      "At <location> · Live voice pipeline for <agent> · swap a stage & apply."
 *                   + Reset location defaults + Apply live
 *   scope card      "Configure pipeline for:" Global pipeline | one agent (character)
 *   global scope    1 Speech-to-Text → 2 Language Model → 3 Text-to-Speech (the TTS
 *                   card is the active agent's, as on Robovoice) · Pause billing when
 *                   idle · Language routing · Default language map · What this
 *                   pipeline bills · Price / min · Presets · Advanced (the other
 *                   location-configurable fields: turn-taking, wake word, LLM, voice)
 *   agent scope     STT / LLM / TTS rows ("Inherit global — …"), Effective now,
 *                   Seamless multilingual, Expressive, Language voices
 *   field markers   "Inherited" | "Overridden here" + Reset to inherited |
 *                   "Organization-level" (not per-location on Robovoice)
 *
 * Edits stay local until "Apply live"; the plugin applies Robovoice's decide()
 * (equal-to-inherited clears the override) and PATCHes Robovoice's edge API.
 * "Reset to inherited" on a saved override writes immediately, like Robovoice.
 * Precedence: org → location → character → location × character.
 */

import { LitElement, html, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { awaitGatewayClient, getGatewayClient } from "../../gateway-client.js";
import type { GatewayBrowserClient } from "../../gateway.js";
import { pipelineStyles } from "./pipeline-styles.js";

type Layer = "org" | "location" | "character" | "override";
type StageKey = "stt" | "llm" | "tts";
type StageValue = { provider: string; model: string; providerFrom: Layer; modelFrom: Layer | null };
type Effective = Record<StageKey, StageValue>;
type ProviderOpt = { id: string; label: string; available?: boolean; hint?: string; local?: boolean };
type Opt = { id: string; name?: string };
type Fields = Record<string, unknown>;
type FieldKind =
  | { type: "str"; max: number }
  | { type: "num"; min: number; max: number; step: number }
  | { type: "int"; min: number; max: number; step: number }
  | { type: "bool" }
  | { type: "provider"; stage: StageKey; extra?: string[] }
  | { type: "preemptive" }
  | { type: "ids" };
type Tier = "standard" | "premium" | "expressive";

type ViewCharacter = {
  id: string;
  name: string;
  callable?: boolean;
  own: Fields;
  override: Fields;
  infinibot_agent_id?: string | null;
};

export type PipelineView = {
  locationId: string;
  locationName: string;
  permissions: { canEditPipeline: boolean; canEditPrompt?: boolean };
  providers: Record<StageKey, ProviderOpt[]>;
  org: Fields;
  defaults: Fields;
  updatedAt?: string | null;
  characters: ViewCharacter[];
  options?: Partial<Record<StageKey, Record<string, Opt[]>>>;
  voiceLlm?: { status: string; base_url?: string | null };
  modelKeys: { stt: Record<string, string>; llm: Record<string, string> };
  fields?: { defaults: string[]; character: string[] };
  fieldKinds?: { defaults: Record<string, FieldKind>; character: Record<string, FieldKind> };
  activeCharacterId?: string | null;
  effective: { location: Effective; characters: Record<string, Effective> };
  inherited: { defaults: Fields; characters: Record<string, Fields> };
  agentByCharacter: Record<string, string>;
};

type Account = {
  org: { id: string; name: string } | null;
  locations: Array<{ id: string; name: string; slug?: string | null; dashboardUrl?: string | null }>;
  selectedLocationId: string | null;
  linked: boolean;
  link?: { apiBase?: string | null; locationSlug?: string | null } | null;
  error?: string;
};

type CatalogModel = { key: string; provider: string; model: string; name: string; tier: Tier };
type Catalog = {
  tiers: Array<{ tier: Tier; families: Array<{ family: string; models: CatalogModel[] }> }>;
  prices: Record<Tier, number>;
};

/** Target of an edit: the location defaults or one character's location override. */
type Target = "defaults" | `char:${string}`;

const STAGES: Array<{ key: StageKey; n: number; title: string; tone: string; short: string }> = [
  { key: "stt", n: 1, title: "Speech-to-Text", tone: "#a855f7", short: "STT" },
  { key: "llm", n: 2, title: "Language Model", tone: "#34d399", short: "LLM" },
  { key: "tts", n: 3, title: "Text-to-Speech", tone: "#fbbf24", short: "TTS" },
];
const TONE: Record<StageKey, string> = { stt: "#a855f7", llm: "#34d399", tts: "#fbbf24" };

const TIER_LABEL: Record<Tier, string> = { standard: "Standard", premium: "Premium", expressive: "Expressive" };
const TIER_ORDER: Tier[] = ["standard", "premium", "expressive"];

/** Robovoice idle-billing-select.tsx presets. */
const IDLE_PRESETS = [10, 30, 60, 120, 300, 600, 1800, 3600];
const idleLabel = (s: number) =>
  s < 60 ? `${s} seconds` : s < 3600 ? `${Math.round(s / 60)} minute${s === 60 ? "" : "s"}` : "1 hour";

/** Robovoice language-routing-toggles.tsx (all default ON). */
const LANGUAGE_ROUTING: Array<{ key: string; label: string; hint: string }> = [
  {
    key: "adaptive_language_enabled",
    label: "Adaptive language",
    hint: "Decide the language on every turn instead of pinning the whole call to the first one heard.",
  },
  {
    key: "mixed_language_enabled",
    label: "Mixed-language speech",
    hint: "Detect a sentence that switches language mid-way, move speech recognition to the stronger multilingual model for it, and let the reply mix languages too.",
  },
  {
    key: "auto_v3_voice_enabled",
    label: "Auto-switch to ElevenLabs v3",
    hint: "When the reply is in a script the configured voice cannot speak (Hebrew, Arabic, Thai, Cyrillic, CJK…), use ElevenLabs v3 for that turn.",
  },
];

/** Robovoice lib/provider-models.ts curated engine models (voice settings). */
const ELEVENLABS_MODELS: Opt[] = [
  { id: "eleven_turbo_v2_5", name: "Turbo v2.5" },
  { id: "eleven_multilingual_v2", name: "Multilingual v2" },
  { id: "eleven_flash_v2_5", name: "Flash v2.5" },
  { id: "eleven_v3", name: "v3 (alpha)" },
];
const INWORLD_MODELS: Opt[] = [
  { id: "inworld-tts-2-flash", name: "TTS-2 Flash" },
  { id: "inworld-tts-2", name: "TTS-2" },
];

/**
 * Location-configurable fields Robovoice edits outside its Pipeline page
 * (controls-tab.tsx "Turn detection & Wake word", the Language / ElevenLabs
 * controls): same labels, same ranges as LOCATION_DEFAULT_FIELDS.
 */
const ADVANCED: Array<{ title: string; subtitle: string; fields: Array<{ k: string; label: string; hint?: string; fmt?: (v: number) => string }> }> = [
  {
    title: "Turn detection & Wake word",
    subtitle: "VAD, endpointing, wake trigger",
    fields: [
      { k: "wake_word_enabled", label: "Wake word enabled" },
      { k: "wake_word_threshold", label: "Wake threshold (VAD sensitivity)", fmt: (v) => v.toFixed(2) },
      { k: "wake_word_timeout", label: "Wake timeout (s)", fmt: (v) => `${v}s` },
      { k: "min_endpointing_delay", label: "Min endpointing delay (s)", fmt: (v) => `${v.toFixed(2)}s` },
      { k: "max_endpointing_delay", label: "Max endpointing delay (s)", fmt: (v) => `${v.toFixed(1)}s` },
      { k: "vad_min_silence_duration", label: "VAD silence hold (s)", fmt: (v) => `${v.toFixed(2)}s` },
      { k: "vad_activation_threshold", label: "VAD activation threshold", fmt: (v) => v.toFixed(2) },
      { k: "min_interruption_words", label: "Interrupt after (words)", fmt: (v) => `${v} words` },
      { k: "min_interruption_duration", label: "Interrupt after (s of speech)", fmt: (v) => `${v.toFixed(2)}s` },
      { k: "allow_interruptions", label: "Allow interruptions" },
      { k: "turn_detection_enabled", label: "Smart turn detection", hint: "Waits for a finished thought instead of just silence" },
      { k: "preemptive_generation", label: "Preemptive generation", hint: "Start the reply before the turn is confirmed (auto = Robovoice decides)" },
    ],
  },
  {
    title: "Speech-to-text & language model",
    subtitle: "Language hint, sampling, reply length",
    fields: [
      { k: "stt_language", label: "Language", hint: "ISO code or 'auto'" },
      { k: "temperature", label: "Temperature", fmt: (v) => v.toFixed(2) },
      { k: "max_tokens", label: "Max tokens", hint: "inherit = each provider's tuned default", fmt: (v) => String(v) },
    ],
  },
  {
    title: "Voice",
    subtitle: "Engine model, ElevenLabs voice settings, delivery",
    fields: [
      { k: "elevenlabs_model_id", label: "ElevenLabs model" },
      { k: "elevenlabs_stability", label: "Stability", fmt: (v) => v.toFixed(2) },
      { k: "elevenlabs_similarity_boost", label: "Similarity boost", fmt: (v) => v.toFixed(2) },
      { k: "elevenlabs_style", label: "Style", fmt: (v) => v.toFixed(2) },
      { k: "elevenlabs_speaker_boost", label: "Speaker boost" },
      { k: "inworld_model_id", label: "Inworld model" },
      { k: "expressive_mode", label: "Expressive (laughter & emotion)" },
      { k: "seamless_multilingual", label: "Seamless multilingual", hint: "one voice, auto language switching, lowest latency" },
    ],
  },
];

/** Robovoice's select / combo chevron. */
const CHEVRON = html`<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>`;

/**
 * Robovoice's UI face (Plus Jakarta Sans; JetBrains Mono is already in the
 * InfiniBot bundle). @font-face can't be declared inside a shadow root, so the
 * stylesheet is linked once on the document; it only declares font faces.
 */
const FONT_HREF = "https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap";
function ensureRobovoiceFont() {
  if (typeof document === "undefined" || document.querySelector("link[data-rv-font]")) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = FONT_HREF;
  link.setAttribute("data-rv-font", "");
  document.head.appendChild(link);
}

const isSet = (v: unknown) => v !== null && v !== undefined && v !== "";
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const s = (v: unknown) => (isSet(v) ? String(v) : "");
const fmtCpm = (v: number) => (Number.isInteger(v) ? v.toLocaleString("en-US") : v.toFixed(1).replace(/\.0$/, ""));
const fmtCredits = (v: number) =>
  Math.abs(v) >= 10_000 ? `${(v / 1000).toFixed(v >= 100_000 ? 0 : 1)}k` : Math.round(v).toLocaleString("en-US");
const charTarget = (id: string): Target => `char:${id}`;

/** robovoice.pipeline.config.get on InfiniBot Cloud: the hosted pipeline, read-only. */
type CloudPipelineView = {
  cloud: true;
  editable: false;
  readOnlyReason?: string;
  resolved: boolean;
  reason?: string;
  locationName?: string;
  effective: { location: Partial<Record<StageKey, { provider: string; model: string } | null>> | null };
};
const isCloudView = (v: unknown): v is CloudPipelineView =>
  Boolean(v && typeof v === "object" && (v as { cloud?: unknown }).cloud === true);

@customElement("rv-pipeline-editor")
export class RvPipelineEditor extends LitElement {
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;

  @state() private view: PipelineView | null = null;
  /** InfiniBot Cloud (voice broker): the hosted pipeline, shown read-only. */
  @state() private cloudView: CloudPipelineView | null = null;
  @state() private account: Account | null = null;
  @state() private scope = ""; // "" = global pipeline, else character id
  @state() private draft: Partial<Record<Target, Fields>> = {};
  @state() private busy = false;
  @state() private loading = false;
  @state() private status: { text: string; error?: boolean } | null = null;
  @state() private loadError: string | null = null;
  @state() private catalogs: Partial<Record<StageKey, Catalog>> = {};
  @state() private filters: Record<string, string> = {};

  static styles = pipelineStyles;

  connectedCallback(): void {
    super.connectedCallback();
    ensureRobovoiceFont();
    void this.load();
  }

  private async rpc<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    let client = this.client ?? getGatewayClient();
    if (!client) client = await awaitGatewayClient(15_000);
    return client.request<T>(method, params);
  }

  async load(): Promise<void> {
    this.loadError = null;
    this.loading = true;
    // All are robovoice.io round trips: fetch them together. The catalogs only
    // price the options; a failed one leaves prices out (never guessed).
    const [account, view] = await Promise.allSettled([
      this.rpc<Account>("robovoice.account.get"),
      this.rpc<PipelineView>("robovoice.pipeline.config.get"),
    ]);
    this.loading = false;
    if (view.status === "fulfilled" && isCloudView(view.value)) {
      // Hosted: no Robovoice location to edit and no catalogs to price.
      this.cloudView = view.value;
      this.view = null;
      return;
    }
    this.cloudView = null;
    void this.loadCatalogs();
    if (account.status === "rejected") {
      this.account = null;
      this.view = null;
      this.loadError = errText(account.reason);
      return;
    }
    this.account = account.value;
    if (!this.account.selectedLocationId) {
      this.view = null;
      return;
    }
    if (view.status === "fulfilled") {
      this.view = view.value;
      if (this.scope && !this.view.characters.some((c) => c.id === this.scope)) this.scope = "";
    } else {
      this.view = null;
      this.loadError = errText(view.reason);
    }
  }

  private async loadCatalogs() {
    // Each stage lands on its own (the LLM catalog is the slow one); a failed
    // stage simply has no prices.
    await Promise.all(
      (["tts", "stt", "llm"] as const).map(async (stage) => {
        try {
          const cat = await this.rpc<Catalog>("robovoice.pipeline.catalog.get", { stage });
          this.catalogs = { ...this.catalogs, [stage]: cat };
        } catch {
          /* no prices for this stage */
        }
      }),
    );
  }

  private async selectLocation(id: string) {
    this.busy = true;
    try {
      await this.rpc("robovoice.location.select", { locationId: id });
      this.draft = {};
      this.scope = "";
      await this.load();
    } catch (e) {
      this.status = { text: errText(e), error: true };
    } finally {
      this.busy = false;
    }
  }

  // ── layers ───────────────────────────────────────────────────────────────
  private charOf(id: string | null | undefined): ViewCharacter | null {
    return id ? (this.view?.characters.find((c) => c.id === id) ?? null) : null;
  }
  private get scopeChar() {
    return this.charOf(this.scope);
  }
  /** The agent the global view's Text-to-Speech card edits (Robovoice: the active character). */
  private get activeChar() {
    const v = this.view;
    if (!v) return null;
    if (v.activeCharacterId !== undefined) return this.charOf(v.activeCharacterId);
    // Older plugin build (no activeCharacterId): same pick as the plugin —
    // the main agent's character, else the first callable one.
    const callable = v.characters.filter((c) => c.callable !== false);
    return callable.find((c) => v.agentByCharacter[c.id] === "main" || c.infinibot_agent_id === "main") ?? callable[0] ?? null;
  }
  private stored(t: Target): Fields {
    if (!this.view) return {};
    if (t === "defaults") return this.view.defaults ?? {};
    return this.charOf(t.slice(5))?.override ?? {};
  }
  private inherited(t: Target): Fields {
    if (!this.view) return {};
    if (t === "defaults") return this.view.inherited.defaults ?? {};
    return this.view.inherited.characters[t.slice(5)] ?? {};
  }
  private kindOf(t: Target, k: string): FieldKind | undefined {
    const kinds = this.view?.fieldKinds;
    return t === "defaults" ? kinds?.defaults[k] : kinds?.character[k];
  }
  /** Allowed at this layer on Robovoice (else "Organization-level"). */
  private allowed(t: Target, k: string): boolean {
    if (this.view?.fieldKinds) return Boolean(this.kindOf(t, k));
    // An older plugin build sends only the field lists (no kinds).
    const list = t === "defaults" ? this.view?.fields?.defaults : this.view?.fields?.character;
    return Boolean(list?.includes(k));
  }
  /** The override at this layer (draft if touched) — undefined/"" = inherit. */
  private raw(t: Target, k: string): unknown {
    const d = this.draft[t];
    return d && k in d ? d[k] : this.stored(t)[k];
  }
  /** What the field shows: the override, else what it inherits. */
  private shown(t: Target, k: string): unknown {
    const v = this.raw(t, k);
    return isSet(v) ? v : this.inherited(t)[k];
  }
  private touched(t: Target, k: string): boolean {
    const d = this.draft[t];
    return Boolean(d && k in d && s(d[k]) !== s(this.stored(t)[k]));
  }
  private edit(t: Target, patch: Fields) {
    this.draft = { ...this.draft, [t]: { ...(this.draft[t] ?? {}), ...patch } };
    this.status = null;
  }
  private get canEdit() {
    return Boolean(this.view?.permissions.canEditPipeline);
  }

  // ── writes ───────────────────────────────────────────────────────────────
  private async write(params: Record<string, unknown>, okText: string) {
    if (!this.view) return;
    this.busy = true;
    this.status = null;
    try {
      const r = await this.rpc<{ changed: boolean; view: PipelineView }>("robovoice.pipeline.config.set", {
        locationId: this.view.locationId,
        ...params,
      });
      this.view = r.view;
      this.draft = {};
      this.status = { text: r.changed ? okText : "No changes" };
      if (r.changed) this.dispatchEvent(new CustomEvent("rv-pipeline-saved", { bubbles: true, composed: true }));
    } catch (e) {
      this.status = { text: errText(e), error: true };
    } finally {
      this.busy = false;
    }
  }

  private apply() {
    if (this.scope) return this.write({ characterId: this.scope, values: this.draft[charTarget(this.scope)] ?? {} }, "Saved ✓");
    const characterValues: Record<string, Fields> = {};
    for (const [t, v] of Object.entries(this.draft)) if (t.startsWith("char:") && v) characterValues[t.slice(5)] = v;
    return this.write({ values: this.draft.defaults ?? {}, characterValues }, "Saved ✓");
  }

  private resetAll() {
    return this.write(this.scope ? { characterId: this.scope, resetAll: true } : { resetAll: true }, "All overrides reset — everything inherits again");
  }

  /** Robovoice: resetting a saved override PATCHes it to null right away. */
  private resetField(t: Target, keys: string[]) {
    const saved = keys.filter((k) => isSet(this.stored(t)[k]));
    const d = { ...(this.draft[t] ?? {}) };
    for (const k of keys) delete d[k];
    this.draft = { ...this.draft, [t]: d };
    if (!saved.length) return;
    const charId = t === "defaults" ? undefined : t.slice(5);
    return this.write(charId ? { characterId: charId, reset: saved } : { reset: saved }, "Reset — now inherited");
  }

  // ── pricing (Robovoice catalog: tier per model, credits/min per tier) ─────
  private tierOf(stage: StageKey, provider: string, model?: string | null): Tier | null {
    const cat = this.catalogs[stage];
    if (!cat) return null;
    for (const t of cat.tiers)
      for (const f of t.families)
        for (const m of f.models) if (m.provider === provider && (!model || m.model === model)) return m.tier;
    return "standard";
  }
  private price(tier: Tier | null): number | null {
    const p = this.catalogs.tts?.prices ?? this.catalogs.llm?.prices ?? this.catalogs.stt?.prices;
    return tier && p ? p[tier] : null;
  }
  /** Robovoice makeOptionPrice (organization view). */
  private optionPrice(stage: StageKey, provider: string, model: string | null): string {
    if (stage === "tts") {
      const t = this.tierOf("tts", provider, model);
      const cpm = this.price(t);
      // Cloud voice is free for InfiniBot: show the voice tier, never a price.
      void cpm;
      return t ? TIER_LABEL[t] : "";
    }
    const lt = stage === "llm" ? this.tierOf("llm", provider, model) : "standard";
    if (!this.catalogs[stage] && stage === "llm") return "";
    if (lt && lt !== "standard") {
      const cpm = this.price(lt);
      void cpm;
      return TIER_LABEL[lt];
    }
    return "";
  }
  /** voiceCatalogKey (pipeline-quality.ts) → the voice tier of a character. */
  private voiceTier(fields: Fields): Tier | null {
    const provider = s(fields.tts_provider);
    if (!provider) return null;
    let model = "";
    if (provider === "inworld") model = s(fields.inworld_model_id) || "inworld-tts-2-flash";
    else if (provider === "elevenlabs")
      model = fields.expressive_mode === true ? "eleven_v3" : s(fields.elevenlabs_model_id) || "eleven_flash_v2_5";
    return this.tierOf("tts", provider, model || null);
  }

  // ── render ───────────────────────────────────────────────────────────────
  /** InfiniBot Cloud: the STT → LLM → TTS every call runs on the hosted voice agent. Read-only. */
  private renderCloud(v: CloudPipelineView) {
    const loc = v.effective.location;
    const card = (key: StageKey) => {
      const st = STAGES.find((x) => x.key === key)!;
      const stage = loc?.[key] ?? null;
      return html`<section class="stage glass" data-stage=${key} data-testid=${`rv-cloud-stage-${key}`}
        style="box-shadow: inset 0 1px 0 0 rgba(255,255,255,0.12), 0 0 0 1px ${st.tone}26, 0 18px 44px -26px ${st.tone};">
        <div class="stage-head">
          <span class="num" style="background:${st.tone}22;color:${st.tone}">${st.n}</span>
          <span class="pill muted">${stage?.provider ?? "unavailable"}</span>
        </div>
        <h3>${st.title}</h3>
        <p class="model" title=${stage?.model ?? ""}>${stage ? stage.model || "provider default" : "Not published by InfiniBot Cloud"}</p>
      </section>`;
    };
    return html`<div class="wrap" data-testid="rv-pipeline-cloud">
      <p class="access" data-testid="rv-pipeline-access" data-access="read">
        ${v.readOnlyReason ?? "On InfiniBot Cloud, calls run the hosted voice pipeline. It is read-only here."}
        ${v.resolved ? nothing : html` ${v.reason ?? ""}`}
      </p>
      <div class="tab">
        <div class="stages">
          ${card("stt")}${this.renderConnector(TONE.stt)}${card("llm")}${this.renderConnector(TONE.llm)}${card("tts")}
        </div>
      </div>
    </div>`;
  }

  render() {
    if (this.cloudView) return this.renderCloud(this.cloudView);
    if (this.loadError && !this.view) {
      return html`<div class="glass card" data-testid="rv-pipeline-error-card"><span class="cap">Pipeline unavailable</span>
        <div class="err" data-testid="rv-pipeline-error">Couldn't load the pipeline from Robovoice: ${this.loadError}</div>
        <div style="margin-top:12px"><button class="btn outline" data-testid="rv-pipeline-retry" ?disabled=${this.loading} @click=${() => void this.load()}>${this.loading ? "Retrying…" : "Retry"}</button></div></div>`;
    }
    if (!this.account) {
      return html`<div class="skel-wrap" data-testid="rv-pipeline-loading" aria-busy="true" aria-label="Loading the pipeline from Robovoice">
        <div class="skel" style="height:44px;"></div>
        <div class="skel-row"><div class="skel" style="height:150px;"></div><div class="skel" style="height:150px;"></div><div class="skel" style="height:150px;"></div></div>
      </div>`;
    }
    if (!this.account.selectedLocationId || !this.view) {
      return html`<div class="glass card">
        <span class="cap">Location pipeline</span>
        <div class="helper">Link this install to Robovoice (above) — it becomes a Robovoice location, and its speech-to-text → model → voice pipeline shows up here.</div>
      </div>`;
    }
    const v = this.view;
    const scopeChar = this.scopeChar;
    const active = this.activeChar;
    const target: Target = scopeChar ? charTarget(scopeChar.id) : "defaults";
    const hasOverrides = Object.keys(this.stored(target)).length > 0;
    const notCallable = v.characters.filter((c) => c.callable === false);
    const pricing = this.pricing();
    return html`
      <div class="wrap" data-testid="rv-pipeline-editor">
        <p class="access" data-testid="rv-pipeline-access" data-access=${this.canEdit ? "edit" : "read"}>
          ${this.canEdit
            ? html`You can override any field for ${v.locationName}. API keys stay with the organization — providers it has no key for can't be picked.`
            : html`Read-only — your role at this location can view these settings but not change them.`}
          ${notCallable.length
            ? html` ${notCallable.map((c) => c.name).join(", ")} ${notCallable.length === 1 ? "is" : "are"} placed here but not in the voice agent's roster, so there is nothing to configure yet.`
            : nothing}
        </p>

        <div class="tab">
          <div class="sticky-bar">
            <div class="bar-text">
              At <b>${v.locationName}</b> · Live voice pipeline for <b>${scopeChar?.name ?? active?.name ?? "—"}</b> · latency = 24h p50 · swap a stage &amp; apply.
            </div>
            <div class="bar-actions">
              ${this.status ? html`<span class=${this.status.error ? "err" : "ok"} role="status">${this.status.text}</span>` : nothing}
              ${this.canEdit && hasOverrides
                ? html`<button class="btn ghost" ?disabled=${this.busy} @click=${() => this.resetAll()}>${scopeChar ? "Reset agent overrides" : "Reset location defaults"}</button>`
                : nothing}
              <button class="btn primary" id="rv-apply" ?disabled=${this.busy || !this.canEdit} @click=${() => this.apply()}>${this.busy ? "Applying…" : "Apply live"}</button>
            </div>
          </div>

          ${this.renderScopeCard()}
          ${scopeChar ? this.renderAgentPipeline(scopeChar) : this.renderGlobal(pricing)}
          ${this.renderLanguageMap()}
          ${this.renderPrice(pricing.billed, pricing.voiceTier, pricing.llmTier, active?.name ?? null)}
          ${this.renderKpis(pricing.billed)}
          ${this.renderPresets()}
          ${scopeChar ? nothing : this.renderAdvanced()}
        </div>
      </div>
    `;
  }

  /** Voice tier of the active agent, the LLM's tier, and the tier the call bills at (the higher one). */
  private pricing(): { voiceTier: Tier | null; llmTier: Tier | null; billed: Tier | null } {
    const v = this.view!;
    const active = this.activeChar;
    const tt: Target | null = active ? charTarget(active.id) : null;
    const ttsFields: Fields = tt ? { ...this.inherited(tt), ...Object.fromEntries(Object.entries({ ...this.stored(tt), ...(this.draft[tt] ?? {}) }).filter(([, x]) => isSet(x))) } : {};
    const voiceTier = tt ? this.voiceTier(ttsFields) : null;
    const llmProvider = s(this.shown("defaults", "llm_provider"));
    const llmModel = s(this.shown("defaults", v.modelKeys.llm[llmProvider] ?? ""));
    const llmTier = this.tierOf("llm", llmProvider, llmModel || null);
    const billed = voiceTier && llmTier ? (TIER_ORDER.indexOf(llmTier) > TIER_ORDER.indexOf(voiceTier) ? llmTier : voiceTier) : voiceTier;
    return { voiceTier, llmTier, billed };
  }

  private closeMenu(e: Event) {
    ((e.currentTarget as HTMLElement).closest(".menu") as (HTMLElement & { hidePopover?: () => void }) | null)?.hidePopover?.();
  }

  /** Robovoice Select: a native select sunk into the glass, with its own chevron. */
  private sel(select: TemplateResult) {
    return html`<div class="sel">${select}${CHEVRON}</div>`;
  }

  private renderScopeCard() {
    const v = this.view!;
    const scopeChar = this.scopeChar;
    const options = [
      { value: "", label: "Global pipeline", hint: "The stages every agent inherits" },
      ...v.characters
        .filter((c) => c.callable !== false)
        .map((c) => {
          const f = { ...c.own, ...c.override };
          const hint =
            [s(f.stt_provider) && `STT ${s(f.stt_provider)}`, s(f.llm_provider) && `LLM ${s(f.llm_provider)}`, s(f.tts_provider) && `TTS ${s(f.tts_provider)}`]
              .filter(Boolean)
              .join(" · ") || "Inherits the global pipeline";
          const agent = v.agentByCharacter[c.id] ?? c.infinibot_agent_id;
          return { value: c.id, label: `${c.name}${agent ? " · InfiniBot" : ""}`, hint };
        }),
    ];
    const current = options.find((o) => o.value === this.scope);
    return html`<div class="glass card p4 scope">
      <div class="scope-row">
        ${this.account!.locations.length > 1
          ? html`<span class="cap">Location:</span>
              <div class="scope-pick">
                ${this.sel(html`<select id="rv-location-select" aria-label="Robovoice location" ?disabled=${this.busy}
                  @change=${(e: Event) => void this.selectLocation((e.target as HTMLSelectElement).value)}>
                  ${this.account!.locations.map(
                    (l) => html`<option value=${l.id} ?selected=${l.id === v.locationId}>${this.account!.org?.name ? `${this.account!.org.name} · ` : ""}${l.name}</option>`,
                  )}
                </select>`)}
              </div>`
          : nothing}
        <span class="cap">Configure pipeline for:</span>
        <div class="scope-pick">
          <button type="button" class="trigger" id="rv-scope-select" aria-haspopup="listbox" aria-label="Configure pipeline for"
            popovertarget="rv-scope-menu" data-value=${this.scope} style="anchor-name:--rv-scope;">
            <span class="lbl">${current?.label ?? "—"}</span>${CHEVRON}
          </button>
          <div class="menu scope-menu" id="rv-scope-menu" popover role="listbox" aria-label="Configure pipeline for" data-testid="rv-scope-menu" style="position-anchor:--rv-scope;">
            ${options.map(
              (o) => html`<button type="button" role="option" class="sopt ${o.value === this.scope ? "on" : ""}" aria-selected=${o.value === this.scope ? "true" : "false"} data-value=${o.value}
                @click=${(e: Event) => {
                  this.scope = o.value;
                  this.status = null;
                  this.closeMenu(e);
                }}>
                <span><span class="n">${o.label}</span><span class="h">${o.hint}</span></span>
                ${o.value === this.scope ? html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" aria-hidden="true"><path d="m5 13 4 4L19 7" /></svg>` : nothing}
              </button>`,
            )}
          </div>
        </div>
        <span class="helper">
          ${scopeChar
            ? `Editing ${scopeChar.name} at ${v.locationName} — every field inherits until you override it here.`
            : `Editing ${v.locationName}'s defaults — every field inherits from the organization until you override it here.`}
        </span>
      </div>
    </div>`;
  }

  // ── global scope ─────────────────────────────────────────────────────────
  private renderGlobal(p: { voiceTier: Tier | null; billed: Tier | null }) {
    return html`
      <div class="stages">
        ${this.renderStageCard("stt")}
        ${this.renderConnector(TONE.stt)}
        ${this.renderStageCard("llm")}
        ${this.renderConnector(TONE.llm)}
        ${this.renderTtsCard(p.voiceTier, p.billed)}
      </div>

      <div class="glass card" data-testid="rv-idle-billing">
        <div class="row-between">
          <div class="idle-text">
            <h3>Pause billing when idle</h3>
            <p class="help">After this long with no speech, motion or reply, a call goes idle but stays connected. It wakes the moment someone speaks or motion is detected. Background noise alone never restarts it. Agents can override this in the Agents tab.</p>
          </div>
          <div class="idle-pick">
            ${this.renderIdleSelect("defaults")}
          </div>
        </div>
      </div>

      <div class="glass card" data-testid="rv-language-routing">
        <h3>Language routing</h3>
        <p class="help">How the agent follows a visitor who changes language. The call page shows the language chosen for each turn and any engine it switched to. Agents can override these in the Agents tab.</p>
        <div class="toggles">
          ${LANGUAGE_ROUTING.map(
            (f) => html`<div class="toggle-row">
              <div class="txt"><div class="t">${f.label}</div><p>${f.hint}</p></div>
              <div class="ctl">${this.renderSwitch("defaults", f.key, true)}${this.renderMarker("defaults", [f.key])}</div>
            </div>`,
          )}
        </div>
      </div>
    `;
  }

  /** Robovoice MultilingualSection: org-level on a location page (not sent to edge tokens). */
  private renderLanguageMap() {
    return html`<div class="glass card" data-testid="rv-language-map">
      <div class="map-row">
        <div class="txt">
          <div class="head"><h2>Default language map — fallback for agents without their own</h2></div>
          <p class="help t2">Speak each reply with a voice that fits its language. The agent reads the script of the text it is about to say — Hebrew letters can only be Hebrew — so detection is instant and local: no extra model, no extra request, nothing added to the turn. <span class="fg80">This is the DEFAULT map every agent inherits — an agent with its own “Language voices (per-agent)” map overrides it.</span></p>
        </div>
        <div class="org">
          <p class="marker"><span class="orglevel" title="Set in the organization's main dashboard">Organization-level</span></p>
          <p class="marker">${this.robovoiceLink("", "Open Robovoice ↗")}</p>
        </div>
      </div>
    </div>`;
  }

  /**
   * Robovoice's KPI grid. The 24h latency / turn analytics are not exposed to
   * edge tokens, so those tiles show Robovoice's own "no data" value.
   */
  private renderKpis(billed: Tier | null) {
    const tiles: Array<{ label: string; text: string; c: string }> = [
      { label: "End-to-end p50", text: "—", c: "#818cf8" },
      { label: "End-to-end p95", text: "—", c: "#818cf8" },
      { label: "EOU delay p50", text: "—", c: "#a78bfa" },
      { label: "Turns (24h)", text: "—", c: "#c4b5fd" },
      { label: "Cloud voice", text: "Free", c: "#f0dca8" },
    ];
    return html`<div class="glass card" data-testid="rv-kpis">
      <div class="kpis">
        ${tiles.map((m) => html`<div class="kpi subpanel"><div class="l">${m.label}</div><div class="v" style="color:${m.c}">${m.text}</div></div>`)}
      </div>
      <p class="helper" style="margin-top:12px;">End-to-end latency, EOU delay and turn counts are on Robovoice's ${this.robovoiceLink("/pipeline", "location Pipeline page ↗")}.</p>
    </div>`;
  }

  private renderPresets() {
    return html`<div class="presets" data-testid="rv-presets">
      <div class="head">
        <h2>Presets — save &amp; reuse this pipeline</h2>
        <p class="help t2">Create a named STT → LLM → TTS combination, then stamp it onto an agent, the global config, or a location. Same presets as Providers → Presets.</p>
      </div>
      <div class="glass card">${this.renderOrgLevel("Presets live with the organization.")}</div>
    </div>`;
  }

  private robovoiceLink(section: string, label: string) {
    const base = (this.account?.link?.apiBase ?? "https://robovoice.io").replace(/\/+$/, "");
    const slug = this.account?.locations.find((l) => l.id === this.view?.locationId)?.slug ?? this.account?.link?.locationSlug;
    const href = slug ? `${base}/l/${slug}${section}` : `${base}/dashboard`;
    return html`<a class="ext" href=${href} target="_blank" rel="noopener">${label}</a>`;
  }

  private renderOrgLevel(text: string) {
    return html`<p class="marker"><span class="orglevel" title="Set in the organization's main dashboard">Organization-level</span>
      <span>· ${text} ${this.robovoiceLink("", "Open Robovoice ↗")}</span></p>`;
  }

  private renderConnector(tone: string) {
    // Robovoice's gradient id carries the "#" of the tone (url(#g#a855f7)), so its dashed line never paints: the arrow is the connector.
    return html`<div class="connector" aria-hidden="true"><svg width="46" height="24" viewBox="0 0 46 24" fill="none">
      <path d="M36 6l8 6-8 6z" fill=${tone} />
    </svg></div>`;
  }

  /**
   * Robovoice StageMeters: Speed (p50 · 24h) | Price. Robovoice's per-stage
   * latency analytics are not exposed to edge tokens, so Speed shows the same
   * "—" Robovoice renders when it has no figure.
   */
  private stageMeters(tone: string, price: TemplateResult) {
    return html`<div class="meters">
      <div class="meter speed subpanel" data-testid="rv-stage-speed">
        <div class="r1"><span class="micro">Speed</span></div>
        <div class="r2"><span class="tnum" style="color:${tone}">—</span></div>
        <div class="r3">p50 · 24h</div>
      </div>
      ${price}
    </div>`;
  }

  private stageShell(key: StageKey, pill: string, model: string, extra: string, price: TemplateResult, body: TemplateResult) {
    const st = STAGES.find((x) => x.key === key)!;
    return html`<section class="stage glass" data-stage=${key}
      style="box-shadow: inset 0 1px 0 0 rgba(255,255,255,0.12), 0 0 0 1px ${st.tone}26, 0 18px 44px -26px ${st.tone};">
      <div class="stage-head">
        <span class="num" style="background:${st.tone}22;color:${st.tone}">${st.n}</span>
        <span class="pill muted">${pill || "—"}</span>
      </div>
      <h3>${st.title}</h3>
      <p class="model" title=${model}>${model || "—"}</p>
      ${extra ? html`<p class="extra">${extra}</p>` : nothing}
      ${this.stageMeters(st.tone, price)}
      <div class="body">${body}</div>
    </section>`;
  }

  private includedPrice() {
    return html`<div class="meter price">
      <div class="r1"><span class="micro">Price</span></div>
      <div class="r2"><span class="included" title="Cloud voice is free on InfiniBot">Included</span></div>
      <div class="r3">the voice tier sets the price</div>
    </div>`;
  }

  private tierBadge(tier: Tier, cpm: number | null) {
    // Free on InfiniBot: the tier only, never a credit price.
    void cpm;
    return html`<span class="tier-badge ${tier}">${TIER_LABEL[tier]}</span>`;
  }

  private renderStageCard(key: "stt" | "llm") {
    const v = this.view!;
    const t: Target = "defaults";
    const pk = `${key}_provider`;
    const provider = s(this.shown(t, pk));
    const mk = v.modelKeys[key][provider] ?? null;
    const model = mk ? s(this.shown(t, mk)) : "";
    const extra = key === "stt" ? `lang: ${s(this.shown(t, "stt_language")) || "—"}` : isSet(this.shown(t, "temperature")) ? `temp ${s(this.shown(t, "temperature"))}` : "";
    const providers = (v.providers[key] ?? []).filter((p) => p.id !== "infinibot");
    const opts = mk ? (v.options?.[key]?.[provider] ?? []) : [];
    const body = html`<div class="stack2">
        <div>
          <span class="cap">Provider</span>
          ${this.renderProviderSelect(t, key, providers, pk, { sep: " · ", price: true }, (id) => this.edit(t, { [pk]: id }))}
          ${this.renderMarker(t, [pk])}
        </div>
        <div>
          <span class="cap">Model</span>
          ${mk
            ? this.renderCombo(t, mk, opts, {
                providerLabel: providers.find((p) => p.id === provider)?.label ?? provider,
                placeholder: "Search models…",
                note: (m) => this.optionPrice(key, provider, m),
              })
            : html`<button type="button" class="trigger" disabled><span class="lbl id empty">no model field for this provider</span>${CHEVRON}</button>`}
          ${mk ? this.renderMarker(t, [mk]) : this.renderMarkerOrg()}
        </div>
      </div>
      ${this.providerNotice(key, provider)}`;
    return this.stageShell(key, provider, model, extra, this.includedPrice(), body);
  }

  private renderTtsCard(voiceTier: Tier | null, billed: Tier | null) {
    const v = this.view!;
    const active = this.activeChar;
    const price = html`<div class="meter price">
      <div class="r1"><span class="micro">Voice tier</span>${billed ? html`<span class="tier">${TIER_LABEL[billed]}</span>` : nothing}</div>
      <div class="r2"><span class="big tnum"><span class="v">Free</span></span></div>
      <div class="r3">cloud voice on InfiniBot</div>
    </div>`;
    if (!active) {
      return this.stageShell("tts", "", "", "", price, html`<div class="helper">No agent at this location yet — Text-to-Speech is set per agent.</div>`);
    }
    const t = charTarget(active.id);
    const provider = s(this.shown(t, "tts_provider"));
    const voiceKey = `tts_voice_${provider}`;
    const voice = s(this.shown(t, voiceKey));
    const providers = v.providers.tts ?? [];
    const body = html`<div class="stack2">
        <div>
          <div class="cap-row">
            <span class="cap">Provider · ${active.name}</span>
            ${voiceTier ? this.tierBadge(voiceTier, this.price(voiceTier)) : nothing}
          </div>
          ${this.renderProviderSelect(t, "tts", providers, "tts_provider", { sep: " — ", price: true }, (id) => this.edit(t, { tts_provider: id }))}
          ${this.renderMarker(t, ["tts_provider"])}
        </div>
        <div>
          <span class="cap">Voice</span>
          ${this.renderVoiceControl(t, provider, voice, false)}
        </div>
      </div>
      ${this.providerNotice("tts", provider)}`;
    return this.stageShell("tts", provider, voice, "", price, body);
  }

  /** Voice picker per provider (Robovoice pipeline-tab voicePicker / CharacterPipeline TTS row). */
  private renderVoiceControl(t: Target, provider: string, voice: string, agentScope: boolean) {
    const v = this.view!;
    const key = `tts_voice_${provider}`;
    const opts = v.options?.tts?.[provider] ?? [];
    if (!provider) {
      return this.sel(html`<select disabled aria-label="Voice"><option>—</option></select>`);
    }
    if (provider === "fal") {
      return html`<button type="button" class="trigger locked" disabled aria-label="fal voice"><span class="lbl id empty">${agentScope ? "fal voice (global)…" : "Search fal voices…"}</span>${CHEVRON}</button>${this.renderMarkerOrg()}`;
    }
    if (!this.allowed(t, key)) {
      return html`<div class="locked">${this.sel(html`<select disabled aria-label="Voice"><option>${voice || "—"}</option></select>`)}</div>${this.renderMarkerOrg()}`;
    }
    if (provider === "elevenlabs" || provider === "inworld") {
      const label = provider === "elevenlabs" ? "ElevenLabs" : "Inworld";
      return html`${this.renderCombo(t, key, opts, {
        providerLabel: label,
        placeholder: agentScope ? `${label} voice…` : `Search ${label} voices…`,
        note: agentScope ? () => "" : () => this.optionPrice("tts", provider, null),
        showName: agentScope && provider === "elevenlabs",
      })}${this.renderMarker(t, [key])}`;
    }
    const list = opts.length ? [...opts] : [];
    if (voice && !list.some((o) => o.id === voice)) list.push({ id: voice, name: voice });
    const p = agentScope ? "" : this.optionPrice("tts", provider, null);
    return html`${this.sel(html`<select aria-label="Voice" ?disabled=${!this.canEdit} @change=${(e: Event) => this.edit(t, { [key]: (e.target as HTMLSelectElement).value })}>
        ${list.length
          ? list.map((o) => html`<option value=${o.id} ?selected=${voice === o.id}>${o.name ?? o.id}${p ? ` · ${p}` : ""}</option>`)
          : html`<option value="" selected>${agentScope ? "— none —" : "—"}</option>`}
      </select>`)}${this.renderMarker(t, [key])}`;
  }

  /**
   * Robovoice provider Select. Without `inheritLabel` the select shows the
   * effective provider (picking the inherited one clears the override on
   * Apply, as on Robovoice); with it, an explicit "Inherit …" row leads.
   */
  private renderProviderSelect(
    t: Target,
    stage: StageKey,
    providers: ProviderOpt[],
    pk: string,
    o: { sep?: string; price?: boolean; inheritLabel?: string; value?: string },
    onPick: (id: string) => void,
  ) {
    const inherit = o.inheritLabel !== undefined;
    const value = o.value ?? (inherit ? s(this.raw(t, pk)) : s(this.shown(t, pk)));
    const list = [...providers];
    // A saved value always stays visible (Robovoice keeps it even when hidden).
    if (value && !list.some((p) => p.id === value)) list.push({ id: value, label: value });
    return this.sel(html`<select aria-label="${STAGES.find((x) => x.key === stage)!.title} provider" ?disabled=${!this.canEdit}
      @change=${(e: Event) => onPick((e.target as HTMLSelectElement).value)}>
      ${inherit ? html`<option value="" ?selected=${!value}>${o.inheritLabel}</option>` : !value ? html`<option value="" selected>—</option>` : nothing}
      ${list.map((p) => {
        const off = p.available === false;
        const price = o.price && !off ? this.optionPrice(stage, p.id, null) : "";
        const label = `${p.label}${p.local ? " (local)" : ""}${price ? `${o.sep ?? " · "}${price}` : ""}${off ? ` — ${p.id === "infinibot" ? (p.hint ?? "unavailable") : "no organization API key"}` : ""}`;
        return html`<option value=${p.id} ?disabled=${off && value !== p.id} ?selected=${value === p.id}>${label}</option>`;
      })}
    </select>`);
  }

  private providerNotice(stage: StageKey, provider: string) {
    const p = this.view?.providers[stage]?.find((x) => x.id === provider);
    if (!p || p.available !== false) return nothing;
    return html`<div class="notice" data-testid="rv-provider-notice"><b>API key required.</b></div>`;
  }

  /**
   * Searchable model / voice picker (Robovoice ModelCombo in location scope):
   * a trigger + a filtered menu of the organization's live list only; a saved
   * value the account no longer offers is flagged. When Robovoice returned no
   * list for the provider (slow / down), free text.
   */
  private renderCombo(
    t: Target,
    k: string,
    opts: Opt[],
    o: { providerLabel: string; placeholder: string; note: (id: string) => string; inheritLabel?: string; showName?: boolean; value?: string },
  ) {
    const inherit = o.inheritLabel !== undefined;
    const value = o.value ?? (inherit ? s(this.raw(t, k)) : s(this.shown(t, k)));
    const fid = `${t}:${k}`;
    if (!opts.length) {
      return html`<input type="text" class="mono" aria-label=${o.placeholder} placeholder=${o.inheritLabel ?? (s(this.inherited(t)[k]) || "provider default")} .value=${value}
        ?disabled=${!this.canEdit} @change=${(e: Event) => this.edit(t, { [k]: (e.target as HTMLInputElement).value.trim() })} />`;
    }
    const dom = fid.replace(/[^a-zA-Z0-9_-]/g, "_");
    const q = (this.filters[fid] ?? "").toLowerCase();
    const shown = q ? opts.filter((x) => `${x.id} ${x.name ?? ""}`.toLowerCase().includes(q)).slice(0, 200) : opts.slice(0, 200);
    const known = opts.find((x) => x.id === value);
    const unavailable = Boolean(value) && !known;
    const pick = (e: Event, id: string) => {
      this.edit(t, { [k]: id });
      this.filters = { ...this.filters, [fid]: "" };
      this.closeMenu(e);
    };
    return html`
      <button type="button" class="trigger" data-combo=${k} data-value=${value} aria-label=${o.placeholder} aria-haspopup="listbox"
        popovertarget="m-${dom}" style="anchor-name:--a-${dom};" ?disabled=${!this.canEdit}
        title=${known ? `${known.name ?? known.id} · ${known.id}` : value || o.inheritLabel || o.placeholder}>
        ${o.showName && known
          ? html`<span class="named"><b>${known.name ?? known.id}</b><i>${known.id}</i></span>`
          : html`<span class="lbl id ${value ? "" : "empty"}">${value || o.inheritLabel || o.placeholder}</span>`}
        ${unavailable ? html`<span class="badge-unavail">unavailable</span>` : nothing}
        ${CHEVRON}
      </button>
      <div class="menu" id="m-${dom}" popover role="listbox" aria-label=${o.placeholder} style="position-anchor:--a-${dom};">
        <input type="search" aria-label="Filter" placeholder="Filter…" .value=${this.filters[fid] ?? ""}
          @input=${(e: Event) => (this.filters = { ...this.filters, [fid]: (e.target as HTMLInputElement).value })} />
        <div class="rows">
          ${inherit ? html`<button type="button" role="option" class="inherit ${value ? "" : "on"}" data-value="" @click=${(e: Event) => pick(e, "")}>${o.inheritLabel}</button>` : nothing}
          ${shown.map((x) => {
            const p = o.note(x.id);
            return html`<button type="button" role="option" class="opt ${value === x.id ? "on" : ""}" aria-selected=${value === x.id ? "true" : "false"} data-value=${x.id} @click=${(e: Event) => pick(e, x.id)}>
              <div class="n">${x.name ?? x.id}</div><div class="i">${x.id}</div>${p ? html`<div class="p">${p}</div>` : nothing}
            </button>`;
          })}
          ${shown.length === 0 ? html`<p class="none">No match.</p>` : nothing}
        </div>
      </div>
      ${unavailable
        ? html`<p class="alert" role="alert">${value} isn't offered by the organization's ${o.providerLabel} account any more — calls here may fail. Pick another ${k.startsWith("tts_voice") ? "voice" : "model"}.</p>`
        : nothing}
`;
  }

  /** Robovoice IdleBillingSelect: the effective timeout; picking the inherited one clears the override. */
  private renderIdleSelect(t: Target) {
    const k = "idle_billing_timeout_seconds";
    const cur = Number(this.shown(t, k));
    const has = Number.isFinite(cur) && cur > 0;
    const values = has && !IDLE_PRESETS.includes(cur) ? [...IDLE_PRESETS, cur].sort((a, b) => a - b) : IDLE_PRESETS;
    return html`${this.sel(html`<select aria-label="Pause billing when idle" ?disabled=${!this.canEdit}
        @change=${(e: Event) => {
          const val = (e.target as HTMLSelectElement).value;
          this.edit(t, { [k]: val === "" ? "" : Number(val) });
        }}>
        ${has ? nothing : html`<option value="" selected>—</option>`}
        ${values.map((sec) => html`<option value=${String(sec)} ?selected=${has && cur === sec}>After ${idleLabel(sec)} idle</option>`)}
      </select>`)}${this.renderMarker(t, [k])}`;
  }

  private renderSwitch(t: Target, k: string, defaultOn: boolean) {
    const val = this.shown(t, k);
    const on = isSet(val) ? val !== false : defaultOn;
    return html`<label class="switch">
      <input type="checkbox" role="switch" aria-label=${k} .checked=${on} ?disabled=${!this.canEdit || !this.allowed(t, k)}
        @change=${(e: Event) => this.edit(t, { [k]: (e.target as HTMLInputElement).checked })} />
      <span class="track"></span>
    </label>`;
  }

  private renderMarker(t: Target, keys: string[]) {
    if (keys.some((k) => !this.allowed(t, k))) return this.renderMarkerOrg();
    const overridden = keys.some((k) => isSet(this.raw(t, k)));
    const touched = keys.some((k) => this.touched(t, k));
    return html`<div class="marker" data-scoped-field=${keys.join(",")} data-overridden=${overridden ? "true" : "false"}>
      ${overridden
        ? html`<span class="over">Overridden here</span>
            ${this.canEdit
              ? html`<button class="linkish" ?disabled=${this.busy} @click=${(e: Event) => { e.preventDefault(); void this.resetField(t, keys); }}>Reset to inherited</button>`
              : nothing}`
        : html`<span>Inherited</span>`}
      ${touched ? html`<span class="pending">· unsaved</span>` : nothing}
    </div>`;
  }

  private renderMarkerOrg() {
    return html`<p class="marker"><span class="orglevel" title="Set in the organization's main dashboard">Organization-level</span></p>`;
  }

  /** Cloud voice is free for InfiniBot: no per-minute price, only the voice tier this pipeline uses. */
  private renderPrice(billed: Tier | null, _voiceTier: Tier | null, _llmTier: Tier | null, agent: string | null) {
    return html`<div class="glass card" data-testid="rv-price">
      <div class="row-between">
        <div class="bill-text">
          <span class="micro gold">Cloud voice</span>
          <div class="bill-row"><span class="bill tnum">Free</span><span class="bill-unit">no credits or top-ups</span></div>
          <p class="bill-help">${billed ? `${agent ?? "This agent"} speaks with a ${TIER_LABEL[billed].toLowerCase()} voice. ` : ""}Usage is measured only to keep cloud voice fair; if it's ever busy, switch back to local voice in one click.</p>
        </div>
      </div>
    </div>`;
  }


  private renderAdvanced() {
    const t: Target = "defaults";
    if (!this.view?.fieldKinds) return nothing;
    const count = ADVANCED.flatMap((g) => g.fields).filter((f) => isSet(this.raw(t, f.k))).length;
    return html`<details class="glass card adv" data-testid="rv-advanced">
      <summary>
        <div><h3>Advanced — location overrides</h3>
          <p class="help">The rest of this location's Robovoice settings: turn-taking, wake word, model sampling and voice delivery. On Robovoice they're under Controls and the Agents editor; each inherits from the organization until you override it here.</p></div>
        <span class="pill ${count ? "gold" : "muted"}">${count ? `${count} overridden` : "all inherited"}</span>
      </summary>
      <div class="adv-grid">
        ${ADVANCED.map(
          (g) => html`<div class="adv-sec subpanel">
            <h4>${g.title}</h4><div class="sub">${g.subtitle}</div>
            ${g.fields.map((f) => this.renderAdvField(t, f))}
          </div>`,
        )}
      </div>
    </details>`;
  }

  private renderAdvField(t: Target, f: { k: string; label: string; hint?: string; fmt?: (v: number) => string }) {
    const kind = this.kindOf(t, f.k);
    if (!kind) return nothing;
    const val = this.shown(t, f.k);
    const rawVal = this.raw(t, f.k);
    let control: TemplateResult;
    if (kind.type === "bool") {
      control = html`<div style="display:flex;justify-content:flex-end">${this.renderSwitch(t, f.k, false)}</div>`;
    } else if (kind.type === "num" || kind.type === "int") {
      const n = isSet(val) ? Number(val) : null;
      const pct = n == null ? 0 : Math.max(0, Math.min(100, ((n - kind.min) / (kind.max - kind.min)) * 100));
      control = html`<input type="range" aria-label=${f.label} min=${kind.min} max=${kind.max} step=${kind.step} style="--pct:${pct}%"
          .value=${String(n ?? kind.min)} ?disabled=${!this.canEdit}
          @change=${(e: Event) => this.edit(t, { [f.k]: Number((e.target as HTMLInputElement).value) })} />`;
    } else if (kind.type === "preemptive") {
      const cur = isSet(rawVal) ? String(rawVal) : "";
      control = this.sel(html`<select aria-label=${f.label} ?disabled=${!this.canEdit}
          @change=${(e: Event) => {
            const x = (e.target as HTMLSelectElement).value;
            this.edit(t, { [f.k]: x === "" ? "" : x === "auto" ? "auto" : x === "true" });
          }}>
          <option value="" ?selected=${!cur}>Inherit — ${isSet(this.inherited(t)[f.k]) ? String(this.inherited(t)[f.k]) : "default"}</option>
          <option value="auto" ?selected=${cur === "auto"}>Auto</option>
          <option value="true" ?selected=${cur === "true"}>On</option>
          <option value="false" ?selected=${cur === "false"}>Off</option>
        </select>`);
    } else if (f.k === "elevenlabs_model_id" || f.k === "inworld_model_id") {
      const list = f.k === "elevenlabs_model_id" ? ELEVENLABS_MODELS : INWORLD_MODELS;
      const cur = s(rawVal);
      control = this.sel(html`<select aria-label=${f.label} ?disabled=${!this.canEdit} @change=${(e: Event) => this.edit(t, { [f.k]: (e.target as HTMLSelectElement).value })}>
          <option value="" ?selected=${!cur}>Inherit — ${s(this.inherited(t)[f.k]) || "default"}</option>
          ${list.map((x) => html`<option value=${x.id} ?selected=${cur === x.id}>${x.name} · ${x.id}</option>`)}
          ${cur && !list.some((x) => x.id === cur) ? html`<option value=${cur} selected>${cur}</option>` : nothing}
        </select>`);
    } else {
      control = html`<input type="text" aria-label=${f.label} placeholder=${s(this.inherited(t)[f.k]) || "inherit"} .value=${s(rawVal)} ?disabled=${!this.canEdit}
          @change=${(e: Event) => this.edit(t, { [f.k]: (e.target as HTMLInputElement).value.trim() })} />`;
    }
    const hint =
      (kind.type === "num" || kind.type === "int") && isSet(val) ? (f.fmt ? f.fmt(Number(val)) : String(val)) : kind.type === "num" || kind.type === "int" ? "provider default" : "";
    return html`<div class="adv-field" data-adv-field=${f.k}>
      <div class="lab"><span class="cap">${f.label}</span>${hint ? html`<span class="h">${hint}</span>` : nothing}</div>
      ${control}
      ${f.hint ? html`<div class="helper" style="margin-top:4px;">${f.hint}</div>` : nothing}
      ${this.renderMarker(t, [f.k])}
    </div>`;
  }

  // ── agent scope (Robovoice CharacterPipeline) ────────────────────────────
  private renderAgentPipeline(c: ViewCharacter) {
    const v = this.view!;
    const t = charTarget(c.id);
    const eff = v.effective.characters[c.id] ?? null;
    const globalStt = s(this.view!.inherited.defaults.stt_provider) || s(v.org.stt_provider);
    const globalLlm = s(this.view!.inherited.defaults.llm_provider) || s(v.org.llm_provider);
    const locSettings: Fields = { ...v.org, ...Object.fromEntries(Object.entries(v.defaults ?? {}).filter(([, x]) => isSet(x))) };
    const globalModel = (stage: "stt" | "llm", provider: string) => s(locSettings[v.modelKeys[stage][provider] ?? ""]);
    const agentId = v.agentByCharacter[c.id] ?? c.infinibot_agent_id ?? null;
    const f = (k: string) => this.shown(t, k);
    /** The agent's own value at this location (override, else its org-level value) — "" = inherits the global stage. */
    const own = (k: string) => s(isSet(this.raw(t, k)) ? this.raw(t, k) : c.own[k]);
    const ttsProvider = s(f("tts_provider"));
    const row = (stage: StageKey, overridden: boolean, body: TemplateResult) => html`<div class="agent-row" data-agent-row=${stage}>
      <div class="chip"><span class="s" style="background:${TONE[stage]}1f;color:${TONE[stage]}">${STAGES.find((x) => x.key === stage)!.short}</span>
        ${overridden ? html`<span class="pill primary">set</span>` : nothing}</div>
      <div class="fields">${body}</div>
    </div>`;
    const stageRow = (stage: "stt" | "llm", inherit: string) => {
      const pk = `${stage}_provider`;
      const mk = `${stage}_model`;
      const provider = eff?.[stage].provider ?? s(f(pk));
      let providers = v.providers[stage] ?? [];
      if (stage === "llm") providers = providers.filter((p) => p.id !== "infinibot" || agentId || s(this.raw(t, pk)) === "infinibot");
      const opts = v.options?.[stage]?.[provider] ?? [];
      const isIb = stage === "llm" && provider === "infinibot";
      return row(
        stage,
        Boolean(own(pk) || own(mk)),
        html`<div>
            ${this.renderProviderSelect(
              t,
              stage,
              providers,
              pk,
              { inheritLabel: `Inherit global — ${inherit || "default"}`, value: own(pk) },
              (id) => this.edit(t, { [pk]: id, [mk]: id === "infinibot" && agentId ? `infinibot:${agentId}` : "" }),
            )}
            ${this.renderMarker(t, [pk])}
            ${isIb ? html`<div class="ib" data-testid="rv-llm-infinibot">● Answers via InfiniBot${agentId ? html` · agent <b>${agentId}</b>` : ""}</div>` : nothing}
          </div>
          <div>
            ${this.renderCombo(t, mk, opts, {
              providerLabel: provider,
              placeholder: "Select a model…",
              note: (m) => this.optionPrice(stage, provider, m),
              inheritLabel: `Inherit — ${globalModel(stage, provider) || "default"}`,
              value: own(mk),
            })}
            ${this.renderMarker(t, [mk])}
          </div>`,
      );
    };
    const voiceKey = `tts_voice_${ttsProvider}`;
    const el = s(f("elevenlabs_model_id")) || s(locSettings.elevenlabs_model_id) || "eleven_v3";
    const autoOn =
      ttsProvider === "qwen" ||
      (ttsProvider === "elevenlabs" && (el.startsWith("eleven_v3") || el.startsWith("eleven_multilingual") || el.startsWith("eleven_flash") || el === "eleven_turbo_v2_5"));
    const seamlessFlag = this.raw(t, "seamless_multilingual");
    const seamlessOn = isSet(seamlessFlag) ? seamlessFlag === true : isSet(c.own.seamless_multilingual) ? c.own.seamless_multilingual === true : autoOn;
    const exprFlag = isSet(this.raw(t, "expressive_mode")) ? this.raw(t, "expressive_mode") : c.own.expressive_mode;
    const exprDefault = locSettings.expressive_mode === true;
    const exprOn = isSet(exprFlag) ? exprFlag === true : exprDefault;
    const fe = (x: StageValue | undefined, fallback: string) => `${x?.provider || "—"}/${x?.model || fallback}`;
    return html`<div class="agent-box" data-testid="rv-agent-pipeline">
      <div class="title">
        <h3>Pipeline</h3>
        <p class="help t2">Override the STT / LLM stage for this agent. Leave a row on “inherit” to follow the global pipeline.</p>
      </div>
      <div class="agent-rows">
        ${stageRow("stt", globalStt)}
        ${stageRow("llm", globalLlm)}
        ${row(
          "tts",
          true,
          html`<div>
              ${this.renderProviderSelect(t, "tts", v.providers.tts ?? [], "tts_provider", {}, (id) => this.edit(t, { tts_provider: id }))}
              ${this.renderMarker(t, ["tts_provider"])}
            </div>
            <div>${this.renderVoiceControl(t, ttsProvider, s(f(voiceKey)), true)}</div>`,
        )}
      </div>
      <p class="effective" data-testid="rv-effective">Effective now — STT <code>${fe(eff?.stt, "—")}</code> · LLM <code>${fe(eff?.llm, "—")}</code> · TTS <code>${fe(eff?.tts, "—")}</code></p>
      <label class="check">
        <input type="checkbox" .checked=${seamlessOn} ?disabled=${!this.canEdit} @change=${(e: Event) => this.edit(t, { seamless_multilingual: (e.target as HTMLInputElement).checked })} />
        <span>Seamless multilingual${!isSet(seamlessFlag) && !isSet(c.own.seamless_multilingual) ? html`<span class="m"> (auto: ${autoOn ? "on" : "off"})</span>` : nothing}<span class="m"> — one voice, auto language switching, lowest latency</span></span>
      </label>
      ${this.renderMarker(t, ["seamless_multilingual"])}
      <label class="check">
        <input type="checkbox" .checked=${exprOn} ?disabled=${!this.canEdit} @change=${(e: Event) => this.edit(t, { expressive_mode: (e.target as HTMLInputElement).checked })} />
        <span>Expressive (laughter &amp; emotion)${!isSet(exprFlag) ? html`<span class="m"> (default: ${exprDefault ? "on" : "off"})</span>` : nothing}</span>
      </label>
      ${this.renderMarker(t, ["expressive_mode"])}
      <p class="small">Lets the voice actually laugh, sigh, whisper and warm up. Uses <span class="fg80">ElevenLabs v3</span> (slightly higher latency) and only fully applies to v3-capable engines.${exprOn && ttsProvider === "elevenlabs"
        ? html`<span class="fg70"> This agent will switch to eleven_v3.</span>`
        : exprOn && ttsProvider === "qwen"
          ? html`<span class="fg70"> Qwen gets an emotional tone hint (no per-tag control).</span>`
          : exprOn
            ? html`<span class="amber"> This engine can't render emotion — delivery stays neutral (tags are stripped).</span>`
            : nothing}</p>
      <div class="lang-box">
        <div class="head"><span>Language voices (per-agent)</span></div>
        <p>Map a detected reply language to one of THIS agent's own voices. A non-empty map overrides the global default; leave it empty to inherit the <span class="fg80">default language map</span> from the Pipeline tab.${autoOn
          ? html` <span class="fg80">This engine is inherently multilingual — prefer the “Seamless multilingual” toggle above (one streaming voice for every language, no per-language swapping) over listing voices here.</span>`
          : nothing}</p>
        ${this.renderOrgLevel("Per-agent language maps are edited in Robovoice's Agents editor.")}
      </div>
    </div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "rv-pipeline-editor": RvPipelineEditor;
  }
}
