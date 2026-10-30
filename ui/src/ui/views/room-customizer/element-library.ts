/**
 * Element Library Panel
 * Browse, search, and drag elements to the room canvas
 */

import { html, nothing } from 'lit';
import type { TemplateResult } from 'lit';
import { icons } from '../../icons';
import {
  type RoomElementDefinition,
  type ElementCategory,
  ALL_CATEGORIES,
  getCategoryIcon,
  getCategoryName,
} from '../../types/room-elements';
import {
  type RoomCustomizerState,
  setLibrarySearch,
  setLibraryCategory,
  toggleLibraryPanel,
  getFilteredElements,
  startDragFromLibrary,
} from '../../controllers/room-customizer';

// ════════════════════════════════════════════════════════════════
// THEME
// ════════════════════════════════════════════════════════════════

const THEME = {
  bg: '#0a0a0a',
  bgCard: '#111111',
  bgHover: '#1a1a1a',
  bgSelected: '#1f1f1f',
  gold: 'var(--g-primary)',
  goldDim: 'var(--g-primary)',
  goldBorder: 'color-mix(in srgb, var(--g-primary) 20%, transparent)',
  text: '#e4e4e7',
  textMuted: '#71717a',
  textDim: '#52525b',
  border: '#1f1f1f',
  borderLight: '#2a2a2a',
  success: '#22c55e',
  mono: "'JetBrains Mono', monospace",
};

// ════════════════════════════════════════════════════════════════
// STYLES
// ════════════════════════════════════════════════════════════════

export function getLibraryStyles(): string {
  return `
    .library-panel {
      width: 280px;
      min-width: 280px;
      background: ${THEME.bg};
      border-right: 1px solid ${THEME.border};
      display: flex;
      flex-direction: column;
      height: 100%;
      overflow: hidden;
      transition: width 0.2s ease, min-width 0.2s ease;
    }
    
    .library-panel.collapsed {
      width: 48px;
      min-width: 48px;
    }
    
    .library-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 16px;
      border-bottom: 1px solid ${THEME.border};
      background: ${THEME.bgCard};
    }
    
    .library-title {
      font-size: 14px;
      font-weight: 600;
      color: ${THEME.text};
      display: flex;
      align-items: center;
      gap: 8px;
    }
    
    .library-title svg {
      width: 18px;
      height: 18px;
      color: ${THEME.gold};
    }
    
    .toggle-btn {
      background: transparent;
      border: none;
      color: ${THEME.textMuted};
      cursor: pointer;
      padding: 4px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 4px;
      transition: all 0.15s ease;
    }
    
    .toggle-btn:hover {
      color: ${THEME.gold};
      background: ${THEME.bgHover};
    }
    
    .toggle-btn svg {
      width: 16px;
      height: 16px;
    }
    
    .library-search {
      padding: 12px;
      border-bottom: 1px solid ${THEME.border};
    }
    
    .search-input {
      width: 100%;
      padding: 8px 12px;
      background: ${THEME.bgCard};
      border: 1px solid ${THEME.borderLight};
      border-radius: 6px;
      color: ${THEME.text};
      font-size: 13px;
      outline: none;
      transition: all 0.15s ease;
    }
    
    .search-input::placeholder {
      color: ${THEME.textDim};
    }
    
    .search-input:focus {
      border-color: ${THEME.goldBorder};
      box-shadow: 0 0 0 2px color-mix(in srgb, var(--g-primary) 10%, transparent);
    }
    
    .library-categories {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      padding: 8px 12px;
      border-bottom: 1px solid ${THEME.border};
    }
    
    .category-btn {
      padding: 4px 8px;
      background: transparent;
      border: 1px solid ${THEME.borderLight};
      border-radius: 4px;
      color: ${THEME.textMuted};
      font-size: 11px;
      cursor: pointer;
      transition: all 0.15s ease;
      display: flex;
      align-items: center;
      gap: 4px;
    }
    
    .category-btn:hover {
      background: ${THEME.bgHover};
      border-color: ${THEME.gold};
      color: ${THEME.gold};
    }
    
    .category-btn.active {
      background: color-mix(in srgb, var(--g-primary) 10%, transparent);
      border-color: ${THEME.gold};
      color: ${THEME.gold};
    }
    
    .category-icon {
      font-size: 12px;
    }
    
    .library-elements {
      flex: 1;
      overflow-y: auto;
      padding: 8px;
    }
    
    .library-elements::-webkit-scrollbar {
      width: 6px;
    }
    
    .library-elements::-webkit-scrollbar-track {
      background: transparent;
    }
    
    .library-elements::-webkit-scrollbar-thumb {
      background: ${THEME.borderLight};
      border-radius: 3px;
    }
    
    .library-elements::-webkit-scrollbar-thumb:hover {
      background: ${THEME.textDim};
    }
    
    .element-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 8px;
    }
    
    .element-card {
      background: ${THEME.bgCard};
      border: 1px solid ${THEME.borderLight};
      border-radius: 8px;
      padding: 8px;
      cursor: grab;
      transition: all 0.15s ease;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 6px;
    }
    
    .element-card:hover {
      border-color: ${THEME.goldBorder};
      background: ${THEME.bgHover};
      transform: translateY(-2px);
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    }
    
    .element-card:active {
      cursor: grabbing;
      transform: scale(0.98);
    }
    
    .element-preview {
      width: 48px;
      height: 48px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: ${THEME.bg};
      border-radius: 6px;
      font-size: 24px;
    }
    
    .element-preview-img {
      max-width: 100%;
      max-height: 100%;
      object-fit: contain;
      image-rendering: pixelated;
    }
    
    .element-name {
      font-size: 11px;
      color: ${THEME.text};
      text-align: center;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 100%;
    }
    
    .element-category-badge {
      font-size: 9px;
      color: ${THEME.textDim};
      background: ${THEME.bg};
      padding: 2px 6px;
      border-radius: 4px;
    }
    
    .library-empty {
      padding: 24px;
      text-align: center;
      color: ${THEME.textDim};
      font-size: 13px;
    }
    
    .library-empty-icon {
      font-size: 32px;
      margin-bottom: 8px;
      opacity: 0.5;
    }
    
    /* Collapsed state */
    .library-panel.collapsed .library-search,
    .library-panel.collapsed .library-categories,
    .library-panel.collapsed .library-elements,
    .library-panel.collapsed .library-title span {
      display: none;
    }
    
    .library-panel.collapsed .library-header {
      justify-content: center;
      padding: 12px 8px;
    }
    
    .library-panel.collapsed .toggle-btn {
      transform: rotate(180deg);
    }
  `;
}

// ════════════════════════════════════════════════════════════════
// RENDER
// ════════════════════════════════════════════════════════════════

function getElementPreview(def: RoomElementDefinition): TemplateResult {
  // For now, use emoji icons based on category
  // In production, could render actual sprite previews
  const previews: Record<string, string> = {
    desk: '🪑',
    chair: '💺',
    sofa: '🛋️',
    littleTable: '🪵',
    bed: '🛏️',
    laptop: '💻',
    television: '📺',
    bookcase: '📚',
    coffee: '☕',
    teddy: '🧸',
    plant: '🌿',
    lamp: '💡',
    window: '🪟',
    drawers: '🗄️',
  };
  
  const emoji = previews[def.id] || getCategoryIcon(def.category);
  
  return html`
    <div class="element-preview">
      ${emoji}
    </div>
  `;
}

function renderElementCard(def: RoomElementDefinition, requestUpdate: () => void): TemplateResult {
  const handleDragStart = (e: DragEvent) => {
    e.dataTransfer?.setData('application/x-room-element', def.id);
    e.dataTransfer!.effectAllowed = 'copy';
    startDragFromLibrary(def);
  };
  
  return html`
    <div 
      class="element-card"
      draggable="true"
      @dragstart=${handleDragStart}
      @click=${() => {
        // Quick-add to center of canvas (for accessibility)
        // This would be handled by the main view
      }}
      title="${def.description || def.name}"
    >
      ${getElementPreview(def)}
      <div class="element-name">${def.name}</div>
    </div>
  `;
}

function renderCategoryFilter(
  state: RoomCustomizerState,
  requestUpdate: () => void
): TemplateResult {
  const categories: (ElementCategory | 'all')[] = ['all', ...ALL_CATEGORIES];
  
  return html`
    <div class="library-categories">
      ${categories.map(cat => html`
        <button
          class="category-btn ${state.libraryCategory === cat ? 'active' : ''}"
          @click=${() => {
            setLibraryCategory(cat);
            requestUpdate();
          }}
        >
          <span class="category-icon">${cat === 'all' ? '✨' : getCategoryIcon(cat)}</span>
          ${cat === 'all' ? 'All' : getCategoryName(cat)}
        </button>
      `)}
    </div>
  `;
}

export function renderElementLibrary(
  state: RoomCustomizerState,
  requestUpdate: () => void
): TemplateResult {
  const elements = getFilteredElements();
  
  return html`
    <div class="library-panel ${state.libraryCollapsed ? 'collapsed' : ''}">
      <div class="library-header">
        <div class="library-title">
          ${icons.puzzle}
          <span>Elements</span>
        </div>
        <button 
          class="toggle-btn"
          @click=${() => {
            toggleLibraryPanel();
            requestUpdate();
          }}
          title="${state.libraryCollapsed ? 'Expand' : 'Collapse'}"
          style="${state.libraryCollapsed ? '' : 'transform: rotate(180deg)'}"
        >
          ${icons.chevronRight}
        </button>
      </div>
      
      ${!state.libraryCollapsed ? html`
        <div class="library-search">
          <input 
            type="text"
            class="search-input"
            placeholder="Search elements..."
            .value=${state.librarySearchQuery}
            @input=${(e: InputEvent) => {
              const target = e.target as HTMLInputElement;
              setLibrarySearch(target.value);
              requestUpdate();
            }}
          />
        </div>
        
        ${renderCategoryFilter(state, requestUpdate)}
        
        <div class="library-elements">
          ${elements.length > 0 ? html`
            <div class="element-grid">
              ${elements.map(def => renderElementCard(def, requestUpdate))}
            </div>
          ` : html`
            <div class="library-empty">
              <div class="library-empty-icon">🔍</div>
              No elements found
            </div>
          `}
        </div>
      ` : nothing}
    </div>
  `;
}
