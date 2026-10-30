/**
 * Chat panel refs — detection. The ONE place every chat surface asks "does this
 * tool result carry an agent-invokable panel?" (webchat, Grid chat, classic
 * chat, voice transcript, and the gateway when it collects the panels a group
 * chat member's run produced). Pure + DOM-free so it unit-tests under node.
 *
 * The `show_panel` tool (src/agents/tools/show-panel-tool.ts) returns JSON whose
 * FIRST key is `chatPanel: { v: 1, kind, query, … }`. Transcripts carry that
 * JSON as tool-result text (sometimes truncated by the surface), as a content
 * block, or as `details` on the tool-result message.
 */

import { coerceString } from "../text/coerce.js";

export interface PanelLink {
  tab: string;
  path?: string;
  label: string;
  action?: "agent-focus";
  actionParams?: Record<string, unknown>;
}

/** Mirrors ChatPanelRef in src/chat-panels/types.ts. */
export interface ChatPanelRef {
  v: 1;
  panelId: string;
  kind: string;
  query: Record<string, unknown>;
  title: string;
  display: "inline" | "modal";
  summary: string;
  count: number;
  empty: boolean;
  error: string | null;
  link: PanelLink;
  refreshMs: number;
  ts: number;
}

/** Mirrors PanelResult in src/chat-panels/types.ts (what chat.panel.refresh returns). */
export interface PanelResult {
  kind: string;
  title: string;
  data: unknown;
  summary: string;
  count: number;
  empty: boolean;
  error: string | null;
  text: string;
  link: PanelLink;
  refreshMs: number;
  fetchedAt: number;
}

export const SHOW_PANEL_TOOL = "show_panel";

function coerceRef(v: unknown): ChatPanelRef | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  if (r.v !== 1 || typeof r.kind !== "string" || !r.kind) return null;
  const link = (
    r.link && typeof r.link === "object" ? r.link : { tab: "", label: "" }
  ) as PanelLink;
  return {
    v: 1,
    panelId:
      typeof r.panelId === "string" && r.panelId
        ? r.panelId
        : `panel_${r.kind}_${coerceString(r.ts)}`,
    kind: r.kind,
    query: r.query && typeof r.query === "object" ? (r.query as Record<string, unknown>) : {},
    title: typeof r.title === "string" ? r.title : r.kind,
    display: r.display === "modal" ? "modal" : "inline",
    summary: typeof r.summary === "string" ? r.summary : "",
    count: typeof r.count === "number" ? r.count : 0,
    empty: r.empty === true,
    error: typeof r.error === "string" ? r.error : null,
    link,
    refreshMs: typeof r.refreshMs === "number" ? r.refreshMs : 0,
    ts: typeof r.ts === "number" ? r.ts : 0,
  };
}

/** Balanced-brace scan from `start` (a `{`); returns the JSON object text or null. */
function sliceObject(text: string, start: number): string | null {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Extract a panel ref from tool-result text (or an already-parsed object).
 * Tolerates surfaces that truncate long output: the ref is the first key, so
 * its own object is complete even when the rest of the JSON is cut off.
 */
export function extractPanelRef(value: unknown): ChatPanelRef | null {
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return coerceRef(o.chatPanel) ?? coerceRef(o);
  }
  if (typeof value !== "string" || !value.includes('"chatPanel"')) return null;
  const text = value.trim();
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const ref = coerceRef(parsed?.chatPanel);
    if (ref) return ref;
  } catch {
    /* truncated / wrapped — fall through to the scan */
  }
  const key = text.indexOf('"chatPanel"');
  const brace = text.indexOf("{", key);
  if (brace < 0) return null;
  const obj = sliceObject(text, brace);
  if (!obj) return null;
  try {
    return coerceRef(JSON.parse(obj));
  } catch {
    return null;
  }
}

function blockText(item: Record<string, unknown>): unknown {
  if (typeof item.text === "string") return item.text;
  if (typeof item.content === "string") return item.content;
  if (Array.isArray(item.content)) {
    return (item.content as Array<Record<string, unknown>>)
      .map((c) => (c && typeof c.text === "string" ? c.text : ""))
      .join("");
  }
  return undefined;
}

/**
 * Every panel ref inside a raw transcript message: a toolResult message
 * (`details`, text content) or tool_result content blocks inside any message.
 */
export function extractPanelRefsFromMessage(message: unknown): ChatPanelRef[] {
  if (!message || typeof message !== "object") return [];
  const m = message as Record<string, unknown>;
  const out: ChatPanelRef[] = [];
  const push = (r: ChatPanelRef | null) => {
    if (r && !out.some((x) => x.panelId === r.panelId)) out.push(r);
  };
  const role = coerceString(m.role).toLowerCase();
  const isToolResult =
    role === "toolresult" ||
    role === "tool_result" ||
    role === "tool" ||
    typeof m.toolCallId === "string";
  if (isToolResult) {
    push(extractPanelRef(m.details));
    if (typeof m.content === "string") push(extractPanelRef(m.content));
  }
  if (Array.isArray(m.content)) {
    for (const raw of m.content as unknown[]) {
      if (!raw || typeof raw !== "object") continue;
      const item = raw as Record<string, unknown>;
      const type = coerceString(item.type).toLowerCase();
      if (type === "toolresult" || type === "tool_result" || (isToolResult && type === "text")) {
        push(extractPanelRef(blockText(item)));
      }
    }
  }
  return out;
}
