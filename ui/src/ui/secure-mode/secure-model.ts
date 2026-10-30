/**
 * <ib-secure-model-picker> — the "Default local model" setting in the Secure
 * Mode controls.
 *
 * Secure runs whose agent/session model is remote move to this model
 * automatically ("Secure Mode: using <model> (local)" in the chat). "Automatic"
 * leaves secureMode.defaultModel unset: the gateway picks the best installed
 * local model. Only local models are offered; ones that are not running are
 * listed but disabled. Renders nothing against a gateway without
 * `modelSwitch` (older builds).
 */
import { LitElement, css, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { icons } from "../icons";
import { dispatchSecure, friendlySecureError, getSecureState, SecureModeController, secureRequest } from "./store";
import { secureBaseStyles } from "./styles";

export type SecureModelCandidate = {
  ref: string;
  provider: string;
  model: string;
  source: "agent" | "default" | "suggested" | "installed";
  local: boolean;
  reachable: boolean;
  note?: string;
};

export type SecureModelsResponse = {
  defaultModel: string | null;
  suggested: string | null;
  candidates: SecureModelCandidate[];
};

/** Parse secure.models; drops remote candidates (never offered). */
export function normalizeSecureModels(raw: unknown): SecureModelsResponse {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const list = Array.isArray(r.candidates) ? r.candidates : [];
  const candidates = list
    .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
    .filter((c) => typeof c.ref === "string" && c.local === true)
    .map((c) => ({
      ref: c.ref as string,
      provider: String(c.provider ?? ""),
      model: String(c.model ?? ""),
      source: (["agent", "default", "suggested", "installed"].includes(c.source as string)
        ? c.source
        : "installed") as SecureModelCandidate["source"],
      local: true,
      reachable: c.reachable === true,
      ...(typeof c.note === "string" && c.note ? { note: c.note } : {}),
    }));
  return {
    defaultModel: typeof r.defaultModel === "string" && r.defaultModel ? r.defaultModel : null,
    suggested: typeof r.suggested === "string" && r.suggested ? r.suggested : null,
    candidates,
  };
}

@customElement("ib-secure-model-picker")
export class SecureModelPicker extends LitElement {
  @state() private data: SecureModelsResponse | null = null;
  @state() private loading = false;
  @state() private saving = false;
  @state() private error: string | null = null;

  private secure = new SecureModeController(this);
  private loadedFor = false;

  updated(): void {
    if (this.secure.state.status?.modelSwitch && !this.loadedFor) {
      this.loadedFor = true;
      void this.load();
    }
  }

  private async load() {
    this.loading = true;
    this.error = null;
    try {
      this.data = normalizeSecureModels(await secureRequest("secure.models", {}));
    } catch (err) {
      this.error = friendlySecureError(err);
    } finally {
      this.loading = false;
    }
  }

  private async onChange(e: Event) {
    const value = (e.target as HTMLSelectElement).value;
    this.saving = true;
    this.error = null;
    try {
      const res = await secureRequest<{ defaultModel?: string | null }>("secure.defaultModel.set", {
        model: value || null,
      });
      const next = res?.defaultModel ?? null;
      if (this.data) this.data = { ...this.data, defaultModel: next };
      dispatchSecure({ type: "status", status: { ...getSecureState().status, defaultModel: next } });
    } catch (err) {
      this.error = friendlySecureError(err);
      (e.target as HTMLSelectElement).value = this.data?.defaultModel ?? "";
    } finally {
      this.saving = false;
    }
  }

  render() {
    if (!this.secure.state.status?.modelSwitch) return nothing;
    const d = this.data;
    const current = d?.defaultModel ?? this.secure.state.status.defaultModel ?? "";
    const autoLabel = d?.suggested ? `Automatic · ${d.suggested}` : "Automatic · best installed local model";
    const known = new Set(d?.candidates.map((c) => c.ref) ?? []);
    return html`
      <div class="smp">
        <label class="smp-label" for="smp-select">
          <span class="smp-ico">${icons.server}</span>Default local model
        </label>
        <div class="smp-row">
          <select
            id="smp-select"
            data-secure-default-model
            ?disabled=${this.loading || this.saving}
            .value=${current}
            @change=${(e: Event) => void this.onChange(e)}
          >
            <option value="" ?selected=${!current}>${autoLabel}</option>
            ${current && !known.has(current)
              ? html`<option value=${current} selected>${current}</option>`
              : nothing}
            ${(d?.candidates ?? []).map(
              (c) => html`<option
                value=${c.ref}
                ?selected=${c.ref === current}
                ?disabled=${!c.reachable && c.ref !== current}
                title=${c.note ?? ""}
              >
                ${c.ref}${c.reachable ? "" : " (not running)"}
              </option>`,
            )}
          </select>
          ${this.loading || this.saving ? html`<span class="smp-busy" aria-hidden="true"></span>` : nothing}
        </div>
        <p class="smp-hint">
          Agents set to a hosted model run on this model while Secure Mode is on. Never falls back to a hosted model.
        </p>
        ${this.error ? html`<p class="smp-err" role="alert">${this.error}</p>` : nothing}
      </div>
    `;
  }

  static styles = [
    secureBaseStyles,
    css`
      :host { display: block; }
      .smp { display: flex; flex-direction: column; gap: 6px; }
      .smp-label { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; color: var(--sm-muted); }
      .smp-ico { display: inline-flex; color: var(--sm-accent); }
      .smp-ico svg { width: 13px; height: 13px; }
      .smp-row { display: flex; align-items: center; gap: 8px; }
      select {
        flex: 1; min-width: 0; height: 32px; padding: 0 10px; border-radius: 10px;
        border: 1px solid var(--sm-border); background: color-mix(in srgb, currentColor 5%, transparent);
        color: inherit; font: inherit; font-size: 12.5px;
      }
      select:focus-visible { outline: 2px solid var(--sm-accent); outline-offset: 1px; }
      select:disabled { opacity: 0.6; }
      option { background: var(--glass-solid, #111); color: inherit; }
      .smp-busy {
        width: 12px; height: 12px; border-radius: 50%; flex: none;
        border: 2px solid var(--sm-ring); border-top-color: var(--sm-accent); animation: smp-spin 0.8s linear infinite;
      }
      @keyframes smp-spin { to { transform: rotate(360deg); } }
      .smp-hint { margin: 0; font-size: 11.5px; color: var(--sm-muted); line-height: 1.4; }
      .smp-err { margin: 0; font-size: 12px; color: #f87171; line-height: 1.35; }
      @media (prefers-reduced-motion: reduce) { .smp-busy { animation: none; } }
    `,
  ];
}

declare global {
  interface HTMLElementTagNameMap {
    "ib-secure-model-picker": SecureModelPicker;
  }
}
