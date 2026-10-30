/**
 * Properties Panel
 * Edit selected element properties - position, size, rotation, variants
 */

import { html, nothing } from 'lit';
import type { TemplateResult } from 'lit';
import { icons } from '../../icons';
import {
  type PlacedElement,
  type RoomElementDefinition,
  getElementDefinition,
} from '../../types/room-elements';
import {
  type RoomCustomizerState,
  getSelectedElements,
  updateElement,
  setElementPosition,
  setElementZIndex,
  rotateElement,
  scaleElement,
  setElementVariant,
  toggleElementLock,
  toggleElementVisibility,
  bringToFront,
  sendToBack,
  removeSelectedElements,
  togglePropertiesPanel,
} from '../../controllers/room-customizer';

// ════════════════════════════════════════════════════════════════
// THEME
// ════════════════════════════════════════════════════════════════

const THEME = {
  bg: '#0a0a0a',
  bgCard: '#111111',
  bgHover: '#1a1a1a',
  bgInput: '#0f0f0f',
  gold: 'var(--g-primary)',
  goldDim: 'var(--g-primary)',
  goldBorder: 'color-mix(in srgb, var(--g-primary) 20%, transparent)',
  text: '#e4e4e7',
  textMuted: '#71717a',
  textDim: '#52525b',
  border: '#1f1f1f',
  borderLight: '#2a2a2a',
  error: '#ef4444',
  success: '#22c55e',
};

// ════════════════════════════════════════════════════════════════
// STYLES
// ════════════════════════════════════════════════════════════════

export function getPropertiesStyles(): string {
  return `
    .properties-panel {
      width: 280px;
      min-width: 280px;
      background: ${THEME.bg};
      border-left: 1px solid ${THEME.border};
      display: flex;
      flex-direction: column;
      height: 100%;
      overflow: hidden;
      transition: width 0.2s ease, min-width 0.2s ease;
    }
    
    .properties-panel.collapsed {
      width: 48px;
      min-width: 48px;
    }
    
    .properties-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 16px;
      border-bottom: 1px solid ${THEME.border};
      background: ${THEME.bgCard};
    }
    
    .properties-title {
      font-size: 14px;
      font-weight: 600;
      color: ${THEME.text};
      display: flex;
      align-items: center;
      gap: 8px;
    }
    
    .properties-title svg {
      width: 18px;
      height: 18px;
      color: ${THEME.gold};
    }
    
    .properties-content {
      flex: 1;
      overflow-y: auto;
      padding: 12px;
    }
    
    .properties-content::-webkit-scrollbar {
      width: 6px;
    }
    
    .properties-content::-webkit-scrollbar-thumb {
      background: ${THEME.borderLight};
      border-radius: 3px;
    }
    
    .prop-section {
      margin-bottom: 16px;
    }
    
    .prop-section-title {
      font-size: 11px;
      font-weight: 600;
      color: ${THEME.textDim};
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 8px;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    
    .prop-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 8px;
    }
    
    .prop-label {
      font-size: 12px;
      color: ${THEME.textMuted};
      min-width: 24px;
    }
    
    .prop-input {
      flex: 1;
      padding: 6px 10px;
      background: ${THEME.bgInput};
      border: 1px solid ${THEME.borderLight};
      border-radius: 4px;
      color: ${THEME.text};
      font-size: 12px;
      outline: none;
      transition: border-color 0.15s;
    }
    
    .prop-input:focus {
      border-color: ${THEME.goldBorder};
    }
    
    .prop-input[type="number"] {
      width: 70px;
      text-align: center;
    }
    
    .prop-input-group {
      display: flex;
      gap: 4px;
    }
    
    .prop-select {
      flex: 1;
      padding: 6px 10px;
      background: ${THEME.bgInput};
      border: 1px solid ${THEME.borderLight};
      border-radius: 4px;
      color: ${THEME.text};
      font-size: 12px;
      outline: none;
      cursor: pointer;
    }
    
    .prop-select:focus {
      border-color: ${THEME.goldBorder};
    }
    
    .prop-btn {
      padding: 6px 12px;
      background: ${THEME.bgCard};
      border: 1px solid ${THEME.borderLight};
      border-radius: 4px;
      color: ${THEME.textMuted};
      font-size: 11px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      transition: all 0.15s;
    }
    
    .prop-btn:hover {
      background: ${THEME.bgHover};
      border-color: ${THEME.gold};
      color: ${THEME.gold};
    }
    
    .prop-btn.active {
      background: color-mix(in srgb, var(--g-primary) 10%, transparent);
      border-color: ${THEME.gold};
      color: ${THEME.gold};
    }
    
    .prop-btn.danger:hover {
      border-color: ${THEME.error};
      color: ${THEME.error};
    }
    
    .prop-btn svg {
      width: 14px;
      height: 14px;
    }
    
    .prop-btn-group {
      display: flex;
      gap: 4px;
    }
    
    .variant-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 6px;
    }
    
    .variant-swatch {
      width: 100%;
      aspect-ratio: 1;
      border-radius: 6px;
      cursor: pointer;
      border: 2px solid transparent;
      transition: all 0.15s;
    }
    
    .variant-swatch:hover {
      transform: scale(1.1);
    }
    
    .variant-swatch.active {
      border-color: ${THEME.gold};
      box-shadow: 0 0 8px color-mix(in srgb, var(--g-primary) 30%, transparent);
    }
    
    .prop-slider {
      flex: 1;
      height: 4px;
      -webkit-appearance: none;
      background: ${THEME.borderLight};
      border-radius: 2px;
      outline: none;
    }
    
    .prop-slider::-webkit-slider-thumb {
      -webkit-appearance: none;
      width: 14px;
      height: 14px;
      background: ${THEME.gold};
      border-radius: 50%;
      cursor: pointer;
      transition: transform 0.15s;
    }
    
    .prop-slider::-webkit-slider-thumb:hover {
      transform: scale(1.2);
    }
    
    .no-selection {
      padding: 40px 16px;
      text-align: center;
      color: ${THEME.textDim};
    }
    
    .no-selection-icon {
      font-size: 40px;
      margin-bottom: 12px;
      opacity: 0.5;
    }
    
    .no-selection-text {
      font-size: 13px;
      margin-bottom: 4px;
    }
    
    .no-selection-hint {
      font-size: 11px;
      color: ${THEME.textDim};
    }
    
    .element-info {
      padding: 12px;
      background: ${THEME.bgCard};
      border-radius: 8px;
      margin-bottom: 12px;
    }
    
    .element-info-name {
      font-size: 16px;
      font-weight: 600;
      color: ${THEME.text};
      margin-bottom: 4px;
    }
    
    .element-info-type {
      font-size: 11px;
      color: ${THEME.textDim};
    }
    
    .multi-selection-info {
      padding: 12px;
      background: ${THEME.bgCard};
      border-radius: 8px;
      margin-bottom: 12px;
      text-align: center;
    }
    
    .multi-selection-count {
      font-size: 24px;
      font-weight: 700;
      color: ${THEME.gold};
    }
    
    .multi-selection-label {
      font-size: 12px;
      color: ${THEME.textMuted};
    }
    
    /* Collapsed state */
    .properties-panel.collapsed .properties-content,
    .properties-panel.collapsed .properties-title span {
      display: none;
    }
    
    .properties-panel.collapsed .properties-header {
      justify-content: center;
      padding: 12px 8px;
    }
  `;
}

// ════════════════════════════════════════════════════════════════
// RENDER
// ════════════════════════════════════════════════════════════════

function renderTransformSection(
  element: PlacedElement,
  definition: RoomElementDefinition,
  requestUpdate: () => void
): TemplateResult {
  return html`
    <div class="prop-section">
      <div class="prop-section-title">
        ${icons.move || '📍'} Position
      </div>
      <div class="prop-row">
        <span class="prop-label">X</span>
        <input 
          type="number"
          class="prop-input"
          .value=${String(Math.round(element.transform.position.x))}
          @change=${(e: Event) => {
            const val = parseInt((e.target as HTMLInputElement).value) || 0;
            setElementPosition(element.instanceId, val, element.transform.position.y);
            requestUpdate();
          }}
        />
        <span class="prop-label">Y</span>
        <input 
          type="number"
          class="prop-input"
          .value=${String(Math.round(element.transform.position.y))}
          @change=${(e: Event) => {
            const val = parseInt((e.target as HTMLInputElement).value) || 0;
            setElementPosition(element.instanceId, element.transform.position.x, val);
            requestUpdate();
          }}
        />
      </div>
      <div class="prop-row">
        <span class="prop-label">Z</span>
        <input 
          type="number"
          class="prop-input"
          .value=${String(element.transform.position.z)}
          @change=${(e: Event) => {
            const val = parseInt((e.target as HTMLInputElement).value) || 0;
            setElementZIndex(element.instanceId, val);
            requestUpdate();
          }}
        />
        <div class="prop-btn-group">
          <button class="prop-btn" @click=${() => { bringToFront(element.instanceId); requestUpdate(); }} title="Bring to front">
            ⬆️
          </button>
          <button class="prop-btn" @click=${() => { sendToBack(element.instanceId); requestUpdate(); }} title="Send to back">
            ⬇️
          </button>
        </div>
      </div>
    </div>
    
    ${definition.canRotate || definition.canResize ? html`
      <div class="prop-section">
        <div class="prop-section-title">
          🔄 Transform
        </div>
        ${definition.canRotate ? html`
          <div class="prop-row">
            <span class="prop-label">Rot</span>
            <input 
              type="range"
              class="prop-slider"
              min="0"
              max="360"
              step="15"
              .value=${String(element.transform.rotation)}
              @input=${(e: Event) => {
                const val = parseInt((e.target as HTMLInputElement).value);
                updateElement(element.instanceId, { 
                  transform: { ...element.transform, rotation: val }
                });
                requestUpdate();
              }}
            />
            <input 
              type="number"
              class="prop-input"
              style="width: 50px"
              min="0"
              max="360"
              .value=${String(element.transform.rotation)}
              @change=${(e: Event) => {
                const val = parseInt((e.target as HTMLInputElement).value) % 360;
                updateElement(element.instanceId, { 
                  transform: { ...element.transform, rotation: val }
                });
                requestUpdate();
              }}
            />
          </div>
        ` : nothing}
        ${definition.canResize ? html`
          <div class="prop-row">
            <span class="prop-label">Scale</span>
            <input 
              type="range"
              class="prop-slider"
              min="0.1"
              max="3"
              step="0.1"
              .value=${String(element.transform.scale)}
              @input=${(e: Event) => {
                const val = parseFloat((e.target as HTMLInputElement).value);
                scaleElement(element.instanceId, val);
                requestUpdate();
              }}
            />
            <input 
              type="number"
              class="prop-input"
              style="width: 50px"
              min="0.1"
              max="3"
              step="0.1"
              .value=${String(element.transform.scale.toFixed(1))}
              @change=${(e: Event) => {
                const val = parseFloat((e.target as HTMLInputElement).value) || 1;
                scaleElement(element.instanceId, val);
                requestUpdate();
              }}
            />
          </div>
        ` : nothing}
      </div>
    ` : nothing}
  `;
}

function renderAppearanceSection(
  element: PlacedElement,
  definition: RoomElementDefinition,
  requestUpdate: () => void
): TemplateResult {
  if (!definition.variants?.length && !definition.customProperties?.length) {
    return html``;
  }
  
  return html`
    <div class="prop-section">
      <div class="prop-section-title">
        🎨 Appearance
      </div>
      
      ${definition.canRecolor && definition.variants?.length ? html`
        <div class="variant-grid">
          ${definition.variants.map(variant => html`
            <div 
              class="variant-swatch ${element.variant === variant.id ? 'active' : ''}"
              style="background-color: ${variant.previewColor}"
              title="${variant.name}"
              @click=${() => {
                setElementVariant(element.instanceId, variant.id);
                requestUpdate();
              }}
            ></div>
          `)}
        </div>
      ` : nothing}
      
      <div class="prop-row" style="margin-top: 12px">
        <span class="prop-label">Opacity</span>
        <input 
          type="range"
          class="prop-slider"
          min="0"
          max="1"
          step="0.05"
          .value=${String(element.opacity)}
          @input=${(e: Event) => {
            const val = parseFloat((e.target as HTMLInputElement).value);
            updateElement(element.instanceId, { opacity: val });
            requestUpdate();
          }}
        />
        <span class="prop-label">${Math.round(element.opacity * 100)}%</span>
      </div>
    </div>
  `;
}

function renderActionsSection(
  element: PlacedElement,
  requestUpdate: () => void
): TemplateResult {
  return html`
    <div class="prop-section">
      <div class="prop-section-title">
        ⚡ Actions
      </div>
      <div class="prop-btn-group">
        <button 
          class="prop-btn ${element.locked ? 'active' : ''}"
          @click=${() => { toggleElementLock(element.instanceId); requestUpdate(); }}
          title="${element.locked ? 'Unlock' : 'Lock'}"
        >
          ${element.locked ? '🔒' : '🔓'}
          ${element.locked ? 'Locked' : 'Lock'}
        </button>
        <button 
          class="prop-btn ${!element.visible ? 'active' : ''}"
          @click=${() => { toggleElementVisibility(element.instanceId); requestUpdate(); }}
          title="${element.visible ? 'Hide' : 'Show'}"
        >
          ${element.visible ? '👁️' : '👁️‍🗨️'}
          ${element.visible ? 'Visible' : 'Hidden'}
        </button>
      </div>
      <div class="prop-row" style="margin-top: 8px">
        <button 
          class="prop-btn danger"
          style="flex: 1"
          @click=${() => { removeSelectedElements(); requestUpdate(); }}
        >
          🗑️ Delete Element
        </button>
      </div>
    </div>
  `;
}

function renderSingleElementProperties(
  element: PlacedElement,
  requestUpdate: () => void
): TemplateResult {
  const definition = getElementDefinition(element.definitionId);
  if (!definition) {
    return html`<div class="no-selection">Unknown element type</div>`;
  }
  
  return html`
    <div class="element-info">
      <div class="element-info-name">${element.name || definition.name}</div>
      <div class="element-info-type">${definition.category} • ${definition.id}</div>
    </div>
    
    ${renderTransformSection(element, definition, requestUpdate)}
    ${renderAppearanceSection(element, definition, requestUpdate)}
    ${renderActionsSection(element, requestUpdate)}
  `;
}

function renderMultiSelectionProperties(
  elements: PlacedElement[],
  requestUpdate: () => void
): TemplateResult {
  return html`
    <div class="multi-selection-info">
      <div class="multi-selection-count">${elements.length}</div>
      <div class="multi-selection-label">elements selected</div>
    </div>
    
    <div class="prop-section">
      <div class="prop-section-title">
        ⚡ Bulk Actions
      </div>
      <div class="prop-row">
        <button 
          class="prop-btn"
          style="flex: 1"
          @click=${() => { bringToFront(elements[0].instanceId); requestUpdate(); }}
        >
          ⬆️ Bring All to Front
        </button>
      </div>
      <div class="prop-row">
        <button 
          class="prop-btn"
          style="flex: 1"
          @click=${() => { sendToBack(elements[0].instanceId); requestUpdate(); }}
        >
          ⬇️ Send All to Back
        </button>
      </div>
      <div class="prop-row">
        <button 
          class="prop-btn danger"
          style="flex: 1"
          @click=${() => { removeSelectedElements(); requestUpdate(); }}
        >
          🗑️ Delete ${elements.length} Elements
        </button>
      </div>
    </div>
  `;
}

function renderNoSelection(): TemplateResult {
  return html`
    <div class="no-selection">
      <div class="no-selection-icon">👆</div>
      <div class="no-selection-text">No element selected</div>
      <div class="no-selection-hint">Click an element to edit its properties</div>
    </div>
  `;
}

export function renderPropertiesPanel(
  state: RoomCustomizerState,
  requestUpdate: () => void
): TemplateResult {
  const selectedElements = getSelectedElements();
  
  return html`
    <div class="properties-panel ${state.propertiesPanelCollapsed ? 'collapsed' : ''}">
      <div class="properties-header">
        <div class="properties-title">
          ${icons.settings}
          <span>Properties</span>
        </div>
        <button 
          class="toggle-btn"
          @click=${() => { togglePropertiesPanel(); requestUpdate(); }}
          title="${state.propertiesPanelCollapsed ? 'Expand' : 'Collapse'}"
        >
          ${icons.chevronRight}
        </button>
      </div>
      
      ${!state.propertiesPanelCollapsed ? html`
        <div class="properties-content">
          ${selectedElements.length === 0 
            ? renderNoSelection()
            : selectedElements.length === 1
              ? renderSingleElementProperties(selectedElements[0], requestUpdate)
              : renderMultiSelectionProperties(selectedElements, requestUpdate)
          }
        </div>
      ` : nothing}
    </div>
  `;
}
