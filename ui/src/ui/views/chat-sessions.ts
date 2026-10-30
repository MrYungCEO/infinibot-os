/**
 * Chat Page - Session Management UI
 * Stylized session header matching the black & gold HUD theme
 */

import { html, nothing } from "lit";
import { icons } from "../icons";
import type { AppViewState } from "../app-view-state";
import type { GatewaySessionRow } from "../types";
import { createNewSession, switchToSession } from "../controllers/sessions-management";
import { patchSession } from "../controllers/sessions";

// ============================================================
// Model Selector Types & State
// ============================================================

export type ModelOption = {
  id: string;
  name: string;
  provider?: string;
};

// Per-panel model selector state (keyed by session key to support multi-grid)
const modelSelectorState: Map<string, {
  open: boolean;
  searchQuery: string;
  providerFilter: string | null;
}> = new Map();

function getModelSelectorState(sessionKey: string) {
  if (!modelSelectorState.has(sessionKey)) {
    modelSelectorState.set(sessionKey, { open: false, searchQuery: "", providerFilter: null });
  }
  return modelSelectorState.get(sessionKey)!;
}

function closeModelSelector(sessionKey: string) {
  const state = getModelSelectorState(sessionKey);
  state.open = false;
  state.searchQuery = "";
}

function toggleModelSelector(sessionKey: string) {
  const state = getModelSelectorState(sessionKey);
  state.open = !state.open;
  if (state.open) {
    state.searchQuery = "";
    state.providerFilter = null;
  }
}

// Model filtering helpers
function getUniqueProviders(models: ModelOption[]): string[] {
  const providers = new Set<string>();
  for (const m of models) {
    if (m.provider) providers.add(m.provider);
  }
  return Array.from(providers).sort();
}

function filterModels(models: ModelOption[], search: string, provider: string | null): ModelOption[] {
  const query = search.toLowerCase().trim();
  return models.filter((m) => {
    // Grid-only "not connected" placeholders never appear in this picker.
    if (m.unconfigured) return false;
    if (provider && m.provider !== provider) return false;
    if (!query) return true;
    return (
      m.name.toLowerCase().includes(query) ||
      m.id.toLowerCase().includes(query) ||
      (m.provider?.toLowerCase().includes(query) ?? false)
    );
  });
}

function groupModelsByProvider(models: ModelOption[]): Map<string, ModelOption[]> {
  const grouped = new Map<string, ModelOption[]>();
  for (const m of models) {
    const key = m.provider ?? "other";
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(m);
  }
  return grouped;
}

// ============================================================
// Rename State
// ============================================================

let renamingSessionKey: string | null = null;
let renameInputValue: string = "";

// Context menu state
let contextMenuSessionKey: string | null = null;
let contextMenuX: number = 0;
let contextMenuY: number = 0;

function startRenameSession(key: string, currentName: string) {
  renamingSessionKey = key;
  renameInputValue = currentName;
  contextMenuSessionKey = null; // Close context menu when starting rename
}

function cancelRenameSession() {
  renamingSessionKey = null;
  renameInputValue = "";
}

function showContextMenu(key: string, x: number, y: number) {
  contextMenuSessionKey = key;
  contextMenuX = x;
  contextMenuY = y;
}

function hideContextMenu() {
  contextMenuSessionKey = null;
}

// ============================================================
// Helpers
// ============================================================

function formatRelativeTime(ts: number | null | undefined): string {
  if (!ts) return "—";
  const ms = Date.now() - ts;
  if (ms < 0) return "just now";
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) {
    const m = Math.floor(ms / 60_000);
    return `${m}m ago`;
  }
  if (ms < 86_400_000) {
    const h = Math.floor(ms / 3_600_000);
    return `${h}h ago`;
  }
  const d = Math.floor(ms / 86_400_000);
  return `${d}d ago`;
}

function formatTokens(n: number | undefined): string {
  if (!n) return "0";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

function shortModel(model?: string): string {
  if (!model) return "default";
  // "anthropic/claude-opus-4-5" → "claude-opus-4-5"
  const slash = model.lastIndexOf("/");
  return slash >= 0 ? model.slice(slash + 1) : model;
}

function sessionDisplayName(s: GatewaySessionRow): string {
  // Prefer label/derivedTitle over displayName (displayName is often a raw key)
  if (s.label && !looksLikeSessionKey(s.label)) return s.label;
  if (s.derivedTitle && !looksLikeSessionKey(s.derivedTitle)) return s.derivedTitle;
  if (s.displayName && !looksLikeSessionKey(s.displayName)) return s.displayName;
  return friendlyKey(s.key);
}

function looksLikeSessionKey(name: string): boolean {
  return /^(whatsapp|webchat|discord|telegram|signal|slack|imessage|nostr):/.test(name)
    || /^agent:/.test(name)
    || /^g-agent-/.test(name);
}

function friendlyKey(key: string): string {
  // "agent:main:main" → "Main"
  // "agent:main:whatsapp:+66..." → "WhatsApp +66..."
  const parts = key.split(":");
  if (parts[0] === "agent" && parts.length >= 3) {
    if (parts[2] === "main" || parts[2] === parts[1]) return capitalize(parts[1]);
    // channel sessions
    if (parts.length >= 4) {
      return `${capitalize(parts[2])} ${parts.slice(3).join(":")}`;
    }
    return capitalize(parts[2]);
  }
  return key;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function kindBadge(kind: string): string {
  switch (kind) {
    case "direct": return "DM";
    case "group": return "GROUP";
    case "global": return "GLOBAL";
    default: return "";
  }
}

function channelIcon(channel?: string): string {
  switch (channel) {
    case "whatsapp": return "📱";
    case "telegram": return "✈️";
    case "discord": return "🎮";
    case "signal": return "🔒";
    case "slack": return "💼";
    case "webchat": return "🌐";
    case "imessage": return "💬";
    default: return "⚡";
  }
}

// ============================================================
// Session Model Selector Component
// ============================================================

function renderSessionModelSelector(props: {
  sessionKey: string;
  currentModel: string;
  models: ModelOption[];
  selectorState: { open: boolean; searchQuery: string; providerFilter: string | null };
  onModelChange: (sessionKey: string, modelId: string) => Promise<void>;
  onRequestUpdate?: () => void;
}) {
  const { sessionKey, currentModel, models, selectorState, onModelChange, onRequestUpdate } = props;
  
  const providers = getUniqueProviders(models);
  const filtered = filterModels(models, selectorState.searchQuery, selectorState.providerFilter);
  const grouped = groupModelsByProvider(filtered);
  
  // Find current model display info
  const currentModelInfo = models.find((m) => m.id === currentModel);
  const displayName = currentModelInfo?.name ?? shortModel(currentModel);
  const displayProvider = currentModelInfo?.provider ?? "";
  
  // Icons
  const chevronIcon = html`<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m6 9 6 6 6-6"/></svg>`;
  const searchIcon = html`<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>`;
  const checkIcon = html`<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6 9 17l-5-5"/></svg>`;
  const modelIcon = html`<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2 2 7l10 5 10-5-10-5Z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/></svg>`;
  
  const handleSelect = async (modelId: string) => {
    closeModelSelector(sessionKey);
    onRequestUpdate?.();
    await onModelChange(sessionKey, modelId);
    onRequestUpdate?.();
  };
  
  const handleToggle = (e: Event) => {
    e.stopPropagation();
    toggleModelSelector(sessionKey);
    
    if (selectorState.open) {
      // Focus search input after render and setup click outside handler
      requestAnimationFrame(() => {
        const container = (e.target as HTMLElement).closest(".term-model-selector");
        const input = container?.querySelector<HTMLInputElement>(".term-model__search-input");
        input?.focus();
        
        // Click outside handler
        const handleClickOutside = (evt: MouseEvent) => {
          if (!container?.contains(evt.target as Node)) {
            closeModelSelector(sessionKey);
            document.removeEventListener("click", handleClickOutside);
            onRequestUpdate?.();
          }
        };
        setTimeout(() => document.addEventListener("click", handleClickOutside), 0);
      });
    }
    onRequestUpdate?.();
  };
  
  const handleSearch = (e: Event) => {
    e.stopPropagation();
    selectorState.searchQuery = (e.target as HTMLInputElement).value;
    onRequestUpdate?.();
  };
  
  const handleProviderFilter = (provider: string | null) => (e: Event) => {
    e.stopPropagation();
    selectorState.providerFilter = selectorState.providerFilter === provider ? null : provider;
    onRequestUpdate?.();
  };
  
  // Truncate model name for display
  const truncatedName = displayName.length > 18 ? displayName.slice(0, 16) + "…" : displayName;
  
  return html`
    <div class="term-cell term-cell--stat term-model-selector">
      <button class="term-model__trigger ${selectorState.open ? 'open' : ''}" @click=${handleToggle} title="Select AI Model for this session">
        ${modelIcon}
        ${displayProvider ? html`<span class="term-model__provider">${displayProvider}/</span>` : nothing}
        <span class="term-model__name">${truncatedName.replace(`${displayProvider}/`, "")}</span>
        <span class="term-model__chevron">${chevronIcon}</span>
      </button>
      
      ${selectorState.open ? html`
        <div class="term-model__dropdown" @click=${(e: Event) => e.stopPropagation()}>
          <!-- Search -->
          <div class="term-model__search">
            <span class="term-model__search-icon">${searchIcon}</span>
            <input
              type="text"
              class="term-model__search-input"
              placeholder="Search models..."
              .value=${selectorState.searchQuery}
              @input=${handleSearch}
              @keydown=${(e: KeyboardEvent) => {
                if (e.key === "Escape") {
                  closeModelSelector(sessionKey);
                  onRequestUpdate?.();
                }
              }}
            />
          </div>
          
          <!-- Provider filters -->
          ${providers.length > 1 ? html`
            <div class="term-model__filters">
              <button
                class="term-model__filter-chip ${selectorState.providerFilter === null ? 'active' : ''}"
                @click=${handleProviderFilter(null)}
              >All</button>
              ${providers.map((p) => html`
                <button
                  class="term-model__filter-chip ${selectorState.providerFilter === p ? 'active' : ''}"
                  @click=${handleProviderFilter(p)}
                >${p}</button>
              `)}
            </div>
          ` : nothing}
          
          <!-- Model list -->
          <div class="term-model__list">
            ${models.length === 0 ? html`
              <div class="term-model__empty">Loading models...</div>
            ` : filtered.length === 0 ? html`
              <div class="term-model__empty">No models match</div>
            ` : html`
              ${Array.from(grouped.entries()).map(([provider, providerModels]) => html`
                <div class="term-model__group">
                  <div class="term-model__group-label">${provider}</div>
                  ${providerModels.map((m) => html`
                    <button
                      class="term-model__item ${m.id === currentModel ? 'selected' : ''}"
                      @click=${() => handleSelect(m.id)}
                    >
                      <span class="term-model__item-name">${m.name}</span>
                      ${m.id === currentModel ? html`<span class="term-model__item-check">${checkIcon}</span>` : nothing}
                    </button>
                  `)}
                </div>
              `)}
            `}
          </div>
        </div>
      ` : nothing}
    </div>
  `;
}

function renderSessionModelSelectorStyles() {
  return html`
    <style>
      /* ============================================================
         Session Model Selector (.term-model-)
         ============================================================ */
      .term-model-selector {
        position: relative;
        border-right: none;
        padding: 0;
      }
      
      .term-model__trigger {
        display: flex;
        align-items: center;
        gap: 5px;
        padding: 0 10px;
        height: 100%;
        background: transparent;
        border: none;
        border-left: 1px solid rgba(255,255,255,0.06);
        color: rgba(255,255,255,0.5);
        font-family: inherit;
        font-size: 10px;
        cursor: pointer;
        transition: all 0.12s ease;
        white-space: nowrap;
      }
      .term-model__trigger:hover {
        background: color-mix(in srgb, var(--g-primary) 8%, transparent);
        color: var(--g-primary);
      }
      .term-model__trigger.open {
        background: color-mix(in srgb, var(--g-primary) 12%, transparent);
        color: var(--g-primary);
      }
      
      .term-model__provider {
        color: color-mix(in srgb, var(--g-primary) 50%, transparent);
        font-weight: 500;
      }
      .term-model__name {
        font-weight: 600;
        color: inherit;
      }
      .term-model__chevron {
        opacity: 0.5;
        transition: transform 0.15s;
      }
      .term-model__trigger.open .term-model__chevron {
        transform: rotate(180deg);
      }
      
      /* Dropdown */
      .term-model__dropdown {
        position: absolute;
        top: 100%;
        right: 0;
        min-width: 280px;
        max-width: 360px;
        background: #0a0a0a;
        border: 1px solid color-mix(in srgb, var(--g-primary) 20%, transparent);
        border-radius: 6px;
        box-shadow: 0 12px 40px rgba(0,0,0,0.6), 0 0 0 1px color-mix(in srgb, var(--g-primary) 5%, transparent);
        z-index: 200;
        overflow: hidden;
      }
      
      /* Search */
      .term-model__search {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 10px;
        border-bottom: 1px solid rgba(255,255,255,0.05);
      }
      .term-model__search-icon {
        color: rgba(255,255,255,0.3);
        flex-shrink: 0;
      }
      .term-model__search-input {
        flex: 1;
        background: transparent;
        border: none;
        color: #e4e4e7;
        font-family: inherit;
        font-size: 11px;
        outline: none;
      }
      .term-model__search-input::placeholder {
        color: rgba(255,255,255,0.25);
      }
      
      /* Provider filters */
      .term-model__filters {
        display: flex;
        gap: 4px;
        padding: 6px 8px;
        border-bottom: 1px solid rgba(255,255,255,0.05);
        flex-wrap: wrap;
      }
      .term-model__filter-chip {
        padding: 3px 8px;
        background: rgba(255,255,255,0.04);
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 10px;
        color: rgba(255,255,255,0.5);
        font-family: inherit;
        font-size: 9px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.03em;
        cursor: pointer;
        transition: all 0.1s;
      }
      .term-model__filter-chip:hover {
        background: color-mix(in srgb, var(--g-primary) 10%, transparent);
        border-color: color-mix(in srgb, var(--g-primary) 20%, transparent);
        color: var(--g-primary);
      }
      .term-model__filter-chip.active {
        background: color-mix(in srgb, var(--g-primary) 15%, transparent);
        border-color: color-mix(in srgb, var(--g-primary) 30%, transparent);
        color: var(--g-primary);
      }
      
      /* Model list */
      .term-model__list {
        max-height: 280px;
        overflow-y: auto;
        scrollbar-width: thin;
        scrollbar-color: color-mix(in srgb, var(--g-primary) 20%, transparent) transparent;
      }
      .term-model__list::-webkit-scrollbar {
        width: 5px;
      }
      .term-model__list::-webkit-scrollbar-track {
        background: transparent;
      }
      .term-model__list::-webkit-scrollbar-thumb {
        background: color-mix(in srgb, var(--g-primary) 20%, transparent);
        border-radius: 3px;
      }
      
      .term-model__empty {
        padding: 16px;
        text-align: center;
        color: rgba(255,255,255,0.35);
        font-size: 11px;
      }
      
      .term-model__group {
        border-bottom: 1px solid rgba(255,255,255,0.03);
      }
      .term-model__group:last-child {
        border-bottom: none;
      }
      .term-model__group-label {
        padding: 6px 10px;
        font-size: 8px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.1em;
        color: color-mix(in srgb, var(--g-primary) 40%, transparent);
        background: rgba(255,255,255,0.02);
        border-bottom: 1px solid rgba(255,255,255,0.03);
      }
      
      .term-model__item {
        display: flex;
        align-items: center;
        width: 100%;
        padding: 8px 10px;
        background: transparent;
        border: none;
        color: #a1a1aa;
        font-family: inherit;
        font-size: 11px;
        text-align: left;
        cursor: pointer;
        transition: all 0.1s;
      }
      .term-model__item:hover {
        background: color-mix(in srgb, var(--g-primary) 6%, transparent);
        color: #e4e4e7;
      }
      .term-model__item.selected {
        background: color-mix(in srgb, var(--g-primary) 10%, transparent);
        color: var(--g-primary);
      }
      .term-model__item-name {
        flex: 1;
        font-weight: 500;
      }
      .term-model__item-check {
        color: var(--g-primary);
        flex-shrink: 0;
      }
    </style>
  `;
}

// ============================================================
// Session Header Component — Terminal Grid Style
// ============================================================

export function renderChatSessionHeader(props: {
  state: AppViewState;
  onSessionChange?: () => void;
  availableModels?: ModelOption[];
  onModelChange?: (sessionKey: string, modelId: string) => Promise<void>;
}) {
  const { state, onSessionChange, availableModels = [], onModelChange } = props;
  const currentKey = state.sessionKey;
  const sessions: GatewaySessionRow[] = state.sessionsResult?.sessions || [];
  const cur = sessions.find((s) => s.key === currentKey);

  const name = cur ? sessionDisplayName(cur) : friendlyKey(currentKey);
  const currentModel = cur?.model || "";
  const totalTok = cur?.totalTokens ?? 0;
  const inputTok = cur?.inputTokens ?? 0;
  const outputTok = cur?.outputTokens ?? 0;
  const channel = cur?.channel;
  const reasoning = cur?.reasoningLevel;
  
  // Model selector state for this session
  const selectorState = getModelSelectorState(currentKey);
  const hasModels = availableModels.length > 0;

  return html`
    <div class="term-bar">
      <!-- Identity cell -->
      <div class="term-cell term-cell--id">
        <span class="term-led"></span>
        ${channel ? html`<span class="term-ch">${channelIcon(channel)}</span>` : nothing}
        <span class="term-name">${name}</span>
        ${reasoning && reasoning !== "off" ? html`<span class="term-badge term-badge--reason">${icons.brain}${reasoning}</span>` : nothing}
      </div>

      <!-- Stats cells -->
      <div class="term-cell term-cell--stat" title="Input / Output tokens">
        <span class="term-label">I/O</span>
        <span class="term-value">${formatTokens(inputTok)}↑${formatTokens(outputTok)}↓</span>
      </div>
      <div class="term-cell term-cell--stat" title="Total tokens">
        <span class="term-label">TOK</span>
        <span class="term-value term-value--gold">${formatTokens(totalTok)}</span>
      </div>
      
      <!-- Model Selector Cell -->
      ${hasModels && onModelChange
        ? renderSessionModelSelector({
            sessionKey: currentKey,
            currentModel,
            models: availableModels,
            selectorState,
            onModelChange,
            onRequestUpdate: state.requestUpdate,
          })
        : html`
          <div class="term-cell term-cell--stat term-cell--model" title="Model">
            <span class="term-value term-value--dim">${shortModel(currentModel)}</span>
          </div>
        `}

      <!-- Controls -->
      <div class="term-controls">
        ${sessions.length > 1 ? html`
          <div class="term-dd-wrap">
            <button class="term-ctrl" @click=${(e: Event) => {
              const dd = (e.currentTarget as HTMLElement).closest('.term-dd-wrap')?.querySelector('.term-dd') as HTMLElement;
              if (dd) dd.classList.toggle('open');
            }} title="Sessions">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
                <rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>
              </svg>
              <span class="term-ctrl__count">${sessions.length}</span>
            </button>
            <div class="term-dd">
              <div class="term-dd__hdr">SESSIONS</div>
              ${sessions.map((s) => html`
                <div class="term-dd__row ${currentKey === s.key ? 'active' : ''}"
                  @click=${async () => {
                    await switchToSession(state, s.key);
                    onSessionChange?.();
                    ((event?.target as HTMLElement)?.closest('.term-dd') as HTMLElement)?.classList.remove('open');
                  }}>
                  <span class="term-dd__led ${currentKey === s.key ? 'on' : ''}"></span>
                  ${s.channel ? html`<span class="term-dd__ch">${channelIcon(s.channel)}</span>` : nothing}
                  <span class="term-dd__name">${sessionDisplayName(s)}</span>
                  <span class="term-dd__tok">${formatTokens(s.totalTokens)}</span>
                </div>
              `)}
            </div>
          </div>
        ` : nothing}

        <button class="term-ctrl term-ctrl--accent" @click=${async () => {
          const newKey = await createNewSession(state);
          if (newKey) onSessionChange?.();
        }} title="New">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>

        <button class="term-ctrl" @click=${() => { state.setTab("sessions"); state.requestUpdate?.(); }} title="Dashboard">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>
          </svg>
        </button>
      </div>
    </div>

    ${renderSessionModelSelectorStyles()}
    <style>
      /* ============================================================
         Terminal Grid Header (.term-)
         ============================================================ */
      .term-bar {
        display: flex;
        align-items: stretch;
        background: #0a0a0a;
        border-bottom: 1px solid color-mix(in srgb, var(--g-primary) 12%, transparent);
        flex-shrink: 0;
        min-height: 32px;
        font-family: var(--mono, 'JetBrains Mono', 'SF Mono', monospace);
        font-size: 11px;
      }

      /* Grid cells */
      .term-cell {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 0 12px;
        border-right: 1px solid rgba(255,255,255,0.06);
      }
      .term-cell--id {
        flex: 1;
        min-width: 0;
      }
      .term-cell--stat {
        gap: 4px;
      }
      .term-cell--model {
        border-right: none;
      }

      /* LED indicator */
      .term-led {
        width: 6px; height: 6px;
        border-radius: 50%;
        background: #22c55e;
        box-shadow: 0 0 6px rgba(34,197,94,0.5);
        flex-shrink: 0;
      }

      .term-ch { font-size: 11px; }

      .term-name {
        font-weight: 600;
        color: #fff;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .term-badge {
        font-size: 9px;
        padding: 1px 4px;
        border-radius: 2px;
        background: rgba(255,255,255,0.06);
        color: rgba(255,255,255,0.6);
        text-transform: uppercase;
        letter-spacing: 0.03em;
      }
      .term-badge--reason {
        background: rgba(139,92,246,0.15);
        color: #a78bfa;
      }

      .term-label {
        font-size: 8px;
        font-weight: 700;
        letter-spacing: 0.1em;
        color: rgba(255,255,255,0.3);
        text-transform: uppercase;
      }

      .term-value {
        color: rgba(255,255,255,0.7);
      }
      .term-value--gold {
        color: var(--g-primary);
      }
      .term-value--dim {
        color: rgba(255,255,255,0.4);
        font-size: 10px;
      }

      /* Controls */
      .term-controls {
        display: flex;
        align-items: stretch;
        margin-left: auto;
      }

      .term-ctrl {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 4px;
        padding: 0 10px;
        background: transparent;
        border: none;
        border-left: 1px solid rgba(255,255,255,0.06);
        color: rgba(255,255,255,0.5);
        cursor: pointer;
        transition: all 0.1s;
      }
      .term-ctrl:hover {
        background: color-mix(in srgb, var(--g-primary) 10%, transparent);
        color: var(--g-primary);
      }
      .term-ctrl--accent {
        color: var(--g-primary);
        background: color-mix(in srgb, var(--g-primary) 5%, transparent);
      }
      .term-ctrl--accent:hover {
        background: var(--g-primary);
        color: #000;
      }
      .term-ctrl__count {
        font-size: 10px;
        font-weight: 700;
      }

      /* Dropdown */
      .term-dd-wrap { position: relative; }
      .term-dd {
        display: none;
        position: absolute;
        top: 100%;
        right: 0;
        min-width: 260px;
        max-height: 320px;
        overflow-y: auto;
        background: #0d0d0d;
        border: 1px solid color-mix(in srgb, var(--g-primary) 15%, transparent);
        box-shadow: 0 8px 32px rgba(0,0,0,0.6);
        z-index: 100;
      }
      .term-dd.open { display: block; }
      .term-dd__hdr {
        padding: 6px 10px;
        font-size: 9px;
        font-weight: 700;
        letter-spacing: 0.12em;
        color: color-mix(in srgb, var(--g-primary) 50%, transparent);
        background: color-mix(in srgb, var(--g-primary) 3%, transparent);
        border-bottom: 1px solid color-mix(in srgb, var(--g-primary) 8%, transparent);
      }
      .term-dd__row {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 8px 10px;
        cursor: pointer;
        border-bottom: 1px solid rgba(255,255,255,0.03);
        transition: background 0.08s;
      }
      .term-dd__row:last-child { border-bottom: none; }
      .term-dd__row:hover { background: color-mix(in srgb, var(--g-primary) 6%, transparent); }
      .term-dd__row.active { background: color-mix(in srgb, var(--g-primary) 10%, transparent); }
      .term-dd__led {
        width: 5px; height: 5px;
        border-radius: 50%;
        background: rgba(255,255,255,0.15);
        flex-shrink: 0;
      }
      .term-dd__led.on {
        background: #22c55e;
        box-shadow: 0 0 4px rgba(34,197,94,0.5);
      }
      .term-dd__ch { font-size: 10px; }
      .term-dd__name {
        flex: 1;
        font-size: 11px;
        color: #e4e4e7;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .term-dd__tok {
        font-size: 9px;
        color: rgba(255,255,255,0.35);
      }

      /* Responsive */
      @media (max-width: 640px) {
        .term-cell--stat { display: none; }
        .term-cell--model { display: none; }
        .term-ctrl__count { display: none; }
      }
    </style>
  `;
}

// ============================================================
// Session Context Bar — Directory & Project selector per-session
// ============================================================

export type SessionContextSettings = {
  directory: string;
  projectId: string | null;
  projectName: string | null;
};

// Per-session context storage
const SESSION_CONTEXT_KEY_PREFIX = "infinibot-session-context-";

function getSessionContextKey(sessionKey: string): string {
  // Sanitize session key for localStorage
  return SESSION_CONTEXT_KEY_PREFIX + sessionKey.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function loadSessionContext(sessionKey: string): SessionContextSettings {
  try {
    const raw = localStorage.getItem(getSessionContextKey(sessionKey));
    if (raw) {
      return JSON.parse(raw);
    }
  } catch {}
  return { directory: "", projectId: null, projectName: null };
}

export function saveSessionContext(sessionKey: string, ctx: SessionContextSettings): void {
  try {
    localStorage.setItem(getSessionContextKey(sessionKey), JSON.stringify(ctx));
  } catch {}
}

// Project dropdown state
let projectDropdownOpen = false;
let projectSearchQuery = "";

function toggleProjectDropdown() {
  projectDropdownOpen = !projectDropdownOpen;
  if (projectDropdownOpen) {
    projectSearchQuery = "";
  }
}

function closeProjectDropdown() {
  projectDropdownOpen = false;
  projectSearchQuery = "";
}

export type SessionContextProject = {
  id: string;
  name: string;
  status?: string;
  progress?: number;
};

export function renderSessionContextBar(props: {
  sessionKey: string;
  context: SessionContextSettings;
  projects: SessionContextProject[];
  projectsLoading?: boolean;
  onDirectoryChange: (dir: string) => void;
  onProjectChange: (projectId: string | null, projectName: string | null) => void;
  onRequestUpdate?: () => void;
  onBrowseDirectory?: () => void;
}) {
  const { sessionKey, context, projects, projectsLoading, onDirectoryChange, onProjectChange, onRequestUpdate, onBrowseDirectory } = props;
  
  // Icons
  const folderIcon = html`<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`;
  const projectIcon = html`<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3h18v18H3zM3 9h18M9 21V9"/></svg>`;
  const chevronIcon = html`<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m6 9 6 6 6-6"/></svg>`;
  const clearIcon = html`<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg>`;
  const searchIcon = html`<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>`;
  
  // Filter projects by search
  const filteredProjects = projects.filter(p => {
    if (!projectSearchQuery) return true;
    const query = projectSearchQuery.toLowerCase();
    return p.name.toLowerCase().includes(query);
  });
  
  // Current project display
  const currentProject = projects.find(p => p.id === context.projectId);
  const projectDisplay = currentProject ? currentProject.name : context.projectName || "Select project...";
  const hasProject = !!context.projectId;
  
  const handleDirectoryInput = (e: Event) => {
    const value = (e.target as HTMLInputElement).value;
    onDirectoryChange(value);
  };
  
  const handleProjectSelect = (project: SessionContextProject | null) => {
    if (project) {
      onProjectChange(project.id, project.name);
    } else {
      onProjectChange(null, null);
    }
    closeProjectDropdown();
    onRequestUpdate?.();
  };
  
  const handleSearchInput = (e: Event) => {
    e.stopPropagation();
    projectSearchQuery = (e.target as HTMLInputElement).value;
    onRequestUpdate?.();
  };
  
  return html`
    <div class="ctx-bar">
      <!-- Directory Input -->
      <div class="ctx-field ctx-field--dir">
        <span class="ctx-field__icon">${folderIcon}</span>
        <input
          type="text"
          class="ctx-field__input"
          placeholder="Working directory..."
          .value=${context.directory}
          @input=${handleDirectoryInput}
          @change=${handleDirectoryInput}
          title="Working directory for this session"
        />
        ${onBrowseDirectory ? html`
          <button class="ctx-field__btn" @click=${onBrowseDirectory} title="Browse...">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M3 12h18M3 18h18"/></svg>
          </button>
        ` : nothing}
      </div>
      
      <!-- Project Dropdown -->
      <div class="ctx-field ctx-field--project">
        <span class="ctx-field__icon">${projectIcon}</span>
        <button
          class="ctx-field__trigger ${projectDropdownOpen ? 'open' : ''} ${hasProject ? 'has-value' : ''}"
          @click=${(e: Event) => {
            e.stopPropagation();
            toggleProjectDropdown();
            onRequestUpdate?.();
            if (projectDropdownOpen) {
              // Setup click-outside handler
              requestAnimationFrame(() => {
                const container = (e.target as HTMLElement).closest(".ctx-field--project");
                const handleClickOutside = (evt: MouseEvent) => {
                  if (!container?.contains(evt.target as Node)) {
                    closeProjectDropdown();
                    document.removeEventListener("click", handleClickOutside);
                    onRequestUpdate?.();
                  }
                };
                setTimeout(() => document.addEventListener("click", handleClickOutside), 0);
              });
            }
          }}
          title="Select Kanban project for this session"
        >
          <span class="ctx-trigger__text">${projectDisplay}</span>
          <span class="ctx-trigger__chevron">${chevronIcon}</span>
        </button>
        
        ${hasProject ? html`
          <button class="ctx-field__clear" @click=${(e: Event) => {
            e.stopPropagation();
            handleProjectSelect(null);
          }} title="Clear project">
            ${clearIcon}
          </button>
        ` : nothing}
        
        ${projectDropdownOpen ? html`
          <div class="ctx-dropdown" @click=${(e: Event) => e.stopPropagation()}>
            <!-- Search -->
            <div class="ctx-dropdown__search">
              <span class="ctx-dropdown__search-icon">${searchIcon}</span>
              <input
                type="text"
                class="ctx-dropdown__search-input"
                placeholder="Search projects..."
                .value=${projectSearchQuery}
                @input=${handleSearchInput}
                @keydown=${(e: KeyboardEvent) => {
                  if (e.key === "Escape") {
                    closeProjectDropdown();
                    onRequestUpdate?.();
                  }
                }}
              />
            </div>
            
            <!-- Project list -->
            <div class="ctx-dropdown__list">
              ${projectsLoading ? html`
                <div class="ctx-dropdown__empty">Loading projects...</div>
              ` : filteredProjects.length === 0 ? html`
                <div class="ctx-dropdown__empty">${projects.length === 0 ? "No projects found" : "No matches"}</div>
              ` : html`
                ${filteredProjects.map(p => html`
                  <button
                    class="ctx-dropdown__item ${p.id === context.projectId ? 'selected' : ''}"
                    @click=${() => handleProjectSelect(p)}
                  >
                    <span class="ctx-dropdown__item-name">${p.name}</span>
                    ${p.status ? html`<span class="ctx-dropdown__item-status">${p.status}</span>` : nothing}
                    ${typeof p.progress === "number" ? html`
                      <span class="ctx-dropdown__item-progress">${p.progress}%</span>
                    ` : nothing}
                  </button>
                `)}
              `}
            </div>
          </div>
        ` : nothing}
      </div>
    </div>
    
    <style>
      /* ============================================================
         Session Context Bar (.ctx-)
         ============================================================ */
      .ctx-bar {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 6px 10px;
        background: rgba(5,5,8,0.95);
        border-bottom: 1px solid color-mix(in srgb, var(--g-primary) 6%, transparent);
        font-family: var(--mono, 'JetBrains Mono', 'SF Mono', monospace);
        font-size: 11px;
        flex-shrink: 0;
      }
      
      .ctx-field {
        display: flex;
        align-items: center;
        gap: 6px;
        position: relative;
      }
      
      .ctx-field--dir {
        flex: 1;
        min-width: 0;
      }
      
      .ctx-field--project {
        flex-shrink: 0;
        min-width: 180px;
        max-width: 280px;
      }
      
      .ctx-field__icon {
        color: color-mix(in srgb, var(--g-primary) 40%, transparent);
        flex-shrink: 0;
      }
      
      .ctx-field__input {
        flex: 1;
        min-width: 0;
        background: rgba(255,255,255,0.03);
        border: 1px solid rgba(255,255,255,0.06);
        border-radius: 4px;
        padding: 4px 8px;
        font-family: inherit;
        font-size: 10px;
        color: #e4e4e7;
        outline: none;
        transition: all 0.15s;
      }
      .ctx-field__input::placeholder {
        color: rgba(255,255,255,0.25);
      }
      .ctx-field__input:focus {
        border-color: color-mix(in srgb, var(--g-primary) 30%, transparent);
        background: color-mix(in srgb, var(--g-primary) 3%, transparent);
      }
      
      .ctx-field__btn {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 22px;
        height: 22px;
        background: rgba(255,255,255,0.03);
        border: 1px solid rgba(255,255,255,0.06);
        border-radius: 4px;
        color: rgba(255,255,255,0.4);
        cursor: pointer;
        transition: all 0.15s;
        flex-shrink: 0;
      }
      .ctx-field__btn:hover {
        background: color-mix(in srgb, var(--g-primary) 10%, transparent);
        border-color: color-mix(in srgb, var(--g-primary) 20%, transparent);
        color: var(--g-primary);
      }
      
      .ctx-field__trigger {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 4px 8px;
        background: rgba(255,255,255,0.03);
        border: 1px solid rgba(255,255,255,0.06);
        border-radius: 4px;
        font-family: inherit;
        font-size: 10px;
        color: rgba(255,255,255,0.4);
        cursor: pointer;
        transition: all 0.15s;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        max-width: 200px;
      }
      .ctx-field__trigger:hover {
        border-color: color-mix(in srgb, var(--g-primary) 20%, transparent);
        background: color-mix(in srgb, var(--g-primary) 5%, transparent);
      }
      .ctx-field__trigger.open {
        border-color: color-mix(in srgb, var(--g-primary) 30%, transparent);
        background: color-mix(in srgb, var(--g-primary) 8%, transparent);
        color: var(--g-primary);
      }
      .ctx-field__trigger.has-value {
        color: #e4e4e7;
      }
      
      .ctx-trigger__text {
        overflow: hidden;
        text-overflow: ellipsis;
        flex: 1;
        text-align: left;
      }
      .ctx-trigger__chevron {
        opacity: 0.5;
        flex-shrink: 0;
        transition: transform 0.15s;
      }
      .ctx-field__trigger.open .ctx-trigger__chevron {
        transform: rotate(180deg);
      }
      
      .ctx-field__clear {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 18px;
        height: 18px;
        background: transparent;
        border: none;
        color: rgba(255,255,255,0.3);
        cursor: pointer;
        transition: all 0.15s;
        margin-left: -4px;
      }
      .ctx-field__clear:hover {
        color: #ef4444;
      }
      
      /* Dropdown */
      .ctx-dropdown {
        position: absolute;
        top: 100%;
        left: 0;
        right: 0;
        min-width: 220px;
        max-width: 320px;
        margin-top: 4px;
        background: #0a0a0a;
        border: 1px solid color-mix(in srgb, var(--g-primary) 20%, transparent);
        border-radius: 6px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.6);
        z-index: 200;
        overflow: hidden;
      }
      
      .ctx-dropdown__search {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 8px 10px;
        border-bottom: 1px solid rgba(255,255,255,0.05);
      }
      .ctx-dropdown__search-icon {
        color: rgba(255,255,255,0.3);
        flex-shrink: 0;
      }
      .ctx-dropdown__search-input {
        flex: 1;
        background: transparent;
        border: none;
        color: #e4e4e7;
        font-family: inherit;
        font-size: 11px;
        outline: none;
      }
      .ctx-dropdown__search-input::placeholder {
        color: rgba(255,255,255,0.25);
      }
      
      .ctx-dropdown__list {
        max-height: 200px;
        overflow-y: auto;
        scrollbar-width: thin;
        scrollbar-color: color-mix(in srgb, var(--g-primary) 20%, transparent) transparent;
      }
      .ctx-dropdown__list::-webkit-scrollbar {
        width: 5px;
      }
      .ctx-dropdown__list::-webkit-scrollbar-thumb {
        background: color-mix(in srgb, var(--g-primary) 20%, transparent);
        border-radius: 3px;
      }
      
      .ctx-dropdown__empty {
        padding: 12px;
        text-align: center;
        color: rgba(255,255,255,0.35);
        font-size: 10px;
      }
      
      .ctx-dropdown__item {
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
        padding: 8px 10px;
        background: transparent;
        border: none;
        border-bottom: 1px solid rgba(255,255,255,0.03);
        color: #a1a1aa;
        font-family: inherit;
        font-size: 11px;
        text-align: left;
        cursor: pointer;
        transition: all 0.1s;
      }
      .ctx-dropdown__item:last-child {
        border-bottom: none;
      }
      .ctx-dropdown__item:hover {
        background: color-mix(in srgb, var(--g-primary) 6%, transparent);
        color: #e4e4e7;
      }
      .ctx-dropdown__item.selected {
        background: color-mix(in srgb, var(--g-primary) 10%, transparent);
        color: var(--g-primary);
      }
      
      .ctx-dropdown__item-name {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .ctx-dropdown__item-status {
        font-size: 9px;
        padding: 1px 5px;
        background: rgba(255,255,255,0.05);
        border-radius: 3px;
        color: rgba(255,255,255,0.5);
        flex-shrink: 0;
      }
      .ctx-dropdown__item-progress {
        font-size: 9px;
        color: color-mix(in srgb, var(--g-primary) 60%, transparent);
        flex-shrink: 0;
      }
      
      /* Responsive */
      @media (max-width: 640px) {
        .ctx-bar {
          flex-wrap: wrap;
          padding: 6px 8px;
        }
        .ctx-field--dir {
          flex: 1 1 100%;
        }
        .ctx-field--project {
          flex: 1 1 auto;
          min-width: 140px;
        }
      }
    </style>
  `;
}

// ============================================================
// Session Tab Bar — Horizontal tabs below session header
// ============================================================

function getTabFriendlyName(s: GatewaySessionRow): string {
  // Prefer label (sub-agent spawn labels like "🏗️ Build API Router")
  if (s.label && !looksLikeSessionKey(s.label)) return s.label;
  // derivedTitle is auto-extracted from conversation — usually good
  if (s.derivedTitle && !looksLikeSessionKey(s.derivedTitle)) return s.derivedTitle;
  // displayName — but skip if it looks like a raw key
  if (s.displayName && !looksLikeSessionKey(s.displayName)) return s.displayName;

  // Smart parse from key
  const parts = s.key.split(":");
  if (parts[0] === "agent" && parts.length >= 3) {
    const agentId = parts[1];
    const segment = parts[2];

    // Main session for each agent
    if (segment === "main" && agentId === "main") return "Infini";
    if (segment === "main") return `${capitalize(agentId)}`;

    // Sub-agent sessions: "agent:coder:subagent:uuid"
    if (parts.includes("subagent")) {
      // Try to find a name from label/derivedTitle even if they were skipped above
      if (s.label) return s.label;
      if (s.derivedTitle) return s.derivedTitle;
      const agentName = capitalize(agentId);
      return `${agentName} Task`;
    }

    // Channel sessions: "agent:main:webchat:+66..."
    if (segment === "webchat") return "Webchat";
    if (segment === "whatsapp") return "WhatsApp";
    if (segment === "discord") return "Discord";
    if (segment === "telegram") return "Telegram";
    if (segment === "signal") return "Signal";
    if (segment === "slack") return "Slack";
    if (segment === "imessage") return "iMessage";

    // Default sessions like "agent:main:default"
    if (segment === "default") return `${capitalize(agentId)} Default`;

    return capitalize(segment);
  }
  return s.key;
}

function truncateName(name: string, max = 20): string {
  if (name.length <= max) return name;
  return name.slice(0, max - 1) + "…";
}

function getTabSessions(sessions: GatewaySessionRow[], currentKey: string): GatewaySessionRow[] {
  const TWO_HOURS = 2 * 60 * 60 * 1000;
  const now = Date.now();

  const filtered = sessions
    .filter(s => {
      if (s.key === currentKey) return true;
      if (s.updatedAt && (now - s.updatedAt) < TWO_HOURS) return true;
      if (s.key.includes("subagent")) return true;
      return false;
    })
    .sort((a, b) => {
      if (a.key === currentKey) return -1;
      if (b.key === currentKey) return 1;
      if (a.key.endsWith(":main")) return -1;
      if (b.key.endsWith(":main")) return 1;
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });

  // Ensure the current session key always has a tab, even if it's brand new
  if (currentKey && !filtered.some(s => s.key === currentKey)) {
    const label = currentKey.includes("webchat-") ? "New Chat" : undefined;
    filtered.unshift({
      key: currentKey,
      displayName: label || currentKey,
      label,
      updatedAt: now,
    } as GatewaySessionRow);
  }

  return filtered;
}

// Template dropdown state
let templateDropdownOpen = false;

function toggleTemplateDropdown() {
  templateDropdownOpen = !templateDropdownOpen;
}

function closeTemplateDropdown() {
  templateDropdownOpen = false;
}

export function renderSessionTabBar(props: {
  sessions: GatewaySessionRow[];
  currentSessionKey: string;
  onSwitchSession: (key: string) => void;
  onCloseSession?: (key: string) => void;
  onNewSession: () => void;
  onCreateMultiple?: (count: number) => void;
  onRename?: (key: string, newLabel: string) => void;
  onRequestUpdate?: () => void;
}) {
  const tabs = getTabSessions(props.sessions, props.currentSessionKey);

  if (tabs.length <= 1 && !props.onCreateMultiple) return nothing;

  // Find the session for context menu
  const contextSession = contextMenuSessionKey 
    ? tabs.find(s => s.key === contextMenuSessionKey) 
    : null;

  return html`
    <div class="term-tabs" @click=${() => { hideContextMenu(); props.onRequestUpdate?.(); }}>
      ${tabs.map(s => {
        const isActive = s.key === props.currentSessionKey;
        const isMain = s.key.endsWith(":main");
        const isRenaming = renamingSessionKey === s.key;
        const name = truncateName(getTabFriendlyName(s), 18);
        const fullName = getTabFriendlyName(s);
        const icon = s.channel ? channelIcon(s.channel) : "";
        
        if (isRenaming) {
          return html`
            <div class="term-tab active term-tab--renaming">
              <span class="term-tab__led on"></span>
              ${icon ? html`<span class="term-tab__icon">${icon}</span>` : nothing}
              <input
                type="text"
                class="term-tab__rename-input"
                .value=${renameInputValue}
                @input=${(e: Event) => { renameInputValue = (e.target as HTMLInputElement).value; }}
                @keydown=${(e: KeyboardEvent) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    const trimmed = renameInputValue.trim();
                    if (trimmed && props.onRename) {
                      props.onRename(s.key, trimmed);
                    }
                    cancelRenameSession();
                    props.onRequestUpdate?.();
                  } else if (e.key === "Escape") {
                    cancelRenameSession();
                    props.onRequestUpdate?.();
                  }
                }}
                @blur=${() => {
                  const trimmed = renameInputValue.trim();
                  if (trimmed && props.onRename) {
                    props.onRename(s.key, trimmed);
                  }
                  cancelRenameSession();
                  props.onRequestUpdate?.();
                }}
                @click=${(e: Event) => e.stopPropagation()}
              />
            </div>
          `;
        }
        
        // Create contextmenu handler that captures the session key
        const handleContextMenu = (e: MouseEvent) => {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          showContextMenu(s.key, e.clientX, e.clientY);
          props.onRequestUpdate?.();
          return false;
        };
        
        // Double-click to rename
        const handleDoubleClick = (e: MouseEvent) => {
          e.preventDefault();
          e.stopPropagation();
          startRenameSession(s.key, fullName);
          props.onRequestUpdate?.();
          setTimeout(() => {
            const input = document.querySelector('.term-tab__rename-input') as HTMLInputElement;
            if (input) { input.focus(); input.select(); }
          }, 10);
        };
        
        return html`
          <div
            class="term-tab ${isActive ? "active" : ""}"
            title="${s.key} — Double-click or right-click to rename"
            @click=${(e: Event) => {
              e.stopPropagation();
              hideContextMenu();
              props.onSwitchSession(s.key);
              props.onRequestUpdate?.();
            }}
            @dblclick=${handleDoubleClick}
            @contextmenu=${handleContextMenu}
          >
            <span class="term-tab__led ${isActive ? 'on' : ''}"></span>
            ${icon ? html`<span class="term-tab__icon">${icon}</span>` : nothing}
            <span class="term-tab__name">${name}</span>
            ${!isMain ? html`
              <span class="term-tab__x" @click=${(e: Event) => {
                e.stopPropagation();
                props.onCloseSession?.(s.key);
              }}>×</span>
            ` : nothing}
          </div>
        `;
      })}
      <button class="term-tab term-tab--add" @click=${() => props.onNewSession()} title="New session">+</button>
      
      ${props.onCreateMultiple ? html`
        <div class="term-template-wrap">
          <button class="term-tab term-tab--template" @click=${(e: Event) => {
            e.stopPropagation();
            toggleTemplateDropdown();
            props.onRequestUpdate?.();
          }} title="Quick layouts">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
              <rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>
            </svg>
            <span class="term-template__label">Grid</span>
          </button>
          ${templateDropdownOpen ? html`
            <div class="term-template-dd" @click=${(e: Event) => e.stopPropagation()}>
              <div class="term-template-dd__header">Quick Layouts</div>
              <button class="term-template-dd__item" @click=${() => {
                props.onCreateMultiple?.(2);
                closeTemplateDropdown();
                props.onRequestUpdate?.();
              }}>
                <div class="term-template-dd__icon term-template-dd__icon--2">
                  <div class="term-template-dd__box"></div>
                  <div class="term-template-dd__box"></div>
                </div>
                <span class="term-template-dd__text">2 Sessions</span>
                <span class="term-template-dd__hint">Split View</span>
              </button>
              <button class="term-template-dd__item" @click=${() => {
                props.onCreateMultiple?.(3);
                closeTemplateDropdown();
                props.onRequestUpdate?.();
              }}>
                <div class="term-template-dd__icon term-template-dd__icon--3">
                  <div class="term-template-dd__box"></div>
                  <div class="term-template-dd__box"></div>
                  <div class="term-template-dd__box term-template-dd__box--wide"></div>
                </div>
                <span class="term-template-dd__text">3 Sessions</span>
                <span class="term-template-dd__hint">Triple Layout</span>
              </button>
              <button class="term-template-dd__item" @click=${() => {
                props.onCreateMultiple?.(4);
                closeTemplateDropdown();
                props.onRequestUpdate?.();
              }}>
                <div class="term-template-dd__icon term-template-dd__icon--4">
                  <div class="term-template-dd__box"></div>
                  <div class="term-template-dd__box"></div>
                  <div class="term-template-dd__box"></div>
                  <div class="term-template-dd__box"></div>
                </div>
                <span class="term-template-dd__text">4 Sessions</span>
                <span class="term-template-dd__hint">Quad Grid</span>
              </button>
            </div>
          ` : nothing}
        </div>
      ` : nothing}
    </div>
    
    <!-- Context Menu -->
    ${contextSession ? html`
      <div class="term-ctx-menu" style="left: ${contextMenuX}px; top: ${contextMenuY}px;"
        @click=${(e: Event) => e.stopPropagation()}>
        <button class="term-ctx-item" @click=${() => {
          const fullName = getTabFriendlyName(contextSession);
          startRenameSession(contextSession.key, fullName);
          props.onRequestUpdate?.();
          setTimeout(() => {
            const input = document.querySelector('.term-tab__rename-input') as HTMLInputElement;
            if (input) { input.focus(); input.select(); }
          }, 10);
        }}>
          <span class="term-ctx-icon">${icons.penLine}</span> Rename
        </button>
        ${!contextSession.key.endsWith(":main") ? html`
          <button class="term-ctx-item term-ctx-item--danger" @click=${() => {
            props.onCloseSession?.(contextSession.key);
            hideContextMenu();
            props.onRequestUpdate?.();
          }}>
            <span class="term-ctx-icon">${icons.trash}</span> Close
          </button>
        ` : nothing}
      </div>
    ` : nothing}

    <style>
      /* ============================================================
         Terminal Tab Bar (.term-tabs)
         ============================================================ */
      .term-tabs {
        display: flex;
        gap: 0;
        overflow-x: auto;
        scrollbar-width: none;
        background: #050505;
        flex-shrink: 0;
        height: 26px;
        align-items: stretch;
        font-family: var(--mono, 'JetBrains Mono', 'SF Mono', monospace);
      }
      .term-tabs::-webkit-scrollbar { display: none; }

      .term-tab {
        display: flex;
        align-items: center;
        gap: 5px;
        padding: 0 10px;
        font-size: 10px;
        color: rgba(255,255,255,0.4);
        background: transparent;
        border: none;
        border-right: 1px solid rgba(255,255,255,0.04);
        cursor: pointer;
        white-space: nowrap;
        max-width: 180px;
        transition: all 0.1s;
        flex-shrink: 0;
        position: relative;
      }
      .term-tab::after {
        content: '';
        position: absolute;
        bottom: 0;
        left: 0;
        right: 0;
        height: 2px;
        background: transparent;
        transition: background 0.1s;
      }
      .term-tab:hover {
        color: rgba(255,255,255,0.75);
        background: rgba(255,255,255,0.02);
      }
      .term-tab.active {
        color: var(--g-primary);
        background: color-mix(in srgb, var(--g-primary) 5%, transparent);
      }
      .term-tab.active::after {
        background: var(--g-primary);
      }

      .term-tab__led {
        width: 4px; height: 4px;
        border-radius: 50%;
        background: rgba(255,255,255,0.15);
        flex-shrink: 0;
      }
      .term-tab__led.on {
        background: var(--g-primary);
        box-shadow: 0 0 4px color-mix(in srgb, var(--g-primary) 60%, transparent);
      }

      .term-tab__icon {
        font-size: 9px;
        line-height: 1;
      }
      .term-tab__name {
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .term-tab__x {
        opacity: 0;
        font-size: 9px;
        padding: 1px 3px;
        margin-left: auto;
        transition: all 0.1s;
        line-height: 1;
      }
      .term-tab:hover .term-tab__x {
        opacity: 0.5;
      }
      .term-tab__x:hover {
        opacity: 1 !important;
        color: #ef4444;
      }

      .term-tab--add {
        font-size: 13px;
        color: color-mix(in srgb, var(--g-primary) 35%, transparent);
        padding: 0 10px;
        border-right: none;
      }
      .term-tab--add:hover {
        color: var(--g-primary);
        background: color-mix(in srgb, var(--g-primary) 8%, transparent);
      }
      
      /* Template dropdown wrapper */
      .term-template-wrap {
        position: relative;
        margin-left: auto;
      }
      
      .term-tab--template {
        display: flex;
        align-items: center;
        gap: 5px;
        padding: 0 10px;
        font-size: 10px;
        color: color-mix(in srgb, var(--g-primary) 50%, transparent);
        background: color-mix(in srgb, var(--g-primary) 3%, transparent);
        border: none;
        border-left: 1px solid color-mix(in srgb, var(--g-primary) 10%, transparent);
        cursor: pointer;
        white-space: nowrap;
        transition: all 0.15s;
        height: 100%;
      }
      .term-tab--template:hover {
        color: var(--g-primary);
        background: color-mix(in srgb, var(--g-primary) 10%, transparent);
      }
      .term-template__label {
        font-weight: 600;
        letter-spacing: 0.03em;
        text-transform: uppercase;
        font-size: 9px;
      }
      
      /* Template dropdown */
      .term-template-dd {
        position: absolute;
        top: 100%;
        right: 0;
        min-width: 200px;
        background: #0a0a0a;
        border: 1px solid color-mix(in srgb, var(--g-primary) 20%, transparent);
        border-radius: 6px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.6), 0 0 20px color-mix(in srgb, var(--g-primary) 5%, transparent);
        z-index: 200;
        overflow: hidden;
      }
      
      .term-template-dd__header {
        padding: 10px 14px;
        font-size: 9px;
        font-weight: 700;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        color: color-mix(in srgb, var(--g-primary) 50%, transparent);
        background: color-mix(in srgb, var(--g-primary) 3%, transparent);
        border-bottom: 1px solid color-mix(in srgb, var(--g-primary) 10%, transparent);
      }
      
      .term-template-dd__item {
        display: flex;
        align-items: center;
        gap: 12px;
        width: 100%;
        padding: 12px 14px;
        background: transparent;
        border: none;
        border-bottom: 1px solid rgba(255,255,255,0.03);
        cursor: pointer;
        text-align: left;
        transition: all 0.1s;
      }
      .term-template-dd__item:last-child {
        border-bottom: none;
      }
      .term-template-dd__item:hover {
        background: color-mix(in srgb, var(--g-primary) 8%, transparent);
      }
      .term-template-dd__item:hover .term-template-dd__box {
        border-color: var(--g-primary);
        background: color-mix(in srgb, var(--g-primary) 15%, transparent);
      }
      
      /* Grid preview icons */
      .term-template-dd__icon {
        display: grid;
        gap: 2px;
        width: 28px;
        height: 20px;
        flex-shrink: 0;
      }
      .term-template-dd__icon--2 {
        grid-template-columns: 1fr 1fr;
      }
      .term-template-dd__icon--3 {
        grid-template-columns: 1fr 1fr;
        grid-template-rows: 1fr 1fr;
      }
      .term-template-dd__icon--3 .term-template-dd__box--wide {
        grid-column: span 2;
      }
      .term-template-dd__icon--4 {
        grid-template-columns: 1fr 1fr;
        grid-template-rows: 1fr 1fr;
      }
      .term-template-dd__box {
        background: color-mix(in srgb, var(--g-primary) 8%, transparent);
        border: 1px solid color-mix(in srgb, var(--g-primary) 30%, transparent);
        border-radius: 2px;
        transition: all 0.15s;
      }
      
      .term-template-dd__text {
        font-size: 11px;
        font-weight: 600;
        color: #e4e4e7;
        flex: 1;
      }
      .term-template-dd__hint {
        font-size: 9px;
        color: #52525b;
        font-style: italic;
      }
      
      /* Rename input styles */
      .term-tab--renaming {
        cursor: default;
        padding: 0 6px;
      }
      .term-tab__rename-input {
        background: rgba(0,0,0,0.4);
        border: 1px solid color-mix(in srgb, var(--g-primary) 40%, transparent);
        border-radius: 2px;
        color: var(--g-primary);
        font-family: inherit;
        font-size: 10px;
        padding: 2px 6px;
        width: 120px;
        outline: none;
      }
      .term-tab__rename-input:focus {
        border-color: var(--g-primary);
        box-shadow: 0 0 6px color-mix(in srgb, var(--g-primary) 30%, transparent);
      }
      
      /* Context Menu */
      .term-ctx-menu {
        position: fixed;
        z-index: 9999;
        background: #0d0d0d;
        border: 1px solid color-mix(in srgb, var(--g-primary) 25%, transparent);
        border-radius: 4px;
        box-shadow: 0 4px 16px rgba(0,0,0,0.5);
        padding: 4px 0;
        min-width: 120px;
      }
      .term-ctx-item {
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
        padding: 8px 12px;
        background: transparent;
        border: none;
        color: #e4e4e7;
        font-family: inherit;
        font-size: 11px;
        cursor: pointer;
        text-align: left;
        transition: all 0.1s;
      }
      .term-ctx-item:hover {
        background: color-mix(in srgb, var(--g-primary) 10%, transparent);
        color: var(--g-primary);
      }
      .term-ctx-item--danger:hover {
        background: rgba(239,68,68,0.15);
        color: #ef4444;
      }
      .term-ctx-icon {
        font-size: 12px;
      }

      @media (max-width: 640px) {
        .term-tabs { height: 24px; }
        .term-tab { padding: 0 6px; font-size: 9px; max-width: 130px; }
        .term-tab__led { display: none; }
      }
    </style>
  `;
}

// ============================================================
// Session Info Panel (Right sidebar)
// ============================================================

export function renderChatSessionInfo(state: AppViewState) {
  const sessions: GatewaySessionRow[] = state.sessionsResult?.sessions || [];
  const cur = sessions.find((s) => s.key === state.sessionKey);

  if (!cur) return nothing;

  return html`
    <div class="si-panel">
      <div class="si-section">
        <h4 class="si-title">Session Details</h4>
        <div class="si-grid">
          <div class="si-field">
            <div class="si-field__label">Session Key</div>
            <div class="si-field__value si-field__value--mono">${state.sessionKey}</div>
          </div>
          <div class="si-field">
            <div class="si-field__label">Model</div>
            <div class="si-field__value si-field__value--mono">${cur.model || "default"}</div>
          </div>
          <div class="si-row">
            <div class="si-field" style="flex:1">
              <div class="si-field__label">Input Tokens</div>
              <div class="si-field__value">${formatTokens(cur.inputTokens)}</div>
            </div>
            <div class="si-field" style="flex:1">
              <div class="si-field__label">Output Tokens</div>
              <div class="si-field__value">${formatTokens(cur.outputTokens)}</div>
            </div>
          </div>
          <div class="si-field">
            <div class="si-field__label">Total Tokens</div>
            <div class="si-field__value" style="font-size:14px; color: var(--accent, var(--g-primary));">${formatTokens(cur.totalTokens)}</div>
          </div>
          <div class="si-field">
            <div class="si-field__label">Last Active</div>
            <div class="si-field__value">${formatRelativeTime(cur.updatedAt)}</div>
          </div>
          ${cur.channel ? html`
            <div class="si-field">
              <div class="si-field__label">Channel</div>
              <div class="si-field__value">${channelIcon(cur.channel)} ${cur.channel}</div>
            </div>
          ` : nothing}
        </div>
      </div>

      <div class="si-section">
        <h4 class="si-title">Active Sessions (${sessions.length})</h4>
        <div class="si-sessions">
          ${sessions.slice(0, 6).map(
            (s) => html`
              <div
                class="si-card ${state.sessionKey === s.key ? 'active' : ''}"
                @click=${async () => {
                  await switchToSession(state, s.key);
                  state.requestUpdate?.();
                }}
              >
                <div class="si-card__top">
                  ${s.channel ? html`<span style="font-size:10px;">${channelIcon(s.channel)}</span>` : nothing}
                  <span class="si-card__name">${sessionDisplayName(s)}</span>
                </div>
                <div class="si-card__meta">
                  ${shortModel(s.model)} · ${formatTokens(s.totalTokens)} tok · ${formatRelativeTime(s.updatedAt)}
                </div>
              </div>
            `
          )}
          ${sessions.length > 6 ? html`
            <div style="color: #52525b; text-align: center; padding: 6px; font-size: 10px;">
              +${sessions.length - 6} more
            </div>
          ` : nothing}
        </div>
      </div>

      <div class="si-footer">
        <button
          class="sh-btn sh-btn--ghost"
          style="width: 100%; justify-content: center;"
          @click=${() => { state.setTab("sessions"); state.requestUpdate?.(); }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
            <line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/>
            <line x1="6" y1="20" x2="6" y2="14"/>
          </svg>
          <span>Dashboard</span>
        </button>
      </div>
    </div>

    <style>
      .si-panel {
        background: rgba(8,8,12,0.95);
        border-left: 1px solid color-mix(in srgb, var(--g-primary) 8%, transparent);
        padding: 16px 14px; width: 280px;
        display: flex; flex-direction: column; gap: 16px;
        backdrop-filter: blur(12px);
      }
      .si-section { display: flex; flex-direction: column; gap: 10px; }
      .si-title {
        margin: 0;
        font-family: var(--mono, 'JetBrains Mono', monospace);
        font-size: 8px; font-weight: 700;
        text-transform: uppercase; letter-spacing: 0.12em;
        color: color-mix(in srgb, var(--g-primary) 40%, transparent);
        padding-bottom: 6px;
        border-bottom: 1px solid rgba(255,255,255,0.03);
      }
      .si-grid { display: flex; flex-direction: column; gap: 8px; }
      .si-row { display: flex; gap: 8px; }
      .si-field { display: flex; flex-direction: column; gap: 1px; }
      .si-field__label {
        font-size: 9px; color: #71717a;
        text-transform: uppercase; letter-spacing: 0.05em;
      }
      .si-field__value {
        font-size: 12px; font-weight: 600; color: #e4e4e7;
      }
      .si-field__value--mono {
        font-family: var(--mono, 'JetBrains Mono', monospace);
        font-size: 10px; color: color-mix(in srgb, var(--g-primary) 60%, transparent);
        word-break: break-all;
      }
      .si-sessions { display: flex; flex-direction: column; gap: 3px; }
      .si-card {
        padding: 6px 8px;
        background: rgba(255,255,255,0.02);
        border: 1px solid rgba(255,255,255,0.03);
        border-radius: 3px; cursor: pointer;
        transition: all 0.15s ease;
      }
      .si-card:hover {
        background: color-mix(in srgb, var(--g-primary) 4%, transparent);
        border-color: color-mix(in srgb, var(--g-primary) 12%, transparent);
      }
      .si-card.active {
        background: color-mix(in srgb, var(--g-primary) 6%, transparent);
        border-color: color-mix(in srgb, var(--g-primary) 20%, transparent);
      }
      .si-card__top {
        display: flex; align-items: center; gap: 4px;
      }
      .si-card__name {
        font-size: 11px; font-weight: 600; color: #d4d4d8;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .si-card__meta {
        font-family: var(--mono, 'JetBrains Mono', monospace);
        font-size: 9px; color: #52525b; margin-top: 1px;
      }
      .si-footer {
        margin-top: auto;
        padding-top: 10px;
        border-top: 1px solid rgba(255,255,255,0.03);
      }
    </style>
  `;
}
