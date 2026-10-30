import type { ReasoningLevel, ThinkLevel } from "../auto-reply/thinking.js";
import { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import { listDeliverableMessageChannels } from "../utils/message-channel.js";
import type { ResolvedTimeFormat } from "./date-time.js";
import type { EmbeddedContextFile } from "./pi-embedded-helpers.js";
import { buildIdentityFrame, isIdentityContextFile } from "./identity-frame.js";
import { buildActiveProfileContextBlock } from "../users/profile-context.js";
import { docsUrl } from "../help/docs-urls.js";
import { isCoreToolSlotFilled } from "../plugins/core-tool-slots.js";
import { infinibotExpertPromptLines } from "../infinibot-knowledge/prompt.js";

/**
 * Controls which hardcoded sections are included in the system prompt.
 * - "full": All sections (default, for main agent)
 * - "minimal": Reduced sections (Tooling, Workspace, Runtime) - used for subagents
 * - "none": Just basic identity line, no sections
 */
export type PromptMode = "full" | "minimal" | "none";

// ── Agent Specialization Context ─────────────────────────────────
/**
 * Describes an agent's profile for system prompt injection.
 */
export interface AgentProfile {
  id: string;
  name: string;
  specialties: string[];
  tools?: string[];
  mcp?: string[];
  description?: string;
}

/**
 * Describes a delegation step in the chain.
 */
export interface DelegationStep {
  fromAgent: string;
  toAgent: string;
  taskId?: string;
  reason?: string;
}

/**
 * Context about agents to inject into system prompts.
 */
export interface AgentContextParams {
  /** The current agent's profile. */
  currentAgent?: AgentProfile;
  /** All available agents in the system. */
  availableAgents?: AgentProfile[];
  /** Current delegation chain (if this agent was delegated to). */
  delegationChain?: DelegationStep[];
}

function buildAgentContextSection(params: {
  agentContext?: AgentContextParams;
  isMinimal: boolean;
}): string[] {
  const ctx = params.agentContext;
  if (!ctx) return [];

  // Only include when there are actual agents configured
  const agents = ctx.availableAgents ?? [];
  const current = ctx.currentAgent;
  if (!current && agents.length === 0) return [];

  const lines: string[] = [];

  // Current agent identity (always include if available)
  if (current) {
    lines.push("## Your Agent Identity");
    lines.push(`Agent ID: ${current.id} | Name: ${current.name}`);
    if (current.specialties.length > 0) {
      lines.push(`Specialties: ${current.specialties.join(", ")}`);
    }
    if (current.tools && current.tools.length > 0) {
      lines.push(`Available tools: ${current.tools.join(", ")}`);
    }
    if (current.mcp && current.mcp.length > 0) {
      lines.push(`MCP protocols: ${current.mcp.join(", ")}`);
    }
    lines.push("");
  }

  // Available agents for delegation (skip in minimal mode to save tokens)
  if (!params.isMinimal && agents.length > 1) {
    lines.push("## Available Agents");
    for (const agent of agents) {
      if (agent.id === current?.id) continue; // Skip self
      const specStr = agent.specialties.length > 0 ? ` — ${agent.specialties.join(", ")}` : "";
      const desc = agent.description ? ` (${agent.description})` : "";
      lines.push(`- **${agent.id}** (${agent.name})${specStr}${desc}`);
    }
    lines.push("");
    lines.push("## Delegation");
    lines.push("When a task falls outside your specialties, delegate to a better-suited agent:");
    lines.push("1. Evaluate which agent's specialties best match the task");
    lines.push('2. Use sessions_spawn({ agentId: "<id>", task: "description" }) to delegate');
    lines.push("3. Include requiredSpecialties in the task description");
    lines.push("4. The agent will update task status via MCP when complete");
    lines.push("");
  }

  // Delegation chain context (include even in minimal mode — subagents need this)
  const chain = ctx.delegationChain;
  if (chain && chain.length > 0) {
    lines.push("## Delegation Chain");
    lines.push("This task was delegated through the following chain:");
    for (const step of chain) {
      const reason = step.reason ? ` (${step.reason})` : "";
      const task = step.taskId ? ` [task:${step.taskId}]` : "";
      lines.push(`- ${step.fromAgent} → ${step.toAgent}${task}${reason}`);
    }
    lines.push("Report results back up the chain when complete.");
    lines.push("");
  }

  return lines;
}

function buildSkillsSection(params: {
  skillsPrompt?: string;
  isMinimal: boolean;
  readToolName: string;
}) {
  if (params.isMinimal) return [];
  const trimmed = params.skillsPrompt?.trim();
  if (!trimmed) return [];
  return [
    "## Skills (mandatory)",
    "Before replying: scan <available_skills> <description> entries.",
    `- If exactly one skill clearly applies: read its SKILL.md at <location> with \`${params.readToolName}\`, then follow it.`,
    "- If multiple could apply: choose the most specific one, then read/follow it.",
    "- If none clearly apply: do not read any SKILL.md.",
    "Constraints: never read more than one skill up front; only read after selecting.",
    trimmed,
    "",
  ];
}

function buildMemorySection(params: { isMinimal: boolean; availableTools: Set<string> }) {
  if (params.isMinimal) return [];
  if (!params.availableTools.has("memory_search") && !params.availableTools.has("memory_get")) {
    return [];
  }
  return [
    "## Memory Recall",
    "Before answering anything about prior work, decisions, dates, people, preferences, or todos: run memory_search on MEMORY.md + memory/*.md; then use memory_get to pull only the needed lines. If low confidence after search, say you checked.",
    "",
  ];
}

/**
 * FlyPic (first-party plugin) is the image/video generation backend. Shown only
 * when the agent actually has the FlyPic tools (plugin enabled + allowlisted),
 * so it rides along with the tools instead of a persona-prompt refresh.
 */
function buildMediaGenerationSection(availableTools: Set<string>) {
  if (
    !availableTools.has("flypic_generate_image") &&
    !availableTools.has("flypic_generate_video")
  ) {
    return [];
  }
  return [
    "## Image & Video Generation (FlyPic)",
    "To generate or edit images/videos, use flypic_generate_image / flypic_generate_video / flypic_edit_media; call flypic_list_models first to pick a model. Generation runs on the FlyPic account's own provider keys.",
    "If a FlyPic tool returns code provider_setup_required, relay its `userMessage` to the user verbatim (they must add that provider's API key in their FlyPic account) and do not retry the same model; offer another model from flypic_list_models instead.",
    "If it returns not_connected, tell the user to click Connect FlyPic (Plugins › FlyPic, or the card in chat) once; if it returns plan_required, share its upgradeUrl. Never ask the user for a FlyPic API key.",
    "Reference photos: whenever the user supplies or asks to use a reference photo (a person, outfit, product or style), pass it in referenceUrls (startImageUrl for video) and pick a model with acceptsReference: true in flypic_list_models (Soul 2, Qwen Image 3, Marketing Studio, Nano Banana…). Never run it on a text-only model such as Higgsfield Soul, and never fold the reference into the text prompt. If the result has referenceModel/note, tell the user which model was used; if it returns reference_model_required, retry with one of its referenceCapableModels.",
    ...(availableTools.has("flypic_find_reference")
      ? [
          "To find a reference photo for a name or description, call flypic_find_reference (live image search in the user's browser via the relay, plus their FlyPic library) and pass its referenceUrls on. Don't use web search or web fetch for images — image hosts block them.",
        ]
      : []),
    "",
  ];
}

function buildWebResearchSection(availableTools: Set<string>) {
  if (!availableTools.has("web_search") && !availableTools.has("web_read")) {
    return [];
  }
  return [
    "## Web, News & Research",
    'To look up anything current — news, a topic, a person/company, "latest X", prices, docs, or social posts — USE web_search (keyless, no API key needed), then web_read / web_fetch to open the best results, and summarize with source links. Never claim you lack a tool or need an API key for a web, news, or social lookup — you have web_search.',
    "Twitter/X, Reddit, Hacker News and similar: you can't read a logged-in live feed, but you CAN web_search the topic (e.g. \"latest AI news\", optionally adding site:x.com or the word twitter) and web_read the top results. Do that and give the user the findings — don't refuse or tell them to run the search themselves.",
    "Only ask for a key or login for a site that genuinely requires authenticated access; general web/news research never does.",
    "",
  ];
}

function buildUserIdentitySection(ownerLine: string | undefined, isMinimal: boolean) {
  if (!ownerLine || isMinimal) return [];
  return ["## User Identity", ownerLine, ""];
}

function buildTimeSection(params: { userTimezone?: string }) {
  if (!params.userTimezone) return [];
  return ["## Current Date & Time", `Time zone: ${params.userTimezone}`, ""];
}

function buildReplyTagsSection(isMinimal: boolean) {
  if (isMinimal) return [];
  return [
    "## Reply Tags",
    "To request a native reply/quote on supported surfaces, include one tag in your reply:",
    "- [[reply_to_current]] replies to the triggering message.",
    "- [[reply_to:<id>]] replies to a specific message id when you have it.",
    "Whitespace inside the tag is allowed (e.g. [[ reply_to_current ]] / [[ reply_to: 123 ]]).",
    "Tags are stripped before sending; support depends on the current channel config.",
    "",
  ];
}

function buildMessagingSection(params: {
  isMinimal: boolean;
  availableTools: Set<string>;
  messageChannelOptions: string;
  inlineButtonsEnabled: boolean;
  runtimeChannel?: string;
  messageToolHints?: string[];
}) {
  if (params.isMinimal) return [];
  return [
    "## Messaging",
    "- Reply in current session → automatically routes to the source channel (Signal, Telegram, etc.)",
    "- Cross-session messaging → use sessions_send(sessionKey, message)",
    "- Never use exec/curl for provider messaging; InfiniBot handles all routing internally.",
    params.availableTools.has("message")
      ? [
          "",
          "### message tool",
          "- Use `message` for proactive sends + channel actions (polls, reactions, etc.).",
          "- For `action=send`, include `to` and `message`.",
          `- If multiple channels are configured, pass \`channel\` (${params.messageChannelOptions}).`,
          `- If you use \`message\` (\`action=send\`) to deliver your user-visible reply, respond with ONLY: ${SILENT_REPLY_TOKEN} (avoid duplicate replies).`,
          params.inlineButtonsEnabled
            ? "- Inline buttons supported. Use `action=send` with `buttons=[[{text,callback_data}]]` (callback_data routes back as a user message)."
            : params.runtimeChannel
              ? `- Inline buttons not enabled for ${params.runtimeChannel}. If you need them, ask to set ${params.runtimeChannel}.capabilities.inlineButtons ("dm"|"group"|"all"|"allowlist").`
              : "",
          ...(params.messageToolHints ?? []),
        ]
          .filter(Boolean)
          .join("\n")
      : "",
    "",
  ];
}

function buildVoiceSection(params: { isMinimal: boolean; ttsHint?: string }) {
  if (params.isMinimal) return [];
  const hint = params.ttsHint?.trim();
  if (!hint) return [];
  return ["## Voice (TTS)", hint, ""];
}

function buildDocsSection(params: { docsPath?: string; isMinimal: boolean; readToolName: string }) {
  const docsPath = params.docsPath?.trim();
  if (!docsPath || params.isMinimal) return [];
  return [
    "## Documentation",
    `InfiniBot docs: ${docsPath}`,
    `Mirror: ${docsUrl("/")}`,
    "Community: https://discord.com/invite/clawd",
    "Find new skills: https://clawdhub.com",
    "For InfiniBot behavior, commands, config, or architecture: consult local docs first.",
    "When diagnosing issues, run `infinibot status` yourself when possible; only ask the user if you lack access (e.g., sandboxed).",
    "",
  ];
}

export function buildAgentSystemPrompt(params: {
  workspaceDir: string;
  defaultThinkLevel?: ThinkLevel;
  reasoningLevel?: ReasoningLevel;
  extraSystemPrompt?: string;
  ownerNumbers?: string[];
  reasoningTagHint?: boolean;
  toolNames?: string[];
  toolSummaries?: Record<string, string>;
  modelAliasLines?: string[];
  userTimezone?: string;
  userTime?: string;
  userTimeFormat?: ResolvedTimeFormat;
  contextFiles?: EmbeddedContextFile[];
  skillsPrompt?: string;
  heartbeatPrompt?: string;
  docsPath?: string;
  workspaceNotes?: string[];
  ttsHint?: string;
  /** Controls which hardcoded sections to include. Defaults to "full". */
  promptMode?: PromptMode;
  runtimeInfo?: {
    agentId?: string;
    host?: string;
    os?: string;
    arch?: string;
    node?: string;
    model?: string;
    defaultModel?: string;
    channel?: string;
    capabilities?: string[];
    repoRoot?: string;
  };
  messageToolHints?: string[];
  sandboxInfo?: {
    enabled: boolean;
    workspaceDir?: string;
    workspaceAccess?: "none" | "ro" | "rw";
    agentWorkspaceMount?: string;
    browserBridgeUrl?: string;
    browserNoVncUrl?: string;
    hostBrowserAllowed?: boolean;
    elevated?: {
      allowed: boolean;
      defaultLevel: "on" | "off" | "ask" | "full";
    };
  };
  /** Reaction guidance for the agent (for Telegram minimal/extensive modes). */
  reactionGuidance?: {
    level: "minimal" | "extensive";
    channel: string;
  };
  /**
   * Custom system prompt from config (agents.defaults.systemPrompt).
   * When set and not "default", replaces the entire built-in prompt.
   * The custom prompt will still have context files appended.
   */
  customSystemPrompt?: string;
  /**
   * Agent specialization context. When provided, injects agent identity,
   * available agents for delegation, and delegation chain into the prompt.
   * Only included when relevant (similar to skillsPrompt).
   */
  agentContext?: AgentContextParams;
  /**
   * Federation topology context. When provided, injects available federation
   * nodes and cross-node spawning/messaging capabilities into the prompt.
   * Should be pre-built using buildFederationContextForPromptMode().
   */
  federationContext?: string;
}) {
  // Check for custom system prompt override from config
  const customPrompt = params.customSystemPrompt?.trim();
  if (customPrompt && customPrompt.toLowerCase() !== "default") {
    // Per-turn extra context (subagent details, OpenAI-compat system messages,
    // external voice calls) must survive a custom prompt — it used to be dropped.
    const extra = params.extraSystemPrompt?.trim();
    const extraBlock = extra
      ? [
          (params.promptMode ?? "full") === "minimal"
            ? "## Subagent Context"
            : "## Group Chat Context",
          extra,
        ]
      : [];
    // Use custom prompt but still append context files if present
    const contextFiles = params.contextFiles ?? [];
    if (contextFiles.length === 0) {
      return [customPrompt, ...extraBlock].join("\n\n");
    }
    // A custom prompt (per-agent systemPrompt, AnKHu's research persona) is the
    // ROLE. When the workspace declares an identity it opens the prompt and the
    // custom prompt is folded in beneath it, so a task persona can no longer
    // overwrite who is speaking.
    const identityFrame = buildIdentityFrame({ contextFiles, role: customPrompt });
    const rest = identityFrame
      ? contextFiles.filter((f) => !isIdentityContextFile(f))
      : contextFiles;
    const lines = identityFrame ? [identityFrame] : [customPrompt, ""];
    if (rest.length > 0) {
      lines.push("# Project Context", "");
      for (const file of rest) {
        lines.push(`## ${file.path}`, "", file.content, "");
      }
    }
    if (extraBlock.length) lines.push(extraBlock[0], extraBlock[1]);
    return lines.filter(Boolean).join("\n");
  }

  const coreToolSummaries: Record<string, string> = {
    read: "Read file contents",
    write: "Create or overwrite files",
    edit: "Make precise edits to files",
    apply_patch: "Apply multi-file patches",
    grep: "Search file contents for patterns",
    find: "Find files by glob pattern",
    ls: "List directory contents",
    exec: "Run shell commands (pty available for TTY-required CLIs)",
    process: "Manage background exec sessions",
    web_search: "Search the web (works with no API key; returns title/url/snippet)",
    web_fetch: "Fetch and extract readable content from a URL",
    web_read: "Read any public page as clean markdown (Jina Reader, no key)",
    web_image_search: "Find images on the web; returns direct image URLs (no key)",
    youtube_transcript: "Get a YouTube video's transcript (yt-dlp)",
    github_read: "Read a GitHub repo README, file, or issue/PR (no setup)",
    rss_read: "Read the latest items of an RSS/Atom feed",
    // Channel docking: add login tools here when a channel needs interactive linking.
    browser: "Control web browser",
    canvas: "Present/eval/snapshot the Canvas",
    nodes: "List/describe/notify/camera/screen on paired nodes",
    cron: "Manage cron jobs and wake events (use for reminders; when scheduling a reminder, write the systemEvent text as something that will read like a reminder when it fires, and mention that it is a reminder depending on the time gap between setting and firing; include recent context in reminder text if appropriate)",
    message: "Send messages and channel actions",
    gateway:
      "Restart, apply config, or run updates on the running InfiniBot process. NEVER stop — only restart. Stopping kills you permanently.",
    agents_list: "List agent ids allowed for sessions_spawn",
    sessions_list: "List other sessions (incl. sub-agents) with filters/last",
    sessions_history: "Fetch history for another session/sub-agent",
    sessions_send: "Send a message to another session/sub-agent",
    sessions_spawn: "Spawn a sub-agent session",
    session_status:
      "Show a /status-equivalent status card (usage + time + Reasoning/Verbose/Elevated); use for model-use questions (📊 session_status); optional per-session model override",
    image: "Analyze an image with the configured image model",
    show_panel:
      "Answer with a LIVE interactive UI panel in the chat instead of a text dump. Use it when the user asks to see / show / pull up something or asks the status of a project, task, agent run or the business: kinds mesh (live agent map), project, task (status changeable), agent, agents, business (needs-attention, clients, opportunities, invoices), clients, opportunities, table (your own rows). Then reply in one or two sentences from its `summary`; on Telegram/WhatsApp reply with its `text`.",
  };

  const toolOrder = [
    "read",
    "write",
    "edit",
    "apply_patch",
    "grep",
    "find",
    "ls",
    "exec",
    "process",
    "web_search",
    "web_fetch",
    "web_read",
    "web_image_search",
    "youtube_transcript",
    "github_read",
    "rss_read",
    "browser",
    "nodes",
    "cron",
    "message",
    "gateway",
    "agents_list",
    "sessions_list",
    "sessions_history",
    "sessions_send",
    "session_status",
    "image",
  ];

  const rawToolNames = (params.toolNames ?? []).map((tool) => tool.trim());
  const canonicalToolNames = rawToolNames.filter(Boolean);
  // Preserve caller casing while deduping tool names by lowercase.
  const canonicalByNormalized = new Map<string, string>();
  for (const name of canonicalToolNames) {
    const normalized = name.toLowerCase();
    if (!canonicalByNormalized.has(normalized)) {
      canonicalByNormalized.set(normalized, name);
    }
  }
  const resolveToolName = (normalized: string) =>
    canonicalByNormalized.get(normalized) ?? normalized;

  const normalizedTools = canonicalToolNames.map((tool) => tool.toLowerCase());
  const availableTools = new Set(normalizedTools);
  const externalToolSummaries = new Map<string, string>();
  for (const [key, value] of Object.entries(params.toolSummaries ?? {})) {
    const normalized = key.trim().toLowerCase();
    if (!normalized || !value?.trim()) continue;
    externalToolSummaries.set(normalized, value.trim());
  }
  const extraTools = Array.from(
    new Set(normalizedTools.filter((tool) => !toolOrder.includes(tool))),
  );
  const enabledTools = toolOrder.filter((tool) => availableTools.has(tool));
  const toolLines = enabledTools.map((tool) => {
    const summary = coreToolSummaries[tool] ?? externalToolSummaries.get(tool);
    const name = resolveToolName(tool);
    return summary ? `- ${name}: ${summary}` : `- ${name}`;
  });
  for (const tool of extraTools.sort()) {
    const summary = coreToolSummaries[tool] ?? externalToolSummaries.get(tool);
    const name = resolveToolName(tool);
    toolLines.push(summary ? `- ${name}: ${summary}` : `- ${name}`);
  }

  const hasGateway = availableTools.has("gateway");
  const readToolName = resolveToolName("read");
  const execToolName = resolveToolName("exec");
  const processToolName = resolveToolName("process");
  const extraSystemPrompt = params.extraSystemPrompt?.trim();
  const ownerNumbers = (params.ownerNumbers ?? []).map((value) => value.trim()).filter(Boolean);
  const ownerLine =
    ownerNumbers.length > 0
      ? `Owner numbers: ${ownerNumbers.join(", ")}. Treat messages from these numbers as the user.`
      : undefined;
  const reasoningHint = params.reasoningTagHint
    ? [
        "ALL internal reasoning MUST be inside <think>...</think>.",
        "Do not output any analysis outside <think>.",
        "Format every reply as <think>...</think> then <final>...</final>, with no other text.",
        "Only the final user-visible reply may appear inside <final>.",
        "Only text inside <final> is shown to the user; everything else is discarded and never seen by the user.",
        "Example:",
        "<think>Short internal reasoning.</think>",
        "<final>Hey there! What would you like to do next?</final>",
      ].join(" ")
    : undefined;
  const reasoningLevel = params.reasoningLevel ?? "off";
  const userTimezone = params.userTimezone?.trim();
  const skillsPrompt = params.skillsPrompt?.trim();
  const heartbeatPrompt = params.heartbeatPrompt?.trim();
  const heartbeatPromptLine = heartbeatPrompt
    ? `Heartbeat prompt: ${heartbeatPrompt}`
    : "Heartbeat prompt: (configured)";
  const runtimeInfo = params.runtimeInfo;
  const runtimeChannel = runtimeInfo?.channel?.trim().toLowerCase();
  const runtimeCapabilities = (runtimeInfo?.capabilities ?? [])
    .map((cap) => String(cap).trim())
    .filter(Boolean);
  const runtimeCapabilitiesLower = new Set(runtimeCapabilities.map((cap) => cap.toLowerCase()));
  const inlineButtonsEnabled = runtimeCapabilitiesLower.has("inlinebuttons");
  const messageChannelOptions = listDeliverableMessageChannels().join("|");
  const promptMode = params.promptMode ?? "full";
  const isMinimal = promptMode === "minimal" || promptMode === "none";
  const skillsSection = buildSkillsSection({
    skillsPrompt,
    isMinimal,
    readToolName,
  });
  const agentContextSection = buildAgentContextSection({
    agentContext: params.agentContext,
    isMinimal,
  });
  const memorySection = buildMemorySection({ isMinimal, availableTools });
  const docsSection = buildDocsSection({
    docsPath: params.docsPath,
    isMinimal,
    readToolName,
  });
  const workspaceNotes = (params.workspaceNotes ?? []).map((note) => note.trim()).filter(Boolean);

  // Layer-1 operator context for the ACTIVE profile (role / goals / languages /
  // notes). Empty string when no operator context is set — single-profile
  // installs see no change. Prepended above the identity line so it frames the
  // whole prompt across every channel that uses this builder.
  const profileContextSection = buildActiveProfileContextBlock();

  // For "none" mode, return just the basic identity line (+ operator context).
  if (promptMode === "none") {
    const frame = buildIdentityFrame({ contextFiles: params.contextFiles ?? [] });
    const opening = frame ?? "You are a personal assistant running inside InfiniBot.";
    return profileContextSection ? `${profileContextSection}\n\n${opening}` : opening;
  }

  // Identity first when the workspace declares one; the generic product line
  // is the fallback for a default install that declares none.
  const identityFrame = buildIdentityFrame({ contextFiles: params.contextFiles ?? [] });
  const lines = [
    ...(profileContextSection ? [profileContextSection, ""] : []),
    identityFrame ?? "You are a personal assistant running inside InfiniBot.",
    "",
    "## Tooling",
    "Tool availability (filtered by policy):",
    "Tool names are case-sensitive. Call tools exactly as listed.",
    toolLines.length > 0
      ? toolLines.join("\n")
      : [
          "Pi lists the standard tools above. This runtime enables:",
          "- grep: search file contents for patterns",
          "- find: find files by glob pattern",
          "- ls: list directory contents",
          "- apply_patch: apply multi-file patches",
          `- ${execToolName}: run shell commands (supports background via yieldMs/background)`,
          `- ${processToolName}: manage background exec sessions`,
          "- browser: control clawd's dedicated browser",
          "- canvas: present/eval/snapshot the Canvas",
          "- nodes: list/describe/notify/camera/screen on paired nodes",
          "- cron: manage cron jobs and wake events (use for reminders; when scheduling a reminder, write the systemEvent text as something that will read like a reminder when it fires, and mention that it is a reminder depending on the time gap between setting and firing; include recent context in reminder text if appropriate)",
          "- sessions_list: list sessions",
          "- sessions_history: fetch session history",
          "- sessions_send: send to another session",
          "- kanban: Manage kanban board tasks and projects. Actions: create_task (create a new task), update_task (update status/description/assignee), list_tasks (list tasks with optional filters), list_projects (list all projects), create_project (always include project_directory for code work), update_project (use directory=<abs path> to bind a project to a local repo — auto-creates a Project-directory file link). Valid statuses: backlog, todo, in_progress, review, done. Valid priorities: low, medium, high, critical.",
        ].join("\n"),
    "TOOLS.md does not control tool availability; it is user guidance for how to use external tools.",
    "Only call tools that are listed above — never invent one (write_file, read_file, create_file, send_email…) and never say an action happened (a file written, a message sent, code run) unless a tool call actually did it. If a request needs a capability you don't have, say so plainly in one sentence and offer the closest thing you can do with the tools you do have. When a tool or the model provider returns an error, explain it in plain words with the next step — never paste raw JSON or stack traces to the user.",
    "If a task is more complex or takes longer, spawn a sub-agent. It will work in the background and ping you on completion. Do NOT poll subagents_list in a loop while waiting — that burns context for no gain. Only call subagents_list when the user asks for status, or when a specific run has clearly stalled. When you do call it, leave it in its default (compact) mode and pass back the serverTime as `since` on subsequent calls so you only see what changed.",
    "",
    "## Funnel Canvas API (gateway)",
    "When the user asks for a customer journey, sales funnel, or lead-flow diagram, build it as a flow map on the canvas — it appears live in the InfiniBot UI's Funnels tab. Use the `gateway` tool to invoke these methods. The canvas IS the funnel — promote a flow map to start tracking real leads + analytics. `businessId` is the compatibility name for the authoritative Agency OS `agencyId`; always use an agency the current operator or employee is authorized to access.",
    "",
    "**Agency operating truth:**",
    "- `agency.ops.funnels.overview({ agencyId })` returns the canonical core funnel, connected sub-funnels, live nodes/edges, connection health, KPI readings, setup percentage, health score and detected gaps.",
    "- `agency.ops.funnels.context({ agencyId })` returns concise agent-readable operating context. Read it before proposing or executing funnel work so you act on current gaps instead of assumptions.",
    "- `agency.ops.funnels.health.check({ agencyId })` refreshes declared connection checks and gap detection. Use it when asked whether the system is actually ready.",
    "- Treat critical/high gaps and disconnected required integrations as blockers. Create or assign accountable work instead of claiming the funnel is production-ready.",
    "",
    "**AI employee operating loop:**",
    "- `agency.ops.employee.inbox.list({ agencyId, workerId? })` is the durable employee inbox. Read it before starting agency work; do not invent assignments from chat context alone.",
    "- Work items follow `queued -> accepted -> in_progress -> review -> completed`, with explicit waiting, cancellation and escalation branches. Use `agency.ops.employee.work-item.transition` and never skip required review or approval states.",
    "- `agency.ops.employee.schedules.list`, `.responsibilities.list` and `.reviews.list` define working hours, recurring duties and manager accountability. Respect schedules and surface due/overdue reviews.",
    "- `agency.ops.employee.memory.list({ agencyId, workerId, namespace? })` is durable job memory. Store concise, attributable operating facts with `.memory.upsert`; never store secrets or use memory to bypass current permissions.",
    "- `agency.ops.employee.loop.tick({ agencyId })` generates due recurring work, escalates SLA breaches and marks reviews due. The gateway now runs this loop automatically for every agency on a cron cadence, so treat the inbox as already current: tick only when you need an immediate refresh, and never assume nothing happened just because you did not tick.",
    "- `agency.ops.employee.update({ agencyId, workerId, ... })` edits a worker (name, role, department, manager, capacity, persona, model binding, autonomy). `agency.ops.employee.deactivate` retires one without deleting its history. Both are owner/admin only — propose the change and let the operator confirm rather than reorganising the workforce on your own initiative.",
    "- Database backup/restore RPCs are owner/admin controls. Never activate a restore autonomously; require the operator to stage it and type the exact confirmation shown by the system.",
    "",
    "**Read:**",
    "- `funnels.flowmap.list({ businessId? })` → `{ flowMaps: FlowMap[] }`. List saved canvases for a business (or all).",
    "- `funnels.flowmap.get({ id? | businessId? })` → `{ flowMap }`. Load a specific canvas.",
    "- `funnels.flow.snapshot({ funnelId })` → `{ funnel, sources, stages, outcomes }`. Real-time analytics: lead counts per stage, qualified/unqualified/pending breakdown, sources rollup (which form/page drove each lead), outcomes (won/lost/promotedToCrm).",
    "",
    "**Write:**",
    "- `funnels.flowmap.save({ id?, name, businessId, nodes, connections, funnelId? })` → `{ flowMap }`. Upsert. Pass an id to update a specific canvas; omit for a new one.",
    "- `funnels.flowmap.delete({ id })` → `{ deleted }`. Drop a saved canvas.",
    "- `funnels.flowmap.promote({ flowMapId, funnelName?, funnelType? })` → `{ flowMap, funnel }`. Materializes the canvas as a live funnel record + one stage per node. Idempotent — re-promoting reuses the bound funnel.",
    "- `funnels.form.bind({ formId, businessId, funnelId, entryStageId, tag? })` → binds a published form to a funnel's entry stage so submissions create leads in the right place.",
    "",
    "**Production node taxonomy (libraryId for each canvas node):**",
    "- Sources: `instagram` `tiktok` `youtube` `twitter` `linkedin` `paid_ad` `referral` `organic_search` `cold_outreach`",
    "- Capture: `lead_magnet` `newsletter_signup` `quiz` `calendar_booking` `webinar_reg`",
    "- Qualify: `lead_scorer` `manual_review` `tag_route`",
    "- Nurture: `email_seq` `sms_seq` `dm_followup` `retargeting_ad` `drip_course`",
    "- Convert: `sales_page` `checkout` `discovery_call` `application_form` `tripwire`",
    "- Destinations: `course_community` `membership_tier` `coaching_program` `dfy_service` `affiliate_hub`",
    "- Outcomes: `won` `lost` `promoted_to_crm`",
    "",
    "**FlowNode shape** (minimum fields): `{ id, type, libraryId, name, row, column }`. Promote maps sources → entry stage, terminals → exit stage, everything else → standard.",
    "**FlowConnection**: `{ id, from, to, label? }` — `from`/`to` are node ids.",
    "",
    '**Workflow for "build me a coaching funnel for X":**',
    "  1. Resolve the businessId (use `business.list` if unknown).",
    "  2. Compose flow map with library-tagged nodes — keep canvas order = funnel flow order. Source first, terminal last.",
    "  3. Call `funnels.flowmap.save` to persist the draft.",
    "  4. Call `funnels.flowmap.promote` to go live. The returned flowMap has the funnelId and each node has its stageId.",
    "  5. If the user has a form/landing page to wire in, call `funnels.form.bind` with the entry stage's id.",
    "  6. Reply with a one-line summary + the funnel id. The user can open the Funnels tab to see the canvas + live analytics.",
    "",
    "Never generate a static image of a funnel — the canvas is the source of truth and supports live lead tracking once promoted.",
    "",
    "## Products Catalog API (gateway)",
    "When the user asks to add, edit, or look up a product (digital or physical), use `gateway` to call these methods. The catalog is per-business and feeds the /products page, Notion sync, and the /databases page (products is a mapped system role).",
    "",
    "**Read:**",
    "- `products.list({ businessId, query?, type?, status?, category?, limit?, offset? })` → `{ products: Product[], count }`. Searches name / SKU / description / tags. type ∈ digital | physical | service | bundle | subscription. status ∈ active | draft | out_of_stock | archived.",
    "- `products.get({ id, businessId })` → `{ product }`.",
    "",
    "**Write:**",
    "- `products.create({ businessId, name, sku?, type?, status?, price?, cost?, inventory?, description?, image?, gallery?, category?, tags?, vendor?, weight?, dimensions?, downloadUrl?, licenseKeyPattern?, stripeProductId?, externalUrl? })` → `{ product }`. Auto-bootstraps the per-business products database on first call.",
    "- `products.update({ id, businessId, ...patch })` → `{ product }`. PATCH semantics — only fields in the patch get touched, unspecified fields are preserved.",
    "- `products.delete({ id, businessId })` → `{ deleted }`.",
    "",
    "**Type → relevant fields:**",
    "- `digital` / `subscription` — `downloadUrl`, `licenseKeyPattern`",
    "- `physical` — `inventory`, `weight`, `dimensions`, `vendor`",
    "- `service` — `description`, `price` (per-hour or flat)",
    "- `bundle` — references multiple children via tags/category",
    "",
    '**Workflow for "add a new product" / "update inventory" / "list our digital products":**',
    "  1. Resolve businessId (use `business.list` if unknown).",
    "  2. For new products: call `products.create` with at minimum `name`. The user can refine in the /products inspector after.",
    "  3. For updates: call `products.get` first if you need current state, otherwise just send a partial patch.",
    "  4. Reply with the product id + a one-line confirmation. The user can open the /products tab to view the gallery/list.",
    "",
    'Products are a mapped system role, so the same data also surfaces under /databases and through Notion sync when the user maps a Notion database via `db.system.set({ role: "products", databaseId })`.',
    "",
    // Discipline plugin: only while it fills the `discipline` tool slot.
    ...(isCoreToolSlotFilled("discipline")
      ? [
          "## Discipline Tool (/discipline page)",
          "Use the `discipline` tool to manage the user's daily time-block schedule, routines, completions, settings, scores, and saved templates. Every change appears live on the /discipline page on next state-poll.",
          "",
          '**Time format:** start / end accept either `"HH:MM"` (e.g. `"09:30"`) or raw minutes-from-midnight (e.g. `570`). `days` is an array of 0..6 (0=Sun, 6=Sat); omit for daily.',
          "",
          "**Block actions:** `list_blocks` (always do this first to discover ids before editing), `get_block`, `create_block`, `update_block` (PATCH — only set keys are changed), `delete_block`, `complete_block`, `uncomplete_block`, `reset_overrides`. routineItems can be passed as plain strings — they get normalized to `{id, label, order}`.",
          "",
          "**Task / project assignment:** `assign_project({ id, projectId })`, `assign_task({ id, taskId })`, `clear_assignment({ id })`. Use kanban tool's list_projects / list_tasks first to discover ids.",
          "",
          "**Activity logs:** `list_logs`, `create_log` (source = manual | planned | probe | abort), `update_log`, `delete_log`.",
          "",
          "**Settings + scoring:** `get_settings`, `update_settings({ militant?, probeIntervalMin?, dayStartHour?, dayEndHour? })`, `score_day({ date? })`, `score_week({ endDate? })`.",
          "",
          "**Templates (save / restore the whole schedule):**",
          "- `save_template({ name, description? })` — snapshots the CURRENT live blocks as a reusable template. Returns `{ template: { id, name, blockCount } }`.",
          "- `list_templates` — read all saved templates with block counts.",
          "- `apply_template({ templateId })` — REPLACES the live schedule with the template's blocks. Idempotent.",
          "- `delete_template({ templateId })` / `update_template({ templateId, name?, description?, blocks? })`.",
          "",
          "**Standard workflows:**",
          '- "Set up my morning routine" → list current blocks, design the day, create_block for each segment with start/end + routineItems.',
          '- "Save this as my workday template" → save_template({ name: "Workday" }).',
          '- "Restore my weekend schedule" → list_templates → apply_template({ templateId }).',
          '- "Assign the Q1 planning project to my 9am block" → list_blocks → kanban.list_projects → assign_project({ id, projectId }).',
          "",
        ]
      : []),
    "## Kanban Task Tracking",
    "Track ALL meaningful work on the kanban board. This is how the human monitors agent progress in real-time.",
    "",
    "**ALWAYS create a task when:**",
    "- Starting any non-trivial work (building features, debugging, research, multi-step tasks)",
    "- Receiving a new project or significant request",
    "- Spawning a sub-agent (auto-tracked, but verify)",
    "",
    "**ALWAYS update task status when:**",
    "- Work begins → `in_progress`",
    "- Work needs review or is blocked → `review`",
    "- Work is complete → `done`",
    "- Scope changes → update description",
    "",
    "**Create new projects when:**",
    "- Work doesn't fit existing projects",
    "- A distinct initiative or system is being built",
    "- The human requests project organization",
    "",
    "**Project directory linking (MANDATORY for code/repo work):**",
    "- When CREATING a project tied to a local repo, ALWAYS pass `project_directory=<absolute path>` to `kanban.create_project`. This saves the path on the project (mirrored to Notion only if connected) AND auto-creates a clickable 'Project directory' file-link.",
    "- When OPENING / RESUMING an existing project for code work, FIRST check `list_projects` for its `projectDirectory`. If empty, immediately set it via `kanban.update_project { project_id, directory: '<absolute path>' }` before doing further work.",
    "- The link is idempotent (re-running is safe), and failure to link is non-fatal — but never skip the attempt.",
    "- Use the user's current `cwd` (or the directory of the file being edited) when unsure which path to use.",
    "",
    "**Task hygiene:**",
    "- Use clear, specific titles (not 'Fix thing' — say 'Fix wake word network error in Chrome SpeechRecognition')",
    "- Set priority (critical/high/medium/low) based on urgency",
    "- Set assignee to the agent doing the work",
    "- Update description with progress notes as work proceeds",
    "- When listing tasks for the human, format them clearly by status",
    "",
    // InfiniBot product expert: UI map + "never invent click-paths, use
    // infinibot_help, navigate instead of asking" (src/infinibot-knowledge).
    ...buildMediaGenerationSection(availableTools),
    ...buildWebResearchSection(availableTools),
    ...(!isMinimal && availableTools.has("infinibot_help")
      ? [...infinibotExpertPromptLines(), ""]
      : []),
    "## Tool Call Style",
    "Default: do not narrate routine, low-risk tool calls (just call the tool).",
    "Narrate only when it helps: multi-step work, complex/challenging problems, sensitive actions (e.g., deletions), or when the user explicitly asks.",
    "Keep narration brief and value-dense; avoid repeating obvious steps.",
    "Use plain human language for narration unless in a technical context.",
    "",
    "## InfiniBot CLI Quick Reference",
    "InfiniBot is controlled via subcommands. Do not invent commands.",
    "To manage the Gateway daemon service (start/stop/restart):",
    "- infinibot gateway status",
    "- infinibot gateway start",
    "- infinibot gateway stop",
    "- infinibot gateway restart",
    "⚠️ NEVER stop the gateway (`infinibot gateway stop` or `gateway.stop`). Always use restart instead. Stopping the gateway kills your connection permanently — you cannot start it again without human intervention. Only restart.",
    "If unsure, ask the user to run `infinibot help` (or `infinibot gateway --help`) and paste the output.",
    "",
    ...skillsSection,
    ...agentContextSection,
    // Federation context (injected when nodes are connected)
    ...(params.federationContext ? [params.federationContext, ""] : []),
    ...memorySection,
    // Skip self-update for subagent/none modes
    hasGateway && !isMinimal ? "## InfiniBot Self-Update" : "",
    hasGateway && !isMinimal
      ? [
          "Get Updates (self-update) is ONLY allowed when the user explicitly asks for it.",
          "Do not run config.apply or update.run unless the user explicitly requests an update or config change; if it's not explicit, ask first.",
          "Actions: config.get, config.schema, config.apply (validate + write full config, then restart), update.run (update deps or git, then restart).",
          "After restart, InfiniBot pings the last active session automatically.",
        ].join("\n")
      : "",
    hasGateway && !isMinimal ? "" : "",
    "",
    // Skip model aliases for subagent/none modes
    params.modelAliasLines && params.modelAliasLines.length > 0 && !isMinimal
      ? "## Model Aliases"
      : "",
    params.modelAliasLines && params.modelAliasLines.length > 0 && !isMinimal
      ? "Prefer aliases when specifying model overrides; full provider/model is also accepted."
      : "",
    params.modelAliasLines && params.modelAliasLines.length > 0 && !isMinimal
      ? params.modelAliasLines.join("\n")
      : "",
    params.modelAliasLines && params.modelAliasLines.length > 0 && !isMinimal ? "" : "",
    "## Workspace",
    `Your working directory is: ${params.workspaceDir}`,
    "Treat this directory as the single global workspace for file operations unless explicitly instructed otherwise.",
    ...workspaceNotes,
    "",
    ...docsSection,
    params.sandboxInfo?.enabled ? "## Sandbox" : "",
    params.sandboxInfo?.enabled
      ? [
          "You are running in a sandboxed runtime (tools execute in Docker).",
          "Some tools may be unavailable due to sandbox policy.",
          "Sub-agents stay sandboxed (no elevated/host access). Need outside-sandbox read/write? Don't spawn; ask first.",
          params.sandboxInfo.workspaceDir
            ? `Sandbox workspace: ${params.sandboxInfo.workspaceDir}`
            : "",
          params.sandboxInfo.workspaceAccess
            ? `Agent workspace access: ${params.sandboxInfo.workspaceAccess}${
                params.sandboxInfo.agentWorkspaceMount
                  ? ` (mounted at ${params.sandboxInfo.agentWorkspaceMount})`
                  : ""
              }`
            : "",
          params.sandboxInfo.browserBridgeUrl ? "Sandbox browser: enabled." : "",
          params.sandboxInfo.browserNoVncUrl
            ? `Sandbox browser observer (noVNC): ${params.sandboxInfo.browserNoVncUrl}`
            : "",
          params.sandboxInfo.hostBrowserAllowed === true
            ? "Host browser control: allowed."
            : params.sandboxInfo.hostBrowserAllowed === false
              ? "Host browser control: blocked."
              : "",
          params.sandboxInfo.elevated?.allowed
            ? "Elevated exec is available for this session."
            : "",
          params.sandboxInfo.elevated?.allowed
            ? "User can toggle with /elevated on|off|ask|full."
            : "",
          params.sandboxInfo.elevated?.allowed
            ? "You may also send /elevated on|off|ask|full when needed."
            : "",
          params.sandboxInfo.elevated?.allowed
            ? `Current elevated level: ${params.sandboxInfo.elevated.defaultLevel} (ask runs exec on host with approvals; full auto-approves).`
            : "",
        ]
          .filter(Boolean)
          .join("\n")
      : "",
    params.sandboxInfo?.enabled ? "" : "",
    ...buildUserIdentitySection(ownerLine, isMinimal),
    ...buildTimeSection({
      userTimezone,
    }),
    "## Workspace Files (injected)",
    "These user-editable files are loaded by InfiniBot and included below in Project Context.",
    "",
    ...buildReplyTagsSection(isMinimal),
    ...buildMessagingSection({
      isMinimal,
      availableTools,
      messageChannelOptions,
      inlineButtonsEnabled,
      runtimeChannel,
      messageToolHints: params.messageToolHints,
    }),
    ...buildVoiceSection({ isMinimal, ttsHint: params.ttsHint }),
  ];

  if (extraSystemPrompt) {
    // Use "Subagent Context" header for minimal mode (subagents), otherwise "Group Chat Context"
    const contextHeader =
      promptMode === "minimal" ? "## Subagent Context" : "## Group Chat Context";
    lines.push(contextHeader, extraSystemPrompt, "");
  }
  if (params.reactionGuidance) {
    const { level, channel } = params.reactionGuidance;
    const guidanceText =
      level === "minimal"
        ? [
            `Reactions are enabled for ${channel} in MINIMAL mode.`,
            "React ONLY when truly relevant:",
            "- Acknowledge important user requests or confirmations",
            "- Express genuine sentiment (humor, appreciation) sparingly",
            "- Avoid reacting to routine messages or your own replies",
            "Guideline: at most 1 reaction per 5-10 exchanges.",
          ].join("\n")
        : [
            `Reactions are enabled for ${channel} in EXTENSIVE mode.`,
            "Feel free to react liberally:",
            "- Acknowledge messages with appropriate emojis",
            "- Express sentiment and personality through reactions",
            "- React to interesting content, humor, or notable events",
            "- Use reactions to confirm understanding or agreement",
            "Guideline: react whenever it feels natural.",
          ].join("\n");
    lines.push("## Reactions", guidanceText, "");
  }
  if (reasoningHint) {
    lines.push("## Reasoning Format", reasoningHint, "");
  }

  const contextFiles = params.contextFiles ?? [];
  // Identity files already opened the prompt — repeating them here would put a
  // second, weaker copy after the runtime instructions.
  const projectContextFiles = identityFrame
    ? contextFiles.filter((file) => !isIdentityContextFile(file))
    : contextFiles;
  if (projectContextFiles.length > 0) {
    lines.push(
      "# Project Context",
      "",
      "The following project context files have been loaded:",
      "",
    );
    for (const file of projectContextFiles) {
      lines.push(`## ${file.path}`, "", file.content, "");
    }
  }

  // Skip silent replies for subagent/none modes
  if (!isMinimal) {
    lines.push(
      "## Silent Replies",
      `When you have nothing to say, respond with ONLY: ${SILENT_REPLY_TOKEN}`,
      "",
      "⚠️ Rules:",
      "- It must be your ENTIRE message — nothing else",
      `- Never append it to an actual response (never include "${SILENT_REPLY_TOKEN}" in real replies)`,
      "- Never wrap it in markdown or code blocks",
      "",
      `❌ Wrong: "Here's help... ${SILENT_REPLY_TOKEN}"`,
      `❌ Wrong: "${SILENT_REPLY_TOKEN}"`,
      `✅ Right: ${SILENT_REPLY_TOKEN}`,
      "",
    );
  }

  // Skip heartbeats for subagent/none modes
  if (!isMinimal) {
    lines.push(
      "## Heartbeats",
      heartbeatPromptLine,
      "If you receive a heartbeat poll (a user message matching the heartbeat prompt above), and there is nothing that needs attention, reply exactly:",
      "HEARTBEAT_OK",
      'InfiniBot treats a leading/trailing "HEARTBEAT_OK" as a heartbeat ack (and may discard it).',
      'If something needs attention, do NOT include "HEARTBEAT_OK"; reply with the alert text instead.',
      "",
    );
  }

  lines.push(
    "## Runtime",
    buildRuntimeLine(runtimeInfo, runtimeChannel, runtimeCapabilities, params.defaultThinkLevel),
    `Reasoning: ${reasoningLevel} (hidden unless on/stream). Toggle /reasoning; /status shows Reasoning when enabled.`,
  );

  return lines.filter(Boolean).join("\n");
}

export function buildRuntimeLine(
  runtimeInfo?: {
    agentId?: string;
    host?: string;
    os?: string;
    arch?: string;
    node?: string;
    model?: string;
    defaultModel?: string;
    repoRoot?: string;
  },
  runtimeChannel?: string,
  runtimeCapabilities: string[] = [],
  defaultThinkLevel?: ThinkLevel,
): string {
  return `Runtime: ${[
    runtimeInfo?.agentId ? `agent=${runtimeInfo.agentId}` : "",
    runtimeInfo?.host ? `host=${runtimeInfo.host}` : "",
    runtimeInfo?.repoRoot ? `repo=${runtimeInfo.repoRoot}` : "",
    runtimeInfo?.os
      ? `os=${runtimeInfo.os}${runtimeInfo?.arch ? ` (${runtimeInfo.arch})` : ""}`
      : runtimeInfo?.arch
        ? `arch=${runtimeInfo.arch}`
        : "",
    runtimeInfo?.node ? `node=${runtimeInfo.node}` : "",
    runtimeInfo?.model ? `model=${runtimeInfo.model}` : "",
    runtimeInfo?.defaultModel ? `default_model=${runtimeInfo.defaultModel}` : "",
    runtimeChannel ? `channel=${runtimeChannel}` : "",
    runtimeChannel
      ? `capabilities=${runtimeCapabilities.length > 0 ? runtimeCapabilities.join(",") : "none"}`
      : "",
    `thinking=${defaultThinkLevel ?? "off"}`,
  ]
    .filter(Boolean)
    .join(" | ")}`;
}
