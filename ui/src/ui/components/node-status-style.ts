/**
 * Canonical visual language for node connection status.
 *
 * Why this exists: status colors and glyphs were spelled differently in 5+
 * places — federation-settings used #22c55e/#f87171, node-selector used
 * #22c55e/#71717a, the neural mesh viz used yet another palette, and the
 * spawn dialog hardcoded "🟢/🔴" emojis. An operator looking at three
 * surfaces side-by-side saw the same node represented three different
 * ways. Pull the palette + the boolean→label/glyph helpers here so every
 * device-status indicator agrees on what "online" looks like.
 *
 * Pure module. No DOM, no state. Safe to import from any view, controller,
 * or component.
 */

/** All possible status values normalized into one string union. */
export type NodeStatus = "online" | "offline" | "connecting" | "local" | "unknown";

/** Canonical palette. Tuned to match the existing accent colors (#f5b542
 *  warn, #5fd17a ok, #ef5b5b err) so this slots into the existing theme
 *  without operator-visible drift. */
export const NODE_STATUS_COLORS: Record<NodeStatus, string> = {
  online: "#5fd17a",
  offline: "#ef5b5b",
  connecting: "#f5b542",
  local: "#7da3ff",
  unknown: "#a3a3ad",
};

/** Glyph used inline next to the node name in selects + lists. Single
 *  character so it lines up cleanly in a `<select>` option. */
export const NODE_STATUS_GLYPH: Record<NodeStatus, string> = {
  online: "●",
  offline: "○",
  connecting: "◐",
  local: "▣",
  unknown: "◇",
};

/** Human label for tooltips / aria-labels. */
export const NODE_STATUS_LABEL: Record<NodeStatus, string> = {
  online: "Online",
  offline: "Offline",
  connecting: "Connecting",
  local: "This device",
  unknown: "Unknown",
};

/**
 * Normalize the many shapes of "online" the codebase carries into one
 * NodeStatus. Accepts:
 *   - boolean (true → online, false → offline)
 *   - string enum: "online" | "offline" | "connecting"
 *   - {isLocal: true} → "local" regardless of online value
 *   - undefined / unknown → "unknown"
 *
 * Caller passes whatever they have; we compute the right indicator.
 */
export function nodeStatusFrom(input: {
  isLocal?: boolean;
  online?: boolean | string;
  state?: string;
  status?: string;
}): NodeStatus {
  if (input.isLocal) return "local";
  const raw = (typeof input.online === "string"
    ? input.online
    : typeof input.state === "string"
      ? input.state
      : typeof input.status === "string"
        ? input.status
        : undefined
  )?.toLowerCase();
  if (raw === "online" || raw === "connected") return "online";
  if (raw === "offline" || raw === "disconnected") return "offline";
  if (raw === "connecting") return "connecting";
  if (typeof input.online === "boolean") return input.online ? "online" : "offline";
  return "unknown";
}

/** Convenience wrappers. All four return the same answer; pick whichever
 *  reads best at the call site. */
export function nodeStatusColor(input: Parameters<typeof nodeStatusFrom>[0]): string {
  return NODE_STATUS_COLORS[nodeStatusFrom(input)];
}
export function nodeStatusGlyph(input: Parameters<typeof nodeStatusFrom>[0]): string {
  return NODE_STATUS_GLYPH[nodeStatusFrom(input)];
}
export function nodeStatusLabel(input: Parameters<typeof nodeStatusFrom>[0]): string {
  return NODE_STATUS_LABEL[nodeStatusFrom(input)];
}

/** Inline-style helper for when a view wants a single-line status dot.
 *  Returns a CSS string, ready to drop into `style=` on a `<span>`. */
export function nodeStatusDotStyle(input: Parameters<typeof nodeStatusFrom>[0]): string {
  const color = nodeStatusColor(input);
  return (
    `display:inline-block; width:8px; height:8px; border-radius:50%;` +
    `background:${color}; box-shadow:0 0 6px ${color}40;`
  );
}
