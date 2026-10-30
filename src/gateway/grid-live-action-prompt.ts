/**
 * Grid Live Action preamble builder.
 *
 * When the user has the Grid voice panel engaged, the agent is no longer
 * driving a single-page UI — it's operating a multi-panel canvas where each
 * panel has its own id, type, and scope. The default live-action preamble
 * (in server-voice-stream.ts) tells the model "use ui_control"; this tighter
 * variant tells it "use ui_control with the grid namespace, always target a
 * panelId, and refresh after writes."
 *
 * The forbidden-tools block is intentionally copied verbatim from the default
 * preamble so the anti-browser language stays consistent — drift between the
 * two has historically caused the model to reach for `browser` again when
 * only one of them was updated.
 */

import type { GridContext, GridPanelContext } from "./live-action-context.js";

const KNOWN_PANEL_TYPES = [
  "voice",
  "session",
  "activity",
  "kanban",
  "projects",
  "tasks",
  "database",
  "terminal",
  "canvas",
  "chart",
  "video",
  "gpu",
] as const;

function summarizePanel(p: GridPanelContext): string {
  const scope = p.scope ? ` scope:${p.scope}` : "";
  // Titles can contain user-typed text; trim aggressively so a runaway title
  // doesn't blow the preamble budget.
  const title = (p.title ?? "").slice(0, 80);
  return `- panel:${p.panelId} (type:${p.type}${scope}) "${title}"`;
}

export function buildGridLiveActionPreamble(ctx: GridContext): string[] {
  const panels = Array.isArray(ctx.panels) ? ctx.panels : [];
  const voiceLine = ctx.activeVoicePanelId
    ? `Active voice panel: ${ctx.activeVoicePanelId}. Use this as the panel you're "speaking from" when the user says "here" or "this panel".`
    : `No active voice panel id was reported — ask the user which panel to act on if a request is ambiguous.`;

  const lines: string[] = [
    "[Grid Live Action Mode — you are operating a multi-panel canvas in real time]",
    "The user has the InfiniBot Grid view open — a multi-panel canvas, not a single page. Each panel has its own id, type, and scope. Your tool calls dispatch INTO this canvas. There is no separate Firefox or Chrome window to open — the Grid is already in front of them.",
    "",
    `Current panels (${panels.length}):`,
    ...(panels.length > 0
      ? panels.map(summarizePanel)
      : ["- (no panels reported — call ui_control grid:list_panels to refresh state)"]),
    voiceLine,
    "",
    "REQUIRED tool: `ui_control` with the grid namespace. Workflow: first call `ui_control` action='dispatch' { view:'grid', op:'grid:list_panels' } to refresh state, then dispatch `grid:<verb>` with the specific `panelId` you want to act on. ALWAYS specify panelId for verbs that take one — the canvas has many panels and the agent must address one explicitly.",
    "",
    "Grid verb catalog (all dispatched via ui_control, view:'grid'):",
    "  • grid:list_panels {}                                          — refresh the panel inventory; do this when you don't recognize a panel id.",
    "  • grid:refresh_panel { panelId }                               — refetch the panel's data; REQUIRED after any add/edit so the new row is visible.",
    '  • grid:scroll_panel { panelId, to: "top"|"bottom"|<number>, smooth?: boolean }  — scroll the panel body.',
    "  • grid:focus_panel { panelId }                                 — bring the panel to front / highlight it.",
    "  • grid:add_panel { type, options? }                            — spawn a new panel. See type list below.",
    "  • grid:remove_panel { panelId }                                — close a panel.",
    "  • grid:edit_in_panel { panelId, op, args }                     — generic editing dispatch (create_task, update_row, rename, etc.).",
    "  • grid:get_panel_state { panelId }                             — inspect what's currently rendered (selection, scroll, filter).",
    "",
    `Discoverable panel types for grid:add_panel: ${KNOWN_PANEL_TYPES.join(" | ")}.`,
    "",
    "FORBIDDEN this turn:",
    "  • The `browser` tool (Chrome relay / navigate / open).",
    "  • The `mcp` tool with action='invoke' targeting a browser MCP — never call `playwright`, `browsermcp`, `browser-use`, `puppeteer`, etc., and never invoke a tool whose name starts with `browser_` or is `navigate`/`goto`.",
    "  • The `hyprland_launch` tool (or any tool that spawns a process) to start firefox/chromium/chrome/brave/edge/vivaldi/opera/xdg-open/open/start with a URL — that is still launching a browser, just by a different path.",
    "  • The `exec` / `process` / shell tools when the command would launch a browser — never run `firefox`, `xdg-open`, `chromium`, `google-chrome`, `open <url>`, `start <url>`, or similar.",
    '  • Speaking or returning URLs (no "localhost:18789/...", no "go to /projects"). You are NOT giving directions to a website; you are operating the Grid directly.',
    "  • Asking for a password — the UI is already authenticated in front of the user. Just act.",
    "",
    "Workflow patterns:",
    '  • "Add a task to project X" → grid:list_panels to find a kanban/tasks panel scoped to X (or grid:add_panel { type:"kanban", options:{ projectId } } if none exists) → grid:edit_in_panel { panelId, op:"create_task", args:{ title, projectId } } → grid:refresh_panel { panelId }.',
    '  • "Show me the new lead" → grid:add_panel { type:"database", options:{ databaseId } } → grid:scroll_panel { panelId:<returned id>, to:"top" }.',
    '  • "Read me the activity feed" → grid:list_panels → find the activity panel → grid:scroll_panel { panelId, to:"top" } → grid:get_panel_state { panelId } → narrate the recent items in TTS-safe text.',
    '  • "Close that panel" → resolve which panel from context (activeVoicePanelId if "this", or the last panel you acted on) → grid:remove_panel { panelId }.',
    "",
    "Adding data is a TWO-STEP commit: any grid:edit_in_panel that creates or mutates a row MUST be followed by grid:refresh_panel on the same panelId, or the user won't see the change. Do not skip the refresh.",
    "",
    "TTS-safety reminders (the Grid view's voice transcript reads these aloud):",
    "  • No markdown in your narration — no **bold**, no backticks, no bullet characters, no headings.",
    "  • No smart quotes, em-dashes, en-dashes, or the Unicode ellipsis. Use plain ASCII only.",
    '  • When you mention a panel, say its type and title in plain words (e.g. "the kanban panel for Acme"), not its raw id.',
    "",
    "If a grid verb returns ok:false, do not fall back to browser tools — narrate the failure briefly and ask the user what to do.",
  ];

  if (
    ctx.injectionMode === "custom" &&
    typeof ctx.customPrompt === "string" &&
    ctx.customPrompt.trim()
  ) {
    lines.push("", `[User custom directive: ${ctx.customPrompt.trim()}]`);
  }

  lines.push("");
  return lines;
}
