import type { LearnTrack } from "../types.js";

/**
 * Agents — the Agents page (Agent Control), creating and configuring agents
 * (model, tools, skills, sub-agent allowlist, prompt), and supervising runs on
 * Activity and Reviews › Oversight.
 * Sources: ui/src/ui/views/agents-management.ts, views/agent-popup.ts,
 * views/agent-activity*.ts, views/oversight/index.ts.
 */
export const track: LearnTrack = {
  id: "agents",
  title: "Agents",
  summary:
    "Meet your agent roster, create and configure agents, and watch their runs and sub-agents as they work.",
  overview: [
    "InfiniBot runs a **team of agents**. Each one has an id, a model (or a CLI such as Claude Code or Codex), a system prompt, and allowlists of the tools, skills, MCP servers and sub-agents it may use. Your **default** agent answers when you don't pick one.",
    "",
    "Agents can hand work to **sub-agents** and coding CLIs. Those runs show up live on the **Activity** page and stay reviewable on **Reviews › Oversight**, with a verdict for every finished run.",
    "",
    "This track covers:",
    "- **Agent Control.** The Agents page, its counts and the status of every agent.",
    "- **Creating an agent.** Native (a direct LLM) or CLI (a subprocess).",
    "- **Configuring an agent.** Model, tools, skills, sub-agents and prompt.",
    "- **Watching runs.** Activity, the queue strip and Oversight.",
  ].join("\n"),
  category: "Agents",
  level: "intermediate",
  certRequired: true,
  order: 30,
  prerequisites: ["chat-models"],
  routes: ["/agents", "/activity"],
  signals: ["agents", "activity", "subagents", "mesh"],
  badge: { id: "agents", label: "Team lead", icon: "🤖" },
  walkthroughs: [
    {
      id: "agent-control",
      title: "Tour Agent Control",
      summary: "Read the roster counts, the status colours and the page controls.",
      estMinutes: 2,
      steps: [
        {
          id: "header",
          title: "Agent Control",
          body: "The Agents page lists every agent the gateway knows about. The counts show how many are active right now, how many agents exist and how many sessions they hold.",
          route: "/agents",
          target: ["learn:agents-header", ".agp-top"],
          placement: "bottom",
          check: { kind: "rpc", method: "agents.list", path: "agents", min: 1 },
          checkHint: "Loading your agents…",
        },
        {
          id: "roster",
          title: "Your roster",
          body: "Each agent appears here. Click one to open its detail panel with its sessions, tools, skills, MCP servers, sub-agents, references and prompt.",
          target: ["learn:agents-map", ".agp-main", "learn:agents-header", ".agp-top"],
        },
        {
          id: "legend",
          title: "Status colours",
          body: "**Active** agents have a live session, **Default** is the agent that answers when none is picked, **Idle** agents are ready, and **Offline** ones are disabled.",
          target: ["learn:agents-legend", ".agp-rail", "learn:agents-map", ".agp-main"],
        },
        {
          id: "refresh",
          title: "Refresh",
          body: "Click **Refresh** to reload the list from the gateway.",
          target: ["learn:agents-refresh", '.agp-actions [aria-label="Refresh"]'],
          action: { kind: "click" },
        },
      ],
    },
    {
      id: "create-agent",
      title: "Draft a new agent",
      summary:
        "Open the New Agent form and see what a native or CLI agent needs, without creating one.",
      estMinutes: 3,
      prerequisites: ["agent-control"],
      steps: [
        {
          id: "new",
          title: "New Agent",
          body: "Click **New Agent** to open the form.",
          route: "/agents",
          target: ["learn:agents-new", ".agp-actions .agp-primary"],
          action: { kind: "click" },
        },
        {
          id: "id",
          title: "Pick an id",
          body: "The id is how chats, tools and other agents refer to this agent: lowercase, no spaces. Type one.",
          target: "learn:agents-create-id",
          action: { kind: "input", sample: "research-helper" },
        },
        {
          id: "type",
          title: "Native or CLI",
          body: "A **Native** agent calls an LLM directly, with an optional model and system prompt. A **CLI** agent runs a command such as `claude` or `codex` as a subprocess, with its own timeout.",
          target: "learn:agents-create-type",
        },
        {
          id: "auto-approve",
          title: "Careful with auto-approve",
          body: "CLI agents have an **Auto-Approve** switch, marked DANGEROUS. It lets the CLI run tools without asking. Leave it off unless you fully trust the workspace.",
          target: "learn:agents-create-type",
        },
        {
          id: "create",
          title: "Create Agent",
          body: "**Create Agent** adds it to your gateway config, using the workspace folder you entered. It then appears in the roster, the chat agent picker and the goal and phase agent lists.",
          target: "learn:agents-create-submit",
          practice: {
            mode: "explain",
            note: "The tour doesn't create the agent: it would add a real entry to your gateway configuration.",
          },
        },
        {
          id: "cancel",
          title: "Close the form",
          body: "Click **Cancel** to throw the draft away.",
          target: "learn:agents-create-cancel",
          action: { kind: "click" },
        },
      ],
    },
    {
      id: "configure-agent",
      title: "Configure an agent",
      summary:
        "Open quick config, pick an agent and see its model, tools, skills, sub-agents and prompt.",
      estMinutes: 3,
      prerequisites: ["agent-control"],
      steps: [
        {
          id: "config",
          title: "Quick config",
          body: "Click **Config** to open quick agent configuration.",
          route: "/agents",
          target: ["learn:agents-config", '.agp-actions [aria-label="Agent defaults"]'],
          action: { kind: "click" },
        },
        {
          id: "pick",
          title: "Pick an agent",
          body: "Every agent is listed, with a **DEFAULT** tag on your default. Click the first one.",
          target: "learn:agents-config-agent",
          action: { kind: "click" },
        },
        {
          id: "model",
          title: "Model",
          body: "The **Model** tab sets this agent's model. **Default** inherits the global model from Setup. Changes save straight away.",
          target: ["learn:agents-config-tab-model", "learn:agents-config-popup"],
          practice: {
            mode: "explain",
            note: "The tour doesn't change the model: the select saves to the agent's config as soon as you pick.",
          },
        },
        {
          id: "tabs",
          title: "Tools, skills, sub-agents, prompt",
          body: "**Tools** and **Skills** are allowlists of what the agent may use. **Sub-agents** lists the agents it may spawn (empty means all). **Prompt** holds its custom system prompt.",
          target: ["learn:agents-config-tab-tools", "learn:agents-config-popup"],
        },
        {
          id: "full-detail",
          title: "More in the detail panel",
          body: "Selecting an agent on the page opens the full panel, which adds its sessions, MCP servers, references and, for CLI agents, CLI settings.",
          target: ["learn:agents-config-popup", "learn:agents-header", ".agp-top"],
        },
        {
          id: "close",
          title: "Close quick config",
          body: "Click **×** to close it.",
          target: "learn:agents-config-close",
          action: { kind: "click" },
        },
      ],
    },
    {
      id: "parallel-sub-agents",
      title: "Run sub-agents in parallel",
      summary:
        "Ask once and let several agents work at the same time, then watch and review their runs.",
      estMinutes: 3,
      steps: [
        {
          id: "ask",
          title: "Ask for a team, not a single answer",
          body: "In chat, describe the jobs and say they can run **in parallel**. Your agent starts one sub-agent per job (a coder, a researcher, a writer) and keeps talking to you while they work.",
          route: "/webchat",
          target: ["learn:chat-input", "learn:chat-composer", "main.content"],
          action: {
            kind: "input",
            sample:
              "Start three sub-agents in parallel: one researches our top 3 competitors, one drafts a launch email, one writes tests for the signup flow.",
          },
        },
        {
          id: "send",
          title: "Send it when you're ready",
          body: "Give each job a clear goal and keep them separate (different files or topics), so the agents don't step on each other.",
          target: ["learn:chat-send", "learn:chat-composer"],
          practice: {
            mode: "explain",
            note: "The tour doesn't send it for you: each sub-agent is a real run that uses your model credits. Send it whenever you want to try.",
          },
        },
        {
          id: "map",
          title: "See them on the map",
          body: "Every sub-agent you start shows up live on the agent map, walking to its room while it works.",
          route: "/mesh",
          target: ["main.content"],
          placement: "center",
        },
        {
          id: "activity",
          title: "Follow each run",
          body: "Activity gives every parallel run its own card with live steps and output. You can open, pause or stop any of them.",
          route: "/activity",
          target: ["learn:activity-running", "learn:activity-header", "main.content"],
        },
        {
          id: "review",
          title: "Check the results",
          body: "When a run finishes, Reviews › Oversight shows what it changed and a verified, unverified or failed verdict. Only trust results marked **verified**.",
          route: "/reviews?view=oversight",
          target: ["learn:oversight-main", "main.content"],
          check: { kind: "route", path: "/reviews" },
        },
      ],
    },
    {
      id: "watch-runs",
      title: "Watch agents work",
      summary: "Follow live runs on Activity and review finished sub-agent runs in Oversight.",
      estMinutes: 3,
      steps: [
        {
          id: "activity",
          title: "Agent Activity",
          body: "Activity is the live view of everything running: sessions by type (native, sub-agent, coder) and a count of live runs. The toggles filter the list and set how often it refreshes.",
          route: "/activity",
          target: ["learn:activity-header", "main.content"],
          placement: "bottom",
        },
        {
          id: "queue-strip",
          title: "Queue events",
          body: "The gold strip at the top shows the phase queue's latest events as they happen.",
          target: ["learn:activity-queue-strip", "queue-activity-strip"],
        },
        {
          id: "stats",
          title: "At a glance",
          body: "Active agents, work completed today, pending tasks and the average run time.",
          target: ["learn:activity-stats", "learn:activity-header"],
        },
        {
          id: "running",
          title: "Running agents",
          body: "Each running agent gets a card with its progress. Click a card for its live steps and output.",
          target: ["learn:activity-running", "learn:activity-stats"],
        },
        {
          id: "completed",
          title: "Recently completed",
          body: "Finished runs stay here for the day. Filter by today or this week, or search them.",
          target: ["learn:activity-completed", "learn:activity-stats"],
        },
        {
          id: "oversight",
          title: "Oversight",
          body: "Reviews › Oversight lists every sub-agent run with its status, backend, files touched and verification verdict. Click a row to expand its review.",
          route: "/reviews?view=oversight",
          target: ["learn:oversight-main", "main.content"],
          check: { kind: "route", path: "/reviews" },
        },
        {
          id: "oversight-search",
          title: "Find a run",
          body: "Search by label, task or run id.",
          target: "learn:oversight-search",
          action: { kind: "input", sample: "coder" },
        },
        {
          id: "oversight-filters",
          title: "Filter what needs you",
          body: "Filter by run status, by your review decision (pending, approved, sent back, drift detected) and time range. **Needs attention** shows only runs with blockers.",
          target: ["learn:oversight-filters", "learn:oversight-header"],
          skipIf: { kind: "viewport", maxWidth: 800 },
        },
      ],
    },
  ],
  quiz: [
    {
      id: "native-vs-cli",
      prompt: "What's the difference between a Native and a CLI agent?",
      options: [
        "Native agents call an LLM directly; CLI agents run a command like claude or codex as a subprocess",
        "CLI agents can't use tools",
        "Native agents only work offline",
        "There is no difference",
      ],
      answer: 0,
      explain: "Native agents talk to a model API. CLI agents spawn a coding CLI as a subprocess.",
    },
    {
      id: "subagent-allowlist",
      prompt: "An agent's Sub-agents allowlist is empty. Which agents may it spawn?",
      options: ["None", "All agents", "Only the default agent", "Only CLI agents"],
      answer: 1,
      explain: "Empty means all agents are allowed. Add entries to restrict it.",
    },
    {
      id: "default-agent",
      prompt: "What does the Default status mean?",
      options: [
        "The agent is disabled",
        "It's the agent that answers when you don't pick one",
        "It has no tools",
        "It was created by the tour",
      ],
      answer: 1,
      explain: "The default agent handles chats and requests that don't name another agent.",
    },
    {
      id: "where-live",
      prompt: "Where do you watch sub-agents and coders while they're running?",
      options: ["Setup", "The Activity page", "API keys", "The Launchpad"],
      answer: 1,
      explain:
        "Activity shows every running session live. Oversight keeps them for review after they finish.",
    },
  ],
};
