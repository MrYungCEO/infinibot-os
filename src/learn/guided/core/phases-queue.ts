import type { LearnTrack } from "../types.js";

/**
 * Phases & the agent queue — the persistent phase queue (src/queue) on
 * Autonomy › Phases: phased entries, per-phase agents, gate checks, dispatch.
 * Sources: ui/src/ui/views/autonomy-phases.ts, docs/autonomy/PHASES.md,
 * src/agents/tools/queue-run-tool.ts.
 */
export const track: LearnTrack = {
  id: "phases-queue",
  title: "Phases & the agent queue",
  summary:
    "Split big work into phases, give each phase its own agent and gate checks, and let the queue run them in order.",
  overview: [
    "The **phase queue** runs an **entry**: a brief plus an ordered list of **phases**. Each phase can use a different agent (Claude Code, Codex, OpenCode, Gemini CLI or a gateway agent) and model, with an optional fallback agent.",
    "",
    "**A phase completes only when its run is VERIFIED (or you accept it) and its gate checks pass.** Failed attempts retry in the same agent session up to the phase's limit. Then the entry is **blocked** with a concrete fix. The queue is stored in the gateway, so entries survive restarts.",
    "",
    "This track covers:",
    "- **The queue at a glance.** Dispatch, backend health and the entry list on Autonomy › Phases.",
    "- **Building an entry.** Title, brief, isolation, phases and gate checks.",
    "- **Gates, blocks and live progress.** What happens when a phase fails, and where queue events show up.",
    "",
    "Agents can queue the same work with the `queue_run` tool, and there's a CLI too: `infinibot queue add`.",
  ].join("\n"),
  category: "Autonomy",
  level: "advanced",
  certRequired: true,
  order: 50,
  prerequisites: ["goals"],
  routes: ["/autonomy"],
  signals: ["autonomy"],
  badge: { id: "phases-queue", label: "Orchestrator", icon: "🧬" },
  walkthroughs: [
    {
      id: "queue-at-a-glance",
      title: "The queue at a glance",
      summary: "Dispatch, CLI backend health, entry filters and how phased entries work.",
      estMinutes: 3,
      steps: [
        {
          id: "open-phases",
          title: "Open Autonomy › Phases",
          body: "The phase queue lives on the **Phases** tab of the Autonomy page. Click it.",
          route: "/autonomy",
          target: "learn:autonomy-tab-phases",
          action: { kind: "click" },
        },
        {
          id: "dispatch",
          title: "Dispatch switch",
          body: "When dispatch is **running**, the queue starts eligible entries on its own. Pausing it holds everything that hasn't started yet. It's one switch for the whole queue.",
          target: "learn:phases-dispatch",
          practice: {
            mode: "explain",
            note: "The tour doesn't flip this switch: pausing dispatch stops every queued entry from starting.",
          },
        },
        {
          id: "backends",
          title: "Backend health",
          body: "Each coding CLI shows whether it's **ok**, **not logged in** or **not installed**. Hover a chip for the fix. **Re-check** probes them again. A phase on a missing CLI blocks, or moves to its fallback agent.",
          target: "learn:phases-backends",
        },
        {
          id: "filter-blocked",
          title: "Find blocked entries",
          body: "Click **Blocked** to see entries waiting on you. It covers blocked entries and dead-letter ones that crashed repeatedly.",
          target: "learn:phases-filter-blocked",
          action: { kind: "click" },
        },
        {
          id: "filter-all",
          title: "Back to all entries",
          body: "Click **All** to see the whole queue again.",
          target: "learn:phases-filter-all",
          action: { kind: "click" },
          check: { kind: "rpc", method: "queue.list", path: "entries", min: 0 },
        },
        {
          id: "how",
          title: "How phased entries work",
          body: "Phases run in order. Each one completes only when the run is verified and every gate check passes, never just because the process exited. Select an entry to see each phase, its attempts and logs.",
          target: ["learn:phases-how", "learn:phases-list"],
          placement: "left",
        },
      ],
    },
    {
      id: "build-an-entry",
      title: "Build a phased entry",
      summary:
        "Draft an entry with a brief, isolation, a phase and a gate check, without queuing it.",
      estMinutes: 4,
      prerequisites: ["queue-at-a-glance"],
      steps: [
        {
          id: "open-phases",
          title: "Go to Phases",
          body: "Click the **Phases** tab.",
          route: "/autonomy",
          target: "learn:autonomy-tab-phases",
          action: { kind: "click" },
        },
        {
          id: "open-composer",
          title: "Open the form",
          body: "Click **New phased entry** to open the form.",
          target: "learn:phases-composer-toggle",
          action: { kind: "click" },
          skipIf: { kind: "element", target: "learn:phases-title-input" },
        },
        {
          id: "title",
          title: "Name the entry",
          body: "Give the whole piece of work a short title.",
          target: "learn:phases-title-input",
          action: { kind: "input", sample: "Billing page v2" },
        },
        {
          id: "brief",
          title: "Write the brief",
          body: "The brief is shared with every phase, so put the overall goal and constraints here.",
          target: "learn:phases-brief-input",
          action: {
            kind: "input",
            sample:
              "Add a billing page with plan, invoices and payment method. Keep all tests green.",
          },
        },
        {
          id: "isolation",
          title: "Isolation and priority",
          body: "**None** runs in your project folder. **One worktree per entry** gives the entry its own git branch. **One worktree per phase** branches each phase from the previous one. Higher priority entries dispatch first.",
          target: "learn:phases-isolation",
        },
        {
          id: "phase-name",
          title: "Name the first phase",
          body: "Each phase has its own name, brief, agent, model, fallback agent, attempt limit and timeout. Type a name for phase 1.",
          target: "learn:phases-phase-name-0",
          action: { kind: "input", sample: "Implement API" },
        },
        {
          id: "gate",
          title: "Add a gate check",
          body: "With no gate checks, the verification verdict alone decides. Click **+ Add gate check** to require a command, file or AI-judge check as well.",
          target: "learn:phases-add-gate-0",
          action: { kind: "click" },
        },
        {
          id: "gate-row",
          title: "Gate checks",
          body: "The default gate is a **Command** check like `pnpm test`, which passes when it exits 0. You can also check a file exists, a file contains a pattern, or ask an AI judge.",
          target: "learn:phases-gate-0",
        },
        {
          id: "queue",
          title: "Queue it",
          body: "The **Queue** button adds the entry. It starts when dispatch is running and a slot is free (two at a time by default). Clear resets the form.",
          target: "learn:phases-queue-btn",
          practice: {
            mode: "explain",
            note: "The tour doesn't queue the entry: once queued, real agents start working in your project folder and use your model credits.",
          },
        },
      ],
    },
    {
      id: "gates-and-blocks",
      title: "Gates, blocks and live progress",
      summary: "What happens when a phase fails, how to unblock it, and where queue events appear.",
      estMinutes: 3,
      prerequisites: ["queue-at-a-glance"],
      steps: [
        {
          id: "attempts",
          title: "Attempts and retries",
          body: "An attempt that ends **unverified**, fails its gate or times out counts toward the phase's max attempts. The retry resumes the same agent session and includes the failing reasons or gate output.",
          route: "/autonomy",
          placement: "center",
        },
        {
          id: "blocked",
          title: "When an entry blocks",
          body: "A blocked entry says why: a gate failed, the run was unverified, the agent needs input, the CLI isn't available or it timed out. Open it to **Retry now** with an instruction, another agent or model, or a fresh session. **Skip phase** advances past it.",
          target: ["learn:autonomy-tab-phases", "learn:autonomy-tabs"],
        },
        {
          id: "accept",
          title: "Accepting a verdict",
          body: "If a phase is blocked as unverified and you've checked the work yourself, accept the run on Reviews › Oversight. The queue then advances by itself.",
          target: ["learn:autonomy-tab-phases", "learn:autonomy-tabs"],
          practice: {
            mode: "explain",
            note: "Accepting a run is an operator decision, so the tour only describes it.",
          },
        },
        {
          id: "activity-strip",
          title: "Live queue events",
          body: "The Activity page opens with a gold **Queue** strip that shows lifecycle events as they happen: queued, phase started, phase complete, blocked, done.",
          route: "/activity",
          target: ["learn:activity-queue-strip", "queue-activity-strip"],
          placement: "bottom",
        },
        {
          id: "mesh",
          title: "On the Agent Mesh",
          body: "The full Agent Mesh map shows queued and blocked entries in a **Holding Zone** off to the side of the main floor, with a pip for each phase.",
          target: ['a.nav-item[data-tab-pill="mesh"]', "main.content"],
          skipIf: { kind: "viewport", maxWidth: 800 },
        },
      ],
    },
  ],
  quiz: [
    {
      id: "phase-complete",
      prompt: "When does a phase complete?",
      options: [
        "As soon as the agent's process exits",
        "When the run is VERIFIED (or accepted) and its gate checks pass",
        "After a fixed timeout",
        "When the next phase starts",
      ],
      answer: 1,
      explain:
        "A phase advances only on a verified (or operator-accepted) run with a passing gate.",
    },
    {
      id: "per-phase-agent",
      prompt: "Can each phase use a different agent?",
      options: [
        "No, the whole entry uses one agent",
        "Yes, each phase picks its own agent, model and optional fallback",
        "Only gateway agents are allowed",
        "Only if isolation is off",
      ],
      answer: 1,
      explain:
        "Every phase has its own agent and model, plus an optional fallback agent when a CLI is missing or logged out.",
    },
    {
      id: "isolation",
      prompt: "What does “One worktree per entry” do?",
      options: [
        "Runs every phase in your project folder",
        "Gives the entry its own git worktree and branch",
        "Deletes the branch after each phase",
        "Runs phases in parallel",
      ],
      answer: 1,
      explain:
        "Entry isolation gives the whole entry one worktree and branch. Phase isolation gives each phase its own branch.",
    },
    {
      id: "retry-session",
      prompt: "A phase fails its gate. What does the retry do?",
      options: [
        "Starts over with a brand-new agent every time",
        "Resumes the same agent session with the failing output as feedback",
        "Skips to the next phase",
        "Cancels the entry",
      ],
      answer: 1,
      explain:
        "Retries resume the same session and include the failing verdict reasons or gate output.",
    },
  ],
};
