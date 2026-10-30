/**
 * <model-selector> — provider + model dropdown for per-agent model configuration.
 *
 * Shows a two-column picker: provider first (Anthropic, OpenAI, Ollama, OpenRouter, Groq),
 * then models filtered to that provider with a cost-tier badge. Supports custom model
 * identifiers for providers that use them (OpenRouter, Ollama custom builds, etc.).
 *
 * Emits `model-change` CustomEvent with `detail: { model: string, provider: string }`
 * when the operator clicks "Apply". The host is responsible for persisting.
 */

import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import "./provider-logo.js";

// ── Provider / model catalogue ────────────────────────────────────────────────

type Tier = "fast" | "balanced" | "powerful";

interface ModelDef {
  id: string;
  label: string;
  tier: Tier;
}

interface ProviderDef {
  label: string;
  color: string;
  models: ModelDef[];
  supportsCustom: boolean;
}

const PROVIDERS: Record<string, ProviderDef> = {
  anthropic: {
    label: "Anthropic",
    color: "#ff9a55",
    models: [
      { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", tier: "balanced" },
      { id: "claude-opus-4-8",   label: "Claude Opus 4.8",   tier: "powerful" },
      { id: "claude-haiku-4-5",  label: "Claude Haiku 4.5",  tier: "fast" },
    ],
    supportsCustom: true,
  },
  openai: {
    label: "OpenAI",
    color: "#10a37f",
    models: [
      { id: "gpt-4o",      label: "GPT-4o",      tier: "balanced" },
      { id: "gpt-4o-mini", label: "GPT-4o Mini", tier: "fast" },
      { id: "o1",          label: "O1",           tier: "powerful" },
      { id: "o3-mini",     label: "O3 Mini",      tier: "fast" },
    ],
    supportsCustom: true,
  },
  ollama: {
    label: "Ollama (local)",
    color: "#4ade80",
    models: [
      { id: "gemma4:31b",     label: "Gemma4 31B",        tier: "balanced" },
      { id: "llama3.3",       label: "Llama 3.3",         tier: "balanced" },
      { id: "qwen2.5-coder",  label: "Qwen 2.5 Coder",   tier: "fast" },
    ],
    supportsCustom: true,
  },
  openrouter: {
    label: "OpenRouter",
    color: "#7dd3fc",
    models: [],
    supportsCustom: true,
  },
  groq: {
    label: "Groq",
    color: "#f472b6",
    models: [
      { id: "llama-3.3-70b-versatile", label: "Llama 3.3 70B",          tier: "balanced" },
      { id: "mixtral-8x7b-32768",      label: "Mixtral 8x7B",           tier: "fast" },
      { id: "llama-3.1-8b-instant",    label: "Llama 3.1 8B Instant",   tier: "fast" },
    ],
    supportsCustom: true,
  },
};

const TIER: Record<Tier, { label: string; color: string; desc: string }> = {
  fast:     { label: "Fast",     color: "#4ade80", desc: "Low cost · Quick response" },
  balanced: { label: "Balanced", color: "#fbbf24", desc: "Good cost/quality ratio" },
  powerful: { label: "Powerful", color: "#f472b6", desc: "Best quality · Higher cost" },
};

// Parse a stored model string ("claude-sonnet-4-6" or "openai/gpt-4o") into
// provider + model parts.
function parseModel(raw: string): { provider: string; model: string } {
  if (!raw || raw === "default") return { provider: "anthropic", model: "" };

  // Explicit provider/model prefix
  for (const id of Object.keys(PROVIDERS)) {
    if (raw.startsWith(id + "/")) {
      return { provider: id, model: raw.slice(id.length + 1) };
    }
  }

  // Model is in a known provider's catalogue
  for (const [id, def] of Object.entries(PROVIDERS)) {
    if (def.models.some((m) => m.id === raw)) {
      return { provider: id, model: raw };
    }
  }

  // Default: treat as bare anthropic model
  return { provider: "anthropic", model: raw };
}

// Build the model string that will be stored (anthropic models stored without prefix
// for backwards-compatibility with agents that pre-date the provider/model convention).
function buildFullModel(provider: string, model: string): string {
  if (!model) return "default";
  if (provider === "anthropic") return model;
  return `${provider}/${model}`;
}

// ── Custom element ────────────────────────────────────────────────────────────

@customElement("model-selector")
export class ModelSelector extends LitElement {
  /** Agent id — passed through to the emitted event for host convenience. */
  @property() agentId = "";

  /** Current stored model string (e.g. "claude-sonnet-4-6" or "openai/gpt-4o"). */
  @property() currentModel = "";

  @state() private _provider = "anthropic";
  @state() private _model = "";
  @state() private _custom = "";
  @state() private _dirty = false;

  static styles = css`
    :host {
      display: block;
      font-family: "JetBrains Mono", "SF Mono", monospace;
      color: rgba(228, 228, 231, 0.9);
    }
    .ms-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 14px;
    }
    @media (max-width: 560px) {
      .ms-grid { grid-template-columns: 1fr; }
    }
    .ms-label {
      display: block;
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.12em;
      color: var(--g-primary, #d4a017);
      margin-bottom: 6px;
    }
    .ms-provider { display: flex; align-items: center; gap: 8px; }
    .ms-provider .ms-select { flex: 1; min-width: 0; }
    .ms-select {
      width: 100%;
      padding: 8px 10px;
      border: 1px solid color-mix(in srgb, var(--g-primary, #d4a017) 22%, transparent);
      border-radius: 6px;
      background: rgba(5, 5, 10, 0.65);
      color: rgba(228, 228, 231, 0.92);
      font-family: inherit;
      font-size: 11px;
      cursor: pointer;
      appearance: none;
      box-sizing: border-box;
      transition: border-color 0.15s ease;
    }
    .ms-select:focus {
      outline: none;
      border-color: color-mix(in srgb, var(--g-primary, #d4a017) 60%, transparent);
      box-shadow: 0 0 0 1px color-mix(in srgb, var(--g-primary, #d4a017) 25%, transparent);
    }
    .ms-select option { background: #0a0a14; color: #e4e4e7; }
    .ms-tier {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 3px 9px;
      border-radius: 999px;
      font-size: 8.5px;
      font-weight: 700;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      margin-top: 7px;
      border: 1px solid transparent;
    }
    .ms-tier-dot {
      width: 5px;
      height: 5px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .ms-custom {
      width: 100%;
      padding: 8px 10px;
      border: 1px solid color-mix(in srgb, var(--g-primary, #d4a017) 22%, transparent);
      border-radius: 6px;
      background: rgba(5, 5, 10, 0.65);
      color: rgba(228, 228, 231, 0.9);
      font-family: inherit;
      font-size: 11px;
      box-sizing: border-box;
      margin-top: 10px;
      transition: border-color 0.15s ease;
    }
    .ms-custom:focus {
      outline: none;
      border-color: color-mix(in srgb, var(--g-primary, #d4a017) 60%, transparent);
    }
    .ms-custom::placeholder {
      color: rgba(228, 228, 231, 0.28);
      letter-spacing: 0.04em;
    }
    .ms-hint {
      font-size: 9px;
      color: rgba(228, 228, 231, 0.38);
      margin-top: 4px;
      letter-spacing: 0.03em;
    }
    .ms-save-btn {
      margin-top: 12px;
      padding: 8px 18px;
      border-radius: 7px;
      border: 1px solid color-mix(in srgb, var(--g-primary, #d4a017) 65%, transparent);
      background: linear-gradient(
        135deg,
        color-mix(in srgb, var(--g-primary, #d4a017) 88%, #fff),
        var(--g-primary, #d4a017)
      );
      color: #08080d;
      font-family: inherit;
      font-size: 10px;
      font-weight: 800;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      cursor: pointer;
      transition: transform 0.14s ease, box-shadow 0.14s ease;
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.4);
    }
    .ms-save-btn:hover:not(:disabled) {
      transform: translateY(-1px);
      box-shadow: 0 8px 22px rgba(0, 0, 0, 0.5),
        0 0 24px color-mix(in srgb, var(--g-primary, #d4a017) 30%, transparent);
    }
    .ms-save-btn:disabled {
      opacity: 0.4;
      cursor: not-allowed;
      transform: none;
    }
    .ms-current {
      font-size: 9px;
      color: rgba(228, 228, 231, 0.45);
      margin-top: 6px;
      letter-spacing: 0.04em;
    }
    .ms-current code {
      color: var(--g-primary, #d4a017);
      font-family: inherit;
    }
  `;

  protected willUpdate(changed: Map<string | number | symbol, unknown>): void {
    if (changed.has("currentModel")) {
      const { provider, model } = parseModel(this.currentModel);
      this._provider = provider;
      const def = PROVIDERS[provider];
      if (def?.models.some((m) => m.id === model) || model === "") {
        this._model = model;
        this._custom = "";
      } else {
        this._model = "__custom__";
        this._custom = model;
      }
      this._dirty = false;
    }
  }

  private get _effectiveModel(): string {
    return this._model === "__custom__" ? this._custom : this._model;
  }

  private _onProviderChange(e: Event): void {
    this._provider = (e.target as HTMLSelectElement).value;
    this._model = "";
    this._custom = "";
    this._dirty = true;
  }

  private _onModelChange(e: Event): void {
    this._model = (e.target as HTMLSelectElement).value;
    if (this._model !== "__custom__") this._custom = "";
    this._dirty = true;
  }

  private _onCustomInput(e: Event): void {
    this._custom = (e.target as HTMLInputElement).value;
    this._dirty = true;
  }

  private _apply(): void {
    const model = buildFullModel(this._provider, this._effectiveModel);
    this._dirty = false;
    this.dispatchEvent(
      new CustomEvent("model-change", {
        detail: { model, provider: this._provider, agentId: this.agentId },
        bubbles: true,
        composed: true,
      })
    );
  }

  render() {
    const provDef = PROVIDERS[this._provider];
    const modelDef = provDef?.models.find((m) => m.id === this._model);
    const tierDef = modelDef ? TIER[modelDef.tier] : null;
    const needsCustom =
      this._model === "__custom__" ||
      (provDef && provDef.models.length === 0);

    return html`
      <div class="ms-grid">
        <!-- Provider picker -->
        <div>
          <span class="ms-label">Provider</span>
          <div class="ms-provider">
          <ib-provider-logo provider=${this._provider} label=${provDef?.label ?? this._provider} size="28"></ib-provider-logo>
          <select class="ms-select" @change=${this._onProviderChange}>
            ${Object.entries(PROVIDERS).map(
              ([id, def]) =>
                html`<option value=${id} ?selected=${id === this._provider}>${def.label}</option>`
            )}
          </select>
          </div>
        </div>

        <!-- Model picker -->
        <div>
          <span class="ms-label">Model</span>
          ${provDef && provDef.models.length > 0
            ? html`
                <select class="ms-select" @change=${this._onModelChange}>
                  <option value="">— select —</option>
                  ${provDef.models.map(
                    (m) =>
                      html`<option value=${m.id} ?selected=${m.id === this._model}>${m.label}</option>`
                  )}
                  ${provDef.supportsCustom
                    ? html`<option value="__custom__" ?selected=${"__custom__" === this._model}>Custom…</option>`
                    : nothing}
                </select>
                ${tierDef
                  ? html`
                      <div
                        class="ms-tier"
                        style="color:${tierDef.color};border-color:${tierDef.color}40;background:${tierDef.color}14;"
                      >
                        <span
                          class="ms-tier-dot"
                          style="background:${tierDef.color};box-shadow:0 0 6px ${tierDef.color};"
                        ></span>
                        ${tierDef.label} · ${tierDef.desc}
                      </div>
                    `
                  : nothing}
              `
            : html`<div class="ms-hint" style="padding-top:6px;">Enter model identifier below</div>`}
        </div>
      </div>

      ${needsCustom
        ? html`
            <input
              class="ms-custom"
              type="text"
              placeholder=${this._provider === "openrouter"
                ? "e.g. anthropic/claude-sonnet-4-6"
                : "Model identifier…"}
              .value=${this._custom}
              @input=${this._onCustomInput}
            />
            <div class="ms-hint">
              ${this._provider === "openrouter"
                ? "Format: provider/model-name (as shown on openrouter.ai)"
                : "Enter the model name as your provider expects it"}
            </div>
          `
        : nothing}

      ${this.currentModel && this.currentModel !== "default"
        ? html`<div class="ms-current">Current: <code>${this.currentModel}</code></div>`
        : nothing}

      ${this._dirty
        ? html`
            <button
              class="ms-save-btn"
              ?disabled=${!this._effectiveModel}
              @click=${this._apply}
            >
              Apply Model
            </button>
          `
        : nothing}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "model-selector": ModelSelector;
  }
}
