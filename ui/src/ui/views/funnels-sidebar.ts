/**
 * Funnel Sidebar Component
 * HUD-styled sidebar with funnel list and stage palette
 */

import { html, nothing, type TemplateResult } from "lit";
import { icons } from "../icons";
import type { FunnelStageType } from "./funnels-canvas";

// ══════════════════════════════════════════════════════════════════════════════
// Types
// ══════════════════════════════════════════════════════════════════════════════

export interface SidebarJourneyItem {
  id: string;
  name: string;
  description?: string;
  category?: string;
  emoji?: string;
  /** True for templates, false for previously-saved journeys. */
  isTemplate: boolean;
  /** True when this is the journey currently rendered on the canvas. */
  selected?: boolean;
}

export interface FunnelSidebarProps {
  funnels: FunnelListItem[];
  selectedFunnelId: string | null;
  loading: boolean;
  searchQuery: string;
  statusFilter: "all" | "active" | "draft" | "paused";
  collapsed: boolean;
  onSelectFunnel: (id: string | null) => void;
  onCreateFunnel: () => void;
  onDeleteFunnel: (id: string) => Promise<void>;
  onDuplicateFunnel: (id: string, newName?: string) => Promise<void>;
  onSearchChange: (query: string) => void;
  onStatusFilterChange: (filter: "all" | "active" | "draft" | "paused") => void;
  onToggleCollapsed: () => void;
  onDragStageStart: (type: FunnelStageType | null) => void;
  requestUpdate: () => void;
  /** Optional customer-journey panel — when omitted, panel is hidden. */
  journeys?: {
    templates: SidebarJourneyItem[];
    saved: SidebarJourneyItem[];
    onPickTemplate: (templateId: string) => void;
    onPickSaved: (journeyId: string) => void;
    onCreateCustom: () => void;
    onDeleteSaved?: (journeyId: string) => void | Promise<void>;
    onClearAllSaved?: () => void | Promise<void>;
  };
}

interface FunnelListItem {
  id: string;
  name: string;
  status: string;
  totalRevenue?: number;
  totalLeads?: number;
  createdAt?: number;
  updatedAt?: number;
}

// ══════════════════════════════════════════════════════════════════════════════
// SVG Icons
// ══════════════════════════════════════════════════════════════════════════════

const sidebarIcons = {
  search: html`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`,
  chevronLeft: html`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>`,
  chevronRight: html`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>`,
  funnel: html`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z"/></svg>`,
  plus: html`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`,
  copy: html`<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`,
  trash: html`<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`,
  users: html`<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
  dollarSign: html`<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>`,
  // Stage type icons
  content: html`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>`,
  engagement: html`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>`,
  capture: html`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>`,
  nurture: html`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`,
  convert: html`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
};

// Stage type configs with helpful descriptions
const STAGE_TYPES: { type: FunnelStageType; label: string; icon: TemplateResult; color: string; tooltip: string }[] = [
  { type: "content", label: "CONTENT", icon: sidebarIcons.content, color: "#00bfff", tooltip: "Where you share valuable content (posts, videos, articles)" },
  { type: "engagement", label: "ENGAGE", icon: sidebarIcons.engagement, color: "#00ffaa", tooltip: "Where people interact with you (comments, DMs, replies)" },
  { type: "capture", label: "CAPTURE", icon: sidebarIcons.capture, color: "#ffaa00", tooltip: "Where you collect contact info (email signups, forms)" },
  { type: "nurture", label: "NURTURE", icon: sidebarIcons.nurture, color: "#ff66cc", tooltip: "Where you build trust over time (emails, sequences)" },
  { type: "convert", label: "CONVERT", icon: sidebarIcons.convert, color: "#00ff88", tooltip: "Where the sale or signup happens" },
];

// ══════════════════════════════════════════════════════════════════════════════
// Render
// ══════════════════════════════════════════════════════════════════════════════

export function renderFunnelSidebar(props: FunnelSidebarProps): TemplateResult {
  const {
    funnels,
    selectedFunnelId,
    loading,
    searchQuery,
    statusFilter,
    collapsed,
    onSelectFunnel,
    onCreateFunnel,
    onDeleteFunnel,
    onDuplicateFunnel,
    onSearchChange,
    onStatusFilterChange,
    onToggleCollapsed,
    onDragStageStart,
    requestUpdate,
  } = props;

  // Filter funnels
  const filteredFunnels = funnels.filter(f => {
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      if (!f.name.toLowerCase().includes(q)) return false;
    }
    if (statusFilter !== "all" && f.status !== statusFilter) return false;
    return true;
  });

  if (collapsed) {
    return html`
      <style>${sidebarStyles}</style>
      <div class="funnel-sidebar funnel-sidebar--collapsed">
        <button class="funnel-sidebar__expand-btn" @click=${onToggleCollapsed} title="Expand Sidebar">
          ${sidebarIcons.chevronRight}
        </button>
        <div class="funnel-sidebar__collapsed-icons">
          ${filteredFunnels.slice(0, 5).map(f => html`
            <button class="funnel-sidebar__collapsed-item ${selectedFunnelId === f.id ? 'selected' : ''}"
              @click=${() => onSelectFunnel(f.id)}
              title="${f.name}">
              ${sidebarIcons.funnel}
            </button>
          `)}
          ${filteredFunnels.length > 5 ? html`
            <div class="funnel-sidebar__collapsed-more">+${filteredFunnels.length - 5}</div>
          ` : nothing}
        </div>
      </div>
    `;
  }

  return html`
    <style>${sidebarStyles}</style>
    <div class="funnel-sidebar">
      <!-- Header -->
      <div class="funnel-sidebar__header">
        <div class="funnel-sidebar__header-title">
          ${sidebarIcons.funnel}
          <span>FUNNELS</span>
          <span class="funnel-sidebar__count">${filteredFunnels.length}</span>
        </div>
        <button class="funnel-sidebar__collapse-btn" @click=${onToggleCollapsed} title="Collapse">
          ${sidebarIcons.chevronLeft}
        </button>
      </div>

      <!-- Search -->
      <div class="funnel-sidebar__search">
        <span class="funnel-sidebar__search-icon">${sidebarIcons.search}</span>
        <input type="text" 
          placeholder="Search funnels..."
          .value=${searchQuery}
          @input=${(e: Event) => onSearchChange((e.target as HTMLInputElement).value)}
        />
      </div>

      <!-- Status Filter -->
      <div class="funnel-sidebar__filters">
        ${["all", "active", "draft", "paused"].map(status => html`
          <button class="funnel-sidebar__filter-btn ${statusFilter === status ? 'active' : ''}"
            @click=${() => onStatusFilterChange(status as any)}>
            ${status.toUpperCase()}
          </button>
        `)}
      </div>

      <!-- Unified scroll region: list + journeys + palette all share one
           overflow-y so any section can grow and the scrollbar lives in
           a single themed channel. The header/search/filters/footer stay
           pinned outside this region. -->
      <div class="funnel-sidebar__scroll">
        <!-- Funnel List -->
        <div class="funnel-sidebar__list">
          ${loading ? html`
            <div class="funnel-sidebar__loading">
              <div class="funnel-sidebar__loading-spinner"></div>
              <span>LOADING...</span>
            </div>
          ` : filteredFunnels.length === 0 ? html`
            <div class="funnel-sidebar__empty">
              <div class="funnel-sidebar__empty-icon">📊</div>
              <span class="funnel-sidebar__empty-title">${searchQuery ? 'No matches found' : 'No funnels yet'}</span>
              <span class="funnel-sidebar__empty-hint">${searchQuery ? 'Try a different search term' : 'Create your first funnel to start tracking your customer journey'}</span>
              ${!searchQuery ? html`
                <button class="funnel-sidebar__empty-btn" @click=${onCreateFunnel}>
                  ${sidebarIcons.plus}
                  <span>Create Your First Funnel</span>
                </button>
              ` : nothing}
            </div>
          ` : filteredFunnels.map(funnel => html`
            <div class="funnel-sidebar__item ${selectedFunnelId === funnel.id ? 'selected' : ''}"
              @click=${() => onSelectFunnel(funnel.id)}>
              <div class="funnel-sidebar__item-main">
                <div class="funnel-sidebar__item-icon">${sidebarIcons.funnel}</div>
                <div class="funnel-sidebar__item-info">
                  <div class="funnel-sidebar__item-name">${funnel.name}</div>
                  <div class="funnel-sidebar__item-meta">
                    <span class="funnel-sidebar__item-status status--${funnel.status}">${funnel.status.toUpperCase()}</span>
                  </div>
                </div>
              </div>
              <div class="funnel-sidebar__item-stats">
                ${funnel.totalLeads !== undefined ? html`
                  <span class="funnel-sidebar__stat" title="Leads">
                    ${sidebarIcons.users}
                    ${funnel.totalLeads}
                  </span>
                ` : nothing}
                ${funnel.totalRevenue !== undefined ? html`
                  <span class="funnel-sidebar__stat" title="Revenue">
                    ${sidebarIcons.dollarSign}
                    ${formatCurrency(funnel.totalRevenue)}
                  </span>
                ` : nothing}
              </div>
              <div class="funnel-sidebar__item-actions">
                <button class="funnel-sidebar__action-btn" title="Duplicate"
                  @click=${(e: Event) => { e.stopPropagation(); onDuplicateFunnel(funnel.id); }}>
                  ${sidebarIcons.copy}
                </button>
                <button class="funnel-sidebar__action-btn action--danger" title="Delete"
                  @click=${(e: Event) => { e.stopPropagation(); onDeleteFunnel(funnel.id); }}>
                  ${sidebarIcons.trash}
                </button>
              </div>
            </div>
          `)}
        </div>

        ${props.journeys ? renderJourneysPanel(props.journeys) : nothing}

        <!-- Stage Palette -->
        <div class="funnel-sidebar__palette">
          <div class="funnel-sidebar__palette-header">
            <span>FUNNEL STEPS</span>
            <span class="funnel-sidebar__palette-help" title="These are the building blocks of your funnel. Drag them onto the canvas to build your customer journey.">?</span>
          </div>
          <div class="funnel-sidebar__palette-grid">
            ${STAGE_TYPES.map(st => html`
              <div class="funnel-sidebar__palette-item"
                style="--stage-color: ${st.color}"
                title="${st.tooltip}"
                draggable="true"
                @dragstart=${() => onDragStageStart(st.type)}
                @dragend=${() => onDragStageStart(null)}>
                <span class="funnel-sidebar__palette-icon">${st.icon}</span>
                <span class="funnel-sidebar__palette-label">${st.label}</span>
              </div>
            `)}
          </div>
          <div class="funnel-sidebar__palette-hint">
            💡 Drag steps to build your funnel
          </div>
        </div>
      </div>

      <!-- Create Button -->
      <div class="funnel-sidebar__footer">
        <button class="funnel-sidebar__create-btn" @click=${onCreateFunnel}>
          ${sidebarIcons.plus}
          <span>NEW FUNNEL</span>
        </button>
      </div>
    </div>
  `;
}

// ══════════════════════════════════════════════════════════════════════════════
// Journeys Panel — saved customer journeys + quick-start templates
// ══════════════════════════════════════════════════════════════════════════════

function renderJourneysPanel(j: NonNullable<FunnelSidebarProps["journeys"]>): TemplateResult {
  return html`
    <div class="funnel-sidebar__journeys glass">
      <div class="funnel-sidebar__journeys-header">
        <span class="hud-title">Customer Journey</span>
      </div>

      <button class="funnel-sidebar__journey-create" @click=${() => j.onCreateCustom()}>
        ${sidebarIcons.plus}
        <span>Create Custom Journey</span>
      </button>

      ${j.saved.length > 0 ? html`
        <div class="funnel-sidebar__journey-section-row">
          <span class="funnel-sidebar__journey-section-label">Saved · ${j.saved.length}</span>
          ${j.onClearAllSaved ? html`
            <button
              class="funnel-sidebar__journey-clear-all"
              title="Delete every saved journey"
              @click=${() => {
                if (window.confirm(`Delete all ${j.saved.length} saved journeys? This can't be undone.`)) {
                  j.onClearAllSaved?.();
                }
              }}>
              Clear all
            </button>
          ` : nothing}
        </div>
        <div class="funnel-sidebar__journey-list">
          ${j.saved.map((s) => html`
            <div class="funnel-sidebar__journey-item ${s.selected ? "selected" : ""}" role="group">
              <button
                class="funnel-sidebar__journey-item-main"
                @click=${() => j.onPickSaved(s.id)}
                title="Load saved journey">
                <span class="funnel-sidebar__journey-emoji">${s.emoji ?? "💼"}</span>
                <span class="funnel-sidebar__journey-info">
                  <span class="funnel-sidebar__journey-name">${s.name}</span>
                  ${s.description ? html`<span class="funnel-sidebar__journey-desc">${s.description}</span>` : nothing}
                </span>
              </button>
              ${j.onDeleteSaved ? html`
                <button
                  class="funnel-sidebar__journey-delete"
                  title="Delete journey"
                  @click=${(e: Event) => {
                    e.stopPropagation();
                    if (window.confirm(`Delete "${s.name}"?`)) j.onDeleteSaved?.(s.id);
                  }}>
                  ${sidebarIcons.trash}
                </button>
              ` : nothing}
            </div>
          `)}
        </div>
      ` : nothing}

      <div class="funnel-sidebar__journey-section-row">
        <span class="funnel-sidebar__journey-section-label">Templates · ${j.templates.length}</span>
      </div>
      <div class="funnel-sidebar__journey-list">
        ${j.templates.map((t) => html`
          <div class="funnel-sidebar__journey-item template" role="group">
            <button
              class="funnel-sidebar__journey-item-main"
              @click=${() => j.onPickTemplate(t.id)}
              title="${t.description ?? ''}">
              <span class="funnel-sidebar__journey-emoji">${t.emoji ?? "✨"}</span>
              <span class="funnel-sidebar__journey-info">
                <span class="funnel-sidebar__journey-name">${t.name}</span>
                ${t.description ? html`<span class="funnel-sidebar__journey-desc">${t.description}</span>` : nothing}
              </span>
            </button>
          </div>
        `)}
      </div>
    </div>
  `;
}

// ══════════════════════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════════════════════

function formatCurrency(value: number): string {
  if (value >= 1000000) return `$${(value / 1000000).toFixed(1)}M`;
  if (value >= 1000) return `$${(value / 1000).toFixed(1)}K`;
  return `$${value}`;
}

// ══════════════════════════════════════════════════════════════════════════════
// Styles - Infinibot Black & Gold Theme
// ══════════════════════════════════════════════════════════════════════════════

const sidebarStyles = `
  .funnel-sidebar {
    width: 280px;
    background: linear-gradient(180deg, color-mix(in srgb, var(--g-primary) 2%, transparent) 0%, color-mix(in srgb, var(--g-bg-deep) 30%, transparent) 100%);
    border-right: 1px solid color-mix(in srgb, var(--g-primary) 8%, transparent);
    display: flex;
    flex-direction: column;
    font-family: var(--g-font-family);
    /* Critical for nested flex scrolling: without min-height: 0 the
       flex child sizes to its content instead of letting overflow-y
       on the scroll region kick in. */
    min-height: 0;
    height: 100%;
  }

  /* Unified scroll region — list + journeys + palette share one
     scrollbar channel. Header/search/filters/footer stay pinned. */
  .funnel-sidebar__scroll {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    overscroll-behavior: contain;
    /* Fade the top + bottom edges so content reads like it's sliding
       under the pinned chrome. */
    mask-image: linear-gradient(
      to bottom,
      transparent 0,
      black 14px,
      black calc(100% - 14px),
      transparent 100%
    );
    -webkit-mask-image: linear-gradient(
      to bottom,
      transparent 0,
      black 14px,
      black calc(100% - 14px),
      transparent 100%
    );
    /* Themed scrollbar (Firefox) — track is invisible, thumb tints
       with the active palette's primary. */
    scrollbar-width: thin;
    scrollbar-color: color-mix(in srgb, var(--g-primary) 32%, transparent) transparent;
    /* Smooth scrolling when jumping to sections programmatically. */
    scroll-behavior: smooth;
  }
  /* Themed scrollbar (WebKit) */
  .funnel-sidebar__scroll::-webkit-scrollbar {
    width: 6px;
  }
  .funnel-sidebar__scroll::-webkit-scrollbar-track {
    background: transparent;
    margin: 6px 0;
  }
  .funnel-sidebar__scroll::-webkit-scrollbar-thumb {
    background: color-mix(in srgb, var(--g-primary) 28%, transparent);
    border-radius: 999px;
    transition: background 0.2s ease;
  }
  .funnel-sidebar__scroll::-webkit-scrollbar-thumb:hover {
    background: color-mix(in srgb, var(--g-primary) 55%, transparent);
  }

  .funnel-sidebar--collapsed {
    width: 50px;
    align-items: center;
    padding: 8px 0;
  }

  .funnel-sidebar__expand-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    background: color-mix(in srgb, var(--g-primary) 4%, transparent);
    border: 1px solid color-mix(in srgb, var(--g-primary) 12%, transparent);
    border-radius: 6px;
    color: color-mix(in srgb, var(--g-primary) 50%, transparent);
    cursor: pointer;
    transition: all 0.15s ease;
    margin-bottom: 12px;
  }

  .funnel-sidebar__expand-btn:hover {
    background: color-mix(in srgb, var(--g-primary) 8%, transparent);
    color: var(--g-primary);
    border-color: color-mix(in srgb, var(--g-primary) 25%, transparent);
  }

  .funnel-sidebar__collapsed-icons {
    display: flex;
    flex-direction: column;
    gap: 4px;
    align-items: center;
  }

  .funnel-sidebar__collapsed-item {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 6px;
    color: color-mix(in srgb, var(--g-primary) 35%, transparent);
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .funnel-sidebar__collapsed-item:hover {
    background: color-mix(in srgb, var(--g-primary) 6%, transparent);
    color: var(--g-primary);
    border-color: color-mix(in srgb, var(--g-primary) 15%, transparent);
  }

  .funnel-sidebar__collapsed-item.selected {
    background: color-mix(in srgb, var(--g-primary) 8%, transparent);
    border-color: color-mix(in srgb, var(--g-primary) 25%, transparent);
    color: var(--g-primary);
  }

  .funnel-sidebar__collapsed-more {
    font-size: 10px;
    color: color-mix(in srgb, var(--g-primary) 35%, transparent);
    margin-top: 4px;
  }

  /* Header */
  .funnel-sidebar__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 16px;
    border-bottom: 1px solid color-mix(in srgb, var(--g-primary) 8%, transparent);
  }

  .funnel-sidebar__header-title {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--g-primary);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 2px;
  }

  .funnel-sidebar__header-title svg {
    width: 14px;
    height: 14px;
    filter: drop-shadow(0 0 3px color-mix(in srgb, var(--g-primary) 40%, transparent));
  }

  .funnel-sidebar__count {
    padding: 2px 6px;
    background: color-mix(in srgb, var(--g-primary) 8%, transparent);
    border-radius: 4px;
    font-size: 10px;
  }

  .funnel-sidebar__collapse-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    background: transparent;
    border: none;
    border-radius: 4px;
    color: color-mix(in srgb, var(--g-primary) 35%, transparent);
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .funnel-sidebar__collapse-btn:hover {
    background: color-mix(in srgb, var(--g-primary) 6%, transparent);
    color: var(--g-primary);
  }

  /* Search */
  .funnel-sidebar__search {
    position: relative;
    padding: 12px 16px;
  }

  .funnel-sidebar__search-icon {
    position: absolute;
    left: 26px;
    top: 50%;
    transform: translateY(-50%);
    color: color-mix(in srgb, var(--g-primary) 25%, transparent);
  }

  .funnel-sidebar__search input {
    width: 100%;
    padding: 8px 12px 8px 32px;
    background: color-mix(in srgb, var(--g-primary) 2%, transparent);
    border: 1px solid color-mix(in srgb, var(--g-primary) 8%, transparent);
    border-radius: 6px;
    color: color-mix(in srgb, var(--g-fg) 90%, transparent);
    font-size: 12px;
    font-family: inherit;
    outline: none;
    transition: all 0.15s ease;
    box-sizing: border-box;
  }

  .funnel-sidebar__search input::placeholder {
    color: color-mix(in srgb, var(--g-fg) 20%, transparent);
  }

  .funnel-sidebar__search input:focus {
    background: color-mix(in srgb, var(--g-primary) 4%, transparent);
    border-color: color-mix(in srgb, var(--g-primary) 25%, transparent);
  }

  /* Filters */
  .funnel-sidebar__filters {
    display: flex;
    gap: 4px;
    padding: 0 16px 12px;
  }

  .funnel-sidebar__filter-btn {
    flex: 1;
    padding: 6px 8px;
    background: transparent;
    border: 1px solid color-mix(in srgb, var(--g-primary) 6%, transparent);
    border-radius: 4px;
    color: color-mix(in srgb, var(--g-fg) 35%, transparent);
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 0.5px;
    cursor: pointer;
    transition: all 0.15s ease;
    font-family: inherit;
  }

  .funnel-sidebar__filter-btn:hover {
    background: color-mix(in srgb, var(--g-primary) 4%, transparent);
    color: color-mix(in srgb, var(--g-fg) 60%, transparent);
    border-color: color-mix(in srgb, var(--g-primary) 12%, transparent);
  }

  .funnel-sidebar__filter-btn.active {
    background: color-mix(in srgb, var(--g-primary) 8%, transparent);
    border-color: color-mix(in srgb, var(--g-primary) 25%, transparent);
    color: var(--g-primary);
  }

  /* List — inner scroll removed; parent .funnel-sidebar__scroll owns it. */
  .funnel-sidebar__list {
    padding: 0 8px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .funnel-sidebar__loading {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    padding: 40px 20px;
    color: color-mix(in srgb, var(--g-primary) 35%, transparent);
    font-size: 10px;
    letter-spacing: 1px;
  }

  .funnel-sidebar__loading-spinner {
    width: 24px;
    height: 24px;
    border: 2px solid color-mix(in srgb, var(--g-primary) 8%, transparent);
    border-top-color: var(--g-primary);
    border-radius: 50%;
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .funnel-sidebar__empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    padding: 40px 20px;
    color: color-mix(in srgb, var(--g-fg) 35%, transparent);
    font-size: 12px;
    text-align: center;
  }

  .funnel-sidebar__empty-icon {
    font-size: 32px;
    margin-bottom: 4px;
  }

  .funnel-sidebar__empty-title {
    font-size: 14px;
    font-weight: 600;
    color: color-mix(in srgb, var(--g-fg) 60%, transparent);
  }

  .funnel-sidebar__empty-hint {
    font-size: 12px;
    color: color-mix(in srgb, var(--g-fg) 35%, transparent);
    max-width: 200px;
    line-height: 1.4;
  }

  .funnel-sidebar__empty-btn {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 14px;
    background: color-mix(in srgb, var(--g-primary) 8%, transparent);
    border: 1px solid color-mix(in srgb, var(--g-primary) 15%, transparent);
    border-radius: 6px;
    color: var(--g-primary);
    font-size: 11px;
    cursor: pointer;
    transition: all 0.15s ease;
    font-family: inherit;
  }

  .funnel-sidebar__empty-btn:hover {
    background: color-mix(in srgb, var(--g-primary) 12%, transparent);
    border-color: color-mix(in srgb, var(--g-primary) 25%, transparent);
  }

  /* Item */
  .funnel-sidebar__item {
    padding: 12px;
    background: color-mix(in srgb, var(--g-primary) 2%, transparent);
    border: 1px solid color-mix(in srgb, var(--g-primary) 4%, transparent);
    border-radius: 8px;
    margin-bottom: 6px;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .funnel-sidebar__item:hover {
    background: color-mix(in srgb, var(--g-primary) 4%, transparent);
    border-color: color-mix(in srgb, var(--g-primary) 10%, transparent);
  }

  .funnel-sidebar__item.selected {
    background: linear-gradient(135deg, color-mix(in srgb, var(--g-primary) 8%, transparent) 0%, color-mix(in srgb, var(--g-primary) 4%, transparent) 100%);
    border-color: color-mix(in srgb, var(--g-primary) 25%, transparent);
    box-shadow: 0 0 15px color-mix(in srgb, var(--g-primary) 8%, transparent), inset 0 0 10px color-mix(in srgb, var(--g-primary) 2%, transparent);
  }

  .funnel-sidebar__item-main {
    display: flex;
    align-items: flex-start;
    gap: 10px;
  }

  .funnel-sidebar__item-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    background: color-mix(in srgb, var(--g-primary) 6%, transparent);
    border-radius: 6px;
    color: color-mix(in srgb, var(--g-primary) 50%, transparent);
    flex-shrink: 0;
  }

  .funnel-sidebar__item.selected .funnel-sidebar__item-icon {
    background: color-mix(in srgb, var(--g-primary) 12%, transparent);
    color: var(--g-primary);
  }

  .funnel-sidebar__item-info {
    flex: 1;
    min-width: 0;
  }

  .funnel-sidebar__item-name {
    font-size: 12px;
    font-weight: 600;
    color: color-mix(in srgb, var(--g-fg) 85%, transparent);
    margin-bottom: 4px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .funnel-sidebar__item.selected .funnel-sidebar__item-name {
    color: var(--g-primary);
    text-shadow: 0 0 8px color-mix(in srgb, var(--g-primary) 25%, transparent);
  }

  .funnel-sidebar__item-meta {
    display: flex;
    gap: 6px;
  }

  .funnel-sidebar__item-status {
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 0.5px;
    padding: 2px 6px;
    border-radius: 3px;
  }

  .funnel-sidebar__item-status.status--active {
    background: rgba(0, 255, 136, 0.12);
    color: #00ff88;
  }

  .funnel-sidebar__item-status.status--draft {
    background: color-mix(in srgb, var(--g-primary) 12%, transparent);
    color: var(--g-primary);
  }

  .funnel-sidebar__item-status.status--paused {
    background: color-mix(in srgb, var(--destructive, #ef4444) 12%, transparent);
    color: var(--destructive, var(--destructive, #ef4444));
  }

  .funnel-sidebar__item-stats {
    display: flex;
    gap: 10px;
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px solid color-mix(in srgb, var(--g-primary) 4%, transparent);
  }

  .funnel-sidebar__stat {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 10px;
    color: color-mix(in srgb, var(--g-fg) 40%, transparent);
  }

  .funnel-sidebar__stat svg {
    opacity: 0.5;
    color: color-mix(in srgb, var(--g-primary) 50%, transparent);
  }

  .funnel-sidebar__item-actions {
    display: none;
    gap: 4px;
    margin-top: 8px;
  }

  .funnel-sidebar__item:hover .funnel-sidebar__item-actions {
    display: flex;
  }

  .funnel-sidebar__action-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    background: color-mix(in srgb, var(--g-primary) 4%, transparent);
    border: 1px solid color-mix(in srgb, var(--g-primary) 8%, transparent);
    border-radius: 4px;
    color: color-mix(in srgb, var(--g-primary) 40%, transparent);
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .funnel-sidebar__action-btn:hover {
    background: color-mix(in srgb, var(--g-primary) 8%, transparent);
    color: var(--g-primary);
    border-color: color-mix(in srgb, var(--g-primary) 15%, transparent);
  }

  .funnel-sidebar__action-btn.action--danger:hover {
    background: color-mix(in srgb, var(--destructive, #ef4444) 8%, transparent);
    border-color: color-mix(in srgb, var(--destructive, #ef4444) 15%, transparent);
    color: var(--destructive, var(--destructive, #ef4444));
  }

  /* Stage Palette */
  .funnel-sidebar__palette {
    margin: 12px 8px 16px;
    padding: 12px;
    border: 1px solid var(--g-border);
    border-radius: var(--g-radius);
    background: color-mix(in srgb, var(--g-bg-deep) 35%, transparent);
    backdrop-filter: var(--g-blur);
    -webkit-backdrop-filter: var(--g-blur);
  }

  .funnel-sidebar__palette-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 10px;
    font-weight: 700;
    color: color-mix(in srgb, var(--g-primary) 40%, transparent);
    letter-spacing: 1.5px;
    margin-bottom: 10px;
  }

  .funnel-sidebar__palette-help {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    background: color-mix(in srgb, var(--g-primary) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--g-primary) 20%, transparent);
    border-radius: 50%;
    font-size: 10px;
    color: color-mix(in srgb, var(--g-primary) 50%, transparent);
    cursor: help;
    transition: all 0.15s ease;
  }

  .funnel-sidebar__palette-help:hover {
    background: color-mix(in srgb, var(--g-primary) 20%, transparent);
    color: var(--g-primary);
  }

  .funnel-sidebar__palette-grid {
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    gap: 6px;
  }

  .funnel-sidebar__palette-item {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: 8px 4px;
    background: color-mix(in srgb, var(--glass-base) 30%, transparent);
    border: 1px solid color-mix(in srgb, var(--g-primary) 6%, transparent);
    border-radius: 6px;
    cursor: grab;
    transition: all 0.15s ease;
  }

  .funnel-sidebar__palette-item:hover {
    background: color-mix(in srgb, var(--stage-color) 10%, transparent);
    border-color: color-mix(in srgb, var(--stage-color) 30%, transparent);
    transform: translateY(-2px);
  }

  .funnel-sidebar__palette-item:active {
    cursor: grabbing;
  }

  .funnel-sidebar__palette-icon {
    color: var(--stage-color);
    opacity: 0.8;
  }

  .funnel-sidebar__palette-icon svg {
    width: 14px;
    height: 14px;
  }

  .funnel-sidebar__palette-label {
    font-size: 8px;
    font-weight: 600;
    color: color-mix(in srgb, var(--g-fg) 45%, transparent);
    letter-spacing: 0.5px;
  }

  .funnel-sidebar__palette-hint {
    font-size: 9px;
    color: color-mix(in srgb, var(--g-primary) 25%, transparent);
    text-align: center;
    margin-top: 8px;
  }

  /* Footer */
  .funnel-sidebar__footer {
    padding: 12px;
    border-top: 1px solid color-mix(in srgb, var(--g-primary) 8%, transparent);
  }

  .funnel-sidebar__create-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    width: 100%;
    padding: 10px 16px;
    background: linear-gradient(135deg, color-mix(in srgb, var(--g-primary) 12%, transparent) 0%, color-mix(in srgb, var(--g-primary) 8%, transparent) 100%);
    border: 1px solid color-mix(in srgb, var(--g-primary) 25%, transparent);
    border-radius: 6px;
    color: var(--g-primary);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 1px;
    cursor: pointer;
    transition: all 0.15s ease;
    font-family: inherit;
  }

  .funnel-sidebar__create-btn:hover {
    background: linear-gradient(135deg, color-mix(in srgb, var(--g-primary) 20%, transparent) 0%, color-mix(in srgb, var(--g-primary) 15%, transparent) 100%);
    box-shadow: 0 0 20px color-mix(in srgb, var(--g-primary) 12%, transparent);
  }

  .funnel-sidebar__create-btn svg {
    filter: drop-shadow(0 0 3px color-mix(in srgb, var(--g-primary) 40%, transparent));
  }

  /* ── Customer Journey panel ─────────────────────────────────── */
  .funnel-sidebar__journeys {
    margin: 12px 8px 0;
    padding: 12px;
    border-radius: var(--g-radius);
    display: flex;
    flex-direction: column;
    gap: 8px;
    position: relative;
  }
  /* Sticky section header inside the unified scroll — the "Customer
     Journey" label stays visible at the top of the panel while the
     user scrolls templates underneath. */
  .funnel-sidebar__journeys-header {
    position: sticky;
    top: 0;
    z-index: 2;
    display: flex;
    align-items: center;
    justify-content: space-between;
    background: linear-gradient(
      to bottom,
      var(--g-surface) 0%,
      var(--g-surface) 80%,
      transparent 100%
    );
    margin: -12px -12px 4px;
    padding: 10px 12px 8px;
    border-radius: var(--g-radius) var(--g-radius) 0 0;
    backdrop-filter: var(--g-blur);
    -webkit-backdrop-filter: var(--g-blur);
  }
  .funnel-sidebar__journey-create {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px;
    border-radius: var(--g-radius-sm);
    border: 1px solid var(--g-border);
    background: var(--g-gradient-accent);
    color: var(--g-bg);
    font-family: inherit;
    font-weight: 700;
    font-size: 11px;
    letter-spacing: 1px;
    text-transform: uppercase;
    cursor: pointer;
    transition: transform 0.15s ease, box-shadow 0.2s ease;
    box-shadow: 0 8px 24px var(--g-primary-soft);
  }
  .funnel-sidebar__journey-create:hover {
    transform: translateY(-1px);
    box-shadow: 0 10px 30px var(--g-primary-muted);
  }
  .funnel-sidebar__journey-create svg {
    width: 14px;
    height: 14px;
    stroke: var(--g-bg);
  }
  .funnel-sidebar__journey-section-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 2px 2px;
  }
  .funnel-sidebar__journey-section-label {
    font-size: 9px;
    letter-spacing: 1.6px;
    text-transform: uppercase;
    color: var(--g-fg-faint);
  }
  .funnel-sidebar__journey-clear-all {
    background: transparent;
    border: 1px solid transparent;
    color: var(--g-fg-faint);
    font-size: 9px;
    letter-spacing: 1.1px;
    text-transform: uppercase;
    padding: 2px 8px;
    border-radius: 999px;
    cursor: pointer;
    font-family: inherit;
    transition: color 0.15s ease, border-color 0.15s ease, background 0.15s ease;
  }
  .funnel-sidebar__journey-clear-all:hover {
    color: var(--destructive, #ef4444);
    border-color: color-mix(in srgb, var(--destructive, #ef4444) 30%, transparent);
    background: color-mix(in srgb, var(--destructive, #ef4444) 8%, transparent);
  }
  .funnel-sidebar__journey-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .funnel-sidebar__journey-item {
    display: flex;
    align-items: stretch;
    gap: 4px;
    border-radius: var(--g-radius-sm);
    border: 1px solid var(--g-border);
    background: var(--g-surface);
    overflow: hidden;
    transition: border-color 0.15s ease, background 0.15s ease, transform 0.15s ease, box-shadow 0.2s ease;
  }
  .funnel-sidebar__journey-item:hover {
    border-color: var(--g-primary-muted);
    background: var(--g-surface-hover);
    transform: translateX(2px);
  }
  .funnel-sidebar__journey-item.selected {
    border-color: var(--g-primary);
    background: var(--g-primary-soft);
    box-shadow: 0 0 0 1px var(--g-primary-muted), 0 0 18px var(--g-primary-soft);
  }
  .funnel-sidebar__journey-item-main {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 10px;
    color: var(--g-fg);
    cursor: pointer;
    font-family: inherit;
    text-align: left;
    background: transparent;
    border: none;
    flex: 1;
    min-width: 0;
  }
  .funnel-sidebar__journey-delete {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    border: none;
    background: transparent;
    color: var(--g-fg-faint);
    cursor: pointer;
    border-left: 1px solid var(--g-border);
    transition: color 0.15s ease, background 0.15s ease;
  }
  .funnel-sidebar__journey-delete:hover {
    color: var(--destructive, #ef4444);
    background: color-mix(in srgb, var(--destructive, #ef4444) 10%, transparent);
  }
  .funnel-sidebar__journey-delete svg {
    width: 12px;
    height: 12px;
  }
  /* Template buttons (no delete) — keep the rounded full-width clickable card */
  .funnel-sidebar__journey-item.template {
    display: flex;
  }
  .funnel-sidebar__journey-item.template > .funnel-sidebar__journey-item-main {
    cursor: pointer;
  }
  .funnel-sidebar__journey-emoji {
    font-size: 18px;
    line-height: 1;
    flex-shrink: 0;
  }
  .funnel-sidebar__journey-info {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .funnel-sidebar__journey-name {
    font-size: 12px;
    font-weight: 600;
    color: var(--g-fg);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .funnel-sidebar__journey-desc {
    font-size: 10px;
    color: var(--g-fg-faint);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  @media (max-width: 720px) {
    .funnel-sidebar,
    .funnel-sidebar--collapsed {
      width: 100%;
      height: auto;
      min-height: 0;
      max-height: 620px;
      padding: 0;
      align-items: stretch;
      border-right: 0;
      border-bottom: 1px solid var(--g-border);
    }
    .funnel-sidebar__scroll {
      min-height: 180px;
      max-height: 470px;
      mask-image: none;
      -webkit-mask-image: none;
    }
    .funnel-sidebar--collapsed .funnel-sidebar__collapsed-icons {
      display: flex;
      flex-flow: row wrap;
      justify-content: center;
      padding: 0 12px 12px;
    }
    .funnel-sidebar--collapsed .funnel-sidebar__expand-btn {
      align-self: flex-start;
      margin: 10px 12px;
    }
  }
`;
