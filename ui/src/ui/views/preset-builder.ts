/**
 * Preset Builder View — Visual effect preset editor with live preview
 */

import { html, nothing } from "lit";
import type { AppViewState } from "../app-view-state.js";
import type { GatewayBrowserClient } from "../gateway.js";
import { rafLoop, type SchedulerHandle } from "../perf/visibility-scheduler";
import {
  getPresetBuilderState,
  getFilteredPresets,
  selectPreset,
  filterByCategory,
  setSearchQuery,
  startEditing,
  cancelEditing,
  updatePresetField,
  updatePresetParam,
  savePreset,
  confirmDelete,
  cancelDelete,
  deletePreset,
  togglePreview,
  updatePreviewProgress,
  setPreviewImage,
  CATEGORIES,
  EASING_OPTIONS,
  DEFAULT_PARAMS,
  type EffectPreset,
  type EffectParams,
  type EasingType,
} from "../controllers/preset-builder.js";
import { gatewayHttpUrl } from "../gateway-endpoint";

// ═══════════════════════════════════════════════════════════════
// MAIN VIEW
// ═══════════════════════════════════════════════════════════════

export function renderPresetBuilder(
  state: AppViewState,
  client: GatewayBrowserClient
): ReturnType<typeof html> {
  const pb = getPresetBuilderState(state);
  
  return html`
    <div class="preset-builder">
      ${renderHeader(state)}
      
      <div class="pb-content">
        <!-- Left: Preset Library -->
        <div class="pb-library">
          ${renderSearch(state)}
          ${renderCategories(state)}
          ${renderPresetList(state, client)}
        </div>
        
        <!-- Right: Editor / Preview -->
        <div class="pb-editor-panel">
          ${pb.isEditing 
            ? renderEditor(state, client)
            : pb.selectedPresetId 
              ? renderPresetDetails(state, client)
              : renderEmptyState()
          }
        </div>
      </div>
    </div>
    
    <style>
      ${presetBuilderStyles}
    </style>
  `;
}

// ═══════════════════════════════════════════════════════════════
// HEADER
// ═══════════════════════════════════════════════════════════════

function renderHeader(state: AppViewState): ReturnType<typeof html> {
  return html`
    <div class="pb-header">
      <div class="pb-title">
        <span class="pb-icon">🎬</span>
        <h2>Effect Preset Builder</h2>
      </div>
      <div class="pb-actions">
        <button 
          class="pb-btn pb-btn-primary"
          @click=${() => startEditing(state)}
        >
          + New Preset
        </button>
      </div>
    </div>
  `;
}

// ═══════════════════════════════════════════════════════════════
// SEARCH & FILTER
// ═══════════════════════════════════════════════════════════════

function renderSearch(state: AppViewState): ReturnType<typeof html> {
  const pb = getPresetBuilderState(state);
  
  return html`
    <div class="pb-search">
      <input
        type="text"
        placeholder="Search presets..."
        .value=${pb.searchQuery}
        @input=${(e: Event) => setSearchQuery(state, (e.target as HTMLInputElement).value)}
      />
    </div>
  `;
}

function renderCategories(state: AppViewState): ReturnType<typeof html> {
  const pb = getPresetBuilderState(state);
  
  return html`
    <div class="pb-categories">
      <button
        class="pb-cat-btn ${pb.filterCategory === null ? 'active' : ''}"
        @click=${() => filterByCategory(state, null)}
      >
        All
      </button>
      ${CATEGORIES.map(cat => html`
        <button
          class="pb-cat-btn ${pb.filterCategory === cat.id ? 'active' : ''}"
          @click=${() => filterByCategory(state, cat.id)}
          title=${cat.description}
        >
          ${cat.label}
        </button>
      `)}
    </div>
  `;
}

// ═══════════════════════════════════════════════════════════════
// PRESET LIST
// ═══════════════════════════════════════════════════════════════

function renderPresetList(
  state: AppViewState,
  client: GatewayBrowserClient
): ReturnType<typeof html> {
  const pb = getPresetBuilderState(state);
  const presets = getFilteredPresets(state);
  
  if (presets.length === 0) {
    return html`
      <div class="pb-no-presets">
        No presets found
      </div>
    `;
  }
  
  return html`
    <div class="pb-preset-list">
      ${presets.map(preset => html`
        <div 
          class="pb-preset-card ${pb.selectedPresetId === preset.id ? 'selected' : ''}"
          @click=${() => selectPreset(state, preset.id)}
        >
          <div class="pb-preset-preview">
            ${preset.previewUrl 
              ? html`<img src=${preset.previewUrl} alt=${preset.name} />`
              : html`<div class="pb-preset-placeholder">${getCategoryIcon(preset.category)}</div>`
            }
          </div>
          <div class="pb-preset-info">
            <div class="pb-preset-name">
              ${preset.name}
              ${preset.isBuiltIn ? html`<span class="pb-badge">Built-in</span>` : nothing}
            </div>
            <div class="pb-preset-desc">${preset.description}</div>
          </div>
        </div>
      `)}
    </div>
  `;
}

function getCategoryIcon(category: string): string {
  const icons: Record<string, string> = {
    zoom: "🔍",
    pan: "↔️",
    transition: "✨",
    stylized: "🎨",
    custom: "⚙️",
  };
  return icons[category] || "🎬";
}

// ═══════════════════════════════════════════════════════════════
// PRESET DETAILS VIEW
// ═══════════════════════════════════════════════════════════════

function renderPresetDetails(
  state: AppViewState,
  client: GatewayBrowserClient
): ReturnType<typeof html> {
  const pb = getPresetBuilderState(state);
  const preset = pb.presets.find(p => p.id === pb.selectedPresetId);
  
  if (!preset) return nothing;
  
  return html`
    <div class="pb-details">
      <div class="pb-details-header">
        <h3>${preset.name}</h3>
        <div class="pb-details-actions">
          <button 
            class="pb-btn"
            @click=${() => startEditing(state, preset.id)}
          >
            ${preset.isBuiltIn ? "Customize" : "Edit"}
          </button>
          ${!preset.isBuiltIn ? html`
            <button 
              class="pb-btn pb-btn-danger"
              @click=${() => confirmDelete(state)}
            >
              Delete
            </button>
          ` : nothing}
        </div>
      </div>
      
      <div class="pb-details-body">
        <p class="pb-details-desc">${preset.description}</p>
        
        <div class="pb-params-preview">
          <h4>Parameters</h4>
          <div class="pb-params-grid">
            ${renderParamPreview("Zoom", `${preset.params.zoomStart}x → ${preset.params.zoomEnd}x`)}
            ${renderParamPreview("Pan", `X: ${preset.params.panX}%, Y: ${preset.params.panY}%`)}
            ${renderParamPreview("Rotation", `${preset.params.rotationStart}° → ${preset.params.rotationEnd}°`)}
            ${renderParamPreview("Vignette", `${Math.round(preset.params.vignette * 100)}%`)}
            ${preset.params.scanlines ? renderParamPreview("Scanlines", "On") : nothing}
            ${preset.params.rgbSplit > 0 ? renderParamPreview("RGB Split", `${preset.params.rgbSplit}px`) : nothing}
            ${preset.params.flash ? renderParamPreview("Flash", `Frame ${preset.params.flashFrame}`) : nothing}
            ${preset.params.shake > 0 ? renderParamPreview("Shake", `${preset.params.shake}`) : nothing}
          </div>
        </div>
        
        <!-- Preview Player -->
        <div class="pb-preview-section">
          <h4>Preview</h4>
          ${preset.previewUrl ? html`
            <video 
              src=${preset.previewUrl}
              controls
              loop
              class="pb-preview-video"
            ></video>
          ` : html`
            <div class="pb-preview-placeholder">
              <p>No preview available</p>
              <button class="pb-btn" @click=${() => startEditing(state, preset.id)}>
                Generate Preview
              </button>
            </div>
          `}
        </div>
      </div>
    </div>
    
    ${pb.showDeleteConfirm ? renderDeleteConfirm(state, client, preset) : nothing}
  `;
}

function renderParamPreview(label: string, value: string): ReturnType<typeof html> {
  return html`
    <div class="pb-param-item">
      <span class="pb-param-label">${label}</span>
      <span class="pb-param-value">${value}</span>
    </div>
  `;
}

function renderDeleteConfirm(
  state: AppViewState,
  client: GatewayBrowserClient,
  preset: EffectPreset
): ReturnType<typeof html> {
  return html`
    <div class="pb-modal-overlay">
      <div class="pb-modal">
        <h3>Delete Preset?</h3>
        <p>Are you sure you want to delete "${preset.name}"? This cannot be undone.</p>
        <div class="pb-modal-actions">
          <button class="pb-btn" @click=${() => cancelDelete(state)}>Cancel</button>
          <button 
            class="pb-btn pb-btn-danger"
            @click=${() => deletePreset(state, client, preset.id)}
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  `;
}

// ═══════════════════════════════════════════════════════════════
// EDITOR
// ═══════════════════════════════════════════════════════════════

function renderEditor(
  state: AppViewState,
  client: GatewayBrowserClient
): ReturnType<typeof html> {
  const pb = getPresetBuilderState(state);
  const preset = pb.editingPreset;
  
  if (!preset) return nothing;
  
  return html`
    <div class="pb-editor">
      <div class="pb-editor-header">
        <input
          type="text"
          class="pb-name-input"
          placeholder="Preset Name"
          .value=${preset.name}
          @input=${(e: Event) => updatePresetField(state, "name", (e.target as HTMLInputElement).value)}
        />
        <div class="pb-editor-actions">
          <button class="pb-btn" @click=${() => cancelEditing(state)}>Cancel</button>
          <button 
            class="pb-btn pb-btn-primary"
            @click=${() => savePreset(state, client)}
            ?disabled=${pb.saving}
          >
            ${pb.saving ? "Saving..." : "Save Preset"}
          </button>
        </div>
      </div>
      
      <div class="pb-editor-body">
        <!-- Description -->
        <div class="pb-field">
          <label>Description</label>
          <input
            type="text"
            placeholder="Brief description of the effect"
            .value=${preset.description}
            @input=${(e: Event) => updatePresetField(state, "description", (e.target as HTMLInputElement).value)}
          />
        </div>
        
        <!-- Category -->
        <div class="pb-field">
          <label>Category</label>
          <select
            .value=${preset.category}
            @change=${(e: Event) => updatePresetField(state, "category", (e.target as HTMLSelectElement).value as any)}
          >
            ${CATEGORIES.map(cat => html`
              <option value=${cat.id}>${cat.label}</option>
            `)}
          </select>
        </div>
        
        <div class="pb-section-divider">
          <span>Zoom & Scale</span>
        </div>
        
        <!-- Zoom Controls -->
        <div class="pb-field-row">
          <div class="pb-field">
            <label>Zoom Start</label>
            ${renderSlider(state, "zoomStart", preset.params.zoomStart, 0.5, 2, 0.05, "x")}
          </div>
          <div class="pb-field">
            <label>Zoom End</label>
            ${renderSlider(state, "zoomEnd", preset.params.zoomEnd, 0.5, 2, 0.05, "x")}
          </div>
        </div>
        
        <div class="pb-field">
          <label>Zoom Easing</label>
          ${renderEasingSelect(state, "zoomEasing", preset.params.zoomEasing)}
        </div>
        
        <div class="pb-section-divider">
          <span>Pan & Movement</span>
        </div>
        
        <!-- Pan Controls -->
        <div class="pb-field-row">
          <div class="pb-field">
            <label>Pan X</label>
            ${renderSlider(state, "panX", preset.params.panX, -100, 100, 1, "%")}
          </div>
          <div class="pb-field">
            <label>Pan Y</label>
            ${renderSlider(state, "panY", preset.params.panY, -100, 100, 1, "%")}
          </div>
        </div>
        
        <div class="pb-section-divider">
          <span>Rotation</span>
        </div>
        
        <!-- Rotation -->
        <div class="pb-field-row">
          <div class="pb-field">
            <label>Rotation Start</label>
            ${renderSlider(state, "rotationStart", preset.params.rotationStart, -360, 360, 1, "°")}
          </div>
          <div class="pb-field">
            <label>Rotation End</label>
            ${renderSlider(state, "rotationEnd", preset.params.rotationEnd, -360, 360, 1, "°")}
          </div>
        </div>
        
        <div class="pb-section-divider">
          <span>Visual Effects</span>
        </div>
        
        <!-- Visual Effects -->
        <div class="pb-field-row">
          <div class="pb-field">
            <label>Vignette</label>
            ${renderSlider(state, "vignette", preset.params.vignette, 0, 1, 0.05, "")}
          </div>
          <div class="pb-field">
            <label>Blur</label>
            ${renderSlider(state, "blur", preset.params.blur, 0, 20, 1, "px")}
          </div>
        </div>
        
        <div class="pb-field-row">
          <div class="pb-field">
            <label>RGB Split</label>
            ${renderSlider(state, "rgbSplit", preset.params.rgbSplit, 0, 10, 1, "px")}
          </div>
          <div class="pb-field">
            <label>Shake</label>
            ${renderSlider(state, "shake", preset.params.shake, 0, 10, 1, "")}
          </div>
        </div>
        
        <!-- Toggles -->
        <div class="pb-toggles">
          ${renderToggle(state, "scanlines", preset.params.scanlines, "Scanlines")}
          ${renderToggle(state, "flash", preset.params.flash, "Flash Effect")}
          ${renderToggle(state, "speedRamp", preset.params.speedRamp, "Speed Ramp")}
        </div>
        
        ${preset.params.flash ? html`
          <div class="pb-field">
            <label>Flash Frame</label>
            ${renderSlider(state, "flashFrame", preset.params.flashFrame, 0, 30, 1, "")}
          </div>
        ` : nothing}
      </div>
      
      <!-- Live Preview -->
      <div class="pb-live-preview">
        <h4>Live Preview</h4>
        <div class="pb-preview-canvas">
          ${renderLivePreview(state, preset)}
        </div>
        <div class="pb-preview-controls">
          <button 
            class="pb-btn"
            @click=${() => togglePreview(state)}
          >
            ${pb.previewPlaying ? "⏸ Pause" : "▶ Play"}
          </button>
        </div>
      </div>
    </div>
  `;
}

function renderSlider(
  state: AppViewState,
  param: keyof EffectParams,
  value: number,
  min: number,
  max: number,
  step: number,
  unit: string
): ReturnType<typeof html> {
  return html`
    <div class="pb-slider">
      <input
        type="range"
        min=${min}
        max=${max}
        step=${step}
        .value=${String(value)}
        @input=${(e: Event) => updatePresetParam(state, param, parseFloat((e.target as HTMLInputElement).value))}
      />
      <span class="pb-slider-value">${value}${unit}</span>
    </div>
  `;
}

function renderEasingSelect(
  state: AppViewState,
  param: "zoomEasing" | "panEasing" | "rotationEasing",
  value: EasingType
): ReturnType<typeof html> {
  return html`
    <select
      .value=${value}
      @change=${(e: Event) => updatePresetParam(state, param, (e.target as HTMLSelectElement).value as EasingType)}
    >
      ${EASING_OPTIONS.map(opt => html`
        <option value=${opt.value}>${opt.label}</option>
      `)}
    </select>
  `;
}

function renderToggle(
  state: AppViewState,
  param: keyof EffectParams,
  value: boolean,
  label: string
): ReturnType<typeof html> {
  return html`
    <label class="pb-toggle">
      <input
        type="checkbox"
        .checked=${value}
        @change=${(e: Event) => updatePresetParam(state, param, (e.target as HTMLInputElement).checked)}
      />
      <span class="pb-toggle-slider"></span>
      <span class="pb-toggle-label">${label}</span>
    </label>
  `;
}

function renderLivePreview(
  state: AppViewState,
  preset: EffectPreset
): ReturnType<typeof html> {
  const pb = getPresetBuilderState(state);
  const progress = pb.previewProgress;
  
  // Calculate current transform values based on progress
  const zoom = preset.params.zoomStart + (preset.params.zoomEnd - preset.params.zoomStart) * progress;
  const panX = preset.params.panX * progress;
  const panY = preset.params.panY * progress;
  const rotation = preset.params.rotationStart + (preset.params.rotationEnd - preset.params.rotationStart) * progress;
  const blur = preset.params.blur * (1 - progress); // Blur fades out
  
  const transform = `scale(${zoom}) translate(${panX}px, ${panY}px) rotate(${rotation}deg)`;
  const filter = blur > 0 ? `blur(${blur}px)` : "none";
  
  // Use SF Bear as preview image
  const previewImage = pb.previewImageUrl || gatewayHttpUrl("/media/storyboard-images/sf-bear-preview.png");
  
  return html`
    <div class="pb-canvas-wrapper">
      <img
        src=${previewImage}
        class="pb-canvas-image"
        style="transform: ${transform}; filter: ${filter};"
        @error=${(e: Event) => (e.target as HTMLImageElement).src = "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='400' height='225' fill='%23333'><rect width='400' height='225'/><text x='50%' y='50%' fill='%23666' text-anchor='middle'>Preview Image</text></svg>"}
      />
      ${preset.params.vignette > 0 ? html`
        <div 
          class="pb-canvas-vignette"
          style="opacity: ${preset.params.vignette};"
        ></div>
      ` : nothing}
      ${preset.params.scanlines ? html`
        <div class="pb-canvas-scanlines"></div>
      ` : nothing}
    </div>
  `;
}

// ═══════════════════════════════════════════════════════════════
// EMPTY STATE
// ═══════════════════════════════════════════════════════════════

function renderEmptyState(): ReturnType<typeof html> {
  return html`
    <div class="pb-empty">
      <div class="pb-empty-icon">🎬</div>
      <h3>Select a Preset</h3>
      <p>Choose a preset from the library to view details, or create a new one.</p>
    </div>
  `;
}

// ═══════════════════════════════════════════════════════════════
// STYLES
// ═══════════════════════════════════════════════════════════════

const presetBuilderStyles = `
.preset-builder {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: #0f0f0f;
  color: #e5e5e5;
}

.pb-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 24px;
  border-bottom: 1px solid rgba(245, 158, 11, 0.2);
  background: linear-gradient(180deg, rgba(245, 158, 11, 0.05) 0%, transparent 100%);
}

.pb-title {
  display: flex;
  align-items: center;
  gap: 12px;
}

.pb-title h2 {
  margin: 0;
  font-size: 20px;
  font-weight: 700;
  color: #f59e0b;
}

.pb-icon {
  font-size: 28px;
}

.pb-content {
  flex: 1;
  display: flex;
  overflow: hidden;
}

/* Library Panel */
.pb-library {
  width: 320px;
  border-right: 1px solid rgba(255, 255, 255, 0.1);
  display: flex;
  flex-direction: column;
  background: rgba(0, 0, 0, 0.3);
}

.pb-search {
  padding: 12px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
}

.pb-search input {
  width: 100%;
  padding: 10px 14px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  color: #fff;
  font-size: 14px;
}

.pb-search input:focus {
  outline: none;
  border-color: #f59e0b;
}

.pb-categories {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 12px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
}

.pb-cat-btn {
  padding: 6px 12px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid transparent;
  border-radius: 16px;
  color: #9ca3af;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.2s;
}

.pb-cat-btn:hover {
  background: rgba(255, 255, 255, 0.1);
  color: #fff;
}

.pb-cat-btn.active {
  background: rgba(245, 158, 11, 0.2);
  border-color: #f59e0b;
  color: #f59e0b;
}

.pb-preset-list {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.pb-preset-card {
  display: flex;
  gap: 12px;
  padding: 12px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.05);
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.2s;
}

.pb-preset-card:hover {
  background: rgba(255, 255, 255, 0.06);
  border-color: rgba(255, 255, 255, 0.1);
}

.pb-preset-card.selected {
  background: rgba(245, 158, 11, 0.1);
  border-color: rgba(245, 158, 11, 0.3);
}

.pb-preset-preview {
  width: 64px;
  height: 36px;
  border-radius: 4px;
  overflow: hidden;
  background: rgba(0, 0, 0, 0.3);
  display: flex;
  align-items: center;
  justify-content: center;
}

.pb-preset-preview img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.pb-preset-placeholder {
  font-size: 20px;
}

.pb-preset-info {
  flex: 1;
  min-width: 0;
}

.pb-preset-name {
  font-weight: 600;
  font-size: 14px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.pb-badge {
  font-size: 10px;
  padding: 2px 6px;
  background: rgba(107, 114, 128, 0.3);
  border-radius: 4px;
  color: #9ca3af;
}

.pb-preset-desc {
  font-size: 12px;
  color: #6b7280;
  margin-top: 4px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Editor Panel */
.pb-editor-panel {
  flex: 1;
  overflow-y: auto;
  padding: 24px;
}

.pb-empty {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: #6b7280;
}

.pb-empty-icon {
  font-size: 64px;
  margin-bottom: 16px;
  opacity: 0.5;
}

.pb-empty h3 {
  margin: 0 0 8px;
  color: #9ca3af;
}

/* Details View */
.pb-details {
  max-width: 800px;
}

.pb-details-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 24px;
}

.pb-details-header h3 {
  margin: 0;
  font-size: 24px;
  color: #f59e0b;
}

.pb-details-actions {
  display: flex;
  gap: 8px;
}

.pb-params-preview {
  margin-top: 24px;
}

.pb-params-preview h4 {
  margin: 0 0 12px;
  font-size: 14px;
  color: #9ca3af;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.pb-params-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 12px;
}

.pb-param-item {
  padding: 12px;
  background: rgba(255, 255, 255, 0.03);
  border-radius: 8px;
}

.pb-param-label {
  display: block;
  font-size: 11px;
  color: #6b7280;
  margin-bottom: 4px;
}

.pb-param-value {
  font-size: 14px;
  font-weight: 600;
  color: #fff;
}

.pb-preview-section {
  margin-top: 24px;
}

.pb-preview-video {
  width: 100%;
  max-width: 600px;
  border-radius: 8px;
  background: #000;
}

.pb-preview-placeholder {
  padding: 48px;
  background: rgba(255, 255, 255, 0.03);
  border-radius: 8px;
  text-align: center;
  color: #6b7280;
}

/* Editor */
.pb-editor {
  display: grid;
  grid-template-columns: 1fr 350px;
  gap: 24px;
}

.pb-editor-header {
  grid-column: 1 / -1;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
}

.pb-name-input {
  flex: 1;
  padding: 12px 16px;
  font-size: 20px;
  font-weight: 700;
  background: transparent;
  border: none;
  border-bottom: 2px solid rgba(245, 158, 11, 0.3);
  color: #f59e0b;
}

.pb-name-input:focus {
  outline: none;
  border-color: #f59e0b;
}

.pb-editor-actions {
  display: flex;
  gap: 8px;
}

.pb-editor-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.pb-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.pb-field label {
  font-size: 12px;
  color: #9ca3af;
  font-weight: 600;
}

.pb-field input[type="text"],
.pb-field select {
  padding: 10px 12px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  color: #fff;
  font-size: 14px;
}

.pb-field input:focus,
.pb-field select:focus {
  outline: none;
  border-color: #f59e0b;
}

.pb-field-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}

.pb-section-divider {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 8px 0;
}

.pb-section-divider span {
  font-size: 11px;
  color: #f59e0b;
  text-transform: uppercase;
  letter-spacing: 1px;
  white-space: nowrap;
}

.pb-section-divider::before,
.pb-section-divider::after {
  content: "";
  flex: 1;
  height: 1px;
  background: rgba(245, 158, 11, 0.2);
}

.pb-slider {
  display: flex;
  align-items: center;
  gap: 12px;
}

.pb-slider input[type="range"] {
  flex: 1;
  height: 4px;
  background: rgba(255, 255, 255, 0.1);
  border-radius: 2px;
  -webkit-appearance: none;
}

.pb-slider input[type="range"]::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 16px;
  height: 16px;
  background: #f59e0b;
  border-radius: 50%;
  cursor: pointer;
}

.pb-slider-value {
  min-width: 50px;
  font-size: 13px;
  font-family: monospace;
  color: #9ca3af;
}

.pb-toggles {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
}

.pb-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
}

.pb-toggle input {
  display: none;
}

.pb-toggle-slider {
  width: 40px;
  height: 22px;
  background: rgba(255, 255, 255, 0.1);
  border-radius: 11px;
  position: relative;
  transition: background 0.2s;
}

.pb-toggle-slider::before {
  content: "";
  position: absolute;
  top: 3px;
  left: 3px;
  width: 16px;
  height: 16px;
  background: #6b7280;
  border-radius: 50%;
  transition: all 0.2s;
}

.pb-toggle input:checked + .pb-toggle-slider {
  background: rgba(245, 158, 11, 0.3);
}

.pb-toggle input:checked + .pb-toggle-slider::before {
  left: 21px;
  background: #f59e0b;
}

.pb-toggle-label {
  font-size: 13px;
  color: #9ca3af;
}

/* Live Preview */
.pb-live-preview {
  position: sticky;
  top: 0;
}

.pb-live-preview h4 {
  margin: 0 0 12px;
  font-size: 14px;
  color: #9ca3af;
}

.pb-preview-canvas {
  width: 100%;
  aspect-ratio: 16/9;
  background: #000;
  border-radius: 8px;
  overflow: hidden;
  position: relative;
}

.pb-canvas-wrapper {
  width: 100%;
  height: 100%;
  position: relative;
  overflow: hidden;
}

.pb-canvas-image {
  width: 100%;
  height: 100%;
  object-fit: cover;
  transition: transform 0.1s linear;
}

.pb-canvas-vignette {
  position: absolute;
  inset: 0;
  background: radial-gradient(ellipse at center, transparent 40%, rgba(0,0,0,0.8) 100%);
  pointer-events: none;
}

.pb-canvas-scanlines {
  position: absolute;
  inset: 0;
  background: repeating-linear-gradient(
    0deg,
    transparent,
    transparent 2px,
    rgba(0, 0, 0, 0.15) 2px,
    rgba(0, 0, 0, 0.15) 4px
  );
  pointer-events: none;
}

.pb-preview-controls {
  margin-top: 12px;
  display: flex;
  justify-content: center;
}

/* Buttons */
.pb-btn {
  padding: 8px 16px;
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
}

.pb-btn:hover {
  background: rgba(255, 255, 255, 0.15);
}

.pb-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.pb-btn-primary {
  background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);
  border-color: #f59e0b;
  color: #000;
}

.pb-btn-primary:hover {
  background: linear-gradient(135deg, var(--g-primary) 0%, #f59e0b 100%);
}

.pb-btn-danger {
  background: rgba(239, 68, 68, 0.2);
  border-color: rgba(239, 68, 68, 0.3);
  color: #ef4444;
}

.pb-btn-danger:hover {
  background: rgba(239, 68, 68, 0.3);
}

/* Modal */
.pb-modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.8);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.pb-modal {
  background: #1a1a1a;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 12px;
  padding: 24px;
  max-width: 400px;
}

.pb-modal h3 {
  margin: 0 0 12px;
  color: #ef4444;
}

.pb-modal p {
  color: #9ca3af;
  margin: 0 0 20px;
}

.pb-modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.pb-no-presets {
  padding: 24px;
  text-align: center;
  color: #6b7280;
}
`;

// ═══════════════════════════════════════════════════════════════
// ANIMATION LOOP FOR PREVIEW
// ═══════════════════════════════════════════════════════════════

let previewAnimationFrame: SchedulerHandle | null = null;

export function startPreviewAnimation(state: AppViewState): void {
  const pb = getPresetBuilderState(state);
  
  if (previewAnimationFrame) {
    previewAnimationFrame.cancel();
  }
  
  const animate = () => {
    if (!pb.previewPlaying) {
      previewAnimationFrame?.cancel();
      previewAnimationFrame = null;
      return;
    }
    
    // Advance progress (5 second loop)
    const newProgress = (pb.previewProgress + 0.005) % 1;
    updatePreviewProgress(state, newProgress);
  };
  
  previewAnimationFrame = rafLoop(animate);
}

export function stopPreviewAnimation(): void {
  if (previewAnimationFrame) {
    previewAnimationFrame.cancel();
    previewAnimationFrame = null;
  }
}
