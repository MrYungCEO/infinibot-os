/**
 * Brand Control — Visual Brand Identity Editor
 * 
 * Comprehensive brand management UI with color palettes, typography,
 * logo management, voice/tone, and designer context preview.
 */

import { html, nothing, TemplateResult } from "lit";
import "../components/doc-agent-panel.js";
import type { GatewayBrowserClient } from "../gateway.js";
import type { AppViewState } from "../app-view-state.js";
import type { BrandState, BrandProfile, BrandColor, BrandTypography, BrandLogo } from "../controllers/brand.js";
import {
  saveBrand,
  setBrandTab,
  addColor,
  updateColor,
  removeColor,
  updateTypography,
  updateVoice,
  updateGuidelines,
  updateBrandField,
  uploadLogo,
  removeLogo,
  generateDesignerContext,
} from "../controllers/brand.js";

// ── Styles ───────────────────────────────────────────────────

const brandStyles = html`
<style>
  .brand-control {
    font-family: 'Inter', system-ui, sans-serif;
    background: #0a0a0a;
    color: #e5e5e5;
    min-height: 100%;
    padding: 24px;
  }

  .brand-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 24px;
    padding-bottom: 16px;
    border-bottom: 1px solid color-mix(in srgb, var(--g-primary) 20%, transparent);
  }

  .brand-title {
    display: flex;
    align-items: center;
    gap: 12px;
    margin: 0;
    font-size: 1.5rem;
    font-weight: 600;
    color: var(--g-primary);
  }

  .brand-title-icon {
    font-size: 1.75rem;
  }

  .save-btn {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 20px;
    background: linear-gradient(135deg, var(--g-primary) 0%, #b8962f 100%);
    color: #000;
    border: none;
    border-radius: 8px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s;
  }

  .save-btn:hover:not(:disabled) {
    transform: translateY(-1px);
    box-shadow: 0 4px 12px color-mix(in srgb, var(--g-primary) 30%, transparent);
  }

  .save-btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  /* Tab Navigation */
  .brand-tabs {
    display: flex;
    gap: 4px;
    margin-bottom: 24px;
    background: rgba(255, 255, 255, 0.03);
    padding: 4px;
    border-radius: 12px;
  }

  .brand-tab {
    flex: 1;
    padding: 12px 16px;
    background: transparent;
    border: none;
    color: #888;
    font-weight: 500;
    cursor: pointer;
    border-radius: 8px;
    transition: all 0.2s;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
  }

  .brand-tab:hover {
    color: #e5e5e5;
    background: rgba(255, 255, 255, 0.05);
  }

  .brand-tab.active {
    background: color-mix(in srgb, var(--g-primary) 15%, transparent);
    color: var(--g-primary);
  }

  .tab-icon {
    font-size: 1.1rem;
  }

  /* Content Panels */
  .brand-panel {
    background: rgba(255, 255, 255, 0.02);
    border: 1px solid rgba(255, 255, 255, 0.05);
    border-radius: 16px;
    padding: 24px;
  }

  .panel-title {
    font-size: 1.1rem;
    font-weight: 600;
    color: var(--g-primary);
    margin: 0 0 16px 0;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .panel-subtitle {
    font-size: 0.85rem;
    color: #888;
    margin: -8px 0 16px 0;
  }

  /* Color Palette Section */
  .color-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 16px;
    margin-bottom: 16px;
  }

  .color-card {
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 12px;
    overflow: hidden;
    transition: all 0.2s;
  }

  .color-card:hover {
    border-color: color-mix(in srgb, var(--g-primary) 30%, transparent);
  }

  .color-swatch {
    height: 80px;
    position: relative;
  }

  .color-swatch-actions {
    position: absolute;
    top: 8px;
    right: 8px;
    display: flex;
    gap: 4px;
    opacity: 0;
    transition: opacity 0.2s;
  }

  .color-card:hover .color-swatch-actions {
    opacity: 1;
  }

  .swatch-btn {
    width: 28px;
    height: 28px;
    border-radius: 6px;
    border: none;
    background: rgba(0, 0, 0, 0.5);
    color: white;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.8rem;
  }

  .swatch-btn:hover {
    background: rgba(0, 0, 0, 0.7);
  }

  .color-info {
    padding: 12px;
  }

  .color-name {
    font-weight: 600;
    font-size: 0.9rem;
    margin-bottom: 4px;
  }

  .color-hex {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.8rem;
    color: #888;
    margin-bottom: 6px;
  }

  .color-usage {
    font-size: 0.75rem;
    color: #666;
  }

  .add-color-btn {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    height: 140px;
    background: transparent;
    border: 2px dashed rgba(255, 255, 255, 0.1);
    border-radius: 12px;
    color: #666;
    cursor: pointer;
    transition: all 0.2s;
  }

  .add-color-btn:hover {
    border-color: color-mix(in srgb, var(--g-primary) 30%, transparent);
    color: var(--g-primary);
  }

  .add-icon {
    font-size: 1.5rem;
  }

  /* Typography Section */
  .typography-list {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .typography-item {
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 12px;
    padding: 20px;
  }

  .typography-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 12px;
  }

  .typography-category {
    font-weight: 600;
    color: var(--g-primary);
    text-transform: capitalize;
  }

  .typography-preview {
    padding: 16px;
    background: rgba(0, 0, 0, 0.3);
    border-radius: 8px;
    margin-bottom: 12px;
  }

  .typography-preview.heading {
    font-size: 1.75rem;
    font-weight: 700;
  }

  .typography-preview.body {
    font-size: 1rem;
    line-height: 1.6;
  }

  .typography-preview.accent {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.9rem;
  }

  .typography-controls {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    gap: 12px;
  }

  .form-group {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .form-label {
    font-size: 0.75rem;
    color: #888;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .form-input,
  .form-select,
  .form-textarea {
    padding: 10px 12px;
    background: rgba(0, 0, 0, 0.3);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 8px;
    color: #e5e5e5;
    font-size: 0.9rem;
    transition: all 0.2s;
  }

  .form-input:focus,
  .form-select:focus,
  .form-textarea:focus {
    outline: none;
    border-color: color-mix(in srgb, var(--g-primary) 50%, transparent);
  }

  .form-textarea {
    resize: vertical;
    min-height: 80px;
  }

  /* Logo Section */
  .logo-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 16px;
  }

  .logo-card {
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 12px;
    overflow: hidden;
    position: relative;
  }

  .logo-preview {
    height: 120px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: repeating-conic-gradient(#1a1a1a 0% 25%, #222 0% 50%) 50% / 20px 20px;
    padding: 16px;
  }

  .logo-preview img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
  }

  .logo-info {
    padding: 12px;
  }

  .logo-name {
    font-weight: 600;
    font-size: 0.85rem;
    margin-bottom: 4px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .logo-variant {
    font-size: 0.75rem;
    color: #888;
    text-transform: capitalize;
  }

  .logo-remove {
    position: absolute;
    top: 8px;
    right: 8px;
    width: 28px;
    height: 28px;
    border-radius: 6px;
    border: none;
    background: rgba(239, 68, 68, 0.8);
    color: white;
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.2s;
  }

  .logo-card:hover .logo-remove {
    opacity: 1;
  }

  .add-logo-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    min-height: 170px;
    background: transparent;
    border: 2px dashed rgba(255, 255, 255, 0.1);
    border-radius: 12px;
    color: #666;
    cursor: pointer;
    transition: all 0.2s;
  }

  .add-logo-card:hover {
    border-color: color-mix(in srgb, var(--g-primary) 30%, transparent);
    color: var(--g-primary);
  }

  /* Voice Section */
  .voice-section {
    display: flex;
    flex-direction: column;
    gap: 20px;
  }

  .tone-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 8px;
  }

  .tone-tag {
    padding: 6px 12px;
    background: color-mix(in srgb, var(--g-primary) 15%, transparent);
    border: 1px solid color-mix(in srgb, var(--g-primary) 30%, transparent);
    border-radius: 20px;
    color: var(--g-primary);
    font-size: 0.85rem;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .tone-tag-remove {
    background: none;
    border: none;
    color: inherit;
    cursor: pointer;
    padding: 0;
    font-size: 1rem;
    opacity: 0.7;
  }

  .tone-tag-remove:hover {
    opacity: 1;
  }

  .tone-input-wrapper {
    display: flex;
    gap: 8px;
    margin-top: 8px;
  }

  .tone-input {
    flex: 1;
    padding: 8px 12px;
    background: rgba(0, 0, 0, 0.3);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 8px;
    color: #e5e5e5;
  }

  .tone-add-btn {
    padding: 8px 16px;
    background: color-mix(in srgb, var(--g-primary) 20%, transparent);
    border: 1px solid color-mix(in srgb, var(--g-primary) 30%, transparent);
    border-radius: 8px;
    color: var(--g-primary);
    cursor: pointer;
  }

  .do-dont-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 20px;
  }

  .do-list,
  .dont-list {
    padding: 16px;
    border-radius: 12px;
  }

  .do-list {
    background: rgba(34, 197, 94, 0.1);
    border: 1px solid rgba(34, 197, 94, 0.2);
  }

  .dont-list {
    background: rgba(239, 68, 68, 0.1);
    border: 1px solid rgba(239, 68, 68, 0.2);
  }

  .list-title {
    font-weight: 600;
    margin-bottom: 12px;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .do-list .list-title {
    color: #22c55e;
  }

  .dont-list .list-title {
    color: #ef4444;
  }

  .list-items {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .list-item {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 0.9rem;
  }

  /* Guidelines Section */
  .guidelines-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 20px;
  }

  @media (max-width: 768px) {
    .guidelines-grid,
    .do-dont-grid {
      grid-template-columns: 1fr;
    }
  }

  /* Preview Section */
  .preview-section {
    display: flex;
    flex-direction: column;
    gap: 20px;
  }

  .preview-card {
    background: #000;
    border: 1px solid color-mix(in srgb, var(--g-primary) 20%, transparent);
    border-radius: 12px;
    padding: 20px;
  }

  .preview-card-title {
    font-size: 0.85rem;
    color: #888;
    margin-bottom: 12px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .color-palette-preview {
    display: flex;
    gap: 4px;
    height: 60px;
    border-radius: 8px;
    overflow: hidden;
  }

  .palette-swatch {
    flex: 1;
  }

  .designer-context-preview {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.8rem;
    color: #888;
    white-space: pre-wrap;
    line-height: 1.6;
    max-height: 400px;
    overflow-y: auto;
    padding: 16px;
    background: rgba(0, 0, 0, 0.3);
    border-radius: 8px;
  }

  /* Identity Section */
  .identity-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 20px;
    margin-bottom: 20px;
  }

  @media (max-width: 768px) {
    .identity-grid {
      grid-template-columns: 1fr;
    }
  }

  /* Success/Error Messages */
  .brand-message {
    padding: 12px 16px;
    border-radius: 8px;
    margin-bottom: 16px;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .brand-message.success {
    background: rgba(34, 197, 94, 0.15);
    border: 1px solid rgba(34, 197, 94, 0.3);
    color: #22c55e;
  }

  .brand-message.error {
    background: rgba(239, 68, 68, 0.15);
    border: 1px solid rgba(239, 68, 68, 0.3);
    color: #ef4444;
  }

  /* Color Picker Modal */
  .color-picker-modal {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.8);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  }

  .color-picker-content {
    background: #1a1a1a;
    border: 1px solid color-mix(in srgb, var(--g-primary) 30%, transparent);
    border-radius: 16px;
    padding: 24px;
    width: 100%;
    max-width: 400px;
  }

  .color-picker-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 20px;
  }

  .color-picker-title {
    font-weight: 600;
    color: var(--g-primary);
  }

  .close-btn {
    background: none;
    border: none;
    color: #888;
    cursor: pointer;
    font-size: 1.5rem;
    padding: 0;
  }

  .close-btn:hover {
    color: #e5e5e5;
  }

  .color-picker-actions {
    display: flex;
    gap: 12px;
    margin-top: 20px;
  }

  .btn-secondary {
    flex: 1;
    padding: 10px 16px;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 8px;
    color: #e5e5e5;
    cursor: pointer;
  }

  .btn-primary {
    flex: 1;
    padding: 10px 16px;
    background: linear-gradient(135deg, var(--g-primary) 0%, #b8962f 100%);
    border: none;
    border-radius: 8px;
    color: #000;
    font-weight: 600;
    cursor: pointer;
  }

  /* Logo Upload Modal */
  .logo-upload-zone {
    border: 2px dashed rgba(255, 255, 255, 0.2);
    border-radius: 12px;
    padding: 40px;
    text-align: center;
    cursor: pointer;
    transition: all 0.2s;
  }

  .logo-upload-zone:hover {
    border-color: color-mix(in srgb, var(--g-primary) 50%, transparent);
    background: color-mix(in srgb, var(--g-primary) 5%, transparent);
  }

  .upload-icon {
    font-size: 2.5rem;
    margin-bottom: 12px;
  }

  .upload-text {
    color: #888;
    font-size: 0.9rem;
  }

  .variant-select {
    margin-top: 16px;
  }
</style>
`;

// ── Tab Configuration ────────────────────────────────────────

const TABS = [
  { id: "colors", label: "Colors", icon: "🎨" },
  { id: "typography", label: "Typography", icon: "✏️" },
  { id: "logos", label: "Logos", icon: "🏷️" },
  { id: "voice", label: "Voice & Tone", icon: "💬" },
  { id: "guidelines", label: "Guidelines", icon: "📋" },
  { id: "preview", label: "Preview", icon: "👁️" },
] as const;

// ── Main Render ──────────────────────────────────────────────

export function renderBrandControl(
  gw: GatewayBrowserClient,
  state: AppViewState,
  businessName: string,
  businessId: string,
  setState: (fn: (s: AppViewState) => AppViewState) => void
): TemplateResult {
  const brandState = state.brandState;
  if (!brandState) return html``;

  const { brand, activeTab, saving, success, error } = brandState;
  if (!brand) {
    return html`
      ${brandStyles}
      <div class="brand-control">
        <div class="brand-panel" style="text-align: center; padding: 60px;">
          <p style="color: #888;">Loading brand settings...</p>
        </div>
      </div>
    `;
  }

  return html`
    ${brandStyles}
    <doc-agent-panel
      .client=${gw as any}
      docType="brand_doc"
      .documentId=${businessId || (brand as any).id || "default"}
      .title=${`Brand — ${businessName}`}
      .extra=${`colors=${brand.colors?.length ?? 0} fontEntries=${brand.typography?.length ?? 0}`}
    ></doc-agent-panel>
    <div class="brand-control">
      <div class="brand-header">
        <h1 class="brand-title">
          <span class="brand-title-icon">🎨</span>
          Brand Identity — ${businessName}
        </h1>
        <button
          class="save-btn"
          ?disabled=${saving}
          @click=${() => saveBrand(gw, brand, businessName, setState)}
        >
          ${saving ? "💾 Saving..." : "💾 Save Changes"}
        </button>
      </div>

      ${success ? html`
        <div class="brand-message success">
          <span>✅</span>
          <span>${success}</span>
        </div>
      ` : nothing}

      ${error ? html`
        <div class="brand-message error">
          <span>❌</span>
          <span>${error}</span>
        </div>
      ` : nothing}

      <!-- Identity Fields -->
      <div class="brand-panel" style="margin-bottom: 24px;">
        <h3 class="panel-title">🏢 Core Identity</h3>
        <div class="identity-grid">
          <div class="form-group">
            <label class="form-label">Tagline</label>
            <input
              type="text"
              class="form-input"
              placeholder="Your brand's memorable tagline"
              .value=${brand.tagline || ""}
              @input=${(e: Event) => updateBrandField("tagline", (e.target as HTMLInputElement).value, setState)}
            />
          </div>
          <div class="form-group">
            <label class="form-label">Mission Statement</label>
            <input
              type="text"
              class="form-input"
              placeholder="What you stand for"
              .value=${brand.mission || ""}
              @input=${(e: Event) => updateBrandField("mission", (e.target as HTMLInputElement).value, setState)}
            />
          </div>
        </div>
      </div>

      <!-- Tabs -->
      <div class="brand-tabs">
        ${TABS.map(tab => html`
          <button
            class="brand-tab ${activeTab === tab.id ? 'active' : ''}"
            @click=${() => setBrandTab(tab.id, setState)}
          >
            <span class="tab-icon">${tab.icon}</span>
            <span>${tab.label}</span>
          </button>
        `)}
      </div>

      <!-- Tab Content -->
      <div class="brand-panel">
        ${activeTab === "colors" ? renderColorsTab(brand, brandState, setState) : nothing}
        ${activeTab === "typography" ? renderTypographyTab(brand, setState) : nothing}
        ${activeTab === "logos" ? renderLogosTab(gw, brand, brandState, businessId, setState) : nothing}
        ${activeTab === "voice" ? renderVoiceTab(brand, setState) : nothing}
        ${activeTab === "guidelines" ? renderGuidelinesTab(brand, setState) : nothing}
        ${activeTab === "preview" ? renderPreviewTab(brand, businessName) : nothing}
      </div>
    </div>
  `;
}

// ── Colors Tab ───────────────────────────────────────────────

function renderColorsTab(
  brand: BrandProfile,
  brandState: BrandState,
  setState: (fn: (s: AppViewState) => AppViewState) => void
): TemplateResult {
  return html`
    <h3 class="panel-title">🎨 Color Palette</h3>
    <p class="panel-subtitle">Define your brand colors for consistent visual identity across all outputs.</p>
    
    <div class="color-grid">
      ${brand.colors.map((color, i) => html`
        <div class="color-card">
          <div class="color-swatch" style="background: ${color.hex}">
            <div class="color-swatch-actions">
              <button
                class="swatch-btn"
                title="Edit"
                @click=${() => setState(s => ({
                  ...s,
                  brandState: { ...s.brandState!, editingColorIndex: i, showColorPicker: true },
                }))}
              >✏️</button>
              <button
                class="swatch-btn"
                title="Remove"
                @click=${() => removeColor(i, setState)}
              >🗑️</button>
            </div>
          </div>
          <div class="color-info">
            <div class="color-name">${color.name}</div>
            <div class="color-hex">${color.hex}</div>
            <div class="color-usage">${color.usage}</div>
          </div>
        </div>
      `)}
      
      <button
        class="add-color-btn"
        @click=${() => setState(s => ({
          ...s,
          brandState: { ...s.brandState!, showColorPicker: true, editingColorIndex: null },
        }))}
      >
        <span class="add-icon">+</span>
        <span>Add Color</span>
      </button>
    </div>

    ${brandState.showColorPicker ? renderColorPicker(brand, brandState, setState) : nothing}
  `;
}

function renderColorPicker(
  brand: BrandProfile,
  brandState: BrandState,
  setState: (fn: (s: AppViewState) => AppViewState) => void
): TemplateResult {
  const isEditing = brandState.editingColorIndex !== null;
  const editingColor = isEditing ? brand.colors[brandState.editingColorIndex!] : null;

  return html`
    <div class="color-picker-modal" @click=${(e: Event) => {
      if ((e.target as HTMLElement).classList.contains('color-picker-modal')) {
        setState(s => ({ ...s, brandState: { ...s.brandState!, showColorPicker: false, editingColorIndex: null } }));
      }
    }}>
      <div class="color-picker-content">
        <div class="color-picker-header">
          <span class="color-picker-title">${isEditing ? "Edit Color" : "Add New Color"}</span>
          <button
            class="close-btn"
            @click=${() => setState(s => ({ ...s, brandState: { ...s.brandState!, showColorPicker: false, editingColorIndex: null } }))}
          >×</button>
        </div>

        <div class="form-group">
          <label class="form-label">Color Name</label>
          <input
            type="text"
            class="form-input"
            id="color-name"
            placeholder="e.g., Primary, Accent"
            .value=${editingColor?.name || brandState.newColor?.name || ""}
          />
        </div>

        <div class="form-group" style="margin-top: 16px;">
          <label class="form-label">Color Value</label>
          <div style="display: flex; gap: 12px; align-items: center;">
            <input
              type="color"
              id="color-hex"
              .value=${editingColor?.hex || brandState.newColor?.hex || "var(--g-primary)"}
              style="width: 60px; height: 40px; border: none; border-radius: 8px; cursor: pointer;"
            />
            <input
              type="text"
              class="form-input"
              id="color-hex-text"
              placeholder="var(--g-primary)"
              .value=${editingColor?.hex || brandState.newColor?.hex || "var(--g-primary)"}
              style="flex: 1; font-family: monospace;"
            />
          </div>
        </div>

        <div class="form-group" style="margin-top: 16px;">
          <label class="form-label">Usage Description</label>
          <input
            type="text"
            class="form-input"
            id="color-usage"
            placeholder="e.g., Primary buttons, highlights"
            .value=${editingColor?.usage || brandState.newColor?.usage || ""}
          />
        </div>

        <div class="color-picker-actions">
          <button
            class="btn-secondary"
            @click=${() => setState(s => ({ ...s, brandState: { ...s.brandState!, showColorPicker: false, editingColorIndex: null } }))}
          >Cancel</button>
          <button
            class="btn-primary"
            @click=${() => {
              const name = (document.getElementById("color-name") as HTMLInputElement)?.value || "Unnamed";
              const hex = (document.getElementById("color-hex") as HTMLInputElement)?.value || "#000000";
              const usage = (document.getElementById("color-usage") as HTMLInputElement)?.value || "";
              
              if (isEditing) {
                updateColor(brandState.editingColorIndex!, { name, hex, usage }, setState);
              } else {
                addColor({ name, hex, usage }, setState);
              }
              setState(s => ({ ...s, brandState: { ...s.brandState!, showColorPicker: false, editingColorIndex: null } }));
            }}
          >${isEditing ? "Update" : "Add Color"}</button>
        </div>
      </div>
    </div>
  `;
}

// ── Typography Tab ───────────────────────────────────────────

function renderTypographyTab(
  brand: BrandProfile,
  setState: (fn: (s: AppViewState) => AppViewState) => void
): TemplateResult {
  return html`
    <h3 class="panel-title">✏️ Typography</h3>
    <p class="panel-subtitle">Configure fonts for headings, body text, and accent/code elements.</p>
    
    <div class="typography-list">
      ${brand.typography.map(typo => html`
        <div class="typography-item">
          <div class="typography-header">
            <span class="typography-category">${typo.category}</span>
          </div>
          
          <div
            class="typography-preview ${typo.category}"
            style="font-family: ${typo.fontFamily}, ${typo.fallback}; font-weight: ${typo.weight};"
          >
            ${typo.category === "heading" ? "The Quick Brown Fox" : 
              typo.category === "body" ? "The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs." :
              "const code = 'monospace';"}
          </div>
          
          <div class="typography-controls">
            <div class="form-group">
              <label class="form-label">Font Family</label>
              <input
                type="text"
                class="form-input"
                .value=${typo.fontFamily}
                @input=${(e: Event) => updateTypography(typo.category, { fontFamily: (e.target as HTMLInputElement).value }, setState)}
              />
            </div>
            <div class="form-group">
              <label class="form-label">Weight</label>
              <select
                class="form-select"
                .value=${typo.weight}
                @change=${(e: Event) => updateTypography(typo.category, { weight: (e.target as HTMLSelectElement).value }, setState)}
              >
                <option value="300">Light (300)</option>
                <option value="400">Regular (400)</option>
                <option value="500">Medium (500)</option>
                <option value="600">Semibold (600)</option>
                <option value="700">Bold (700)</option>
                <option value="800">Extrabold (800)</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">Fallback</label>
              <input
                type="text"
                class="form-input"
                .value=${typo.fallback}
                @input=${(e: Event) => updateTypography(typo.category, { fallback: (e.target as HTMLInputElement).value }, setState)}
              />
            </div>
          </div>
        </div>
      `)}
    </div>
  `;
}

// ── Logos Tab ────────────────────────────────────────────────

function renderLogosTab(
  gw: GatewayBrowserClient,
  brand: BrandProfile,
  brandState: BrandState,
  businessId: string,
  setState: (fn: (s: AppViewState) => AppViewState) => void
): TemplateResult {
  return html`
    <h3 class="panel-title">🏷️ Logo Variants</h3>
    <p class="panel-subtitle">Upload different logo variants for various use cases.</p>
    
    <div class="logo-grid">
      ${brand.logos.map(logo => html`
        <div class="logo-card">
          <div class="logo-preview">
            <img src=${logo.path} alt=${logo.name} />
          </div>
          <div class="logo-info">
            <div class="logo-name">${logo.name}</div>
            <div class="logo-variant">${logo.variant}</div>
          </div>
          <button
            class="logo-remove"
            @click=${() => removeLogo(logo.id, setState)}
          >🗑️</button>
        </div>
      `)}
      
      <label class="add-logo-card">
        <span class="upload-icon">📤</span>
        <span>Upload Logo</span>
        <input
          type="file"
          accept="image/*"
          style="display: none;"
          @change=${async (e: Event) => {
            const file = (e.target as HTMLInputElement).files?.[0];
            if (file) {
              await uploadLogo(gw, businessId, file, "primary", setState);
            }
          }}
        />
      </label>
    </div>
  `;
}

// ── Voice Tab ────────────────────────────────────────────────

function renderVoiceTab(
  brand: BrandProfile,
  setState: (fn: (s: AppViewState) => AppViewState) => void
): TemplateResult {
  return html`
    <h3 class="panel-title">💬 Voice & Tone</h3>
    <p class="panel-subtitle">Define how your brand communicates.</p>
    
    <div class="voice-section">
      <div class="form-group">
        <label class="form-label">Tone Keywords</label>
        <div class="tone-tags">
          ${brand.voice.tone.map((t, i) => html`
            <span class="tone-tag">
              ${t}
              <button
                class="tone-tag-remove"
                @click=${() => {
                  const newTone = brand.voice.tone.filter((_, idx) => idx !== i);
                  updateVoice({ tone: newTone }, setState);
                }}
              >×</button>
            </span>
          `)}
        </div>
        <div class="tone-input-wrapper">
          <input
            type="text"
            class="tone-input"
            id="new-tone"
            placeholder="Add a tone word (e.g., friendly, bold, technical)"
            @keypress=${(e: KeyboardEvent) => {
              if (e.key === "Enter") {
                const input = document.getElementById("new-tone") as HTMLInputElement;
                if (input.value.trim()) {
                  updateVoice({ tone: [...brand.voice.tone, input.value.trim()] }, setState);
                  input.value = "";
                }
              }
            }}
          />
          <button
            class="tone-add-btn"
            @click=${() => {
              const input = document.getElementById("new-tone") as HTMLInputElement;
              if (input.value.trim()) {
                updateVoice({ tone: [...brand.voice.tone, input.value.trim()] }, setState);
                input.value = "";
              }
            }}
          >Add</button>
        </div>
      </div>

      <div class="form-group">
        <label class="form-label">Brand Personality</label>
        <textarea
          class="form-textarea"
          placeholder="Describe your brand's personality in a few sentences..."
          .value=${brand.voice.personality}
          @input=${(e: Event) => updateVoice({ personality: (e.target as HTMLTextAreaElement).value }, setState)}
        ></textarea>
      </div>

      <div class="do-dont-grid">
        <div class="do-list">
          <div class="list-title">✅ Do</div>
          <div class="list-items">
            ${brand.voice.doList.map((item, i) => html`
              <div class="list-item">
                <span>•</span>
                <input
                  type="text"
                  class="form-input"
                  style="flex: 1;"
                  .value=${item}
                  @input=${(e: Event) => {
                    const newList = [...brand.voice.doList];
                    newList[i] = (e.target as HTMLInputElement).value;
                    updateVoice({ doList: newList }, setState);
                  }}
                />
              </div>
            `)}
            <button
              class="tone-add-btn"
              style="margin-top: 8px;"
              @click=${() => updateVoice({ doList: [...brand.voice.doList, ""] }, setState)}
            >+ Add</button>
          </div>
        </div>

        <div class="dont-list">
          <div class="list-title">❌ Don't</div>
          <div class="list-items">
            ${brand.voice.dontList.map((item, i) => html`
              <div class="list-item">
                <span>•</span>
                <input
                  type="text"
                  class="form-input"
                  style="flex: 1;"
                  .value=${item}
                  @input=${(e: Event) => {
                    const newList = [...brand.voice.dontList];
                    newList[i] = (e.target as HTMLInputElement).value;
                    updateVoice({ dontList: newList }, setState);
                  }}
                />
              </div>
            `)}
            <button
              class="tone-add-btn"
              style="margin-top: 8px;"
              @click=${() => updateVoice({ dontList: [...brand.voice.dontList, ""] }, setState)}
            >+ Add</button>
          </div>
        </div>
      </div>
    </div>
  `;
}

// ── Guidelines Tab ───────────────────────────────────────────

function renderGuidelinesTab(
  brand: BrandProfile,
  setState: (fn: (s: AppViewState) => AppViewState) => void
): TemplateResult {
  return html`
    <h3 class="panel-title">📋 Brand Guidelines</h3>
    <p class="panel-subtitle">Document rules for using brand elements.</p>
    
    <div class="guidelines-grid">
      <div class="form-group">
        <label class="form-label">Logo Usage</label>
        <textarea
          class="form-textarea"
          placeholder="Rules for logo placement, sizing, clear space..."
          .value=${brand.guidelines.logoUsage}
          @input=${(e: Event) => updateGuidelines({ logoUsage: (e.target as HTMLTextAreaElement).value }, setState)}
        ></textarea>
      </div>

      <div class="form-group">
        <label class="form-label">Color Usage</label>
        <textarea
          class="form-textarea"
          placeholder="When to use each color, combinations to avoid..."
          .value=${brand.guidelines.colorUsage}
          @input=${(e: Event) => updateGuidelines({ colorUsage: (e.target as HTMLTextAreaElement).value }, setState)}
        ></textarea>
      </div>

      <div class="form-group">
        <label class="form-label">Typography Rules</label>
        <textarea
          class="form-textarea"
          placeholder="Font sizing, hierarchy, line height guidelines..."
          .value=${brand.guidelines.typographyRules}
          @input=${(e: Event) => updateGuidelines({ typographyRules: (e.target as HTMLTextAreaElement).value }, setState)}
        ></textarea>
      </div>

      <div class="form-group">
        <label class="form-label">Image Style</label>
        <textarea
          class="form-textarea"
          placeholder="Photography style, illustration guidelines, visual mood..."
          .value=${brand.guidelines.imageStyle}
          @input=${(e: Event) => updateGuidelines({ imageStyle: (e.target as HTMLTextAreaElement).value }, setState)}
        ></textarea>
      </div>
    </div>

    <div class="form-group" style="margin-top: 20px;">
      <label class="form-label">Additional Notes</label>
      <textarea
        class="form-textarea"
        placeholder="Any other brand guidelines or notes..."
        .value=${brand.guidelines.additionalNotes}
        @input=${(e: Event) => updateGuidelines({ additionalNotes: (e.target as HTMLTextAreaElement).value }, setState)}
        style="min-height: 120px;"
      ></textarea>
    </div>
  `;
}

// ── Preview Tab ──────────────────────────────────────────────

function renderPreviewTab(brand: BrandProfile, businessName: string): TemplateResult {
  const designerContext = generateDesignerContext(brand, businessName);

  return html`
    <h3 class="panel-title">👁️ Brand Preview</h3>
    <p class="panel-subtitle">See how your brand looks and the context sent to Canvas (designer agent).</p>
    
    <div class="preview-section">
      <div class="preview-card">
        <div class="preview-card-title">Color Palette</div>
        <div class="color-palette-preview">
          ${brand.colors.map(c => html`
            <div class="palette-swatch" style="background: ${c.hex};" title="${c.name}: ${c.hex}"></div>
          `)}
        </div>
      </div>

      <div class="preview-card">
        <div class="preview-card-title">Typography Preview</div>
        ${brand.typography.map(t => html`
          <div style="margin-bottom: 12px;">
            <div style="font-size: 0.7rem; color: #666; margin-bottom: 4px;">${t.category.toUpperCase()}</div>
            <div style="font-family: ${t.fontFamily}, ${t.fallback}; font-weight: ${t.weight}; font-size: ${t.category === 'heading' ? '1.5rem' : t.category === 'body' ? '1rem' : '0.9rem'};">
              ${t.category === 'heading' ? brand.tagline || 'Your Brand Tagline' :
                t.category === 'body' ? 'This is how your body text will appear. Clear, readable, and consistent.' :
                'const brand = { tone: "professional" };'}
            </div>
          </div>
        `)}
      </div>

      <div class="preview-card">
        <div class="preview-card-title">Designer Agent Context (Canvas)</div>
        <div class="designer-context-preview">${designerContext}</div>
      </div>
    </div>
  `;
}
