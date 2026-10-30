/**
 * Bundled walkthroughs — TS-native so they ship through `tsc` into
 * `dist/` without a separate copy step. Admin-authored walkthroughs
 * still live as JSON under `<state>/learn/tracks/` (loaded by
 * `loadTracksFromDir` in `store.ts`); these are the defaults that
 * cover every major area of the app.
 *
 * Edit these files freely — they round-trip through the same admin UI
 * as user-authored tracks. The JSON copies under `walkthroughs/` are
 * kept in sync as a reference for hand-authoring; runtime reads from
 * this module.
 */

import type { Walkthrough } from "./store.js";

export const BUNDLED_WALKTHROUGHS: Walkthrough[] = [
  {
    id: "welcome",
    title: "Welcome to InfiniBot",
    description:
      "Five minutes to understand what InfiniBot is, how to navigate it, and where to go next. Auto-assigned to every new user.",
    audience: "all",
    defaultForNewUsers: true,
    order: 1,
    category: "Getting started",
    tier: "beginner",
    certRequired: true,
    badge: "first-steps",
    steps: [
      {
        id: "intro",
        title: "What InfiniBot does for you",
        estMinutes: 1,
        body: "InfiniBot is a personal AI control room. Think of it as one place where every tool you use — chat, projects, your calendar, your business pipeline — talks to the same AI agent that knows your context.\n\n**You'll come away from this walkthrough knowing:**\n- How the navigation works\n- How to open a chat and ask the agent to do something\n- Where to find your user profile and language preferences\n- What other walkthroughs exist for the deeper features\n\nEverything is reversible. You can't break anything by clicking around.",
      },
      {
        id: "nav",
        title: "The navigation sidebar",
        estMinutes: 1,
        body: "On the left edge of the screen is your navigation sidebar. Tabs are grouped by purpose:\n\n- **Chat** — single chat, multi-session grid, voice mode\n- **Media** — whiteboard, storyboard\n- **Business** — projects, business center, clients, leads\n- **Agent** — the agent's tools, schedule, autonomy, skills\n- **Settings** — your profile, appearance, integrations, this Learn page\n\nClick around. The active tab highlights in your accent color. Press the tab again to refresh.",
        cta: { label: "Open the Chat page", tab: "webchat" },
      },
      {
        id: "chat",
        title: "Send your first message",
        estMinutes: 2,
        body: 'Open the Chat tab and type something — anything. The agent has access to:\n\n- Your filesystem (under your home directory)\n- Web search and web fetch\n- Your other tabs\' data (it can read your projects, your business, your calendar)\n- Tools like running a shell command, reading a file, generating an image\n\nGood first prompts:\n- *"What can you see in my projects?"*\n- *"Summarize my calendar this week"*\n- *"Help me write a one-pager for X"*\n\nThe agent will tell you when it\'s about to do something risky and ask for permission.',
        verify: { kind: "tab_visited", tab: "webchat" },
      },
      {
        id: "profile",
        title: "Your profile + language",
        estMinutes: 1,
        body: "Settings → Users → click your row. Here you set:\n\n- **Language** — the agent will respond in this by default. Set it to `Spanish — formal` or `Thai` or whatever you need.\n- **Background context** — a short paragraph the agent reads at the start of every session. Put your role, your current focus, your preferences here. The agent will treat this as load-bearing context.\n- **Password** — change your login password.\n\nThe context field is the highest-leverage setting on this page. Treat it like a system prompt for *yourself*.",
        cta: { label: "Open Users", tab: "users" },
      },
      {
        id: "next",
        title: "Where to go next",
        estMinutes: 1,
        body: "You've seen the basics. Pick a walkthrough for the area that matters most to you:\n\n- **Chat & Sessions** — multi-session grid, voice mode, sub-agents\n- **Projects & Kanban** — kanban-style projects with auto-run tasks\n- **Business Center** — revenue tracking, clients CRM, Whop/Stripe sync\n- **Mobile** — install the Android APK from your gateway, or build an iPhone app\n- **Multi-User Admin** *(admin only)* — adding users, page gating, agent directory locking\n\nEach is 5–15 minutes. Mark this one complete and pick the next one from the Library tab.",
      },
    ],
  },

  {
    id: "chat",
    title: "Chat & Sessions",
    description:
      "Single chat, the multi-session grid, voice mode, sub-agents, and how the agent uses your context.",
    audience: "all",
    order: 10,
    category: "Chat",
    tier: "beginner",
    certRequired: true,
    steps: [
      {
        id: "single-chat",
        title: "The single-chat tab",
        estMinutes: 1,
        cta: { label: "Open Chat", tab: "webchat" },
        body: "Chat tab → top center is the message bar, history scrolls above. Each session is a separate conversation with its own memory window. The agent can:\n\n- Read & write files in your home directory\n- Search the web\n- Run code, query databases\n- Look at your projects, business, calendar\n\nKeyboard shortcuts: ⌘/Ctrl+Enter sends, ↑ recalls last prompt, Esc cancels a streaming reply.",
      },
      {
        id: "sessions",
        title: "Sessions = parallel conversations",
        estMinutes: 2,
        body: "Each session has a distinct context. Use sessions when you want the agent to *not* mix two threads — e.g. one for `client-A research`, one for `code refactor`. Switch via the threads sidebar.\n\nA session remembers everything inside it (messages + tool outputs) and forgets everything outside.\n\n**Tip:** name sessions descriptively. The agent uses the name when picking which session to deliver an inbound message to.",
      },
      {
        id: "grid",
        title: "For power users: the multi-session grid",
        estMinutes: 2,
        cta: { label: "Open Grid", tab: "grid" },
        body: "Everyday chatting happens on the **Chat** page. When you want several conversations side by side, open **Grid** from the sidebar. You'll see 4–9 chat panels at once — each with its own session, model, and federation device.\n\nUse cases:\n- Run the same prompt across 3 different models and compare\n- One session writing code, another reviewing, another running tests\n- Talk to the same agent across multiple federated devices simultaneously\n\nEach grid panel has its own model dropdown, federation device picker, and skill picker.",
      },
      {
        id: "voice",
        title: "Voice mode",
        estMinutes: 2,
        body: "Voice tab. Press **Connect** — wake-word + push-to-talk both supported. The agent speaks back through the configured TTS (default: Onyx voice).\n\nIf no Claude terminal is selected when you connect, voice mode auto-spawns one so the conversation has somewhere to land.\n\nSettings → Appearance → Voice section lets you change voices, language, and speech speed.",
      },
      {
        id: "skills",
        title: "Skills + sub-agents",
        estMinutes: 2,
        body: "Skills are pre-packaged prompts/tools the agent can invoke mid-conversation. Open the agent-chat sidebar (right edge of any chat), click the lightning bolt → search.\n\nGood examples:\n- `/skill ultrareview` — multi-agent code review of your branch\n- `/skill watch` — analyze a video file\n\nSub-agents are isolated agent runs the main agent can spawn for parallel work. The agent decides when to use them; you'll see them in the agent-chat sidebar as separate threads.",
      },
      {
        id: "context",
        title: "How the agent uses your context",
        estMinutes: 2,
        body: "Every session prepends:\n\n1. The system prompt (sets the agent's behavior)\n2. **Your user-profile context** (Settings → Users → Background context)\n3. **Your active business** (if you have one set as active)\n4. The conversation so far\n\nThis is why the user-profile context field is high-leverage: anything you put there flavors *every* session. Update it whenever your focus changes — switching businesses, starting a new project.",
      },
    ],
  },

  {
    id: "projects",
    title: "Projects & Kanban",
    description:
      "Kanban-style projects, tasks, auto-run with the agent, business linking, and the Databases sub-view.",
    audience: "all",
    order: 20,
    category: "Projects",
    tier: "beginner",
    certRequired: true,
    steps: [
      {
        id: "create",
        title: "Create your first project",
        estMinutes: 2,
        cta: { label: "Open Projects", tab: "projects" },
        body: "Open the **Projects** tab and click **+ New Project**. Give it a name. The kanban opens with three default columns: To Do, In Progress, Done.\n\nProjects are the unit of organized work. Anything the agent does that takes more than one prompt — a refactor, a research run, a multi-step deliverable — should live in one.",
      },
      {
        id: "tasks",
        title: "Add tasks the agent can run",
        estMinutes: 2,
        body: "Click `+` on a column to add a task. A task is just a card with a title, description, and (optionally) a checklist.\n\nThe magic: drag a task to **In Progress** and click the ⚡ **Run** button. The agent reads the task, plans, and executes — running shell commands, editing files, searching the web — until the checklist is satisfied. You watch the live log; you can pause/cancel any time.\n\nIf the agent hits a destructive action (delete, force-push), it stops and asks your approval via Telegram (when configured).",
      },
      {
        id: "criticality",
        title: "Criticality + GitHub precheck",
        estMinutes: 2,
        body: "When you click Run, the agent classifies the task by criticality (low / medium / high / critical). Higher criticality triggers an approval gate before any code lands.\n\nIf the project is linked to a GitHub repo, a precheck runs first: pulls latest, ensures clean working tree, confirms the branch matches the project's expected branch. Failures block the run instead of merging into a dirty state.",
      },
      {
        id: "business",
        title: "Link a project to a business",
        estMinutes: 1,
        body: "Open the project's **Edit** dialog. The **Linked business** dropdown scopes the project to one of your businesses (Settings → Business). Once linked:\n\n- The project shows in the business's command center\n- The agent treats the business's context as primary when running tasks\n- Income tracking ties to that business\n\nUnlinking is reversible — click `(none)` to clear.",
      },
      {
        id: "databases",
        title: "Databases — the Notion-style sub-view",
        estMinutes: 3,
        body: "Inside Projects there's a **Databases** sub-view (top tabs). These are flexible tables: rows + custom properties (text, select, relation, etc.). Use cases:\n\n- A clients database with `name, status, mrr, owner`\n- A research database where each row is a paper + tags\n- An inventory tracker, content calendar, anything tabular\n\nThe agent can query and write to databases via tool calls — *\"Add a row to my clients DB for Acme Corp\"* just works. Each database can also sync two-way with Notion if you've connected it.",
      },
      {
        id: "review",
        title: "Reviewing what the agent did",
        estMinutes: 1,
        body: "Every run leaves a trail:\n\n- **Activity tab** — every tool call the agent made, in order\n- **Files tab** (in the project) — every file the agent created/changed, diffable\n- **Checkpoints** — the agent snapshots state before risky operations; you can roll back to any checkpoint\n\nIf something went sideways, restoring a checkpoint is a single click.",
      },
    ],
  },

  {
    id: "business",
    title: "Business Center",
    description:
      "Multiple businesses, revenue tracking with provider syncs, the clients CRM, and Notion sync.",
    audience: "all",
    order: 30,
    category: "Business",
    tier: "beginner",
    certRequired: true,
    steps: [
      {
        id: "first-business",
        title: "Create your first business",
        estMinutes: 1,
        cta: { label: "Open Business", tab: "business" },
        body: "Settings → Business → **+ New Business**. Fill in name, industry, plan, context (a paragraph the agent uses when picking up business-related tasks).\n\nYou can have many businesses. The active one is the lens the agent uses by default — switch via the dropdown at the top of the page.",
      },
      {
        id: "context",
        title: "Why the context field matters",
        estMinutes: 1,
        body: 'The business context is the agent\'s brief: who you serve, your pricing, your competitive position, the projects in flight. When you ask *"draft an email to a prospect"*, the agent reads this context to write in your voice and price your services correctly.\n\nKeep it under 500 words. Update it monthly as positioning shifts.',
      },
      {
        id: "income",
        title: "Connect Whop / Stripe / Square",
        estMinutes: 3,
        body: "Business → Income panel → ⚙ Configure. Paste your provider keys per business (each business has its own keys — you might have a personal Stripe and a client's Stripe). Click **Sync** for each.\n\nThe panel shows real revenue: today, week, month, year, all-time. The chart graphs monthly trend. Recent transactions render below. Manual entries (cash, transfers) go in via the **Log income** dialog.\n\nNothing is sent to the cloud — keys are stored in your local state directory.",
      },
      {
        id: "clients",
        title: "Clients CRM",
        estMinutes: 2,
        cta: { label: "Open Clients", tab: "clients" },
        body: 'Settings → Clients (or the Business → Clients sub-tab). Add clients with name, email, status (`prospect`, `active`, `lapsed`), MRR, owner, notes. Each client can have a Notion page synced for richer notes.\n\nWhen the agent answers *"what\'s our pipeline look like?"*, it walks the clients table grouped by status.',
      },
      {
        id: "notion-sync",
        title: "Two-way Notion sync",
        estMinutes: 2,
        body: "Each business and each clients database can sync with Notion. Configure in the **Notion** sub-tab of Business.\n\nFlow:\n1. Create or paste an integration token\n2. Pick a Notion database for clients (or let it create one)\n3. Sync — pulls existing rows, pushes local changes\n\nFrom that point, edits in either Notion or the dashboard reconcile both ways. Useful if your team lives in Notion but you want the agent to query a fast local copy.",
      },
      {
        id: "command-center",
        title: "The command center view",
        estMinutes: 2,
        body: "Business tab → top of the page. The command center shows:\n\n- Revenue tile (this month + delta vs. last)\n- Active clients count\n- Open projects scoped to this business\n- Recent activity feed (income, completed tasks, new clients, project updates)\n- Quick actions\n\nThe layout is glassmorphism over your global theme. Switch businesses with the dropdown — every tile re-scopes.",
      },
    ],
  },

  {
    id: "mobile",
    title: "Mobile (Android APK + builds)",
    description:
      "Install the Android APK straight from your gateway in a minute, or build a personal iPhone app with EAS.",
    audience: "all",
    order: 50,
    category: "Mobile",
    tier: "intermediate",
    certRequired: true,
    steps: [
      {
        id: "expo-intro",
        title: "Android APK — the fastest way on your phone",
        estMinutes: 1,
        cta: { label: "Open Mobile", tab: "mobile" },
        body: "Settings → Mobile. The **Android app (APK)** card at the top downloads the InfiniBot app straight from your gateway — scan its QR with your phone, allow *Install unknown apps* for your browser, install, then pick **Self-hosted gateway** (or **InfiniBot Cloud**) in the app.\n\n**Expo Go does not work** — the app uses native modules (LiveKit voice, WebRTC, the dev client). For development, the **Dev client (Metro)** tab serves JavaScript to an InfiniBot development build instead.",
      },
      {
        id: "modes",
        title: "Tunnel vs LAN vs Localhost",
        estMinutes: 2,
        body: "Three connection modes:\n\n- **Tunnel** — works anywhere (cellular, different Wi-Fi, behind NAT). Slower because traffic routes through Expo's servers. Recommended.\n- **LAN** — same Wi-Fi only. Fastest because direct.\n- **Localhost** — same machine only. Use for the iOS simulator or web preview.\n\nTunnel is the default. Switch only if you have a reason.",
      },
      {
        id: "url-token",
        title: "Pre-baked credentials",
        estMinutes: 1,
        body: "Before starting Metro, the dashboard writes your gateway URL + your password to `<expoProject>/.env.local`. The Expo app reads these at boot — you never type them on your phone.\n\nIf your phone is on cellular and the gateway is on your laptop, you'll need a public URL (Cloudflare Tunnel, Tailscale, ngrok). Paste it into the **Gateway URL** field on the page; click Save default so the next start uses it.",
      },
      {
        id: "scan",
        title: "Scan the QR",
        estMinutes: 1,
        body: "Open the **InfiniBot development build** on your phone and scan the Metro QR from its launcher (on iOS the Camera app works too). Expo Go from the stores will not load this app.\n\nThe dev build boots, loads the JavaScript from Metro, and connects to your gateway.",
      },
      {
        id: "limits",
        title: "Dev client vs a built app",
        estMinutes: 1,
        body: "The Metro dev client is for working on the app itself. For everyday use install a built app — the **Android APK** card, or an iPhone build from the **Build the app** tab — so push notifications, deep links from alerts and background audio all work without Metro running.",
      },
      {
        id: "ipa-prereqs",
        title: "IPA build — prerequisites",
        estMinutes: 3,
        body: "Building a personal IPA requires three things, each one-time:\n\n1. **Apple Developer account** — $99/year, signup at `developer.apple.com/programs`. Apple takes 24-48 hours to approve. There's no way around this if you want the app on your iPhone.\n2. **Expo account** (free) at `expo.dev`.\n3. **EAS CLI** installed: open a terminal, run `npm install -g eas-cli`, then `eas login`.\n\nAfter that, run `eas credentials` once — pick iOS, follow the prompts, EAS auto-fetches certificates and provisioning profiles using your Apple ID.",
      },
      {
        id: "build",
        title: "Kick the build",
        estMinutes: 2,
        body: "Settings → Mobile → **Build the app** tab. Click **Build iOS Preview**. The build queues on Expo's servers and finishes in ~15-25 minutes.\n\nWatch progress in the Recent Builds table — refresh button polls EAS for status. When it's done you get an email with a download QR; scan that on your iPhone, Safari handles the install.\n\nFirst time only: Settings → General → VPN & Device Management → tap your developer profile → Trust. Then the InfiniBot icon appears on your home screen.",
      },
    ],
  },

  {
    id: "multi-user-admin",
    title: "Multi-user admin",
    description:
      "Add users, gate page access, lock agents to a directory, set per-user language and context. Admin-only.",
    audience: "admin",
    order: 60,
    category: "Admin",
    tier: "advanced",
    certRequired: true,
    steps: [
      {
        id: "intro",
        title: "When to use multi-user",
        estMinutes: 1,
        body: "InfiniBot can run single-tenant (one operator, no friction) or multi-user (your team, your family, paying clients). The implicit-admin rule: until you create the first user, *every* connection has admin rights. As soon as you create user #1, only users with `role: admin` get the admin features.\n\n**Use multi-user when:** giving someone access without giving them everything, running a paid service on top of InfiniBot, separating personal vs work identities.",
      },
      {
        id: "create-user",
        title: "Create your first user",
        estMinutes: 2,
        cta: { label: "Open Users", tab: "users" },
        body: "Settings → Users → **+ New User**. The form asks for:\n\n- Username + optional email\n- **User password** (what they type at login)\n- **Gateway password** (what the WebSocket layer validates — separate so you can rotate independently)\n- Role: `user` or `admin`\n- Language preference (the agent will respond in this)\n- Background context (prepended to every session's system prompt for this user)\n- Optional home directory override\n- Optional agent gating + allowed dirs + allowed pages\n\nClick Create. The user's home directory auto-creates at `<state>/users/<username>/`.",
      },
      {
        id: "page-gating",
        title: "Gate which pages a user sees",
        estMinutes: 2,
        body: "Edit a user → **Allowed pages** field, comma-separated. Empty = no restriction (sees everything).\n\nExamples:\n- `chat,projects,docs` — a junior team member who only needs the basics\n- `business,clients,leads,funnels` — a sales role\n- (empty) — full access; pair with role=user when you trust them but don't need them administering other users\n\nUsers always see the `/users` page so they can edit their own profile, even when it's not in their allowedPages list.",
      },
      {
        id: "agent-gating",
        title: "Lock agents to a directory",
        estMinutes: 3,
        body: "Edit a user → toggle **Lock agent to home + allowed directories**. When on:\n\n- Every subagent's working directory pins to the user's home dir\n- Filesystem tools (read, write, exec) refuse paths outside `homeDir` ∪ `allowedDirs`\n- The agent can still see other tabs' data via gateway methods, but can't `ls` outside the sandbox\n\nUse this when: you give an outside contractor agent access, or you don't want a junior accidentally touching production paths.\n\nAdmins always bypass gating, even if their record sets it.",
      },
      {
        id: "language-context",
        title: "Per-user language + context",
        estMinutes: 2,
        body: "Edit a user → **Language** and **Background context**. The agent prepends a `[User profile]` block to every session's system prompt:\n\n```\nThe user's preferred language is \"Spanish — formal\". Respond in this language by default.\n\nUser-supplied background context (always relevant, never repeat back verbatim):\n<their context paragraph>\n```\n\nSelf-edit: non-admin users can change their own language + context + password from the same Users page (the form just hides admin-only fields).",
      },
      {
        id: "switching",
        title: "How users actually log in",
        estMinutes: 1,
        body: "Login screen → click **Sign in as a user account**. Type username + their user-password.\n\nUnder the hood: the dashboard POSTs `/api/users/login` (public, rate-limited 60/min/IP) and gets back the gateway password to use for the WebSocket. The user never types the gateway password.\n\nSwitching users: log out (clear the saved password) and log in with another. Each user gets their own home directory, their own context, their own page access.",
      },
      {
        id: "monitor",
        title: "Monitor what users are doing",
        estMinutes: 2,
        body: "Admin Users page shows everyone — pill badges flag `admin`, `gated`, etc. The sessions list (top toolbar) shows currently active sessions across all users; each session names the owning user.\n\nFor learning progress specifically, the Learn page (this page) has an **All Users** tab when you're admin — shows each user's progress through the bundled walkthroughs at a glance. Click a user to see which steps they've completed and where they're stuck.",
      },
    ],
  },

  // ── Intermediate ─────────────────────────────────────────

  {
    id: "skills-mcp",
    title: "Skills & MCP",
    description:
      "Install Claude Code skills, expose them to the agent, register MCP servers (Anthropic's Model Context Protocol) for richer tool surfaces.",
    audience: "all",
    order: 70,
    category: "Agent",
    tier: "intermediate",
    certRequired: true,
    steps: [
      {
        id: "what-skills",
        title: "What a skill is",
        estMinutes: 2,
        body: "A **skill** is a packaged prompt + (optional) helper script the agent can invoke mid-conversation. They live under `~/.claude/skills/` (or `~/.codex/skills/` for Codex). Examples: `ultrareview` (multi-agent code review), `watch` (video analysis), `apply-patch` (structured diff edits).\n\nSkills bundle:\n- A name + description\n- A system prompt fragment that gets injected when the skill is invoked\n- Optional shell helpers the agent can call\n- Allowlists of file paths / tools the skill is permitted to use",
      },
      {
        id: "browse",
        title: "Browse + install skills",
        estMinutes: 2,
        cta: { label: "Open Skills", tab: "skills" },
        body: "**Skills** tab. The library lists every installed skill plus the marketplace (Claude Code's `/plugin marketplace`). Click any to read its prompt + permissions, click Install to add it to your agent. Skills surface as `/skill <name>` slash commands inside chat.",
      },
      {
        id: "invoke",
        title: "Invoking a skill",
        estMinutes: 2,
        body: 'Three ways to use a skill:\n\n1. **Direct slash command** in chat: `/skill ultrareview` — opens a dialog where you fill its inputs.\n2. **Mention by name**: "use the watch skill on this video" — the agent picks it.\n3. **Auto-invoke**: when the agent thinks a skill matches, it asks before invoking.\n\nEvery skill invocation shows up in the activity log so you can audit what tools ran.',
      },
      {
        id: "mcp",
        title: "MCP — bigger tool surfaces",
        estMinutes: 3,
        cta: { label: "Open MCP", tab: "mcp" },
        body: "**Model Context Protocol** servers are external processes that expose typed tools to the agent. Examples: Linear MCP (read/write issues), Slack MCP (read/post messages), browser MCP, filesystem MCP for sandboxed paths.\n\nMCP tab → **Add server** → paste an MCP config (stdio command or HTTP URL). Once running, the agent sees its tools alongside built-ins. The agent can chain MCP tools and built-in tools in a single response.\n\nWhich MCP servers ship by default depends on your config — Linear, GitHub, and the InfiniBot internal MCP are common.",
      },
      {
        id: "internal-mcp",
        title: "Internal MCP — InfiniBot's own tools",
        estMinutes: 2,
        body: "InfiniBot exposes its own tools as an MCP server (`mcp.internal.*`). The agent uses this surface to read your projects, write to databases, query your business — without needing to pull data through the gateway protocol.\n\nThis is why the agent in Claude Coder TUI can answer questions about your business immediately: it's the same MCP your dashboard talks to.\n\nThe internal MCP config can be edited (admin) under Settings → MCP → Internal.",
      },
      {
        id: "build-skill",
        title: "Building your own skill",
        estMinutes: 4,
        body: 'A skill is a directory under `~/.claude/skills/<name>/` with:\n\n- `manifest.json` — name, description, prompt, permissions\n- Optional `scripts/*.py` or `*.sh` — helpers the agent can spawn\n- A README\n\nMinimal example:\n\n```json\n{\n  "name": "my-skill",\n  "description": "What it does",\n  "prompt": "You are now in <skill-name> mode. Goal: ...",\n  "allowedTools": ["Bash", "Read", "Write"]\n}\n```\n\nReload skills in the dashboard (Skills → Refresh). The agent picks them up immediately.',
      },
    ],
  },

  {
    id: "agents-custom",
    title: "Agents — personalities + custom tools",
    description:
      "How agents are configured, building per-agent system prompts, scoping tools, sub-agents, multi-agent orchestration.",
    audience: "all",
    order: 80,
    category: "Agent",
    tier: "intermediate",
    certRequired: true,
    steps: [
      {
        id: "agent-anatomy",
        title: "What an agent actually is",
        estMinutes: 2,
        body: "An **agent** in InfiniBot is a configuration bundle:\n\n- A **system prompt** (its identity + instructions)\n- A **model** (claude-opus-4, claude-sonnet-4-6, gemini, etc.)\n- A **toolset** (which built-in tools it can use)\n- A **workspace** (its default cwd)\n- An **identity** (name, description, voice, personality traits)\n\nEvery session uses one agent. The default is a generalist; you can swap to specialists per session — `coder-claude`, `coder-gemini`, `executive-assistant`, etc.",
      },
      {
        id: "list",
        title: "Browse your agents",
        estMinutes: 1,
        cta: { label: "Open Agents", tab: "agents" },
        body: "**Agents** tab → **Management** sub-view. Lists every configured agent. Click one to see its full config: model, prompt, tools, identity. The default agent is highlighted.",
      },
      {
        id: "create",
        title: "Build a new agent",
        estMinutes: 4,
        body: 'Agents → Management → **+ New agent**. The form:\n\n- **id**: kebab-case, used in session keys\n- **name**: human-readable\n- **default**: true means it\'s the default for new sessions\n- **model**: pick from your configured providers\n- **prompt**: the agent\'s identity. Be specific. "You are a brevity-first executive assistant. Default to terse answers..."\n- **tools**: leave empty for full access, or restrict (e.g. `["Read", "Bash"]`)\n- **workspace**: cwd default — useful for scoping a coder agent to one repo\n\nSave. The new agent appears in the model dropdown of every chat session.',
      },
      {
        id: "subagents",
        title: "Sub-agents — parallel work",
        estMinutes: 3,
        body: 'Sub-agents are isolated agent runs the main agent spawns for parallel tasks. Use cases:\n\n- *"Review the last 3 PRs in parallel"* → 3 sub-agents, one per PR\n- *"Search for X in 5 different sources"* → 5 sub-agents\n- *"Refactor module A while B is being tested"* → 2 sub-agents\n\nSub-agents inherit the parent\'s tools but have their own context window — they don\'t see the parent\'s history. The parent gets the sub-agent\'s final answer back as a tool result.',
      },
      {
        id: "mesh",
        title: "Agent mesh — multi-agent orchestration",
        estMinutes: 3,
        cta: { label: "Open Agent mesh", tab: "agents" },
        body: "InfiniBot can route a request through a chain of specialized agents. Example mesh:\n\n1. Triage agent — classifies the request\n2. Domain agent — actually does the work\n3. Reviewer agent — sanity-checks before returning\n\nConfigure in Agents → Mesh. Each step has its own agent + a routing rule. The mesh is opt-in per session — toggle it on the chat panel.\n\nGood for: multi-stage code review, content workflows where draft → edit → publish are different roles.",
      },
      {
        id: "delegation",
        title: "Budget-aware delegation",
        estMinutes: 2,
        body: 'Settings → Budget. The router scores each task by complexity + your budget remaining + which providers are within their free tier this hour. Force-local mode pushes everything to Ollama. Force-cloud mode picks the cheapest cloud option that can handle the complexity.\n\nThe budget router is what makes "the agent picks the right model" actually work — without it, every request would hit your most-expensive default.',
      },
    ],
  },

  {
    id: "voice-wakeword",
    title: "Voice & wake-word",
    description:
      "Voice mode setup, wake-word configuration, TTS providers, push-to-talk vs always-listening, federation across devices.",
    audience: "all",
    order: 90,
    category: "Chat",
    tier: "intermediate",
    certRequired: false,
    steps: [
      {
        id: "voice-mode",
        title: "Voice mode basics",
        estMinutes: 2,
        cta: { label: "Open Voice", tab: "voice" },
        body: "**Voice** tab → **Connect**. The agent listens, transcribes via Whisper (or Groq), generates a response, speaks back through TTS. Defaults: Onyx voice, English.\n\nFirst-time connect: if no Claude terminal is selected, voice mode auto-spawns one — your conversation lands in a real session you can scroll back through later.",
      },
      {
        id: "wake",
        title: "Wake-word listener",
        estMinutes: 3,
        body: 'Wake-word means "the gateway is *always* listening for a phrase" (default: `infinibot`). When triggered, it opens voice mode. Configure in Settings → Voicewake:\n\n- **Triggers**: an array of phrases. Add per-language variants.\n- **Backend**: `openwakeword` (local, free, works fine), `picovoice` (paid, more accurate), or `whisper-vad` (no wake word, just voice activity).\n- **Threshold**: 0.0–1.0, lower = more sensitive but more false positives.',
      },
      {
        id: "tts",
        title: "TTS providers",
        estMinutes: 2,
        body: "Settings → Appearance → Voice. Pick your TTS:\n\n- **Kokoro** (local) — free, fast, very good. Recommended default.\n- **Edge TTS** — Microsoft, free, no key needed.\n- **ElevenLabs** — best quality, paid. Voice cloning supported.\n- **OpenAI** — natural, paid.\n\nVoice + provider is per-language — the agent picks the right voice for the language it's responding in.",
      },
      {
        id: "push-vs-listen",
        title: "Push-to-talk vs always-listening",
        estMinutes: 2,
        body: "Voice mode has two modes:\n\n- **Push-to-talk** — hold a key (default: `Right Alt`) to speak. Releases when you let go. Best for noisy environments.\n- **Always-listening** — voice activity detection (VAD) finds your speech automatically. Best for hands-free use.\n\nToggle in the voice panel. Conversations transcribe to the active session in real time.",
      },
      {
        id: "federation-voice",
        title: "Voice across devices",
        estMinutes: 3,
        body: "When you've set up federation (next track), voice mode can route through any federated device. Use case: speak into your phone (satellite), agent runs on your beefy desktop (master), TTS plays back on your phone speakers.\n\nThe device picker in voice mode lists every federated node. Pick one — voice events route there transparently.",
      },
      {
        id: "barge-in",
        title: "Barge-in — interrupting the agent",
        estMinutes: 2,
        body: "Sometimes the agent says something wrong mid-sentence. Just start talking — the wake-word VAD detects you, cancels the current TTS, and queues your new input. The agent processes once you stop.\n\nThis only works in always-listening mode. Push-to-talk requires you to release first.",
      },
    ],
  },

  {
    id: "cron-autonomy",
    title: "Cron & autonomy",
    description:
      "Scheduled tasks, autonomous agent loops, idle-detection-driven work, approval gates via Telegram, audit trails.",
    audience: "all",
    order: 100,
    category: "Agent",
    tier: "advanced",
    certRequired: true,
    steps: [
      {
        id: "cron-basics",
        title: "Scheduling agent tasks with cron",
        estMinutes: 3,
        cta: { label: "Open Cron", tab: "cron" },
        body: "**Cron** tab → **+ Add job**. Schedule any agent prompt on a cron expression:\n\n- `0 8 * * *` — every morning at 8 AM\n- `*/15 * * * *` — every 15 minutes\n- `0 0 * * 1` — every Monday midnight\n\nFields:\n- Schedule (cron expression)\n- Prompt the agent runs\n- Session it lands in (or auto-create)\n- Notify on completion (Telegram/Slack/etc)\n\nThe agent runs autonomously — no human in the loop unless it hits an approval gate.",
      },
      {
        id: "examples",
        title: "Useful cron jobs",
        estMinutes: 2,
        body: 'Real workflows operators run:\n\n- **Daily inbox triage** — `0 7 * * *`: "Read my Gmail, group by urgency, draft replies for the urgent ones"\n- **Weekly status report** — `0 17 * * 5`: "Summarize this week\'s commits + closed issues + revenue. Send to my Telegram."\n- **Lead enrichment** — `0 */4 * * *`: "Pull new leads from CRM, enrich each with company data, score them"\n- **Backup checkpoint** — `0 */6 * * *`: "Create a checkpoint of every active project"\n\nThe agent picks tools as needed and reports back when done.',
      },
      {
        id: "autonomy",
        title: "Autonomy mode — pure background",
        estMinutes: 4,
        cta: { label: "Open Autonomy", tab: "autonomy" },
        body: "**Autonomy** tab. Different from cron — autonomy is *event-driven*. The agent watches:\n\n- Hardware idle detection (your machine is unused for N minutes)\n- The autonomy queue (tasks you've added)\n- Inbound messages on configured channels\n\nWhen hardware is idle + queue has work + you haven't paused: the agent picks the next task and runs it. Pause it explicitly with the big Pause button — no tasks fire while paused.",
      },
      {
        id: "queue",
        title: "The autonomy queue",
        estMinutes: 2,
        body: "Add tasks to the queue from anywhere — the chat agent can `autonomy:queue.add`, the dashboard has a queue view, or you can import from a kanban project.\n\nEach queued task has:\n- Title + description\n- Criticality (low/medium/high/critical)\n- Status (pending/approved/in-progress/complete/failed)\n- Estimated runtime\n\nHigh + critical tasks stop for approval before any code lands.",
      },
      {
        id: "approvals",
        title: "Approval gates via Telegram",
        estMinutes: 3,
        body: "When the agent's about to do something destructive (delete files, force-push, charge a credit card, send a public message), it pauses and pings your Telegram (or another channel).\n\nThe Telegram message has Approve / Reject buttons. Tap Approve, the agent continues. Reject, it stops and asks for clarification.\n\nWiring:\n1. Set up the Telegram channel (next walkthrough)\n2. Settings → Autonomy → set the Telegram chat ID\n3. The agent will start using it for high-criticality approvals automatically",
      },
      {
        id: "audit",
        title: "Audit trail — what the agent did overnight",
        estMinutes: 2,
        body: "Autonomy → **Audit** sub-view. Every task that ran shows:\n\n- When it started + finished\n- Every tool call it made\n- Every file it changed (diffable)\n- Every approval it requested + the response\n\nUse this every morning to verify the agent did what you wanted. If something's wrong, restoring a checkpoint rolls back any file changes the agent made.",
      },
    ],
  },

  {
    id: "federation",
    title: "Federation — multi-device InfiniBot",
    description:
      "Pair multiple machines into one agent fabric. Master/satellite topology, Tailscale meshing, cross-device PTY streaming, federated sessions.",
    audience: "all",
    order: 110,
    category: "Federation",
    tier: "advanced",
    certRequired: true,
    steps: [
      {
        id: "why",
        title: "What federation is for",
        estMinutes: 2,
        body: "Federation lets you run InfiniBot across multiple machines as if they were one. Use cases:\n\n- **Heavy work on the desktop, light interaction on the phone** — you ask a question on iOS, the desktop runs the actual model\n- **Always-on box** — a Mac mini stays online 24/7 running cron jobs; your laptop connects when needed\n- **Geographic redundancy** — gateway on home, gateway on cloud VPS, automatic failover\n- **Per-device tooling** — phone has voice + camera; laptop has the codebase; both available to the same agent\n\nTopology: one **master** + many **satellites**. The master holds canonical state; satellites mirror what they need.",
      },
      {
        id: "master",
        title: "Set up the master",
        estMinutes: 3,
        body: 'On your beefy machine (laptop/desktop/Mac mini), start the gateway in master mode:\n\n```\npnpm start gateway --master-mode --bind lan --tailscale on --auth password --password "yourpass"\n```\n\n- `--master-mode` — accepts incoming federation handshakes\n- `--bind lan` — listen on your LAN IP (not just localhost)\n- `--tailscale on` — also bind on the Tailscale interface (recommended for cross-network)\n- `--password` — same password every node uses to join\n\nThe gateway prints its URLs at startup. Note them down — you\'ll paste one into each satellite.',
      },
      {
        id: "tailscale",
        title: "Tailscale (optional but recommended)",
        estMinutes: 3,
        body: "**Tailscale** is a free VPN that meshes your devices. With it, every machine has a stable hostname (e.g. `mymac`, `phone`) reachable from any other regardless of network.\n\nWithout Tailscale, federation works on the same Wi-Fi (LAN mode) but breaks when devices roam.\n\nSetup:\n1. Install Tailscale on every device — `tailscale.com/download`\n2. Sign in with the same account on each\n3. Done — devices auto-mesh\n\nIn the gateway, `--tailscale on` makes it bind on the Tailscale interface so satellites reach it via `<masterhostname>:port`.",
      },
      {
        id: "satellite",
        title: "Pair a satellite",
        estMinutes: 4,
        cta: { label: "Open Federation", tab: "federation" },
        body: "On the second machine: **Settings → Federation → + Add node**. Paste the master's URL + the same password. Click Connect.\n\nMaster receives a pair-request notification. Open Federation tab on the master → the request appears → click Approve. The two now know each other.\n\nVerify: master's Federation tab now shows the satellite as connected. Satellite's tab shows the master.\n\nDo this once per device. The pairing is persistent — even after restarts.",
      },
      {
        id: "cross-device",
        title: "Cross-device sessions",
        estMinutes: 4,
        body: "Open the **Terminals** or **Grid** tab. The federation device picker (per panel) now lists every paired node.\n\nPick a satellite — the terminal/chat panel runs *on that machine* but renders here. Useful for:\n\n- Spawning a claude TUI on the desktop while you're on the laptop\n- Watching a build on the always-on box\n- Running expensive local models on the GPU machine\n\nEvery key you press, every output line, streams over the federation link in real time.",
      },
      {
        id: "shared-resources",
        title: "What gets shared",
        estMinutes: 3,
        body: "By default, satellites can:\n- Spawn terminal sessions on the master\n- Run agent invocations on the master's models\n- Read the master's projects, business, calendar (via gateway methods)\n\nWhat *doesn't* sync automatically: filesystem changes (each device's home dir is local), running processes, vault contents.\n\nIf you want a project to be available on every device, put it in a shared cloud-synced folder (Dropbox, iCloud) or use git.",
      },
      {
        id: "failover",
        title: "Failover + tunnels",
        estMinutes: 3,
        body: "When the master goes down, satellites can:\n\n- Promote one of themselves to master temporarily (manual)\n- Wait for the master to come back (default)\n\nFor remote access without VPN: enable **Cloudflare Tunnel** (Settings → Tunnel → Start). This gives you a public `*.trycloudflare.com` URL pointing at your gateway. Useful for accessing your own gateway from a friend's house, but be careful with your password if the URL leaks.\n\nProduction setup: master + 1 satellite + Tailscale + Cloudflare Tunnel = available from anywhere, redundant locally.",
      },
    ],
  },

  {
    id: "channels",
    title: "Channels — Telegram / Slack / Discord / iMessage",
    description:
      "Wire inbound message platforms so people can chat with your InfiniBot agent without opening the dashboard.",
    audience: "all",
    order: 120,
    category: "Channels",
    tier: "intermediate",
    certRequired: false,
    steps: [
      {
        id: "why",
        title: "Why hook up channels",
        estMinutes: 1,
        body: "Channels are inbound chat platforms. Once configured, anyone messaging your bot on Telegram (or Slack, Discord, etc.) reaches your InfiniBot agent. Use cases:\n\n- A 24/7 customer support bot in your business's Telegram channel\n- Personal assistant you DM from your phone without opening the dashboard\n- Team Slack bot that fields ops requests\n- Approval-gate destination for autonomous agent actions",
      },
      {
        id: "telegram",
        title: "Telegram bot",
        estMinutes: 4,
        cta: { label: "Open Channels", tab: "channels" },
        body: "Easiest channel to set up:\n\n1. On Telegram, message **@BotFather** → `/newbot` → follow prompts. Save the bot token.\n2. **Channels** tab → **Telegram** → paste token + click Start. The bot connects.\n3. DM your bot. The agent should respond within seconds.\n4. (Optional) Configure: which agent answers, default language, allowed user IDs (whitelist).",
      },
      {
        id: "slack",
        title: "Slack workspace",
        estMinutes: 5,
        body: "1. Go to `api.slack.com/apps` → Create new app\n2. Add scopes: `chat:write`, `app_mentions:read`, `im:history`, `im:read`\n3. Install to your workspace, copy the Bot token + Signing secret\n4. **Channels** tab → **Slack** → paste both, click Start\n5. In Slack, invite the bot to a channel: `/invite @yourbot`\n6. @-mention the bot — it responds.\n\nFor DMs: bot needs `im:history` + `im:read`. Re-install if you added scopes after.",
      },
      {
        id: "discord",
        title: "Discord bot",
        estMinutes: 5,
        body: "1. `discord.com/developers/applications` → New Application\n2. Bot tab → Add Bot → copy token, enable Message Content Intent\n3. OAuth2 → URL Generator → `bot` scope + send messages permission → use the URL to invite to your server\n4. **Channels** tab → **Discord** → paste token, click Start\n5. @-mention the bot in any channel — agent responds.",
      },
      {
        id: "imessage",
        title: "iMessage (Mac only)",
        estMinutes: 4,
        body: "Requires a Mac (or BlueBubbles bridge from another platform). Two paths:\n\n- **Native** (Mac with iMessage): InfiniBot reads from `~/Library/Messages/chat.db` and sends via AppleScript. **Channels → iMessage → Start**. macOS will prompt for Full Disk Access — grant it.\n- **BlueBubbles** (other platforms): install BlueBubbles server on a Mac, configure InfiniBot to talk to it over LAN.\n\niMessage is sensitive — make sure your bot has clear scope rules so it doesn't reply to your mom by accident.",
      },
      {
        id: "routing",
        title: "Per-channel agent + sessions",
        estMinutes: 3,
        body: "Each channel can:\n\n- Pick which agent answers (default vs. specialist)\n- Create one session per inbound conversation (so threading works)\n- Filter by sender ID/email/handle (whitelist)\n- Auto-translate responses to the sender's language\n\nConfigure in the channel's edit dialog. The agent treats each thread as a separate session — distinct memory, distinct context.",
      },
    ],
  },

  {
    id: "workflows",
    title: "Workflows — typed multi-step procedures",
    description:
      "Define repeatable agent procedures with typed inputs, preflight checks, and step-by-step execution. Like cron but for parameterized work.",
    audience: "all",
    order: 130,
    category: "Agent",
    tier: "intermediate",
    certRequired: false,
    steps: [
      {
        id: "concept",
        title: "Workflow vs cron vs prompt",
        estMinutes: 2,
        body: "Three ways to give the agent a job:\n\n- **One-shot prompt** — type in chat, agent does it once. Throwaway.\n- **Cron job** — same prompt on a schedule. Same args every time.\n- **Workflow** — parameterized procedure. Calls with different args each time, runs through a defined sequence of steps.\n\nUse workflows when: the *shape* of the job is repeatable but the *inputs* vary. Onboarding a new client, generating a weekly report on a different topic, processing batches with parameters.",
      },
      {
        id: "create",
        title: "Define your first workflow",
        estMinutes: 3,
        cta: { label: "Open Workflows", tab: "workflows" },
        body: '**Workflows** tab → **+ New workflow**. Fields:\n\n- **id**: kebab-case\n- **inputs**: typed schema (`{ topic: string, date: ISO, length: number }`)\n- **preflight**: optional checks that must pass before the workflow runs (e.g. "Notion is connected")\n- **steps**: array of agent prompts, each can reference inputs by `${input.topic}` etc.\n\nSave. The workflow is now callable.',
      },
      {
        id: "run",
        title: "Run a workflow",
        estMinutes: 2,
        body: 'Two ways:\n\n- **From dashboard**: Workflows → click the workflow → fill the form → Run. Live progress shows for each step.\n- **From agent prompt**: "run the weekly-report workflow with topic=AI agents" — the agent fills inputs from your phrasing.\n\nEach step runs sequentially; if step 3 fails, the workflow pauses for you to fix or retry.',
      },
      {
        id: "preflight",
        title: "Preflight checks",
        estMinutes: 3,
        body: 'Preflight is a list of conditions that must all pass before the workflow runs. Examples:\n\n- `gateway.connected`\n- `notion.connected` (a Notion integration is configured)\n- `business.active` (an active business is set)\n- `business.income.config.set` (Stripe key is set for active business)\n\nPreflight failures stop the workflow with a clear "go fix X first" message — no half-run state.',
      },
      {
        id: "examples",
        title: "Workflow examples",
        estMinutes: 2,
        body: "Concrete workflows operators run:\n\n- **Onboard new client** — input: name, email, company. Steps: create CRM record → draft welcome email → schedule kickoff → create kanban project → invite to Slack.\n- **Publish blog post** — input: topic, target_publish_date. Steps: research → outline → first draft → edit pass → image generation → schedule.\n- **Weekly executive brief** — input: week_of. Steps: pull metrics → pull commits → pull revenue → format → email.",
      },
    ],
  },

  {
    id: "notion-deep",
    title: "Notion sync — deep dive",
    description:
      "Connect Notion, sync databases two-way, the Notion DB Manager, agent-driven Notion edits.",
    audience: "all",
    order: 140,
    category: "Integrations",
    tier: "intermediate",
    certRequired: false,
    steps: [
      {
        id: "integration",
        title: "Create a Notion integration",
        estMinutes: 3,
        body: "1. Go to `notion.so/my-integrations` → New integration\n2. Name it (e.g. `infinibot`), pick your workspace\n3. Capabilities: read content, update content, insert content, no user info needed\n4. Submit → copy the integration token (`secret_...`)\n5. In Notion, share the pages/databases you want InfiniBot to access **with this integration** (Share button → search the integration name → invite)\n\nSharing is per-page — grant access only to what you want the bot touching.",
      },
      {
        id: "connect",
        title: "Connect to InfiniBot",
        estMinutes: 2,
        cta: { label: "Open Settings → Apikeys", tab: "apikeys" },
        body: "Settings → API Keys → **Notion** → paste the token. Save. The dashboard verifies the token by listing accessible pages.",
      },
      {
        id: "db-manager",
        title: "Notion DB Manager",
        estMinutes: 3,
        body: "**Notion** tab (or Projects → Databases → Notion sub-tab). Lists every Notion database you've granted access to.\n\nEach DB has:\n- Pull (download every row into the local cache)\n- Refresh (re-pull updated rows)\n- Discover (auto-detect schema)\n- Query (filter rows the agent can ask about)\n\nLocal queries are fast — the agent uses cached rows for answering questions, then re-pulls only when you ask for fresh data.",
      },
      {
        id: "two-way",
        title: "Two-way sync",
        estMinutes: 3,
        body: "For each database, enable **Two-way sync**: changes in either direction (Notion or local) reconcile.\n\nFlow:\n1. You add a row to a synced database in Notion\n2. Local copy updates within ~30 seconds\n3. The agent edits the local row\n4. The change pushes back to Notion within ~30 seconds\n\nConflicts resolve by last-write-wins. Notion is the source of truth for unsolved conflicts.",
      },
      {
        id: "agent-edits",
        title: "Agent-driven Notion edits",
        estMinutes: 3,
        body: 'Once a database is synced, the agent can manipulate it via natural language:\n\n- *"Add a row to my clients DB for Acme: status=active, MRR=$2k"*\n- *"Update every project tagged \'archive\' to status=done"*\n- *"What\'s the total MRR across active clients?"*\n\nThe agent uses the local cache for queries and the sync layer for writes. Notion sees the changes within a sync cycle.',
      },
    ],
  },

  {
    id: "vault",
    title: "Vault — community + courses + analytics",
    description:
      "Run a paid community/membership inside InfiniBot. Members, courses with modules and lessons, progress tracking, Discord roles, analytics.",
    audience: "all",
    order: 150,
    category: "Business",
    tier: "advanced",
    certRequired: false,
    steps: [
      {
        id: "concept",
        title: "What Vault is",
        estMinutes: 2,
        body: "Vault is InfiniBot's community-management surface. If you sell a membership product (paid Discord, course, mentorship program), Vault is the back-office that tracks:\n\n- Members + payment status\n- Courses they have access to\n- Their progress through each course\n- Discord role gating\n- Engagement analytics\n\nTypical use: a paid Skool/Whop/Circle alternative running locally with the agent helping you operate it.",
      },
      {
        id: "members",
        title: "Member management",
        estMinutes: 3,
        cta: { label: "Open Vault", tab: "users" },
        body: 'Vault → Members. Add members manually or import from CSV. Each member has:\n\n- Name + email + avatar\n- Membership tier (free / standard / premium)\n- Join date + last active\n- Discord ID (for role sync)\n- Linked Whop/Stripe payment status\n\nThe agent uses this — *"send a welcome email to every member who joined this week"* just works.',
      },
      {
        id: "courses",
        title: "Build a course",
        estMinutes: 4,
        body: "Vault → Courses → **+ New course**. A course has:\n\n- Title + description + cover image\n- Modules (sections of related lessons)\n- Lessons (single learning units, like our Learn walkthrough steps)\n- Required tier (which membership levels can access)\n\nLessons can be: video URL, markdown body, downloadable resources, quizzes. The format is flexible.",
      },
      {
        id: "progress",
        title: "Member progress tracking",
        estMinutes: 2,
        body: "Each member's view shows: which courses they're enrolled in, % completed, last lesson watched, time spent. The admin sees the same per-member.\n\nProgress drives unlocks: a member who finishes Module 1 can be auto-granted the Discord role for Module 2 access.",
      },
      {
        id: "discord-roles",
        title: "Discord role gating",
        estMinutes: 3,
        body: "Vault → Discord. Configure:\n\n- The Discord server + bot token (same Discord channel walkthrough)\n- Mapping: tier `premium` → Discord role `@premium`\n- Mapping: course completion → role unlock\n\nMember pays / completes / cancels → bot adds/removes their Discord role within seconds. No manual role management.",
      },
      {
        id: "analytics",
        title: "Vault analytics",
        estMinutes: 2,
        body: 'Vault → Analytics shows engagement at a glance: DAU/WAU, course completion rates, churn risk (members who\'ve gone inactive), retention curves.\n\nThe agent can run targeted plays: *"identify members at risk of churn this week and draft a re-engagement email for each"*.',
      },
    ],
  },

  {
    id: "funnels",
    title: "Funnels & Lead Qualifier",
    description:
      "Build a sales/marketing funnel inside InfiniBot. Stages, KPIs, lead scoring, AI-driven qualification.",
    audience: "all",
    order: 160,
    category: "Business",
    tier: "intermediate",
    certRequired: false,
    steps: [
      {
        id: "concept",
        title: "Why a funnel inside InfiniBot",
        estMinutes: 2,
        body: 'Most businesses run a funnel in HubSpot/Salesforce — separate from where the work happens. InfiniBot\'s funnel sits next to your projects, your business, your agent. The agent watches every stage transition and can act on it: *"a lead just moved to Demo, draft a personalized prep doc for me."*\n\nUse cases: SaaS sales, service-business pipelines, any process where leads progress through stages.',
      },
      {
        id: "create",
        title: "Build a funnel",
        estMinutes: 4,
        cta: { label: "Open Funnels", tab: "funnels" },
        body: '**Funnels** tab → **+ New funnel**. A funnel has:\n\n- Stages (e.g. `Cold`, `Engaged`, `Demo`, `Proposal`, `Closed`)\n- KPIs per stage (conversion %, time-in-stage, drop-off reasons)\n- Triggers — "when a lead enters X stage, do Y" (notify, draft email, score)\n- Offers — what\'s pitched at each stage\n\nDrag stages to reorder. Connect them to define valid transitions.',
      },
      {
        id: "leads",
        title: "Adding leads",
        estMinutes: 2,
        body: "Funnels → Leads. Add manually or import from CSV. Each lead has: name, email, company, source, stage, score, last activity, owner.\n\nLeads also flow in from:\n- Form submissions (the public form-bindings system)\n- Channel inbound messages tagged as leads\n- API calls from your website\n- Manual entry by sales reps",
      },
      {
        id: "qualifier",
        title: "AI Lead Qualifier",
        estMinutes: 3,
        cta: { label: "Open Qualifier", tab: "qualifier" },
        body: "**Qualifier** tab. Define qualification questions (`What's your company size?`, `What's your timeline?`). For each new lead, the agent:\n\n1. Drafts personalized questions\n2. Runs the conversation (manual or via channel)\n3. Scores the answers against your ICP (ideal customer profile)\n4. Recommends a stage to move them to\n\nYou approve or override. Over time the qualifier learns your team's scoring rubric.",
      },
      {
        id: "automation",
        title: "Stage automations",
        estMinutes: 3,
        body: "Per stage, define automations:\n\n- **On enter**: notify Slack, draft a follow-up email, create a kanban card\n- **On stale**: lead hasn't moved in 7 days → ping the owner\n- **On exit**: archive a CRM record, update Notion\n\nThe agent runs these automations directly — no Zapier needed.",
      },
      {
        id: "kpis",
        title: "Funnel analytics",
        estMinutes: 2,
        body: 'Funnels → Analytics. Per-stage conversion rates, time-in-stage histograms, drop-off attribution. Compare time-windows.\n\nThe agent reads this — *"why is the demo→proposal conversion dropping?"* gets a real answer based on your funnel state.',
      },
    ],
  },

  {
    id: "vision",
    title: "Vision — see what's on screen",
    description:
      "Camera capture, screen analysis, vision look (multimodal queries on images), device picker for federated cameras.",
    audience: "all",
    order: 170,
    category: "Tools",
    tier: "intermediate",
    certRequired: false,
    steps: [
      {
        id: "what",
        title: "What vision unlocks",
        estMinutes: 2,
        body: "Vision turns InfiniBot multimodal: the agent sees what you show it. Three modes:\n\n- **Camera capture** — your webcam or phone camera\n- **Screen capture** — your display or a specific window\n- **Image upload** — drop a file, agent describes/analyzes\n\nUse cases: 'help me debug this UI', 'transcribe this whiteboard photo', 'is there anything wrong with this code on screen?'",
      },
      {
        id: "capture",
        title: "Take a snapshot",
        estMinutes: 2,
        cta: { label: "Open Vision", tab: "agents" },
        body: "Vision tools live in the agent's toolbar. From any chat, click the camera icon. Pick:\n\n- **Camera** — list of webcams; pick one, frame, capture\n- **Screen** — list of displays; pick one, optionally select a window region\n- **Image** — file picker\n\nThe captured image attaches to your next message. The agent processes it as part of the prompt.",
      },
      {
        id: "analyze",
        title: "Vision queries",
        estMinutes: 2,
        body: 'After attaching an image, just ask. The agent uses vision-capable models (Claude Sonnet 4.6, GPT-4o, Gemini 2.0). Examples:\n\n- *"What\'s in this image?"*\n- *"Read every text on this whiteboard and structure it as Markdown"*\n- *"This is my dashboard — what\'s wrong?"*\n- *"Compare these two screenshots, what changed?"*\n\nThe agent describes, transcribes, compares, or extracts whatever you need.',
      },
      {
        id: "federated",
        title: "Federated cameras",
        estMinutes: 3,
        body: "If you've paired devices via federation, the camera/screen list includes every paired device's hardware. Use case: take a photo on your phone, ask the agent on your desktop.\n\nThe device picker is in the Vision capture dialog. Stream is fetched over the federation link, captured snapshots cache locally for the conversation.",
      },
      {
        id: "look",
        title: "Vision look — continuous",
        estMinutes: 2,
        body: "Beyond one-shot capture, **vision.look** opens a continuous stream the agent watches in 1–5 second intervals. Use case: 'tell me when the build finishes by watching my terminal' — the agent watches the screen and pings you when output changes.\n\nLook sessions stop after 30 minutes (configurable) or when you click stop. They're expensive — uses model tokens per frame.",
      },
    ],
  },

  {
    id: "storyboard-deep",
    title: "Storyboard & ComfyUI — deep dive",
    description:
      "AI-generated storyboards from a single prompt: script generation, scene splitting, ComfyUI image gen, voiceover, motion effects, full pipeline rendering.",
    audience: "all",
    order: 180,
    category: "Media",
    tier: "advanced",
    certRequired: false,
    steps: [
      {
        id: "concept",
        title: "What Storyboard Studio is",
        estMinutes: 2,
        body: "Storyboard Studio is end-to-end AI video creation: type a prompt → get a finished video. Pipeline:\n\n1. **Script** — LLM writes the script (Claude/Gemini/OpenRouter)\n2. **Scenes** — LLM splits script into shot list with descriptions\n3. **Images** — ComfyUI generates one image per shot\n4. **Voiceover** — TTS reads each scene's narration\n5. **Effects** — Remotion adds motion/overlay (Ken Burns, dramatic push, etc.)\n6. **Render** — ffmpeg assembles final MP4\n\nGood for short-form social content, faceless YouTube, marketing teasers.",
      },
      {
        id: "comfy",
        title: "ComfyUI prerequisite",
        estMinutes: 3,
        cta: { label: "Open Storyboard", tab: "storyboard" },
        body: 'Storyboard requires a running ComfyUI instance — local-only, no cloud. The Storyboard tab\'s Storyboard panel shows whether ComfyUI is reachable.\n\nDefault URL: `http://127.0.0.1:8000`. If yours runs elsewhere, set `COMFY_URL` (gateway) or `localStorage.comfyuiUrl` (browser).\n\nWalkthrough: Storyboard tab → If "ComfyUI not reachable" warning appears, follow the setup hint.',
      },
      {
        id: "create-project",
        title: "Create your first storyboard",
        estMinutes: 4,
        body: 'Storyboard tab → **+ New project**. Fill in:\n\n- Name (descriptive)\n- Prompt (the topic — "5-min explainer on transformer architecture")\n- Duration target (minutes)\n- Platform (YouTube/TikTok/Shorts/Reels) — drives aspect + pacing\n- Image style (cinematic/anime/illustrated/etc)\n- Image backend (Local ComfyUI is the only option)\n- Language\n\nClick Generate Script. The LLM writes the full script in your language.',
      },
      {
        id: "scenes",
        title: "Splitting into scenes",
        estMinutes: 3,
        body: "**Step 2 → Split into scenes**. The LLM reads the script and produces a shot list — each scene has:\n\n- A title\n- Voiceover text\n- An image prompt (very specific — character, setting, mood)\n- Duration\n- Effect preset (which Remotion motion to apply)\n\nReview before generating images — edits at this stage are cheaper than redoing images.",
      },
      {
        id: "images",
        title: "Generate images",
        estMinutes: 4,
        body: "**Step 3 → Generate images**. ComfyUI runs the prompts in batch. Each image takes ~30-60s on consumer GPUs.\n\nProgress shows per scene. Failed scenes (model couldn't load, prompt rejected) are retryable individually.\n\nAfter generation, hover any scene card to see the full prompt, regenerate with a different model, or edit the prompt and re-run.",
      },
      {
        id: "characters",
        title: "Character consistency",
        estMinutes: 3,
        body: "Characters tab → **+ New character**. Each character has:\n\n- Name + slug\n- Description (the character's physical/personality traits)\n- Reference image (one or more)\n- Style tokens (LoRA-like phrases)\n\nWhen you add a character to a storyboard project, every scene image generation uses their reference. Result: the same character across every shot, recognizable. Critical for narrative content.",
      },
      {
        id: "voiceover",
        title: "Voiceover generation",
        estMinutes: 3,
        body: "**Generate voiceovers** runs the TTS provider (Kokoro local / ElevenLabs / OpenAI / Edge) over each scene's voiceover text. One audio file per scene.\n\nCharacters can have voice IDs — different characters get different voices. With ElevenLabs voice cloning, you can use your own voice for one character and another for the rest.",
      },
      {
        id: "render",
        title: "Final render",
        estMinutes: 3,
        body: "**Export video**. Picks happen here:\n\n- Per-scene effect (Ken Burns, parallax, glitch, light leak, etc.) for motion\n- Aspect (matches your platform choice — 16:9, 9:16, 1:1)\n- Output format (MP4 H.264 default)\n\nffmpeg assembles each scene's image + voiceover + effect into a clip, then concatenates them all. Result lands in `<state>/storyboard-exports/<projectId>/`.",
      },
    ],
  },
];
