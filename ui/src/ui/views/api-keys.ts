import { html, nothing, svg, type TemplateResult } from "lit";
import "../components/provider-logo.js";
import { providerLogoMark } from "../lib/provider-logos";
import type { ApiKeysState, AuthProviderSummary, AuthProfileEntry } from "../controllers/api-keys";
import { KNOWN_PROVIDERS, formatRemainingTime, getProviderInfo } from "../controllers/api-keys";

export type ApiKeysProps = {
  state: ApiKeysState;
  onRefresh: () => void;
  onFilterChange: (filter: string) => void;
  onShowAddDialog: () => void;
  onHideAddDialog: () => void;
  onFormChange: (field: string, value: string) => void;
  onSaveKey: () => void;
  onDeleteKey: (profileId: string) => void;
  onTestKey: (profileId: string) => void;
  onSelectProfile: (profileId: string | null) => void;
};

type CategoryId = "all" | "llm" | "voice" | "media" | "integrations";
type ApiKeysUiState = { category: CategoryId; revealed: Set<string> };

const uiStates = new WeakMap<ApiKeysState, ApiKeysUiState>();

function getUiState(state: ApiKeysState): ApiKeysUiState {
  let uiState = uiStates.get(state);
  if (!uiState) {
    uiState = { category: "all", revealed: new Set() };
    uiStates.set(state, uiState);
  }
  return uiState;
}

const ICONS = {
  key: svg`
    <path d="M15.5 7.5a5 5 0 1 1-1.1 3.13L22 3v4h-3v3h-3l-1.5 1.5" />
  `,
  plus: svg`
    <path d="M12 5v14M5 12h14" />
  `,
  refresh: svg`
    <path d="M20 6v5h-5M4 18v-5h5M6.1 9a7 7 0 0 1 11.4-2.4L20 9M4 15l2.5 2.4A7 7 0 0 0 17.9 15" />
  `,
  search: svg`
    <circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" />
  `,
  close: svg`
    <path d="m6 6 12 12M18 6 6 18" />
  `,
  shield: svg`
    <path d="M12 3 5 6v5c0 4.4 2.8 8.2 7 10 4.2-1.8 7-5.6 7-10V6l-7-3Z" /><path
      d="m9.5 12 1.7 1.7 3.7-4"
    />
  `,
  eye: svg`
    <path d="M2.5 12s3.4-5 9.5-5 9.5 5 9.5 5-3.4 5-9.5 5-9.5-5-9.5-5Z" /><circle
      cx="12"
      cy="12"
      r="2.3"
    />
  `,
  eyeOff: svg`
    <path
      d="m3 3 18 18M10.6 7.1c.5-.1.9-.1 1.4-.1 6.1 0 9.5 5 9.5 5a17.4 17.4 0 0 1-2.2 2.6M6.2 6.2C3.8 7.8 2.5 12 2.5 12s3.4 5 9.5 5c1.3 0 2.5-.2 3.5-.6M10 10l4 4"
    />
  `,
  copy: svg`
    <rect x="9" y="9" width="10" height="10" rx="2" /><path
      d="M15 9V7a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2"
    />
  `,
  check: svg`
    <path d="m5 12 4 4L19 6" />
  `,
  alert: svg`
    <path d="M12 3 2.7 19h18.6L12 3Z" /><path d="M12 9v4M12 16.5h.01" />
  `,
  clock: svg`
    <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />
  `,
  activity: svg`
    <path d="M3 12h4l2-6 4 12 2-6h6" />
  `,
  pencil: svg`
    <path d="m4 20 4.2-1 10.4-10.4a2.1 2.1 0 0 0-3-3L5.2 16 4 20Z" /><path d="m14 7 3 3" />
  `,
  trash: svg`
    <path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5" />
  `,
  lock: svg`
    <rect x="5" y="10" width="14" height="10" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v2" />
  `,
  chevron: svg`
    <path d="m9 18 6-6-6-6" />
  `,
} as const;

function icon(name: keyof typeof ICONS, size = 18): TemplateResult {
  return svg`<svg viewBox="0 0 24 24" width=${size} height=${size} fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
}

const CATEGORY_META: ReadonlyArray<{ id: CategoryId; label: string }> = [
  { id: "all", label: "All keys" },
  { id: "llm", label: "LLM" },
  { id: "voice", label: "Voice" },
  { id: "media", label: "Media" },
  { id: "integrations", label: "Integrations" },
];

function providerCategory(providerId: string): Exclude<CategoryId, "all"> {
  const provider = getProviderInfo(providerId);
  if (providerId === "elevenlabs") return "voice";
  if (provider?.category === "model") return "llm";
  if (provider?.category === "media") return "media";
  return "integrations";
}

function categoryLabel(category: Exclude<CategoryId, "all">): string {
  return CATEGORY_META.find((item) => item.id === category)?.label ?? "Integrations";
}

function providerMonogram(providerId: string, label: string): TemplateResult {
  const monograms: Record<string, string> = {
    anthropic: "AI",
    openai: "OA",
    google: "G",
    groq: "GQ",
    together: "T",
    deepseek: "DS",
    mistral: "M",
    cohere: "C",
    perplexity: "PX",
    fireworks: "FW",
    openrouter: "OR",
    xai: "xAI",
    cerebras: "CB",
    zai: "Z",
    llamacloud: "LC",
    "ollama-cloud": "OC",
    ollama: "OL",
    replicate: "R",
    elevenlabs: "11",
    notion: "N",
    loops: "L",
    github: "GH",
    brave: "B",
    hunter: "H",
    gmail: "M",
    "google-calendar": "31",
    telegram: "TG",
    discord: "D",
    slack: "S",
  };
  const fallback = label
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  if (providerLogoMark(providerId)) return html`<ib-provider-logo class="ak-provider-mark ak-provider-mark--logo" provider=${providerId}></ib-provider-logo>`;
  return html`<span class="ak-provider-mark ak-provider-mark--${providerId}" aria-hidden="true">${monograms[providerId] ?? fallback}</span>`;
}

function statusTone(status: AuthProviderSummary["status"]): "good" | "warn" | "bad" {
  if (status === "ok" || status === "static") return "good";
  if (status === "expiring") return "warn";
  return "bad";
}

function statusLabel(status: AuthProviderSummary["status"]): string {
  if (status === "ok" || status === "static") return "Connected";
  if (status === "missing") return "Missing";
  if (status === "expiring") return "Needs attention";
  return "Invalid";
}

function filteredProviders(state: ApiKeysState, category: CategoryId): AuthProviderSummary[] {
  const query = state.filter.trim().toLowerCase();
  return state.providers
    .filter((provider) => category === "all" || providerCategory(provider.provider) === category)
    .map((provider) => ({
      ...provider,
      profiles: provider.profiles.filter((profile) => {
        if (!query) return true;
        const info = getProviderInfo(profile.provider);
        return [profile.provider, info?.label, profile.label, profile.profileId, profile.email]
          .filter(Boolean)
          .some((value) => value!.toLowerCase().includes(query));
      }),
    }))
    .filter((provider) => provider.profiles.length > 0);
}

function closeDialog(props: ApiKeysProps): void {
  props.onSelectProfile(null);
  props.onHideAddDialog();
}

function openAddDialog(props: ApiKeysProps, provider = ""): void {
  props.onSelectProfile(null);
  if (provider) props.onFormChange("provider", provider);
  props.onShowAddDialog();
}

function openEditDialog(profile: AuthProfileEntry, props: ApiKeysProps): void {
  const suffix = profile.profileId.startsWith(`${profile.provider}:`)
    ? profile.profileId.slice(profile.provider.length + 1)
    : profile.label;
  props.onSelectProfile(profile.profileId);
  props.onFormChange("provider", profile.provider);
  props.onFormChange("profileName", suffix || "default");
  props.onFormChange("key", "");
  props.onFormChange("email", profile.email ?? "");
  props.onShowAddDialog();
}

export function renderApiKeys(props: ApiKeysProps) {
  const { state } = props;
  const uiState = getUiState(state);
  const visibleProviders = filteredProviders(state, uiState.category);
  const connectedCount = state.providers.filter(
    (provider) => statusTone(provider.status) === "good",
  ).length;
  const attentionCount = state.providers.filter(
    (provider) => statusTone(provider.status) !== "good",
  ).length;
  const visibleCategories = (["llm", "voice", "media", "integrations"] as const)
    .map((category) => ({
      category,
      providers: visibleProviders.filter(
        (provider) => providerCategory(provider.provider) === category,
      ),
    }))
    .filter((group) => group.providers.length > 0);

  return html`
    <main class="ak-page" data-testid="api-keys-page">
      <section class="ak-hero" data-learn-id="apikeys-header">
        <div class="ak-hero__aurora" aria-hidden="true"></div>
        <div class="ak-hero__content">
          <div class="ak-eyebrow">${icon("shield", 15)} Credential vault</div>
          <h1>API Keys</h1>
          <p>Secure the providers that power your InfiniBot workspace. Every secret stays encrypted and write-only.</p>
          <div class="ak-hero__actions">
            <button class="ak-btn ak-btn--quiet" ?disabled=${state.loading} @click=${props.onRefresh}>
              <span class=${state.loading ? "ak-spin" : ""}>${icon("refresh", 16)}</span>
              ${state.loading ? "Refreshing" : "Refresh"}
            </button>
            <button class="ak-btn ak-btn--primary" data-learn-id="apikeys-add" data-ib-target="control:apikeys/add" @click=${() => openAddDialog(props)}>
              ${icon("plus", 17)} Add credential
            </button>
          </div>
        </div>
        <div class="ak-hero__metrics" aria-label="Credential overview">
          <div class="ak-metric"><span class="ak-metric__value">${state.profileCount}</span><span class="ak-metric__label">Credentials</span></div>
          <div class="ak-metric"><span class="ak-metric__value ak-metric__value--good">${connectedCount}</span><span class="ak-metric__label">Connected</span></div>
          <div class="ak-metric"><span class="ak-metric__value ${attentionCount ? "ak-metric__value--warn" : ""}">${attentionCount}</span><span class="ak-metric__label">Attention</span></div>
        </div>
      </section>

      <section class="ak-command-bar" aria-label="Search and filter credentials">
        <label class="ak-search">
          <span>${icon("search", 18)}</span>
          <span class="ak-sr-only">Search credentials</span>
          <input type="search" data-learn-id="apikeys-search" placeholder="Search providers, profiles, or accounts" autocomplete="off" .value=${state.filter} @input=${(event: Event) => props.onFilterChange((event.target as HTMLInputElement).value)} />
          ${
            state.filter
              ? html`<button class="ak-icon-btn" aria-label="Clear search" @click=${() => props.onFilterChange("")}>${icon("close", 15)}</button>`
              : html`
                  <span class="ak-shortcut" aria-hidden="true">Ctrl K</span>
                `
          }
        </label>
        <div class="ak-segmented" role="group" aria-label="Credential category">
          ${CATEGORY_META.map(
            (item) => html`
            <button class="ak-segment ${uiState.category === item.id ? "is-active" : ""}" aria-pressed=${uiState.category === item.id} @click=${() => {
              uiState.category = item.id;
              props.onFilterChange(state.filter);
            }}>${item.label}</button>
          `,
          )}
        </div>
      </section>

      ${state.error ? html`<div class="ak-callout ak-callout--danger" role="alert">${icon("alert", 18)}<div><strong>Couldn’t load the vault</strong><span>${state.error}</span></div></div>` : nothing}

      ${
        state.loading && state.providers.length === 0
          ? renderSkeletons()
          : visibleCategories.length === 0
            ? renderEmptyState(state.filter, uiState.category, props)
            : html`<div class="ak-groups">
              ${visibleCategories.map(
                (group) => html`
                <section class="ak-group" aria-labelledby="ak-group-${group.category}">
                  <header class="ak-group__header">
                    <div><span class="ak-group__index">0${CATEGORY_META.findIndex((item) => item.id === group.category)}</span><h2 id="ak-group-${group.category}">${categoryLabel(group.category)}</h2></div>
                    <span>${group.providers.length} ${group.providers.length === 1 ? "provider" : "providers"}</span>
                  </header>
                  <div class="ak-grid">${group.providers.map((provider) => renderProviderCard(provider, props, uiState))}</div>
                </section>
              `,
              )}
            </div>`
      }

      ${!state.loading ? renderQuickAddSection(state.providers, state.filter, uiState.category, props) : nothing}
      ${state.showAddDialog ? renderAddDialog(props) : nothing}
    </main>

    <style>
      .ak-page {
        --ak-glass-1: color-mix(in srgb, var(--g-surface) 78%, transparent);
        --ak-glass-2: color-mix(in srgb, var(--g-surface-strong) 82%, transparent);
        --ak-glass-3: color-mix(in srgb, var(--g-surface-strong) 94%, transparent);
        --ak-glass-4: color-mix(in srgb, var(--g-bg) 90%, var(--g-surface-strong));
        --ak-stroke: var(--g-border);
        --ak-stroke-strong: var(--g-border-strong);
        --ak-elev-1: var(--g-shadow-sm), inset 0 1px 0 var(--g-edge-light, var(--g-border));
        --ak-elev-2: var(--g-shadow), inset 0 1px 0 var(--g-edge-light, var(--g-border)), inset 0 -1px 0 var(--g-edge-shadow, var(--g-border));
        --ak-elev-3: var(--g-shadow-lg), 0 0 0 1px color-mix(in srgb, var(--g-primary) 5%, transparent), inset 0 1px 0 var(--g-edge-light, var(--g-border));
        --ak-elev-4: var(--g-shadow-lg), 0 0 56px color-mix(in srgb, var(--g-primary) 12%, transparent), inset 0 1px 0 var(--g-edge-light, var(--g-border));
        position: relative; isolation: isolate; max-width: 1480px; min-height: 100%; margin: 0 auto;
        padding: 30px clamp(18px, 3vw, 42px) 64px; color: var(--g-fg); font-family: var(--g-font-family);
      }
      .ak-page::before { content: ""; position: absolute; inset: 0; z-index: -2; pointer-events: none; opacity: .025; background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 140 140' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='.8'/%3E%3C/svg%3E"); mix-blend-mode: overlay; }
      .ak-page::after { content: ""; position: fixed; inset: 0; z-index: -3; pointer-events: none; background: radial-gradient(circle at 50% 10%, transparent, color-mix(in srgb, var(--g-bg-deep) 46%, transparent) 76%); }

      .ak-hero { position: relative; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: clamp(26px, 5vw, 80px); overflow: hidden; padding: clamp(28px, 5vw, 56px); border: 1px solid var(--ak-stroke); border-radius: calc(var(--g-radius-lg) + 6px); background: linear-gradient(135deg, var(--ak-glass-3), var(--ak-glass-1)); backdrop-filter: var(--g-blur-heavy); -webkit-backdrop-filter: var(--g-blur-heavy); box-shadow: var(--ak-elev-3); }
      .ak-hero::before { content: ""; position: absolute; inset: 0 0 auto; height: 1px; background: linear-gradient(90deg, transparent, var(--g-primary), transparent); opacity: .8; }
      .ak-hero__aurora { position: absolute; width: 72%; aspect-ratio: 1.65; top: -52%; left: 2%; border-radius: 50%; background: radial-gradient(ellipse at 42% 58%, var(--g-primary-strong), var(--g-primary-muted) 34%, var(--g-accent-soft) 54%, transparent 74%); filter: blur(27px); opacity: .96; animation: ak-breathe 8s ease-in-out infinite alternate; pointer-events: none; }
      .ak-hero__content { position: relative; z-index: 1; max-width: 730px; }
      .ak-eyebrow { display: inline-flex; align-items: center; gap: 8px; margin-bottom: 18px; color: var(--g-primary); font-size: 11px; font-weight: 700; letter-spacing: .17em; text-transform: uppercase; }
      .ak-hero h1 { margin: 0; font-size: clamp(38px, 5vw, 64px); font-weight: 650; letter-spacing: -.055em; line-height: .96; background: linear-gradient(112deg, var(--g-fg), var(--g-primary)); -webkit-background-clip: text; background-clip: text; color: transparent; }
      .ak-hero p { max-width: 610px; margin: 20px 0 0; color: var(--g-fg-dim); font-size: clamp(14px, 1.5vw, 17px); line-height: 1.65; }
      .ak-hero__actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 28px; }
      .ak-hero__metrics { position: relative; z-index: 1; display: grid; grid-template-columns: repeat(3, minmax(84px, 1fr)); min-width: min(100%, 330px); align-self: end; border: 1px solid var(--ak-stroke); border-radius: var(--g-radius-lg); background: var(--ak-glass-2); box-shadow: var(--ak-elev-1); backdrop-filter: var(--g-blur); -webkit-backdrop-filter: var(--g-blur); }
      .ak-metric { position: relative; padding: 20px 18px; text-align: center; }
      .ak-metric + .ak-metric::before { content: ""; position: absolute; left: 0; top: 22%; bottom: 22%; width: 1px; background: var(--ak-stroke); }
      .ak-metric__value { display: block; font-size: 28px; font-weight: 650; letter-spacing: -.05em; }
      .ak-metric__value--good { color: var(--g-success); }
      .ak-metric__value--warn { color: var(--g-warning); }
      .ak-metric__label { display: block; margin-top: 5px; color: var(--g-fg-faint); font-size: 10px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }

      .ak-btn, .ak-icon-btn, .ak-segment, .ak-provider-select, .ak-available-card, .ak-link-btn { font: inherit; }
      .ak-btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 42px; padding: 0 16px; border: 1px solid var(--ak-stroke); border-radius: var(--g-radius-sm); color: var(--g-fg); background: var(--ak-glass-2); box-shadow: var(--ak-elev-1); cursor: pointer; transition: transform var(--g-motion-fast), border-color var(--g-motion-fast), background var(--g-motion-fast), box-shadow var(--g-motion-fast); }
      .ak-btn:hover:not(:disabled) { transform: translateY(-2px); border-color: var(--ak-stroke-strong); background: var(--g-surface-hover); }
      .ak-btn:active:not(:disabled) { transform: translateY(0); }
      .ak-btn:disabled { opacity: .48; cursor: not-allowed; }
      .ak-btn--primary { border-color: var(--ak-stroke-strong); background: linear-gradient(135deg, var(--g-primary-strong), var(--g-primary-muted)); color: var(--g-fg); box-shadow: var(--ak-elev-2), 0 0 24px var(--g-primary-soft); }
      .ak-btn--danger { color: var(--g-danger); border-color: var(--g-danger-border); background: var(--g-danger-soft); }
      .ak-btn--small { min-height: 34px; padding: 0 11px; font-size: 12px; }

      .ak-command-bar { position: sticky; top: 10px; z-index: 12; display: grid; grid-template-columns: minmax(260px, 1fr) auto; gap: 14px; align-items: center; margin: 22px 0 34px; padding: 12px; border: 1px solid var(--ak-stroke); border-radius: var(--g-radius-lg); background: var(--ak-glass-4); box-shadow: var(--ak-elev-2); backdrop-filter: var(--g-blur-heavy); -webkit-backdrop-filter: var(--g-blur-heavy); }
      .ak-search { display: flex; align-items: center; gap: 10px; min-width: 0; height: 44px; padding: 0 12px; border: 1px solid var(--ak-stroke); border-radius: var(--g-radius-sm); color: var(--g-fg-faint); background: var(--ak-glass-1); transition: border-color var(--g-motion-fast), box-shadow var(--g-motion-fast); }
      .ak-search:focus-within { border-color: var(--ak-stroke-strong); box-shadow: 0 0 0 3px var(--g-primary-soft); color: var(--g-primary); }
      .ak-search input { flex: 1; min-width: 0; height: 100%; padding: 0; border: 0; outline: 0; color: var(--g-fg); background: transparent; font: inherit; font-size: 13px; }
      .ak-search input::placeholder { color: var(--g-fg-faint); }
      .ak-search input::-webkit-search-cancel-button { display: none; }
      .ak-shortcut { padding: 3px 7px; border: 1px solid var(--ak-stroke); border-radius: 6px; color: var(--g-fg-faint); font-size: 10px; }
      .ak-icon-btn { display: inline-grid; place-items: center; width: 32px; height: 32px; flex: 0 0 auto; padding: 0; border: 1px solid transparent; border-radius: 8px; color: var(--g-fg-dim); background: transparent; cursor: pointer; transition: color var(--g-motion-fast), background var(--g-motion-fast), border-color var(--g-motion-fast); }
      .ak-icon-btn:hover { color: var(--g-primary); border-color: var(--ak-stroke); background: var(--g-primary-soft); }
      .ak-segmented { display: flex; align-items: center; gap: 4px; padding: 4px; overflow-x: auto; border: 1px solid var(--ak-stroke); border-radius: var(--g-radius-sm); background: var(--ak-glass-1); scrollbar-width: none; }
      .ak-segmented::-webkit-scrollbar { display: none; }
      .ak-segment { min-height: 34px; padding: 0 12px; border: 1px solid transparent; border-radius: 7px; color: var(--g-fg-faint); background: transparent; font-size: 11px; font-weight: 700; letter-spacing: .05em; white-space: nowrap; cursor: pointer; transition: color var(--g-motion-fast), background var(--g-motion-fast), border-color var(--g-motion-fast); }
      .ak-segment:hover { color: var(--g-fg); }
      .ak-segment.is-active { color: var(--g-primary); border-color: var(--ak-stroke); background: var(--g-primary-soft); box-shadow: inset 0 1px 0 var(--g-edge-light, var(--g-border)); }

      .ak-callout { display: flex; gap: 12px; align-items: flex-start; margin-bottom: 24px; padding: 16px 18px; border: 1px solid var(--g-danger-border); border-radius: var(--g-radius); color: var(--g-danger); background: var(--g-danger-soft); box-shadow: var(--ak-elev-1); }
      .ak-callout strong, .ak-callout span { display: block; }
      .ak-callout strong { margin-bottom: 3px; font-size: 13px; }
      .ak-callout span { color: var(--g-fg-dim); font-size: 12px; }
      .ak-groups { display: grid; gap: 38px; }
      .ak-group__header { display: flex; align-items: end; justify-content: space-between; gap: 16px; margin-bottom: 15px; }
      .ak-group__header > div { display: flex; align-items: center; gap: 10px; }
      .ak-group__header h2 { margin: 0; color: var(--g-fg); font-size: 14px; font-weight: 700; letter-spacing: .13em; text-transform: uppercase; }
      .ak-group__header > span { color: var(--g-fg-faint); font-size: 11px; }
      .ak-group__index { color: var(--g-primary); font-size: 10px; font-weight: 800; letter-spacing: .08em; }
      .ak-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 390px), 1fr)); gap: 18px; }

      .ak-card { position: relative; overflow: hidden; border: 1px solid var(--ak-stroke); border-radius: var(--g-radius-lg); background: linear-gradient(145deg, var(--ak-glass-3), var(--ak-glass-1)); box-shadow: var(--ak-elev-2); backdrop-filter: var(--g-blur); -webkit-backdrop-filter: var(--g-blur); transition: transform var(--g-motion-medium), border-color var(--g-motion-medium), box-shadow var(--g-motion-medium); }
      .ak-card::before { content: ""; position: absolute; inset: 0 8% auto; height: 1px; background: linear-gradient(90deg, transparent, var(--g-edge-light, var(--g-border-strong)), transparent); pointer-events: none; }
      .ak-card:hover { transform: translateY(-4px); border-color: var(--ak-stroke-strong); box-shadow: var(--ak-elev-3), 0 0 30px var(--g-primary-soft); }
      .ak-card__header { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 20px; border-bottom: 1px solid var(--ak-stroke); background: linear-gradient(110deg, var(--g-primary-soft), transparent 44%); }
      .ak-card__identity { display: flex; align-items: center; min-width: 0; gap: 12px; }
      .ak-provider-mark { display: grid; place-items: center; width: 42px; height: 42px; flex: 0 0 auto; border: 1px solid var(--ak-stroke-strong); border-radius: 13px; color: var(--g-primary); background: linear-gradient(145deg, var(--g-primary-muted), var(--ak-glass-2)); box-shadow: 0 8px 24px var(--g-primary-soft), inset 0 1px 0 var(--g-edge-light, var(--g-border)); font-size: 12px; font-weight: 800; letter-spacing: -.02em; }
      .ak-provider-mark--logo { border: 0; background: none; box-shadow: none; }
      .ak-provider-mark--openai, .ak-provider-mark--anthropic, .ak-provider-mark--github, .ak-provider-mark--notion { border-radius: 50%; }
      .ak-card__name { min-width: 0; }
      .ak-card__name strong { display: block; overflow: hidden; color: var(--g-fg); font-size: 15px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
      .ak-card__name span { display: block; margin-top: 3px; color: var(--g-fg-dim); font-size: 10px; letter-spacing: .08em; text-transform: uppercase; }
      .ak-status { display: inline-flex; align-items: center; gap: 7px; flex: 0 0 auto; padding: 6px 9px; border: 1px solid var(--g-neutral-border); border-radius: 999px; color: var(--g-neutral); background: var(--g-neutral-soft); font-size: 10px; font-weight: 750; letter-spacing: .05em; text-transform: uppercase; }
      .ak-status::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; box-shadow: 0 0 10px currentColor; }
      .ak-status--good { color: var(--g-success); border-color: var(--g-success-border); background: var(--g-success-soft); }
      .ak-status--warn { color: var(--g-warning); border-color: var(--g-warning-border); background: var(--g-warning-soft); }
      .ak-status--bad { color: var(--g-danger); border-color: var(--g-danger-border); background: var(--g-danger-soft); }
      .ak-card__body { padding: 4px 20px; }
      .ak-profile { padding: 18px 0; }
      .ak-profile + .ak-profile { border-top: 1px solid var(--ak-stroke); }
      .ak-profile__top { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; }
      .ak-profile__title { min-width: 0; }
      .ak-profile__title strong { display: block; overflow: hidden; color: var(--g-fg); font-size: 13px; font-weight: 620; text-overflow: ellipsis; white-space: nowrap; }
      .ak-profile__title span { display: block; overflow: hidden; margin-top: 4px; color: var(--g-fg-dim); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
      .ak-secret { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; gap: 5px; margin-top: 14px; padding: 6px 6px 6px 12px; border: 1px solid var(--ak-stroke); border-radius: 10px; background: color-mix(in srgb, var(--g-bg-deep) 42%, transparent); }
      .ak-secret code { overflow: hidden; color: var(--g-fg-dim); font-family: var(--g-font-family); font-size: 11px; font-variant-numeric: tabular-nums; letter-spacing: .08em; text-overflow: ellipsis; white-space: nowrap; }
      .ak-secret code.is-hidden { letter-spacing: .16em; }
      .ak-profile__facts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 9px; margin-top: 13px; }
      .ak-fact { display: flex; align-items: flex-start; gap: 8px; min-width: 0; color: var(--g-fg-faint); }
      .ak-fact > span:first-child { display: grid; place-items: center; width: 25px; height: 25px; flex: 0 0 auto; border: 1px solid var(--ak-stroke); border-radius: 7px; color: var(--g-primary); background: var(--g-primary-soft); }
      .ak-fact strong, .ak-fact small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .ak-fact strong { color: var(--g-fg-dim); font-size: 11px; font-weight: 650; }
      .ak-fact small { margin-top: 2px; color: var(--g-fg-dim); font-size: 10px; }
      .ak-test-result { display: flex; align-items: center; gap: 8px; margin-top: 13px; padding: 9px 11px; border: 1px solid var(--g-danger-border); border-radius: 9px; color: var(--g-danger); background: var(--g-danger-soft); font-size: 11px; animation: ak-success-in var(--g-motion-slow); }
      .ak-test-result--success { color: var(--g-success); border-color: var(--g-success-border); background: var(--g-success-soft); }
      .ak-profile__actions { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 15px; }

      .ak-available { margin-top: 46px; padding-top: 28px; border-top: 1px solid var(--ak-stroke); }
      .ak-available__header { display: flex; justify-content: space-between; gap: 16px; align-items: end; margin-bottom: 15px; }
      .ak-available__header h2 { margin: 0; color: var(--g-fg); font-size: 18px; font-weight: 640; letter-spacing: -.02em; }
      .ak-available__header p { margin: 5px 0 0; color: var(--g-fg-faint); font-size: 12px; }
      .ak-available__header > span { color: var(--g-fg-faint); font-size: 11px; }
      .ak-available__grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 10px; }
      .ak-available-card { display: flex; align-items: center; gap: 10px; min-height: 64px; padding: 10px 12px; text-align: left; border: 1px solid var(--ak-stroke); border-radius: var(--g-radius); color: var(--g-fg); background: var(--ak-glass-1); box-shadow: var(--ak-elev-1); cursor: pointer; transition: transform var(--g-motion-fast), border-color var(--g-motion-fast), background var(--g-motion-fast); }
      .ak-available-card:hover { transform: translateY(-2px); border-color: var(--ak-stroke-strong); background: var(--g-primary-soft); }
      .ak-available-card .ak-provider-mark { width: 34px; height: 34px; border-radius: 10px; font-size: 10px; }
      .ak-available-card__text { flex: 1; min-width: 0; }
      .ak-available-card__text strong, .ak-available-card__text span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .ak-available-card__text strong { font-size: 12px; }
      .ak-available-card__text span { margin-top: 3px; color: var(--g-fg-faint); font-size: 9px; letter-spacing: .07em; text-transform: uppercase; }
      .ak-available-card > svg { color: var(--g-fg-faint); }

      .ak-empty { display: grid; place-items: center; min-height: 350px; padding: 44px 20px; text-align: center; border: 1px dashed var(--ak-stroke-strong); border-radius: var(--g-radius-lg); background: linear-gradient(145deg, var(--ak-glass-2), transparent); box-shadow: var(--ak-elev-1); }
      .ak-empty__icon { display: grid; place-items: center; width: 64px; height: 64px; margin: 0 auto 20px; border: 1px solid var(--ak-stroke-strong); border-radius: 20px; color: var(--g-primary); background: var(--g-primary-soft); box-shadow: 0 0 34px var(--g-primary-muted), inset 0 1px 0 var(--g-edge-light, var(--g-border)); }
      .ak-empty h2 { margin: 0; font-size: 20px; font-weight: 640; letter-spacing: -.025em; }
      .ak-empty p { max-width: 460px; margin: 9px auto 22px; color: var(--g-fg-dim); font-size: 13px; line-height: 1.6; }
      .ak-skeleton-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 390px), 1fr)); gap: 18px; }
      .ak-skeleton { height: 310px; overflow: hidden; border: 1px solid var(--ak-stroke); border-radius: var(--g-radius-lg); background: var(--ak-glass-1); box-shadow: var(--ak-elev-1); }
      .ak-skeleton::after { content: ""; display: block; width: 45%; height: 100%; transform: translateX(-120%); background: linear-gradient(90deg, transparent, var(--g-primary-soft), transparent); animation: ak-shimmer 1.6s ease-in-out infinite; }

      .ak-dialog-overlay { position: fixed; inset: 0; z-index: 2147483647; display: grid; place-items: center; padding: 22px; background: color-mix(in srgb, var(--g-bg-deep) 78%, transparent); backdrop-filter: var(--g-blur-heavy); -webkit-backdrop-filter: var(--g-blur-heavy); transform: translateZ(0); isolation: isolate; animation: ak-fade-in var(--g-motion-medium); }
      .content:has(.ak-dialog-overlay) > .host-subtabs { visibility: hidden; pointer-events: none; }
      .ak-dialog { position: relative; width: min(100%, 610px); max-height: min(90vh, 820px); overflow: auto; border: 1px solid var(--ak-stroke-strong); border-radius: calc(var(--g-radius-lg) + 4px); background: linear-gradient(145deg, var(--ak-glass-4), var(--g-bg)); box-shadow: var(--ak-elev-4); animation: ak-dialog-in var(--g-motion-slow); }
      .ak-dialog::before { content: ""; position: absolute; inset: 0 9% auto; height: 1px; background: linear-gradient(90deg, transparent, var(--g-primary), transparent); }
      .ak-dialog__header { display: flex; justify-content: space-between; gap: 18px; align-items: flex-start; padding: 24px 24px 20px; border-bottom: 1px solid var(--ak-stroke); background: linear-gradient(120deg, var(--g-primary-soft), transparent 58%); }
      .ak-dialog__eyebrow { color: var(--g-primary); font-size: 9px; font-weight: 750; letter-spacing: .15em; text-transform: uppercase; }
      .ak-dialog__header h2 { margin: 7px 0 0; color: var(--g-fg); font-size: 22px; font-weight: 640; letter-spacing: -.03em; }
      .ak-dialog__body { padding: 24px; }
      .ak-dialog__footer { position: sticky; bottom: 0; display: flex; justify-content: flex-end; gap: 9px; padding: 16px 24px 20px; border-top: 1px solid var(--ak-stroke); background: var(--ak-glass-4); backdrop-filter: var(--g-blur-heavy); -webkit-backdrop-filter: var(--g-blur-heavy); }
      .ak-provider-select-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 9px; }
      .ak-provider-select { display: flex; flex-direction: column; align-items: center; gap: 8px; min-height: 96px; padding: 12px 8px; border: 1px solid var(--ak-stroke); border-radius: var(--g-radius); color: var(--g-fg-dim); background: var(--ak-glass-1); cursor: pointer; transition: transform var(--g-motion-fast), border-color var(--g-motion-fast), background var(--g-motion-fast); }
      .ak-provider-select:hover { transform: translateY(-2px); border-color: var(--ak-stroke-strong); background: var(--g-primary-soft); }
      .ak-provider-select .ak-provider-mark { width: 36px; height: 36px; border-radius: 10px; font-size: 10px; }
      .ak-provider-select span:last-child { max-width: 100%; overflow: hidden; font-size: 10px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
      .ak-selected-provider { display: flex; align-items: center; gap: 12px; padding: 12px; border: 1px solid var(--ak-stroke); border-radius: var(--g-radius); background: var(--g-primary-soft); }
      .ak-selected-provider__text { flex: 1; min-width: 0; }
      .ak-selected-provider__text strong, .ak-selected-provider__text span { display: block; }
      .ak-selected-provider__text strong { color: var(--g-fg); font-size: 13px; }
      .ak-selected-provider__text span { margin-top: 3px; color: var(--g-fg-faint); font-size: 10px; }
      .ak-link-btn { padding: 5px; border: 0; color: var(--g-primary); background: transparent; font-size: 11px; cursor: pointer; }
      .ak-form-group { margin-bottom: 18px; }
      .ak-form-group:last-child { margin-bottom: 0; }
      .ak-form-label { display: flex; justify-content: space-between; gap: 10px; margin-bottom: 7px; color: var(--g-fg-dim); font-size: 11px; font-weight: 650; }
      .ak-form-label span { color: var(--g-fg-faint); font-size: 9px; font-weight: 500; letter-spacing: .08em; text-transform: uppercase; }
      .ak-input { width: 100%; min-height: 45px; padding: 0 13px; border: 1px solid var(--ak-stroke); border-radius: var(--g-radius-sm); outline: 0; color: var(--g-fg); background: color-mix(in srgb, var(--g-bg-deep) 34%, transparent); box-shadow: inset 0 1px 0 var(--g-edge-shadow, var(--g-border)); font: inherit; font-size: 13px; box-sizing: border-box; transition: border-color var(--g-motion-fast), box-shadow var(--g-motion-fast); }
      .ak-input:focus { border-color: var(--ak-stroke-strong); box-shadow: 0 0 0 3px var(--g-primary-soft), inset 0 1px 0 var(--g-edge-shadow, var(--g-border)); }
      .ak-input::placeholder { color: var(--g-fg-faint); }
      .ak-help { display: flex; align-items: flex-start; gap: 7px; margin-top: 7px; color: var(--g-fg-faint); font-size: 10px; line-height: 1.5; }
      .ak-security-note { display: flex; gap: 11px; margin-top: 21px; padding: 13px; border: 1px solid var(--ak-stroke); border-radius: var(--g-radius); color: var(--g-fg-dim); background: var(--g-primary-soft); font-size: 10px; line-height: 1.55; }
      .ak-security-note > span { color: var(--g-primary); }
      .ak-sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; }
      .ak-page svg { stroke-width: 2; }
      .ak-page button:focus-visible, .ak-page input:focus-visible { outline: 2px solid var(--g-primary); outline-offset: 3px; }

      html[data-theme="light"] .ak-page,
      html[data-theme-mode="light"] .ak-page {
        --g-bg: var(--bg-content);
        --g-bg-deep: var(--bg-muted);
        --g-fg: var(--card-foreground);
        --g-fg-dim: var(--chat-text);
        --g-fg-faint: color-mix(in srgb, var(--card-foreground) 60%, transparent);
        --g-surface: color-mix(in srgb, var(--card) 76%, transparent);
        --g-surface-strong: color-mix(in srgb, var(--card) 94%, transparent);
        --g-surface-hover: var(--card);
        --ak-glass-1: color-mix(in srgb, var(--g-surface) 94%, var(--g-bg));
        --ak-glass-2: color-mix(in srgb, var(--g-surface-strong) 96%, var(--g-bg));
        --ak-glass-3: color-mix(in srgb, var(--g-surface-strong) 92%, var(--g-primary-soft));
        --ak-glass-4: var(--g-surface-strong);
        --ak-stroke: var(--g-border-strong);
      }
      html[data-theme="light"] .ak-page::after,
      html[data-theme-mode="light"] .ak-page::after { background: radial-gradient(circle at 50% 8%, var(--g-primary-soft), transparent 56%), var(--g-bg); }
      html[data-theme="light"] .ak-hero__aurora,
      html[data-theme-mode="light"] .ak-hero__aurora { opacity: .28; filter: blur(48px); }
      html[data-theme="light"] .ak-command-bar,
      html[data-theme-mode="light"] .ak-command-bar,
      html[data-theme="light"] .ak-dialog__footer,
      html[data-theme-mode="light"] .ak-dialog__footer { background: var(--g-surface-strong); }
      html[data-theme="light"] .ak-search,
      html[data-theme-mode="light"] .ak-search,
      html[data-theme="light"] .ak-segmented,
      html[data-theme-mode="light"] .ak-segmented,
      html[data-theme="light"] .ak-secret,
      html[data-theme-mode="light"] .ak-secret,
      html[data-theme="light"] .ak-input,
      html[data-theme-mode="light"] .ak-input { background: var(--g-surface); }
      html[data-theme="light"] .ak-card,
      html[data-theme-mode="light"] .ak-card { background: linear-gradient(145deg, var(--g-surface-strong), var(--g-surface)); }
      html[data-theme="light"] .ak-card__header,
      html[data-theme-mode="light"] .ak-card__header { background: linear-gradient(110deg, var(--g-primary-soft), var(--g-surface-strong) 72%); }
      html[data-theme="light"] .ak-status--good,
      html[data-theme-mode="light"] .ak-status--good { color: color-mix(in srgb, var(--g-success) 68%, var(--g-fg)); }
      html[data-theme="light"] .ak-status--warn,
      html[data-theme-mode="light"] .ak-status--warn { color: color-mix(in srgb, var(--g-warning) 68%, var(--g-fg)); }
      html[data-theme="light"] .ak-status--bad,
      html[data-theme-mode="light"] .ak-status--bad,
      html[data-theme="light"] .ak-btn--danger,
      html[data-theme-mode="light"] .ak-btn--danger { color: color-mix(in srgb, var(--g-danger) 72%, var(--g-fg)); }
      html[data-theme="light"] .ak-eyebrow,
      html[data-theme-mode="light"] .ak-eyebrow,
      html[data-theme="light"] .ak-segment.is-active,
      html[data-theme-mode="light"] .ak-segment.is-active { color: color-mix(in srgb, var(--g-primary) 58%, var(--g-fg)); }
      html[data-theme="light"] .ak-metric__value--warn,
      html[data-theme-mode="light"] .ak-metric__value--warn { color: color-mix(in srgb, var(--g-warning) 64%, var(--g-fg)); }
      html[data-theme="light"] .ak-card__name span,
      html[data-theme-mode="light"] .ak-card__name span,
      html[data-theme="light"] .ak-profile__title span,
      html[data-theme-mode="light"] .ak-profile__title span,
      html[data-theme="light"] .ak-fact small,
      html[data-theme-mode="light"] .ak-fact small,
      html[data-theme="light"] .ak-metric__label,
      html[data-theme-mode="light"] .ak-metric__label { color: var(--g-fg-dim); }

      @keyframes ak-breathe { to { transform: translate3d(14%, 8%, 0) scale(1.12); opacity: .62; } }
      @keyframes ak-spin { to { transform: rotate(1turn); } }
      @keyframes ak-shimmer { to { transform: translateX(260%); } }
      @keyframes ak-fade-in { from { opacity: 0; } }
      @keyframes ak-dialog-in { from { opacity: 0; transform: translateY(18px) scale(.985); } }
      @keyframes ak-success-in { from { opacity: 0; transform: translateY(5px); } }
      .ak-spin { display: inline-flex; animation: ak-spin 1s linear infinite; }

      @media (max-width: 880px) {
        .ak-hero { grid-template-columns: 1fr; }
        .ak-hero__metrics { width: 100%; }
        .ak-command-bar { position: relative; top: auto; grid-template-columns: 1fr; }
        .ak-segmented { width: 100%; box-sizing: border-box; }
      }
      @media (max-width: 560px) {
        .ak-page { padding: 14px 12px 44px; }
        .ak-page:has(.ak-dialog-overlay) > :not(.ak-dialog-overlay) { visibility: hidden; }
        .ak-hero { padding: 24px 18px 18px; border-radius: var(--g-radius-lg); }
        .ak-hero h1 { font-size: 40px; }
        .ak-hero p { font-size: 13px; }
        .ak-hero__actions { display: grid; grid-template-columns: 1fr; }
        .ak-btn { width: 100%; }
        .ak-metric { padding: 15px 8px; }
        .ak-metric__value { font-size: 23px; }
        .ak-metric__label { font-size: 8px; }
        .ak-command-bar { margin: 14px 0 28px; padding: 8px; }
        .ak-shortcut { display: none; }
        .ak-segmented { display: flex; overflow-x: auto; }
        .ak-segment { flex: 0 0 auto; min-width: 0; padding: 0 10px; }
        .ak-group__header { align-items: center; }
        .ak-grid { grid-template-columns: 1fr; }
        .ak-card__header { padding: 16px; }
        .ak-card__body { padding: 2px 16px; }
        .ak-profile__top { flex-direction: column; }
        .ak-status { align-self: flex-start; }
        .ak-profile__facts { grid-template-columns: 1fr; }
        .ak-profile__actions { display: grid; grid-template-columns: repeat(3, 1fr); }
        .ak-profile__actions .ak-btn { padding: 0 6px; font-size: 10px; }
        .ak-available__header { align-items: flex-start; flex-direction: column; }
        .ak-available__grid { grid-template-columns: 1fr 1fr; }
        .ak-available-card { min-width: 0; }
        .ak-available-card > svg { display: none; }
        .ak-dialog-overlay { align-items: end; padding: 0; }
        .ak-dialog { width: 100%; max-height: 94vh; border-radius: var(--g-radius-lg) var(--g-radius-lg) 0 0; background: var(--g-bg); }
        .ak-dialog__header, .ak-dialog__body { padding: 20px 16px; }
        .ak-dialog__footer { padding: 12px 16px max(16px, env(safe-area-inset-bottom)); background: var(--g-bg); }
        .ak-provider-select-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .ak-dialog__footer .ak-btn { width: auto; flex: 1; }
      }
      @media (prefers-reduced-motion: reduce) {
        .ak-page *, .ak-page *::before, .ak-page *::after { scroll-behavior: auto !important; animation-duration: .01ms !important; animation-iteration-count: 1 !important; transition-duration: .01ms !important; }
      }
      @media (prefers-reduced-transparency: reduce) {
        .ak-hero, .ak-command-bar, .ak-card, .ak-dialog, .ak-dialog__footer { background: var(--g-bg); backdrop-filter: none; -webkit-backdrop-filter: none; }
        .ak-page::before, .ak-hero__aurora { display: none; }
      }
      :root.perf-mode .ak-page .ak-hero, :root.perf-mode .ak-page .ak-command-bar, :root.perf-mode .ak-page .ak-card, :root.perf-mode .ak-page .ak-dialog-overlay { backdrop-filter: var(--g-blur); -webkit-backdrop-filter: var(--g-blur); }
    </style>
  `;
}

function renderProviderCard(
  provider: AuthProviderSummary,
  props: ApiKeysProps,
  uiState: ApiKeysUiState,
) {
  const info = getProviderInfo(provider.provider);
  const label = info?.label ?? provider.provider;
  const tone = statusTone(provider.status);
  return html`
    <article class="ak-card" data-provider=${provider.provider}>
      <header class="ak-card__header">
        <div class="ak-card__identity">${providerMonogram(provider.provider, label)}<div class="ak-card__name"><strong>${label}</strong><span>${provider.profileCount} ${provider.profileCount === 1 ? "profile" : "profiles"}</span></div></div>
        <span class="ak-status ak-status--${tone}">${statusLabel(provider.status)}</span>
      </header>
      <div class="ak-card__body">${provider.profiles.map((profile) => renderProfileItem(profile, props, uiState))}</div>
    </article>
  `;
}

function renderProfileItem(
  profile: AuthProfileEntry,
  props: ApiKeysProps,
  uiState: ApiKeysUiState,
) {
  const { state } = props;
  const testing = state.testing[profile.profileId] ?? false;
  const testResult = state.testResults[profile.profileId];
  const revealed = uiState.revealed.has(profile.profileId);
  const safeFingerprint = profile.maskedKey ?? "Encrypted credential";
  return html`
    <div class="ak-profile" data-profile-id=${profile.profileId}>
      <div class="ak-profile__top">
        <div class="ak-profile__title"><strong>${profile.label}</strong><span>${profile.email ?? profile.profileId}</span></div>
        <span class="ak-status ak-status--good">${profile.type === "oauth" ? "OAuth" : "Encrypted"}</span>
      </div>
      <div class="ak-secret">
        <code class=${revealed ? "" : "is-hidden"}>${revealed ? safeFingerprint : "••••••••••••••••"}</code>
        <button class="ak-icon-btn" aria-label=${revealed ? "Hide masked credential" : "Reveal masked credential"} aria-pressed=${revealed ? "true" : "false"} title=${revealed ? "Hide masked credential" : "Reveal masked credential"} @click=${(
          event: Event,
        ) => {
          const code = (event.currentTarget as HTMLElement).parentElement?.querySelector("code");
          const button = event.currentTarget as HTMLButtonElement;
          if (uiState.revealed.has(profile.profileId)) uiState.revealed.delete(profile.profileId);
          else uiState.revealed.add(profile.profileId);
          const nowRevealed = uiState.revealed.has(profile.profileId);
          if (code) {
            code.textContent = nowRevealed ? safeFingerprint : "••••••••••••••••";
            code.classList.toggle("is-hidden", !nowRevealed);
          }
          button.setAttribute(
            "aria-label",
            nowRevealed ? "Hide masked credential" : "Reveal masked credential",
          );
          button.setAttribute("aria-pressed", nowRevealed ? "true" : "false");
          button.title = nowRevealed ? "Hide masked credential" : "Reveal masked credential";
        }}>${revealed ? icon("eyeOff", 15) : icon("eye", 15)}</button>
        <button class="ak-icon-btn" aria-label="Copy masked credential fingerprint" title="Copy masked credential fingerprint" @click=${async (
          event: Event,
        ) => {
          const button = event.currentTarget as HTMLButtonElement;
          try {
            await navigator.clipboard.writeText(safeFingerprint);
            button.dataset.copied = "true";
            button.title = "Copied masked fingerprint";
            window.setTimeout(() => {
              delete button.dataset.copied;
              button.title = "Copy masked credential fingerprint";
            }, 1400);
          } catch {
            button.title = "Copy unavailable";
          }
        }}>${icon("copy", 15)}</button>
      </div>
      <div class="ak-profile__facts">
        <div class="ak-fact"><span>${icon("clock", 13)}</span><div><strong>${testResult?.valid ? "Verified just now" : profile.remainingMs !== undefined && profile.remainingMs <= 0 ? "Credential expired" : profile.remainingMs !== undefined && profile.status !== "static" ? `Expires ${formatRemainingTime(profile.remainingMs)}` : "Not verified this session"}</strong><small>Last verification</small></div></div>
        <div class="ak-fact"><span>${icon("activity", 13)}</span><div><strong>Provider-managed</strong><small>Usage &amp; billing</small></div></div>
      </div>
      ${testResult ? html`<div class="ak-test-result ${testResult.valid ? "ak-test-result--success" : ""}" role="status">${icon(testResult.valid ? "check" : "alert", 14)}<span>${testResult.message}</span></div>` : nothing}
      <div class="ak-profile__actions">
        <button class="ak-btn ak-btn--small" ?disabled=${testing} @click=${() => props.onTestKey(profile.profileId)}><span class=${testing ? "ak-spin" : ""}>${icon(testing ? "refresh" : "activity", 14)}</span>${testing ? "Testing" : "Test"}</button>
        <button class="ak-btn ak-btn--small" @click=${() => openEditDialog(profile, props)}>${icon("pencil", 14)} Replace</button>
        <button class="ak-btn ak-btn--small ak-btn--danger" @click=${() => {
          if (confirm(`Delete ${profile.label}?`)) props.onDeleteKey(profile.profileId);
        }}>${icon("trash", 14)} Delete</button>
      </div>
    </div>
  `;
}

function renderQuickAddSection(
  existingProviders: AuthProviderSummary[],
  query: string,
  category: CategoryId,
  props: ApiKeysProps,
) {
  const existingIds = new Set(existingProviders.map((provider) => provider.provider));
  const normalizedQuery = query.trim().toLowerCase();
  const missingProviders = KNOWN_PROVIDERS.filter((provider) => !existingIds.has(provider.id))
    .filter((provider) => category === "all" || providerCategory(provider.id) === category)
    .filter(
      (provider) =>
        !normalizedQuery ||
        provider.label.toLowerCase().includes(normalizedQuery) ||
        provider.id.includes(normalizedQuery),
    );
  if (missingProviders.length === 0) return nothing;
  return html`
    <section class="ak-available" data-ib-target="control:apikeys/quick-add" aria-labelledby="ak-available-title">
      <header class="ak-available__header"><div><h2 id="ak-available-title">Available connections</h2><p>Add another provider without leaving your vault.</p></div><span>${missingProviders.length} available</span></header>
      <div class="ak-available__grid">${missingProviders.map(
        (provider) => html`
        <button class="ak-available-card" @click=${() => openAddDialog(props, provider.id)}>${providerMonogram(provider.id, provider.label)}<span class="ak-available-card__text"><strong>${provider.label}</strong><span>${categoryLabel(providerCategory(provider.id))}</span></span>${icon("chevron", 14)}</button>
      `,
      )}</div>
    </section>
  `;
}

function renderEmptyState(query: string, category: CategoryId, props: ApiKeysProps) {
  const isFiltered = Boolean(query.trim()) || category !== "all";
  return html`<section class="ak-empty"><div><div class="ak-empty__icon">${icon(isFiltered ? "search" : "key", 28)}</div><h2>${isFiltered ? "No credentials match" : "Your vault is ready"}</h2><p>${isFiltered ? "Try another search or category. Your other credentials are still safely stored." : "Connect your first provider to start powering models, media, voice, and integrations."}</p>${isFiltered ? html`<button class="ak-btn" @click=${() => props.onFilterChange("")}>Clear search</button>` : html`<button class="ak-btn ak-btn--primary" @click=${() => openAddDialog(props)}>${icon("plus", 16)} Add your first credential</button>`}</div></section>`;
}

function renderSkeletons() {
  return html`<div class="ak-skeleton-grid" aria-label="Loading credentials">${[0, 1, 2].map(
    () =>
      html`
        <div class="ak-skeleton"></div>
      `,
  )}</div>`;
}

function renderAddDialog(props: ApiKeysProps) {
  const { state } = props;
  const selectedProvider = getProviderInfo(state.addForm.provider);
  const editing = Boolean(state.selectedProfileId);
  const hasKey = Boolean(state.addForm.key.trim());
  return html`
    <div class="ak-dialog-overlay" role="presentation" @click=${(event: Event) => {
      if ((event.target as HTMLElement).classList.contains("ak-dialog-overlay")) closeDialog(props);
    }} @keydown=${(event: KeyboardEvent) => {
      if (event.key === "Escape") closeDialog(props);
    }}>
      <section class="ak-dialog" role="dialog" aria-modal="true" aria-labelledby="ak-dialog-title" aria-busy=${state.saving} data-ib-target="modal:apikeys/add">
        <header class="ak-dialog__header"><div><div class="ak-dialog__eyebrow">${editing ? "Rotate credential" : "Secure connection"}</div><h2 id="ak-dialog-title">${editing ? "Replace API key" : selectedProvider ? `Connect ${selectedProvider.label}` : "Add a credential"}</h2></div><button class="ak-icon-btn" aria-label="Close dialog" @click=${() => closeDialog(props)}>${icon("close", 19)}</button></header>
        <div class="ak-dialog__body">
          ${
            !state.addForm.provider
              ? html`
                <div class="ak-form-group"><div class="ak-form-label" id="ak-provider-picker-label">Select provider <span>${KNOWN_PROVIDERS.length} available</span></div><div class="ak-provider-select-grid" role="radiogroup" aria-labelledby="ak-provider-picker-label" data-ib-target="control:apikeys/dialog/provider">${KNOWN_PROVIDERS.map((provider) => html`<button type="button" class="ak-provider-select" role="radio" aria-checked="false" @click=${() => props.onFormChange("provider", provider.id)}>${providerMonogram(provider.id, provider.label)}<span>${provider.label}</span></button>`)}</div></div>
                <div class="ak-form-group"><label class="ak-form-label" for="ak-custom-provider">Custom provider ID <span>Advanced</span></label><input id="ak-custom-provider" class="ak-input" type="text" placeholder="custom-provider" .value=${state.addForm.provider} @input=${(event: Event) => props.onFormChange("provider", (event.target as HTMLInputElement).value)} /></div>
              `
              : html`
                <div class="ak-form-group"><div class="ak-form-label">Provider</div><div class="ak-selected-provider">${providerMonogram(state.addForm.provider, selectedProvider?.label ?? state.addForm.provider)}<div class="ak-selected-provider__text"><strong>${selectedProvider?.label ?? state.addForm.provider}</strong><span>${selectedProvider?.envKey || "Secure credential profile"}</span></div>${editing ? nothing : html`<button class="ak-link-btn" @click=${() => props.onFormChange("provider", "")}>Change</button>`}</div></div>
                <div class="ak-form-group"><label class="ak-form-label" for="ak-profile-name">Profile name <span>Optional</span></label><input id="ak-profile-name" class="ak-input" type="text" placeholder="default" .value=${state.addForm.profileName} @input=${(event: Event) => props.onFormChange("profileName", (event.target as HTMLInputElement).value)} /><div class="ak-help">Use distinct names for work, personal, or fallback credentials.</div></div>
                <div class="ak-form-group"><label class="ak-form-label" for="ak-secret-key">${editing ? "New API key" : "API key"} <span>Required</span></label><input id="ak-secret-key" class="ak-input" type="password" autocomplete="new-password" aria-describedby="ak-secret-help" placeholder=${selectedProvider?.envKey ? `Value for ${selectedProvider.envKey}` : "Paste credential securely"} data-ib-target="control:apikeys/dialog/key" .value=${state.addForm.key} @input=${(event: Event) => props.onFormChange("key", (event.target as HTMLInputElement).value)} /><div class="ak-help" id="ak-secret-help">${editing ? "Your existing secret cannot be read back. Paste a new value to rotate it." : "The raw value is never returned to this page after saving."}</div></div>
                <div class="ak-form-group"><label class="ak-form-label" for="ak-email">Account email <span>Optional</span></label><input id="ak-email" class="ak-input" type="email" autocomplete="email" placeholder="you@example.com" .value=${state.addForm.email} @input=${(event: Event) => props.onFormChange("email", (event.target as HTMLInputElement).value)} /></div>
                <div class="ak-security-note"><span>${icon("lock", 17)}</span><div><strong>Encrypted at rest.</strong> Credentials are stored in your InfiniBot state directory and are masked everywhere in the interface.</div></div>
              `
          }
        </div>
        <footer class="ak-dialog__footer"><button class="ak-btn" @click=${() => closeDialog(props)}>Cancel</button><button class="ak-btn ak-btn--primary" data-ib-target="control:apikeys/dialog/save" ?disabled=${!state.addForm.provider || !hasKey || state.saving} @click=${props.onSaveKey}>${state.saving ? html`<span class="ak-spin">${icon("refresh", 15)}</span>Saving securely` : html`${icon(editing ? "refresh" : "check", 15)}${editing ? "Replace key" : "Save credential"}`}</button></footer>
      </section>
    </div>
  `;
}
