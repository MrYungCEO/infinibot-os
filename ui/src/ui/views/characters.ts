/**
 * Characters Library View — Global character management panel
 * Revamped with modern layout, popup modal, and file browser
 */

import { html, nothing } from "lit";
import { icons } from "../icons";
import type { AppViewState } from "../app-view-state.js";
import type { GatewayBrowserClient } from "../gateway.js";
import {
  getCharactersState,
  getFilteredCharacters,
  getUniqueTags,
  loadCharacters,
  selectCharacter,
  clearSelection,
  openCreateDialog,
  closeCreateDialog,
  openEditDialog,
  closeEditDialog,
  openImageUploadDialog,
  closeImageUploadDialog,
  openPreviewModal,
  closePreviewModal,
  updateCreateForm,
  updateEditForm,
  updateImageUploadForm,
  createCharacter,
  updateCharacter,
  deleteCharacter,
  addImage,
  deleteImage,
  setPrimaryImage,
  setFilterTag,
  clearError,
  getImageUrl,
  type Character,
  type CharacterSummary,
} from "../controllers/characters.js";

// ═══════════════════════════════════════════════════════════════
// STYLES
// ═══════════════════════════════════════════════════════════════

const characterStyles = `
  /* ─────────────────────────────────────────────────────────────
     PANEL CONTAINER
     ───────────────────────────────────────────────────────────── */
  .char-panel {
    background: linear-gradient(180deg, rgba(15,12,8,0.98) 0%, rgba(10,8,5,0.98) 100%);
    border: 1px solid color-mix(in srgb, var(--g-primary) 25%, transparent);
    border-radius: 16px;
    padding: 16px;
    height: 100%;
    display: flex;
    flex-direction: column;
    gap: 12px;
    overflow: hidden;
  }
  
  /* ─────────────────────────────────────────────────────────────
     HEADER
     ───────────────────────────────────────────────────────────── */
  .char-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding-bottom: 12px;
    border-bottom: 1px solid color-mix(in srgb, var(--g-primary) 15%, transparent);
  }
  
  .char-title {
    font-size: 15px;
    font-weight: 600;
    color: var(--g-primary);
    display: flex;
    align-items: center;
    gap: 8px;
    letter-spacing: 0.5px;
  }
  
  .char-title-icon {
    font-size: 18px;
  }
  
  .char-btn {
    background: linear-gradient(135deg, color-mix(in srgb, var(--g-primary) 15%, transparent) 0%, color-mix(in srgb, var(--g-primary) 8%, transparent) 100%);
    border: 1px solid color-mix(in srgb, var(--g-primary) 40%, transparent);
    color: var(--g-primary);
    padding: 6px 12px;
    border-radius: 8px;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s ease;
    display: flex;
    align-items: center;
    gap: 5px;
  }
  
  .char-btn:hover {
    background: linear-gradient(135deg, color-mix(in srgb, var(--g-primary) 25%, transparent) 0%, color-mix(in srgb, var(--g-primary) 15%, transparent) 100%);
    border-color: var(--g-primary);
    transform: translateY(-1px);
    box-shadow: 0 4px 12px color-mix(in srgb, var(--g-primary) 20%, transparent);
  }
  
  .char-btn-sm {
    padding: 4px 8px;
    font-size: 11px;
  }
  
  .char-btn-icon {
    background: transparent;
    border: none;
    color: #888;
    padding: 6px;
    border-radius: 6px;
    cursor: pointer;
    transition: all 0.2s;
  }
  
  .char-btn-icon:hover {
    background: rgba(255,255,255,0.1);
    color: var(--g-primary);
  }
  
  .char-btn-danger {
    border-color: rgba(220,80,80,0.4);
    color: #dc5050;
  }
  
  .char-btn-danger:hover {
    background: rgba(220,80,80,0.15);
    border-color: #dc5050;
  }
  
  /* ─────────────────────────────────────────────────────────────
     TAG FILTERS
     ───────────────────────────────────────────────────────────── */
  .char-tags-filter {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 4px 0;
  }
  
  .char-tag-btn {
    background: rgba(60,60,60,0.4);
    border: 1px solid rgba(100,100,100,0.3);
    color: #888;
    padding: 4px 10px;
    border-radius: 20px;
    font-size: 11px;
    cursor: pointer;
    transition: all 0.2s;
    text-transform: lowercase;
  }
  
  .char-tag-btn:hover {
    background: color-mix(in srgb, var(--g-primary) 15%, transparent);
    border-color: color-mix(in srgb, var(--g-primary) 40%, transparent);
    color: var(--g-primary);
  }
  
  .char-tag-btn.active {
    background: linear-gradient(135deg, color-mix(in srgb, var(--g-primary) 25%, transparent) 0%, color-mix(in srgb, var(--g-primary) 15%, transparent) 100%);
    border-color: var(--g-primary);
    color: var(--g-primary);
    font-weight: 500;
  }
  
  /* ─────────────────────────────────────────────────────────────
     CHARACTER GRID
     ───────────────────────────────────────────────────────────── */
  .char-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
    gap: 12px;
    flex: 1;
    overflow-y: auto;
    padding: 4px;
    scrollbar-width: thin;
    scrollbar-color: color-mix(in srgb, var(--g-primary) 30%, transparent) transparent;
  }
  
  .char-grid::-webkit-scrollbar {
    width: 6px;
  }
  
  .char-grid::-webkit-scrollbar-track {
    background: transparent;
  }
  
  .char-grid::-webkit-scrollbar-thumb {
    background: color-mix(in srgb, var(--g-primary) 30%, transparent);
    border-radius: 3px;
  }
  
  /* ─────────────────────────────────────────────────────────────
     CHARACTER CARD
     ───────────────────────────────────────────────────────────── */
  .char-card {
    position: relative;
    background: linear-gradient(180deg, rgba(30,28,25,0.9) 0%, rgba(20,18,15,0.9) 100%);
    border: 1px solid rgba(100,100,100,0.25);
    border-radius: 12px;
    overflow: hidden;
    cursor: pointer;
    transition: all 0.25s ease;
  }
  
  .char-card:hover {
    border-color: color-mix(in srgb, var(--g-primary) 50%, transparent);
    transform: translateY(-3px);
    box-shadow: 0 8px 24px rgba(0,0,0,0.4), 0 0 0 1px color-mix(in srgb, var(--g-primary) 20%, transparent);
  }
  
  .char-card.selected {
    border-color: var(--g-primary);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--g-primary) 30%, transparent), 0 8px 24px rgba(0,0,0,0.4);
  }
  
  .char-card-img-wrap {
    position: relative;
    width: 100%;
    aspect-ratio: 1;
    overflow: hidden;
    background: rgba(0,0,0,0.5);
  }
  
  .char-card-img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    transition: transform 0.3s ease;
  }
  
  .char-card:hover .char-card-img {
    transform: scale(1.05);
  }
  
  .char-card-img-placeholder {
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    background: linear-gradient(135deg, rgba(40,35,30,1) 0%, rgba(30,25,20,1) 100%);
    color: #555;
    font-size: 36px;
  }
  
  .char-card-overlay {
    position: absolute;
    inset: 0;
    background: linear-gradient(180deg, transparent 40%, rgba(0,0,0,0.9) 100%);
    opacity: 0;
    transition: opacity 0.25s;
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    padding: 10px;
  }
  
  .char-card:hover .char-card-overlay {
    opacity: 1;
  }
  
  .char-card-actions {
    display: flex;
    gap: 6px;
    justify-content: center;
  }
  
  .char-card-action-btn {
    background: rgba(255,255,255,0.1);
    backdrop-filter: blur(4px);
    border: 1px solid rgba(255,255,255,0.2);
    color: #fff;
    width: 32px;
    height: 32px;
    border-radius: 8px;
    cursor: pointer;
    transition: all 0.2s;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 14px;
  }
  
  .char-card-action-btn:hover {
    background: color-mix(in srgb, var(--g-primary) 30%, transparent);
    border-color: var(--g-primary);
    transform: scale(1.1);
  }
  
  .char-card-info {
    padding: 10px;
    background: linear-gradient(180deg, rgba(25,22,18,0.95) 0%, rgba(20,18,15,0.98) 100%);
  }
  
  .char-card-name {
    font-size: 13px;
    font-weight: 600;
    color: #fff;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    margin-bottom: 2px;
  }
  
  .char-card-meta {
    font-size: 10px;
    color: #666;
    display: flex;
    align-items: center;
    gap: 4px;
  }
  
  .char-card-badge {
    position: absolute;
    top: 8px;
    right: 8px;
    background: color-mix(in srgb, var(--g-primary) 90%, transparent);
    color: #000;
    font-size: 9px;
    font-weight: 700;
    padding: 2px 6px;
    border-radius: 4px;
  }
  
  /* ─────────────────────────────────────────────────────────────
     EMPTY STATE
     ───────────────────────────────────────────────────────────── */
  .char-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 40px 20px;
    color: #555;
    text-align: center;
  }
  
  .char-empty-icon {
    font-size: 48px;
    margin-bottom: 12px;
    opacity: 0.5;
  }
  
  .char-empty-text {
    font-size: 14px;
    color: #666;
    margin-bottom: 4px;
  }
  
  .char-empty-hint {
    font-size: 12px;
    color: #555;
  }
  
  /* ─────────────────────────────────────────────────────────────
     ERROR DISPLAY
     ───────────────────────────────────────────────────────────── */
  .char-error {
    background: rgba(220,80,80,0.15);
    border: 1px solid rgba(220,80,80,0.3);
    border-radius: 8px;
    padding: 10px 14px;
    color: #dc5050;
    font-size: 12px;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  
  /* ─────────────────────────────────────────────────────────────
     MODAL OVERLAY
     ───────────────────────────────────────────────────────────── */
  .char-modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.85);
    backdrop-filter: blur(8px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 9999;
    animation: charModalFadeIn 0.2s ease;
  }
  
  @keyframes charModalFadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }
  
  .char-modal {
    background: linear-gradient(180deg, rgba(25,22,18,0.98) 0%, rgba(15,12,8,0.98) 100%);
    border: 1px solid color-mix(in srgb, var(--g-primary) 30%, transparent);
    border-radius: 16px;
    width: 90%;
    max-width: 600px;
    max-height: 85vh;
    overflow: hidden;
    box-shadow: 0 24px 80px rgba(0,0,0,0.6), 0 0 0 1px color-mix(in srgb, var(--g-primary) 10%, transparent);
    animation: charModalSlideIn 0.25s ease;
  }
  
  @keyframes charModalSlideIn {
    from { opacity: 0; transform: translateY(20px) scale(0.98); }
    to { opacity: 1; transform: translateY(0) scale(1); }
  }
  
  .char-modal-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 16px 20px;
    border-bottom: 1px solid color-mix(in srgb, var(--g-primary) 15%, transparent);
    background: rgba(0,0,0,0.3);
  }
  
  .char-modal-title {
    font-size: 18px;
    font-weight: 600;
    color: var(--g-primary);
    display: flex;
    align-items: center;
    gap: 10px;
  }
  
  .char-modal-close {
    background: transparent;
    border: none;
    color: #888;
    font-size: 20px;
    cursor: pointer;
    padding: 4px 8px;
    border-radius: 6px;
    transition: all 0.2s;
  }
  
  .char-modal-close:hover {
    background: rgba(255,255,255,0.1);
    color: #fff;
  }
  
  .char-modal-body {
    padding: 20px;
    overflow-y: auto;
    max-height: calc(85vh - 70px);
  }
  
  /* ─────────────────────────────────────────────────────────────
     CHARACTER DETAIL MODAL
     ───────────────────────────────────────────────────────────── */
  .char-detail-hero {
    display: flex;
    gap: 20px;
    margin-bottom: 20px;
  }
  
  .char-detail-img-main {
    width: 180px;
    height: 180px;
    border-radius: 12px;
    object-fit: cover;
    border: 2px solid color-mix(in srgb, var(--g-primary) 30%, transparent);
    flex-shrink: 0;
  }
  
  .char-detail-info {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  
  .char-detail-name {
    font-size: 24px;
    font-weight: 700;
    color: #fff;
    margin: 0;
  }
  
  .char-detail-desc {
    color: #aaa;
    font-size: 13px;
    line-height: 1.5;
    padding: 10px 12px;
    background: rgba(0,0,0,0.3);
    border-radius: 8px;
    border-left: 3px solid var(--g-primary);
  }
  
  .char-detail-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  
  .char-detail-tag {
    background: color-mix(in srgb, var(--g-primary) 15%, transparent);
    color: var(--g-primary);
    padding: 4px 10px;
    border-radius: 12px;
    font-size: 11px;
    font-weight: 500;
  }
  
  .char-detail-actions {
    display: flex;
    gap: 8px;
    margin-top: auto;
    padding-top: 10px;
  }
  
  /* ─────────────────────────────────────────────────────────────
     IMAGE GALLERY
     ───────────────────────────────────────────────────────────── */
  .char-gallery {
    margin-top: 16px;
  }
  
  .char-gallery-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 12px;
  }
  
  .char-gallery-title {
    font-size: 14px;
    font-weight: 600;
    color: #888;
  }
  
  .char-gallery-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(100px, 1fr));
    gap: 10px;
  }
  
  .char-gallery-item {
    position: relative;
    aspect-ratio: 1;
    border-radius: 10px;
    overflow: hidden;
    border: 2px solid transparent;
    cursor: pointer;
    transition: all 0.2s;
  }
  
  .char-gallery-item:hover {
    border-color: color-mix(in srgb, var(--g-primary) 50%, transparent);
    transform: scale(1.02);
  }
  
  .char-gallery-item.primary {
    border-color: var(--g-primary);
  }
  
  .char-gallery-item img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  
  .char-gallery-item-overlay {
    position: absolute;
    inset: 0;
    background: rgba(0,0,0,0.7);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    opacity: 0;
    transition: opacity 0.2s;
  }
  
  .char-gallery-item:hover .char-gallery-item-overlay {
    opacity: 1;
  }
  
  .char-gallery-item-actions {
    display: flex;
    gap: 6px;
  }
  
  .char-gallery-btn {
    background: rgba(255,255,255,0.15);
    border: none;
    color: #fff;
    width: 28px;
    height: 28px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 12px;
    transition: all 0.2s;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  
  .char-gallery-btn:hover {
    background: color-mix(in srgb, var(--g-primary) 40%, transparent);
  }
  
  .char-gallery-primary-badge {
    position: absolute;
    top: 6px;
    right: 6px;
    background: var(--g-primary);
    color: #000;
    font-size: 9px;
    font-weight: 700;
    padding: 2px 6px;
    border-radius: 4px;
  }
  
  .char-gallery-label {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    background: linear-gradient(transparent, rgba(0,0,0,0.9));
    color: #aaa;
    font-size: 10px;
    padding: 16px 8px 6px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  
  /* ─────────────────────────────────────────────────────────────
     FORM STYLES
     ───────────────────────────────────────────────────────────── */
  .char-form-group {
    margin-bottom: 16px;
  }
  
  .char-form-label {
    display: block;
    font-size: 12px;
    font-weight: 500;
    color: #888;
    margin-bottom: 6px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  
  .char-form-input {
    width: 100%;
    background: rgba(0,0,0,0.4);
    border: 1px solid rgba(100,100,100,0.3);
    border-radius: 8px;
    padding: 10px 12px;
    color: #fff;
    font-size: 13px;
    transition: all 0.2s;
  }
  
  .char-form-input:focus {
    outline: none;
    border-color: var(--g-primary);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--g-primary) 15%, transparent);
  }
  
  .char-form-input::placeholder {
    color: #555;
  }
  
  .char-form-textarea {
    min-height: 80px;
    resize: vertical;
    font-family: inherit;
  }
  
  .char-form-hint {
    font-size: 11px;
    color: #555;
    margin-top: 4px;
  }
  
  .char-form-actions {
    display: flex;
    gap: 10px;
    justify-content: flex-end;
    margin-top: 20px;
    padding-top: 16px;
    border-top: 1px solid rgba(100,100,100,0.2);
  }
  
  /* ─────────────────────────────────────────────────────────────
     FILE PICKER
     ───────────────────────────────────────────────────────────── */
  .char-file-picker {
    border: 2px dashed color-mix(in srgb, var(--g-primary) 30%, transparent);
    border-radius: 12px;
    padding: 24px;
    text-align: center;
    cursor: pointer;
    transition: all 0.2s;
    background: rgba(0,0,0,0.2);
  }
  
  .char-file-picker:hover {
    border-color: var(--g-primary);
    background: color-mix(in srgb, var(--g-primary) 5%, transparent);
  }
  
  .char-file-picker-icon {
    font-size: 32px;
    color: var(--g-primary);
    margin-bottom: 8px;
  }
  
  .char-file-picker-text {
    font-size: 13px;
    color: #888;
    margin-bottom: 4px;
  }
  
  .char-file-picker-hint {
    font-size: 11px;
    color: #555;
  }
  
  .char-file-input {
    display: none;
  }
  
  .char-file-preview {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px;
    background: rgba(0,0,0,0.3);
    border-radius: 10px;
    margin-top: 12px;
  }
  
  .char-file-preview-img {
    width: 60px;
    height: 60px;
    object-fit: cover;
    border-radius: 8px;
    border: 1px solid color-mix(in srgb, var(--g-primary) 30%, transparent);
  }
  
  .char-file-preview-info {
    flex: 1;
  }
  
  .char-file-preview-name {
    font-size: 13px;
    color: #fff;
    margin-bottom: 2px;
  }
  
  .char-file-preview-size {
    font-size: 11px;
    color: #666;
  }
  
  /* ─────────────────────────────────────────────────────────────
     PREVIEW MODAL
     ───────────────────────────────────────────────────────────── */
  .char-preview-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.95);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 10000;
    cursor: pointer;
  }
  
  .char-preview-container {
    position: relative;
    max-width: 90vw;
    max-height: 90vh;
    display: flex;
    flex-direction: column;
    align-items: center;
  }
  
  .char-preview-close {
    position: absolute;
    top: -50px;
    right: 0;
    width: 40px;
    height: 40px;
    border: none;
    background: rgba(255,255,255,0.1);
    color: white;
    border-radius: 50%;
    font-size: 20px;
    cursor: pointer;
    transition: all 0.2s;
  }
  
  .char-preview-close:hover {
    background: rgba(255,255,255,0.2);
    transform: scale(1.1);
  }
  
  .char-preview-image {
    max-width: 100%;
    max-height: 80vh;
    object-fit: contain;
    border-radius: 12px;
    box-shadow: 0 24px 80px rgba(0,0,0,0.6);
  }
  
  .char-preview-name {
    margin-top: 16px;
    font-size: 18px;
    font-weight: 600;
    color: var(--g-primary);
  }
`;

let stylesInjected = false;

function injectStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  
  const existing = document.getElementById("char-styles");
  if (existing) existing.remove();
  
  const style = document.createElement("style");
  style.id = "char-styles";
  style.textContent = characterStyles;
  document.head.appendChild(style);
}

// ═══════════════════════════════════════════════════════════════
// INITIALIZE
// ═══════════════════════════════════════════════════════════════

export async function initializeCharacters(
  state: AppViewState,
  client: GatewayBrowserClient
): Promise<void> {
  await loadCharacters(state, client);
}

// ═══════════════════════════════════════════════════════════════
// MAIN RENDER
// ═══════════════════════════════════════════════════════════════

export function renderCharactersPanel(
  state: AppViewState,
  client: GatewayBrowserClient
): ReturnType<typeof html> {
  injectStyles();
  
  const cs = getCharactersState(state);
  const characters = getFilteredCharacters(state);
  const tags = getUniqueTags(state);
  
  return html`
    <div class="char-panel">
      <!-- Header -->
      <div class="char-header">
        <div class="char-title">
          <span class="char-title-icon">${icons.theater}</span>
          <span>Characters Library</span>
        </div>
        <button class="char-btn" @click=${() => { openCreateDialog(state); state.requestUpdate?.(); }}>
          <span>${icons.plus}</span> New
        </button>
      </div>
      
      <!-- Error display -->
      ${cs.error ? html`
        <div class="char-error">
          <span>${cs.error}</span>
          <button class="char-btn-icon" @click=${() => { clearError(state); state.requestUpdate?.(); }}>${icons.x}</button>
        </div>
      ` : nothing}
      
      <!-- Tags filter -->
      ${tags.length > 0 ? html`
        <div class="char-tags-filter">
          <button 
            class="char-tag-btn ${!cs.filterTag ? 'active' : ''}"
            @click=${() => { setFilterTag(state, null); state.requestUpdate?.(); }}
          >All</button>
          ${tags.map(tag => html`
            <button 
              class="char-tag-btn ${cs.filterTag === tag ? 'active' : ''}"
              @click=${() => { setFilterTag(state, tag); state.requestUpdate?.(); }}
            >${tag}</button>
          `)}
        </div>
      ` : nothing}
      
      <!-- Characters grid -->
      ${characters.length > 0 ? html`
        <div class="char-grid">
          ${characters.map(char => renderCharacterCard(state, client, char))}
        </div>
      ` : html`
        <div class="char-empty">
          <div class="char-empty-icon">${icons.theater}</div>
          <div class="char-empty-text">No characters yet</div>
          <div class="char-empty-hint">Create your first character reference</div>
        </div>
      `}
      
      <!-- Modals -->
      ${cs.selectedCharacter ? renderDetailModal(state, client, cs.selectedCharacter) : nothing}
      ${cs.showCreateDialog ? renderCreateModal(state, client) : nothing}
      ${cs.showEditDialog && cs.selectedCharacter ? renderEditModal(state, client, cs.selectedCharacter) : nothing}
      ${cs.showImageUploadDialog && cs.selectedCharacter ? renderAddImageModal(state, client, cs.selectedCharacter) : nothing}
      ${cs.showPreviewModal && cs.previewImageUrl ? renderImagePreviewModal(state) : nothing}
    </div>
  `;
}

// ═══════════════════════════════════════════════════════════════
// CHARACTER CARD
// ═══════════════════════════════════════════════════════════════

function renderCharacterCard(
  state: AppViewState,
  client: GatewayBrowserClient,
  char: CharacterSummary
): ReturnType<typeof html> {
  const cs = getCharactersState(state);
  const isSelected = cs.selectedCharacter?.slug === char.slug;
  const imageUrl = char.primaryImage ? getImageUrl(char.primaryImage, char.slug) : null;
  
  return html`
    <div 
      class="char-card ${isSelected ? 'selected' : ''}"
      @click=${() => { selectCharacter(state, client, char.slug); state.requestUpdate?.(); }}
    >
      <div class="char-card-img-wrap">
        ${imageUrl ? html`
          <img class="char-card-img" src="${imageUrl}" alt="${char.name}" />
        ` : html`
          <div class="char-card-img-placeholder">${icons.theater}</div>
        `}
        
        ${char.imageCount > 1 ? html`
          <div class="char-card-badge">${char.imageCount}</div>
        ` : nothing}
        
        <div class="char-card-overlay">
          <div class="char-card-actions">
            <button 
              class="char-card-action-btn" 
              title="View"
              @click=${(e: Event) => { e.stopPropagation(); selectCharacter(state, client, char.slug); state.requestUpdate?.(); }}
            >${icons.eye}</button>
            ${imageUrl ? html`
              <button 
                class="char-card-action-btn" 
                title="Enlarge"
                @click=${(e: Event) => { 
                  e.stopPropagation(); 
                  openPreviewModal(state, imageUrl, char.name); 
                  state.requestUpdate?.();
                }}
              >${icons.search}</button>
            ` : nothing}
          </div>
        </div>
      </div>
      
      <div class="char-card-info">
        <div class="char-card-name">${char.name}</div>
        <div class="char-card-meta">
          <span>${icons.image} ${char.imageCount} image${char.imageCount !== 1 ? 's' : ''}</span>
        </div>
      </div>
    </div>
  `;
}

// ═══════════════════════════════════════════════════════════════
// DETAIL MODAL
// ═══════════════════════════════════════════════════════════════

function renderDetailModal(
  state: AppViewState,
  client: GatewayBrowserClient,
  char: Character
): ReturnType<typeof html> {
  const primaryImage = char.images.find(i => i.isPrimary) || char.images[0];
  const imageUrl = primaryImage ? getImageUrl(primaryImage.path, char.slug) : null;
  
  return html`
    <div class="char-modal-overlay" @click=${(e: Event) => {
      if ((e.target as HTMLElement).classList.contains('char-modal-overlay')) {
        clearSelection(state);
        state.requestUpdate?.();
      }
    }}>
      <div class="char-modal" @click=${(e: Event) => e.stopPropagation()}>
        <div class="char-modal-header">
          <div class="char-modal-title">
            <span>${icons.theater}</span>
            <span>Character Details</span>
          </div>
          <button class="char-modal-close" @click=${() => { clearSelection(state); state.requestUpdate?.(); }}>${icons.x}</button>
        </div>
        
        <div class="char-modal-body">
          <!-- Hero section -->
          <div class="char-detail-hero">
            ${imageUrl ? html`
              <img 
                class="char-detail-img-main" 
                src="${imageUrl}" 
                alt="${char.name}"
                @click=${() => { openPreviewModal(state, imageUrl, char.name); state.requestUpdate?.(); }}
                style="cursor: pointer;"
              />
            ` : html`
              <div class="char-detail-img-main" style="display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,0.4); font-size: 48px;">
                ${icons.theater}
              </div>
            `}
            
            <div class="char-detail-info">
              <h2 class="char-detail-name">${char.name}</h2>
              
              ${char.description ? html`
                <div class="char-detail-desc">${char.description}</div>
              ` : nothing}
              
              ${char.tags.length > 0 ? html`
                <div class="char-detail-tags">
                  ${char.tags.map(tag => html`<span class="char-detail-tag">${tag}</span>`)}
                </div>
              ` : nothing}
              
              <div class="char-detail-actions">
                <button class="char-btn" @click=${() => { openEditDialog(state); state.requestUpdate?.(); }}>
                  ${icons.penLine} Edit
                </button>
                <button class="char-btn" @click=${() => { openImageUploadDialog(state); state.requestUpdate?.(); }}>
                  ${icons.image} Add Image
                </button>
                <button 
                  class="char-btn char-btn-danger" 
                  @click=${async () => { 
                    if (confirm(`Delete "${char.name}"? This removes all reference images.`)) {
                      await deleteCharacter(state, client, char.slug);
                      state.requestUpdate?.();
                    }
                  }}
                >
                  ${icons.trash} Delete
                </button>
              </div>
            </div>
          </div>
          
          <!-- Image gallery -->
          ${char.images.length > 0 ? html`
            <div class="char-gallery">
              <div class="char-gallery-header">
                <span class="char-gallery-title">Reference Images (${char.images.length})</span>
              </div>
              
              <div class="char-gallery-grid">
                ${char.images.map(img => {
                  const imgUrl = getImageUrl(img.path, char.slug);
                  return html`
                    <div class="char-gallery-item ${img.isPrimary ? 'primary' : ''}">
                      <img src="${imgUrl}" alt="${img.label}" />
                      
                      ${img.isPrimary ? html`
                        <span class="char-gallery-primary-badge">${icons.starFilled} PRIMARY</span>
                      ` : nothing}
                      
                      <span class="char-gallery-label">${img.label}</span>
                      
                      <div class="char-gallery-item-overlay">
                        <div class="char-gallery-item-actions">
                          <button 
                            class="char-gallery-btn" 
                            title="View full size"
                            @click=${() => { openPreviewModal(state, imgUrl, char.name); state.requestUpdate?.(); }}
                          >${icons.search}</button>
                          ${!img.isPrimary ? html`
                            <button 
                              class="char-gallery-btn" 
                              title="Set as primary"
                              @click=${async () => { await setPrimaryImage(state, client, img.id); state.requestUpdate?.(); }}
                            >${icons.star}</button>
                          ` : nothing}
                          <button 
                            class="char-gallery-btn" 
                            title="Copy path"
                            @click=${() => navigator.clipboard.writeText(img.path)}
                          >${icons.copy}</button>
                          <button 
                            class="char-gallery-btn" 
                            title="Delete"
                            @click=${async () => { 
                              if (confirm('Delete this image?')) {
                                await deleteImage(state, client, img.id);
                                state.requestUpdate?.();
                              }
                            }}
                          >${icons.trash}</button>
                        </div>
                      </div>
                    </div>
                  `;
                })}
              </div>
            </div>
          ` : nothing}
        </div>
      </div>
    </div>
  `;
}

// ═══════════════════════════════════════════════════════════════
// CREATE MODAL
// ═══════════════════════════════════════════════════════════════

function renderCreateModal(
  state: AppViewState,
  client: GatewayBrowserClient
): ReturnType<typeof html> {
  const cs = getCharactersState(state);
  const hasImage = cs.createForm.imageData || cs.createForm.imagePath;
  
  // Handle file input change - processes the selected file
  const handleCreateFileInputChange = (e: Event) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) {
      console.warn("[characters] No file selected for create");
      return;
    }
    
    console.log("[characters] Create file selected:", file.name, file.type, file.size);
    
    // Validate file type
    if (!file.type.startsWith('image/')) {
      console.error("[characters] Invalid file type:", file.type);
      return;
    }
    
    // Read file as base64
    const reader = new FileReader();
    
    reader.onload = () => {
      const base64 = reader.result as string;
      console.log("[characters] Create file read complete, base64 length:", base64?.length);
      
      if (!base64) {
        console.error("[characters] FileReader returned empty result");
        return;
      }
      
      updateCreateForm(state, { 
        imageData: base64,
        filename: file.name,
        imagePath: file.name
      });
      
      // Force update
      if (state.requestUpdate) {
        state.requestUpdate();
      }
    };
    
    reader.onerror = (err) => {
      console.error("[characters] FileReader error:", err);
    };
    
    reader.readAsDataURL(file);
  };
  
  // Trigger the hidden file input
  const triggerCreateFileInput = () => {
    const input = document.getElementById('char-create-image-input') as HTMLInputElement;
    if (input) {
      input.value = ''; // Reset to allow re-selecting same file
      input.click();
    }
  };
  
  return html`
    <div class="char-modal-overlay" @click=${(e: Event) => {
      if ((e.target as HTMLElement).classList.contains('char-modal-overlay')) {
        closeCreateDialog(state);
        state.requestUpdate?.();
      }
    }}>
      <div class="char-modal" @click=${(e: Event) => e.stopPropagation()}>
        <div class="char-modal-header">
          <div class="char-modal-title">
            <span>${icons.sparkles}</span>
            <span>New Character</span>
          </div>
          <button class="char-modal-close" @click=${() => { closeCreateDialog(state); state.requestUpdate?.(); }}>${icons.x}</button>
        </div>
        
        <div class="char-modal-body">
          <!-- Hidden file input (always present in DOM) -->
          <input 
            type="file"
            id="char-create-image-input"
            accept="image/png,image/jpeg,image/jpg,image/webp,image/gif"
            style="display: none;"
            @change=${handleCreateFileInputChange}
          />
          
          <div class="char-form-group">
            <label class="char-form-label">Name *</label>
            <input 
              class="char-form-input" 
              type="text"
              placeholder="e.g., Survival Bear"
              .value=${cs.createForm.name}
              @input=${(e: Event) => { 
                updateCreateForm(state, { name: (e.target as HTMLInputElement).value });
                state.requestUpdate?.();
              }}
            />
          </div>
          
          <div class="char-form-group">
            <label class="char-form-label">Reference Image *</label>
            
            ${cs.createForm.imageData ? html`
              <div class="char-file-preview">
                <img class="char-file-preview-img" src="${cs.createForm.imageData}" alt="Preview" />
                <div class="char-file-preview-info">
                  <div class="char-file-preview-name">${cs.createForm.filename || 'Selected image'}</div>
                  <div class="char-file-preview-size">Ready to upload</div>
                </div>
                <button 
                  class="char-btn char-btn-sm"
                  @click=${() => {
                    updateCreateForm(state, { imageData: undefined, filename: undefined, imagePath: '' });
                    state.requestUpdate?.();
                  }}
                >${icons.x}</button>
              </div>
              <button class="char-btn" style="margin-top: 10px; width: 100%;" @click=${triggerCreateFileInput}>
                ${icons.folder} Choose Different Image
              </button>
            ` : html`
              <div class="char-file-picker" @click=${triggerCreateFileInput}>
                <div class="char-file-picker-icon">${icons.folder}</div>
                <div class="char-file-picker-text">Click to select image</div>
                <div class="char-file-picker-hint">PNG, JPG, or WebP</div>
              </div>
            `}
            
            <div style="text-align: center; margin: 12px 0; color: #555; font-size: 12px;">— or paste file path —</div>
            
            <input 
              class="char-form-input" 
              type="text"
              placeholder="C:\\path\\to\\image.png"
              .value=${cs.createForm.imageData ? '' : cs.createForm.imagePath}
              ?disabled=${!!cs.createForm.imageData}
              @input=${(e: Event) => { 
                updateCreateForm(state, { 
                  imagePath: (e.target as HTMLInputElement).value,
                  imageData: undefined,
                  filename: undefined
                });
                state.requestUpdate?.();
              }}
            />
          </div>
          
          <div class="char-form-group">
            <label class="char-form-label">Description</label>
            <textarea 
              class="char-form-input char-form-textarea"
              placeholder="Visual description for image generation prompts..."
              .value=${cs.createForm.description}
              @input=${(e: Event) => { 
                updateCreateForm(state, { description: (e.target as HTMLTextAreaElement).value });
                state.requestUpdate?.();
              }}
            ></textarea>
            <div class="char-form-hint">Used in image generation prompts</div>
          </div>
          
          <div class="char-form-group">
            <label class="char-form-label">Tags</label>
            <input 
              class="char-form-input" 
              type="text"
              placeholder="e.g., anime, military, mascot"
              .value=${cs.createForm.tags}
              @input=${(e: Event) => { 
                updateCreateForm(state, { tags: (e.target as HTMLInputElement).value });
                state.requestUpdate?.();
              }}
            />
            <div class="char-form-hint">Comma-separated tags for filtering</div>
          </div>
          
          <div class="char-form-actions">
            <button class="char-btn" @click=${() => { closeCreateDialog(state); state.requestUpdate?.(); }}>
              Cancel
            </button>
            <button 
              class="char-btn" 
              style="background: linear-gradient(135deg, color-mix(in srgb, var(--g-primary) 30%, transparent) 0%, color-mix(in srgb, var(--g-primary) 20%, transparent) 100%); ${!cs.createForm.name || !hasImage ? 'opacity: 0.5; cursor: not-allowed;' : ''}"
              ?disabled=${!cs.createForm.name || !hasImage}
              @click=${async () => {
                console.log("[characters] Create Character clicked, form:", {
                  name: cs.createForm.name,
                  hasImageData: !!cs.createForm.imageData,
                  filename: cs.createForm.filename
                });
                const success = await createCharacter(state, client);
                if (success) state.requestUpdate?.();
              }}
            >
              ${icons.sparkles} Create Character
            </button>
          </div>
        </div>
      </div>
    </div>
  `;
}

// ═══════════════════════════════════════════════════════════════
// EDIT MODAL
// ═══════════════════════════════════════════════════════════════

function renderEditModal(
  state: AppViewState,
  client: GatewayBrowserClient,
  char: Character
): ReturnType<typeof html> {
  const cs = getCharactersState(state);
  
  return html`
    <div class="char-modal-overlay" @click=${(e: Event) => {
      if ((e.target as HTMLElement).classList.contains('char-modal-overlay')) {
        closeEditDialog(state);
        state.requestUpdate?.();
      }
    }}>
      <div class="char-modal" @click=${(e: Event) => e.stopPropagation()}>
        <div class="char-modal-header">
          <div class="char-modal-title">
            <span>${icons.penLine}</span>
            <span>Edit ${char.name}</span>
          </div>
          <button class="char-modal-close" @click=${() => { closeEditDialog(state); state.requestUpdate?.(); }}>${icons.x}</button>
        </div>
        
        <div class="char-modal-body">
          <div class="char-form-group">
            <label class="char-form-label">Name</label>
            <input 
              class="char-form-input" 
              type="text"
              .value=${cs.editForm.name}
              @input=${(e: Event) => { 
                updateEditForm(state, { name: (e.target as HTMLInputElement).value });
                state.requestUpdate?.();
              }}
            />
          </div>
          
          <div class="char-form-group">
            <label class="char-form-label">Description</label>
            <textarea 
              class="char-form-input char-form-textarea"
              .value=${cs.editForm.description}
              @input=${(e: Event) => { 
                updateEditForm(state, { description: (e.target as HTMLTextAreaElement).value });
                state.requestUpdate?.();
              }}
            ></textarea>
          </div>
          
          <div class="char-form-group">
            <label class="char-form-label">Tags</label>
            <input 
              class="char-form-input" 
              type="text"
              .value=${cs.editForm.tags}
              @input=${(e: Event) => { 
                updateEditForm(state, { tags: (e.target as HTMLInputElement).value });
                state.requestUpdate?.();
              }}
            />
          </div>
          
          <div class="char-form-actions">
            <button class="char-btn" @click=${() => { closeEditDialog(state); state.requestUpdate?.(); }}>
              Cancel
            </button>
            <button 
              class="char-btn" 
              style="background: linear-gradient(135deg, color-mix(in srgb, var(--g-primary) 30%, transparent) 0%, color-mix(in srgb, var(--g-primary) 20%, transparent) 100%);"
              @click=${async () => {
                const success = await updateCharacter(state, client);
                if (success) state.requestUpdate?.();
              }}
            >
              ${icons.download} Save Changes
            </button>
          </div>
        </div>
      </div>
    </div>
  `;
}

// ═══════════════════════════════════════════════════════════════
// ADD IMAGE MODAL
// ═══════════════════════════════════════════════════════════════

function renderAddImageModal(
  state: AppViewState,
  client: GatewayBrowserClient,
  char: Character
): ReturnType<typeof html> {
  const cs = getCharactersState(state);
  const hasFile = cs.imageUploadForm.imageData || cs.imageUploadForm.imagePath;
  
  // Handle file input change - processes the selected file
  const handleFileInputChange = (e: Event) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) {
      console.warn("[characters] No file selected");
      return;
    }
    
    console.log("[characters] File selected:", file.name, file.type, file.size);
    
    // Validate file type
    if (!file.type.startsWith('image/')) {
      console.error("[characters] Invalid file type:", file.type);
      return;
    }
    
    // Read file as base64
    const reader = new FileReader();
    
    reader.onload = () => {
      const base64 = reader.result as string;
      console.log("[characters] File read complete, base64 length:", base64?.length);
      
      if (!base64) {
        console.error("[characters] FileReader returned empty result");
        return;
      }
      
      updateImageUploadForm(state, { 
        imageData: base64,
        filename: file.name,
        imagePath: file.name
      });
      
      // Force update
      if (state.requestUpdate) {
        state.requestUpdate();
      }
    };
    
    reader.onerror = (err) => {
      console.error("[characters] FileReader error:", err);
    };
    
    reader.readAsDataURL(file);
  };
  
  // Trigger the hidden file input
  const triggerFileInput = () => {
    const input = document.getElementById('char-image-upload-input') as HTMLInputElement;
    if (input) {
      input.value = ''; // Reset to allow re-selecting same file
      input.click();
    }
  };
  
  return html`
    <div class="char-modal-overlay" @click=${(e: Event) => {
      if ((e.target as HTMLElement).classList.contains('char-modal-overlay')) {
        closeImageUploadDialog(state);
        state.requestUpdate?.();
      }
    }}>
      <div class="char-modal" @click=${(e: Event) => e.stopPropagation()}>
        <div class="char-modal-header">
          <div class="char-modal-title">
            <span>${icons.image}</span>
            <span>Add Image to ${char.name}</span>
          </div>
          <button class="char-modal-close" @click=${() => { closeImageUploadDialog(state); state.requestUpdate?.(); }}>${icons.x}</button>
        </div>
        
        <div class="char-modal-body">
          <!-- Hidden file input (always present in DOM) -->
          <input 
            type="file"
            id="char-image-upload-input"
            accept="image/png,image/jpeg,image/jpg,image/webp,image/gif"
            style="display: none;"
            @change=${handleFileInputChange}
          />
          
          <div class="char-form-group">
            <label class="char-form-label">Image File</label>
            
            ${cs.imageUploadForm.imageData ? html`
              <!-- File preview -->
              <div class="char-file-preview">
                <img class="char-file-preview-img" src="${cs.imageUploadForm.imageData}" alt="Preview" />
                <div class="char-file-preview-info">
                  <div class="char-file-preview-name">${cs.imageUploadForm.filename || 'Selected image'}</div>
                  <div class="char-file-preview-size">Ready to upload</div>
                </div>
                <button 
                  class="char-btn char-btn-sm"
                  @click=${() => {
                    updateImageUploadForm(state, { imageData: undefined, filename: undefined, imagePath: '' });
                    state.requestUpdate?.();
                  }}
                >${icons.x}</button>
              </div>
              <button class="char-btn" style="margin-top: 10px; width: 100%;" @click=${triggerFileInput}>
                ${icons.folder} Choose Different Image
              </button>
            ` : html`
              <div class="char-file-picker" @click=${triggerFileInput}>
                <div class="char-file-picker-icon">${icons.folder}</div>
                <div class="char-file-picker-text">Click to select image</div>
                <div class="char-file-picker-hint">PNG, JPG, or WebP</div>
              </div>
            `}
            
            <div style="text-align: center; margin: 12px 0; color: #555; font-size: 12px;">— or paste file path —</div>
            
            <input 
              class="char-form-input" 
              type="text"
              placeholder="C:\\path\\to\\image.png"
              .value=${cs.imageUploadForm.imageData ? '' : cs.imageUploadForm.imagePath}
              ?disabled=${!!cs.imageUploadForm.imageData}
              @input=${(e: Event) => { 
                updateImageUploadForm(state, { 
                  imagePath: (e.target as HTMLInputElement).value,
                  imageData: undefined,
                  filename: undefined
                });
                state.requestUpdate?.();
              }}
            />
          </div>
          
          <div class="char-form-group">
            <label class="char-form-label">Label</label>
            <input 
              class="char-form-input" 
              type="text"
              placeholder="e.g., front view, action pose"
              .value=${cs.imageUploadForm.label}
              @input=${(e: Event) => { 
                updateImageUploadForm(state, { label: (e.target as HTMLInputElement).value });
                state.requestUpdate?.();
              }}
            />
            <div class="char-form-hint">Description of this reference image</div>
          </div>
          
          <div class="char-form-actions">
            <button class="char-btn" @click=${() => { closeImageUploadDialog(state); state.requestUpdate?.(); }}>
              Cancel
            </button>
            <button 
              class="char-btn" 
              style="background: linear-gradient(135deg, color-mix(in srgb, var(--g-primary) 30%, transparent) 0%, color-mix(in srgb, var(--g-primary) 20%, transparent) 100%); ${!hasFile ? 'opacity: 0.5; cursor: not-allowed;' : ''}"
              ?disabled=${!hasFile}
              @click=${async () => {
                console.log("[characters] Add Image clicked, form:", {
                  hasImageData: !!getCharactersState(state).imageUploadForm.imageData,
                  filename: getCharactersState(state).imageUploadForm.filename,
                  label: getCharactersState(state).imageUploadForm.label
                });
                try {
                  const success = await addImage(state, client);
                  console.log("[characters] Add Image result:", success);
                } catch (e) {
                  console.error("[characters] Add Image error:", e);
                }
                state.requestUpdate?.();
              }}
            >
              ${icons.image} Add Image
            </button>
          </div>
        </div>
      </div>
    </div>
  `;
}

// ═══════════════════════════════════════════════════════════════
// IMAGE PREVIEW MODAL
// ═══════════════════════════════════════════════════════════════

function renderImagePreviewModal(state: AppViewState): ReturnType<typeof html> {
  const cs = getCharactersState(state);
  
  return html`
    <div class="char-preview-overlay" @click=${() => { closePreviewModal(state); state.requestUpdate?.(); }}>
      <div class="char-preview-container" @click=${(e: Event) => e.stopPropagation()}>
        <button class="char-preview-close" @click=${() => { closePreviewModal(state); state.requestUpdate?.(); }}>${icons.x}</button>
        <img 
          class="char-preview-image" 
          src="${cs.previewImageUrl}" 
          alt="${cs.previewCharacterName || 'Character'}"
        />
        ${cs.previewCharacterName ? html`
          <div class="char-preview-name">${cs.previewCharacterName}</div>
        ` : nothing}
      </div>
    </div>
  `;
}
