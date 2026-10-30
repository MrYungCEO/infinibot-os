/**
 * Room Settings Panel
 * Configure room dimensions, background, grid, and agent assignment
 */

import { html, nothing } from 'lit';
import type { TemplateResult } from 'lit';
import { icons } from '../../icons';
import {
  type RoomConfiguration,
  type RoomSettings,
  type CarpetColor,
  type RoomBackgroundType,
} from '../../types/room-elements';
import {
  type RoomCustomizerState,
  updateRoomSettings,
  toggleSettingsPanel,
  assignRoomToAgent,
  saveCurrentRoom,
  renameRoom,
  exportCurrentRoom,
  importRoom,
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
};

// ════════════════════════════════════════════════════════════════
// STYLES
// ════════════════════════════════════════════════════════════════

export function getSettingsStyles(): string {
  return `
    .settings-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.7);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
      animation: fadeIn 0.2s ease;
    }
    
    @keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    
    .settings-modal {
      background: ${THEME.bg};
      border: 1px solid ${THEME.border};
      border-radius: 12px;
      width: 500px;
      max-width: 90vw;
      max-height: 80vh;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      animation: slideIn 0.2s ease;
    }
    
    @keyframes slideIn {
      from { transform: translateY(-20px); opacity: 0; }
      to { transform: translateY(0); opacity: 1; }
    }
    
    .settings-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 16px 20px;
      border-bottom: 1px solid ${THEME.border};
      background: ${THEME.bgCard};
    }
    
    .settings-title {
      font-size: 16px;
      font-weight: 600;
      color: ${THEME.text};
      display: flex;
      align-items: center;
      gap: 10px;
    }
    
    .settings-title svg {
      width: 20px;
      height: 20px;
      color: ${THEME.gold};
    }
    
    .close-btn {
      background: transparent;
      border: none;
      color: ${THEME.textMuted};
      cursor: pointer;
      padding: 4px;
      display: flex;
      border-radius: 4px;
      transition: all 0.15s;
    }
    
    .close-btn:hover {
      color: ${THEME.text};
      background: ${THEME.bgHover};
    }
    
    .close-btn svg {
      width: 20px;
      height: 20px;
    }
    
    .settings-content {
      flex: 1;
      overflow-y: auto;
      padding: 20px;
    }
    
    .settings-content::-webkit-scrollbar {
      width: 6px;
    }
    
    .settings-content::-webkit-scrollbar-thumb {
      background: ${THEME.borderLight};
      border-radius: 3px;
    }
    
    .settings-section {
      margin-bottom: 24px;
    }
    
    .settings-section:last-child {
      margin-bottom: 0;
    }
    
    .section-title {
      font-size: 12px;
      font-weight: 600;
      color: ${THEME.textDim};
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 12px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    
    .settings-row {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 12px;
    }
    
    .settings-label {
      font-size: 13px;
      color: ${THEME.text};
      min-width: 100px;
    }
    
    .settings-input {
      flex: 1;
      padding: 8px 12px;
      background: ${THEME.bgInput};
      border: 1px solid ${THEME.borderLight};
      border-radius: 6px;
      color: ${THEME.text};
      font-size: 13px;
      outline: none;
      transition: border-color 0.15s;
    }
    
    .settings-input:focus {
      border-color: ${THEME.goldBorder};
    }
    
    .settings-input[type="number"] {
      width: 80px;
      text-align: center;
    }
    
    .settings-input[type="color"] {
      width: 48px;
      height: 36px;
      padding: 4px;
      cursor: pointer;
    }
    
    .settings-select {
      flex: 1;
      padding: 8px 12px;
      background: ${THEME.bgInput};
      border: 1px solid ${THEME.borderLight};
      border-radius: 6px;
      color: ${THEME.text};
      font-size: 13px;
      outline: none;
      cursor: pointer;
    }
    
    .settings-select:focus {
      border-color: ${THEME.goldBorder};
    }
    
    .color-swatches {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    
    .color-swatch {
      width: 32px;
      height: 32px;
      border-radius: 6px;
      cursor: pointer;
      border: 2px solid transparent;
      transition: all 0.15s;
    }
    
    .color-swatch:hover {
      transform: scale(1.1);
    }
    
    .color-swatch.active {
      border-color: ${THEME.gold};
      box-shadow: 0 0 8px ${THEME.goldBorder};
    }
    
    .settings-slider {
      flex: 1;
      height: 4px;
      -webkit-appearance: none;
      background: ${THEME.borderLight};
      border-radius: 2px;
      outline: none;
    }
    
    .settings-slider::-webkit-slider-thumb {
      -webkit-appearance: none;
      width: 16px;
      height: 16px;
      background: ${THEME.gold};
      border-radius: 50%;
      cursor: pointer;
    }
    
    .settings-checkbox {
      display: flex;
      align-items: center;
      gap: 8px;
      cursor: pointer;
    }
    
    .settings-checkbox input {
      width: 16px;
      height: 16px;
      accent-color: ${THEME.gold};
    }
    
    .settings-footer {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 8px;
      padding: 16px 20px;
      border-top: 1px solid ${THEME.border};
      background: ${THEME.bgCard};
    }
    
    .settings-btn {
      padding: 8px 16px;
      background: ${THEME.bgHover};
      border: 1px solid ${THEME.borderLight};
      border-radius: 6px;
      color: ${THEME.text};
      font-size: 13px;
      cursor: pointer;
      transition: all 0.15s;
    }
    
    .settings-btn:hover {
      background: #222;
      border-color: ${THEME.gold};
    }
    
    .settings-btn.primary {
      background: ${THEME.gold};
      border-color: ${THEME.gold};
      color: #000;
      font-weight: 500;
    }
    
    .settings-btn.primary:hover {
      background: ${THEME.goldDim};
    }
    
    .import-export-row {
      display: flex;
      gap: 8px;
    }
    
    .import-export-row button {
      flex: 1;
    }
  `;
}

// ════════════════════════════════════════════════════════════════
// RENDER
// ════════════════════════════════════════════════════════════════

const CARPET_COLORS: { id: CarpetColor; name: string; color: string }[] = [
  { id: 'default', name: 'Natural', color: '#d4a574' },
  { id: 'blue', name: 'Blue', color: '#3b82f6' },
  { id: 'green', name: 'Green', color: '#22c55e' },
  { id: 'red', name: 'Red', color: '#ef4444' },
  { id: 'purple', name: 'Purple', color: '#9333ea' },
  { id: 'yellow', name: 'Yellow', color: '#eab308' },
  { id: 'white', name: 'White', color: '#f3f4f6' },
  { id: 'none', name: 'None', color: 'transparent' },
];

const BACKGROUND_TYPES: { id: RoomBackgroundType; name: string }[] = [
  { id: 'room1', name: 'Cozy Room 1' },
  { id: 'room2', name: 'Cozy Room 2' },
  { id: 'none', name: 'Solid Color' },
  { id: 'custom', name: 'Custom Image' },
];

function renderDimensionsSection(
  settings: RoomSettings,
  requestUpdate: () => void
): TemplateResult {
  return html`
    <div class="settings-section">
      <div class="section-title">📐 Dimensions</div>
      <div class="settings-row">
        <span class="settings-label">Width</span>
        <input 
          type="number"
          class="settings-input"
          min="200"
          max="1200"
          step="50"
          .value=${String(settings.width)}
          @change=${(e: Event) => {
            const val = parseInt((e.target as HTMLInputElement).value) || 400;
            updateRoomSettings({ width: Math.max(200, Math.min(1200, val)) });
            requestUpdate();
          }}
        />
        <span class="settings-label" style="min-width: auto">×</span>
        <span class="settings-label">Height</span>
        <input 
          type="number"
          class="settings-input"
          min="200"
          max="800"
          step="50"
          .value=${String(settings.height)}
          @change=${(e: Event) => {
            const val = parseInt((e.target as HTMLInputElement).value) || 300;
            updateRoomSettings({ height: Math.max(200, Math.min(800, val)) });
            requestUpdate();
          }}
        />
      </div>
    </div>
  `;
}

function renderBackgroundSection(
  settings: RoomSettings,
  requestUpdate: () => void
): TemplateResult {
  return html`
    <div class="settings-section">
      <div class="section-title">🎨 Background</div>
      <div class="settings-row">
        <span class="settings-label">Style</span>
        <select 
          class="settings-select"
          .value=${settings.backgroundType}
          @change=${(e: Event) => {
            const val = (e.target as HTMLSelectElement).value as RoomBackgroundType;
            updateRoomSettings({ backgroundType: val });
            requestUpdate();
          }}
        >
          ${BACKGROUND_TYPES.map(bg => html`
            <option value="${bg.id}">${bg.name}</option>
          `)}
        </select>
      </div>
      <div class="settings-row">
        <span class="settings-label">Color</span>
        <input 
          type="color"
          class="settings-input"
          .value=${settings.backgroundColor}
          @change=${(e: Event) => {
            const val = (e.target as HTMLInputElement).value;
            updateRoomSettings({ backgroundColor: val });
            requestUpdate();
          }}
        />
        <input 
          type="text"
          class="settings-input"
          style="flex: 1"
          .value=${settings.backgroundColor}
          @change=${(e: Event) => {
            const val = (e.target as HTMLInputElement).value;
            updateRoomSettings({ backgroundColor: val });
            requestUpdate();
          }}
        />
      </div>
    </div>
  `;
}

function renderCarpetSection(
  settings: RoomSettings,
  requestUpdate: () => void
): TemplateResult {
  return html`
    <div class="settings-section">
      <div class="section-title">🟫 Carpet</div>
      <div class="settings-row">
        <span class="settings-label">Color</span>
        <div class="color-swatches">
          ${CARPET_COLORS.map(carpet => html`
            <div 
              class="color-swatch ${settings.carpetColor === carpet.id ? 'active' : ''}"
              style="background-color: ${carpet.color}; ${carpet.id === 'none' ? 'background: repeating-linear-gradient(45deg, #333, #333 5px, #444 5px, #444 10px)' : ''}"
              title="${carpet.name}"
              @click=${() => {
                updateRoomSettings({ carpetColor: carpet.id });
                requestUpdate();
              }}
            ></div>
          `)}
        </div>
      </div>
      <div class="settings-row">
        <span class="settings-label">Scale</span>
        <input 
          type="range"
          class="settings-slider"
          min="0.5"
          max="2"
          step="0.1"
          .value=${String(settings.carpetScale)}
          @input=${(e: Event) => {
            const val = parseFloat((e.target as HTMLInputElement).value);
            updateRoomSettings({ carpetScale: val });
            requestUpdate();
          }}
        />
        <span style="font-size: 12px; color: ${THEME.textMuted}; width: 40px">
          ${settings.carpetScale.toFixed(1)}×
        </span>
      </div>
    </div>
  `;
}

function renderGridSection(
  settings: RoomSettings,
  requestUpdate: () => void
): TemplateResult {
  return html`
    <div class="settings-section">
      <div class="section-title">📐 Grid & Snap</div>
      <div class="settings-row">
        <label class="settings-checkbox">
          <input 
            type="checkbox"
            ?checked=${settings.gridVisible}
            @change=${(e: Event) => {
              updateRoomSettings({ gridVisible: (e.target as HTMLInputElement).checked });
              requestUpdate();
            }}
          />
          Show Grid
        </label>
        <label class="settings-checkbox">
          <input 
            type="checkbox"
            ?checked=${settings.snapToGrid}
            @change=${(e: Event) => {
              updateRoomSettings({ snapToGrid: (e.target as HTMLInputElement).checked });
              requestUpdate();
            }}
          />
          Snap to Grid
        </label>
      </div>
      <div class="settings-row">
        <span class="settings-label">Grid Size</span>
        <input 
          type="number"
          class="settings-input"
          min="8"
          max="64"
          step="8"
          .value=${String(settings.gridSize)}
          @change=${(e: Event) => {
            const val = parseInt((e.target as HTMLInputElement).value) || 16;
            updateRoomSettings({ gridSize: Math.max(8, Math.min(64, val)) });
            requestUpdate();
          }}
        />
        <span style="font-size: 12px; color: ${THEME.textMuted}">px</span>
      </div>
    </div>
  `;
}

function renderLightingSection(
  settings: RoomSettings,
  requestUpdate: () => void
): TemplateResult {
  return html`
    <div class="settings-section">
      <div class="section-title">💡 Lighting</div>
      <div class="settings-row">
        <span class="settings-label">Ambient</span>
        <input 
          type="range"
          class="settings-slider"
          min="0"
          max="1"
          step="0.05"
          .value=${String(settings.ambientLight)}
          @input=${(e: Event) => {
            const val = parseFloat((e.target as HTMLInputElement).value);
            updateRoomSettings({ ambientLight: val });
            requestUpdate();
          }}
        />
        <span style="font-size: 12px; color: ${THEME.textMuted}; width: 40px">
          ${Math.round(settings.ambientLight * 100)}%
        </span>
      </div>
    </div>
  `;
}

function renderAgentSection(
  state: RoomCustomizerState,
  room: RoomConfiguration,
  requestUpdate: () => void
): TemplateResult {
  return html`
    <div class="settings-section">
      <div class="section-title">🤖 Agent Assignment</div>
      <div class="settings-row">
        <span class="settings-label">Assign to</span>
        <select 
          class="settings-select"
          .value=${room.agentId || ''}
          @change=${(e: Event) => {
            const val = (e.target as HTMLSelectElement).value || undefined;
            assignRoomToAgent(room.id, val);
            requestUpdate();
          }}
        >
          <option value="">— No Agent —</option>
          ${state.agents.map(agent => html`
            <option value="${agent.id}">${agent.name}</option>
          `)}
        </select>
      </div>
    </div>
  `;
}

function renderImportExportSection(
  room: RoomConfiguration,
  requestUpdate: () => void
): TemplateResult {
  const handleExport = () => {
    const json = exportCurrentRoom();
    if (!json) return;
    
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${room.name.replace(/[^a-z0-9]/gi, '_')}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };
  
  const handleImport = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      
      const text = await file.text();
      const imported = importRoom(text);
      if (imported) {
        alert(`Imported room: ${imported.name}`);
      }
      requestUpdate();
    };
    input.click();
  };
  
  return html`
    <div class="settings-section">
      <div class="section-title">📦 Import / Export</div>
      <div class="import-export-row">
        <button class="settings-btn" @click=${handleExport}>
          📤 Export Room
        </button>
        <button class="settings-btn" @click=${handleImport}>
          📥 Import Room
        </button>
      </div>
    </div>
  `;
}

export function renderRoomSettings(
  state: RoomCustomizerState,
  requestUpdate: () => void
): TemplateResult {
  if (!state.settingsPanelOpen || !state.currentRoom) {
    return html``;
  }
  
  const room = state.currentRoom;
  const settings = room.settings;
  
  const handleClose = () => {
    toggleSettingsPanel();
    requestUpdate();
  };
  
  const handleOverlayClick = (e: MouseEvent) => {
    if (e.target === e.currentTarget) {
      handleClose();
    }
  };
  
  return html`
    <div class="settings-overlay" @click=${handleOverlayClick}>
      <div class="settings-modal">
        <div class="settings-header">
          <div class="settings-title">
            ${icons.settings}
            Room Settings
          </div>
          <button class="close-btn" @click=${handleClose}>
            ${icons.x}
          </button>
        </div>
        
        <div class="settings-content">
          <div class="settings-section">
            <div class="section-title">📝 Room Info</div>
            <div class="settings-row">
              <span class="settings-label">Name</span>
              <input 
                type="text"
                class="settings-input"
                .value=${room.name}
                @change=${(e: Event) => {
                  const val = (e.target as HTMLInputElement).value.trim() || 'Untitled';
                  renameRoom(room.id, val);
                  requestUpdate();
                }}
              />
            </div>
          </div>
          
          ${renderDimensionsSection(settings, requestUpdate)}
          ${renderBackgroundSection(settings, requestUpdate)}
          ${renderCarpetSection(settings, requestUpdate)}
          ${renderGridSection(settings, requestUpdate)}
          ${renderLightingSection(settings, requestUpdate)}
          ${renderAgentSection(state, room, requestUpdate)}
          ${renderImportExportSection(room, requestUpdate)}
        </div>
        
        <div class="settings-footer">
          <button class="settings-btn" @click=${handleClose}>
            Close
          </button>
          <button class="settings-btn primary" @click=${() => { saveCurrentRoom(); handleClose(); }}>
            Save & Close
          </button>
        </div>
      </div>
    </div>
  `;
}
