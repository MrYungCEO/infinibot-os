/**
 * Branding modal — reachable by clicking the topbar brand (logo + title).
 *
 * Lets the user upload a custom logo and edit the brand title / subtitle, then
 * persists them through the EXISTING app-branding controller (branding.set),
 * the same path the Appearance settings view uses. There is no separate store:
 * `appName` ← brand title, `tagline` ← brand subtitle, `logoDataUrl` / `logoUrl`
 * ← logo. Both surfaces stay in sync because they share one controller.
 *
 * Save/Cancel semantics: the modal keeps its OWN local draft seeded from the
 * last *saved* payload (not the controller's live draft, which may carry
 * unsaved Appearance edits). On Save we write the branding fields into the
 * controller draft and call its `saveDraft`. On Cancel/ESC we throw the local
 * draft away and touch nothing — Appearance's in-progress edits are preserved.
 *
 * Mounted globally at the app root via `renderBrandingModal`; opened from
 * anywhere with `openBrandingModal`.
 */

import { html, nothing, type TemplateResult } from "lit";
import { ref } from "lit/directives/ref.js";
import type { AppViewState } from "../app-view-state.js";
import type { GatewayBrowserClient } from "../gateway.js";
import {
  BRAND_DEFAULT_LOGO,
  fileToDataUrl,
  readCachedBranding,
  saveDraft,
  updateDraftBranding,
} from "../controllers/app-branding.js";
import { t } from "../i18n.js";

// Topbar fallbacks — must match the literals previously hardcoded in
// app-render.ts so an unset field renders exactly as before.
export const BRAND_DEFAULT_TITLE = "INFINIBOT";
export const BRAND_DEFAULT_SUBTITLE = "Master Terminal";
export { BRAND_DEFAULT_LOGO };

const MAX_LOGO_BYTES = 2 * 1024 * 1024; // ~2 MB
const ACCEPTED_LOGO_TYPES = /^image\/(png|jpeg|jpg|svg\+xml|webp)$/i;

interface BrandingDraft {
  appName: string;
  tagline: string;
  logoDataUrl: string;
  logoUrl: string;
}

// ── Module-level open state ─────────────────────────────────────────────────
let _open = false;
let _rerender: () => void = () => {};
let _returnFocusEl: HTMLElement | null = null;
let _draft: BrandingDraft = { appName: "", tagline: "", logoDataUrl: "", logoUrl: "" };
let _useUrl = false;
let _dragOver = false;
let _error: string | null = null;
let _saving = false;
let _focused = false; // first-field autofocus only once per open

function snapshotSaved(state: AppViewState): BrandingDraft {
  const b =
    state.appBrandingState?.payload?.branding ??
    readCachedBranding()?.branding ??
    null;
  return {
    appName: b?.appName ?? "",
    tagline: b?.tagline ?? "",
    logoDataUrl: b?.logoDataUrl ?? "",
    logoUrl: b?.logoUrl ?? "",
  };
}

/** Open the Branding modal. Captures the current focus so we can restore it. */
export function openBrandingModal(state: AppViewState, rerender: () => void): void {
  _rerender = rerender;
  _returnFocusEl =
    typeof document !== "undefined" && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  _draft = snapshotSaved(state);
  _useUrl = !!_draft.logoUrl && !_draft.logoDataUrl;
  _dragOver = false;
  _error = null;
  _saving = false;
  _focused = false;
  _open = true;
  _rerender();
}

export function closeBrandingModal(): void {
  _open = false;
  _rerender();
  // Restore focus to the brand button after the modal unmounts.
  const el = _returnFocusEl;
  _returnFocusEl = null;
  if (el && typeof el.focus === "function") {
    setTimeout(() => {
      try {
        el.focus();
      } catch {
        /* element gone */
      }
    }, 0);
  }
}

export function isBrandingModalOpen(): boolean {
  return _open;
}

// ── Draft edits (local only) ────────────────────────────────────────────────
function patch(p: Partial<BrandingDraft>): void {
  _draft = { ..._draft, ...p };
  _rerender();
}

async function ingestFile(file: File): Promise<void> {
  if (!ACCEPTED_LOGO_TYPES.test(file.type)) {
    _error = t("branding.modal.notImage", undefined, "File must be a PNG, JPG, SVG or WebP image");
    _rerender();
    return;
  }
  if (file.size > MAX_LOGO_BYTES) {
    _error = t("branding.modal.tooLarge", undefined, "Image is too large (max 2 MB)");
    _rerender();
    return;
  }
  try {
    const dataUrl = await fileToDataUrl(file);
    _error = null;
    _useUrl = false;
    patch({ logoDataUrl: dataUrl, logoUrl: "" });
  } catch {
    _error = t("branding.modal.notImage", undefined, "File must be a PNG, JPG, SVG or WebP image");
    _rerender();
  }
}

function resetToDefault(): void {
  _error = null;
  _useUrl = false;
  patch({ appName: "", tagline: "", logoDataUrl: "", logoUrl: "" });
}

async function save(state: AppViewState, client: GatewayBrowserClient): Promise<void> {
  _saving = true;
  _error = null;
  _rerender();
  try {
    // Write the four branding fields into the controller draft, then persist
    // via the shared branding.set path. Trim text so a stray space doesn't
    // shadow the topbar default.
    updateDraftBranding(state, {
      appName: _draft.appName.trim(),
      tagline: _draft.tagline.trim(),
      logoDataUrl: _draft.logoDataUrl,
      logoUrl: _draft.logoUrl.trim(),
    });
    await saveDraft(state, client);
    _saving = false;
    closeBrandingModal();
  } catch (err) {
    _saving = false;
    _error = String((err as Error)?.message ?? err);
    _rerender();
  }
}

// ── Focus trap ──────────────────────────────────────────────────────────────
function focusableWithin(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      'a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])',
    ),
  ).filter((el) => el.offsetParent !== null || el === document.activeElement);
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    closeBrandingModal();
    return;
  }
  if (e.key !== "Tab") return;
  const modal = (e.currentTarget as HTMLElement).querySelector<HTMLElement>(".brd-modal");
  if (!modal) return;
  const items = focusableWithin(modal);
  if (items.length === 0) return;
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement as HTMLElement | null;
  if (e.shiftKey && active === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
}

// ── Render ──────────────────────────────────────────────────────────────────
export function renderBrandingModal(
  state: AppViewState,
  client: GatewayBrowserClient,
): TemplateResult | typeof nothing {
  if (!_open) return nothing;

  const title = _draft.appName.trim() || BRAND_DEFAULT_TITLE;
  const subtitle = _draft.tagline.trim() || BRAND_DEFAULT_SUBTITLE;
  const logo = _draft.logoDataUrl || _draft.logoUrl || BRAND_DEFAULT_LOGO;

  return html`
    ${styles()}
    <div
      class="brd-overlay"
      role="presentation"
      @click=${(e: MouseEvent) => {
        if (e.target === e.currentTarget) closeBrandingModal();
      }}
      @keydown=${onKeydown}
    >
      <div
        class="brd-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="brd-modal-title"
        ${ref((el?: Element) => {
          if (el instanceof HTMLElement && !_focused) {
            _focused = true;
            const input = el.querySelector<HTMLElement>("input,button");
            setTimeout(() => input?.focus(), 0);
          }
        })}
      >
        <!-- Decorative gold glow + corner brackets -->
        <span class="brd-glow" aria-hidden="true"></span>
        <span class="brd-corner brd-corner-tl" aria-hidden="true"></span>
        <span class="brd-corner brd-corner-tr" aria-hidden="true"></span>
        <span class="brd-corner brd-corner-bl" aria-hidden="true"></span>
        <span class="brd-corner brd-corner-br" aria-hidden="true"></span>

        <header class="brd-header">
          <div class="brd-eyebrow">
            <span class="brd-eyebrow-dot"></span>
            <span>InfiniBot · Brand</span>
          </div>
          <h2 class="brd-title" id="brd-modal-title">
            ${t("branding.modal.title", undefined, "Customize branding")}
          </h2>
          <button
            class="brd-close"
            title=${t("branding.modal.close", undefined, "Close")}
            aria-label=${t("branding.modal.close", undefined, "Close")}
            @click=${() => closeBrandingModal()}
          >×</button>
        </header>

        <div class="brd-body">
          <!-- Hero preview — full-width, matches the topbar look -->
          <div class="brd-preview-card">
            <div class="brd-preview-grid">
              <div class="brd-preview-logo">
                <img src=${logo} alt="" />
              </div>
              <div class="brd-preview-text">
                <div class="brd-preview-name">${title}</div>
                <div class="brd-preview-sub">${subtitle}</div>
              </div>
              <span class="brd-preview-chip">LIVE PREVIEW</span>
            </div>
          </div>

          <!-- Two-column fields on desktop -->
          <div class="brd-fields-grid">
            <div class="brd-field">
              <label class="brd-label" for="brd-title-input">
                ${t("branding.modal.brandTitle", undefined, "Brand title")}
              </label>
              <input
                id="brd-title-input"
                class="brd-input"
                type="text"
                placeholder=${BRAND_DEFAULT_TITLE}
                .value=${_draft.appName}
                @input=${(e: Event) => patch({ appName: (e.target as HTMLInputElement).value })}
              />
            </div>
            <div class="brd-field">
              <label class="brd-label" for="brd-sub-input">
                ${t("branding.modal.brandSubtitle", undefined, "Brand subtitle")}
              </label>
              <input
                id="brd-sub-input"
                class="brd-input"
                type="text"
                placeholder=${BRAND_DEFAULT_SUBTITLE}
                .value=${_draft.tagline}
                @input=${(e: Event) => patch({ tagline: (e.target as HTMLInputElement).value })}
              />
            </div>
          </div>

          <!-- Logo source -->
          <div class="brd-field">
            <div class="brd-label-row">
              <label class="brd-label">${t("branding.modal.logo", undefined, "Logo")}</label>
              <div class="brd-source-toggle" role="tablist" aria-label="Logo source">
                <button
                  type="button"
                  role="tab"
                  class="brd-source ${!_useUrl ? "active" : ""}"
                  aria-selected=${!_useUrl}
                  @click=${() => { _useUrl = false; _error = null; _rerender(); }}
                >Upload</button>
                <button
                  type="button"
                  role="tab"
                  class="brd-source ${_useUrl ? "active" : ""}"
                  aria-selected=${_useUrl}
                  @click=${() => { _useUrl = true; _error = null; _rerender(); }}
                >URL</button>
              </div>
            </div>
            ${_useUrl
              ? html`
                  <input
                    class="brd-input"
                    type="text"
                    placeholder="https://example.com/logo.png"
                    aria-label=${t("branding.modal.logoUrl", undefined, "Logo URL")}
                    .value=${_draft.logoUrl}
                    @input=${(e: Event) =>
                      patch({ logoUrl: (e.target as HTMLInputElement).value, logoDataUrl: "" })}
                  />
                `
              : html`
                  <label
                    class="brd-drop ${_dragOver ? "brd-drop--over" : ""}"
                    @dragover=${(e: DragEvent) => {
                      e.preventDefault();
                      if (!_dragOver) { _dragOver = true; _rerender(); }
                    }}
                    @dragleave=${() => { if (_dragOver) { _dragOver = false; _rerender(); } }}
                    @drop=${(e: DragEvent) => {
                      e.preventDefault();
                      _dragOver = false;
                      const f = e.dataTransfer?.files?.[0];
                      if (f) void ingestFile(f);
                      else _rerender();
                    }}
                  >
                    <div class="brd-drop-logo">
                      <img src=${logo} alt="" />
                    </div>
                    <div class="brd-drop-copy">
                      <div class="brd-drop-hint">
                        ${t("branding.modal.dropHint", undefined, "Drop an image · or click to choose")}
                      </div>
                      <div class="brd-drop-formats">
                        PNG · JPG · SVG · WebP &nbsp;·&nbsp; up to 2 MB
                      </div>
                    </div>
                    <div class="brd-drop-cta">${icons_upload()}</div>
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/svg+xml,image/webp"
                      style="display:none"
                      @change=${(e: Event) => {
                        const f = (e.target as HTMLInputElement).files?.[0];
                        if (f) void ingestFile(f);
                      }}
                    />
                  </label>
                `}
          </div>

          ${_error ? html`<div class="brd-error" role="alert">${_error}</div>` : nothing}
        </div>

        <footer class="brd-footer">
          <button class="brd-btn brd-btn--ghost" @click=${() => resetToDefault()}>
            ${t("branding.modal.reset", undefined, "Reset to default")}
          </button>
          <span class="brd-footer-spacer"></span>
          <button class="brd-btn brd-btn--secondary" @click=${() => closeBrandingModal()}>
            ${t("branding.modal.cancel", undefined, "Cancel")}
          </button>
          <button
            class="brd-btn brd-btn--primary"
            ?disabled=${_saving}
            @click=${() => void save(state, client)}
          >
            ${_saving
              ? t("branding.modal.saving", undefined, "Saving…")
              : t("branding.modal.save", undefined, "Save changes")}
          </button>
        </footer>
      </div>
    </div>
  `;
}

function icons_upload(): TemplateResult {
  return html`<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="17 8 12 3 7 8" />
    <line x1="12" y1="3" x2="12" y2="15" />
  </svg>`;
}

// ── Styles ──────────────────────────────────────────────────────────────────
// All rules are namespaced under `.brd-overlay` so global app CSS can't bleed
// into the modal, and the modal can't bleed into the rest of the app. Sizing
// uses absolute px/clamp so the modal can never grow to fill the viewport
// even when an ancestor is a flex/grid container.
let _stylesInjected = false;
function styles(): TemplateResult | typeof nothing {
  if (_stylesInjected) return nothing;
  _stylesInjected = true;
  return html`
    <style>
      .brd-overlay {
        position: fixed; inset: 0;
        background: radial-gradient(
          ellipse at center,
          rgba(0, 0, 0, 0.55) 0%,
          rgba(0, 0, 0, 0.78) 70%
        );
        -webkit-backdrop-filter: blur(10px) saturate(140%);
        backdrop-filter: blur(10px) saturate(140%);
        display: flex; align-items: center; justify-content: center;
        z-index: 10001;
        padding: 24px;
        animation: brdFade 0.18s ease-out;
        /* Isolate the modal's stacking + filter context so app-level filters
           or transforms can't reposition it. */
        isolation: isolate;
        box-sizing: border-box;
      }
      .brd-overlay * { box-sizing: border-box; }

      @keyframes brdFade {
        from { opacity: 0; }
        to { opacity: 1; }
      }
      @keyframes brdSlide {
        from { transform: translateY(20px) scale(0.97); opacity: 0; }
        to   { transform: translateY(0)    scale(1);    opacity: 1; }
      }
      @keyframes brdGlow {
        0%, 100% { opacity: 0.7; }
        50%       { opacity: 1; }
      }

      .brd-overlay .brd-modal {
        position: relative;
        width: clamp(320px, 92vw, 520px);
        max-height: min(88vh, 760px);
        overflow: hidden;
        display: flex; flex-direction: column;
        background:
          linear-gradient(155deg, rgba(255,215,0,0.05), rgba(255,255,255,0.014) 50%, rgba(0,0,0,0.45)),
          rgba(14, 14, 18, 0.92);
        border: 1px solid rgba(255, 255, 255, 0.14);
        border-radius: 18px;
        box-shadow:
          0 30px 80px rgba(0, 0, 0, 0.60),
          0 0 0 1px rgba(255, 215, 0, 0.08) inset,
          0 1px 0 rgba(255, 255, 255, 0.06) inset;
        animation: brdSlide 0.24s cubic-bezier(0.2, 0.9, 0.3, 1) both;
        font-family: var(--font-body, system-ui, -apple-system, sans-serif);
        color: rgba(245, 245, 244, 0.95);
      }

      /* Decorative gold glow + corner brackets — pure CSS, zero weight */
      .brd-overlay .brd-glow {
        position: absolute; top: -120px; right: -120px;
        width: 320px; height: 320px; pointer-events: none;
        background: radial-gradient(closest-side, rgba(255,215,0,0.22), transparent 70%);
        filter: blur(30px);
        animation: brdGlow 5s ease-in-out infinite;
      }
      .brd-overlay .brd-corner {
        position: absolute; width: 14px; height: 14px;
        pointer-events: none;
      }
      .brd-overlay .brd-corner-tl { top: 8px; left: 8px;
        border-top: 1.5px solid #ffd700; border-left: 1.5px solid #ffd700;
        border-top-left-radius: 6px; }
      .brd-overlay .brd-corner-tr { top: 8px; right: 8px;
        border-top: 1.5px solid #ffd700; border-right: 1.5px solid #ffd700;
        border-top-right-radius: 6px; }
      .brd-overlay .brd-corner-bl { bottom: 8px; left: 8px;
        border-bottom: 1.5px solid #ffd700; border-left: 1.5px solid #ffd700;
        border-bottom-left-radius: 6px; }
      .brd-overlay .brd-corner-br { bottom: 8px; right: 8px;
        border-bottom: 1.5px solid #ffd700; border-right: 1.5px solid #ffd700;
        border-bottom-right-radius: 6px; }

      /* Header */
      .brd-overlay .brd-header {
        position: relative; z-index: 2;
        padding: 22px 26px 14px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.06);
      }
      .brd-overlay .brd-eyebrow {
        display: inline-flex; align-items: center; gap: 8px;
        font-size: 10.5px;
        letter-spacing: 0.18em;
        text-transform: uppercase;
        color: rgba(245, 245, 244, 0.55);
        margin-bottom: 6px;
        font-family: ui-monospace, 'JetBrains Mono', monospace;
      }
      .brd-overlay .brd-eyebrow-dot {
        width: 7px; height: 7px; border-radius: 50%;
        background: #ffd700;
        box-shadow: 0 0 8px #ffd700;
      }
      .brd-overlay .brd-title {
        margin: 0;
        font-size: 22px;
        font-weight: 700;
        letter-spacing: -0.01em;
        color: rgba(245, 245, 244, 0.98);
        line-height: 1.2;
      }
      .brd-overlay .brd-close {
        position: absolute; top: 18px; right: 18px;
        width: 32px; height: 32px;
        background: rgba(255, 255, 255, 0.04);
        border: 1px solid rgba(255, 255, 255, 0.10);
        border-radius: 8px;
        color: rgba(245, 245, 244, 0.65);
        font-size: 20px; line-height: 1;
        cursor: pointer;
        display: inline-flex; align-items: center; justify-content: center;
        transition: background 0.12s, color 0.12s, border-color 0.12s, transform 0.12s;
        font-family: inherit;
      }
      .brd-overlay .brd-close:hover {
        background: rgba(239, 68, 68, 0.18);
        border-color: rgba(239, 68, 68, 0.45);
        color: #fca5a5;
        transform: rotate(90deg);
      }

      /* Body */
      .brd-overlay .brd-body {
        position: relative; z-index: 2;
        padding: 20px 26px 4px;
        overflow-y: auto;
        display: flex; flex-direction: column;
        gap: 18px;
        scrollbar-width: thin;
        scrollbar-color: rgba(255, 255, 255, 0.12) transparent;
      }
      .brd-overlay .brd-body::-webkit-scrollbar { width: 6px; }
      .brd-overlay .brd-body::-webkit-scrollbar-thumb {
        background: rgba(255, 255, 255, 0.12);
        border-radius: 3px;
      }

      /* Preview card */
      .brd-overlay .brd-preview-card {
        position: relative;
        padding: 18px 18px 16px;
        border-radius: 14px;
        background:
          linear-gradient(135deg, rgba(255,215,0,0.10), rgba(255,255,255,0.02) 60%, rgba(0,0,0,0.25));
        border: 1px solid rgba(255, 215, 0, 0.30);
        box-shadow:
          inset 0 1px 0 rgba(255, 255, 255, 0.08),
          0 4px 18px rgba(0, 0, 0, 0.35);
        overflow: hidden;
      }
      .brd-overlay .brd-preview-grid {
        display: grid;
        grid-template-columns: auto 1fr auto;
        align-items: center;
        gap: 14px;
      }
      .brd-overlay .brd-preview-logo {
        width: 52px; height: 52px;
        border-radius: 12px;
        overflow: hidden;
        display: inline-flex; align-items: center; justify-content: center;
        background: linear-gradient(135deg, rgba(255,215,0,0.18), rgba(255,255,255,0.04));
        border: 1px solid rgba(255, 215, 0, 0.35);
        flex-shrink: 0;
      }
      .brd-overlay .brd-preview-logo img,
      .brd-overlay .brd-drop-logo img {
        width: 100%; height: 100%;
        object-fit: contain;
        padding: 4px;
      }
      .brd-overlay .brd-preview-text {
        min-width: 0;
        display: flex; flex-direction: column;
        gap: 3px;
      }
      .brd-overlay .brd-preview-name {
        font-size: 17px;
        font-weight: 700;
        letter-spacing: 0.04em;
        color: #fff;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .brd-overlay .brd-preview-sub {
        font-size: 12px;
        color: rgba(245, 245, 244, 0.62);
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .brd-overlay .brd-preview-chip {
        font-size: 9px;
        letter-spacing: 0.14em;
        font-weight: 700;
        padding: 4px 8px;
        border-radius: 4px;
        background: rgba(255, 215, 0, 0.16);
        border: 1px solid rgba(255, 215, 0, 0.40);
        color: #ffd700;
        font-family: ui-monospace, monospace;
        white-space: nowrap;
        animation: brdGlow 2.2s ease-in-out infinite;
      }

      /* Field rows */
      .brd-overlay .brd-fields-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 14px;
      }
      .brd-overlay .brd-field { display: flex; flex-direction: column; gap: 7px; }
      .brd-overlay .brd-label-row {
        display: flex; align-items: center; justify-content: space-between;
      }
      .brd-overlay .brd-label {
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: rgba(245, 245, 244, 0.50);
        font-family: ui-monospace, monospace;
      }
      .brd-overlay .brd-input {
        width: 100%;
        padding: 10px 14px;
        border-radius: 9px;
        background: rgba(255, 255, 255, 0.035);
        border: 1px solid rgba(255, 255, 255, 0.10);
        color: #fff;
        font-size: 14px;
        font-weight: 500;
        outline: none;
        transition: border-color 0.15s, background 0.15s, box-shadow 0.15s;
        font-family: inherit;
      }
      .brd-overlay .brd-input::placeholder {
        color: rgba(245, 245, 244, 0.35);
      }
      .brd-overlay .brd-input:focus {
        border-color: rgba(255, 215, 0, 0.55);
        background: rgba(255, 255, 255, 0.06);
        box-shadow: 0 0 0 3px rgba(255, 215, 0, 0.12);
      }

      /* Source toggle (Upload | URL) */
      .brd-overlay .brd-source-toggle {
        display: inline-flex;
        padding: 2px;
        border-radius: 8px;
        background: rgba(255, 255, 255, 0.04);
        border: 1px solid rgba(255, 255, 255, 0.08);
      }
      .brd-overlay .brd-source {
        padding: 4px 12px;
        border-radius: 6px;
        background: none;
        border: none;
        color: rgba(245, 245, 244, 0.55);
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0.04em;
        cursor: pointer;
        transition: background 0.12s, color 0.12s;
        font-family: inherit;
      }
      .brd-overlay .brd-source:hover { color: rgba(245, 245, 244, 0.9); }
      .brd-overlay .brd-source.active {
        background: linear-gradient(135deg, rgba(255,215,0,0.28), rgba(255,215,0,0.10));
        color: #ffd700;
        box-shadow: 0 0 10px rgba(255, 215, 0, 0.18);
      }

      /* Drop zone */
      .brd-overlay .brd-drop {
        display: grid;
        grid-template-columns: auto 1fr auto;
        gap: 14px;
        align-items: center;
        padding: 16px 18px;
        border-radius: 12px;
        border: 1.5px dashed rgba(255, 255, 255, 0.18);
        background: rgba(255, 255, 255, 0.02);
        cursor: pointer;
        transition: border-color 0.15s, background 0.15s, transform 0.12s;
      }
      .brd-overlay .brd-drop:hover {
        border-color: rgba(255, 215, 0, 0.55);
        background: rgba(255, 215, 0, 0.04);
        transform: translateY(-1px);
      }
      .brd-overlay .brd-drop--over {
        border-color: #ffd700;
        background: rgba(255, 215, 0, 0.10);
        box-shadow: inset 0 0 18px rgba(255, 215, 0, 0.18);
      }
      .brd-overlay .brd-drop-logo {
        width: 56px; height: 56px;
        border-radius: 12px;
        overflow: hidden;
        display: inline-flex; align-items: center; justify-content: center;
        background: linear-gradient(135deg, rgba(255,215,0,0.14), rgba(255,255,255,0.04));
        border: 1px solid rgba(255, 215, 0, 0.30);
        flex-shrink: 0;
      }
      .brd-overlay .brd-drop-copy {
        display: flex; flex-direction: column;
        gap: 3px; min-width: 0;
      }
      .brd-overlay .brd-drop-hint {
        font-size: 13.5px;
        font-weight: 500;
        color: rgba(245, 245, 244, 0.92);
      }
      .brd-overlay .brd-drop-formats {
        font-size: 11px;
        color: rgba(245, 245, 244, 0.42);
        font-family: ui-monospace, monospace;
        letter-spacing: 0.03em;
      }
      .brd-overlay .brd-drop-cta {
        width: 36px; height: 36px;
        border-radius: 10px;
        background: rgba(255, 215, 0, 0.15);
        border: 1px solid rgba(255, 215, 0, 0.35);
        color: #ffd700;
        display: inline-flex; align-items: center; justify-content: center;
        flex-shrink: 0;
      }

      /* Error */
      .brd-overlay .brd-error {
        font-size: 13px;
        padding: 10px 12px;
        border-radius: 9px;
        background: rgba(239, 68, 68, 0.10);
        border: 1px solid rgba(239, 68, 68, 0.30);
        color: #fca5a5;
      }

      /* Footer */
      .brd-overlay .brd-footer {
        position: relative; z-index: 2;
        display: flex; align-items: center;
        gap: 10px;
        padding: 16px 26px 20px;
        border-top: 1px solid rgba(255, 255, 255, 0.06);
        background: linear-gradient(0deg, rgba(0,0,0,0.18), transparent);
      }
      .brd-overlay .brd-footer-spacer { flex: 1; }
      .brd-overlay .brd-btn {
        padding: 10px 18px;
        border-radius: 10px;
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        border: 1px solid transparent;
        transition: transform 0.12s, background 0.15s, opacity 0.15s, box-shadow 0.15s, border-color 0.15s;
        font-family: inherit;
      }
      .brd-overlay .brd-btn:disabled { opacity: 0.55; cursor: not-allowed; }
      .brd-overlay .brd-btn--primary {
        background: linear-gradient(135deg, #ffd700, #f0a040);
        color: #1a1208;
        border-color: rgba(255, 255, 255, 0.18);
        box-shadow:
          0 4px 14px rgba(255, 215, 0, 0.30),
          inset 0 1px 0 rgba(255, 255, 255, 0.30);
      }
      .brd-overlay .brd-btn--primary:not(:disabled):hover {
        transform: translateY(-1px);
        box-shadow:
          0 6px 20px rgba(255, 215, 0, 0.45),
          inset 0 1px 0 rgba(255, 255, 255, 0.40);
      }
      .brd-overlay .brd-btn--secondary {
        background: rgba(255, 255, 255, 0.05);
        color: rgba(245, 245, 244, 0.92);
        border-color: rgba(255, 255, 255, 0.14);
      }
      .brd-overlay .brd-btn--secondary:hover {
        background: rgba(255, 255, 255, 0.10);
        border-color: rgba(255, 255, 255, 0.22);
      }
      .brd-overlay .brd-btn--ghost {
        background: none;
        color: rgba(245, 245, 244, 0.50);
      }
      .brd-overlay .brd-btn--ghost:hover {
        color: rgba(245, 245, 244, 0.85);
        background: rgba(255, 255, 255, 0.04);
      }

      /* Mobile */
      @media (max-width: 560px) {
        .brd-overlay { padding: 12px; }
        .brd-overlay .brd-modal { width: 100%; max-height: 92vh; border-radius: 14px; }
        .brd-overlay .brd-header { padding: 18px 18px 12px; }
        .brd-overlay .brd-title { font-size: 19px; }
        .brd-overlay .brd-body { padding: 16px 18px 4px; gap: 14px; }
        .brd-overlay .brd-fields-grid { grid-template-columns: 1fr; }
        .brd-overlay .brd-preview-grid { grid-template-columns: auto 1fr; }
        .brd-overlay .brd-preview-chip { grid-column: 1 / -1; justify-self: end; }
        .brd-overlay .brd-footer { padding: 14px 18px 16px; flex-wrap: wrap; }
        .brd-overlay .brd-footer-spacer { flex-basis: 100%; height: 0; }
        .brd-overlay .brd-corner { display: none; }
      }
    </style>
  `;
}
