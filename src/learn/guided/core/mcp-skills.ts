import type { LearnTrack } from "../types.js";

/**
 * MCP & skills: the MCP page (ui/src/ui/views/mcp.ts: Tools / Skills / MCPs
 * tabs, status bar, Quick Install for external agents, Discover, MCP
 * servers), plugin-bundled MCP servers (Whiteboard's Excalidraw server under
 * What it adds), and the Skills page (ui/src/ui/views/skills.ts: discover,
 * self-generated skills, drafts, healing, settings).
 *
 * Explain-only for anything that installs, writes a client config, starts /
 * stops the MCP server, reveals or rotates the gateway key, or runs
 * self-improve.
 */
export const track: LearnTrack = {
  id: "mcp-skills",
  title: "MCP & skills",
  summary:
    "Give your agents more tools with MCP servers, let outside agents like Claude Code use InfiniBot, and manage the skills your agents learn.",
  overview: [
    "Agents do things through **tools**. InfiniBot has native tools built in, adds more through **MCP servers**, and teaches agents how to use them with **skills**.",
    "",
    "This track covers:",
    "- **The MCP page.** Three tabs: **Tools** (native tools), **Skills** and **MCPs** (the MCP server, its status and every configured server).",
    "- **Adding servers.** One-click integrations from Discover, the public registry, or a custom command. Plugins can bundle their own MCP servers, which are listed only while the plugin is on.",
    "- **The InfiniBot MCP bridge.** Quick Install gives Claude Code, Claude Desktop, Cursor, Codex CLI and other clients the snippet that points them at this gateway, so an outside agent can use InfiniBot's tools.",
    "- **Skills.** Each skill is a `SKILL.md` folder that teaches an agent a task. Browse and create them, and review what the agent learns on its own: self-generated skills, drafts and healing proposals.",
  ].join("\n"),
  category: "Agents",
  level: "advanced",
  certRequired: true,
  order: 55,
  estMinutes: 15,
  routes: ["/mcp", "/skills"],
  signals: ["mcp", "skills"],
  badge: { id: "mcp-skills", label: "Toolsmith", icon: "🔌" },
  walkthroughs: [
    {
      id: "mcp-page",
      title: "Tools and MCP servers",
      summary: "Native tools, the MCP server and the list of configured servers.",
      estMinutes: 3,
      steps: [
        {
          id: "tabs",
          title: "Three tabs",
          body: "**Tools** are built into InfiniBot. **Skills** teach agents how to use them. **MCPs** are the extra servers that add more tools.",
          route: "/mcp",
          target: "learn:mcp-tabs",
          placement: "bottom",
          waitMs: 12000,
        },
        {
          id: "open-tools",
          title: "Native tools",
          body: "Click **Tools**.",
          target: "learn:mcp-tab-tools",
          action: { kind: "click" },
        },
        {
          id: "tools",
          title: "What agents can already do",
          body: "Kanban, files, web, browser, memory, cron, sessions, workflows, notes and research. Each card shows its transport, its tool count and whether it's running.",
          target: ["learn:mcp-native-tools", "learn:mcp-tabs"],
        },
        {
          id: "open-mcps",
          title: "MCP servers",
          body: "Click **MCPs**.",
          target: "learn:mcp-tab-mcps",
          action: { kind: "click" },
        },
        {
          id: "status",
          title: "The MCP server",
          body: "Shows whether InfiniBot's MCP server is running, on which port, and how many servers are enabled. **Restart**, **Stop** and **Start** control it.",
          target: "learn:mcp-status",
          placement: "bottom",
          practice: {
            mode: "explain",
            note: "This tour doesn't start, stop or restart the MCP server. Stopping it disconnects every client using it.",
          },
        },
        {
          id: "servers",
          title: "Configured servers",
          body: "Every MCP server this gateway knows, grouped by category. **Browse registry** searches public servers and **Add custom** takes any command. Both add a server, so they aren't clicked here.",
          target: ["learn:mcp-servers-title", "learn:mcp-status"],
          placement: "top",
        },
      ],
    },
    {
      id: "connect-external-agent",
      title: "Let Claude Code use InfiniBot",
      summary: "Quick Install: the endpoint, scope and config snippet for an external MCP client.",
      estMinutes: 3,
      steps: [
        {
          id: "open-mcps",
          title: "Open MCPs",
          body: "Click **MCPs**.",
          route: "/mcp",
          target: "learn:mcp-tab-mcps",
          action: { kind: "click" },
          waitMs: 12000,
        },
        {
          id: "quick-install",
          title: "Quick Install",
          body: "InfiniBot is an MCP server too. Point Claude Code, Cursor or any MCP client here and it can use InfiniBot's tools, sub-agents and boards.",
          target: "learn:mcp-quick-install",
          placement: "bottom",
        },
        {
          id: "scopes",
          title: "Local, LAN or Tailscale",
          body: "Pick where the client runs. **Local** is this machine. **LAN** exposes the gateway to your network, so turn on a key. **Tailscale** is the secure way in from outside.",
          target: ["learn:mcp-quick-scopes", "learn:mcp-quick-install"],
        },
        {
          id: "clients",
          title: "Pick your client",
          body: "Choose the client and your OS: Claude Code, Claude Desktop, Cursor, Windsurf, Cline, Continue, Codex CLI, OpenCode or a generic JSON or HTTP setup.",
          target: ["learn:mcp-quick-clients", "learn:mcp-quick-install"],
        },
        {
          id: "snippet",
          title: "Copy the snippet",
          body: "Paste this into the config file shown under it, or run it for Claude Code. The **Claude Code** button in the status bar writes the entry for you.",
          target: ["learn:mcp-quick-snippet", "learn:mcp-quick-install"],
          practice: {
            mode: "explain",
            note: "This tour doesn't write any client config or reveal the gateway key. The snippet uses the key, so keep it private.",
          },
        },
      ],
    },
    {
      id: "add-integrations",
      title: "Find integrations and plugin servers",
      summary: "Search one-click integrations, and see MCP servers a plugin brings with it.",
      estMinutes: 3,
      steps: [
        {
          id: "open-mcps",
          title: "Open MCPs",
          body: "Click **MCPs**.",
          route: "/mcp",
          target: "learn:mcp-tab-mcps",
          action: { kind: "click" },
          waitMs: 12000,
        },
        {
          id: "discover",
          title: "Discover",
          body: "Featured integrations you can add in one click, filtered by category.",
          target: "learn:mcp-discovery",
          placement: "top",
        },
        {
          id: "search",
          title: "Search integrations",
          body: "Type **github**.",
          target: "learn:mcp-discovery-search",
          action: { kind: "input", match: "git", sample: "github" },
        },
        {
          id: "install",
          title: "Installing one",
          body: "Installing opens a short dialog that asks for any keys the integration needs, then adds the server. Its tools then appear to your agents.",
          target: "learn:mcp-discovery",
          practice: {
            mode: "explain",
            note: "This tour doesn't install anything or ask for keys.",
          },
        },
        {
          id: "plugin-servers",
          title: "Servers inside plugins",
          body: "Plugins can bundle MCP servers. Whiteboard, for example, brings the Excalidraw canvas tools. They're listed under the plugin's **What it adds** and run only while the plugin is on.",
          route: "/plugins?plugin=whiteboard&ptab=contributions",
          target: [
            '[data-contribution^="mcp:"]',
            "learn:plugin-section-contributions",
            "learn:plugin-detail-nav",
          ],
          waitMs: 12000,
        },
      ],
    },
    {
      id: "skills",
      title: "Browse and create skills",
      summary: "The Skills page: what's active, what needs setup, and how to write your own.",
      estMinutes: 3,
      steps: [
        {
          id: "stats",
          title: "The Skills page",
          body: "At a glance: active skills, pending drafts and healing proposals, and what you accepted or rejected in the last week.",
          route: "/skills",
          target: ["learn:skills-stats", "main.content"],
          placement: "bottom",
          waitMs: 12000,
        },
        {
          id: "open-active",
          title: "Active skills",
          body: "Click **Active Skills**.",
          target: "learn:skills-tab-active",
          action: { kind: "click" },
        },
        {
          id: "discover",
          title: "Discover skills",
          body: "Each skill is a `SKILL.md` folder that teaches an agent a task. Filter by category or status: **Enabled**, **Needs setup** (missing a binary or key) or **Disabled**.",
          target: "learn:skills-discover",
          placement: "bottom",
        },
        {
          id: "search",
          title: "Search",
          body: "Search by name, description, trigger or requirement. Type **github**.",
          target: "learn:skills-search",
          action: { kind: "input", match: "git", sample: "github" },
        },
        {
          id: "create",
          title: "Write your own",
          body: "**Create skill** opens a form: name, description, when to use it, allowed tools and step-by-step instructions. It saves a new `SKILL.md` your agents can use.",
          target: "learn:skills-create",
          practice: {
            mode: "explain",
            note: "This tour doesn't create a skill.",
          },
        },
      ],
    },
    {
      id: "learned-skills",
      title: "Skills your agents learn",
      summary:
        "Self-generated skills, drafts to review, healing proposals and the settings behind them.",
      estMinutes: 3,
      prerequisites: ["skills"],
      steps: [
        {
          id: "self-generated",
          title: "Self-generated skills",
          body: "The agent distils skills from its own completed runs and refines them once they're used enough. **Run Self-Improve** refines eligible skills on demand.",
          route: "/skills",
          target: ["learn:skills-learned", "learn:skills-stats"],
          placement: "top",
          waitMs: 12000,
          practice: {
            mode: "explain",
            note: "This tour doesn't run Self-Improve, which calls a model.",
          },
        },
        {
          id: "open-drafts",
          title: "Drafts",
          body: "Click **Drafts**.",
          target: "learn:skills-tab-drafts",
          action: { kind: "click" },
        },
        {
          id: "drafts",
          title: "Review before promoting",
          body: "Skill candidates generated from completed runs. Accept one to install it, or reject it. With auto-approval on, accepted drafts go straight to self-generated skills.",
          target: ["learn:skills-drafts", "learn:skills-stats"],
        },
        {
          id: "open-healing",
          title: "Healing",
          body: "Click **Healing**.",
          target: "learn:skills-tab-healing",
          action: { kind: "click" },
        },
        {
          id: "healing",
          title: "Fixes for existing skills",
          body: "When a task fails because a skill was wrong, InfiniBot proposes a correction. Compare it with the current skill, then apply or reject it.",
          target: ["learn:skills-healing", "learn:skills-stats"],
        },
        {
          id: "open-settings",
          title: "Settings",
          body: "Click **Settings** to control when the system drafts and proposes new skills.",
          target: "learn:skills-tab-settings",
          action: { kind: "click" },
        },
      ],
    },
  ],
  quiz: [
    {
      id: "bridge",
      prompt: "How do you let Claude Code use InfiniBot's tools?",
      options: [
        "You can't, InfiniBot only works in its own UI",
        "Add InfiniBot as an MCP server with the snippet from MCP › Quick Install",
        "Install Claude Code as a plugin",
        "Paste your chat history into Claude Code",
      ],
      answer: 1,
      explain:
        "Quick Install generates the endpoint and config for Claude Code, Cursor, Codex CLI and other MCP clients.",
    },
    {
      id: "plugin-mcp",
      prompt: "A plugin bundles an MCP server. When do its tools reach your agents?",
      options: [
        "Always, even when the plugin is off",
        "Only while the plugin is enabled",
        "Only after you copy it into the config by hand",
        "Never, plugins can't ship MCP servers",
      ],
      answer: 1,
      explain:
        "Plugin MCP servers are surfaced only while the plugin is on, and are listed under its What it adds.",
    },
    {
      id: "skill-file",
      prompt: "What is a skill?",
      options: [
        "A paid add-on",
        "A folder with a SKILL.md that teaches an agent how to do a task",
        "Another name for an MCP server",
        "A sidebar favorite",
      ],
      answer: 1,
      explain:
        "Skills are SKILL.md folders with frontmatter and instructions. Agents load the ones whose requirements are met.",
    },
    {
      id: "healing",
      prompt: "What is a healing proposal?",
      options: [
        "A request to restart the gateway",
        "A proposed correction to an existing skill, triggered by a task failure",
        "A new plugin suggestion",
        "A backup of your settings",
      ],
      answer: 1,
      explain:
        "Healing proposes a fix to a skill that led to a failure. You review it before it's applied.",
    },
  ],
};
