/**
 * Pure turn planning for agent group chats: @mention parsing, who speaks next
 * for each mode, agent→agent hand-offs and the context prompt each agent gets.
 */
import { formatActivityBlock } from "./activity.js";
import { formatUnverified } from "./truth-guard.js";
import type { GroupChatMode, GroupTranscriptMessage } from "./types.js";

export type GroupMember = { id: string; name: string };

/** Lowercase slug used to match `@Name` mentions ("Head of Dev" → "head-of-dev"). */
export function mentionSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const MENTION_RE = /(^|[^\w@])@([A-Za-z0-9][\w-]*)/g;
const EVERYONE = new Set(["all", "everyone", "here", "team"]);

/**
 * Members @mentioned in `text`, in first-mention order. `@all` / `@everyone`
 * expands to every member. Matches an agent id, its name slug, or the first
 * word of its name ("@infini" → "Infini Bot").
 */
export function parseMentions(text: string, members: GroupMember[]): string[] {
  const out: string[] = [];
  const add = (id: string) => {
    if (!out.includes(id)) out.push(id);
  };
  for (const m of text.matchAll(MENTION_RE)) {
    const token = m[2].toLowerCase().replace(/[-_]+$/, "");
    if (EVERYONE.has(token)) {
      for (const member of members) add(member.id);
      continue;
    }
    const hit =
      members.find((x) => x.id.toLowerCase() === token) ??
      members.find((x) => mentionSlug(x.name) === token) ??
      members.find((x) => mentionSlug(x.name).split("-")[0] === token);
    if (hit) add(hit.id);
  }
  return out;
}

export type RoundPlan = {
  /** Agents that reply, in order. */
  agents: string[];
  /** Updated round-robin cursor. */
  rrIndex: number;
  reason: "mention" | GroupChatMode;
};

/** Who answers a user message. @mentions override the group's mode. */
export function planRound(params: {
  text: string;
  members: GroupMember[];
  mode: GroupChatMode;
  moderatorId?: string;
  rrIndex?: number;
}): RoundPlan {
  const { members, mode } = params;
  const rr = Math.max(0, Math.floor(params.rrIndex ?? 0));
  if (members.length === 0) return { agents: [], rrIndex: rr, reason: mode };
  const mentioned = parseMentions(params.text, members);
  if (mentioned.length > 0) return { agents: mentioned, rrIndex: rr, reason: "mention" };
  if (mode === "round-robin") {
    const idx = rr % members.length;
    return { agents: [members[idx].id], rrIndex: (idx + 1) % members.length, reason: mode };
  }
  if (mode === "moderator") {
    const lead = members.find((m) => m.id === params.moderatorId) ?? members[0];
    return { agents: [lead.id], rrIndex: rr, reason: mode };
  }
  return { agents: members.map((m) => m.id), rrIndex: rr, reason: mode };
}

/** Max agent turns triggered by one user message (stops agent ping-pong). */
export const MAX_TURNS_PER_ROUND = 8;

/**
 * Agents an agent's reply hands the floor to (@mentions of other members that
 * are not already queued in this round). `@all` from an agent is ignored so a
 * single reply can't fan out to the whole room repeatedly.
 */
export function handoffsFromReply(params: {
  reply: string;
  speakerId: string;
  members: GroupMember[];
  queued: string[];
  turnsSoFar: number;
}): string[] {
  const room = MAX_TURNS_PER_ROUND - params.turnsSoFar - params.queued.length;
  if (room <= 0) return [];
  const direct = parseMentions(
    params.reply.replace(/@(all|everyone|here|team)\b/gi, ""),
    params.members,
  );
  return direct
    .filter((id) => id !== params.speakerId && !params.queued.includes(id))
    .slice(0, room);
}

const SILENT_TOKENS = ["NO_REPLY", "HEARTBEAT_OK"];

/** An agent chose to stay quiet (empty reply or a silent token). */
export function isPassReply(text: string | null | undefined): boolean {
  const t = (text ?? "").trim();
  if (!t) return true;
  return SILENT_TOKENS.some((tok) => t === tok || t.replace(/[.!\s]+$/, "") === tok);
}

export function messageText(
  msg: Pick<GroupTranscriptMessage, "content"> | null | undefined,
): string {
  if (!msg || !Array.isArray(msg.content)) return "";
  return msg.content
    .map((c) => (c && c.type === "text" && typeof c.text === "string" ? c.text : ""))
    .filter(Boolean)
    .join("\n");
}

export function speakerLabel(msg: GroupTranscriptMessage, members: GroupMember[]): string {
  const meta = msg.groupChat;
  if (msg.role === "user" && meta?.kind !== "status") return "User";
  if (meta?.kind === "status") return "System";
  const id = meta?.agentId;
  const name = meta?.agentName ?? members.find((m) => m.id === id)?.name ?? id ?? "Agent";
  return id ? `${name} (@${id})` : name;
}

/** Render transcript messages as `Speaker: text` lines, newest kept under `maxChars`. */
export function formatTranscript(
  messages: GroupTranscriptMessage[],
  members: GroupMember[],
  maxChars = 16_000,
): string {
  const lines = messages
    .map((m) => {
      const attached = m.groupChat?.attachmentContext?.trim();
      const text = [messageText(m).trim(), attached].filter(Boolean).join("\n\n");
      if (!text) return "";
      // Shared activity ledger + truthfulness flags: members see what each
      // other's tools REALLY did, not just the claims in the reply text.
      const ledger = [
        formatActivityBlock(m.groupChat?.activity),
        formatUnverified(m.groupChat?.unverified),
      ]
        .filter(Boolean)
        .join("\n");
      return `${speakerLabel(m, members)}: ${text}${ledger ? `\n${ledger}` : ""}`;
    })
    .filter(Boolean);
  const kept: string[] = [];
  let total = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const len = lines[i].length + 2;
    if (total + len > maxChars && kept.length > 0) {
      kept.unshift(`[… ${i + 1} earlier message${i === 0 ? "" : "s"} omitted]`);
      break;
    }
    kept.unshift(lines[i].length > maxChars ? `${lines[i].slice(0, maxChars - 1)}…` : lines[i]);
    total += len;
  }
  return kept.join("\n\n");
}

/** Prompt for one conversational agent turn (the agent's own session already holds earlier context). */
export function buildTurnPrompt(params: {
  groupTitle: string;
  self: GroupMember;
  members: GroupMember[];
  /** Group messages this agent has not been shown yet. */
  unseen: GroupTranscriptMessage[];
  firstTurn: boolean;
  /** Why this agent is speaking: mentioned / handed off / mode. */
  cue?: string;
}): string {
  const others = params.members
    .filter((m) => m.id !== params.self.id)
    .map((m) => `${m.name} (@${m.id})`)
    .join(", ");
  const header = params.firstTurn
    ? [
        `[Group chat "${params.groupTitle}"] You are ${params.self.name} (@${params.self.id}) in a group conversation with the user and ${others || "no other agents"}.`,
        `Speak only as yourself and only to add something useful. To hand a question to another agent, @mention them (e.g. @${params.members.find((m) => m.id !== params.self.id)?.id ?? "agent"}). If you have nothing to add, reply exactly NO_REPLY.`,
      ].join("\n")
    : `[Group chat "${params.groupTitle}"] Your turn, ${params.self.name} (@${params.self.id}).`;
  const transcript = formatTranscript(params.unseen, params.members);
  return [
    header,
    params.cue ? `(${params.cue})` : "",
    transcript
      ? `New messages in the group since your last turn:\n\n${transcript}`
      : "No new messages since your last turn.",
    "Write your reply to the group now (no speaker prefix).",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Prompt for one workflow step: its instruction plus every upstream step's output. */
export function buildStepPrompt(params: {
  groupTitle: string;
  workflowName: string;
  self: GroupMember;
  stepLabel: string;
  stepPrompt: string;
  input: string;
  upstream: Array<{ label: string; agent: GroupMember; output: string }>;
  stepIndex: number;
  stepCount: number;
}): string {
  const upstream = params.upstream
    .map(
      (u) =>
        `### ${u.label} — ${u.agent.name} (@${u.agent.id})\n${u.output.trim() || "(no output)"}`,
    )
    .join("\n\n");
  return [
    `[Workflow "${params.workflowName}" in group chat "${params.groupTitle}" — step ${params.stepIndex}/${params.stepCount}: ${params.stepLabel}]`,
    `You are ${params.self.name} (@${params.self.id}).`,
    params.input.trim() ? `Workflow input from the user:\n${params.input.trim()}` : "",
    `Your task for this step:\n${params.stepPrompt.trim() || `Carry out the "${params.stepLabel}" step.`}`,
    upstream
      ? `Output handed to you from the previous step(s):\n\n${upstream}`
      : "You are the first step; there is no upstream output.",
    "Reply with your complete output for this step — it is passed to the next step verbatim.",
  ]
    .filter(Boolean)
    .join("\n\n");
}
