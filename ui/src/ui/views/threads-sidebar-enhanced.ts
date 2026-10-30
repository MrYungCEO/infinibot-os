/**
 * Enhanced Threads Sidebar - Discord-style with reliable drag-drop
 * Uses pointer events for cross-platform support (mouse + touch)
 */

import { html, nothing } from "lit";
import { ref, createRef, Ref } from "lit/directives/ref.js";
import type { SessionsListResult, GatewaySessionRow } from "../types";
import { icons } from "../icons";
import { commIcon, ensureCommunicationGlassStyles } from "./communication-glass";
import type {
  SidebarState,
  SidebarCategory,
  SidebarItem,
} from "../controllers/sidebar-categories";
import {
  loadSidebarState,
  syncWithSessions,
  createCategory,
  deleteCategory,
  toggleCategoryCollapsed,
  addItemToCategory,
  moveItemWithinCategory,
  removeItemFromCategory,
  renameItem,
  toggleItemPinned,
  reorderCategories,
  startEdit,
  updateEditValue,
  finishEdit,
  cancelEdit,
  showContextMenu,
  hideContextMenu,
} from "../controllers/sidebar-categories";
import {
  getDragDropController,
  type DragItem,
  type DropZone,
  type DragDropState,
} from "../controllers/drag-drop";

export interface EnhancedThreadsSidebarProps {
  sessions: SessionsListResult | null;
  currentSessionKey: string;
  visible: boolean;
  onSwitchSession: (key: string) => void;
  onNewSession: () => void;
  onDeleteSession: (key: string) => void;
  onClose: () => void;
  onRefresh: () => void;
  sidebarState: SidebarState;
  onSidebarStateChange: (state: SidebarState) => void;
}

// ============================================================
// Helpers
// ============================================================

function formatRelativeTime(ts: number | null | undefined): string {
  if (!ts) return "";
  const ms = Date.now() - ts;
  if (ms < 0) return "now";
  if (ms < 60_000) return "now";
  if (ms < 3_600_000) {
    const m = Math.floor(ms / 60_000);
    return `${m}m`;
  }
  if (ms < 86_400_000) {
    const h = Math.floor(ms / 3_600_000);
    return `${h}h`;
  }
  const d = Math.floor(ms / 86_400_000);
  return `${d}d`;
}

function getSessionDisplayName(session: GatewaySessionRow, customName?: string): string {
  if (customName) return customName;
  if (session.derivedTitle && !looksLikeSessionKey(session.derivedTitle)) return session.derivedTitle;
  if (session.label && !looksLikeSessionKey(session.label)) return session.label;
  if (session.displayName && !looksLikeSessionKey(session.displayName)) return session.displayName;
  return friendlyKey(session.key);
}

function looksLikeSessionKey(name: string): boolean {
  return /^(whatsapp|webchat|discord|telegram|signal|slack|imessage|nostr):/.test(name)
    || /^agent:/.test(name)
    || /^g-agent-/.test(name);
}

function friendlyKey(key: string): string {
  const parts = key.split(":");
  if (parts[0] === "agent" && parts.length >= 3) {
    if (parts[2].startsWith("mobile-")) return "Mobile Chat";
    if (parts[2].startsWith("webchat-")) return "Chat";
    if (parts[2] === "main" || parts[2] === parts[1]) return "Main";
    return parts[2].charAt(0).toUpperCase() + parts[2].slice(1);
  }
  return key;
}

function getLastMessagePreview(s: GatewaySessionRow): string {
  const msg = (s as any).lastMessage;
  if (!msg) return "";
  
  let text = "";
  if (typeof msg.content === "string") {
    text = msg.content;
  } else if (Array.isArray(msg.content)) {
    const textBlocks = msg.content.filter((b: any) => b.type === "text");
    text = textBlocks.map((b: any) => b.text || "").join(" ");
  } else if (msg.text) {
    text = msg.text;
  }
  
  if (text.length > 50) {
    return text.slice(0, 47) + "...";
  }
  return text;
}

function getSourceIcon(key: string): string {
  if (key.includes("mobile-")) return "phone";
  if (key.includes("webchat-")) return "globe";
  if (key.includes("whatsapp")) return "chat";
  if (key.includes("telegram")) return "send";
  if (key.includes("discord")) return "game";
  return "bolt";
}

function isWebchatSession(key: string): boolean {
  return key.includes("webchat-") || key.includes("mobile-") || key === "agent:main:main" || key === "main";
}

// ============================================================
// Drag & Drop Integration
// ============================================================

let dragDropInitialized = false;
let sidebarContainerRef: HTMLElement | null = null;
let listContainerRef: HTMLElement | null = null;
let currentProps: EnhancedThreadsSidebarProps | null = null;

function initDragDrop(
  container: HTMLElement,
  listContainer: HTMLElement,
  props: EnhancedThreadsSidebarProps
) {
  if (dragDropInitialized) return;
  
  sidebarContainerRef = container;
  listContainerRef = listContainer;
  currentProps = props;
  
  const controller = getDragDropController();
  controller.init(
    container,
    listContainer,
    handleDrop,
    handleDragStateChange
  );
  
  dragDropInitialized = true;
}

function handleDrop(item: DragItem, zone: DropZone) {
  if (!currentProps) return;
  
  let newState = currentProps.sidebarState;
  
  if (item.type === 'category') {
    // Reordering categories
    if (zone.type === 'category-header') {
      const fromIndex = newState.categories.findIndex(c => c.id === item.id);
      const toIndex = zone.index;
      if (fromIndex !== -1 && fromIndex !== toIndex) {
        newState = reorderCategories(newState, fromIndex, toIndex);
      }
    }
  } else if (item.type === 'session') {
    // Moving/reordering sessions
    if (zone.type === 'session-slot' && zone.categoryId) {
      if (zone.categoryId === item.sourceCategoryId) {
        // Reorder within same category
        newState = moveItemWithinCategory(newState, item.id, zone.categoryId, zone.index);
      } else {
        // Move to different category
        newState = addItemToCategory(newState, item.id, zone.categoryId, zone.index);
      }
    } else if (zone.type === 'category-body' && zone.categoryId) {
      // Drop into category (append to end)
      newState = addItemToCategory(newState, item.id, zone.categoryId);
    } else if (zone.type === 'uncategorized') {
      // Move to uncategorized
      newState = removeItemFromCategory(newState, item.id);
    }
  }
  
  currentProps.onSidebarStateChange(newState);
}

function handleDragStateChange(_state: DragDropState) {
  // Could trigger re-render here if needed
  // For now, the drag controller handles visual updates internally
}

function handlePointerDown(
  e: PointerEvent,
  item: DragItem,
  element: HTMLElement
) {
  const controller = getDragDropController();
  controller.startPotentialDrag(e, item, element);
}

// ============================================================
// Render Functions
// ============================================================

function renderCategoryHeader(
  props: EnhancedThreadsSidebarProps,
  category: SidebarCategory,
  index: number
) {
  const isEditing = props.sidebarState.editState?.type === 'category' 
    && props.sidebarState.editState?.id === category.id;
  
  const handleHeaderPointerDown = (e: PointerEvent) => {
    // Don't start drag on buttons or inputs
    const target = e.target as HTMLElement;
    if (target.closest('button') || target.closest('input')) return;
    
    const el = (e.currentTarget as HTMLElement);
    handlePointerDown(e, {
      type: 'category',
      id: category.id,
      sourceCategoryId: null,
      sourceIndex: index,
    }, el);
  };
  
  return html`
    <div 
      class="sidebar-category-header"
      data-drop-category-header="${category.id}"
      data-category-id="${category.id}"
      data-drop-index="${index}"
      @pointerdown=${handleHeaderPointerDown}
      @contextmenu=${(e: MouseEvent) => {
        e.preventDefault();
        props.onSidebarStateChange(showContextMenu(props.sidebarState, 'category', category.id, e.clientX, e.clientY));
      }}
    >
      <button 
        class="sidebar-category-toggle g-btn g-btn--ghost g-btn--sm g-btn--icon"
        @click=${() => props.onSidebarStateChange(toggleCategoryCollapsed(props.sidebarState, category.id))}
      >
        ${category.collapsed ? icons.chevronRight : icons.chevronDown}
      </button>
      
      <span class="sidebar-category-icon">${category.icon || commIcon("folder", 15)}</span>
      
      ${isEditing ? html`
        <input
          type="text"
          class="sidebar-edit-input g-input"
          .value=${props.sidebarState.editState!.value}
          @input=${(e: InputEvent) => props.onSidebarStateChange(
            updateEditValue(props.sidebarState, (e.target as HTMLInputElement).value)
          )}
          @blur=${() => props.onSidebarStateChange(finishEdit(props.sidebarState))}
          @keydown=${(e: KeyboardEvent) => {
            if (e.key === 'Enter') {
              props.onSidebarStateChange(finishEdit(props.sidebarState));
            } else if (e.key === 'Escape') {
              props.onSidebarStateChange(cancelEdit(props.sidebarState));
            }
          }}
          @click=${(e: Event) => e.stopPropagation()}
          @pointerdown=${(e: Event) => e.stopPropagation()}
          autofocus
        />
      ` : html`
        <span 
          class="sidebar-category-name"
          @dblclick=${() => props.onSidebarStateChange(
            startEdit(props.sidebarState, 'category', category.id, category.name)
          )}
        >
          ${category.name}
        </span>
      `}
      
      <span class="sidebar-category-count g-chip">${category.itemIds.length}</span>
      
      <div class="sidebar-category-actions">
        <button 
          class="sidebar-action-btn g-btn g-btn--ghost g-btn--sm g-btn--icon"
          title="Delete category"
          @click=${(e: Event) => {
            e.stopPropagation();
            if (confirm('Delete this category? Items will be moved to uncategorized.')) {
              props.onSidebarStateChange(deleteCategory(props.sidebarState, category.id));
            }
          }}
        >
          ${icons.trash}
        </button>
      </div>
    </div>
  `;
}

function renderSessionItem(
  props: EnhancedThreadsSidebarProps,
  session: GatewaySessionRow,
  item: SidebarItem | undefined,
  index: number,
  categoryId: string | null
) {
  const itemId = session.key;
  const isActive = session.key === props.currentSessionKey;
  const isEditing = props.sidebarState.editState?.type === 'item' 
    && props.sidebarState.editState?.id === itemId;
  
  const preview = getLastMessagePreview(session);
  const timeAgo = formatRelativeTime(session.updatedAt);
  const icon = getSourceIcon(session.key);
  const displayName = getSessionDisplayName(session, item?.customName);
  
  const handleItemPointerDown = (e: PointerEvent) => {
    // Don't start drag on buttons or inputs
    const target = e.target as HTMLElement;
    if (target.closest('button') || target.closest('input')) return;
    
    const el = (e.currentTarget as HTMLElement);
    handlePointerDown(e, {
      type: 'session',
      id: itemId,
      sourceCategoryId: categoryId,
      sourceIndex: index,
    }, el);
  };
  
  return html`
    <div 
      class="sidebar-item g-card g-card--interactive ${isActive ? 'active' : ''} ${item?.pinned ? 'pinned' : ''}"
      data-session-id="${itemId}"
      data-drop-session-slot
      data-category-id="${categoryId || ''}"
      data-drop-index="${index}"
      @pointerdown=${handleItemPointerDown}
      @click=${() => props.onSwitchSession(session.key)}
      @contextmenu=${(e: MouseEvent) => {
        e.preventDefault();
        props.onSidebarStateChange(showContextMenu(props.sidebarState, 'item', itemId, e.clientX, e.clientY));
      }}
    >
      <div class="sidebar-item-drag-handle">
        <span class="drag-indicator" aria-hidden="true">${commIcon("list", 13)}</span>
      </div>
      
      <span class="sidebar-item-icon">${commIcon(icon, 16)}</span>
      
      <div class="sidebar-item-content">
        ${isEditing ? html`
          <input
            type="text"
            class="sidebar-edit-input g-input"
            .value=${props.sidebarState.editState!.value}
            @input=${(e: InputEvent) => props.onSidebarStateChange(
              updateEditValue(props.sidebarState, (e.target as HTMLInputElement).value)
            )}
            @blur=${() => props.onSidebarStateChange(finishEdit(props.sidebarState))}
            @keydown=${(e: KeyboardEvent) => {
              if (e.key === 'Enter') {
                props.onSidebarStateChange(finishEdit(props.sidebarState));
              } else if (e.key === 'Escape') {
                props.onSidebarStateChange(cancelEdit(props.sidebarState));
              }
            }}
            @click=${(e: Event) => e.stopPropagation()}
            @pointerdown=${(e: Event) => e.stopPropagation()}
            autofocus
          />
        ` : html`
          <div class="sidebar-item-header">
            <span 
              class="sidebar-item-title"
              @dblclick=${(e: Event) => {
                e.stopPropagation();
                props.onSidebarStateChange(
                  startEdit(props.sidebarState, 'item', itemId, displayName)
                );
              }}
            >
              ${item?.pinned ? commIcon("pin", 13) : nothing}${displayName}
            </span>
            <span class="sidebar-item-time">${timeAgo}</span>
          </div>
          ${preview ? html`
            <p class="sidebar-item-preview">${preview}</p>
          ` : html`
            <p class="sidebar-item-preview empty">No messages</p>
          `}
        `}
      </div>
      
      <button 
        class="sidebar-item-delete g-btn g-btn--ghost g-btn--sm g-btn--icon"
        @click=${(e: Event) => {
          e.stopPropagation();
          if (confirm(`Delete "${displayName}"?`)) {
            props.onDeleteSession(session.key);
          }
        }}
        title="Delete thread"
      >
        ${icons.trash}
      </button>
    </div>
  `;
}

function renderCategory(
  props: EnhancedThreadsSidebarProps,
  category: SidebarCategory,
  sessions: Map<string, GatewaySessionRow>,
  index: number
) {
  return html`
    <div class="sidebar-category">
      ${renderCategoryHeader(props, category, index)}
      
      ${category.collapsed ? nothing : html`
        <div 
          class="sidebar-category-items"
          data-drop-category-body="${category.id}"
        >
          ${category.itemIds.length === 0 ? html`
            <div class="sidebar-category-empty">
              <span>Drop threads here</span>
            </div>
          ` : category.itemIds.map((itemId, itemIndex) => {
            const session = sessions.get(itemId);
            if (!session) return nothing;
            const item = props.sidebarState.items[itemId];
            return renderSessionItem(props, session, item, itemIndex, category.id);
          })}
        </div>
      `}
    </div>
  `;
}

function renderUncategorized(
  props: EnhancedThreadsSidebarProps,
  sessions: Map<string, GatewaySessionRow>
) {
  // Get sessions that are not in any category
  const uncategorizedSessions = [...sessions.values()].filter(session => {
    const isInCategory = props.sidebarState.categories.some(
      cat => cat.itemIds.includes(session.key)
    );
    return !isInCategory;
  });
  
  if (uncategorizedSessions.length === 0) return nothing;
  
  return html`
    <div class="sidebar-category sidebar-uncategorized">
      <div class="sidebar-category-header uncategorized">
        <span class="sidebar-category-icon">${commIcon("list", 15)}</span>
        <span class="sidebar-category-name">All Threads</span>
        <span class="sidebar-category-count g-chip">${uncategorizedSessions.length}</span>
      </div>
      
      <div 
        class="sidebar-category-items"
        data-drop-uncategorized
      >
        ${uncategorizedSessions.map((session, index) => {
          const item = props.sidebarState.items[session.key];
          return renderSessionItem(props, session, item, index, null);
        })}
      </div>
    </div>
  `;
}

function renderContextMenu(props: EnhancedThreadsSidebarProps) {
  const { contextMenu } = props.sidebarState;
  if (!contextMenu) return nothing;
  
  const isCategory = contextMenu.type === 'category';
  
  // Keep menu within viewport
  const menuWidth = 200;
  const menuHeight = 200;
  let x = contextMenu.x;
  let y = contextMenu.y;
  
  if (x + menuWidth > window.innerWidth) {
    x = window.innerWidth - menuWidth - 10;
  }
  if (y + menuHeight > window.innerHeight) {
    y = window.innerHeight - menuHeight - 10;
  }
  
  return html`
    <div 
      class="sidebar-context-menu-overlay"
      @click=${() => props.onSidebarStateChange(hideContextMenu(props.sidebarState))}
      @contextmenu=${(e: Event) => e.preventDefault()}
    ></div>
    <div 
      class="sidebar-context-menu g-float"
      style="left: ${x}px; top: ${y}px;"
    >
      <button 
        class="context-menu-item g-btn g-btn--ghost"
        @click=${() => {
          const name = isCategory 
            ? props.sidebarState.categories.find(c => c.id === contextMenu.id)?.name || ''
            : getSessionDisplayName(
                props.sidebarState.items[contextMenu.id]?.session as GatewaySessionRow,
                props.sidebarState.items[contextMenu.id]?.customName
              );
          props.onSidebarStateChange(
            startEdit(hideContextMenu(props.sidebarState), contextMenu.type, contextMenu.id, name)
          );
        }}
      >
        ${commIcon("edit", 14)} Rename
      </button>
      
      ${!isCategory ? html`
        <button 
          class="context-menu-item g-btn g-btn--ghost"
          @click=${() => {
            props.onSidebarStateChange(
              toggleItemPinned(hideContextMenu(props.sidebarState), contextMenu.id)
            );
          }}
        >
          ${commIcon("pin", 14)} ${props.sidebarState.items[contextMenu.id]?.pinned ? 'Unpin' : 'Pin'}
        </button>
        
        <div class="context-menu-separator"></div>
        
        <div class="context-menu-submenu">
          <span class="context-menu-label">Move to:</span>
          ${props.sidebarState.categories.map(cat => html`
            <button 
              class="context-menu-item g-btn g-btn--ghost"
              @click=${() => {
                props.onSidebarStateChange(
                  addItemToCategory(hideContextMenu(props.sidebarState), contextMenu.id, cat.id)
                );
              }}
            >
              ${cat.icon || commIcon("folder", 14)} ${cat.name}
            </button>
          `)}
          <button 
            class="context-menu-item g-btn g-btn--ghost"
            @click=${() => {
              props.onSidebarStateChange(
                removeItemFromCategory(hideContextMenu(props.sidebarState), contextMenu.id)
              );
            }}
          >
            ${commIcon("list", 14)} Uncategorized
          </button>
        </div>
      ` : nothing}
      
      <div class="context-menu-separator"></div>
      
      <button 
        class="context-menu-item danger g-btn g-btn--danger"
        @click=${() => {
          if (isCategory) {
            if (confirm('Delete this category? Items will be moved to uncategorized.')) {
              props.onSidebarStateChange(
                deleteCategory(hideContextMenu(props.sidebarState), contextMenu.id)
              );
            }
          } else {
            if (confirm('Delete this thread?')) {
              props.onDeleteSession(contextMenu.id);
              props.onSidebarStateChange(hideContextMenu(props.sidebarState));
            }
          }
        }}
      >
        ${commIcon("trash", 14)} Delete
      </button>
    </div>
  `;
}

function renderNewCategoryButton(props: EnhancedThreadsSidebarProps) {
  return html`
    <button 
      class="sidebar-add-category g-btn"
      @click=${() => {
        const name = prompt('Category name:');
        if (name?.trim()) {
          props.onSidebarStateChange(createCategory(props.sidebarState, name.trim()));
        }
      }}
    >
      ${icons.plus} Add Category
    </button>
  `;
}

// ============================================================
// Main Render
// ============================================================

export function renderEnhancedThreadsSidebar(props: EnhancedThreadsSidebarProps) {
  ensureCommunicationGlassStyles();
  if (!props.visible) {
    // Reset drag-drop when hidden
    if (dragDropInitialized) {
      getDragDropController().destroy();
      dragDropInitialized = false;
      sidebarContainerRef = null;
      listContainerRef = null;
    }
    return nothing;
  }
  
  // Store props for drag-drop callbacks
  currentProps = props;
  
  const allSessions = props.sessions?.sessions || [];
  
  // Filter to only webchat/mobile sessions
  const filteredSessions = allSessions.filter(s => isWebchatSession(s.key));
  
  // Create session map for quick lookup
  const sessionMap = new Map(filteredSessions.map(s => [s.key, s]));
  
  // Sort categories by position
  const sortedCategories = [...props.sidebarState.categories].sort((a, b) => a.position - b.position);
  
  // Initialize drag-drop after render
  const handleSidebarRef = (el: Element | undefined) => {
    if (el && el instanceof HTMLElement) {
      sidebarContainerRef = el;
      const listEl = el.querySelector('.threads-sidebar__list');
      if (listEl instanceof HTMLElement) {
        listContainerRef = listEl;
        initDragDrop(el, listEl, props);
      }
    }
  };
  
  return html`
    <div class="threads-sidebar-overlay" @click=${props.onClose}></div>
    <aside class="threads-sidebar enhanced g-float" ${ref(handleSidebarRef as any)}>
      <header class="threads-sidebar__header">
        <h3 class="g-title">${commIcon("chat", 18)} Threads</h3>
        <div class="threads-sidebar__actions">
          <button 
            class="threads-sidebar__btn g-btn g-btn--icon"
            @click=${props.onRefresh}
            title="Refresh"
          >
            ${icons.refresh}
          </button>
          <button 
            class="threads-sidebar__btn threads-sidebar__btn--primary g-btn g-btn--primary g-btn--icon"
            @click=${props.onNewSession}
            title="New Thread"
          >
            ${icons.plus}
          </button>
          <button 
            class="threads-sidebar__btn g-btn g-btn--icon"
            @click=${props.onClose}
            title="Close"
          >
            ${icons.x}
          </button>
        </div>
      </header>
      
      <div class="threads-sidebar__list">
        ${sortedCategories.map((category, index) => 
          renderCategory(props, category, sessionMap, index)
        )}
        
        ${renderUncategorized(props, sessionMap)}
        
        ${renderNewCategoryButton(props)}
      </div>
      
      <footer class="threads-sidebar__footer">
        <span class="threads-sidebar__count">
          ${filteredSessions.length} thread${filteredSessions.length !== 1 ? 's' : ''} • 
          ${props.sidebarState.categories.length} categories
        </span>
        <span class="threads-sidebar__hint">
          Drag to organize • Double-click to rename • Right-click for options
        </span>
      </footer>
    </aside>
    
    ${renderContextMenu(props)}
  `;
}

// ============================================================
// Initialize Sidebar State
// ============================================================

export function initializeSidebarState(sessions: SessionsListResult | null): SidebarState {
  const baseState = loadSidebarState();
  if (sessions) {
    return syncWithSessions(baseState, sessions.sessions);
  }
  return baseState;
}
