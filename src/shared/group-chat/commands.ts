/**
 * Group chat slash commands — the group's version of the 1:1 chat's gateway
 * commands (/model, /think, /stop, /help) plus /mode for who replies.
 *
 * In a 1:1 chat these go straight to the agent's session. In a group the user
 * message is shared context for several agents, so the gateway handles them
 * here instead: they change the group (or one member, with an @mention) and
 * never reach the agents as text. Shared by the gateway and both composers
 * (the composers show GROUP_COMMANDS as suggestions).
 */
import type { GroupMember } from "./planner.js";
import { parseMentions } from "./planner.js";
import { GROUP_CHAT_MODES, type GroupChatMode } from "./types.js";

export type GroupCommandName = "model" | "think" | "mode" | "stop" | "help";

export type GroupCommandSpec = {
  name: GroupCommandName;
  usage: string;
  description: string;
  aliases?: string[];
};

export const GROUP_COMMANDS: readonly GroupCommandSpec[] = [
  {
    name: "model",
    usage: "/model [@agent] <provider/model | default>",
    description: "Model for every member, or one member with @agent",
    aliases: ["models"],
  },
  {
    name: "think",
    usage: "/think [@agent] <level | default>",
    description:
      "Thinking level (off, minimal, low, medium, high, xhigh) for every member, or one member",
    aliases: ["thinking", "effort", "t"],
  },
  {
    name: "mode",
    usage: "/mode <everyone|round-robin|moderator>",
    description: "Who replies to your messages",
    aliases: ["reply"],
  },
  {
    name: "stop",
    usage: "/stop",
    description: "Stop every agent that is replying",
    aliases: ["abort"],
  },
  { name: "help", usage: "/help", description: "List the group commands", aliases: ["commands"] },
];

export type ParsedGroupCommand = {
  name: GroupCommandName;
  /** Argument text with any @mention removed. */
  arg: string;
  /** Member the command targets (per-member override), when @mentioned. */
  agentId?: string;
};

const CMD_RE = /^\/([a-z][a-z-]*)(?:\s+([\s\S]*))?$/i;

/** Parse a group slash command; null when `text` isn't one (plain text, paths, unknown names). */
export function parseGroupCommand(
  text: string,
  members: GroupMember[] = [],
): ParsedGroupCommand | null {
  const m = CMD_RE.exec(text.trim());
  if (!m) return null;
  const word = m[1].toLowerCase();
  const spec = GROUP_COMMANDS.find((c) => c.name === word || c.aliases?.includes(word));
  if (!spec) return null;
  let arg = (m[2] ?? "").trim();
  let agentId: string | undefined;
  const at = /(^|\s)@([A-Za-z0-9][\w-]*)/.exec(arg);
  if (at && (spec.name === "model" || spec.name === "think")) {
    const hit = parseMentions(`@${at[2]}`, members);
    if (hit.length === 1) {
      agentId = hit[0];
      arg = `${arg.slice(0, at.index)} ${arg.slice(at.index + at[0].length)}`.trim();
    }
  }
  return { name: spec.name, arg, ...(agentId ? { agentId } : {}) };
}

export function parseModeArg(arg: string): GroupChatMode | null {
  const s = arg
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
  const alias: Record<string, GroupChatMode> = {
    all: "everyone",
    rr: "round-robin",
    roundrobin: "round-robin",
    lead: "moderator",
  };
  const mode = (alias[s] ?? s) as GroupChatMode;
  return GROUP_CHAT_MODES.includes(mode) ? mode : null;
}

export function groupCommandsHelp(): string {
  return ["Group commands:", ...GROUP_COMMANDS.map((c) => `${c.usage} — ${c.description}`)].join(
    "\n",
  );
}

/** Commands whose name starts with `prefix` (composer suggestions after "/"). */
export function suggestGroupCommands(prefix: string): GroupCommandSpec[] {
  const p = prefix.replace(/^\//, "").toLowerCase();
  return GROUP_COMMANDS.filter(
    (c) => c.name.startsWith(p) || c.aliases?.some((a) => a.startsWith(p)),
  );
}
