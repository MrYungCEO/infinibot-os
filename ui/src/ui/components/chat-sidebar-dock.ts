/**
 * Dock geometry for the app-wide chat sidebar (<agent-chat-modal> in its
 * default, non-integrated mode): a right-hand, non-blocking panel that is
 * drag-resizable (width remembered in localStorage) and collapsible to a rail.
 * Same interaction model as the Live Action voice sidebar (voice-chat's
 * .la-resize-handle), kept separate so its keys don't collide.
 */

export const CHAT_DOCK_WIDTH_KEY = "infinibot.agentChat.sidebarWidthPx";
export const CHAT_DOCK_COLLAPSED_KEY = "infinibot.agentChat.sidebarCollapsed";
export const CHAT_DOCK_DEFAULT_WIDTH = 460;
export const CHAT_DOCK_MIN_WIDTH = 340;
export const CHAT_DOCK_MAX_WIDTH = 900;
/** Width of the collapsed rail. */
export const CHAT_DOCK_RAIL_WIDTH = 28;
/** Below this viewport width the dock is a full-width sheet (no resize). */
export const CHAT_DOCK_SHEET_BREAKPOINT = 600;
/** Dragging this far past the minimum collapses the dock. */
export const CHAT_DOCK_COLLAPSE_SLOP = 60;

type StorageLike = Pick<Storage, "getItem" | "setItem">;

/** Keep at least 240px of page visible next to the dock. */
export function maxDockWidth(viewportWidth: number): number {
  return Math.max(CHAT_DOCK_MIN_WIDTH, Math.min(CHAT_DOCK_MAX_WIDTH, viewportWidth - 240));
}

export function clampDockWidth(width: number, viewportWidth: number): number {
  if (!Number.isFinite(width)) return Math.min(CHAT_DOCK_DEFAULT_WIDTH, maxDockWidth(viewportWidth));
  return Math.round(Math.min(maxDockWidth(viewportWidth), Math.max(CHAT_DOCK_MIN_WIDTH, width)));
}

/** Width for a pointer at clientX dragging the dock's left edge. */
export function widthFromPointer(clientX: number, viewportWidth: number): { width: number; collapse: boolean } {
  const raw = viewportWidth - clientX;
  return {
    width: clampDockWidth(raw, viewportWidth),
    collapse: raw < CHAT_DOCK_MIN_WIDTH - CHAT_DOCK_COLLAPSE_SLOP,
  };
}

export function loadDockState(storage: StorageLike | null | undefined, viewportWidth: number) {
  let width = CHAT_DOCK_DEFAULT_WIDTH;
  let collapsed = false;
  try {
    const w = Number(storage?.getItem(CHAT_DOCK_WIDTH_KEY));
    if (w > 0) width = w;
    collapsed = storage?.getItem(CHAT_DOCK_COLLAPSED_KEY) === "1";
  } catch {
    /* storage blocked — defaults */
  }
  return { width: clampDockWidth(width, viewportWidth), collapsed };
}

export function saveDockState(storage: StorageLike | null | undefined, s: { width: number; collapsed: boolean }): void {
  try {
    storage?.setItem(CHAT_DOCK_WIDTH_KEY, String(Math.round(s.width)));
    storage?.setItem(CHAT_DOCK_COLLAPSED_KEY, s.collapsed ? "1" : "0");
  } catch {
    /* storage blocked */
  }
}
