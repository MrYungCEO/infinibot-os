/**
 * Enhanced Navigation Sidebar - Discord-style with drag-drop, categories, and editing
 */

import { html, nothing } from "lit";
import type { Tab } from "../navigation";
import type { GatewayBrowserClient } from "../gateway";
import { iconForTab, titleForTab, pathForTab, groupLabel, hostForTab, navLabelForTab, navSearchTargetForEntry, navSearchTermsForTab, navTargetForEntry } from "../navigation";
import { t } from "../i18n";
import { icons } from "../icons";
import { renderSidebarBottomStrip } from "./sidebar-bottom-strip.js";
import {
  isPluginGatedTab,
  isTabAvailable,
  pluginNavSections,
  pluginSectionOfTab,
  PLUGIN_HOST_EVENT,
  type PluginNavSection,
} from "../plugin-host.js";
import {
  hideNavPluginFlyout,
  isNavPluginFlyoutOpen,
  scheduleHideNavPluginFlyout,
  showNavPluginFlyout,
} from "../controllers/nav-plugin-flyout.js";
import "../../styles/nav-plugin-sections.css";
import "../../styles/nav-sidebar-favorites.css";
import "../../styles/nav-setup-glow.css";
import { markGateUnpassed, setGateEnabled } from "../profiles.js";
import { isCloudBuild } from "../cloud/cloud-env.js";
import {
  getNavSearchQuery,
  setNavSearchQuery,
  clearNavSearchQuery,
  isNavSearching,
  tabMatchesSearch,
} from "../controllers/nav-ui-state.js";
import { initNavBadges, getNavBadge } from "../controllers/nav-badges.js";
import { initNavSetupStatus, navSetupCountFor, navSetupFor, setupHint } from "../controllers/nav-setup-status.js";
import { showNavFlyout, hideNavFlyout } from "../controllers/nav-collapsed-flyout.js";
import { openLaunchpad } from "./launchpad.js";
import type {
  NavSidebarState,
  NavCategory,
  NavDropTarget,
} from "../controllers/nav-sidebar";
import {
  loadNavSidebarState,
  isCustomCategory,
  createNavCategory,
  deleteNavCategory,
  toggleNavCategoryCollapsed,
  hideTab,
  unhideTab,
  startNavDrag,
  updateNavDropTarget,
  endNavDrag,
  cancelNavDrag,
  startNavEdit,
  startNavTabEdit,
  updateNavEditValue,
  finishNavEdit,
  cancelNavEdit,
  showNavContextMenu,
  hideNavContextMenu,
  resetNavSidebarToDefaultsWithBackup,
  getNavTabDisplayName,
  clearNavTabCustomName,
  forceNavSidebarSync,
  isPluginSectionCollapsed,
  isPluginSectionHidden,
  setPluginSectionHidden,
  togglePluginSectionCollapsed,
  isFavorite,
  moveFavorite,
  moveSection,
  moveSectionBefore,
  moveTabToSection,
  nestSection,
  orderedSectionIds,
  pluginSectionId,
  reorderFavorite,
  sectionParent,
  toggleFavorite,
  toggleFavoritesCollapsed,
  unnestSection,
  visibleFavorites,
} from "../controllers/nav-sidebar";

export interface EnhancedNavSidebarProps {
  currentTab: Tab;
  basePath: string;
  collapsed: boolean;
  navState: NavSidebarState;
  onNavStateChange: (state: NavSidebarState) => void;
  onTabSelect: (tab: Tab) => void;
  /**
   * When provided, only tabs for which this returns true are rendered —
   * used by the multi-user system to hide pages outside the logged-in
   * user's `allowedPages` allowlist. Admins bypass this entirely by
   * passing a function that always returns true (or by leaving the
   * prop unset).
   */
  isPageAllowed?: (tab: Tab) => boolean;
  /** Gateway client — passed through to the update widget. */
  client?: GatewayBrowserClient | null;
  /** Lit's requestUpdate hook so the update widget can re-render itself. */
  requestUpdate?: () => void;
}

// ============================================================
// Footer collapse persistence
//
// The footer (settings / profile / system area) defaults to collapsed
// for a fresh user so the main nav gets more vertical space. The user's
// manual expand/collapse choice persists across reloads in localStorage.
// ============================================================

const FOOTER_COLLAPSE_KEY = "infinibot-nav-footer-collapsed";

function isNavFooterCollapsed(): boolean {
  try {
    const v = localStorage.getItem(FOOTER_COLLAPSE_KEY);
    // No stored choice yet → fresh user → start collapsed.
    return v === null ? true : v === "1";
  } catch {
    return true;
  }
}

function setNavFooterCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(FOOTER_COLLAPSE_KEY, collapsed ? "1" : "0");
  } catch {
    /* localStorage unavailable (private mode) — non-fatal */
  }
}

// ============================================================
// Drag & Drop Handlers
// ============================================================

function createTabDragHandlers(
  props: EnhancedNavSidebarProps,
  tab: Tab,
  sourceIndex: number,
  sourceCategoryId: string
) {
  return {
    onDragStart: (e: DragEvent) => {
      e.dataTransfer!.effectAllowed = 'move';
      e.dataTransfer!.setData('text/plain', JSON.stringify({ type: 'tab', id: tab }));
      
      setTimeout(() => {
        (e.target as HTMLElement).classList.add('dragging');
      }, 0);
      
      props.onNavStateChange(
        startNavDrag(props.navState, 'tab', tab, sourceIndex, sourceCategoryId)
      );
    },
    onDragEnd: (e: DragEvent) => {
      (e.target as HTMLElement).classList.remove('dragging');
      props.onNavStateChange(endNavDrag(props.navState));
    },
  };
}

function createCategoryDragHandlers(
  props: EnhancedNavSidebarProps,
  sectionId: string,
) {
  return {
    onDragStart: (e: DragEvent) => {
      e.dataTransfer!.effectAllowed = 'move';
      e.dataTransfer!.setData('text/plain', JSON.stringify({ type: 'section', id: sectionId }));
      
      setTimeout(() => {
        (e.target as HTMLElement).classList.add('dragging');
      }, 0);
      
      props.onNavStateChange(
        startNavDrag(props.navState, 'category', sectionId, 0, sectionId)
      );
    },
    onDragEnd: (e: DragEvent) => {
      (e.target as HTMLElement).classList.remove('dragging');
      if (props.navState.dragState?.type === "category") {
        props.onNavStateChange(cancelNavDrag(props.navState));
      }
    },
  };
}

function createSectionDropHandlers(
  props: EnhancedNavSidebarProps,
  targetSectionId: string,
  availableIds: readonly string[],
) {
  return {
    onDragOver: (e: DragEvent) => {
      if (props.navState.dragState?.type !== "category") return;
      e.preventDefault();
      e.dataTransfer!.dropEffect = "move";
      (e.currentTarget as HTMLElement).classList.add("drag-over");
    },
    onDragLeave: (e: DragEvent) => (e.currentTarget as HTMLElement).classList.remove("drag-over"),
    onDrop: (e: DragEvent) => {
      if (props.navState.dragState?.type !== "category") return;
      e.preventDefault();
      (e.currentTarget as HTMLElement).classList.remove("drag-over");
      const dragged = props.navState.dragState.id;
      props.onNavStateChange(
        moveSectionBefore(cancelNavDrag(props.navState), dragged, targetSectionId, availableIds),
      );
    },
  };
}

function createDropHandlers(
  props: EnhancedNavSidebarProps,
  dropTarget: NavDropTarget
) {
  return {
    onDragOver: (e: DragEvent) => {
      e.preventDefault();
      e.dataTransfer!.dropEffect = 'move';
      
      const el = e.currentTarget as HTMLElement;
      el.classList.add('drag-over');
      
      props.onNavStateChange(
        updateNavDropTarget(props.navState, dropTarget)
      );
    },
    onDragLeave: (e: DragEvent) => {
      const el = e.currentTarget as HTMLElement;
      el.classList.remove('drag-over');
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      const el = e.currentTarget as HTMLElement;
      el.classList.remove('drag-over');
      
      props.onNavStateChange(endNavDrag(props.navState));
    },
  };
}

// ============================================================
// Render Functions
// ============================================================

let contextMenuReturnFocus: HTMLElement | null = null;

function openNavContextMenu(
  props: EnhancedNavSidebarProps,
  type: "tab" | "category" | "plugin-section",
  id: string,
  e: MouseEvent,
): void {
  e.preventDefault();
  contextMenuReturnFocus = e.currentTarget as HTMLElement;
  props.onNavStateChange(showNavContextMenu(props.navState, type, id, e.clientX, e.clientY));
}

function closeNavContextMenu(props: EnhancedNavSidebarProps): NavSidebarState {
  const next = hideNavContextMenu(props.navState);
  requestAnimationFrame(() => contextMenuReturnFocus?.focus());
  return next;
}

function openNavContextMenuFromKeyboard(
  props: EnhancedNavSidebarProps,
  type: "tab" | "category" | "plugin-section",
  id: string,
  e: KeyboardEvent,
): void {
  if (e.key !== "ContextMenu" && !(e.shiftKey && e.key === "F10")) return;
  e.preventDefault();
  e.stopPropagation();
  const target = e.currentTarget as HTMLElement;
  const rect = target.getBoundingClientRect();
  contextMenuReturnFocus = target;
  props.onNavStateChange(showNavContextMenu(props.navState, type, id, rect.left + 12, rect.bottom));
}

/** Group-header chip: how many pages in the group still need setup. */
function renderSetupCount(count: number) {
  if (count <= 0) return nothing;
  const label = `${count} ${count === 1 ? "page needs" : "pages need"} setup`;
  return html`<span class="nav-setup-count" title=${label} aria-label=${label}
    ><span class="nav-setup-count__dot" aria-hidden="true"></span>${count}</span
  >`;
}

function renderCategoryHeader(
  props: EnhancedNavSidebarProps,
  category: NavCategory,
  availableIds: readonly string[],
  setupCount = 0,
) {
  const isEditing = props.navState.editState?.id === category.id;
  const isDragging = props.navState.dragState?.type === 'category' 
    && props.navState.dragState?.id === category.id;
  
  const dragHandlers = createCategoryDragHandlers(props, category.id);
  const dropHandlers = createSectionDropHandlers(props, category.id, availableIds);
  
  return html`
    <div 
      class="nav-category-header ${isDragging ? 'dragging' : ''}"
      tabindex="0"
      aria-haspopup="menu"
      aria-label=${`${groupLabel(category.label)} section actions`}
      draggable="true"
      @dragstart=${dragHandlers.onDragStart}
      @dragend=${dragHandlers.onDragEnd}
      @dragover=${dropHandlers.onDragOver}
      @dragleave=${dropHandlers.onDragLeave}
      @drop=${dropHandlers.onDrop}
      @contextmenu=${(e: MouseEvent) => {
        openNavContextMenu(props, "category", category.id, e);
      }}
      @keydown=${(e: KeyboardEvent) => openNavContextMenuFromKeyboard(props, "category", category.id, e)}
    >
      <button 
        class="nav-category-toggle"
        type="button"
        aria-expanded=${String(!category.collapsed)}
        aria-label=${`${category.collapsed ? "Expand" : "Collapse"} ${groupLabel(category.label)}`}
        @click=${() => props.onNavStateChange(toggleNavCategoryCollapsed(props.navState, category.id))}
      >
        ${category.collapsed ? icons.chevronRight : icons.chevronDown}
      </button>
      
      ${isEditing ? html`
        <input
          type="text"
          class="nav-edit-input"
          .value=${props.navState.editState!.value}
          @input=${(e: InputEvent) => props.onNavStateChange(
            updateNavEditValue(props.navState, (e.target as HTMLInputElement).value)
          )}
          @blur=${() => props.onNavStateChange(finishNavEdit(props.navState))}
          @keydown=${(e: KeyboardEvent) => {
            if (e.key === 'Enter') {
              props.onNavStateChange(finishNavEdit(props.navState));
            } else if (e.key === 'Escape') {
              props.onNavStateChange(cancelNavEdit(props.navState));
            }
          }}
          @click=${(e: Event) => e.stopPropagation()}
          autofocus
        />
      ` : html`
        <span 
          class="nav-category-label"
          @dblclick=${() => props.onNavStateChange(
            startNavEdit(props.navState, category.id, category.label)
          )}
        >
          ${groupLabel(category.label)}
        </span>
      `}
      
      ${renderSetupCount(setupCount)}
      <span class="nav-category-count">${category.tabs.filter((t) => isTabAvailable(t)).length}</span>
    </div>
  `;
}

/** Icon for a sidebar entry: the plugin-declared icon when it names a known one. */
function navIconFor(tab: Tab, declared?: string) {
  const own = declared ? (icons as Record<string, unknown>)[declared] : undefined;
  return own ?? icons[iconForTab(tab)];
}

function renderNavTab(
  props: EnhancedNavSidebarProps,
  tab: Tab,
  index: number,
  categoryId: string,
  groupName: string,
  options?: {
    icon?: string;
    pluginItem?: boolean;
    favoriteItem?: boolean;
  },
) {
  // A retired tab (e.g. /decisions) lights up the sidebar entry that hosts it.
  const isFavoriteItem = options?.favoriteItem === true;
  // Favorites duplicate a page elsewhere in the tree. The pinned copy owns
  // the active state so the single-active-pill invariant remains true.
  const favoriteOwnsActive =
    isFavorite(props.navState, tab) &&
    !props.navState.favoritesCollapsed &&
    !props.navState.hiddenTabs.includes(tab) &&
    isTabAvailable(tab);
  const isActive = tab === hostForTab(props.currentTab) && (isFavoriteItem || !favoriteOwnsActive);
  const badge = getNavBadge(tab);
  const badgeLabel = badge > 99 ? "99+" : String(badge);
  // "Needs setup" glow (controllers/nav-setup-status.ts); null when nothing's
  // outstanding or the Appearance toggle is off.
  const setup = navSetupFor(tab);
  const setupText = setup ? setupHint(setup) : "";
  const setupDescId = setup ? `nav-setup-desc-${categoryId}-${tab}` : "";
  const isDragging = props.navState.dragState?.type === 'tab' 
    && props.navState.dragState?.id === tab;
  const isEditing = props.navState.editState?.type === 'tab' 
    && props.navState.editState?.id === tab;
  
  const displayName = getNavTabDisplayName(props.navState, tab, navLabelForTab(tab));
  // Normally the entry itself; for an allowlisted user it may be a page the
  // entry hosts (see navTargetForEntry).
  // While searching (⌘K), a query naming a page this entry hosts ("debug" on
  // Logs) opens that page / sub-tab instead of the entry's default view.
  const target =
    (isNavSearching() ? navSearchTargetForEntry(tab, getNavSearchQuery(), props.isPageAllowed) : null) ??
    navTargetForEntry(tab, props.isPageAllowed) ??
    tab;
  const href = pathForTab(target, props.basePath);
  const dragHandlers = createTabDragHandlers(props, tab, index, categoryId);
  const dropHandlers = createDropHandlers(props, { 
    type: 'tab-gap', 
    categoryId, 
    position: index 
  });
  
  // Double-click handler for inline rename
  const handleDoubleClick = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    props.onNavStateChange(startNavTabEdit(props.navState, tab, displayName));
  };
  
  // Delete/hide handler with confirmation
  const handleDelete = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (confirm(`Hide "${displayName}" from the sidebar?\n\nYou can restore it from the "Hidden Tabs" section at the bottom.`)) {
      props.onNavStateChange(hideTab(props.navState, tab));
    }
  };

  const plugin = pluginSectionOfTab(tab);
  const favoritePluginStyle = plugin ? pluginAccentStyle(plugin) : "";
  const handleFavorite = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    props.onNavStateChange(toggleFavorite(props.navState, tab));
  };
  const favoriteDrag = isFavoriteItem
    ? {
        onDragStart: (e: DragEvent) => {
          e.dataTransfer!.effectAllowed = "move";
          e.dataTransfer!.setData("text/plain", JSON.stringify({ type: "favorite", id: tab }));
          props.onNavStateChange(startNavDrag(props.navState, "tab", tab, index, "favorites"));
        },
        onDragEnd: () => props.onNavStateChange(cancelNavDrag(props.navState)),
      }
    : null;
  
  return html`
    <div 
      class="nav-tab-wrapper ${isDragging ? 'dragging' : ''}"
      @dragover=${dropHandlers.onDragOver}
      @dragleave=${dropHandlers.onDragLeave}
      @drop=${dropHandlers.onDrop}
    >
      ${isEditing ? html`
        <div class="nav-item nav-item--editing">
          <span class="nav-item__icon" aria-hidden="true">${navIconFor(tab, options?.icon)}</span>
          <input
            type="text"
            class="nav-edit-input nav-tab-edit-input"
            .value=${props.navState.editState!.value}
            @input=${(e: InputEvent) => props.onNavStateChange(
              updateNavEditValue(props.navState, (e.target as HTMLInputElement).value)
            )}
            @blur=${() => props.onNavStateChange(finishNavEdit(props.navState))}
            @keydown=${(e: KeyboardEvent) => {
              if (e.key === 'Enter') {
                props.onNavStateChange(finishNavEdit(props.navState));
              } else if (e.key === 'Escape') {
                props.onNavStateChange(cancelNavEdit(props.navState));
              }
            }}
            @click=${(e: Event) => e.stopPropagation()}
            autofocus
          />
        </div>
      ` : html`
        <a
          href=${href}
          data-tab-pill=${tab}
          class="nav-item ${isActive ? 'active' : ''} ${isFavoriteItem ? "nav-item--favorite" : ""} ${plugin && isFavoriteItem ? "nav-item--favorite-plugin" : ""} ${setup ? `nav-item--setup nav-item--setup-${setup.state}` : ""}"
          aria-current=${isActive ? "page" : nothing}
          aria-describedby=${setup ? setupDescId : nothing}
          data-setup-state=${setup ? setup.state : nothing}
          style=${plugin && isFavoriteItem ? favoritePluginStyle : nothing}
          draggable=${options?.pluginItem && !isFavoriteItem ? "false" : "true"}
          @dragstart=${favoriteDrag?.onDragStart ?? (options?.pluginItem ? nothing : dragHandlers.onDragStart)}
          @dragend=${favoriteDrag?.onDragEnd ?? (options?.pluginItem ? nothing : dragHandlers.onDragEnd)}
          @dragover=${isFavoriteItem ? (e: DragEvent) => {
            if (props.navState.dragState?.sourceCategoryId !== "favorites") return;
            e.preventDefault();
            (e.currentTarget as HTMLElement).classList.add("drag-over");
          } : nothing}
          @dragleave=${isFavoriteItem ? (e: DragEvent) => (e.currentTarget as HTMLElement).classList.remove("drag-over") : nothing}
          @drop=${isFavoriteItem ? (e: DragEvent) => {
            if (props.navState.dragState?.sourceCategoryId !== "favorites") return;
            e.preventDefault();
            (e.currentTarget as HTMLElement).classList.remove("drag-over");
            props.onNavStateChange(reorderFavorite(cancelNavDrag(props.navState), props.navState.dragState.id as Tab, index));
          } : nothing}
          @click=${(e: MouseEvent) => {
            if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
              return;
            }
            e.preventDefault();
            props.onTabSelect(target);
          }}
          @dblclick=${handleDoubleClick}
          @contextmenu=${(e: MouseEvent) => {
            openNavContextMenu(props, "tab", tab, e);
          }}
          @keydown=${(e: KeyboardEvent) => openNavContextMenuFromKeyboard(props, "tab", tab, e)}
          @mouseenter=${(e: MouseEvent) => {
            // Collapsed icon-rail flyout: full label + group context. Mounted on
            // <body> to escape the sidebar scroll-clip / backdrop containing block.
            // Expanded rows only pop it to explain a setup glow.
            if (!props.collapsed && !setup) return;
            showNavFlyout(e.currentTarget as HTMLElement, {
              group: groupName,
              label: displayName,
              badge,
              setup: setup ? { state: setup.state, text: setupText, action: setup.primary.action?.label } : undefined,
            });
          }}
          @mouseleave=${() => {
            if (props.collapsed || setup) hideNavFlyout();
          }}
          @focus=${(e: FocusEvent) => {
            if (!setup) return;
            showNavFlyout(e.currentTarget as HTMLElement, {
              group: groupName,
              label: displayName,
              badge,
              setup: { state: setup.state, text: setupText, action: setup.primary.action?.label },
            });
          }}
          @blur=${() => {
            if (setup) hideNavFlyout();
          }}
          title=${setup ? `${displayName} — ${setupText}` : displayName}
        >
          ${setup ? html`<span class="nav-item__setup-ring" aria-hidden="true"></span>` : nothing}
          ${options?.pluginItem && !isFavoriteItem ? nothing : html`<span class="nav-item__drag-handle">${icons.move}</span>`}
          ${plugin && isFavoriteItem ? html`<span class="nav-favorite-plugin-mark" aria-label=${`${plugin.title} plugin`}>${plugin.monogram}</span>` : nothing}
          <span class="nav-item__icon" aria-hidden="true">
            ${navIconFor(tab, options?.icon)}
            ${badge > 0
              ? html`<span class="nav-item__dot" aria-hidden="true"></span>`
              : nothing}
            ${setup ? html`<span class="nav-item__setup-dot" aria-hidden="true"></span>` : nothing}
          </span>
          <span class="nav-item__text">${displayName}</span>
          ${badge > 0
            ? html`<span
                class="nav-item__badge"
                title="${badgeLabel} active"
                aria-label="${badgeLabel} active"
                >${badgeLabel}</span
              >`
            : nothing}
          <button
            class="nav-item__favorite ${isFavorite(props.navState, tab) ? "is-favorite" : ""}"
            type="button"
            @click=${handleFavorite}
            title=${isFavorite(props.navState, tab) ? "Remove from favorites" : "Add to favorites"}
            aria-label=${isFavorite(props.navState, tab) ? `Remove ${displayName} from favorites` : `Add ${displayName} to favorites`}
            aria-pressed=${String(isFavorite(props.navState, tab))}
          >${icons.star}</button>
          <button
            class="nav-item__delete"
            @click=${handleDelete}
            title="Hide tab"
            aria-label="Hide ${displayName}"
          >×</button>
        </a>
        ${setup ? html`<span id=${setupDescId} class="nav-sr-only">${setupText}</span>` : nothing}
      `}
    </div>
  `;
}

function renderCategory(
  props: EnhancedNavSidebarProps,
  category: NavCategory,
  availableIds: readonly string[],
  nested = false,
) {
  // Apply the page-allowlist filter from the multi-user system. When no
  // predicate is supplied (admin or legacy single-tenant mode) every tab
  // passes through.
  // Plugin pages live only in their plugin's own section (below), never in a
  // core/custom category — so a stale saved layout can't list one twice.
  const movedHere = Object.entries(props.navState.tabSectionOverrides)
    .filter(([, sectionId]) => sectionId === category.id)
    .map(([tab]) => tab as Tab);
  const categoryTabs = [...new Set([...category.tabs, ...movedHere])].filter(
    (tab) => isTabAvailable(tab) &&
      (!props.navState.tabSectionOverrides[tab] || props.navState.tabSectionOverrides[tab] === category.id),
  );
  const allowedTabs = props.isPageAllowed
    ? categoryTabs.filter((t) => navTargetForEntry(t, props.isPageAllowed) !== null)
    : categoryTabs;
  // If this category has no tabs the user is allowed to see, drop the
  // whole category instead of leaving an empty drop zone visible. A
  // user-created category that is simply still empty is kept, so a category
  // the user just made doesn't vanish before they can drag tabs into it.
  if (
    allowedTabs.length === 0 &&
    props.isPageAllowed &&
    !(category.tabs.length === 0 && isCustomCategory(category))
  ) {
    return nothing;
  }

  const groupName = groupLabel(category.label);

  // Search filter — when the user is typing in the tab search box, narrow the
  // visible tabs to matches. A category with zero matches is dropped entirely
  // so the result reads as a clean filtered list rather than a tree of empty
  // groups.
  const searching = isNavSearching();
  const visibleTabs = searching
    ? allowedTabs.filter((tab) =>
        tabMatchesSearch(
          tab,
          getNavTabDisplayName(props.navState, tab, navLabelForTab(tab)),
          navSearchTermsForTab(tab),
        ),
      )
    : allowedTabs;
  if (searching && visibleTabs.length === 0) return nothing;

  const hasActiveTab = visibleTabs.some(tab => tab === hostForTab(props.currentTab));
  // While searching, always expand matching groups so results are visible
  // regardless of the saved collapsed state.
  const showItems = searching || !category.collapsed || hasActiveTab;

  const categoryDropHandlers = createDropHandlers(props, { type: 'category', categoryId: category.id });

  return html`
    <div class="nav-group ${nested ? "nav-group--nested" : ""} ${!searching && category.collapsed && !hasActiveTab ? 'nav-group--collapsed' : ''}" data-section-id=${category.id}>
      ${renderCategoryHeader(props, category, availableIds, navSetupCountFor(allowedTabs))}

      ${showItems ? html`
        <div
          class="nav-group__items"
          @dragover=${categoryDropHandlers.onDragOver}
          @dragleave=${categoryDropHandlers.onDragLeave}
          @drop=${categoryDropHandlers.onDrop}
        >
          ${visibleTabs.length === 0 ? html`
            <div class="nav-category-empty">
              Drop tabs here
            </div>
          ` : visibleTabs.map((tab, tabIndex) =>
            renderNavTab(props, tab, tabIndex, category.id, groupName)
          )}
        </div>
      ` : nothing}
    </div>
  `;
}

function renderHiddenTabs(props: EnhancedNavSidebarProps) {
  // A disabled plugin shows nothing — not even its hidden pages.
  const hiddenTabs = props.navState.hiddenTabs.filter((tab) => isTabAvailable(tab));
  const hiddenSections = pluginNavSections().filter((s) => isPluginSectionHidden(props.navState, s.pluginId));
  const count = hiddenTabs.length + hiddenSections.length;
  if (count === 0) return nothing;
  
  return html`
    <div class="nav-group nav-group--hidden">
      <div class="nav-category-header hidden">
        <span class="nav-category-label">${t("nav.hiddenTabs", undefined, "Hidden Tabs")}</span>
        <span class="nav-category-count">${count}</span>
      </div>
      <div class="nav-group__items">
        ${hiddenSections.map((section) => html`
          <div class="nav-hidden-tab" data-hidden-plugin-section=${section.pluginId}>
            <span class="nav-item__icon"><span class="nav-plugin-mark nav-plugin-mark--sm" style=${pluginAccentStyle(section)}>${section.monogram}</span></span>
            <span class="nav-item__text">${section.title} section</span>
            <button
              class="nav-unhide-btn"
              @click=${() => props.onNavStateChange(setPluginSectionHidden(props.navState, section.pluginId, false))}
              title="Show section"
              aria-label="Show the ${section.title} section"
            >
              ${icons.plus}
            </button>
          </div>
        `)}
        ${hiddenTabs.map(tab => html`
          <div class="nav-hidden-tab">
            <span class="nav-item__icon">${icons[iconForTab(tab)]}</span>
            <span class="nav-item__text">${navLabelForTab(tab)}</span>
            <button 
              class="nav-unhide-btn"
              @click=${() => props.onNavStateChange(unhideTab(props.navState, tab))}
              title="Show tab"
            >
              ${icons.plus}
            </button>
          </div>
        `)}
      </div>
    </div>
  `;
}

function renderContextMenu(props: EnhancedNavSidebarProps) {
  const { contextMenu } = props.navState;
  if (!contextMenu) return nothing;

  const isCategory = contextMenu.type === 'category';
  const isTab = contextMenu.type === 'tab';
  const pluginSection =
    contextMenu.type === 'plugin-section'
      ? pluginNavSections().find((s) => s.pluginId === contextMenu.id)
      : undefined;
  const section = isCategory ? props.navState.categories.find((category) => category.id === contextMenu.id) : pluginSection;
  const sectionId = isCategory ? contextMenu.id : pluginSection ? pluginSectionId(pluginSection.pluginId) : null;
  const available = availableSidebarSections(props);
  const availableIds = available.map((item) => item.id);
  const parent = sectionId ? sectionParent(props.navState, sectionId, availableIds) : null;
  const sectionName = (id: string) => {
    const candidate = available.find((item) => item.id === id);
    return candidate?.kind === "category" ? groupLabel(candidate.category.label) : candidate?.plugin.title ?? id;
  };
  const tab = isTab ? contextMenu.id as Tab : null;
  const favoriteIndex = tab ? props.navState.favorites.indexOf(tab) : -1;
  const closed = () => closeNavContextMenu(props);
  const x = Math.max(8, Math.min(contextMenu.x, (globalThis.innerWidth || 1200) - 310));
  const y = Math.max(8, Math.min(contextMenu.y, (globalThis.innerHeight || 800) - 560));

  requestAnimationFrame(() => {
    const menu = document.querySelector<HTMLElement>("[data-nav-context-menu]");
    if (!menu || menu.dataset.focused) return;
    menu.dataset.focused = "1";
    menu.querySelector<HTMLButtonElement>("[role=menuitem]:not(:disabled)")?.focus();
  });
  const menuKeydown = (e: KeyboardEvent) => {
    const items = [...(e.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>("[role=menuitem]:not(:disabled)")];
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    let next = current;
    if (e.key === "ArrowDown") next = Math.min(items.length - 1, current + 1);
    else if (e.key === "ArrowUp") next = Math.max(0, current - 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = items.length - 1;
    else if (e.key === "Escape") { e.preventDefault(); props.onNavStateChange(closed()); return; }
    else return;
    e.preventDefault();
    items[next]?.focus();
  };

  return html`
    <div 
      class="nav-context-menu-overlay"
      @click=${() => props.onNavStateChange(closed())}
    ></div>
    <div 
      class="nav-context-menu"
      data-nav-context-menu
      role="menu"
      aria-label=${isTab ? "Page actions" : "Section actions"}
      style="left: ${x}px; top: ${y}px;"
      @keydown=${menuKeydown}
    >
      ${section && sectionId ? html`
        <button class="context-menu-item" role="menuitem" @click=${() => {
          const base = closed();
          props.onNavStateChange(isCategory
            ? toggleNavCategoryCollapsed(base, sectionId)
            : togglePluginSectionCollapsed(base, pluginSection!.pluginId, pluginSection!.collapsedByDefault));
        }}>
          ${icons.chevronRight}
          ${isCategory
            ? (section as NavCategory).collapsed ? "Expand section" : "Collapse section"
            : isPluginSectionCollapsed(props.navState, pluginSection!.pluginId, pluginSection!.collapsedByDefault) ? "Expand section" : "Collapse section"}
        </button>
        <div class="context-menu-separator"></div>
        <button class="context-menu-item" role="menuitem" @click=${() => props.onNavStateChange(moveSection(closed(), sectionId, "up", availableIds))}>${icons.arrowUp} Move section up</button>
        <button class="context-menu-item" role="menuitem" @click=${() => props.onNavStateChange(moveSection(closed(), sectionId, "down", availableIds))}>${icons.arrowDown} Move section down</button>
        <button class="context-menu-item" role="menuitem" @click=${() => props.onNavStateChange(moveSection(closed(), sectionId, "top", availableIds))}>${icons.chevronUp} Move to top</button>
        <button class="context-menu-item" role="menuitem" @click=${() => props.onNavStateChange(moveSection(closed(), sectionId, "bottom", availableIds))}>${icons.chevronDown} Move to bottom</button>
        <div class="context-menu-submenu" role="group" aria-label="Move into section">
          <span class="context-menu-label">Move into…</span>
          ${available.filter((candidate) => candidate.id !== sectionId && !sectionParent(props.navState, candidate.id, availableIds)).map((candidate) => html`
            <button class="context-menu-item" role="menuitem" @click=${() => props.onNavStateChange(nestSection(closed(), sectionId, candidate.id, availableIds))}>${icons.folder} ${sectionName(candidate.id)}</button>
          `)}
        </div>
        ${parent ? html`<button class="context-menu-item" role="menuitem" @click=${() => props.onNavStateChange(unnestSection(closed(), sectionId))}>${icons.chevronRight} Move out of ${sectionName(parent)}</button>` : nothing}
        <div class="context-menu-separator"></div>
        ${pluginSection ? html`
          <button class="context-menu-item" role="menuitem" @click=${() => { props.onNavStateChange(closed()); props.onTabSelect("plugins"); }}>${icons.puzzle} Manage plugin…</button>
          <button class="context-menu-item" role="menuitem" @click=${() => props.onNavStateChange(setPluginSectionHidden(closed(), pluginSection.pluginId, true))}>${icons.eye} Hide section</button>
        ` : nothing}
        ${isCategory ? html`
          <button class="context-menu-item" role="menuitem" @click=${() => props.onNavStateChange(startNavEdit(closed(), sectionId, (section as NavCategory).label))}>${icons.penLine} Rename category</button>
          ${isCustomCategory(section as NavCategory) ? html`<button class="context-menu-item danger" role="menuitem" @click=${() => {
            if (confirm("Delete this category? Pages will be moved to the first category.")) props.onNavStateChange(deleteNavCategory(closed(), sectionId));
          }}>${icons.trash} Delete category</button>` : nothing}
        ` : nothing}
        <div class="context-menu-separator"></div>
        <button class="context-menu-item" role="menuitem" @click=${async () => {
          if (!confirm("Reset sidebar layout? Your current layout will be backed up before reset.")) return;
          props.onNavStateChange(closed());
          try { props.onNavStateChange(await resetNavSidebarToDefaultsWithBackup()); }
          catch (error) { alert(`Sidebar reset failed; your current layout was kept.\n\n${String(error)}`); }
        }}>${icons.refresh} Reset sidebar layout</button>
      ` : nothing}
      
      ${tab ? html`
        <button class="context-menu-item" role="menuitem" @click=${() => props.onNavStateChange(toggleFavorite(closed(), tab))}>${icons.star} ${isFavorite(props.navState, tab) ? "Remove from favorites" : "Add to favorites"}</button>
        ${favoriteIndex >= 0 ? html`
          <button class="context-menu-item" role="menuitem" ?disabled=${favoriteIndex === 0} @click=${() => props.onNavStateChange(moveFavorite(closed(), tab, -1))}>${icons.arrowUp} Move up in favorites</button>
          <button class="context-menu-item" role="menuitem" ?disabled=${favoriteIndex === props.navState.favorites.length - 1} @click=${() => props.onNavStateChange(moveFavorite(closed(), tab, 1))}>${icons.arrowDown} Move down in favorites</button>
        ` : nothing}
        <div class="context-menu-separator"></div>
        <button class="context-menu-item" role="menuitem" @click=${() => props.onNavStateChange(startNavTabEdit(closed(), tab, getNavTabDisplayName(props.navState, tab, navLabelForTab(tab))))}>${icons.penLine} Rename</button>
        ${props.navState.tabCustomNames[tab] ? html`<button class="context-menu-item" role="menuitem" @click=${() => props.onNavStateChange(clearNavTabCustomName(closed(), tab))}>${icons.refresh} Reset name</button>` : nothing}
        <div class="context-menu-separator"></div>
        <div class="context-menu-submenu" role="group" aria-label="Move page to section">
          <span class="context-menu-label">Move to section…</span>
          ${available.map((candidate) => html`<button class="context-menu-item" role="menuitem" @click=${() => props.onNavStateChange(moveTabToSection(closed(), tab, candidate.id))}>${icons.folder} ${sectionName(candidate.id)}</button>`)}
          <button class="context-menu-item" role="menuitem" @click=${() => {
            const name = prompt("New section name:");
            if (!name?.trim()) return;
            const created = createNavCategory(closed(), name.trim());
            const category = created.categories.at(-1);
            if (category) props.onNavStateChange(moveTabToSection(created, tab, category.id));
          }}>${icons.plus} New custom category…</button>
        </div>
        <div class="context-menu-separator"></div>
        <button class="context-menu-item" role="menuitem" @click=${() => props.onNavStateChange(hideTab(closed(), tab))}>${icons.eye} Hide tab</button>
      ` : nothing}
    </div>
  `;
}

function renderAddCategoryButton(props: EnhancedNavSidebarProps) {
  return html`
    <button 
      class="nav-add-category"
      @click=${() => {
        const name = prompt('Category name:');
        if (name?.trim()) {
          props.onNavStateChange(createNavCategory(props.navState, name.trim()));
        }
      }}
    >
      ${icons.plus} Add Category
    </button>
  `;
}

function renderSyncButton() {
  return html`
    <button 
      class="nav-sync-btn"
      @click=${async () => {
        const btn = document.querySelector('.nav-sync-btn') as HTMLButtonElement;
        if (btn) btn.textContent = 'Syncing...';
        const ok = await forceNavSidebarSync();
        if (btn) btn.textContent = ok ? 'Synced!' : 'Failed';
        setTimeout(() => {
          if (btn) btn.textContent = 'Sync';
        }, 2000);
      }}
      title="Sync sidebar layout to server (for other browsers)"
    >
      ${icons.refresh} Sync
    </button>
  `;
}

function renderResetButton(props: EnhancedNavSidebarProps) {
  return html`
    <button 
      class="nav-reset-btn"
      @click=${async () => {
        if (!confirm('Reset sidebar layout? Your current layout will be backed up before reset.')) return;
        try {
          props.onNavStateChange(await resetNavSidebarToDefaultsWithBackup());
        } catch (error) {
          alert(`Sidebar reset failed; your current layout was kept.\n\n${String(error)}`);
        }
      }}
      title="Reset to defaults"
    >
      ${icons.refresh} Reset
    </button>
  `;
}

// The commercial licenses page lives on the cloud site's static root
// (site/pages/licenses.mjs); a cloud build links it same-origin.
function commercialLicensesUrl(): string {
  return isCloudBuild() ? "/licenses/" : "https://cloud.infinibotos.com/licenses/";
}

function renderNavFooter(props: EnhancedNavSidebarProps) {
  // The footer-collapse only applies in the wide sidebar. In slim
  // icon-rail mode (props.collapsed) the footer is already reduced to
  // icon links, so always show its body there.
  const collapsed = !props.collapsed && isNavFooterCollapsed();

  const body = html`
    <div class="nav-footer-body">
      ${renderAddCategoryButton(props)}
      <div class="nav-footer-row">
        ${renderSyncButton()}
        ${renderResetButton(props)}
      </div>

      <div class="nav-group nav-group--links">
        <div class="nav-category-header">
          <span class="nav-category-label">${t("nav.resources", undefined, "Resources")}</span>
        </div>
        <div class="nav-group__items">
          <button
            class="nav-item"
            type="button"
            title="Reopen the profile chooser to switch users"
            @click=${() => {
              setGateEnabled(true);
              markGateUnpassed();
              location.reload();
            }}
          >
            <span class="nav-item__icon" aria-hidden="true">${icons.users}</span>
            <span class="nav-item__text">Switch profile</span>
          </button>
          <button
            class="nav-item nav-item--danger"
            type="button"
            title="Log out and return to the login screen"
            @click=${() => {
              // Clear saved gateway credentials so the login screen appears.
              try {
                const raw = localStorage.getItem("infinibot.control.settings.v1");
                if (raw) {
                  const s = JSON.parse(raw) as Record<string, unknown>;
                  delete s.token;
                  delete s.password;
                  localStorage.setItem("infinibot.control.settings.v1", JSON.stringify(s));
                }
              } catch { /* ignore */ }
              // Clear the session login marker.
              try { sessionStorage.removeItem("infinibot.login.username"); } catch { /* ignore */ }
              // Un-pass the gate so profile chooser resets too.
              markGateUnpassed();
              location.reload();
            }}
          >
            <span class="nav-item__icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg></span>
            <span class="nav-item__text">Log out</span>
          </button>
          <button
            class="nav-item ${props.currentTab === "docs" ? "is-active" : ""}"
            type="button"
            title="Open the in-app docs viewer"
            @click=${() => props.onTabSelect("docs")}
          >
            <span class="nav-item__icon" aria-hidden="true">${icons.book}</span>
            <span class="nav-item__text">Docs</span>
          </button>
          <a
            class="nav-item"
            href=${commercialLicensesUrl()}
            target="_blank"
            rel="noopener"
            title="Commercial licenses for hosted, resale, white-label and OEM use"
          >
            <span class="nav-item__icon" aria-hidden="true">${icons.briefcase}</span>
            <span class="nav-item__text">Commercial license</span>
          </a>
        </div>
      </div>

      ${renderSidebarBottomStrip({
        requestUpdate: props.requestUpdate,
        client: props.client ?? null,
      })}
    </div>
  `;

  return html`
    <div class="nav-footer ${collapsed ? "nav-footer--collapsed" : ""}">
      <button
        class="nav-footer-toggle"
        type="button"
        aria-expanded=${collapsed ? "false" : "true"}
        title=${collapsed ? "Expand settings & system tools" : "Collapse settings & system tools"}
        @click=${() => {
          setNavFooterCollapsed(!isNavFooterCollapsed());
          props.requestUpdate?.();
        }}
      >
        <span class="nav-footer-toggle__icon">
          ${collapsed ? icons.chevronRight : icons.chevronDown}
        </span>
        <span class="nav-category-label">${t("nav.system", undefined, "System")}</span>
      </button>
      ${collapsed ? nothing : body}
    </div>
  `;
}

// ============================================================
// Search header — lightweight gold-caret filter (⌘K)
// ============================================================

function renderNavSearch(props: EnhancedNavSidebarProps) {
  const q = getNavSearchQuery();
  return html`
    <div class="nav-search ${q ? "is-filled" : ""}">
      <span class="nav-search__icon" aria-hidden="true">${icons.search}</span>
      <input
        class="nav-search__input"
        data-nav-search
        type="text"
        autocomplete="off"
        spellcheck="false"
        placeholder=${t("nav.search", undefined, "Search tabs…")}
        .value=${q}
        @input=${(e: InputEvent) => {
          setNavSearchQuery((e.target as HTMLInputElement).value);
          props.requestUpdate?.();
        }}
        @keydown=${(e: KeyboardEvent) => {
          if (e.key === "Escape") {
            clearNavSearchQuery();
            props.requestUpdate?.();
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
      ${q
        ? html`<button
            class="nav-search__clear"
            type="button"
            title="Clear search"
            aria-label="Clear search"
            @click=${() => {
              clearNavSearchQuery();
              props.requestUpdate?.();
            }}
          >
            ${icons.x}
          </button>`
        : html`<kbd class="nav-search__kbd" aria-hidden="true">⌘K</kbd>`}
    </div>
  `;
}

// ============================================================
// Launchpad trigger — opens the full-screen page launcher
// ============================================================

/**
 * A tasteful grid-glyph button that opens the Launchpad (macOS-Launchpad-style
 * page switcher). Rendered in BOTH collapsed and expanded sidebar states; it is
 * purely additive and never touches the collapse/expand toggles.
 */
function renderLaunchpadTrigger(props: EnhancedNavSidebarProps) {
  const collapsed = props.collapsed;
  return html`
    <button
      class="nav-launchpad-btn ${collapsed ? "nav-launchpad-btn--collapsed" : ""}"
      type="button"
      title="Open Launchpad — all pages (⌘/Ctrl+P)"
      aria-label="Open Launchpad page switcher"
      @click=${() => {
        openLaunchpad();
        props.requestUpdate?.();
      }}
    >
      <span class="nav-launchpad-btn__icon" aria-hidden="true">${icons.gridFour}</span>
      ${collapsed
        ? nothing
        : html`<span class="nav-launchpad-btn__text">Launchpad</span>
            <kbd class="nav-launchpad-btn__kbd" aria-hidden="true">⌘P</kbd>`}
    </button>
  `;
}

// ============================================================
// Runtime wiring — badge stream + ⌘K focus shortcut (one-time)
// ============================================================

let _cmdKBound = false;
let _pluginHostBound = false;

function ensureNavRuntime(props: EnhancedNavSidebarProps): void {
  // Live badge counts (running agents, …) driven off the gateway event stream.
  initNavBadges(props.client ?? null, () => props.requestUpdate?.());
  // "Needs setup" glow: one setup.status fetch, then gateway pushes.
  initNavSetupStatus(props.client ?? null, () => props.requestUpdate?.());

  // Plugin enable/disable, a hidden nav contribution or an appearance change
  // re-syncs the plugin host; redraw the sections live (no reload).
  // props.requestUpdate is the app element's (unbound) Lit method, so call it
  // on the element itself.
  if (!_pluginHostBound && typeof window !== "undefined") {
    _pluginHostBound = true;
    window.addEventListener(PLUGIN_HOST_EVENT, () => {
      hideNavPluginFlyout();
      document.querySelector<HTMLElement & { requestUpdate?: () => void }>("infinibot-app")?.requestUpdate?.();
    });
  }

  if (_cmdKBound || typeof window === "undefined") return;
  _cmdKBound = true;
  window.addEventListener("keydown", (e) => {
    const isCmdK = (e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K");
    if (!isCmdK) return;
    const input = document.querySelector<HTMLInputElement>("[data-nav-search]");
    if (!input) return; // collapsed rail / no search box mounted
    e.preventDefault();
    input.focus();
    input.select();
  });
}

// ============================================================
// Plugin sections — one per enabled plugin with pages
// ============================================================

/** Inline custom properties carrying the plugin's accent for both themes. */
function pluginAccentStyle(section: PluginNavSection): string {
  const clean = (v?: string) => (v ?? "").replace(/[;{}<>"]/g, "");
  const out: string[] = [];
  if (section.accent?.dark) out.push(`--nav-plugin-accent-dark: ${clean(section.accent.dark)}`);
  if (section.accent?.light) out.push(`--nav-plugin-accent-light: ${clean(section.accent.light)}`);
  return out.join("; ");
}

function renderPluginSection(
  props: EnhancedNavSidebarProps,
  section: PluginNavSection,
  availableIds: readonly string[],
  nested = false,
) {
  if (isPluginSectionHidden(props.navState, section.pluginId)) return nothing;
  const sectionId = pluginSectionId(section.pluginId);
  const hidden = new Set(props.navState.hiddenTabs);
  const extras = Object.entries(props.navState.tabSectionOverrides)
    .filter(([, target]) => target === sectionId)
    .map(([tab]) => ({ tab: tab as Tab, label: navLabelForTab(tab as Tab), title: titleForTab(tab as Tab), icon: undefined }));
  const sourceItems = [
    ...section.items.filter((item) => !props.navState.tabSectionOverrides[item.tab] || props.navState.tabSectionOverrides[item.tab] === sectionId),
    ...extras.filter((extra) => !section.items.some((item) => item.tab === extra.tab)),
  ];
  const allowed = sourceItems.filter(
    (it) =>
      isTabAvailable(it.tab) &&
      !hidden.has(it.tab) &&
      (!props.isPageAllowed || navTargetForEntry(it.tab, props.isPageAllowed) !== null),
  );
  const displayName = (tab: Tab) => getNavTabDisplayName(props.navState, tab, navLabelForTab(tab));
  const searching = isNavSearching();
  // ⌘K: a page matches on its own label/terms OR on the plugin's name.
  const visible = searching
    ? allowed.filter((it) =>
        tabMatchesSearch(it.tab, displayName(it.tab), [
          ...navSearchTermsForTab(it.tab),
          section.title,
          it.title ?? "",
        ]),
      )
    : allowed;
  if (visible.length === 0) return nothing;

  const activeHost = hostForTab(props.currentTab);
  const hasActive = visible.some((it) => it.tab === activeHost);
  const collapsed = isPluginSectionCollapsed(props.navState, section.pluginId, section.collapsedByDefault);
  // Same rule as core groups: searching or holding the active page keeps it open.
  const showItems = searching || !collapsed || hasActive;
  const itemsId = `nav-plugin-items-${section.pluginId}`;
  const accent = pluginAccentStyle(section);
  const rail = props.collapsed;
  const setupCount = navSetupCountFor(allowed.map((it) => it.tab));
  const dragHandlers = createCategoryDragHandlers(props, sectionId);
  const dropHandlers = createSectionDropHandlers(props, sectionId, availableIds);

  const flyoutSpec = () => ({
    pluginId: section.pluginId,
    title: section.title,
    monogram: section.monogram,
    accentStyle: accent,
    items: visible.map((it) => ({
      label: displayName(it.tab),
      href: pathForTab(it.tab, props.basePath),
      icon: navIconFor(it.tab, it.icon),
      active: it.tab === activeHost,
      setup: (() => {
        const e = navSetupFor(it.tab);
        return e ? { state: e.state, text: setupHint(e) } : undefined;
      })(),
      onSelect: () => props.onTabSelect(it.tab),
    })),
  });

  const onHeaderClick = (e: MouseEvent) => {
    if (rail) {
      const btn = e.currentTarget as HTMLElement;
      if (isNavPluginFlyoutOpen(section.pluginId)) hideNavPluginFlyout();
      // detail === 0 → keyboard activation: move focus into the menu.
      else showNavPluginFlyout(btn, flyoutSpec(), e.detail === 0);
      return;
    }
    props.onNavStateChange(
      togglePluginSectionCollapsed(props.navState, section.pluginId, section.collapsedByDefault),
    );
  };

  return html`
    <div
      class="nav-group nav-group--plugin ${nested ? "nav-group--nested" : ""} ${!searching && collapsed && !hasActive ? "nav-group--collapsed" : ""} ${hasActive ? "has-active" : ""}"
      data-plugin-section=${section.pluginId}
      data-section-id=${sectionId}
      style=${accent}
    >
      <div
        class="nav-category-header nav-plugin-header"
        tabindex="0"
        aria-haspopup="menu"
        aria-label=${`${section.title} section actions`}
        draggable="true"
        @dragstart=${dragHandlers.onDragStart}
        @dragend=${dragHandlers.onDragEnd}
        @dragover=${dropHandlers.onDragOver}
        @dragleave=${dropHandlers.onDragLeave}
        @drop=${dropHandlers.onDrop}
        @contextmenu=${(e: MouseEvent) => {
          openNavContextMenu(props, "plugin-section", section.pluginId, e);
        }}
        @keydown=${(e: KeyboardEvent) => openNavContextMenuFromKeyboard(props, "plugin-section", section.pluginId, e)}
      >
        <button
          class="nav-plugin-toggle ${setupCount > 0 ? "nav-plugin-toggle--setup" : ""}"
          type="button"
          aria-expanded=${rail ? String(isNavPluginFlyoutOpen(section.pluginId)) : String(showItems)}
          aria-controls=${rail ? `nav-plugin-flyout-${section.pluginId}` : itemsId}
          aria-haspopup=${rail ? "menu" : nothing}
          aria-label=${rail ? `${section.title} pages${setupCount ? `, ${setupCount} need setup` : ""}` : `${section.title} section`}
          title=${setupCount && rail ? `${section.title} — ${setupCount} ${setupCount === 1 ? "page needs" : "pages need"} setup` : section.title}
          @click=${onHeaderClick}
          @keydown=${(e: KeyboardEvent) => {
            if (rail && e.key === "ArrowDown") {
              e.preventDefault();
              showNavPluginFlyout(e.currentTarget as HTMLElement, flyoutSpec(), true);
            }
          }}
          @mouseenter=${(e: MouseEvent) => {
            if (rail) showNavPluginFlyout(e.currentTarget as HTMLElement, flyoutSpec());
          }}
          @mouseleave=${() => {
            if (rail) scheduleHideNavPluginFlyout();
          }}
        >
          <span class="nav-plugin-toggle__chevron" aria-hidden="true">
            ${showItems ? icons.chevronDown : icons.chevronRight}
          </span>
          <span class="nav-plugin-mark ${hasActive ? "is-active" : ""}" aria-hidden="true">${section.monogram}</span>
          <span class="nav-category-label">${section.title}</span>
          ${setupCount > 0 ? html`<span class="nav-plugin-setup-dot" aria-hidden="true"></span>` : nothing}
        </button>
        ${renderSetupCount(setupCount)}
        <span class="nav-category-count" aria-label="${allowed.length} pages">${allowed.length}</span>
      </div>
      <div
        class="nav-group__items"
        id=${itemsId}
        role="group"
        aria-label=${section.title}
        ?hidden=${!showItems}
      >
        ${showItems
          ? visible.map((it, i) =>
              renderNavTab(props, it.tab, i, sectionId, section.title, { icon: it.icon, pluginItem: true }),
            )
          : nothing}
      </div>
    </div>
  `;
}

type SidebarSection =
  | { id: string; kind: "category"; category: NavCategory }
  | { id: string; kind: "plugin"; plugin: PluginNavSection };

function availableSidebarSections(props: EnhancedNavSidebarProps): SidebarSection[] {
  const categories = props.navState.categories.map((category): SidebarSection => ({ id: category.id, kind: "category", category }));
  const plugins = pluginNavSections()
    .filter((plugin) => !isPluginSectionHidden(props.navState, plugin.pluginId))
    .map((plugin): SidebarSection => ({ id: pluginSectionId(plugin.pluginId), kind: "plugin", plugin }));
  const byId = new Map([...categories, ...plugins].map((section) => [section.id, section]));
  return orderedSectionIds(props.navState, [...byId.keys()])
    .map((id) => byId.get(id))
    .filter((section): section is SidebarSection => Boolean(section));
}

function sectionIsCollapsed(props: EnhancedNavSidebarProps, section: SidebarSection): boolean {
  return section.kind === "category"
    ? section.category.collapsed
    : isPluginSectionCollapsed(props.navState, section.plugin.pluginId, section.plugin.collapsedByDefault);
}

function renderSidebarSection(props: EnhancedNavSidebarProps, section: SidebarSection, availableIds: readonly string[], nested = false) {
  return section.kind === "category"
    ? renderCategory(props, section.category, availableIds, nested)
    : renderPluginSection(props, section.plugin, availableIds, nested);
}

function renderFavorites(props: EnhancedNavSidebarProps) {
  const visible = visibleFavorites(props.navState, (tab) => isTabAvailable(tab) && (!props.isPageAllowed || props.isPageAllowed(tab)));
  const searching = isNavSearching();
  const filtered = searching
    ? visible.filter((tab) => tabMatchesSearch(tab, getNavTabDisplayName(props.navState, tab, navLabelForTab(tab)), navSearchTermsForTab(tab)))
    : visible;
  if (searching && filtered.length === 0) return nothing;
  const showItems = searching || !props.navState.favoritesCollapsed;
  return html`
    <div class="nav-group nav-group--favorites ${props.navState.favoritesCollapsed ? "nav-group--collapsed" : ""}" data-favorites-section>
      <button class="nav-category-header nav-favorites-header" type="button" aria-expanded=${String(showItems)} aria-controls="nav-favorite-items" title="Favorites" @click=${() => props.onNavStateChange(toggleFavoritesCollapsed(props.navState))}>
        <span class="nav-category-toggle" aria-hidden="true">${showItems ? icons.chevronDown : icons.chevronRight}</span>
        <span class="nav-favorites-star" aria-hidden="true">${icons.star}</span>
        <span class="nav-category-label">Favorites</span>
        <span class="nav-category-count">${visible.length}</span>
      </button>
      <div id="nav-favorite-items" class="nav-group__items nav-favorite-items" ?hidden=${!showItems}>
        ${showItems && filtered.length
          ? filtered.map((tab, index) => {
              const plugin = pluginSectionOfTab(tab);
              return renderNavTab(props, tab, index, "favorites", "Favorites", {
                icon: plugin?.items.find((item) => item.tab === tab)?.icon,
                favoriteItem: true,
              });
            })
          : showItems ? html`<div class="nav-favorites-empty">Right-click any page to add it here</div>` : nothing}
      </div>
    </div>
  `;
}

function renderCategoriesWithPluginSections(props: EnhancedNavSidebarProps) {
  const sections = availableSidebarSections(props);
  const ids = sections.map((section) => section.id);
  const top = sections.filter((section) => !sectionParent(props.navState, section.id, ids));
  return html`${top.map((section) => {
    const children = sections.filter((candidate) => sectionParent(props.navState, candidate.id, ids) === section.id);
    const showChildren = isNavSearching() || !sectionIsCollapsed(props, section);
    return html`
      ${renderSidebarSection(props, section, ids)}
      ${children.length && showChildren ? html`<div class="nav-section-children" data-parent-section=${section.id}>${children.map((child) => renderSidebarSection(props, child, ids, true))}</div>` : nothing}
    `;
  })}`;
}

// ============================================================
// Main Render
// ============================================================

let _lastRenderedTab: Tab | null = null;

export function renderEnhancedNavSidebar(props: EnhancedNavSidebarProps) {
  ensureNavRuntime(props);

  // The plugin flyout is mounted on <body>: navigation that doesn't start with
  // a pointer press (back/forward, in-page links, agent/voice ui_control) left
  // it open over the new page. Close it whenever the active tab changes.
  if (_lastRenderedTab !== null && _lastRenderedTab !== props.currentTab && isNavPluginFlyoutOpen()) hideNavPluginFlyout();
  _lastRenderedTab = props.currentTab;

  // DEV-only invariant: exactly one tab pill may carry the `active` class at a
  // time. Runs after paint so the freshly-rendered DOM is queried. Guards
  // against regressions where the active state lights up sibling pills.
  assertSingleActiveTabPill();

  return html`
    <aside class="nav enhanced infinibar ${props.collapsed ? 'nav--collapsed' : ''} ${isNavSearching() ? 'is-searching' : ''}">
      ${renderLaunchpadTrigger(props)}
      ${props.collapsed ? nothing : renderNavSearch(props)}
      <div class="nav-categories">
        ${renderFavorites(props)}
        ${renderCategoriesWithPluginSections(props)}

        ${renderHiddenTabs(props)}
      </div>

      ${renderNavFooter(props)}
    </aside>

    ${renderContextMenu(props)}
  `;
}

// ============================================================
// Active-pill invariant (DEV)
// ============================================================

let _activePillRafQueued = false;

/**
 * Assert that exactly one `[data-tab-pill]` carries the `.active` class while a
 * tab is selected. Gated behind `import.meta.env.DEV` so it's stripped from
 * production builds. Logs a warning (never throws) so a regression is loud in
 * dev without breaking the UI.
 */
function assertSingleActiveTabPill(): void {
  if (typeof document === "undefined") return;
  // import.meta.env.DEV is replaced statically by Vite; the optional chain keeps
  // this safe under tsc / non-Vite test harnesses.
  const isDev = Boolean((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV);
  if (!isDev) return;
  if (_activePillRafQueued) return;
  _activePillRafQueued = true;
  requestAnimationFrame(() => {
    _activePillRafQueued = false;
    const active = document.querySelectorAll("[data-tab-pill].active");
    // Zero is legitimate (e.g. a route with no sidebar pill, like a modal). Only
    // more-than-one is the bug the operator reported.
    if (active.length > 1) {
      const tabs = Array.from(active).map((el) => el.getAttribute("data-tab-pill")).join(", ");
      // eslint-disable-next-line no-console
      console.warn(
        `[nav] expected at most 1 active tab pill, found ${active.length}: ${tabs}. ` +
          `Only the pill matching state.tab should carry .active.`,
      );
    }
  });
}

// ============================================================
// Initialize
// ============================================================

export function initializeNavSidebarState(): NavSidebarState {
  return loadNavSidebarState();
}

export { loadNavSidebarStateAsync } from "../controllers/nav-sidebar";
