/**
 * SaaS new-member quickstart.
 *
 * Shown full-screen (instead of the app shell) to a signed-in SaaS member whose
 * workspace hasn't finished onboarding — see saas-onboarding-gate.ts. Cloud
 * only, bring-your-own-key: the member names their assistant, pastes at least
 * one of their own provider keys (validated server-side against the provider),
 * optionally picks a cloud voice, and finishes. Everything is stored in the
 * member's own workspace namespace via the saas.onboarding.* RPCs.
 *
 * Visual language: "unlocking a hidden control terminal" — a glass console on
 * an ambient ground (saas-terminal-ambient.ts), steps as glowing nodes on a
 * rail. Styles are scoped under `.sob-*`; the local setup wizard's `.sw-*`
 * styles are not used or touched. No emoji anywhere: the assistant's mark is a
 * monogram derived from its name (or an abstract sigil until it has one).
 */
import { html, nothing, type TemplateResult } from "lit";
import { keyed } from "lit/directives/keyed.js";
import type { GatewayBrowserClient } from "../gateway";
import { icon } from "../icons";
import { renderTerminalGround, terminalAmbientStyles } from "../saas-terminal-ambient";
import { BRAND_DEFAULT_LOGO } from "./branding-modal";
import "../components/provider-logo.js";
import { g8GlassStyles } from "./glass-g8.js";
import {
  businessDirty,
  initSetup,
  leaveSetupStep,
  renderBusinessStep,
  renderChannelsStep,
  renderIntegrationsStep,
  saveBusinessIfNeeded,
  setupStyles,
  setupSummary,
  type SetupCtx,
  type SetupState,
  type SetupStatus,
} from "./saas-onboarding-setup";
import { leaveImportStep, renderImportStep } from "./saas-onboarding-import";
import {
  ALL_STEPS,
  clearResume,
  isServerlessBackend,
  loadResume,
  resumeStepIndex,
  saveResume,
  serverResume,
  stepsFor,
  type StepDef,
  type StepKey,
} from "./saas-onboarding-steps";

export type OnboardingProvider = {
  id: string;
  label: string;
  keyHint: string;
  signupUrl: string;
  configured: boolean;
  maskedKey: string | null;
  /** `media` providers (Replicate) can't back the assistant on their own. */
  kind?: "chat" | "media";
  /** False when the provider has no key check (the key is stored unverified). */
  verifiable?: boolean;
};

export type OnboardingVoiceProvider = {
  id: string;
  label: string;
  needsOwnKey: boolean;
  /** Model provider whose connected key this voice provider reuses. */
  reusesKeyOf?: string;
  keyHint?: string;
  signupUrl?: string;
  voices: string[];
};

export type OnboardingStatus = SetupStatus & {
  saasMode: boolean;
  tenantScoped?: boolean;
  required: boolean;
  onboarded?: boolean;
  providers?: OnboardingProvider[];
  /** Voice output (TTS). */
  voiceProviders?: OnboardingVoiceProvider[];
  /** Speech recognition (STT); absent on gateways that predate the choice. */
  sttProviders?: OnboardingVoiceProvider[];
  assistant?: { name: string | null; avatar: string | null };
  model?: string | null;
  voice?: { enabled: boolean; provider?: string; voice?: string; stt?: string } | null;
  /** "netlify-functions" when the serverless account surface answers (no private gateway). */
  backend?: string;
  /** Resumable step data kept by the serverless backend. */
  stepData?: Record<string, unknown> | null;
};

export type SaasOnboardingProps = {
  client: GatewayBrowserClient;
  status: OnboardingStatus;
  email?: string | null;
  requestUpdate: () => void;
  onDone: (status: OnboardingStatus) => void;
};

let activeSteps: readonly StepDef[] = ALL_STEPS;

const COUNT_WORDS = ["Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight"];

/** How long the "terminal unlocking" exit plays before the app shell takes over. */
const OPEN_MS = 720;

type SaveState = { busy: boolean; error: string | null; ok: string | null };

type State = {
  step: number;
  name: string;
  providers: OnboardingProvider[];
  selected: string | null;
  keyDraft: string;
  save: SaveState;
  filter: string;
  /** Voice output provider id, or "none". */
  voiceChoice: string;
  voiceId: string;
  /** Key for an own-key voice output provider (ElevenLabs, Cartesia). */
  ttsKey: string;
  /** Speech recognition provider id. */
  sttChoice: string | null;
  sttKey: string;
  finishing: boolean;
  finishError: string | null;
  finished: OnboardingStatus | null;
  opening: boolean;
  /** Channels, integrations/MCP and business steps. */
  setup: SetupState;
  /** Continue is saving the current step before moving on. */
  advancing: boolean;
};

let s: State | null = null;

/** localStorage, or null where it is blocked (private mode, sandboxed frame). */
function resumeStore(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function init(status: OnboardingStatus, member: string | null | undefined): State {
  const providers = status.providers ?? [];
  // A refresh mid-setup resumes at the saved step (this browser first, then
  // what the serverless backend kept), never past what the member may reach.
  const saved = loadResume(resumeStore(), member) ?? serverResume(status);
  const step = resumeStepIndex(stepsFor(status), saved, {
    hasChatProvider: providers.some((p) => p.configured && p.kind !== "media"),
  });
  return {
    step,
    name: status.assistant?.name || saved?.name || "",
    providers,
    selected: providers.find((p) => !p.configured)?.id ?? providers[0]?.id ?? null,
    keyDraft: "",
    save: { busy: false, error: null, ok: null },
    filter: "",
    voiceChoice: "none",
    voiceId: "alloy",
    ttsKey: "",
    sttChoice: null,
    sttKey: "",
    finishing: false,
    finishError: null,
    finished: null,
    opening: false,
    setup: initSetup(status),
    advancing: false,
  };
}

/** Remember where the member is, so a reload (or a dropped connection) resumes here. */
function persistProgress(props: SaasOnboardingProps, st: State, remote = true): void {
  const at = activeSteps[st.step]?.key;
  if (!at || st.finished) return;
  const name = st.name.trim().slice(0, 50);
  saveResume(resumeStore(), props.email, { at, ...(name ? { name } : {}) });
  // Serverless backend only: also keep it with the tenant (another device resumes too).
  if (remote && isServerlessBackend(props.status)) {
    void props.client.request("saas.onboarding.step", { step: "progress", data: { at, name } }).catch(() => undefined);
  }
}

function configuredProviders(st: State): OnboardingProvider[] {
  return st.providers.filter((p) => p.configured);
}

/** A connected provider that can back the assistant (not media-only). */
function hasChatProvider(st: State): boolean {
  return st.providers.some((p) => p.configured && p.kind !== "media");
}

function hasKeyFor(st: State, providerId: string | undefined): boolean {
  return Boolean(providerId) && st.providers.some((p) => p.id === providerId && p.configured);
}

/** Registry labels carry a parenthetical ("xAI (Grok)"): split it into title + sub. */
export function splitProviderLabel(label: string): { title: string; sub: string | null } {
  const m = /^(.*?)\s*\((.+)\)\s*$/.exec(label);
  return m ? { title: m[1], sub: m[2] } : { title: label, sub: null };
}

/** Two-letter, periodic-table style marks. Text only: the registry's emoji icons are never shown. */
const PROVIDER_MARKS: Record<string, string> = {
  anthropic: "An",
  openai: "Oa",
  google: "Gm",
  groq: "Gq",
  together: "Tg",
  deepseek: "Ds",
  mistral: "Mi",
  cohere: "Co",
  perplexity: "Px",
  fireworks: "Fw",
  openrouter: "Or",
  xai: "Xa",
  cerebras: "Cb",
  zai: "Zg",
  llamacloud: "Ll",
  "ollama-cloud": "Ol",
  replicate: "Rp",
};

/** A provider's mark; unknown (newly registered) providers get initial + next consonant. */
export function providerMark(p: { id: string; label: string }): string {
  const known = PROVIDER_MARKS[p.id];
  if (known) return known;
  const chars = [...splitProviderLabel(p.label).title].filter((ch) => /[\p{L}\p{N}]/u.test(ch));
  if (chars.length === 0) return "--";
  const second = chars.slice(1).find((ch) => /[bcdfghjklmnpqrstvwxz]/i.test(ch)) ?? chars[1] ?? "";
  return `${chars[0].toUpperCase()}${second.toLowerCase()}`;
}

/** Speech recognition pick: keep a usable choice, else the first provider the member can use. */
function defaultStt(st: State, stt: OnboardingVoiceProvider[]): string | null {
  const usable = (v: OnboardingVoiceProvider) => !v.reusesKeyOf || hasKeyFor(st, v.reusesKeyOf);
  const current = stt.find((v) => v.id === st.sttChoice);
  if (current && usable(current)) return current.id;
  return stt.find((v) => v.reusesKeyOf && usable(v))?.id ?? stt.find(usable)?.id ?? null;
}

/**
 * The assistant's mark: initials from the name — two for a multi-word name,
 * one otherwise. Letters and digits only, so an emoji in the name never ends
 * up in the mark. Empty when the name has nothing usable.
 */
export function monogramFor(name: string): string {
  const initials = name
    .trim()
    .split(/[\s\-_.]+/)
    .map((word) => [...word].find((ch) => /[\p{L}\p{N}]/u.test(ch)))
    .filter((ch): ch is string => Boolean(ch));
  return initials.slice(0, initials.length >= 2 ? 2 : 1).join("").toUpperCase();
}

async function saveKey(props: SaasOnboardingProps, st: State): Promise<void> {
  const provider = st.selected;
  const apiKey = st.keyDraft.trim();
  if (!provider || !apiKey || st.save.busy) return;
  st.save = { busy: true, error: null, ok: null };
  props.requestUpdate();
  try {
    const res = await props.client.request<{
      ok: boolean;
      error?: string;
      maskedKey?: string;
      modelCount?: number;
      verified?: boolean;
    }>("saas.onboarding.saveKey", { provider, apiKey });
    if (res?.ok) {
      st.providers = st.providers.map((p) =>
        p.id === provider ? { ...p, configured: true, maskedKey: res.maskedKey ?? "••••" } : p,
      );
      st.keyDraft = "";
      st.save = {
        busy: false,
        error: null,
        ok:
          res.verified === false
            ? "stored, not verified (no key check for this provider)"
            : typeof res.modelCount === "number"
              ? `${res.modelCount} models available`
              : "key verified",
      };
    } else {
      st.save = { busy: false, error: res?.error ?? "The provider rejected this key.", ok: null };
    }
  } catch (err) {
    st.save = { busy: false, error: String((err as Error)?.message ?? err), ok: null };
  }
  props.requestUpdate();
}

async function removeKey(props: SaasOnboardingProps, st: State, provider: string): Promise<void> {
  try {
    await props.client.request("saas.onboarding.removeKey", { provider });
    st.providers = st.providers.map((p) =>
      p.id === provider ? { ...p, configured: false, maskedKey: null } : p,
    );
    st.selected = provider;
    st.save = { busy: false, error: null, ok: null };
  } catch (err) {
    st.save = { busy: false, error: String((err as Error)?.message ?? err), ok: null };
  }
  props.requestUpdate();
}

async function finish(props: SaasOnboardingProps, st: State): Promise<void> {
  if (st.finishing) return;
  st.finishing = true;
  st.finishError = null;
  props.requestUpdate();
  const voice =
    st.voiceChoice === "none"
      ? { enabled: false }
      : {
          enabled: true,
          provider: st.voiceChoice,
          voice: st.voiceChoice === "openai" ? st.voiceId : undefined,
          apiKey: st.voiceChoice !== "openai" ? st.ttsKey.trim() || undefined : undefined,
          stt: st.sttChoice ?? undefined,
          sttApiKey: st.sttChoice === "deepgram" ? st.sttKey.trim() || undefined : undefined,
        };
  try {
    const res = await props.client.request<
      { ok: true; status: OnboardingStatus } | { ok: false; error: string }
    >("saas.onboarding.complete", {
      assistantName: st.name.trim() || undefined,
      assistantAvatar: monogramFor(st.name) || undefined,
      voice,
    });
    if (res && res.ok) {
      st.finished = res.status;
      clearResume(resumeStore(), props.email);
      st.ttsKey = "";
      st.sttKey = "";
    } else {
      st.finishError = (res as { error?: string })?.error ?? "Setup could not be completed.";
    }
  } catch (err) {
    st.finishError = String((err as Error)?.message ?? err);
  }
  st.finishing = false;
  props.requestUpdate();
}

/** Play the unlock exit, then hand over to the app shell. */
function openWorkspace(props: SaasOnboardingProps, st: State): void {
  if (!st.finished || st.opening) return;
  st.opening = true;
  props.requestUpdate();
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const done = st.finished;
  window.setTimeout(() => props.onDone(done), reduced ? 0 : OPEN_MS);
}

// ── Pieces ─────────────────────────────────────────────────────────────────

const SIGIL = html`<svg class="sob-sigil__svg" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" aria-hidden="true">
  <path d="M24 4 41.3 14v20L24 44 6.7 34V14z" opacity=".5" />
  <path d="M24 13l9.5 5.5v11L24 35l-9.5-5.5v-11z" />
  <path d="M24 4v9M24 35v9M6.7 14l7.8 4.5M41.3 14l-7.8 4.5M6.7 34l7.8-4.5M41.3 34l-7.8-4.5" opacity=".45" />
  <circle cx="24" cy="24" r="2.6" fill="currentColor" stroke="none" />
</svg>`;

/** Padlock; the open variant's shackle lifts on mount — the key-verified / unlock beat. */
const lockIcon = (open: boolean) => html`<svg class="sob-lock ${open ? "is-open" : ""}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path class="sob-lock__shackle" d=${open ? "M7 11V7a5 5 0 0 1 9.9-1" : "M7 11V7a5 5 0 0 1 10 0v4"} />
  <rect width="18" height="11" x="3" y="11" rx="2" />
</svg>`;

type SigilSize = "sm" | "lg" | "xl";

function renderSigil(name: string, size: SigilSize): TemplateResult {
  const mono = monogramFor(name);
  return html`<span class="sob-sigil sob-sigil--${size} ${mono ? "" : "is-empty"}" aria-hidden="true">
    ${size === "sm" ? nothing : html`<span class="sob-sigil__halo"></span><span class="sob-sigil__orbit"></span>`}
    <span class="sob-sigil__face"
      >${mono ? keyed(mono, html`<span class="sob-sigil__glyph">${mono}</span>`) : SIGIL}</span
    >
  </span>`;
}

function stepHeader(key: StepKey, title: TemplateResult | string, sub: TemplateResult | string): TemplateResult {
  const i = Math.max(0, activeSteps.findIndex((step) => step.key === key));
  return html`
    <div class="sob-eyebrow">
      <span class="sob-eyebrow__code">Step ${String(i + 1).padStart(2, "0")}</span>
      <span class="sob-eyebrow__rule"></span>
      <span>${activeSteps[i]?.label}</span>
    </div>
    <h2 class="sob-title">${title}</h2>
    <p class="sob-sub">${sub}</p>
  `;
}

// ── Steps ──────────────────────────────────────────────────────────────────

function renderWelcome(props: SaasOnboardingProps, st: State): TemplateResult {
  const mono = monogramFor(st.name);
  return html`
    ${stepHeader(
      "identity",
      "Meet your assistant",
      html`This is your own private workspace${props.email
        ? html` for <strong>${props.email}</strong>`
        : nothing}. Give your assistant a name. You can change it later.`,
    )}
    <div class="sob-identity">
      <div class="sob-identity__mark">
        ${renderSigil(st.name, "lg")}
        <div class="sob-identity__caption">
          <span>Mark</span><span class="sob-identity__value">${mono || "Awaiting name"}</span>
        </div>
      </div>
      <div class="sob-identity__fields">
        <label class="sob-field">
          <span class="sob-label">Assistant name</span>
          <input
            class="sob-input sob-input--lg"
            data-testid="so-name"
            maxlength="50"
            placeholder="e.g. Atlas"
            autocomplete="off"
            .value=${st.name}
            @input=${(e: Event) => {
              st.name = (e.target as HTMLInputElement).value;
              persistProgress(props, st, false);
              props.requestUpdate();
            }}
          />
        </label>
        <p class="sob-hint">
          Its mark is drawn from the name's initials. A custom image can be set later in Settings.
        </p>
      </div>
    </div>
  `;
}

function selectProvider(props: SaasOnboardingProps, st: State, id: string): void {
  st.selected = id;
  st.keyDraft = "";
  st.save = { busy: false, error: null, ok: null };
  props.requestUpdate();
}

function renderProviderTile(
  props: SaasOnboardingProps,
  st: State,
  p: OnboardingProvider,
  index: number,
): TemplateResult {
  const { title, sub } = splitProviderLabel(p.label);
  const detail = sub ?? (p.kind === "media" ? "Image and video" : "Model API");
  return html`<button
    type="button"
    role="radio"
    aria-checked=${st.selected === p.id}
    aria-label=${`${p.label}, ${p.configured ? "connected" : "not connected"}`}
    title=${p.label}
    data-testid=${`so-provider-${p.id}`}
    class="sob-prov ${st.selected === p.id ? "is-selected" : ""} ${p.configured ? "is-linked" : ""}"
    @click=${() => selectProvider(props, st, p.id)}
  >
    <ib-provider-logo class="sob-prov__logo" provider=${p.id} letters=${providerMark(p)} size="40"></ib-provider-logo
    >
    <span class="sob-prov__text">
      <span class="sob-prov__name">${title}</span>
      <span class="sob-prov__status">
        ${p.configured
          ? html`Connected<span class="sob-prov__mask">${p.maskedKey ?? ""}</span>`
          : detail}
      </span>
    </span>
    <span class="sob-led ${p.configured ? "is-on" : ""}"></span>
  </button>`;
}

function renderKeys(props: SaasOnboardingProps, st: State): TemplateResult {
  const sel = st.providers.find((p) => p.id === st.selected) ?? null;
  const query = st.filter.trim().toLowerCase();
  const indexed = st.providers.map((p, i) => ({ p, i }));
  const shown = query
    ? indexed.filter(({ p }) => `${p.label} ${p.id}`.toLowerCase().includes(query))
    : indexed;
  const linked = configuredProviders(st).length;
  const selTitle = sel ? splitProviderLabel(sel.label).title : "";
  return html`
    ${stepHeader(
      "keys",
      "Connect a model provider",
      html`InfiniBot runs on <strong>your own</strong> cloud API key. Paste at least one. We check it
        with the provider before saving. Keys are stored only in your workspace and are used only
        for your requests.`,
    )}
    <div class="sob-provbar">
      <span class="sob-provbar__count" data-testid="so-prov-count"
        ><span class="sob-provbar__num">${st.providers.length}</span> providers<span class="sob-dot"></span
        ><span class="sob-provbar__num ${linked ? "is-on" : ""}">${linked}</span> linked</span
      >
      <label class="sob-filter">
        <span class="sob-filter__icon">${icon("search")}</span>
        <input
          class="sob-filter__input"
          data-testid="so-prov-filter"
          type="search"
          placeholder="Filter providers"
          autocomplete="off"
          spellcheck="false"
          aria-label="Filter providers"
          .value=${st.filter}
          @input=${(e: Event) => {
            st.filter = (e.target as HTMLInputElement).value;
            props.requestUpdate();
          }}
          @keydown=${(e: KeyboardEvent) => {
            if (e.key === "Enter" && shown.length > 0) selectProvider(props, st, shown[0].p.id);
            if (e.key === "Escape" && st.filter) {
              st.filter = "";
              props.requestUpdate();
            }
          }}
        />
      </label>
    </div>
    <div class="sob-provscroll">
      <div class="sob-providers" role="radiogroup" aria-label="Model provider">
        ${shown.map(({ p, i }) => renderProviderTile(props, st, p, i))}
      </div>
      ${shown.length === 0
        ? html`<div class="sob-provempty">No provider matches <code>${st.filter.trim()}</code>.</div>`
        : nothing}
    </div>
    ${sel
      ? sel.configured
        ? html`<div class="sob-unlock" data-testid="so-key-ok">
            <span class="sob-unlock__icon">${lockIcon(true)}</span>
            <span class="sob-unlock__text">
              <span class="sob-unlock__title"><strong>${sel.label}</strong> is connected</span>
              <span class="sob-unlock__meta"
                >${sel.maskedKey}${st.save.ok ? html`<span class="sob-dot"></span>${st.save.ok}` : nothing}</span
              >
            </span>
            <button type="button" class="sob-link" @click=${() => void removeKey(props, st, sel.id)}>
              Replace key
            </button>
          </div>`
        : html`<div class="sob-field sob-field--key">
            <label class="sob-label" for="sob-key">${selTitle} API key</label>
            <div class="sob-keyrow">
              <div class="sob-input-wrap ${st.save.busy ? "is-scanning" : ""}">
                <span class="sob-input-wrap__icon">${icon("key")}</span>
                <input
                  id="sob-key"
                  class="sob-input sob-input--mono"
                  type="password"
                  autocomplete="off"
                  spellcheck="false"
                  data-testid="so-key"
                  placeholder=${sel.keyHint}
                  .value=${st.keyDraft}
                  @input=${(e: Event) => {
                    st.keyDraft = (e.target as HTMLInputElement).value;
                    props.requestUpdate();
                  }}
                  @keydown=${(e: KeyboardEvent) => {
                    if (e.key === "Enter") void saveKey(props, st);
                  }}
                />
                <span class="sob-input-wrap__scan"></span>
              </div>
              <button
                type="button"
                class="sob-btn sob-btn--primary"
                data-testid="so-save-key"
                aria-busy=${st.save.busy ? "true" : "false"}
                ?disabled=${!st.keyDraft.trim() || st.save.busy}
                @click=${() => void saveKey(props, st)}
              >
                ${st.save.busy ? html`<span class="sob-spinner"></span>Checking…` : html`${lockIcon(false)}Verify &amp; save`}
              </button>
            </div>
            ${sel.signupUrl
              ? html`<span class="sob-hint">
                  ${sel.kind === "media"
                    ? "Replicate powers image and video tools. Connect a chat model provider too. "
                    : "Don't have one? "}
                  <a href=${sel.signupUrl} target="_blank" rel="noopener noreferrer">Create a key at ${selTitle}</a>.
                </span>`
              : nothing}
          </div>`
      : nothing}
    ${st.save.error
      ? html`<div class="sob-alert" role="alert" data-testid="so-key-error">
          ${icon("alertCircle")}<span>${st.save.error}</span>
        </div>`
      : nothing}
  `;
}

/** Fallbacks for gateways whose status predates these fields. */
const FALLBACK_TTS: OnboardingVoiceProvider[] = [
  { id: "openai", label: "OpenAI voice", needsOwnKey: false, reusesKeyOf: "openai", voices: ["alloy"] },
  { id: "elevenlabs", label: "ElevenLabs", needsOwnKey: true, keyHint: "xi-…", voices: [] },
];

const VOICE_COPY: Record<string, { glyph: () => TemplateResult; desc: string }> = {
  openai: { glyph: () => icon("volumeUp"), desc: "Natural voices on your OpenAI key." },
  elevenlabs: { glyph: () => icon("voiceover"), desc: "Premium, expressive voices. Your own key." },
  cartesia: { glyph: () => icon("activity"), desc: "Sonic: ultra-low-latency speech. Your own key." },
};

/** "an OpenAI", "a Groq". */
function withArticle(name: string): string {
  return `${/^[aeiou]/i.test(name) ? "an" : "a"} ${name}`;
}

function keyInput(
  label: string,
  placeholder: string,
  value: string,
  onInput: (v: string) => void,
  hint: TemplateResult | string,
  testid: string,
): TemplateResult {
  return html`<label class="sob-field sob-field--reveal">
    <span class="sob-label">${label}</span>
    <div class="sob-input-wrap">
      <span class="sob-input-wrap__icon">${icon("key")}</span>
      <input
        class="sob-input sob-input--mono"
        type="password"
        autocomplete="off"
        spellcheck="false"
        data-testid=${testid}
        placeholder=${placeholder}
        .value=${value}
        @input=${(e: Event) => onInput((e.target as HTMLInputElement).value)}
      />
    </div>
    <span class="sob-hint">${hint}</span>
  </label>`;
}

function renderVoice(props: SaasOnboardingProps, st: State): TemplateResult {
  const tts = props.status.voiceProviders?.length ? props.status.voiceProviders : FALLBACK_TTS;
  const stt = props.status.sttProviders ?? [];
  const selTts = tts.find((v) => v.id === st.voiceChoice) ?? null;
  const labelOf = (id: string) =>
    splitProviderLabel(st.providers.find((p) => p.id === id)?.label ?? id).title;
  const opt = (
    id: string,
    glyph: TemplateResult,
    title: string,
    desc: string,
    disabled = false,
  ) => html`<button
    type="button"
    role="radio"
    aria-checked=${st.voiceChoice === id}
    data-testid=${`so-voice-${id}`}
    class="sob-opt ${st.voiceChoice === id ? "is-selected" : ""}"
    ?disabled=${disabled}
    @click=${() => {
      if (disabled) return;
      st.voiceChoice = id;
      if (id !== "none") st.sttChoice = defaultStt(st, stt);
      props.requestUpdate();
    }}
  >
    <span class="sob-opt__icon">${disabled ? lockIcon(false) : glyph}</span>
    <span class="sob-opt__title">${title}</span>
    <span class="sob-opt__desc">${desc}</span>
    <span class="sob-opt__radio"></span>
  </button>`;
  const selStt = stt.find((v) => v.id === st.sttChoice) ?? null;
  return html`
    ${stepHeader(
      "voice",
      html`Voice <span class="sob-tag">Optional</span>`,
      "Talk to your assistant with a cloud voice. You can skip this and turn it on later.",
    )}
    <div class="sob-options" role="radiogroup" aria-label="Voice output">
      ${opt("none", icon("volumeMute"), "Skip for now", "Text only. Enable voice any time in Settings.")}
      ${tts.map((v) => {
        const locked = Boolean(v.reusesKeyOf) && !hasKeyFor(st, v.reusesKeyOf);
        const copy = VOICE_COPY[v.id];
        const desc = locked
          ? `Connect ${withArticle(labelOf(v.reusesKeyOf!))} key in step 2 first.`
          : v.reusesKeyOf
            ? `Uses the ${labelOf(v.reusesKeyOf)} key you connected.`
            : (copy?.desc ?? "Your own key.");
        return opt(v.id, copy?.glyph() ?? icon("volumeUp"), v.label, desc, locked);
      })}
    </div>
    ${selTts?.id === "openai"
      ? html`<label class="sob-field sob-field--reveal">
          <span class="sob-label">Voice</span>
          <select
            class="sob-input sob-select"
            .value=${st.voiceId}
            @change=${(e: Event) => {
              st.voiceId = (e.target as HTMLSelectElement).value;
              props.requestUpdate();
            }}
          >
            ${selTts.voices.map((v) => html`<option value=${v} ?selected=${st.voiceId === v}>${v}</option>`)}
          </select>
        </label>`
      : nothing}
    ${selTts && stt.length
      ? html`<div class="sob-field sob-field--reveal">
            <span class="sob-label" id="sob-stt-label">Speech recognition</span>
            <div class="sob-seg" role="radiogroup" aria-labelledby="sob-stt-label">
              ${stt.map((v) => {
                const locked = Boolean(v.reusesKeyOf) && !hasKeyFor(st, v.reusesKeyOf);
                return html`<button
                  type="button"
                  role="radio"
                  aria-checked=${st.sttChoice === v.id}
                  data-testid=${`so-stt-${v.id}`}
                  class="sob-seg__opt ${st.sttChoice === v.id ? "is-selected" : ""}"
                  title=${locked ? `Connect ${withArticle(labelOf(v.reusesKeyOf!))} key in step 2 first.` : v.label}
                  ?disabled=${locked}
                  @click=${() => {
                    st.sttChoice = v.id;
                    props.requestUpdate();
                  }}
                >
                  ${locked ? lockIcon(false) : html`<span class="sob-seg__dot"></span>`}${v.label}
                </button>`;
              })}
            </div>
            <span class="sob-hint">
              ${selStt?.reusesKeyOf
                ? `Transcribes what you say using your ${labelOf(selStt.reusesKeyOf)} key.`
                : selStt
                  ? `Streaming transcription with your own ${selStt.label} key.`
                  : "Connect OpenAI or Groq in step 2, or use Deepgram with your own key."}
            </span>
          </div>
`
      : nothing}
    ${selTts?.needsOwnKey || selStt?.needsOwnKey
      ? html`<div class="sob-keypair">
          ${selTts?.needsOwnKey
            ? keyInput(
                `${selTts.label} API key`,
                selTts.keyHint ?? "API key",
                st.ttsKey,
                (v) => {
                  st.ttsKey = v;
                  props.requestUpdate();
                },
                `Checked with ${selTts.label} when you finish.`,
                "so-voice-key",
              )
            : nothing}
          ${selStt?.needsOwnKey
            ? keyInput(
                `${selStt.label} API key`,
                selStt.keyHint ?? "API key",
                st.sttKey,
                (v) => {
                  st.sttKey = v;
                  props.requestUpdate();
                },
                `Checked with ${selStt.label} when you finish.`,
                "so-stt-key",
              )
            : nothing}
        </div>`
      : nothing}
  `;
}

/** Voice step is complete: every chosen provider has a usable key. */
function voiceReady(props: SaasOnboardingProps, st: State): boolean {
  if (st.voiceChoice === "none") return true;
  const tts = (props.status.voiceProviders?.length ? props.status.voiceProviders : FALLBACK_TTS).find(
    (v) => v.id === st.voiceChoice,
  );
  if (!tts) return false;
  if (tts.needsOwnKey && !st.ttsKey.trim()) return false;
  const stt = props.status.sttProviders;
  if (!stt?.length) return true;
  const pick = stt.find((v) => v.id === st.sttChoice);
  if (!pick) return false;
  if (pick.reusesKeyOf) return hasKeyFor(st, pick.reusesKeyOf);
  return !pick.needsOwnKey || Boolean(st.sttKey.trim());
}

function renderFinish(props: SaasOnboardingProps, st: State): TemplateResult {
  if (st.finished) {
    const name = st.finished.assistant?.name || "Your assistant";
    return html`
      <div class="sob-done" data-testid="so-done">
        <div class="sob-done__emblem">
          <span class="sob-done__wave"></span>
          <span class="sob-done__wave sob-done__wave--late"></span>
          ${renderSigil(st.finished.assistant?.name ?? "", "xl")}
        </div>
        <div class="sob-eyebrow sob-eyebrow--center">
          <span class="sob-eyebrow__rule"></span><span>Access granted</span><span class="sob-eyebrow__rule"></span>
        </div>
        <h2 class="sob-title sob-title--hero">${name} is ready</h2>
        <div class="sob-done__model">
          <span>Default model</span><code title=${st.finished.model ?? ""}>${st.finished.model ?? "—"}</code>
        </div>
        <p class="sob-sub">Your keys and settings live only in your workspace.</p>
        <button
          type="button"
          class="sob-btn sob-btn--primary sob-btn--xl"
          data-testid="so-enter"
          ?disabled=${st.opening}
          @click=${() => openWorkspace(props, st)}
        >
          ${lockIcon(true)}${isServerlessBackend(props.status) ? "Continue" : "Open InfiniBot"}
        </button>
      </div>
    `;
  }
  const connected = configuredProviders(st);
  const ttsLabel = props.status.voiceProviders?.find((v) => v.id === st.voiceChoice)?.label ?? st.voiceChoice;
  const sttLabel = props.status.sttProviders?.find((v) => v.id === st.sttChoice)?.label;
  const voiceLabel =
    st.voiceChoice === "none"
      ? "Off"
      : [ttsLabel, st.voiceChoice === "openai" ? st.voiceId : null, sttLabel].filter(Boolean).join(" · ");
  const row = (label: string, value: TemplateResult | string) =>
    html`<div class="sob-manifest__row"><dt>${label}</dt><span class="sob-manifest__lead"></span><dd>${value}</dd></div>`;
  return html`
    ${stepHeader(
      "finish",
      "Review & finish",
      "We'll pick a default model from the providers you connected. You can change it any time.",
    )}
    <dl class="sob-manifest">
      ${row(
        "Assistant",
        html`<span class="sob-manifest__who">${renderSigil(st.name, "sm")}${st.name.trim() || "Assistant"}</span>`,
      )}
      ${row("Providers", connected.map((p) => splitProviderLabel(p.label).title).join(", ") || "—")}
      ${setupSummary(st.setup, props.status).map((r) => row(r.label, r.value))}
      ${row("Voice", voiceLabel)}
      ${row("Local models", "Not available in the cloud")}
    </dl>
    ${st.finishError
      ? html`<div class="sob-alert" role="alert" data-testid="so-finish-error">
          ${icon("alertCircle")}<span>${st.finishError}</span>
        </div>`
      : nothing}
  `;
}

// ── Shell ──────────────────────────────────────────────────────────────────

function setupCtx(props: SaasOnboardingProps, st: State, key: StepKey): SetupCtx {
  return {
    client: props.client,
    status: props.status,
    requestUpdate: props.requestUpdate,
    header: (title, sub) => stepHeader(key, title, sub),
    lockIcon,
    st: st.setup,
  };
}

const HOSTED_ONLY: Record<"channels" | "connect" | "import", { title: string; sub: string; items: string[] }> = {
  import: {
    title: "Import your notes",
    sub: "Bring your Obsidian vault or Notion workspace into Documents, with links, tags and attachments. Imports run on your private cloud machine, so they come with a hosted plan.",
    items: ["Obsidian vault (.zip)", "Notion export (.zip)", "Notion integration", "Undo any import"],
  },
  channels: {
    title: "Channels",
    sub: "Chat with your assistant from Telegram, Discord, Slack or WhatsApp. Channels run on your private cloud machine, so they come with a hosted plan.",
    items: ["Telegram", "Discord", "Slack", "WhatsApp"],
  },
  connect: {
    title: "Integrations & MCP",
    sub: "Connect Notion, GitHub, Gmail, Calendar and MCP tools. They run on your private cloud machine, so they come with a hosted plan.",
    items: ["Notion", "GitHub", "Gmail & Calendar", "MCP servers"],
  },
};

/** A step this plan can't run (no private gateway): say so plainly; Continue stays enabled. */
function renderHostedOnlyStep(key: "channels" | "connect" | "import"): TemplateResult {
  const copy = HOSTED_ONLY[key];
  return html`
    ${stepHeader(key, html`${copy.title} <span class="sob-tag">Hosted plans</span>`, copy.sub)}
    <div class="sob-hosted" data-testid="so-hosted-only">
      <div class="sob-hosted__head">${lockIcon(false)}<span>Available on hosted plans</span></div>
      <ul class="sob-hosted__list">
        ${copy.items.map((item) => html`<li><span class="sob-led"></span>${item}</li>`)}
      </ul>
      <p class="sob-hint">
        Nothing to do here on your current plan. Continue with setup: this step opens up when you
        move to a hosted plan.
        <a class="sob-link" href="/pricing/" target="_blank" rel="noopener">See hosted plans</a>
      </p>
    </div>
  `;
}

const isLocked = (key: StepKey) => Boolean(activeSteps.find((step) => step.key === key)?.locked);

const STEP_RENDERERS: Record<StepKey, (props: SaasOnboardingProps, st: State) => TemplateResult> = {
  identity: renderWelcome,
  keys: renderKeys,
  channels: (props, st) =>
    isLocked("channels") ? renderHostedOnlyStep("channels") : renderChannelsStep(setupCtx(props, st, "channels")),
  connect: (props, st) =>
    isLocked("connect") ? renderHostedOnlyStep("connect") : renderIntegrationsStep(setupCtx(props, st, "connect")),
  business: (props, st) => renderBusinessStep(setupCtx(props, st, "business")),
  import: (props, st) =>
    isLocked("import")
      ? renderHostedOnlyStep("import")
      : renderImportStep({
          client: props.client,
          requestUpdate: props.requestUpdate,
          header: (title, sub) => stepHeader("import", title, sub),
        }),
  voice: renderVoice,
  finish: renderFinish,
};

export function renderSaasOnboarding(props: SaasOnboardingProps): TemplateResult {
  const steps = stepsFor(props.status);
  activeSteps = steps;
  if (!s) s = init(props.status, props.email);
  const st = s;
  st.step = Math.min(st.step, steps.length - 1);
  const key = steps[st.step].key;
  const savingBusiness = st.setup.bizSave.busy || st.advancing;
  const canNext =
    key === "keys"
      ? hasChatProvider(st)
      : key === "voice"
        ? voiceReady(props, st)
        : key === "business"
          ? !savingBusiness
          : true;
  const go = async (n: number) => {
    const next = Math.max(0, Math.min(steps.length - 1, n));
    if (next === st.step || st.advancing) return;
    if (key === "business" && next > st.step) {
      // The business is saved on the way out, so it persists even if setup stops here.
      st.advancing = true;
      const saved = await saveBusinessIfNeeded(setupCtx(props, st, "business"));
      st.advancing = false;
      if (!saved) {
        props.requestUpdate();
        return;
      }
    }
    if ((key === "channels" || key === "connect") && !isLocked(key)) leaveSetupStep(st.setup);
    if (key === "import") leaveImportStep();
    st.step = next;
    persistProgress(props, st);
    props.requestUpdate();
  };
  const body = STEP_RENDERERS[key](props, st);
  const progress = st.finished ? 1 : st.step / (steps.length - 1);
  const counter = `${String(st.step + 1).padStart(2, "0")} / ${String(steps.length).padStart(2, "0")}`;
  const long = steps.length > 4;
  const bizDirty = key === "business" && businessDirty(st.setup);
  const note =
    key === "keys" && !hasChatProvider(st)
      ? configuredProviders(st).length > 0
        ? "Replicate covers media. Connect a chat model provider to continue."
        : "Connect at least one provider to continue."
      : key === "voice" && !canNext
        ? "Add the voice keys to continue, or skip voice."
        : key === "business" && !st.setup.biz.name.trim()
          ? "No business name yet. Continue to skip this step."
          : null;
  const current = steps[st.step];
  return html`
    ${terminalAmbientStyles()} ${onboardingStyles()} ${setupStyles()}
    ${g8GlassStyles}
    <div class="sob-screen g8-page ${st.opening ? "is-opening" : ""} ${long ? "is-long" : ""}" data-testid="saas-onboarding">
      ${renderTerminalGround()}
      <main class="sob-stage">
        <header class="sob-hero">
          <div class="sob-hero__eyebrow"><span class="sob-led is-on"></span>Workspace setup</div>
          <h1 class="sob-hero__title">Welcome to InfiniBot</h1>
          <p class="sob-hero__sub">
            ${long
              ? `${COUNT_WORDS[steps.length] ?? steps.length} short steps. Only your name and one model key are required.`
              : `${COUNT_WORDS[steps.length] ?? steps.length} quick steps and your private AI workspace is live.`}
          </p>
        </header>

        <div class="sob-console" style="--sob-progress:${progress};--sob-steps:${steps.length}">
          <span class="sob-corner sob-corner--tl"></span><span class="sob-corner sob-corner--tr"></span>
          <span class="sob-corner sob-corner--bl"></span><span class="sob-corner sob-corner--br"></span>
          <span class="sob-console__trace"></span>
          <span class="sob-console__doors" aria-hidden="true"
            ><span class="sob-door sob-door--top"></span><span class="sob-door sob-door--bottom"></span
          ></span>

          <div class="sob-console__inner">
            <div class="sob-bar">
              <div class="sob-bar__brand">
                <img src=${BRAND_DEFAULT_LOGO} alt="" />
                <span class="sob-bar__name">InfiniBot</span>
                <span class="sob-bar__path">/ workspace-init</span>
              </div>
              <div class="sob-bar__status">
                <span class="sob-bar__link"><span class="sob-led is-on"></span>Link active</span>
                <span class="sob-bar__count">${st.finished ? "Unlocked" : counter}</span>
              </div>
            </div>

            <div class="sob-body">
              <nav class="sob-rail ${long ? "is-long" : ""}" aria-label="Setup progress">
                <span class="sob-rail__track"><span class="sob-rail__fill"></span></span>
                ${steps.map((step, i) => {
                  const reachable = i <= st.step || (i === st.step + 1 && canNext);
                  const done = i < st.step || Boolean(st.finished);
                  const active = i === st.step && !st.finished;
                  return html`<button
                    type="button"
                    class="sob-node ${active ? "is-active" : ""} ${done ? "is-done" : ""}"
                    aria-current=${active ? "step" : "false"}
                    aria-label=${`Step ${i + 1}: ${step.label}`}
                    ?disabled=${!reachable || Boolean(st.finished)}
                    @click=${() => void go(i)}
                  >
                    <span class="sob-node__dot">
                      ${done ? icon("check") : html`<span class="sob-node__num">${i + 1}</span>`}
                    </span>
                    <span class="sob-node__text">
                      <span class="sob-node__code">${String(i + 1).padStart(2, "0")}</span>
                      <span class="sob-node__label">${step.label}</span>
                      <span class="sob-node__hint">${step.hint}</span>
                    </span>
                  </button>`;
                })}
              </nav>
              ${long && !st.finished
                ? html`<div class="sob-rail__now" aria-hidden="true">
                    <span class="sob-rail__now-code">${String(st.step + 1).padStart(2, "0")}</span>${current.label}<span
                      class="sob-dot"
                    ></span
                    ><span class="sob-rail__now-hint">${current.hint}</span>
                  </div>`
                : nothing}

              <section class="sob-panel">
                ${keyed(st.finished ? "done" : st.step, html`<div class="sob-panel__step">${body}</div>`)}
              </section>
            </div>

            ${st.finished
              ? nothing
              : html`<footer class="sob-foot">
                  <button
                    type="button"
                    class="sob-btn sob-btn--ghost"
                    ?disabled=${st.step === 0 || st.advancing}
                    @click=${() => void go(st.step - 1)}
                  >
                    ${icon("arrowLeft")}Back
                  </button>
                  <span class="sob-foot__spacer"></span>
                  ${note ? html`<span class="sob-foot__note"><span class="sob-led"></span>${note}</span>` : nothing}
                  ${st.step < steps.length - 1
                    ? html`<button
                        type="button"
                        class="sob-btn sob-btn--primary"
                        data-testid="so-next"
                        aria-busy=${savingBusiness ? "true" : "false"}
                        ?disabled=${!canNext}
                        @click=${() => void go(st.step + 1)}
                      >
                        ${savingBusiness
                          ? html`<span class="sob-spinner"></span>Saving…`
                          : html`${bizDirty ? "Save & continue" : "Continue"}${icon("arrowRight")}`}
                      </button>`
                    : html`<button
                        type="button"
                        class="sob-btn sob-btn--primary"
                        data-testid="so-finish"
                        aria-busy=${st.finishing ? "true" : "false"}
                        ?disabled=${st.finishing || !hasChatProvider(st)}
                        @click=${() => void finish(props, st)}
                      >
                        ${st.finishing
                          ? html`<span class="sob-spinner"></span>Finishing…`
                          : html`${lockIcon(false)}Finish setup`}
                      </button>`}
                </footer>`}
          </div>
        </div>
      </main>
      ${st.opening ? html`<div class="sob-flash" aria-hidden="true"></div>` : nothing}
    </div>
  `;
}

/** Drop the module state (e.g. after completion or a different tenant connects). */
export function resetSaasOnboarding(): void {
  s = null;
}

export function onboardingStyles(): TemplateResult {
  return html`<style>
    /* ── Stage + hero ─────────────────────────────────────── */
    .sob-stage {
      position: relative; z-index: 1;
      min-height: 100%;
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      gap: clamp(20px, 3.4vh, 34px);
      padding: clamp(28px, 6vh, 72px) 24px;
    }
    .sob-hero { text-align: center; max-width: 720px; animation: sob-rise 0.9s 0.1s var(--sob-ease) both; }
    .sob-hero__eyebrow {
      display: inline-flex; align-items: center; gap: 10px;
      font-family: var(--sob-mono); font-size: 11px; font-weight: 500;
      letter-spacing: 0.32em; text-transform: uppercase; color: var(--sob-gold);
    }
    .sob-hero__title {
      margin: 12px 0 8px;
      font: 600 clamp(30px, 3.6vw, 46px)/1.06 var(--sob-sans);
      letter-spacing: -0.03em;
      background: linear-gradient(180deg, #ffffff 10%, #f3e6c6 60%, color-mix(in srgb, var(--sob-gold) 78%, #fff) 100%);
      -webkit-background-clip: text; background-clip: text; color: transparent;
      filter: drop-shadow(0 0 22px color-mix(in srgb, var(--sob-gold) 18%, transparent));
    }
    .sob-hero__sub { margin: 0; color: var(--sob-fg-2); font-size: 16px; text-wrap: balance; }

    /* ── Console ──────────────────────────────────────────── */
    .sob-console {
      position: relative; width: 100%; max-width: 1020px;
      border-radius: 22px;
      background:
        radial-gradient(90% 60% at 50% 0%, color-mix(in srgb, var(--sob-gold) 7%, transparent), transparent 70%),
        linear-gradient(180deg, rgba(20, 17, 11, 0.74), rgba(8, 7, 5, 0.82));
      -webkit-backdrop-filter: blur(22px) saturate(140%);
      backdrop-filter: blur(22px) saturate(140%);
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.07),
        inset 0 0 70px color-mix(in srgb, var(--sob-gold) 4%, transparent),
        0 40px 100px -20px rgba(0, 0, 0, 0.85),
        0 0 60px -10px color-mix(in srgb, var(--sob-gold) 16%, transparent);
      animation: sob-power 0.5s 0.1s ease-out backwards;
    }
    /* Neon gradient border — brightest along the top edge. */
    .sob-console::before {
      content: ""; position: absolute; inset: 0; border-radius: inherit; padding: 1px; pointer-events: none;
      background: linear-gradient(180deg,
        color-mix(in srgb, var(--sob-gold) 72%, transparent) 0%,
        color-mix(in srgb, var(--sob-gold) 22%, transparent) 26%,
        color-mix(in srgb, var(--sob-gold) 10%, transparent) 70%,
        color-mix(in srgb, var(--sob-gold) 28%, transparent) 100%);
      -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
      -webkit-mask-composite: xor;
      mask: linear-gradient(#000 0 0) content-box exclude, linear-gradient(#000 0 0);
    }
    .sob-console__trace {
      position: absolute; top: -1px; left: 12%; right: 12%; height: 1px; pointer-events: none;
      background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--sob-gold) 95%, #fff), transparent);
      box-shadow: 0 0 12px 1px color-mix(in srgb, var(--sob-gold) 55%, transparent);
      animation: sob-trace 1.2s 0.45s var(--sob-ease) both;
    }
    .sob-corner {
      position: absolute; width: 16px; height: 16px; pointer-events: none;
      border: 0 solid color-mix(in srgb, var(--sob-gold) 75%, transparent);
      filter: drop-shadow(0 0 4px color-mix(in srgb, var(--sob-gold) 60%, transparent));
      animation: sob-lock-on 0.6s 1.05s var(--sob-ease) both;
    }
    .sob-corner--tl { top: -8px; left: -8px; border-top-width: 1.5px; border-left-width: 1.5px; border-top-left-radius: 6px; --dx: -10px; --dy: -10px; }
    .sob-corner--tr { top: -8px; right: -8px; border-top-width: 1.5px; border-right-width: 1.5px; border-top-right-radius: 6px; --dx: 10px; --dy: -10px; }
    .sob-corner--bl { bottom: -8px; left: -8px; border-bottom-width: 1.5px; border-left-width: 1.5px; border-bottom-left-radius: 6px; --dx: -10px; --dy: 10px; }
    .sob-corner--br { bottom: -8px; right: -8px; border-bottom-width: 1.5px; border-right-width: 1.5px; border-bottom-right-radius: 6px; --dx: 10px; --dy: 10px; }
    .sob-console__inner { position: relative; animation: sob-resolve 0.8s 0.7s var(--sob-ease) both; }
    /* Power-on: two blast doors part along a glowing seam. They never take
       pointer events, so the console is usable from the first frame.
       Their REST state is open (and the seam invisible): the closed state only
       exists inside the keyframes. Low-power mode (low-power.css: 4 cores or
       fewer, 4 GB or less, or reduced motion) strips every animation, and doors
       that rest closed then cover the whole console for good. */
    .sob-console__doors {
      position: absolute; inset: 0; z-index: 2; border-radius: inherit; overflow: hidden; pointer-events: none;
    }
    .sob-door {
      position: absolute; left: 0; right: 0; height: 50.5%;
      background: linear-gradient(180deg, #0e0c08, #070605);
      animation: 0.95s 0.5s cubic-bezier(0.7, 0, 0.2, 1) both;
    }
    .sob-door--top { top: 0; transform: translateY(-101%); box-shadow: inset 0 -1px 0 color-mix(in srgb, var(--sob-gold) 70%, transparent); animation-name: sob-door-top; }
    .sob-door--bottom { bottom: 0; transform: translateY(101%); box-shadow: inset 0 1px 0 color-mix(in srgb, var(--sob-gold) 70%, transparent); animation-name: sob-door-bottom; }
    .sob-console__doors::after {
      content: ""; position: absolute; left: 0; right: 0; top: 50%; height: 4px; margin-top: -2px; opacity: 0;
      background: radial-gradient(50% 50% at 50% 50%,
        color-mix(in srgb, var(--sob-gold) 55%, #fff) 0%,
        color-mix(in srgb, var(--sob-gold) 80%, transparent) 35%,
        transparent 100%);
      animation: sob-seam 1.35s 0.15s var(--sob-ease) both;
    }

    .sob-bar {
      display: flex; align-items: center; justify-content: space-between; gap: 16px;
      padding: 14px 24px;
      border-bottom: 1px solid var(--sob-line);
      font-family: var(--sob-mono); font-size: 11px; letter-spacing: 0.16em; text-transform: uppercase;
      color: var(--sob-fg-3);
    }
    .sob-bar__brand { display: flex; align-items: center; gap: 10px; min-width: 0; }
    .sob-bar__brand img { width: 20px; height: 20px; object-fit: contain; filter: drop-shadow(0 0 6px color-mix(in srgb, var(--sob-gold) 45%, transparent)); }
    .sob-bar__name { color: var(--sob-fg); font-weight: 500; }
    .sob-bar__path { color: var(--sob-fg-4); white-space: nowrap; }
    .sob-bar__status { display: flex; align-items: center; gap: 18px; white-space: nowrap; }
    .sob-bar__link { display: inline-flex; align-items: center; gap: 8px; }
    .sob-bar__count { color: var(--sob-gold); font-variant-numeric: tabular-nums; }

    .sob-led {
      width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; display: inline-block;
      background: var(--sob-fg-4);
    }
    .sob-led.is-on {
      background: var(--sob-gold);
      box-shadow: 0 0 0 3px color-mix(in srgb, var(--sob-gold) 14%, transparent), 0 0 10px var(--sob-gold);
      animation: sob-led 2.8s ease-in-out infinite;
    }
    @keyframes sob-led { 50% { box-shadow: 0 0 0 5px color-mix(in srgb, var(--sob-gold) 6%, transparent), 0 0 14px var(--sob-gold); } }

    .sob-body { display: grid; grid-template-columns: 236px minmax(0, 1fr); }

    /* ── Progress rail ────────────────────────────────────── */
    .sob-rail {
      --node-h: 76px;
      position: relative; display: flex; flex-direction: column;
      padding: 30px 18px 30px 24px;
      border-right: 1px solid var(--sob-line);
      background: linear-gradient(90deg, rgba(0, 0, 0, 0.18), transparent);
    }
    .sob-rail__track {
      position: absolute; left: calc(24px + 15px); top: calc(30px + 16px);
      width: 1px; height: calc(var(--node-h) * (var(--sob-steps, 4) - 1));
      background: var(--sob-line);
    }
    .sob-rail__fill {
      position: absolute; inset: 0; transform-origin: top;
      transform: scaleY(var(--sob-progress, 0));
      background: linear-gradient(180deg, var(--sob-gold), color-mix(in srgb, var(--sob-gold) 60%, transparent));
      box-shadow: 0 0 10px color-mix(in srgb, var(--sob-gold) 70%, transparent);
      transition: transform 0.7s var(--sob-ease);
    }
    .sob-rail.is-long { --node-h: 64px; }
    .sob-rail__now { display: none; }
    .sob-node {
      position: relative; display: grid; grid-template-columns: 32px 1fr; gap: 14px; align-items: start;
      height: var(--node-h); padding: 0; margin: 0;
      background: none; border: none; text-align: left; color: inherit; font: inherit; cursor: pointer;
    }
    .sob-node:disabled { cursor: default; }
    .sob-node:focus-visible { outline: none; }
    .sob-node:focus-visible .sob-node__dot { outline: 2px solid var(--sob-gold); outline-offset: 3px; }
    .sob-node__dot {
      position: relative; width: 32px; height: 32px; border-radius: 50%;
      display: grid; place-items: center;
      background: #0b0a08;
      border: 1px solid var(--sob-line);
      color: var(--sob-fg-4);
      font-family: var(--sob-mono); font-size: 12px;
      transition: border-color 0.4s, color 0.4s, background 0.4s, box-shadow 0.4s;
    }
    .sob-node__dot svg { width: 15px; height: 15px; stroke-width: 2.4; }
    .sob-node.is-active .sob-node__dot {
      border-color: var(--sob-gold); color: var(--sob-gold);
      background: radial-gradient(circle, color-mix(in srgb, var(--sob-gold) 22%, #0b0a08), #0b0a08 70%);
      box-shadow: var(--sob-glow);
    }
    .sob-node.is-active .sob-node__dot::after {
      content: ""; position: absolute; inset: -1px; border-radius: 50%;
      border: 1px solid var(--sob-gold);
      animation: sob-ping 2.4s var(--sob-ease) infinite;
    }
    .sob-node.is-done .sob-node__dot {
      border-color: var(--sob-gold); color: #140f02;
      background: linear-gradient(180deg, color-mix(in srgb, var(--sob-gold) 85%, #fff), var(--sob-gold));
      box-shadow: var(--sob-glow-soft);
      animation: sob-node-lock 0.55s var(--sob-ease) both;
    }
    .sob-node__text { display: flex; flex-direction: column; padding-top: 1px; min-width: 0; }
    .sob-node__code { font-family: var(--sob-mono); font-size: 10px; letter-spacing: 0.2em; color: var(--sob-fg-4); }
    .sob-node__label { font-size: 15px; font-weight: 600; color: var(--sob-fg-3); line-height: 1.35; transition: color 0.3s; }
    .sob-node__hint { font-size: 12.5px; color: var(--sob-fg-4); line-height: 1.4; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .sob-node.is-active .sob-node__label { color: var(--sob-fg); }
    .sob-node.is-active .sob-node__code { color: var(--sob-gold); }
    .sob-node.is-active .sob-node__hint { color: var(--sob-fg-3); }
    .sob-node.is-done .sob-node__label { color: var(--sob-fg-2); }
    .sob-node:not(:disabled):not(.is-active):hover .sob-node__label { color: var(--sob-fg); }
    .sob-node:not(:disabled):not(.is-active):hover .sob-node__dot { border-color: var(--sob-line-2); }

    /* ── Panel ────────────────────────────────────────────── */
    .sob-panel { position: relative; min-width: 0; padding: 32px 44px 30px; min-height: 400px; }
    .sob-panel__step { animation: sob-step-in 0.5s var(--sob-ease) both; }
    .sob-eyebrow {
      display: flex; align-items: center; gap: 12px;
      font-family: var(--sob-mono); font-size: 11px; letter-spacing: 0.24em; text-transform: uppercase;
      color: var(--sob-fg-3);
    }
    .sob-eyebrow__code { color: var(--sob-gold); }
    .sob-eyebrow__rule { width: 28px; height: 1px; background: var(--sob-line-2); }
    .sob-eyebrow--center { justify-content: center; color: var(--sob-gold); text-shadow: var(--sob-text-glow); }
    .sob-title {
      margin: 12px 0 8px;
      font: 600 30px/1.15 var(--sob-sans); letter-spacing: -0.025em; color: var(--sob-fg);
      display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
    }
    .sob-title--hero { justify-content: center; font-size: 34px; }
    .sob-sub { margin: 0 0 24px; max-width: 660px; color: var(--sob-fg-2); font-size: 15px; line-height: 1.6; text-wrap: pretty; }
    .sob-sub strong { color: var(--sob-fg); font-weight: 600; }
    .sob-sub code, .sob-manifest code {
      font-family: var(--sob-mono); font-size: 0.86em; color: var(--sob-gold);
      padding: 2px 8px; border-radius: 6px;
      background: color-mix(in srgb, var(--sob-gold) 8%, transparent);
      border: 1px solid color-mix(in srgb, var(--sob-gold) 22%, transparent);
    }
    .sob-tag {
      font-family: var(--sob-mono); font-size: 10px; font-weight: 500; letter-spacing: 0.2em; text-transform: uppercase;
      color: var(--sob-fg-3); border: 1px solid var(--sob-line); border-radius: 999px; padding: 4px 10px;
    }

    /* ── Fields ───────────────────────────────────────────── */
    .sob-field { display: flex; flex-direction: column; gap: 9px; margin-top: 4px; }
    .sob-field--reveal { margin-top: 22px; animation: sob-step-in 0.4s var(--sob-ease) both; }
    .sob-label {
      font-family: var(--sob-mono); font-size: 11px; letter-spacing: 0.18em; text-transform: uppercase;
      color: var(--sob-fg-3);
    }
    .sob-input {
      width: 100%; height: 50px; padding: 0 16px;
      border-radius: 12px; outline: none;
      background: rgba(0, 0, 0, 0.42);
      border: 1px solid var(--sob-line);
      box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.5);
      color: var(--sob-fg); font: 500 15px var(--sob-sans); letter-spacing: 0;
      transition: border-color 0.25s, box-shadow 0.25s, background 0.25s;
    }
    .sob-input::placeholder { color: var(--sob-fg-4); }
    .sob-input:hover { border-color: color-mix(in srgb, var(--sob-gold) 26%, rgba(255,255,255,0.08)); }
    .sob-input:focus {
      border-color: color-mix(in srgb, var(--sob-gold) 70%, transparent);
      background: rgba(0, 0, 0, 0.55);
      box-shadow: 0 0 0 4px color-mix(in srgb, var(--sob-gold) 12%, transparent), var(--sob-glow-soft);
    }
    .sob-input--lg { height: 56px; font-size: 18px; font-weight: 500; }
    .sob-input--mono { font-family: var(--sob-mono); font-size: 14px; }
    .sob-select {
      appearance: none; -webkit-appearance: none; cursor: pointer; max-width: 320px;
      text-transform: capitalize;
      background-image: linear-gradient(45deg, transparent 50%, var(--sob-gold) 50%), linear-gradient(135deg, var(--sob-gold) 50%, transparent 50%);
      background-position: calc(100% - 22px) 50%, calc(100% - 17px) 50%;
      background-size: 5px 5px, 5px 5px; background-repeat: no-repeat;
    }
    .sob-select option { background: #0e0c09; color: var(--sob-fg); }
    .sob-hint { font-size: 13px; color: var(--sob-fg-3); margin: 0; }
    /* A step the current plan can't run: plain, informational, never blocking. */
    .sob-hosted {
      display: grid; gap: 14px; padding: 18px 20px; border-radius: 14px;
      border: 1px dashed var(--sob-line-2);
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.03), rgba(255, 255, 255, 0.01));
    }
    .sob-hosted__head {
      display: flex; align-items: center; gap: 10px;
      font-family: var(--sob-mono); font-size: 11px; letter-spacing: 0.18em; text-transform: uppercase; color: var(--sob-gold);
    }
    .sob-hosted__head .sob-lock { width: 16px; height: 16px; }
    .sob-hosted__list {
      list-style: none; margin: 0; padding: 0; display: grid; gap: 8px 18px;
      grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); color: var(--sob-fg-2); font-size: 14px;
    }
    .sob-hosted__list li { display: flex; align-items: center; gap: 10px; }
    .sob-hosted .sob-hint { line-height: 1.6; }
    .sob-hint a, .sob-link {
      color: var(--sob-gold); text-decoration: none;
      border-bottom: 1px solid color-mix(in srgb, var(--sob-gold) 40%, transparent);
      transition: border-color 0.2s, text-shadow 0.2s;
    }
    .sob-hint a:hover, .sob-link:hover { border-color: var(--sob-gold); text-shadow: var(--sob-text-glow); }
    .sob-link { background: none; border-top: 0; border-left: 0; border-right: 0; padding: 0; font: 500 13px var(--sob-sans); cursor: pointer; white-space: nowrap; }

    .sob-input-wrap { position: relative; flex: 1; min-width: 0; overflow: hidden; border-radius: 12px; }
    .sob-input-wrap .sob-input { padding-left: 44px; }
    .sob-input-wrap__icon {
      position: absolute; left: 15px; top: 50%; transform: translateY(-50%);
      display: grid; color: var(--sob-fg-4); pointer-events: none; z-index: 1;
    }
    .sob-input-wrap__icon svg { width: 17px; height: 17px; }
    .sob-input-wrap:focus-within .sob-input-wrap__icon { color: var(--sob-gold); }
    .sob-input-wrap__scan { position: absolute; inset: 0; pointer-events: none; opacity: 0; }
    .sob-input-wrap.is-scanning .sob-input-wrap__scan {
      opacity: 1;
      background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--sob-gold) 22%, transparent), transparent);
      background-size: 40% 100%; background-repeat: no-repeat;
      animation: sob-scanline 1.1s linear infinite;
    }
    .sob-input-wrap.is-scanning .sob-input { border-color: color-mix(in srgb, var(--sob-gold) 55%, transparent); }
    .sob-keyrow { display: flex; gap: 12px; align-items: stretch; }
    .sob-field--key { margin-top: 22px; }

    /* ── Buttons ──────────────────────────────────────────── */
    .sob-btn {
      position: relative; overflow: hidden;
      display: inline-flex; align-items: center; justify-content: center; gap: 10px;
      height: 48px; padding: 0 22px; border-radius: 12px;
      border: 1px solid transparent; cursor: pointer; white-space: nowrap;
      font: 600 14.5px var(--sob-sans); letter-spacing: 0.01em;
      transition: transform 0.2s var(--sob-ease), box-shadow 0.25s, border-color 0.25s;
    }
    .sob-btn svg { width: 17px; height: 17px; flex-shrink: 0; }
    .sob-btn:focus-visible { outline: 2px solid var(--sob-gold); outline-offset: 3px; }
    .sob-btn:disabled { cursor: not-allowed; }
    .sob-btn--primary {
      color: #150f02;
      background: linear-gradient(180deg, color-mix(in srgb, var(--sob-gold) 80%, #fff) 0%, var(--sob-gold) 48%, color-mix(in srgb, var(--sob-gold) 84%, #b45309) 100%);
      transition: transform 0.2s var(--sob-ease), box-shadow 0.25s;
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.5), 0 10px 28px -10px color-mix(in srgb, var(--sob-gold) 70%, transparent), var(--sob-glow-soft);
    }
    .sob-btn--primary::after {
      content: ""; position: absolute; inset: 0; pointer-events: none;
      background: linear-gradient(105deg, transparent 35%, rgba(255, 255, 255, 0.55) 50%, transparent 65%);
      transform: translateX(-110%);
    }
    .sob-btn--primary:not(:disabled):hover { transform: translateY(-1px); box-shadow: inset 0 1px 0 rgba(255,255,255,0.5), 0 14px 32px -10px color-mix(in srgb, var(--sob-gold) 80%, transparent), var(--sob-glow); }
    .sob-btn--primary:not(:disabled):hover::after { transform: translateX(110%); transition: transform 0.9s var(--sob-ease); }
    .sob-btn--primary:not(:disabled):active { transform: translateY(0) scale(0.985); }
    .sob-btn--primary:disabled:not([aria-busy="true"]) {
      color: var(--sob-fg-4); background: rgba(255, 255, 255, 0.035);
      box-shadow: inset 0 0 0 1px var(--sob-line);
    }
    /* In progress is not the same as unavailable: stay lit while the request runs. */
    .sob-btn--primary[aria-busy="true"] { cursor: progress; }
    .sob-btn--ghost { color: var(--sob-fg-2); background: rgba(255, 255, 255, 0.02); border-color: var(--sob-line); }
    .sob-btn--ghost:not(:disabled):hover { color: var(--sob-fg); border-color: var(--sob-line-2); background: rgba(255,255,255,0.04); }
    .sob-btn--ghost:disabled { opacity: 0.35; }
    .sob-btn--xl { height: 56px; padding: 0 30px; font-size: 16px; border-radius: 14px; }
    .sob-spinner {
      width: 15px; height: 15px; border-radius: 50%;
      border: 2px solid color-mix(in srgb, currentColor 25%, transparent); border-top-color: currentColor;
      animation: sob-spin 0.8s linear infinite;
    }
    .sob-lock.is-open .sob-lock__shackle { animation: sob-shackle 0.8s 0.2s var(--sob-ease) both; }

    /* ── Identity ─────────────────────────────────────────── */
    .sob-identity { display: grid; grid-template-columns: 168px minmax(0, 1fr); gap: 36px; align-items: center; margin-top: 4px; }
    .sob-identity__mark { display: flex; flex-direction: column; align-items: center; gap: 14px; }
    .sob-identity__caption {
      display: flex; gap: 8px; font-family: var(--sob-mono); font-size: 10.5px; letter-spacing: 0.2em; text-transform: uppercase;
      color: var(--sob-fg-4); white-space: nowrap;
    }
    .sob-identity__value { color: var(--sob-gold); }
    .sob-identity__fields { display: flex; flex-direction: column; gap: 12px; }

    .sob-sigil { --s: 132px; position: relative; display: inline-grid; place-items: center; flex-shrink: 0; width: var(--s); height: var(--s); }
    .sob-sigil--xl { --s: 150px; }
    .sob-sigil--sm { --s: 28px; }
    .sob-sigil__halo {
      position: absolute; inset: -18%; border-radius: 50%;
      background: radial-gradient(closest-side, color-mix(in srgb, var(--sob-gold) 20%, transparent), transparent 75%);
      animation: sob-breathe 4.5s ease-in-out infinite;
    }
    .sob-sigil__orbit {
      position: absolute; inset: 0; border-radius: 50%;
      box-shadow: inset 0 0 0 1px var(--sob-line);
    }
    .sob-sigil__orbit::before {
      content: ""; position: absolute; inset: 0; border-radius: 50%;
      background: conic-gradient(from 0deg, transparent 0 62%, color-mix(in srgb, var(--sob-gold) 90%, transparent) 92%, transparent);
      -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 1.5px), #000 calc(100% - 1px));
      mask: radial-gradient(farthest-side, transparent calc(100% - 1.5px), #000 calc(100% - 1px));
      animation: sob-spin 8s linear infinite;
    }
    .sob-sigil__face {
      position: absolute; inset: 15%; border-radius: 30%;
      display: grid; place-items: center; overflow: hidden;
      color: var(--sob-gold);
      background: radial-gradient(circle at 50% 22%, color-mix(in srgb, var(--sob-gold) 26%, #15110a), #0a0907 72%);
      border: 1px solid color-mix(in srgb, var(--sob-gold) 58%, transparent);
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.22),
        inset 0 0 calc(var(--s) * 0.22) color-mix(in srgb, var(--sob-gold) 16%, transparent),
        var(--sob-glow);
    }
    .sob-sigil__face::after {
      content: ""; position: absolute; inset: 0; pointer-events: none;
      background: linear-gradient(160deg, rgba(255, 255, 255, 0.14), transparent 45%);
    }
    .sob-sigil__glyph {
      font: 600 calc(var(--s) * 0.3)/1 var(--sob-sans); letter-spacing: -0.02em;
      background: linear-gradient(180deg, #fff8e2 15%, var(--sob-gold) 85%);
      -webkit-background-clip: text; background-clip: text; color: transparent;
      filter: drop-shadow(0 0 calc(var(--s) * 0.07) color-mix(in srgb, var(--sob-gold) 60%, transparent));
      animation: sob-glyph-in 0.45s var(--sob-ease) both;
    }
    .sob-sigil__svg { width: 54%; height: 54%; filter: drop-shadow(0 0 6px color-mix(in srgb, var(--sob-gold) 55%, transparent)); animation: sob-glyph-in 0.45s var(--sob-ease) both; }
    .sob-sigil--sm .sob-sigil__face { inset: 0; border-radius: 9px; box-shadow: inset 0 1px 0 rgba(255,255,255,0.2), var(--sob-glow-soft); }
    .sob-sigil--sm .sob-sigil__glyph { font-size: 12px; filter: none; }

    /* ── Providers ────────────────────────────────────────── */
    .sob-provbar {
      display: flex; align-items: center; justify-content: space-between; gap: 10px 16px; flex-wrap: wrap;
      margin-bottom: 10px;
    }
    .sob-provbar__count {
      display: inline-flex; align-items: center; gap: 8px;
      font-family: var(--sob-mono); font-size: 11px; letter-spacing: 0.18em; text-transform: uppercase; color: var(--sob-fg-3);
    }
    .sob-provbar__num { color: var(--sob-fg); font-variant-numeric: tabular-nums; letter-spacing: 0.04em; }
    .sob-provbar__num.is-on { color: var(--sob-ok); text-shadow: 0 0 10px color-mix(in srgb, var(--sob-ok) 55%, transparent); }
    .sob-filter {
      position: relative; display: flex; align-items: center; width: 232px; height: 38px;
      border-radius: 10px; background: rgba(0, 0, 0, 0.38); border: 1px solid var(--sob-line);
      box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.45);
      transition: border-color 0.25s, box-shadow 0.25s;
    }
    .sob-filter:hover { border-color: color-mix(in srgb, var(--sob-gold) 26%, rgba(255,255,255,0.08)); }
    .sob-filter:focus-within {
      border-color: color-mix(in srgb, var(--sob-gold) 70%, transparent);
      box-shadow: 0 0 0 3px color-mix(in srgb, var(--sob-gold) 12%, transparent), var(--sob-glow-soft);
    }
    .sob-filter__icon { position: absolute; left: 12px; display: grid; color: var(--sob-fg-4); pointer-events: none; }
    .sob-filter__icon svg { width: 15px; height: 15px; }
    .sob-filter:focus-within .sob-filter__icon { color: var(--sob-gold); }
    .sob-filter__input {
      width: 100%; height: 100%; padding: 0 12px 0 36px; border: 0; outline: none; background: transparent;
      color: var(--sob-fg); font: 500 13px var(--sob-mono);
    }
    .sob-filter__input::placeholder { color: var(--sob-fg-4); }
    /* Focus is drawn by the rounded wrapper (:focus-within), not the square global ring. */
    .sob-filter__input:focus, .sob-filter__input:focus-visible { outline: none; box-shadow: none; }
    .sob-filter__input::-webkit-search-cancel-button { filter: grayscale(1) brightness(1.6); cursor: pointer; }

    /* The grid scrolls inside the console so the key field stays in view. */
    .sob-provscroll {
      position: relative; max-height: 268px; overflow-y: auto; overscroll-behavior: contain;
      margin: 0 -8px; padding: 8px 8px 22px;
      scrollbar-width: thin; scrollbar-color: color-mix(in srgb, var(--sob-gold) 40%, transparent) transparent;
      -webkit-mask-image: linear-gradient(180deg, transparent 0, #000 8px, #000 calc(100% - 22px), transparent 100%);
      mask-image: linear-gradient(180deg, transparent 0, #000 8px, #000 calc(100% - 22px), transparent 100%);
    }
    .sob-provscroll::-webkit-scrollbar { width: 6px; }
    .sob-provscroll::-webkit-scrollbar-thumb { border-radius: 6px; background: color-mix(in srgb, var(--sob-gold) 38%, transparent); }
    .sob-provscroll::-webkit-scrollbar-track { background: transparent; }
    .sob-providers { display: grid; grid-template-columns: repeat(auto-fill, minmax(196px, 1fr)); gap: 10px; }
    .sob-provempty {
      padding: 26px 0 8px; text-align: center; font-size: 14px; color: var(--sob-fg-3);
    }
    .sob-provempty code { font-family: var(--sob-mono); color: var(--sob-gold); }
    .sob-prov {
      position: relative; display: grid; grid-template-columns: 40px minmax(0, 1fr) auto; align-items: center; column-gap: 12px;
      min-width: 0; min-height: 62px; padding: 10px 14px 10px 10px; border-radius: 13px; cursor: pointer; text-align: left;
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.035), rgba(255, 255, 255, 0.012));
      border: 1px solid var(--sob-line); color: inherit; font: inherit;
      transition: border-color 0.25s, background 0.25s, box-shadow 0.25s, transform 0.25s var(--sob-ease);
    }
    @media (hover: hover) {
      .sob-prov:hover {
        border-color: color-mix(in srgb, var(--sob-gold) 30%, var(--sob-line-2)); transform: translateY(-1px);
        box-shadow: 0 10px 26px -16px color-mix(in srgb, var(--sob-gold) 55%, transparent);
      }
      .sob-prov:hover .sob-prov__mark { color: var(--sob-fg); border-color: var(--sob-line-2); }
    }
    .sob-prov:focus-visible { outline: 2px solid var(--sob-gold); outline-offset: 2px; }
    .sob-prov.is-selected {
      border-color: color-mix(in srgb, var(--sob-gold) 70%, transparent);
      background: linear-gradient(180deg, color-mix(in srgb, var(--sob-gold) 12%, transparent), color-mix(in srgb, var(--sob-gold) 3%, transparent));
      box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--sob-gold) 18%, transparent), var(--sob-glow-soft);
    }
    .sob-prov.is-linked:not(.is-selected) { border-color: color-mix(in srgb, var(--sob-ok) 34%, var(--sob-line)); }
    .sob-prov__mark {
      position: relative; width: 40px; height: 40px; border-radius: 10px; display: grid; place-items: center;
      font: 600 15px/1 var(--sob-mono); letter-spacing: -0.02em; color: var(--sob-fg-3);
      background: radial-gradient(circle at 50% 18%, rgba(255, 255, 255, 0.07), rgba(0, 0, 0, 0.4) 72%);
      border: 1px solid var(--sob-line);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06);
      transition: color 0.25s, border-color 0.25s, box-shadow 0.25s;
    }
    .sob-prov__z {
      position: absolute; top: 3px; left: 4px;
      font: 500 7.5px/1 var(--sob-mono); letter-spacing: 0.06em; color: var(--sob-fg-4);
    }
    .sob-prov.is-selected .sob-prov__mark {
      color: color-mix(in srgb, var(--sob-gold) 70%, #fff);
      border-color: color-mix(in srgb, var(--sob-gold) 62%, transparent);
      background: radial-gradient(circle at 50% 18%, color-mix(in srgb, var(--sob-gold) 28%, #15110a), #0a0907 75%);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.18), var(--sob-glow-soft);
      text-shadow: 0 0 10px color-mix(in srgb, var(--sob-gold) 70%, transparent);
    }
    .sob-prov.is-selected .sob-prov__z { color: var(--sob-gold); }
    .sob-prov.is-linked:not(.is-selected) .sob-prov__mark { color: var(--sob-ok); border-color: color-mix(in srgb, var(--sob-ok) 38%, transparent); }
    .sob-prov__text { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
    .sob-prov__name { font-size: 15px; font-weight: 600; color: var(--sob-fg); letter-spacing: -0.01em; line-height: 1.2; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .sob-prov__status { font-family: var(--sob-mono); font-size: 10.5px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--sob-fg-4); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .sob-prov.is-selected .sob-prov__status { color: var(--sob-fg-3); }
    .sob-prov.is-linked .sob-prov__status { color: var(--sob-ok); }
    .sob-prov__mask { color: var(--sob-fg-3); margin-left: 6px; text-transform: none; letter-spacing: 0; }
    .sob-prov .sob-led.is-on { background: var(--sob-ok); box-shadow: 0 0 0 3px color-mix(in srgb, var(--sob-ok) 16%, transparent), 0 0 10px var(--sob-ok); animation: sob-led-on 0.8s var(--sob-ease) both; }

    /* ── Segmented choice (speech recognition) ────────────── */
    .sob-seg { display: flex; flex-wrap: wrap; gap: 8px; }
    .sob-seg__opt {
      display: inline-flex; align-items: center; gap: 9px; height: 40px; padding: 0 16px; border-radius: 999px;
      background: rgba(0, 0, 0, 0.3); border: 1px solid var(--sob-line); color: var(--sob-fg-2);
      font: 500 13.5px var(--sob-sans); cursor: pointer; white-space: nowrap;
      transition: border-color 0.25s, color 0.25s, box-shadow 0.25s, background 0.25s;
    }
    .sob-seg__opt svg { width: 14px; height: 14px; }
    .sob-seg__opt:not(:disabled):hover { border-color: var(--sob-line-2); color: var(--sob-fg); }
    .sob-seg__opt:focus-visible { outline: 2px solid var(--sob-gold); outline-offset: 2px; }
    .sob-seg__opt:disabled { cursor: not-allowed; opacity: 0.45; }
    .sob-seg__dot { width: 8px; height: 8px; border-radius: 50%; border: 1px solid var(--sob-line-2); transition: background 0.25s, box-shadow 0.25s, border-color 0.25s; }
    .sob-seg__opt.is-selected {
      color: var(--sob-fg); border-color: color-mix(in srgb, var(--sob-gold) 65%, transparent);
      background: color-mix(in srgb, var(--sob-gold) 10%, rgba(0, 0, 0, 0.3)); box-shadow: var(--sob-glow-soft);
    }
    .sob-seg__opt.is-selected .sob-seg__dot { border-color: var(--sob-gold); background: var(--sob-gold); box-shadow: 0 0 8px var(--sob-gold); }

    .sob-unlock {
      position: relative; overflow: hidden;
      display: flex; align-items: center; gap: 14px; margin-top: 20px;
      padding: 14px 18px 14px 14px; border-radius: 14px;
      background: linear-gradient(90deg, color-mix(in srgb, var(--sob-gold) 13%, transparent), color-mix(in srgb, var(--sob-gold) 3%, transparent) 70%);
      border: 1px solid color-mix(in srgb, var(--sob-gold) 42%, transparent);
      box-shadow: var(--sob-glow-soft);
      animation: sob-unlock-in 0.55s var(--sob-ease) both;
    }
    .sob-unlock::after {
      content: ""; position: absolute; inset: 0; pointer-events: none;
      background: linear-gradient(100deg, transparent 30%, color-mix(in srgb, var(--sob-gold) 30%, transparent) 50%, transparent 70%);
      transform: translateX(100%);
      animation: sob-sheen 1.2s 0.3s var(--sob-ease) both;
    }
    .sob-unlock__icon {
      width: 42px; height: 42px; border-radius: 12px; flex-shrink: 0; display: grid; place-items: center;
      color: var(--sob-gold);
      background: color-mix(in srgb, var(--sob-gold) 12%, #0b0a08);
      border: 1px solid color-mix(in srgb, var(--sob-gold) 55%, transparent);
      box-shadow: var(--sob-glow);
      animation: sob-icon-flash 0.9s 0.15s var(--sob-ease) both;
    }
    .sob-unlock__icon svg { width: 20px; height: 20px; }
    .sob-unlock__text { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; }
    .sob-unlock__title { font-size: 15px; color: var(--sob-fg-2); }
    .sob-unlock__title strong { color: var(--sob-fg); font-weight: 600; }
    .sob-unlock__meta { font-family: var(--sob-mono); font-size: 12px; color: var(--sob-gold); display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .sob-dot { width: 3px; height: 3px; border-radius: 50%; background: currentColor; opacity: 0.6; }

    .sob-alert {
      display: flex; align-items: flex-start; gap: 10px; margin-top: 16px;
      padding: 12px 14px; border-radius: 12px;
      font-size: 14px; color: #fecaca;
      background: color-mix(in srgb, var(--sob-danger) 9%, transparent);
      border: 1px solid color-mix(in srgb, var(--sob-danger) 36%, transparent);
      animation: sob-shake 0.45s var(--sob-ease) both;
    }
    .sob-alert svg { width: 17px; height: 17px; color: var(--sob-danger); margin-top: 2px; flex-shrink: 0; }

    /* ── Voice options ────────────────────────────────────── */
    .sob-options { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    .sob-opt {
      position: relative; display: grid; grid-template-columns: 36px minmax(0, 1fr); column-gap: 14px; row-gap: 2px; align-content: center;
      padding: 14px 44px 14px 14px; border-radius: 14px; cursor: pointer; text-align: left; min-width: 0;
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.035), rgba(255, 255, 255, 0.012));
      border: 1px solid var(--sob-line); color: inherit; font: inherit;
      transition: border-color 0.25s, background 0.25s, box-shadow 0.25s, transform 0.25s var(--sob-ease);
    }
    .sob-opt:not(:disabled):hover { border-color: var(--sob-line-2); transform: translateY(-1px); }
    .sob-opt:focus-visible { outline: 2px solid var(--sob-gold); outline-offset: 3px; }
    .sob-opt:disabled { cursor: not-allowed; opacity: 0.5; }
    .sob-opt.is-selected {
      border-color: color-mix(in srgb, var(--sob-gold) 70%, transparent);
      background: linear-gradient(180deg, color-mix(in srgb, var(--sob-gold) 11%, transparent), color-mix(in srgb, var(--sob-gold) 3%, transparent));
      box-shadow: var(--sob-glow-soft);
    }
    .sob-opt__icon {
      grid-row: span 2; align-self: center;
      width: 36px; height: 36px; border-radius: 10px; display: grid; place-items: center;
      color: var(--sob-fg-3); background: rgba(255, 255, 255, 0.03); border: 1px solid var(--sob-line);
      transition: color 0.25s, border-color 0.25s, box-shadow 0.25s;
    }
    .sob-opt__icon svg { width: 18px; height: 18px; }
    /* A provider logo brings its own tile. */
    .sob-opt__icon--logo { background: none; border: 0; }
    .sob-opt__icon--logo ib-provider-logo { width: 100%; height: 100%; }
    .sob-opt.is-selected .sob-opt__icon { color: var(--sob-gold); border-color: color-mix(in srgb, var(--sob-gold) 50%, transparent); box-shadow: var(--sob-glow-soft); }
    .sob-opt__title { font-size: 15px; font-weight: 600; color: var(--sob-fg); }
    .sob-opt__desc { font-size: 13px; color: var(--sob-fg-3); line-height: 1.45; }
    .sob-keypair { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 0 16px; }
    .sob-opt__radio {
      position: absolute; top: 50%; margin-top: -8px; right: 16px; width: 16px; height: 16px; border-radius: 50%;
      border: 1px solid var(--sob-line-2);
    }
    .sob-opt.is-selected .sob-opt__radio { border-color: var(--sob-gold); box-shadow: inset 0 0 0 3.5px #0b0a08, inset 0 0 0 8px var(--sob-gold), 0 0 10px color-mix(in srgb, var(--sob-gold) 60%, transparent); }

    /* ── Review manifest ──────────────────────────────────── */
    .sob-manifest {
      margin: 0; padding: 8px 20px; border-radius: 14px;
      background: rgba(0, 0, 0, 0.3); border: 1px solid var(--sob-line);
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.03);
    }
    .sob-manifest__row { display: flex; align-items: center; gap: 14px; min-height: 56px; }
    .sob-manifest__row + .sob-manifest__row { border-top: 1px solid rgba(255, 255, 255, 0.045); }
    .sob-manifest dt {
      font-family: var(--sob-mono); font-size: 11px; letter-spacing: 0.2em; text-transform: uppercase; color: var(--sob-fg-3);
      white-space: nowrap;
    }
    .sob-manifest__lead { flex: 1; min-width: 12px; height: 1px; background-image: linear-gradient(90deg, var(--sob-fg-4) 1px, transparent 1px); background-size: 6px 1px; opacity: 0.6; }
    .sob-manifest dd { margin: 0; font-size: 15px; font-weight: 500; color: var(--sob-fg); text-align: right; }
    .sob-manifest__who { display: inline-flex; align-items: center; gap: 10px; }

    /* ── Footer ───────────────────────────────────────────── */
    .sob-foot {
      display: flex; align-items: center; gap: 12px 16px; flex-wrap: wrap;
      padding: 16px 24px; border-top: 1px solid var(--sob-line);
      background: linear-gradient(180deg, transparent, rgba(0, 0, 0, 0.22));
      border-radius: 0 0 22px 22px;
    }
    .sob-foot__spacer { flex: 1; }
    .sob-foot__note {
      display: inline-flex; align-items: center; gap: 10px;
      font-family: var(--sob-mono); font-size: 11.5px; letter-spacing: 0.04em; color: var(--sob-fg-3);
    }
    .sob-foot__note .sob-led { background: var(--sob-amber); box-shadow: 0 0 8px var(--sob-amber); animation: sob-blink 1.6s steps(2) infinite; }

    /* ── Done / unlocked ──────────────────────────────────── */
    .sob-done { display: flex; flex-direction: column; align-items: center; text-align: center; padding: 8px 0 12px; }
    .sob-done .sob-sub { margin-left: auto; margin-right: auto; max-width: 480px; text-wrap: balance; }
    .sob-done__model {
      display: flex; align-items: center; justify-content: center; flex-wrap: wrap; gap: 8px 12px;
      max-width: 100%; margin: 2px 0 10px;
      font-family: var(--sob-mono); font-size: 11px; letter-spacing: 0.18em; text-transform: uppercase; color: var(--sob-fg-3);
    }
    .sob-done__model code {
      max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      font-family: var(--sob-mono); font-size: 13px; letter-spacing: 0; text-transform: none; color: var(--sob-gold);
      padding: 5px 12px; border-radius: 8px;
      background: color-mix(in srgb, var(--sob-gold) 8%, transparent);
      border: 1px solid color-mix(in srgb, var(--sob-gold) 24%, transparent);
    }
    .sob-done__emblem { position: relative; display: grid; place-items: center; margin-bottom: 22px; }
    .sob-done__emblem .sob-sigil { animation: sob-emblem 0.9s var(--sob-ease) both; }
    .sob-done__wave {
      position: absolute; width: 150px; height: 150px; border-radius: 50%;
      border: 1px solid var(--sob-gold);
      box-shadow: 0 0 20px color-mix(in srgb, var(--sob-gold) 45%, transparent);
      opacity: 0;
      animation: sob-shockwave 1.4s 0.15s var(--sob-ease) both;
    }
    .sob-done__wave--late { animation-delay: 0.45s; }
    .sob-done .sob-btn--xl { margin-top: 6px; animation: sob-rise 0.7s 0.5s var(--sob-ease) both; }

    /* ── Unlock exit ──────────────────────────────────────── */
    .sob-screen.is-opening .sob-console { animation: sob-open 0.7s var(--sob-ease) forwards; }
    .sob-screen.is-opening .sob-hero { animation: sob-open-hero 0.5s var(--sob-ease) forwards; }
    .sob-screen.is-opening .sob-ground { animation: sob-fade-out 0.7s 0.1s ease forwards; }
    .sob-flash {
      position: fixed; left: 0; right: 0; top: 50%; height: 2px; margin-top: -1px; z-index: 3; pointer-events: none;
      background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--sob-gold) 70%, #fff), transparent);
      box-shadow: 0 0 30px 6px color-mix(in srgb, var(--sob-gold) 45%, transparent);
      opacity: 0;
      animation: sob-flash 0.72s var(--sob-ease) forwards;
    }

    /* ── Keyframes ────────────────────────────────────────── */
    @keyframes sob-rise { from { opacity: 0; transform: translateY(14px); filter: blur(6px); } to { opacity: 1; transform: none; filter: none; } }
    @keyframes sob-power { from { opacity: 0; } to { opacity: 1; } }
    @keyframes sob-door-top { from { transform: none; } to { transform: translateY(-101%); } }
    @keyframes sob-door-bottom { from { transform: none; } to { transform: translateY(101%); } }
    @keyframes sob-seam {
      0% { transform: scaleX(0); opacity: 0; }
      28% { transform: scaleX(1); opacity: 1; }
      45% { transform: scaleX(1); opacity: 1; }
      100% { transform: scaleX(1) scaleY(22); opacity: 0; }
    }
    @keyframes sob-trace {
      0% { transform: scaleX(0); opacity: 0; }
      40% { opacity: 1; }
      100% { transform: scaleX(1); opacity: 0.85; }
    }
    @keyframes sob-lock-on {
      from { opacity: 0; transform: translate(var(--dx), var(--dy)); }
      to { opacity: 1; transform: none; }
    }
    @keyframes sob-resolve { from { opacity: 0; filter: blur(8px); transform: translateY(6px); } to { opacity: 1; filter: none; transform: none; } }
    @keyframes sob-step-in { from { opacity: 0; transform: translateY(10px); filter: blur(4px); } to { opacity: 1; transform: none; filter: none; } }
    @keyframes sob-ping { 0% { transform: scale(1); opacity: 0.8; } 80%, 100% { transform: scale(1.9); opacity: 0; } }
    @keyframes sob-node-lock { 0% { transform: scale(0.8); box-shadow: 0 0 0 0 color-mix(in srgb, var(--sob-gold) 70%, transparent); } 60% { transform: scale(1.08); box-shadow: 0 0 0 8px transparent, var(--sob-glow); } 100% { transform: none; } }
    @keyframes sob-breathe { 50% { opacity: 0.55; transform: scale(0.94); } }
    @keyframes sob-glyph-in { from { opacity: 0; transform: scale(0.82); filter: blur(6px); } to { opacity: 1; transform: none; } }
    @keyframes sob-scanline { from { background-position: -60% 0; } to { background-position: 160% 0; } }
    @keyframes sob-shackle { 0% { transform: translateY(3px); } 55% { transform: translateY(-1.2px); } 100% { transform: none; } }
    @keyframes sob-icon-flash { 0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--sob-gold) 60%, transparent); } 45% { box-shadow: 0 0 0 7px transparent, 0 0 26px color-mix(in srgb, var(--sob-gold) 80%, transparent); } 100% { box-shadow: var(--sob-glow); } }
    @keyframes sob-unlock-in { from { opacity: 0; transform: translateY(8px) scale(0.98); } to { opacity: 1; transform: none; } }
    @keyframes sob-sheen { from { transform: translateX(-100%); } to { transform: translateX(100%); } }
    @keyframes sob-led-on { 0% { transform: scale(0.4); opacity: 0; } 60% { transform: scale(1.6); opacity: 1; } 100% { transform: none; } }
    @keyframes sob-shake { 0%, 100% { transform: none; } 20% { transform: translateX(-6px); } 40% { transform: translateX(5px); } 60% { transform: translateX(-3px); } 80% { transform: translateX(2px); } }
    @keyframes sob-blink { 50% { opacity: 0.35; } }
    @keyframes sob-emblem { 0% { opacity: 0; transform: scale(0.7); filter: blur(8px) brightness(2); } 60% { opacity: 1; transform: scale(1.04); filter: brightness(1.4); } 100% { transform: none; filter: none; } }
    @keyframes sob-shockwave { 0% { opacity: 0.9; transform: scale(0.6); } 100% { opacity: 0; transform: scale(2.3); } }
    @keyframes sob-open { to { opacity: 0; transform: scale(1.035); filter: blur(6px) brightness(1.6); } }
    @keyframes sob-open-hero { to { opacity: 0; transform: translateY(-12px); } }
    @keyframes sob-fade-out { to { opacity: 0; } }
    @keyframes sob-flash {
      0% { transform: scaleX(0); opacity: 0; }
      35% { transform: scaleX(1); opacity: 1; }
      100% { transform: scaleX(1) scaleY(60); opacity: 0; }
    }

    /* ── Short laptop screens: keep the whole console above the fold ── */
    @media (min-width: 861px) and (max-height: 960px) {
      .sob-stage { gap: 18px; padding-top: 26px; padding-bottom: 26px; }
      .sob-hero__title { font-size: 36px; margin: 8px 0 4px; }
      .sob-hero__sub { font-size: 15px; }
      .sob-panel { padding-top: 26px; padding-bottom: 24px; min-height: 360px; }
      .sob-sub { margin-bottom: 20px; }
      .sob-rail { padding-top: 24px; }
      .sob-rail__track { top: calc(24px + 16px); }
      .sob-provscroll { max-height: 236px; }
      /* Seven steps: trade the hero eyebrow for console height. */
      .sob-screen.is-long .sob-stage { gap: 12px; padding-top: 16px; padding-bottom: 16px; }
      .sob-screen.is-long .sob-hero__eyebrow { display: none; }
      .sob-screen.is-long .sob-hero__title { font-size: 32px; margin-top: 0; }
      .sob-screen.is-long .sob-panel { padding-top: 22px; }
      .sob-screen.is-long .sob-sub { margin-bottom: 16px; }
    }

    /* ── Responsive ───────────────────────────────────────── */
    @media (max-width: 860px) {
      .sob-body { grid-template-columns: minmax(0, 1fr); }
      .sob-rail {
        --node-h: auto;
        flex-direction: row; justify-content: space-between;
        padding: 18px 20px 16px; border-right: 0; border-bottom: 1px solid var(--sob-line);
        background: linear-gradient(180deg, rgba(0, 0, 0, 0.18), transparent);
      }
      .sob-rail__track {
        left: calc(20px + 22px); right: calc(20px + 22px); top: calc(18px + 22px); width: auto; height: 1px;
      }
      .sob-rail__fill { transform-origin: left; transform: scaleX(var(--sob-progress, 0)); }
      .sob-node { display: flex; flex-direction: column; align-items: center; gap: 6px; height: auto; min-width: 44px; padding: 6px 0 0; }
      .sob-node__text { align-items: center; }
      .sob-node__code, .sob-node__hint { display: none; }
      .sob-node__label { font-size: 11px; font-family: var(--sob-mono); font-weight: 500; letter-spacing: 0.08em; text-transform: uppercase; white-space: nowrap; }
      .sob-panel { padding: 26px 24px 24px; min-height: 0; }
      .sob-options { grid-template-columns: minmax(0, 1fr); }
      .sob-opt { display: grid; grid-template-columns: 36px 1fr; column-gap: 14px; row-gap: 2px; padding: 14px 44px 14px 14px; }
      .sob-opt__icon { grid-row: span 2; margin: 0; align-self: center; }
      .sob-opt__radio { top: 50%; margin-top: -8px; }
    }
    /* A seven-step rail can't fit its labels across a phone: dots only, current step spelled out below. */
    @media (max-width: 720px) {
      .sob-rail.is-long .sob-node__text { display: none; }
      .sob-rail.is-long .sob-node { min-width: 32px; padding-top: 0; }
      .sob-rail.is-long .sob-rail__track { top: calc(18px + 16px); left: calc(20px + 16px); right: calc(20px + 16px); }
      .sob-rail__now {
        display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
        padding: 10px 20px; border-bottom: 1px solid var(--sob-line);
        font-family: var(--sob-mono); font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--sob-fg);
      }
      .sob-rail__now-code { color: var(--sob-gold); }
      .sob-rail__now-hint { color: var(--sob-fg-3); letter-spacing: 0.06em; text-transform: none; font-family: var(--sob-sans); font-size: 12.5px; }
    }
    @media (max-width: 560px) {
      .sob-stage { padding: 22px 14px 28px; justify-content: flex-start; }
      .sob-hero__title { font-size: 30px; }
      .sob-hero__sub { font-size: 14.5px; }
      .sob-console { border-radius: 18px; }
      .sob-foot { border-radius: 0 0 18px 18px; padding: 14px 16px; }
      .sob-foot__note { order: -1; width: 100%; justify-content: center; }
      .sob-bar { padding: 12px 16px; }
      .sob-bar__path, .sob-bar__link { display: none; }
      .sob-rail { padding: 14px 10px 12px; }
      .sob-rail__track { left: calc(10px + 30px); right: calc(10px + 30px); top: calc(14px + 22px); }
      .sob-node { min-width: 60px; }
      .sob-node__label { font-size: 9.5px; letter-spacing: 0.06em; }
      .sob-panel { padding: 22px 18px 20px; }
      .sob-title { font-size: 25px; }
      .sob-title--hero { font-size: 28px; }
      .sob-sub { font-size: 14.5px; margin-bottom: 20px; }
      .sob-identity { grid-template-columns: minmax(0, 1fr); gap: 18px; justify-items: center; }
      .sob-identity__fields { width: 100%; }
      .sob-sigil--lg { --s: 112px; }
      .sob-sigil--xl { --s: 128px; }
      .sob-done__wave { width: 128px; height: 128px; }
      .sob-provbar__count { letter-spacing: 0.12em; }
      .sob-filter { width: 100%; height: 42px; }
      .sob-provscroll { max-height: 320px; }
      .sob-providers { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
      .sob-prov { grid-template-columns: 32px minmax(0, 1fr); column-gap: 9px; min-height: 56px; padding: 9px 10px 9px 8px; }
      .sob-prov > .sob-led { position: absolute; top: 8px; right: 8px; width: 5px; height: 5px; }
      .sob-prov__mark { width: 32px; height: 32px; border-radius: 8px; font-size: 12.5px; }
      .sob-prov__logo { width: 32px; height: 32px; }
      .sob-prov__z { display: none; }
      .sob-prov__name { font-size: 14px; padding-right: 6px; }
      .sob-prov__status { font-size: 9.5px; letter-spacing: 0.04em; }
      .sob-seg__opt { flex: 1 1 auto; justify-content: center; }
      .sob-keyrow { flex-direction: column; }
      .sob-keyrow .sob-btn { width: 100%; }
      .sob-unlock { flex-wrap: wrap; }
      .sob-unlock__text { flex-basis: calc(100% - 60px); }
      .sob-unlock .sob-link { margin-left: 56px; }
      .sob-unlock__meta { flex-direction: column; align-items: flex-start; gap: 0; }
      .sob-unlock__meta .sob-dot { display: none; }
      .sob-manifest { padding: 4px 14px; }
      .sob-manifest__row { flex-wrap: wrap; gap: 4px 10px; padding: 12px 0; min-height: 0; }
      .sob-manifest__lead { display: none; }
      .sob-manifest dd { text-align: left; width: 100%; }
      .sob-corner { display: none; }
      .sob-btn--xl { width: 100%; }
    }
  </style>`;
}
