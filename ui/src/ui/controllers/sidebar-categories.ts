/**
 * Sidebar Categories Controller
 * Discord-style categories with drag-drop, editing, and collapsible sections
 */

import type { GatewaySessionRow } from "../types";

// ============================================================
// Types
// ============================================================

export interface SidebarCategory {
  id: string;
  name: string;
  collapsed: boolean;
  position: number;
  itemIds: string[];
  color?: string;
  icon?: string;
}

export interface SidebarItem {
  id: string;
  categoryId: string;
  position: number;
  session?: GatewaySessionRow;
  customName?: string;
  pinned?: boolean;
}

export interface SidebarState {
  categories: SidebarCategory[];
  items: Record<string, SidebarItem>;
  uncategorizedItems: string[];
  dragState: DragState | null;
  editState: EditState | null;
  contextMenu: ContextMenuState | null;
}

export interface DragState {
  type: 'item' | 'category';
  id: string;
  sourceIndex: number;
  sourceCategoryId: string | null;
  currentDropTarget: DropTarget | null;
}

export interface DropTarget {
  type: 'category' | 'item' | 'gap' | 'uncategorized';
  categoryId?: string;
  position?: number;
  beforeItemId?: string;
  afterItemId?: string;
}

export interface EditState {
  type: 'item' | 'category';
  id: string;
  value: string;
}

export interface ContextMenuState {
  type: 'item' | 'category';
  id: string;
  x: number;
  y: number;
}

// ============================================================
// Storage
// ============================================================

const STORAGE_KEY = 'infinibot-sidebar-categories';

export function loadSidebarState(): SidebarState {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      return {
        ...getDefaultState(),
        ...parsed,
        dragState: null,
        editState: null,
        contextMenu: null,
      };
    }
  } catch (e) {
    console.error('Failed to load sidebar state:', e);
  }
  return getDefaultState();
}

export function saveSidebarState(state: SidebarState): void {
  try {
    const toStore = {
      categories: state.categories,
      items: state.items,
      uncategorizedItems: state.uncategorizedItems,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(toStore));
  } catch (e) {
    console.error('Failed to save sidebar state:', e);
  }
}

function getDefaultState(): SidebarState {
  return {
    categories: [
      {
        id: 'recent',
        name: 'Recent',
        collapsed: false,
        position: 0,
        itemIds: [],
        icon: '🕐',
      },
      {
        id: 'favorites',
        name: 'Favorites',
        collapsed: false,
        position: 1,
        itemIds: [],
        icon: '⭐',
      },
      {
        id: 'archived',
        name: 'Archived',
        collapsed: true,
        position: 2,
        itemIds: [],
        icon: '📦',
      },
    ],
    items: {},
    uncategorizedItems: [],
    dragState: null,
    editState: null,
    contextMenu: null,
  };
}

// ============================================================
// Category Operations
// ============================================================

export function createCategory(state: SidebarState, name: string, icon?: string): SidebarState {
  const id = `cat-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const position = state.categories.length;
  
  const newState = {
    ...state,
    categories: [
      ...state.categories,
      {
        id,
        name,
        collapsed: false,
        position,
        itemIds: [],
        icon,
      },
    ],
  };
  
  saveSidebarState(newState);
  return newState;
}

export function renameCategory(state: SidebarState, categoryId: string, name: string): SidebarState {
  const newState = {
    ...state,
    categories: state.categories.map(cat =>
      cat.id === categoryId ? { ...cat, name } : cat
    ),
  };
  
  saveSidebarState(newState);
  return newState;
}

export function deleteCategory(state: SidebarState, categoryId: string): SidebarState {
  const category = state.categories.find(c => c.id === categoryId);
  if (!category) return state;
  
  // Move all items to uncategorized
  const itemsToMove = category.itemIds;
  
  const newItems = { ...state.items };
  itemsToMove.forEach(id => {
    if (newItems[id]) {
      newItems[id] = { ...newItems[id], categoryId: '' };
    }
  });
  
  const newState = {
    ...state,
    categories: state.categories.filter(c => c.id !== categoryId),
    items: newItems,
    uncategorizedItems: [...state.uncategorizedItems, ...itemsToMove],
  };
  
  saveSidebarState(newState);
  return newState;
}

export function toggleCategoryCollapsed(state: SidebarState, categoryId: string): SidebarState {
  const newState = {
    ...state,
    categories: state.categories.map(cat =>
      cat.id === categoryId ? { ...cat, collapsed: !cat.collapsed } : cat
    ),
  };
  
  saveSidebarState(newState);
  return newState;
}

export function reorderCategories(state: SidebarState, fromIndex: number, toIndex: number): SidebarState {
  const newCategories = [...state.categories];
  const [moved] = newCategories.splice(fromIndex, 1);
  newCategories.splice(toIndex, 0, moved);
  
  // Update positions
  newCategories.forEach((cat, idx) => {
    cat.position = idx;
  });
  
  const newState = { ...state, categories: newCategories };
  saveSidebarState(newState);
  return newState;
}

// ============================================================
// Item Operations
// ============================================================

export function addItemToCategory(
  state: SidebarState,
  itemId: string,
  categoryId: string,
  position?: number
): SidebarState {
  const item = state.items[itemId] || { id: itemId, categoryId: '', position: 0 };
  const oldCategoryId = item.categoryId;
  
  // Remove from old category
  let newCategories = state.categories.map(cat => {
    if (cat.id === oldCategoryId) {
      return { ...cat, itemIds: cat.itemIds.filter(id => id !== itemId) };
    }
    return cat;
  });
  
  // Remove from uncategorized if present
  let newUncategorized = state.uncategorizedItems.filter(id => id !== itemId);
  
  // Add to new category
  newCategories = newCategories.map(cat => {
    if (cat.id === categoryId) {
      const newItemIds = [...cat.itemIds];
      const insertPos = position !== undefined ? position : newItemIds.length;
      newItemIds.splice(insertPos, 0, itemId);
      return { ...cat, itemIds: newItemIds };
    }
    return cat;
  });
  
  const newItems = {
    ...state.items,
    [itemId]: {
      ...item,
      categoryId,
      position: position || 0,
    },
  };
  
  const newState = {
    ...state,
    categories: newCategories,
    items: newItems,
    uncategorizedItems: newUncategorized,
  };
  
  saveSidebarState(newState);
  return newState;
}

export function moveItemWithinCategory(
  state: SidebarState,
  itemId: string,
  categoryId: string,
  newPosition: number
): SidebarState {
  const newCategories = state.categories.map(cat => {
    if (cat.id === categoryId) {
      const itemIds = cat.itemIds.filter(id => id !== itemId);
      itemIds.splice(newPosition, 0, itemId);
      return { ...cat, itemIds };
    }
    return cat;
  });
  
  const newState = { ...state, categories: newCategories };
  saveSidebarState(newState);
  return newState;
}

export function removeItemFromCategory(state: SidebarState, itemId: string): SidebarState {
  const item = state.items[itemId];
  if (!item) return state;
  
  const newCategories = state.categories.map(cat => {
    if (cat.id === item.categoryId) {
      return { ...cat, itemIds: cat.itemIds.filter(id => id !== itemId) };
    }
    return cat;
  });
  
  const newItems = { ...state.items };
  delete newItems[itemId];
  
  const newState = {
    ...state,
    categories: newCategories,
    items: newItems,
    uncategorizedItems: [...state.uncategorizedItems, itemId],
  };
  
  saveSidebarState(newState);
  return newState;
}

export function renameItem(state: SidebarState, itemId: string, customName: string): SidebarState {
  const item = state.items[itemId];
  if (!item) {
    // Create new item entry
    const newState = {
      ...state,
      items: {
        ...state.items,
        [itemId]: {
          id: itemId,
          categoryId: '',
          position: 0,
          customName,
        },
      },
    };
    saveSidebarState(newState);
    return newState;
  }
  
  const newState = {
    ...state,
    items: {
      ...state.items,
      [itemId]: { ...item, customName },
    },
  };
  
  saveSidebarState(newState);
  return newState;
}

export function toggleItemPinned(state: SidebarState, itemId: string): SidebarState {
  const item = state.items[itemId];
  const newState = {
    ...state,
    items: {
      ...state.items,
      [itemId]: {
        ...(item || { id: itemId, categoryId: '', position: 0 }),
        pinned: item ? !item.pinned : true,
      },
    },
  };
  
  saveSidebarState(newState);
  return newState;
}

// ============================================================
// Drag Operations
// ============================================================

export function startDrag(
  state: SidebarState,
  type: 'item' | 'category',
  id: string,
  sourceIndex: number,
  sourceCategoryId: string | null
): SidebarState {
  return {
    ...state,
    dragState: {
      type,
      id,
      sourceIndex,
      sourceCategoryId,
      currentDropTarget: null,
    },
  };
}

export function updateDropTarget(state: SidebarState, dropTarget: DropTarget | null): SidebarState {
  if (!state.dragState) return state;
  return {
    ...state,
    dragState: {
      ...state.dragState,
      currentDropTarget: dropTarget,
    },
  };
}

export function endDrag(state: SidebarState): SidebarState {
  if (!state.dragState) return state;
  
  const { type, id, sourceCategoryId, currentDropTarget } = state.dragState;
  
  if (!currentDropTarget) {
    return { ...state, dragState: null };
  }
  
  let newState = { ...state, dragState: null };
  
  if (type === 'category') {
    // Reorder categories
    if (currentDropTarget.type === 'gap' && currentDropTarget.position !== undefined) {
      const fromIndex = state.categories.findIndex(c => c.id === id);
      const toIndex = currentDropTarget.position;
      if (fromIndex !== -1 && fromIndex !== toIndex) {
        newState = reorderCategories(newState, fromIndex, toIndex);
      }
    }
  } else if (type === 'item') {
    // Move item to category or reorder within category
    if (currentDropTarget.type === 'category' && currentDropTarget.categoryId) {
      newState = addItemToCategory(newState, id, currentDropTarget.categoryId);
    } else if (currentDropTarget.type === 'gap' && currentDropTarget.categoryId) {
      if (currentDropTarget.categoryId === sourceCategoryId) {
        // Reorder within same category
        if (currentDropTarget.position !== undefined) {
          newState = moveItemWithinCategory(newState, id, currentDropTarget.categoryId, currentDropTarget.position);
        }
      } else {
        // Move to different category
        newState = addItemToCategory(newState, id, currentDropTarget.categoryId, currentDropTarget.position);
      }
    } else if (currentDropTarget.type === 'uncategorized') {
      newState = removeItemFromCategory(newState, id);
    }
  }
  
  saveSidebarState(newState);
  return newState;
}

export function cancelDrag(state: SidebarState): SidebarState {
  return { ...state, dragState: null };
}

// ============================================================
// Edit Operations
// ============================================================

export function startEdit(state: SidebarState, type: 'item' | 'category', id: string, initialValue: string): SidebarState {
  return {
    ...state,
    editState: { type, id, value: initialValue },
  };
}

export function updateEditValue(state: SidebarState, value: string): SidebarState {
  if (!state.editState) return state;
  return {
    ...state,
    editState: { ...state.editState, value },
  };
}

export function finishEdit(state: SidebarState): SidebarState {
  if (!state.editState) return state;
  
  const { type, id, value } = state.editState;
  let newState = { ...state, editState: null };
  
  if (value.trim()) {
    if (type === 'category') {
      newState = renameCategory(newState, id, value.trim());
    } else {
      newState = renameItem(newState, id, value.trim());
    }
  }
  
  return newState;
}

export function cancelEdit(state: SidebarState): SidebarState {
  return { ...state, editState: null };
}

// ============================================================
// Context Menu Operations
// ============================================================

export function showContextMenu(
  state: SidebarState,
  type: 'item' | 'category',
  id: string,
  x: number,
  y: number
): SidebarState {
  return {
    ...state,
    contextMenu: { type, id, x, y },
  };
}

export function hideContextMenu(state: SidebarState): SidebarState {
  return { ...state, contextMenu: null };
}

// ============================================================
// Sync with Sessions
// ============================================================

export function syncWithSessions(state: SidebarState, sessions: GatewaySessionRow[]): SidebarState {
  const sessionIds = new Set(sessions.map(s => s.key));
  
  // Update items with session data
  const newItems = { ...state.items };
  sessions.forEach(session => {
    if (newItems[session.key]) {
      newItems[session.key] = { ...newItems[session.key], session };
    }
  });
  
  // Add new sessions to uncategorized if not already tracked
  const trackedIds = new Set([
    ...Object.keys(state.items),
    ...state.uncategorizedItems,
  ]);
  
  const newUncategorized = [...state.uncategorizedItems];
  sessions.forEach(session => {
    if (!trackedIds.has(session.key)) {
      newUncategorized.push(session.key);
      newItems[session.key] = {
        id: session.key,
        categoryId: '',
        position: 0,
        session,
      };
    }
  });
  
  // Remove items for deleted sessions (but keep custom items)
  const cleanedCategories = state.categories.map(cat => ({
    ...cat,
    itemIds: cat.itemIds.filter(id => sessionIds.has(id) || !newItems[id]?.session),
  }));
  
  const cleanedUncategorized = newUncategorized.filter(id => 
    sessionIds.has(id) || !newItems[id]?.session
  );
  
  return {
    ...state,
    categories: cleanedCategories,
    items: newItems,
    uncategorizedItems: cleanedUncategorized,
  };
}
