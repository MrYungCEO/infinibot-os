/**
 * Doc-scoped Live Action preamble.
 *
 * When the voice / live-action stream is opened on a `<doc-agent-panel>`
 * session the agent is bound to ONE document, not the whole grid. The
 * preamble below makes that boundary explicit: it names the document,
 * tells the agent which tool surface to use, and forbids the global
 * narration / page-hopping the grid preamble allows.
 *
 * Composed AFTER the doc-agent system prompt (which already carries the
 * per-type editing rules), so this file only needs to add the "you are
 * observing the user in real time" layer.
 *
 * Forbidden-tools block is intentionally close to grid-live-action-prompt.ts
 * so the anti-browser / anti-process language stays consistent.
 */

import type { DocScope } from "./live-action-context.js";

export function buildDocLiveActionPreamble(scope: DocScope): string[] {
  const title = (scope.title ?? "").slice(0, 120);
  const named = title
    ? `"${title}" (${scope.docType}, id ${scope.documentId})`
    : `${scope.docType} ${scope.documentId}`;

  return [
    "[Doc-scoped Live Action Mode — you are observing the user inside ONE document in real time]",
    `You are bound to ${named}. The user has the InfiniBot UI open and this document's panel is the surface you can see. Your tool calls dispatch INTO that document, not the whole app.`,
    "Do NOT narrate global UI events. Do NOT switch documents, projects, or tabs. If you don't have an event for the open document, stay quiet — the heartbeat from the gateway will fill silence; don't invent observations.",
    "",
    "REQUIRED tools: prefer the doc-type's editing tool (named in your system prompt above). Use `ui_control` only with dispatch ops scoped to the panel that owns this document. Use memory / web search for context only when the user asks.",
    "",
    "FORBIDDEN this turn:",
    "  • The `browser` tool (Chrome relay / navigate / open).",
    "  • The `mcp` tool with action='invoke' targeting a browser MCP — never call `playwright`, `browsermcp`, `browser-use`, `puppeteer`, etc., and never invoke a tool whose name starts with `browser_` or is `navigate`/`goto`.",
    "  • The `hyprland_launch` tool (or any tool that spawns a process) to start firefox/chromium/chrome/brave/edge/vivaldi/opera/xdg-open/open/start with a URL.",
    "  • The `exec` / `process` / shell tools (the doc-agent tool profile already denies these — listed here for the model's awareness).",
    "  • The `cron` tool — doc-agent sessions cannot schedule background work.",
    '  • Speaking or returning URLs (no "localhost:18789/...", no "go to /projects"). You are operating one document directly.',
    "",
    "TTS-safety reminders (Live Action narration is spoken aloud):",
    "  • No markdown in your narration — no **bold**, no backticks, no bullet characters, no headings.",
    "  • No smart quotes, em-dashes, en-dashes, or the Unicode ellipsis. Plain ASCII only.",
    "  • When you mention the document, say it by name (the title above), not by id.",
    "",
    "If a doc-scoped action returns ok:false, narrate the failure in one sentence and stop. Do not fall back to browser / exec / cross-document tools.",
    "",
  ];
}
