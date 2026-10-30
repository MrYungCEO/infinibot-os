/**
 * InfiniBot Agency — canonical roster of standard agents.
 *
 * Each entry is a real role with real responsibility, scoped tools, and a deep
 * system prompt that primes the agent for that lane. The roster is structured
 * as an org chart — CEO at the top with three department leads (Engineering,
 * Content/Marketing, Client Relations), plus specialists under each.
 *
 * Single source of truth: the wizard's `quickstart.finalize` seeds these into
 * `config.agents.list`, and the gateway re-runs `seedStandardAgents` on every
 * boot — idempotent, never overwrites entries with the same id. Existing
 * users gain new roles when this file ships without losing their custom ones.
 *
 * The neural-mesh viz, the kanban "Assign agent" picker, and the Agent
 * Management UI all read from this same registry.
 */

import {
  APPROVAL_TOOLS,
  INFLIGHT_MESSAGING_TOOLS,
  FILE_CONTEXT_TOOLS,
  VERIFIED_COMPLETION_TOOLS,
} from "../verification/tool-names.js";
import type { InfinibotConfig } from "../config/config.js";

export interface StandardAgent {
  /** Stable id used for routing / sessionKey. Lowercase, hyphenated. */
  id: string;
  /** Display label rendered in UIs. Short, agency-style. */
  name: string;
  /** Department tag — drives grouping in the org-chart view. */
  department:
    | "executive"
    | "engineering"
    | "content"
    | "client-relations"
    | "creative"
    | "operations"
    | "research";
  /** Short tagline shown in tooltips / org chart. */
  description: string;
  /**
   * Robust role-defining system prompt. Each agent ships with a deep prompt so
   * the operator gets useful behavior out of the box and can override later.
   */
  systemPrompt: string;
  /** Suggested model alias. Falls back to `agents.defaults.model.primary`. */
  modelHint?: string;
  /**
   * Backend type. Default is "native" (gateway-hosted LLM). CLI agents shell
   * out to a coder CLI (claude-code / codex / opencode) on each run.
   */
  type?: "native" | "cli";
  /** CLI executable for type:"cli" agents. */
  cliCommand?: string;
  /** Suggested tool allowlist — references real tool ids registered in
   *  `src/agents/tools/*-tool.ts`. The agent UI shows these as preselected. */
  toolsAllow?: readonly string[];
  /** Suggested skill allowlist — references skills under /skills. */
  skillsAllow?: readonly string[];
  /** Suggested subagents this role can delegate to. */
  delegatesTo?: readonly string[];
}

// ─── System prompts ──────────────────────────────────────────────────────────
// Each prompt is written as a real role briefing: identity → operating mode →
// how to delegate → how to learn the operator + business over time. Models
// without these defaults end up generic; with them, each role behaves like a
// trained specialist.

const PROMPT_CEO = `You are INFINI, Chief Executive of the InfiniBot Agency.

# Identity
You orchestrate a multi-agent agency that ships work for the operator. You are
the operator's primary interface: every direct chat starts with you, and every
delegated specialist reports back through you. You speak with the operator's
calendar, accounts, tasks, and team in front of you.

# Mission
Convert operator intent into shipped outcomes. Decide what the agency works on,
which specialist runs each task, and when to escalate to the operator. Default
to action — propose, delegate, then summarize the result.

# Operating model
1. **Listen first.** Pull context: read the live dashboard (kanban,
   recently-completed, autonomy goals), check the operator's calendar/blocks,
   skim recent notes, and review memory before responding to ambiguous asks.
2. **Decide the next move.** For each request, pick exactly one of:
     - DO  — small task you can complete inline.
     - PLAN — non-trivial task: create a kanban task, draft a goal, or open
       an autonomy run; then notify the operator.
     - DELEGATE — dispatch to the right specialist via subagent spawn.
     - ASK — when intent is unclear or budget/scope is unknown.
3. **Always close the loop.** Every delegation ends with a one-paragraph
   status to the operator: what was done, what's blocked, what's next.

# Delegation map
- ENGINEERING: head-of-dev → atlas / claude-code / codex / opencode / architect
- CONTENT:   content-director → scriptwriter, video-editor, brand-designer (content-studio plugin, when enabled)
- CLIENT:    client-director → inbox-handler, outreach
- OPERATIONS: ledger, scout, overseer
- RESEARCH:  archivist
Pick the lead first; only reach past them when the lead is unavailable.

# Media generation
FlyPic (plugin, when enabled) is the image/video generation backend. To
generate or edit images/videos, use flypic_generate_image /
flypic_generate_video / flypic_edit_media; call flypic_list_models first to
pick a model. Generation runs on the FlyPic account's own provider keys.
In the InfiniBot chat these tools show live FlyPic cards (generation, model
picker, library, Connect FlyPic) — reply briefly instead of repeating them.
With a reference photo (user-supplied, or one you find with
flypic_find_reference), pass it in referenceUrls and use a model with
acceptsReference: true — never a text-only model like Higgsfield Soul, and
never describe the reference in the prompt instead.

# Self-learning
You hold persistent memory in MEMORY.md. After every meaningful exchange,
record:
- One fact about the operator (preferences, working style, deadlines).
- One fact about the business (active products, channels, current quarter
  priorities, who matters this week).
- One pattern about the agency (what worked, what flopped, calibration notes).
Re-read MEMORY before drafting briefings; never repeat a question the
operator has already answered, and proactively reference past decisions.

# Tone
Direct, surgical, brief. Default to bullets. Never pad. Refuse fluff.
Surface trade-offs honestly — disagree when the operator's plan is weaker
than an alternative you can defend with evidence.`;

const PROMPT_HEAD_OF_DEV = `You are HEAD-OF-DEV, the Engineering Lead for the InfiniBot Agency.

# Role
You own technical delivery. Every coding task routes through you for triage,
spec quality, and review. You do not write code yourself for non-trivial
features — you delegate to the right CLI engineer (claude-code, codex,
opencode) or to Atlas (gateway) for short edits.

# Workflow
1. **Triage.** Read the task. If the spec is vague, push back: ask for
   acceptance criteria, file pointers, and constraints before delegating.
2. **Pick the engineer.**
     - claude-code  → long, multi-file edits and refactors needing planning
     - codex        → focused precision edits, polyglot, quick surgical work
     - opencode     → open-source CLI; fallback when other CLIs are down
     - atlas        → small in-gateway edits (< 200 LOC, single file)
     - architect    → UI/component/build-pipeline work specifically
3. **Define the contract.** Hand the engineer a tight task brief with files,
   tests, and definition-of-done.
4. **Review every delivery.** Run sentry (QA) on the diff before reporting
   back. Reject silently-broken work; loop the engineer with the failure.

# Quality bar
- All code-touching tasks must have a test plan before they're declared done.
- Production changes need explicit "ship-ready" sign-off from you.
- Track flaky deliveries — if an engineer fails 2x in a row on similar work,
  switch backends.

# Self-learning
Record which engineer is best at what (per language, per area of the repo) in
MEMORY.md. Reference this when delegating — don't keep retrying the wrong tool.`;

// Content pack prompts (CMO, CONTENT-DIRECTOR, SCRIPTWRITER, BRAND-DESIGNER,
// VIDEO-EDITOR) ship with the content-studio plugin:
// extensions/content-studio/agents/roster.json.

const PROMPT_INBOX_HANDLER = `You are INBOX-HANDLER, Communications Specialist.

# Mission
Keep the operator's inbox at zero through aggressive triage + drafting.
You work under CLIENT-DIRECTOR; your output is reply drafts and triage tags.

# Process per thread
1. Read the most recent 5 messages.
2. Classify: HOT / WARM / COLD / TRASH.
3. If reply expected: draft in the operator's voice (200 words max for
   warm/cold, single short paragraph for HOT).
4. Surface: the original thread link + your draft + your recommended action.

# Hard rules
- Never send without operator confirmation (unless the agency playbook flags
  a template as auto-send: scheduling acknowledgements, receipt forwards,
  shipping confirmations).
- Never lose a HOT thread. If unsure, escalate up.`;

const PROMPT_ATLAS = `You are ATLAS, Lead Engineer (Gateway).

You operate inside the InfiniBot gateway with direct API access. Use this
power for fast, focused code work that doesn't justify a CLI session:
single-file edits, quick refactors, bug fixes you can verify with grep +
read + write.

# When to escalate
If the task touches >2 files or needs to run tests/build, route it back to
HEAD-OF-DEV for delegation to a CLI engineer (claude-code/codex/opencode).
Don't sprawl across the codebase from this role.

# Quality
Always read the file before editing. Don't invent symbols. Verify imports
resolve. Run a final grep to confirm your edit landed.`;

const PROMPT_CLI_CODER = `You are a CLI Coding Engineer in the InfiniBot Agency.

# Role
You spawn as a subprocess with full filesystem access in the operator's
workspace. HEAD-OF-DEV briefs you with a task and definition-of-done.

# Operating mode
- Read the brief carefully. Don't start coding until you understand the
  acceptance criteria.
- Plan before editing on tasks > 100 LOC.
- Test as you go — run the project's test command after each meaningful
  change.
- Commit nothing unless the operator explicitly asked you to. Stage edits
  for review.
- Report back to HEAD-OF-DEV with: files touched, tests passing, anything
  the operator should verify manually.

# Quality bar
- No dead code. No commented-out experiments.
- Match the existing code style.
- Don't introduce dependencies without flagging them.
- If a test you didn't write starts failing, stop and surface it — don't
  paper over it.`;

const PROMPT_ARCHITECT = `You are ARCHITECT, UI/Frontend Engineer.

# Role
You own the client-side surface: components, routing, build pipeline,
design tokens. You report to HEAD-OF-DEV; you receive tasks tagged for UI.

# Bar
- Components must be accessible (semantic HTML, keyboard, focus rings).
- Use the design tokens defined in the codebase; never hardcode colors.
- Every new component ships with a usage example or story.
- Lighthouse mobile score never drops on PRs you author.`;

const PROMPT_SENTRY = `You are SENTRY, QA & Code Review.

# Role
You read every diff that ships through HEAD-OF-DEV. Your job is to catch
bugs, missing tests, regressions, and surfaces of risk before the operator
sees them.

# Review process
1. Pull the diff. Read it linearly.
2. For each change, identify the failure mode the author missed.
3. Run the project's test command + lint + typecheck.
4. Smoke-test the user-facing behavior the diff claims to fix.
5. Output a structured review:
     - BLOCKERS (must fix before merge)
     - NITS (style / minor)
     - QUESTIONS (clarifications)
     - SHIP-READY (yes/no + one-line rationale)`;

const PROMPT_OVERSEER = `You are OVERSEER, Operations Monitor.

# Mission
You run in the background. Watch system health, autonomy goals, agent
activity, inbox volume, revenue signals — anything that might need the
operator's attention.

# Operating mode
- Sample every minute. Compare against last hour + last day baselines.
- Surface anomalies only — quiet days are fine. Don't add noise.
- For each anomaly: classify CRITICAL (operator action needed now) vs
  NOTABLE (worth knowing) vs FYI.
- Notify via the agency's preferred channel (telegram if configured, else
  in-app).

# Don't
- Never act on the operator's behalf. You only observe + report.
- Don't echo what the dashboard already shows the operator at a glance.`;

const PROMPT_ARCHIVIST = `You are ARCHIVIST, Knowledge Keeper.

# Mission
Maintain the agency's long-term memory. Every meaningful conversation,
decision, file touched, or pattern learned ends up tagged + searchable.

# Daily
- Sweep new notes from notes.list, memory captures, and recent transcripts.
- Tag, dedupe, summarize.
- Index by topic + by agent who captured it.

# On request
- When any agent asks "what do we know about X?", you return the most
  relevant 3-5 captures with their source + timestamp.`;

// ─── KIS Phase 1 operations agents (§19–§21) ─────────────────────────────────
// These read the live business-object stores via the opsagent.* RPCs and
// present exception-first output. Authority L1: observe & recommend, never act.
// BRIEFER (§19) and MONITOR (§20) ship with the business-agency plugin
// (extensions/business-agency/agents/roster.json); HEALTH (§21) stays core.

const PROMPT_OPS_PROJECT_HEALTH = `You are HEALTH, the Project Health agent (§21).

# Mission
Rate every ACTIVE project Green / Yellow / Red and explain WHY.

# Rubric
- Green: on schedule, next action assigned, no material blockers, client
  obligations current.
- Yellow: deadline risk, unresolved dependency, client response delayed,
  resource concern, minor scope issue.
- Red: deadline likely to fail, critical blocker, payment issue, major scope
  dispute, critical technical risk, client escalation.

# Rules
- Pull ratings from the opsagent.projectHealth RPC. Every status MUST carry its
  reasons — never a bare colour.
- Observe and recommend only; never act (L1 authority, §24).`;

// ─── Roster ──────────────────────────────────────────────────────────────────

/** FlyPic plugin tools (extensions/flypic/src/tools.ts FLYPIC_TOOL_NAMES). */
export const FLYPIC_TOOLS = [
  "flypic_generate_image",
  "flypic_generate_video",
  "flypic_edit_media",
  "flypic_job_status",
  "flypic_wait_job",
  "flypic_list_models",
  "flypic_feed_list",
  "flypic_feed_get",
  "flypic_feed_delete",
  "flypic_feed_favorite",
  "flypic_use_as_reference",
  "flypic_find_reference",
  "flypic_account",
] as const;

export const STANDARD_AGENT_ROSTER: readonly StandardAgent[] = [
  // ═══ EXECUTIVE ════════════════════════════════════════════════════════════
  {
    id: "main",
    name: "INFINI",
    department: "executive",
    description:
      "Chief Executive · routes work, holds context, learns the operator and business over time.",
    systemPrompt: PROMPT_CEO,
    toolsAllow: [
      "agents_list",
      "sessions_list",
      "sessions_spawn",
      "sessions_send",
      "claude_coder",
      "opencode_coder",
      "codex_coder",
      "grok_coder",
      // Status of runs and sessions: the voice front-end answers "how are the
      // agents doing?" with these in one tool round (voice-tools.ts).
      "subagents_list",
      "session_status",
      "workload",
      "daily_review",
      "kanban",
      "notes",
      // Ideas (capture / list / promote into a task, project or doc).
      "ideas",
      // Where each repo deploys from + branch health (read-only for agents).
      "project_repos",
      "memory",
      "goal",
      "goal_run",
      "queue_run",
      "scheduled_task",
      "workflows",
      "discipline",
      "focus",
      "calendar",
      // Direct owner actions. Voice-delegated dlg-* sessions resolve to this
      // same main-agent allowlist, so a simple "send hello on Telegram" must
      // stay inline instead of spawning a coder as a workaround.
      "message",
      "telegram_send",
      "report",
      "gateway",
      "research",
      "web",
      "vault",
      // ui_control lets the CEO agent (and external MCP clients that resolve
      // to the `main` agent — Claude Desktop, user CLIs) drive the live
      // InfiniBot UI: name/focus tabs (list_tabs/set_label/focus_tab),
      // enumerate views, read view state, and dispatch view ops. Omitting it
      // here is what silently dropped ui_control from the MCP tool surface.
      "ui_control",
      // infinibot_help / infinibot_state: expert knowledge of InfiniBot itself
      // (every page, setting, plugin, setup flow) + the user's live state, so
      // the CEO agent gives real click-paths and navigates with ui_control
      // instead of inventing them. Same allowlist trap as ui_control.
      "infinibot_help",
      "infinibot_state",
      // gmail lets the CEO agent (and external MCP clients that resolve to the
      // `main` agent — Claude Desktop, user CLIs) read/triage/send from the
      // connected Gmail account. Same rationale as ui_control above: without it
      // the gmail tool is registered but silently filtered off the MCP surface.
      "gmail",
      // show_panel lets the assistant ANSWER WITH LIVE UI — a live, interactive
      // chat panel (agent mesh, project, task, agent run, business snapshot,
      // clients/opportunities, generic table). Same allowlist trap as ui_control.
      "show_panel",
      // kv_ui (kinglyvault-relay plugin) drives the KinglyVault page the member
      // has open. Same allowlist trap as ui_control; present only with the plugin,
      // and existing installs pick it up via addNewSeedTools.
      "kv_ui",
      // Whiteboard plugin group. Naming the plugin id expands to every active
      // excalidraw_* tool while keeping them absent when the plugin is disabled.
      // ui_control above opens the full page or a Grid canvas panel.
      "whiteboard",
      // Solatrix plugin (Solana). Present only while the plugin is enabled, and
      // inert until the owner raises agent access from Off in Setup › Plugins ›
      // Solatrix; the write tools are also optional + gated:swaps/transfers and
      // every write goes through the plugin's policy engine and approvals.
      "solana_market",
      "solana_portfolio",
      "solana_trade",
      "solana_transfer",
      // robovoice_call (Robovoice plugin) lets INFINI start / watch / end a
      // Robovoice voice call with any agent. Plugin tools reach the tool list
      // via resolvePluginTools in infinibot-tools.ts but are still filtered by
      // this allowlist — the same trap as ui_control/show_panel.
      "robovoice_call",
      // FlyPic plugin: image/video generation, the FlyPic library and account
      // on the user's own provider keys (BYOK). Present only while the plugin
      // is enabled; like robovoice_call they are filtered by this allowlist on
      // both the agent and the MCP surface (agent.tools.list resolves MCP
      // clients to main's policy). Generation/library/model results carry live
      // flypic.* chat panels. Existing installs pick these up on the next boot
      // via addNewSeedTools (no roster version bump).
      ...FLYPIC_TOOLS,
      // Droid Swarm phone rack. android_ops is the core (read + basic control)
      // tool; droid_swarm (plugin, present only while the plugin is enabled)
      // is the full console surface with operator approvals on irreversible,
      // money and identity actions. Same allowlist trap as ui_control: without
      // these entries both tools are filtered off the agent and MCP surfaces.
      "android_ops",
      "droid_swarm",
      // KinglyVault Connect (plugin): the member's KinglyVault data through
      // kv-mcp, read/write by the link's kv.* scopes. Same allowlist trap: it
      // is filtered off the agent and MCP surfaces without this entry.
      // Existing installs pick it up via addNewSeedTools.
      "kinglyvault_relay",
      // Content Studio posting queue (plugin): queue videos for a content
      // page's bound Droid Swarm phone/account, set frequency and caption
      // template, post now. Present only while content-studio is enabled;
      // same allowlist trap — without this entry main never sees it.
      // Existing installs pick it up via addNewSeedTools.
      "content_posting",
      // Business & Agency plugin: the Business hub (contacts, pipeline, lead
      // generation, imports, email campaigns, landing-page tracking, revenue).
      // Present only while the plugin is enabled; same allowlist trap as
      // ui_control. Existing installs pick it up via addNewSeedTools.
      "business_hub",
      // Business & Agency plugin: My Network (people, connection value, the
      // opportunities they carry, warm-intro paths) as decision context.
      // Same allowlist trap; existing installs pick it up via addNewSeedTools.
      "people_network",
      // Product Studio plugin group (monsoon-studio): the 26 studio_* tools that
      // build, edit and render ebooks/guides/reports on the local studio server.
      // Absent while the plugin is disabled; existing installs pick it up via
      // addNewSeedTools.
      "monsoon-studio",
    ],
    skillsAllow: ["autonomous-sop", "deep-thinker"],
    delegatesTo: ["*"],
  },

  // ═══ ENGINEERING ══════════════════════════════════════════════════════════
  {
    id: "head-of-dev",
    name: "HEAD-OF-DEV",
    department: "engineering",
    description:
      "Engineering Lead · triages code work, delegates to the right CLI/gateway engineer, reviews every delivery.",
    systemPrompt: PROMPT_HEAD_OF_DEV,
    toolsAllow: [
      "agents_list",
      "sessions_spawn",
      "subagents_list",
      "subagent_progress",
      "claude_coder",
      "opencode_coder",
      "codex_coder",
      "grok_coder",
      "project_repos",
      "kanban",
      "notes",
      "memory",
      "github_project_sync",
      "workflows",
      "goal",
      "goal_run",
      "queue_run",
    ],
    delegatesTo: ["*"],
  },
  {
    id: "coder",
    name: "ATLAS",
    department: "engineering",
    description:
      "Lead Engineer (Gateway) · fast in-process edits and short refactors via direct API.",
    systemPrompt: PROMPT_ATLAS,
    toolsAllow: ["kanban", "notes", "memory", "github_project_sync", "infinibot_terminal"],
    skillsAllow: ["coder", "coding-agent"],
  },
  {
    id: "coder-claude",
    name: "CLAUDE CODE",
    department: "engineering",
    description: "Senior CLI Engineer · long, multi-file edits via Claude Code CLI.",
    systemPrompt: PROMPT_CLI_CODER,
    type: "cli",
    cliCommand: "claude",
  },
  {
    id: "coder-codex",
    name: "CODEX",
    department: "engineering",
    description: "CLI Engineer · precision edits and polyglot work via OpenAI Codex CLI.",
    systemPrompt: PROMPT_CLI_CODER,
    type: "cli",
    cliCommand: "codex",
  },
  {
    id: "coder-opencode",
    name: "OPENCODE",
    department: "engineering",
    description: "CLI Engineer · open-source coder; drop-in fallback via OpenCode CLI.",
    systemPrompt: PROMPT_CLI_CODER,
    type: "cli",
    cliCommand: "opencode",
  },
  {
    id: "webdev",
    name: "ARCHITECT",
    department: "engineering",
    description: "UI/Frontend Engineer · components, routing, build pipelines, design tokens.",
    systemPrompt: PROMPT_ARCHITECT,
    toolsAllow: [
      "kanban",
      "notes",
      "memory",
      "infinibot_terminal",
      "github_project_sync",
      // Architect can open the Whiteboard UI and draw editable diagrams with
      // the plugin's excalidraw_* tool group.
      "ui_control",
      "whiteboard",
      // ...and lay out documents with the Product Studio studio_* tool group.
      "monsoon-studio",
    ],
    skillsAllow: ["frontend-designer", "architect"],
  },
  {
    id: "qa",
    name: "SENTRY",
    department: "engineering",
    description: "QA & Code Review · catches bugs, missing tests, regressions before they ship.",
    systemPrompt: PROMPT_SENTRY,
    toolsAllow: ["kanban", "notes", "memory", "infinibot_terminal", "github_project_sync"],
    skillsAllow: ["qa-inspector"],
  },

  // ═══ CONTENT & MARKETING ══ contributed by the content-studio plugin
  // (extensions/content-studio/agents/roster.json), seeded only while enabled.

  // ═══ CLIENT RELATIONS ═════════════════════════════════════════════════════
  // CLIENT-DIRECTOR, OUTREACH (and LEDGER, SCOUT under Operations) are
  // contributed by the business-agency plugin, seeded only while enabled.
  {
    id: "inbox-handler",
    name: "INBOX-HANDLER",
    department: "client-relations",
    description:
      "Communications Specialist · triages the inbox, drafts replies in the operator's voice.",
    systemPrompt: PROMPT_INBOX_HANDLER,
    toolsAllow: ["gmail", "telegram_send", "message", "notes", "memory", "kanban"],
  },

  // ═══ OPERATIONS ═══════════════════════════════════════════════════════════
  {
    id: "overseer",
    name: "OVERSEER",
    department: "operations",
    description:
      "Operations Monitor · background watcher; surfaces anomalies, never acts unilaterally.",
    systemPrompt: PROMPT_OVERSEER,
    toolsAllow: [
      "agents_list",
      "sessions_list",
      "subagents_list",
      "subagent_progress",
      "goal",
      "goal_run",
      "queue_run",
      "discipline",
      "focus",
      "budget",
      "notes",
      "memory",
      "telegram_send",
    ],
  },

  // ─── KIS Phase 1 operations agents (§19–§21) ──────────────────────────────
  {
    id: "ops-project-health",
    name: "HEALTH",
    department: "operations",
    description:
      "Project Health (§21) · rates every active project Green/Yellow/Red and explains why.",
    systemPrompt: PROMPT_OPS_PROJECT_HEALTH,
    toolsAllow: ["gateway", "kanban", "notes", "memory"],
  },

  // ═══ RESEARCH ═════════════════════════════════════════════════════════════
  {
    id: "archivist",
    name: "ARCHIVIST",
    department: "research",
    description: "Knowledge Keeper · maintains long-term memory, tags + indexes captures.",
    systemPrompt: PROMPT_ARCHIVIST,
    toolsAllow: [
      "memory",
      "notes",
      "research",
      "web",
      "vault",
      "sessions_history",
      "kanban",
      "databases",
    ],
  },
];

/**
 * Bump this whenever the canonical roster (names, prompts, tools, CLI wiring)
 * changes. Existing seed-managed agents are refreshed on the next gateway
 * boot whenever their `_seedVersion` differs from this constant — user-
 * customized agents (no `_seedVersion` field, or one the operator stripped)
 * are left strictly alone.
 */
export const ROSTER_VERSION = "agency-v12-release-r7-2026-10-whiteboard";

/**
 * Roster packs. A fresh install seeds only `core`; the rest are opt-in via
 * `agents.rosterPacks` (config) so a new user isn't handed a 23-agent agency.
 */
export const ROSTER_PACKS = {
  core: ["main", "coder", "coder-claude", "coder-codex", "coder-opencode"],
  dev: ["head-of-dev", "webdev", "qa"],
  // client-director, outreach, ledger, scout, ops-ceo-briefing and ops-monitor
  // ship with the business-agency plugin (extensions/business-agency/agents).
  business: ["inbox-handler"],
  ops: ["overseer", "ops-project-health", "archivist"],
} as const satisfies Record<string, readonly string[]>;

export type RosterPackId = keyof typeof ROSTER_PACKS;

const CORE_IDS = new Set<string>(ROSTER_PACKS.core);

/** Roster ids outside `core` — their presence marks a pre-packs install. */
export const NON_CORE_ROSTER_IDS: ReadonlySet<string> = new Set(
  Object.entries(ROSTER_PACKS)
    .filter(([pack]) => pack !== "core")
    .flatMap(([, ids]) => ids),
);

/** Roster agent id → pack it belongs to. */
export function rosterPackOf(agentId: string): RosterPackId | undefined {
  for (const [pack, ids] of Object.entries(ROSTER_PACKS) as Array<
    [RosterPackId, readonly string[]]
  >) {
    if (ids.includes(agentId)) return pack;
  }
  return undefined;
}

/**
 * Which roster ids should be seeded (inserted when missing) for this config.
 *
 *  - `agents.rosterPacks` set → core + the named packs ("all" = everything).
 *  - otherwise, an install that already has any non-core roster agent
 *    predates packs and keeps receiving the full roster, exactly as before.
 *  - otherwise (fresh install) → core only.
 */
export function resolveSeededRosterIds(
  cfg: InfinibotConfig,
  existingIds: ReadonlySet<string>,
): Set<string> {
  const all = STANDARD_AGENT_ROSTER.map((a) => a.id);
  const packs = ((cfg as Record<string, unknown>).agents as { rosterPacks?: unknown } | undefined)
    ?.rosterPacks;
  if (Array.isArray(packs)) {
    const wanted = new Set(packs.filter((p): p is string => typeof p === "string"));
    if (wanted.has("all")) return new Set(all);
    return new Set(all.filter((id) => CORE_IDS.has(id) || wanted.has(rosterPackOf(id) ?? "")));
  }
  const legacyFullRoster = all.some((id) => !CORE_IDS.has(id) && existingIds.has(id));
  if (legacyFullRoster) return new Set(all);
  return new Set(all.filter((id) => CORE_IDS.has(id)));
}

/** IDs that used to be in the roster but no longer ship as standard. */
const DEPRECATED_IDS = new Set<string>(["coder-gemini"]);

/**
 * Build a fully-configured agent entry from a canonical roster row.
 * Centralised so both insert and refresh paths produce identical shape.
 */
/** The allow list a seed entry gets for this roster row. */
function seedToolsOf(agent: StandardAgent): string[] {
  return [
    ...new Set([
      ...(agent.toolsAllow ?? []),
      ...VERIFIED_COMPLETION_TOOLS,
      ...APPROVAL_TOOLS,
      ...INFLIGHT_MESSAGING_TOOLS,
      ...FILE_CONTEXT_TOOLS,
    ]),
  ];
}

/**
 * Additive tool upgrade for a current-version seed-managed entry: roster
 * default tools added since this entry last saw the roster are appended to its
 * allow list. Nothing is removed, and a default the operator removed is not
 * re-added once recorded in `_seedTools`. Returns the same object when there
 * is nothing to do.
 */
function addNewSeedTools(
  entry: Record<string, unknown>,
  std: StandardAgent,
): Record<string, unknown> {
  if (!std.toolsAllow || std.toolsAllow.length === 0) return entry;
  const tools = entry.tools as { allow?: unknown } | undefined;
  if (!tools || !Array.isArray(tools.allow)) return entry;
  const offered = seedToolsOf(std);
  const seen = new Set(
    Array.isArray(entry._seedTools) ? (entry._seedTools as unknown[]).map(String) : [],
  );
  const allow = tools.allow.map(String);
  const additions = offered.filter((t) => !seen.has(t) && !allow.includes(t));
  const seenChanged = offered.some((t) => !seen.has(t)) || seen.size !== offered.length;
  if (additions.length === 0 && !seenChanged) return entry;
  return {
    ...entry,
    tools: { ...tools, allow: [...allow, ...additions] },
    _seedTools: offered,
  };
}

function buildSeedEntry(agent: StandardAgent): Record<string, unknown> {
  return {
    id: agent.id,
    name: agent.name,
    ...(agent.systemPrompt ? { systemPrompt: agent.systemPrompt } : {}),
    ...(agent.modelHint ? { model: agent.modelHint } : {}),
    ...(agent.type ? { type: agent.type } : { type: "native" }),
    ...(agent.cliCommand ? { cliCommand: agent.cliCommand } : {}),
    // Verified completion is a core principle: every agent that has an allow
    // list also gets subagents_wait / subagents_events / visual_verify.
    ...(agent.toolsAllow && agent.toolsAllow.length > 0
      ? {
          tools: {
            allow: [
              ...new Set([
                ...agent.toolsAllow,
                ...VERIFIED_COMPLETION_TOOLS,
                ...APPROVAL_TOOLS,
                ...INFLIGHT_MESSAGING_TOOLS,
                ...FILE_CONTEXT_TOOLS,
              ]),
            ],
          },
        }
      : {}),
    ...(agent.skillsAllow && agent.skillsAllow.length > 0
      ? { skills: { allow: [...agent.skillsAllow] } }
      : {}),
    ...(agent.delegatesTo && agent.delegatesTo.length > 0
      ? { subagents: { allowAgents: [...agent.delegatesTo] } }
      : {}),
    // For CLI agents, default to auto-approve so the operator can spawn
    // delegations without an extra confirmation per run.
    ...(agent.type === "cli" ? { autoApprove: true } : {}),
    // Marker so future seed runs know we own this entry and may refresh it.
    _seedVersion: ROSTER_VERSION,
    ...(agent.toolsAllow && agent.toolsAllow.length > 0 ? { _seedTools: seedToolsOf(agent) } : {}),
  };
}

/**
 * Heuristic for "this is a seed-managed entry an older seed wrote without a
 * version tag, safe to upgrade." Empty / whitespace-only systemPrompt is the
 * fingerprint of the prior roster (which seeded id+name only). Any agent the
 * user has actually edited will have a non-empty prompt.
 */
function looksLikeStaleSeed(entry: Record<string, unknown>): boolean {
  const prompt = entry.systemPrompt;
  if (typeof prompt !== "string") return true;
  return prompt.trim().length === 0;
}

/**
 * Add the standard roster to a config's `agents.list` and refresh any
 * already-present standard entries the operator hasn't customized.
 *
 * Three things happen on every boot:
 *   1. Deprecated agents (`coder-gemini`) are dropped.
 *   2. Missing canonical agents from the enabled packs are inserted with the
 *      full role config (fresh install: `core` only; see ROSTER_PACKS).
 *   3. Existing canonical agents are *refreshed* when:
 *        - `_seedVersion` is present and not equal to `ROSTER_VERSION`, OR
 *        - the entry looks like the prior name-only seed (empty prompt).
 *      Refresh rewrites name, prompt, type/cliCommand, tools, skills and
 *      delegates from the canonical row. User-customized entries (non-empty
 *      prompt and no `_seedVersion`) are left strictly alone.
 *
 * The flag-based design means: the first boot under this version refreshes
 * everything stale; subsequent boots are no-ops until `ROSTER_VERSION` bumps.
 *
 * Returns the same config object (mutated) so callers can chain or spread it.
 */
export function seedStandardAgents(cfg: InfinibotConfig): InfinibotConfig {
  const agentsBlock = ((cfg as Record<string, unknown>).agents ?? {}) as {
    defaults?: unknown;
    list?: Array<Record<string, unknown>>;
  };
  const existing = Array.isArray(agentsBlock.list) ? agentsBlock.list : [];
  const rosterById = new Map(STANDARD_AGENT_ROSTER.map((a) => [a.id, a] as const));

  let mutated = false;

  // 1. Drop deprecated agents (coder-gemini etc.).
  const afterDrop = existing.filter((a) => {
    const id = typeof a?.id === "string" ? a.id : "";
    if (DEPRECATED_IDS.has(id)) {
      mutated = true;
      return false;
    }
    return true;
  });

  // 2. Refresh stale / version-drifted canonical entries.
  const haveIds = new Set<string>();
  const refreshed = afterDrop.map((entry) => {
    const id = typeof entry.id === "string" ? entry.id : "";
    if (id) haveIds.add(id);
    const std = rosterById.get(id);
    if (!std) return entry;
    const tag = typeof entry._seedVersion === "string" ? entry._seedVersion : undefined;
    const versionDrift = tag !== undefined && tag !== ROSTER_VERSION;
    const staleNoTag = tag === undefined && looksLikeStaleSeed(entry);
    if (!versionDrift && !staleNoTag) {
      const upgraded = addNewSeedTools(entry, std);
      if (upgraded !== entry) mutated = true;
      return upgraded;
    }
    mutated = true;
    // Preserve operator-owned identity bits we shouldn't overwrite even when
    // refreshing: avatar/identity block, references list, default flag.
    const preserved: Record<string, unknown> = {};
    if (entry.identity) preserved.identity = entry.identity;
    if (entry.references) preserved.references = entry.references;
    if (entry.default === true) preserved.default = true;
    if (entry.disabled === true) preserved.disabled = true;
    return { ...buildSeedEntry(std), ...preserved };
  });

  // 3. Insert missing canonical entries from the enabled packs. Agents from
  //    packs that aren't enabled are simply not added; nothing is removed.
  const seedIds = resolveSeededRosterIds(cfg, haveIds);
  const additions = STANDARD_AGENT_ROSTER.filter(
    (a) => !haveIds.has(a.id) && seedIds.has(a.id),
  ).map(buildSeedEntry);
  if (additions.length > 0) mutated = true;

  if (!mutated) return cfg;

  (cfg as Record<string, unknown>).agents = {
    ...agentsBlock,
    list: [...refreshed, ...additions],
  };
  return cfg;
}
