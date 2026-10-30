/**
 * Pure, DOM-free logic for the group chat view (node-testable).
 */
import type { ToolActivity } from "../../../../../src/shared/group-chat/activity.js";
import type { RepoInfo } from "../../../../../src/shared/group-chat/context.js";
import type { UnverifiedClaim } from "../../../../../src/shared/group-chat/truth-guard.js";
import type {
  GroupChatBinding,
  ChatPanelRef,
  GroupMessageMeta,
  WorkflowGraph,
  WorkflowRunRecord,
} from "../../../../../src/shared/group-chat/types.js";
import type {
  EffectiveRunSettings,
  GroupRunSettings,
} from "../../../../../src/shared/group-chat/settings.js";
import {
  suggestGroupCommands,
  type GroupCommandSpec,
} from "../../../../../src/shared/group-chat/commands.js";
import type { ChatAttachment } from "../../ui-types";

export type GroupMemberInfo = {
  id: string;
  name: string;
  avatarUrl?: string | null;
};

export type GroupDescription = {
  key: string;
  title: string;
  members: Array<{ id: string; name: string }>;
  mode: "everyone" | "round-robin" | "moderator";
  moderatorId: string;
  workflows: WorkflowGraph[];
  runs: WorkflowRunRecord[];
  busy: boolean;
  activeTurns: Array<{ runId: string; agentId: string; memberKey: string; workflowRunId?: string }>;
  updatedAt: number;
  /** Shared repo / project / purpose (null when unbound; absent on older gateways). */
  binding?: GroupChatBinding | null;
  /** Live git state of the bound repo. */
  repo?: RepoInfo | null;
  /** Group-wide model / thinking (absent on gateways before composer parity). */
  settings?: GroupRunSettings;
  /** Per-member overrides of `settings`. */
  memberSettings?: Record<string, GroupRunSettings>;
  /** What each member actually runs with, and where each value comes from. */
  effective?: Record<string, EffectiveRunSettings>;
};

export type DisplayMessage = {
  id: string;
  kind: "user" | "agent" | "status";
  agentId?: string;
  agentName?: string;
  text: string;
  ts: number;
  workflowRunId?: string;
  workflowId?: string;
  error?: boolean;
  /** Real tool calls/results of the turn (shared activity ledger). */
  activity?: ToolActivity[];
  /** Claims the gateway could not back with a tool result. */
  unverified?: UnverifiedClaim[];
  /** data: URLs of attached images (user messages). */
  images: string[];
  /** Chat panels the agent's run produced (show_panel / plugin cards). */
  panels: ChatPanelRef[];
  /** Model the agent replied with. */
  model?: string;
};

/** Image content blocks → data: URLs (both the {data,mimeType} and Anthropic `source` shapes). */
export function imagesOf(m: Record<string, unknown>): string[] {
  const c = m.content;
  if (!Array.isArray(c)) return [];
  const out: string[] = [];
  for (const raw of c) {
    if (!raw || typeof raw !== "object") continue;
    const b = raw as Record<string, unknown>;
    if (b.type !== "image") continue;
    const src = (b.source ?? null) as Record<string, unknown> | null;
    const data = typeof src?.data === "string" ? src.data : typeof b.data === "string" ? b.data : "";
    if (!data) continue;
    if (data.startsWith("data:")) {
      out.push(data);
      continue;
    }
    const mime = (src?.media_type as string) || (b.mimeType as string) || "image/png";
    out.push(`data:${mime};base64,${data}`);
  }
  return out;
}

function textOf(m: Record<string, unknown>): string {
  const c = m.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map((p) => (p && typeof p === "object" && (p as { type?: unknown }).type === "text" ? String((p as { text?: unknown }).text ?? "") : ""))
      .filter(Boolean)
      .join("\n");
  }
  return typeof m.text === "string" ? m.text : "";
}

function ledgerOf(meta: GroupMessageMeta | null): Pick<DisplayMessage, "activity" | "unverified"> {
  return {
    ...(meta?.activity?.length ? { activity: meta.activity } : {}),
    ...(meta?.unverified?.length ? { unverified: meta.unverified } : {}),
  };
}

/** chat.history rows of a group session → attributed display messages. */
export function toDisplayMessages(raw: unknown[]): DisplayMessage[] {
  const out: DisplayMessage[] = [];
  raw.forEach((r, i) => {
    if (!r || typeof r !== "object") return;
    const m = r as Record<string, unknown>;
    const meta = (m.groupChat ?? null) as GroupMessageMeta | null;
    const role = String(m.role ?? "");
    const text = textOf(m).trim();
    const images = imagesOf(m);
    const panels = Array.isArray(meta?.panels) ? meta.panels : [];
    if (!text && images.length === 0 && panels.length === 0) return;
    const ts = typeof m.timestamp === "number" ? m.timestamp : 0;
    const id = meta?.messageId ?? `${i}-${ts}`;
    const base = { images: [] as string[], panels: [] as ChatPanelRef[] };
    if (meta?.kind === "status") {
      out.push({ ...base, id, kind: "status", text, ts, workflowRunId: meta.workflowRunId, workflowId: meta.workflowId, ...ledgerOf(meta) });
    } else if (role === "user") {
      out.push({ ...base, images, id, kind: "user", text, ts, workflowRunId: meta?.workflowRunId, workflowId: meta?.workflowId });
    } else if (role === "assistant") {
      out.push({
        id,
        kind: "agent",
        agentId: meta?.agentId,
        agentName: meta?.agentName,
        text,
        ts,
        workflowRunId: meta?.workflowRunId,
        workflowId: meta?.workflowId,
        error: meta?.error,
        ...ledgerOf(meta),
        images,
        panels,
        model: meta?.model,
      });
    }
  });
  return out;
}

/** Append live messages from `groupchat` events, deduped by id. */
export function mergeMessages(existing: DisplayMessage[], incoming: DisplayMessage[]): DisplayMessage[] {
  const seen = new Set(existing.map((m) => m.id));
  const add = incoming.filter((m) => !seen.has(m.id));
  return add.length ? [...existing, ...add] : existing;
}

/** Workflow filter: a run id shows only that run; a workflow id shows all its runs. */
export function filterMessages(
  msgs: DisplayMessage[],
  filter: { runId?: string | null; workflowId?: string | null } | null,
): DisplayMessage[] {
  if (!filter?.runId && !filter?.workflowId) return msgs;
  return msgs.filter((m) =>
    filter.runId ? m.workflowRunId === filter.runId : m.workflowId === filter.workflowId,
  );
}

// ── @mention autocomplete ───────────────────────────────────────────────

/** The `@partial` being typed at the caret, if any. */
export function mentionQueryAt(text: string, caret: number): { start: number; query: string } | null {
  const upto = text.slice(0, caret);
  const m = /(^|[\s(])@([\w-]*)$/.exec(upto);
  if (!m) return null;
  return { start: caret - m[2].length - 1, query: m[2].toLowerCase() };
}

export function suggestMembers(members: GroupMemberInfo[], query: string, max = 6): GroupMemberInfo[] {
  const q = query.toLowerCase();
  const scored = members
    .map((m) => {
      const id = m.id.toLowerCase();
      const name = m.name.toLowerCase();
      const score = !q ? 1 : id.startsWith(q) || name.startsWith(q) ? 3 : id.includes(q) || name.includes(q) ? 2 : 0;
      return { m, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  const list = scored.map((x) => x.m);
  if (!q || "all".startsWith(q) || "everyone".startsWith(q)) {
    list.push({ id: "all", name: "Everyone" });
  }
  return list.slice(0, max);
}

/** Replace the `@partial` at [start, caret) with `@id `; returns text + new caret. */
export function applyMention(text: string, start: number, caret: number, id: string): { text: string; caret: number } {
  const insert = `@${id} `;
  const next = text.slice(0, start) + insert + text.slice(caret).replace(/^\s+/, "");
  return { text: next, caret: start + insert.length };
}

/**
 * The gateway serves composer parity (model/thinking settings, attachments,
 * group slash commands) — groupchat.get only returns `settings` from a gateway
 * that has it. Older gateways silently ignore the params, so hide the controls.
 */
export function supportsComposerParity(g: Pick<GroupDescription, "settings"> | null | undefined): boolean {
  return Boolean(g && g.settings !== undefined);
}

// ── slash commands + attachments ───────────────────────────────────────

/** Group commands to suggest while the draft is a bare `/word` (no argument yet). */
export function slashSuggestions(draft: string): GroupCommandSpec[] {
  const m = /^\/([a-z-]*)$/i.exec(draft);
  return m ? suggestGroupCommands(m[1]) : [];
}

/** Composer files → chat.send / groupchat.send attachments. */
export function toApiAttachments(atts: ChatAttachment[]): Array<{
  type: "image" | "video" | "document";
  mimeType: string;
  content?: string;
  fileName?: string;
  ocrId?: string;
  filePath?: string;
}> {
  const out: Array<{
    type: "image" | "video" | "document";
    mimeType: string;
    content?: string;
    fileName?: string;
    ocrId?: string;
    filePath?: string;
  }> = [];
  for (const a of atts) {
    const m = /^data:([^;]+);base64,(.+)$/.exec(a.dataUrl);
    if (!m && !a.ocrId) continue;
    const mimeType = m?.[1] ?? a.mimeType;
    const image = mimeType.startsWith("image/");
    const video = mimeType.startsWith("video/");
    const includeContent = Boolean(
      m && ((image && (a.size ?? 0) <= 5_000_000) || !a.ocrId),
    );
    out.push({
      type: video ? "video" : image ? "image" : "document",
      mimeType,
      ...(includeContent && m ? { content: m[2] } : {}),
      ...(a.fileName ? { fileName: a.fileName } : {}),
      ...(a.ocrId ? { ocrId: a.ocrId } : {}),
      ...(a.filePath ? { filePath: a.filePath } : {}),
    });
  }
  return out;
}

/** Short label for a model ref ("openrouter/deepseek/deepseek-v4" → "deepseek-v4"). */
export function shortModel(ref: string | null | undefined): string {
  if (!ref) return "";
  const parts = ref.split("/");
  return parts[parts.length - 1] || ref;
}

export const THINKING_LABELS: Record<string, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
};

/** One-line summary of what the group runs with ("Agent defaults", "gpt-5 · High", "Mixed"). */
export function settingsSummary(g: Pick<GroupDescription, "settings" | "memberSettings"> | null): string {
  const s = g?.settings ?? {};
  const parts = [s.model ? shortModel(s.model) : "", s.thinkingLevel ? `${THINKING_LABELS[s.thinkingLevel] ?? s.thinkingLevel} thinking` : ""].filter(Boolean);
  const overrides = Object.keys(g?.memberSettings ?? {}).length;
  const head = parts.length ? parts.join(" · ") : "Agent defaults";
  return overrides ? `${head} · ${overrides} override${overrides === 1 ? "" : "s"}` : head;
}

// ── avatars ─────────────────────────────────────────────────────────────

export function agentHue(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % 360;
}

export function initials(name: string): string {
  const words = name
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .split(/[\s-]+/)
    .filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

// ── live turns ──────────────────────────────────────────────────────────

export type LiveTurn = { runId: string; agentId: string; memberKey: string; text: string; workflowRunId?: string };

/**
 * Apply a `chat` delta/final for a member session to the live-turn map.
 * Returns the same map when the event is unrelated (cheap re-render check).
 */
export function applyChatEvent(
  turns: Map<string, LiveTurn>,
  payload: { runId?: string; sessionKey?: string; state?: string; message?: unknown },
): Map<string, LiveTurn> {
  if (!payload?.runId) return turns;
  const turn = turns.get(payload.runId);
  if (!turn || (payload.sessionKey && payload.sessionKey !== turn.memberKey)) return turns;
  if (payload.state === "delta") {
    const text = textOf((payload.message ?? {}) as Record<string, unknown>);
    if (!text || text === turn.text) return turns;
    const next = new Map(turns);
    next.set(payload.runId, { ...turn, text });
    return next;
  }
  return turns;
}

export const MODE_LABELS: Record<GroupDescription["mode"], { label: string; hint: string }> = {
  everyone: { label: "Everyone replies", hint: "Each agent answers in turn and sees the others' replies." },
  "round-robin": { label: "Round robin", hint: "One agent answers per message, rotating through the group." },
  moderator: { label: "Moderator", hint: "The lead answers and @mentions others when it needs them." },
};

export function runLabel(run: WorkflowRunRecord): string {
  const done = run.steps.filter((s) => s.status === "done").length;
  const t = new Date(run.startedAt);
  const time = t.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return `${run.workflowName} · ${time} · ${run.status === "running" ? `${done}/${run.steps.length}` : run.status}`;
}

// ── per-group view state (draft / scroll / filter) ──────────────────────

export type GroupViewState = { draft: string; scrollTop: number | null; runFilter: string | null; tab: "chat" | "workflows" };

const VIEW_KEY = "infinibot.groupchat.view.";

export function loadViewState(key: string, storage: Pick<Storage, "getItem"> | null): GroupViewState {
  const empty: GroupViewState = { draft: "", scrollTop: null, runFilter: null, tab: "chat" };
  try {
    const raw = storage?.getItem(VIEW_KEY + key);
    if (!raw) return empty;
    const v = JSON.parse(raw) as Partial<GroupViewState>;
    return {
      draft: typeof v.draft === "string" ? v.draft : "",
      scrollTop: typeof v.scrollTop === "number" ? v.scrollTop : null,
      runFilter: typeof v.runFilter === "string" ? v.runFilter : null,
      tab: v.tab === "workflows" ? "workflows" : "chat",
    };
  } catch {
    return empty;
  }
}

export function saveViewState(key: string, state: GroupViewState, storage: Pick<Storage, "setItem"> | null): void {
  try {
    storage?.setItem(VIEW_KEY + key, JSON.stringify(state));
  } catch {
    /* private mode / quota */
  }
}
