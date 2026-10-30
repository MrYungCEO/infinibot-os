/**
 * Shared model-picker filtering — search + provider + capability + tier.
 *
 * Used by every model selector in the app (chat topbar, grid panels, agent
 * popup, spawn dialog) so the filter UX is consistent everywhere. Keep the
 * filter logic here; render the controls per-host with `renderModelFilterBar`.
 */
import { html, type TemplateResult } from "lit";

export type ModelCapability = "vision" | "tool-use" | "long-context" | "reasoning" | "free";

export type ModelOption = {
  id: string;
  name: string;
  provider?: string;
  /** Context window in tokens, when known. Drives the "long-context" filter + tier. */
  contextWindow?: number;
  /** Extended thinking / reasoning model. */
  reasoning?: boolean;
  /** Accepts image input. */
  vision?: boolean;
  /** Supports tool / function calling. Best-effort; defaults to true for chat models. */
  toolUse?: boolean;
  /**
   * Placeholder for a provider that's visible but not yet connected (e.g.
   * Ollama with no local daemon / no cloud key). Not a real, selectable model —
   * the grid renders it as a "set up" affordance. Hidden by the shared
   * `filterModels` so it never leaks into the other model pickers.
   */
  unconfigured?: boolean;
  /** false when the gateway reports no credential for the provider. */
  available?: boolean;
  /** false when the gateway's model allowlist excludes it (sessions.patch would reject it). */
  allowed?: boolean;
  /** true when agents.defaults.models lists it explicitly ("your models"). */
  pinned?: boolean;
  /**
   * Sourced free classification from the gateway (src/agents/model-free.ts):
   * "free" = $0 pricing, "free-tier" = paid model with a free allowance,
   * "local" = runs on the user's machine. Absent = not free / unknown.
   */
  free?: FreeKind;
  /** Limits / conditions behind `free` (tooltip). */
  freeNote?: string;
  /** Where the free claim comes from (tooltip). */
  freeSource?: string;
  /** The provider recently rejected this model as not found. */
  unavailable?: boolean;
  /** Nearest valid model ref to offer instead of an unavailable one. */
  suggestion?: string;
};

export type FreeKind = "free" | "free-tier" | "local";

export const FREE_KIND_LABELS: Record<FreeKind, string> = {
  free: "Free",
  "free-tier": "Free tier",
  local: "Local",
};

/** Per-provider facts from models.list (`providers`). */
export type ProviderInfo = {
  id: string;
  available?: boolean;
  free?: {
    kind: FreeKind;
    label: string;
    note: string;
    source: string;
    verified?: string;
    keyUrl?: string;
    count: number;
  };
};

const FREE_KINDS = new Set<string>(["free", "free-tier", "local"]);

export function normalizeProviderInfo(
  res: { providers?: unknown } | null | undefined,
): Map<string, ProviderInfo> {
  const out = new Map<string, ProviderInfo>();
  const rows = Array.isArray(res?.providers) ? (res.providers as ProviderInfo[]) : [];
  for (const row of rows) {
    if (!row || typeof row.id !== "string") continue;
    const free = row.free && FREE_KINDS.has(row.free.kind) ? row.free : undefined;
    out.set(row.id, { id: row.id, available: row.available, ...(free ? { free } : {}) });
  }
  return out;
}

type RawModelRow = {
  id?: unknown;
  name?: unknown;
  provider?: unknown;
  contextWindow?: number;
  reasoning?: boolean;
  vision?: boolean;
  unconfigured?: boolean;
  available?: boolean;
  allowed?: boolean;
  pinned?: boolean;
  free?: unknown;
  freeNote?: unknown;
  freeSource?: unknown;
  unavailable?: boolean;
  suggestion?: unknown;
};

/**
 * Normalize a `models.list` response into picker options. Ids become the
 * `provider/model` refs `sessions.patch { model }` accepts. Shared by the app's
 * catalog loader (grid panels) and the webchat picker.
 */
export function normalizeModelsList(res: { models?: unknown } | null | undefined): ModelOption[] {
  const rows = Array.isArray(res?.models) ? (res.models as RawModelRow[]) : [];
  return rows
    .filter((m) => typeof m?.id === "string")
    .map((m) => {
      const id = m.id as string;
      const provider = typeof m.provider === "string" ? m.provider : undefined;
      return {
        id: provider ? `${provider}/${id}` : id,
        name: (typeof m.name === "string" && m.name) || id,
        provider,
        contextWindow: m.contextWindow,
        reasoning: m.reasoning,
        vision: m.vision,
        unconfigured: m.unconfigured,
        available: m.available,
        allowed: m.allowed,
        pinned: m.pinned,
        ...(typeof m.free === "string" && FREE_KINDS.has(m.free) ? { free: m.free as FreeKind } : {}),
        ...(typeof m.freeNote === "string" ? { freeNote: m.freeNote } : {}),
        ...(typeof m.freeSource === "string" ? { freeSource: m.freeSource } : {}),
        ...(m.unavailable === true ? { unavailable: true } : {}),
        ...(typeof m.suggestion === "string" && m.suggestion ? { suggestion: m.suggestion } : {}),
      };
    });
}

export type ModelFilterState = {
  search: string;
  provider: string | null;
  capabilities: Set<ModelCapability>;
  /** Tier bucket by context window: "s" <32k, "m" <200k, "l" >=200k. null = any. */
  tier: "s" | "m" | "l" | null;
};

export function createModelFilterState(): ModelFilterState {
  return { search: "", provider: null, capabilities: new Set(), tier: null };
}

/** Long-context threshold (tokens). */
const LONG_CONTEXT_MIN = 200_000;

/**
 * Free-to-use model (free, free tier or local). Only what the gateway could
 * source counts — a "free" in the name is never taken at face value.
 */
export function isFreeModel(m: Pick<ModelOption, "free">): boolean {
  return m.free !== undefined;
}

/** Tooltip for a free badge: what it means and where the claim comes from. */
export function freeBadgeTitle(m: Pick<ModelOption, "free" | "freeNote" | "freeSource">): string {
  if (!m.free) return "";
  const parts = [m.freeNote, m.freeSource ? `Source: ${m.freeSource}` : ""].filter(Boolean);
  return parts.join(" ") || FREE_KIND_LABELS[m.free];
}

export function modelHasCapability(m: ModelOption, cap: ModelCapability): boolean {
  switch (cap) {
    case "free":
      return isFreeModel(m);
    case "vision":
      return m.vision === true;
    case "reasoning":
      return m.reasoning === true;
    case "long-context":
      return (m.contextWindow ?? 0) >= LONG_CONTEXT_MIN;
    case "tool-use":
      // Most hosted chat models support tools; treat undefined as "yes" so the
      // filter doesn't hide everything when the catalog omits the flag.
      return m.toolUse !== false;
    default:
      return false;
  }
}

/** Coarse cost/size tier inferred from the context window. */
export function modelTier(m: ModelOption): "s" | "m" | "l" {
  const ctx = m.contextWindow ?? 0;
  if (ctx >= LONG_CONTEXT_MIN) return "l";
  if (ctx >= 32_000) return "m";
  return "s";
}

export function getUniqueProviders(models: ModelOption[]): string[] {
  const providers = new Set<string>();
  for (const m of models) if (m.provider) providers.add(m.provider);
  return Array.from(providers).sort();
}

export function filterModels(models: ModelOption[], f: ModelFilterState): ModelOption[] {
  const query = f.search.toLowerCase().trim();
  return models.filter((m) => {
    // Placeholder "not connected" rows are a grid-only setup affordance; keep
    // them out of the shared pickers so they can't be selected as a model.
    if (m.unconfigured) return false;
    if (f.provider && m.provider !== f.provider) return false;
    if (f.tier && modelTier(m) !== f.tier) return false;
    for (const cap of f.capabilities) {
      if (!modelHasCapability(m, cap)) return false;
    }
    if (!query) return true;
    return (
      m.name.toLowerCase().includes(query) ||
      m.id.toLowerCase().includes(query) ||
      (m.provider?.toLowerCase().includes(query) ?? false)
    );
  });
}

export function groupModelsByProvider(models: ModelOption[]): Map<string, ModelOption[]> {
  const grouped = new Map<string, ModelOption[]>();
  for (const m of models) {
    const key = m.provider ?? "other";
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(m);
  }
  return grouped;
}

const CAPABILITY_LABELS: Array<{ cap: ModelCapability; label: string; icon: string }> = [
  { cap: "vision", label: "Vision", icon: "👁" },
  { cap: "tool-use", label: "Tools", icon: "🔧" },
  { cap: "long-context", label: "Long ctx", icon: "📏" },
  { cap: "reasoning", label: "Reasoning", icon: "🧠" },
  { cap: "free", label: "Free", icon: "🆓" },
];

const TIER_LABELS: Array<{ tier: "s" | "m" | "l"; label: string }> = [
  { tier: "s", label: "Small" },
  { tier: "m", label: "Mid" },
  { tier: "l", label: "Large" },
];

/**
 * Render the full filter bar (search + provider chips + capability chips +
 * tier chips). `onChange` is invoked after mutating `state` so the host can
 * re-render. Styling hooks (class names) are shared via model-filter.css
 * injected by each host, or the host's own stylesheet.
 */
export function renderModelFilterBar(
  models: ModelOption[],
  state: ModelFilterState,
  onChange: () => void,
): TemplateResult {
  const providers = getUniqueProviders(models);
  return html`
    <div class="mf-bar" @click=${(e: Event) => e.stopPropagation()}>
      <input
        class="mf-search"
        type="text"
        placeholder="Search models…"
        .value=${state.search}
        @input=${(e: Event) => {
          state.search = (e.target as HTMLInputElement).value;
          onChange();
        }}
      />
      ${providers.length > 1
        ? html`<div class="mf-chips">
            <button
              class="mf-chip ${state.provider === null ? "active" : ""}"
              @click=${() => {
                state.provider = null;
                onChange();
              }}
            >
              All providers
            </button>
            ${providers.map(
              (p) => html`<button
                class="mf-chip ${state.provider === p ? "active" : ""}"
                @click=${() => {
                  state.provider = state.provider === p ? null : p;
                  onChange();
                }}
              >
                ${p}
              </button>`,
            )}
          </div>`
        : null}
      <div class="mf-chips">
        ${CAPABILITY_LABELS.map(
          ({ cap, label, icon }) => html`<button
            class="mf-chip cap ${state.capabilities.has(cap) ? "active" : ""}"
            title=${label}
            @click=${() => {
              if (state.capabilities.has(cap)) state.capabilities.delete(cap);
              else state.capabilities.add(cap);
              onChange();
            }}
          >
            ${icon} ${label}
          </button>`,
        )}
        ${TIER_LABELS.map(
          ({ tier, label }) => html`<button
            class="mf-chip tier ${state.tier === tier ? "active" : ""}"
            @click=${() => {
              state.tier = state.tier === tier ? null : tier;
              onChange();
            }}
          >
            ${label}
          </button>`,
        )}
      </div>
    </div>
  `;
}

/** Shared CSS for the filter bar — hosts can include this once. */
export const MODEL_FILTER_CSS = `
  .mf-bar { display: flex; flex-direction: column; gap: 8px; padding: 8px; }
  .mf-search {
    width: 100%; box-sizing: border-box;
    background: rgba(0,0,0,0.35); color: var(--c-text, #f4f4f8);
    border: 1px solid rgba(255,255,255,0.12); border-radius: 8px;
    padding: 8px 10px; font-size: 13px; outline: none;
  }
  .mf-search:focus { border-color: var(--g-primary, #f5b542); }
  .mf-chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .mf-chip {
    font-size: 11px; padding: 4px 9px; border-radius: 99px; cursor: pointer;
    background: rgba(255,255,255,0.05); color: var(--c-text-2, #a1a1aa);
    border: 1px solid rgba(255,255,255,0.1); white-space: nowrap;
    transition: all 120ms ease;
  }
  .mf-chip:hover { background: rgba(255,255,255,0.1); color: var(--c-text, #f4f4f8); }
  .mf-chip.active {
    background: color-mix(in srgb, var(--g-primary, #f5b542) 22%, transparent);
    border-color: var(--g-primary, #f5b542);
    color: var(--g-primary, #f5b542);
  }
`;
