/**
 * Curated knowledge — ONLY what the code can't express: multi-step intent
 * ("how do I connect Gmail"), the meaning of a control, cloud/local
 * differences. Everything else is generated.
 *
 * Rot guards (curated.test.ts):
 *   - `at` must be the id of a GENERATED entry; breadcrumb, route and tab are
 *     copied from it at build time, so they can never drift from the UI.
 *   - `verify` probes assert the quoted UI labels still exist in the source.
 *   - `targets` must all be ids that exist in the knowledge base.
 */

import { controlTarget, flowTarget, pluginTarget } from "./targets.js";

export type CuratedEntry = {
  id: string;
  kind: "flow" | "control";
  title: string;
  summary: string;
  /** Generated entry whose breadcrumb/route/tab this entry inherits. */
  at: string;
  /** Appended to the inherited breadcrumb (controls: the control's label). */
  crumbTail?: string[];
  steps?: string[];
  keywords: string[];
  /** Extra target ids (must exist). The entry's own id is always first. */
  targets?: string[];
  related?: string[];
  pluginId?: string;
  requiresPlugin?: string;
  localOnly?: boolean;
  /** Source files that must contain each label (repo-relative). */
  verify?: Array<{ file: string; contains: string[] }>;
  facts?: Record<string, unknown>;
};

const SOLATRIX_ACCESS = pluginTarget("solatrix", "settings", "agent-access");
const SOLATRIX_UI = "extensions/solatrix/ui/agent-access.ts";

export const CURATED: CuratedEntry[] = [
  // ── Solatrix agent access (the failure that started this) ────────────────
  {
    id: controlTarget("solatrix", "agent-access", "mode"),
    kind: "control",
    title: "Solatrix › Agent access mode",
    summary:
      "What agents may do with Solana data and wallets: Off (agents can't see Solana data or wallets) · Read-only (market data, balances, positions, P&L — no trades) · Trade with approval (every agent buy/sell/transfer waits for the owner's OK on Telegram or the web) · Full access (autonomous within limits; typed confirmation, auto-expires). This is SEPARATE from enabling the plugin: an enabled Solatrix still starts with Agent access Off. The control is a row of four option cards (a radio group, not a dropdown); clicking one applies immediately — there is no Save button. Trade with approval and Full access stay disabled until the owner accepts the disclosure in \"Before agents can trade\" (just above the cards); Full access also asks to type ENABLE FULL ACCESS.",
    at: SOLATRIX_ACCESS,
    crumbTail: ["Agent access mode"],
    keywords: [
      "agent access",
      "read-only",
      "read only",
      "trade with approval",
      "full access",
      "solana agent access",
      "let agents read my wallet",
      "why can't you read my wallet",
      "solatrix access off",
    ],
    pluginId: "solatrix",
    requiresPlugin: "solatrix",
    verify: [
      {
        file: SOLATRIX_UI,
        contains: [
          "Agent access mode",
          "Read-only",
          "Trade with approval",
          "Off",
          'role="radiogroup"',
          "Before agents can trade",
        ],
      },
      {
        file: "extensions/solatrix/ui/dashboard/sections/settings.ts",
        contains: ["Agent Access", "sxAgentAccessHost"],
      },
    ],
    facts: {
      onPage:
        'On Solatrix › Settings scroll down past Configuration to the 🤖 Agent Access panel; the Agent access mode cards are below "Before agents can trade". Clicking a card applies it immediately.',
      modes: ["off", "read", "approval", "full"],
      rpc: "solatrix.agent.mode.set (owner session only)",
    },
  },
  {
    id: controlTarget("solatrix", "agent-access", "kill-switch"),
    kind: "control",
    title: "Solatrix › Kill switch (freeze agent trading)",
    summary:
      "Freezes every agent trade/transfer immediately. Agents or anomaly rules (rate limit, burst of denials, sudden large sell) can trigger it; only the owner can unfreeze, from the Agent access panel.",
    at: SOLATRIX_ACCESS,
    crumbTail: ["Freeze agent trading / Unfreeze"],
    keywords: ["freeze", "frozen", "unfreeze", "kill switch", "stop agent trading"],
    pluginId: "solatrix",
    requiresPlugin: "solatrix",
    verify: [{ file: SOLATRIX_UI, contains: ["Freeze agent trading", "Unfreeze"] }],
  },
  {
    id: controlTarget("solatrix", "agent-access", "limits"),
    kind: "control",
    title: "Solatrix › Agent limits",
    summary:
      "Per-trade max (SOL and USD), daily cap, max slippage and price impact, cooldown, trades per minute, token allow/deny lists, allowed agents and wallets. Above-limit trades always need approval; on InfiniBot Cloud platform ceilings clamp them.",
    at: SOLATRIX_ACCESS,
    crumbTail: ["Limits"],
    keywords: ["limits", "daily cap", "per trade", "slippage", "allowed agents", "token allowlist"],
    pluginId: "solatrix",
    requiresPlugin: "solatrix",
    verify: [{ file: SOLATRIX_UI, contains: ["Limits"] }],
  },
  {
    id: controlTarget("solatrix", "agent-access", "transfer-allowlist"),
    kind: "control",
    title: "Solatrix › Transfer allowlist",
    summary:
      "External addresses agents may send SOL to (after a 24h safety cooldown). Transfers out always need approval; on Cloud, withdrawals ONLY go to allowlisted addresses.",
    at: SOLATRIX_ACCESS,
    crumbTail: ["Transfer allowlist"],
    keywords: ["transfer allowlist", "withdraw", "allowlisted address", "send sol"],
    pluginId: "solatrix",
    requiresPlugin: "solatrix",
    verify: [{ file: SOLATRIX_UI, contains: ["Transfer allowlist"] }],
  },
  {
    id: controlTarget("solatrix", "agent-access", "rpc"),
    kind: "control",
    title: "Solatrix › Solana RPC",
    summary:
      "Your own Solana RPC URL (Helius/QuickNode/Triton). Without it Solatrix uses the public endpoint, which is rate limited and refuses heavy calls such as holder lists and bubble maps.",
    at: SOLATRIX_ACCESS,
    crumbTail: ["Solana RPC"],
    keywords: ["rpc", "solana rpc", "helius", "quicknode", "rate limited", "rpc url"],
    pluginId: "solatrix",
    requiresPlugin: "solatrix",
    verify: [{ file: SOLATRIX_UI, contains: ["Solana RPC"] }],
  },
  {
    id: flowTarget("solatrix-agent-access"),
    kind: "flow",
    title: "Let agents read (or trade) your Solana wallets — Solatrix agent access",
    summary:
      "Two separate switches: (1) the Solatrix PLUGIN must be enabled, (2) its Agent access mode must be above Off. Read-only is enough for prices, balances, positions and P&L. Trading also needs the Execute swaps / Transfer funds permissions and the risk disclosure.",
    at: SOLATRIX_ACCESS,
    steps: [
      "If Solatrix is not in the sidebar: Settings › Setup › Plugins › Solatrix → Enable (reloads the gateway).",
      "Open Solatrix › Settings (or Settings › Setup › Plugins › Solatrix › Settings) → Agent access & limits.",
      "Under Agent access mode pick Read-only (reads) or Trade with approval (trades wait for your OK on Telegram/web).",
      "For trades also switch on Execute swaps / Transfer funds in Setup › Plugins › Solatrix › Permissions and accept the trading disclosure.",
      "Add a wallet in Solatrix › Wallets if you have none.",
    ],
    keywords: [
      "enable solatrix",
      "solatrix read only",
      "solana wallet agent",
      "why can't you read my wallet",
      "let agent see my wallet",
      "agent access off",
      "solatrix disabled",
    ],
    targets: [
      controlTarget("solatrix", "agent-access", "mode"),
      pluginTarget("solatrix"),
      pluginTarget("solatrix", "permissions"),
    ],
    related: ["page:solatrix-wallets", "tool:solana_portfolio", "tool:solana_market"],
    pluginId: "solatrix",
  },

  // ── Models / API keys ────────────────────────────────────────────────────
  {
    id: flowTarget("add-api-key"),
    kind: "flow",
    title: "Add a model provider / API key",
    summary:
      "Chat and agents need at least one model provider: an API key (OpenAI, Anthropic, OpenRouter, Groq, …), a local model (Ollama) or a signed-in Claude/Codex CLI. Keys are stored per provider and tested on save.",
    at: "page:apikeys",
    steps: [
      "Open Settings › Keys & Usage (API keys tab).",
      "Click Add credential, pick the provider (or type a custom provider id), paste the key, Save credential.",
      "Use Test to check it; the Model provider setup glow clears once one works.",
      "Usage & plans (same page, second tab) shows spend and limits.",
    ],
    keywords: [
      "api key",
      "add key",
      "openai key",
      "anthropic key",
      "openrouter",
      "model provider",
      "where do i add an api key",
      "provider key",
      "llm key",
    ],
    targets: ["check:core.models"],
    related: ["page:credits"],
    verify: [
      { file: "ui/src/ui/views/api-keys.ts", contains: ["Add credential", "Save credential"] },
    ],
  },

  // ── Email / Gmail ─────────────────────────────────────────────────────────
  {
    id: flowTarget("connect-gmail"),
    kind: "flow",
    title: "Connect Gmail (or any email account) to the Inbox",
    summary:
      "Gmail is an account of the unified Inbox, not its own page. Connect it from the Inbox's account manager with Google OAuth; IMAP/SMTP, Mailgun, SendGrid and Resend are the other account kinds.",
    at: "page:inbox",
    steps: [
      "Open Chat & Voice › Inbox.",
      "Click Manage accounts (top right of the account bar) → Add account.",
      "Choose Gmail (OAuth-based Gmail account) → Open Google consent → approve in the new tab; the page waits for Google to redirect back.",
      "Test connection, then Set primary if you have several accounts.",
    ],
    keywords: [
      "gmail",
      "connect gmail",
      "email",
      "connect email",
      "inbox",
      "google mail",
      "imap",
      "smtp",
      "how do i connect gmail",
    ],
    targets: ["check:core.inbox"],
    related: ["tool:gmail"],
    verify: [
      { file: "ui/src/ui/views/inbox.ts", contains: ["Manage accounts"] },
      {
        file: "ui/src/ui/views/email-accounts.ts",
        contains: ["Add account", "OAuth-based Gmail account", "Open Google consent"],
      },
    ],
  },

  // ── Channels / Telegram ──────────────────────────────────────────────────
  {
    id: flowTarget("connect-telegram"),
    kind: "flow",
    title: "Connect Telegram (or another messaging channel)",
    summary:
      "Channels let you talk to your agents from Telegram, WhatsApp, Discord, Slack, Signal, iMessage and more. Telegram needs a bot token from @BotFather; your own chat id becomes the owner/approvals chat.",
    at: "page:channels",
    steps: [
      "Create a bot with @BotFather in Telegram and copy its token.",
      "Open Settings › Channels → Telegram card → paste the bot token and save.",
      "Message your bot once so it learns your chat id (it becomes the default/owner chat).",
      "The card shows Running / Configured / Last inbound when it works.",
    ],
    keywords: [
      "telegram",
      "connect telegram",
      "bot token",
      "botfather",
      "whatsapp",
      "discord",
      "slack",
      "channel",
      "messaging",
    ],
    targets: ["check:core.channels"],
    verify: [{ file: "ui/src/ui/views/channels.telegram.ts", contains: ["Configured", "Running"] }],
  },
  {
    id: flowTarget("telegram-approvals"),
    kind: "flow",
    title: "Turn on Telegram approvals",
    summary:
      "When an agent needs your OK (request_approval, exec in ask mode, Solatrix trades with approval, gated check-ins) InfiniBot sends a Telegram message with Approve / Deny buttons. It is ON automatically once a Telegram channel with an owner chat exists; the same requests appear in the web Approvals inbox (shield badge in the topbar).",
    at: "page:channels",
    steps: [
      "Connect Telegram first (Settings › Channels › Telegram) and message the bot once.",
      "Nothing else to switch on: approvals go to channels.telegram.defaultChatId (or allowFrom[0]).",
      "To change the chat, operators, sources or minimum risk, edit `approvals.telegram` in Settings › Setup › Config (enabled: false turns it off).",
      "Answer from Telegram, the topbar shield (web Approvals inbox), the CLI or /approve in chat — first answer wins.",
    ],
    keywords: [
      "approvals",
      "telegram approvals",
      "approve on telegram",
      "approval buttons",
      "turn on telegram approvals",
      "request approval",
      "shield",
    ],
    targets: ["page:config"],
    related: ["doc:docs/autonomy/telegram-approvals", "tool:request_approval"],
    facts: {
      configKey: "approvals.telegram",
      defaultEnabled: "when a Telegram owner chat is configured",
    },
  },

  // ── Coders ────────────────────────────────────────────────────────────────
  {
    id: flowTarget("install-coder"),
    kind: "flow",
    title:
      "Install and sign in a coding agent (Claude Code, Codex, OpenCode, Gemini CLI, Grok Build…)",
    summary:
      'Coding agents are CLIs InfiniBot runs as sub-agents (claude_coder, codex_coder, opencode_coder, grok_coder; claude_coder also takes backend gemini or grok). Install and sign in from Setup › Coders; ⌘K "install claude code" lands there too.',
    at: "section:setup/coders",
    steps: [
      "Open Settings › Setup › Coders.",
      "On the coder's card click Install (one click; a manual Install guide link appears if it can't auto-install).",
      "Click Sign in and finish in the browser (or paste a key with Save key).",
      "Test it, then Set default to make it the coder agents use.",
    ],
    keywords: [
      "install claude code",
      "claude code",
      "codex",
      "opencode",
      "gemini cli",
      "grok build",
      "grok cli",
      "coder",
      "coding agent",
      "sign in claude",
    ],
    targets: ["check:core.coders"],
    related: ["tool:claude_coder", "tool:codex_coder", "tool:opencode_coder", "tool:grok_coder"],
    localOnly: true,
    verify: [
      {
        file: "ui/src/ui/views/coders-settings.ts",
        contains: ["Install", "Sign in", "Set default"],
      },
    ],
  },

  // ── Plugins ──────────────────────────────────────────────────────────────
  {
    id: flowTarget("enable-plugin"),
    kind: "flow",
    title: "Enable (or disable) a plugin, or buy a paid one",
    summary:
      "Plugins add their own sidebar section, pages, tools and settings while enabled. Free plugins (Business & Agency, Canvas Library, Content Studio, Discipline, Whiteboard, Robovoice) are included. Paid plugins are a one-time purchase that unlocks on the Plugins page (Buy; Purchases restores them on another install); no plugin is limited to the desktop app. Turning one on/off reloads the gateway (connections reconnect, running sub-agents stop). Some plugins also have their own agent access or permissions that start Off even after enabling.",
    at: "page:plugins",
    steps: [
      'Open Home › Plugins (or ⌘K "plugins").',
      "Click the plugin's card. A paid plugin you don't own shows Buy instead of Enable; buying unlocks it here.",
      "Click Enable.",
      "Check its Permissions tab (gated permissions start off) and Settings tab (e.g. Solatrix › Agent access & limits).",
      "Its sidebar section appears once it has loaded.",
    ],
    keywords: [
      "enable plugin",
      "install plugin",
      "turn on plugin",
      "buy plugin",
      "paid plugin",
      "plugin price",
      "plugins",
      "marketplace",
      "disable plugin",
    ],
    related: [pluginTarget("solatrix")],
  },

  // ── Voice ────────────────────────────────────────────────────────────────
  {
    id: flowTarget("voice-setup"),
    kind: "flow",
    title: "Set up voice (talk to InfiniBot)",
    summary:
      'Local voice is the default (Whisper to listen, Kokoro or Piper to speak, on this machine, no API keys); on the desktop app "Set up voice for me" installs the built-in engine in one click with no Docker (the Docker GPU engine is under Advanced). Cloud voice (Robovoice) is an optional, free choice the user picks; usage is measured to keep it fair, and if it\'s busy one click switches back to local voice. Robovoice is never needed to talk to InfiniBot. Configure listen/talk providers and the voice brain in Setup › Voice, then talk on the Voice page or say the wake word.',
    at: "section:setup/voice",
    steps: [
      "Open Settings › Setup › Voice (Listen, talk & voice brain).",
      "Pick providers on the voice provider card and follow the voice setup wizard.",
      "Open Chat & Voice › Voice to talk; Voice › Commands lists voice commands.",
    ],
    keywords: ["voice", "voice setup", "microphone", "tts", "stt", "wake word", "talk", "speech"],
    targets: ["check:core.voice", "page:voice"],
    localOnly: true,
  },

  // ── Surfaces agents are asked about ──────────────────────────────────────
  {
    id: flowTarget("chat-panels"),
    kind: "flow",
    title: "Live chat panels (show_panel)",
    summary:
      'Agents can answer with a LIVE UI panel inside the chat or as a full-size modal: agent mesh, a project, a task, an agent run, the business snapshot, clients/opportunities, a generic table, plus plugin panels (e.g. Solatrix wallet/token). Ask "pull up project X".',
    at: "page:webchat",
    keywords: ["panel", "live panel", "show panel", "pull up", "chat panel"],
    related: ["tool:show_panel"],
  },
  {
    id: flowTarget("mesh-map"),
    kind: "flow",
    title: "Agent Mesh map",
    summary:
      "The isometric map of every agent and live coder sub-agent, with plugin rooms (Plugin District) for enabled plugins. Click an agent to inspect it.",
    at: "page:mesh",
    keywords: ["mesh", "agent map", "world map", "agent mesh", "plugin district"],
  },
  {
    id: flowTarget("knowledge-graph"),
    kind: "flow",
    title: "Knowledge graph",
    summary:
      "Projects, tasks, CRM objects and memory linked as a graph, under Agents › Memory › Knowledge graph.",
    at: "page:memory/graph",
    keywords: ["knowledge graph", "graph", "relations", "connections"],
  },
  {
    id: flowTarget("memory-agents"),
    kind: "flow",
    title: "What each agent knows (Memory › Agents)",
    summary:
      "Per-agent profile: memory, workspace files, tools and skills it can reach. Memory is the searchable store all agents share; Knowledge graph links it.",
    at: "page:memory",
    keywords: ["memory", "what does the agent know", "agent knowledge", "memory agents"],
  },
  {
    id: flowTarget("setup-glow"),
    kind: "flow",
    title: "Why a sidebar item is glowing (setup status)",
    summary:
      "A glowing sidebar entry (and a banner on its page) means a setup check isn't ready: model provider, email account, coding agent, voice, messaging channel, calendar, mobile app, or a plugin's own check (e.g. Solatrix RPC / wallet). The banner's button opens the fix.",
    at: "page:setup",
    keywords: [
      "glow",
      "glowing",
      "needs setup",
      "banner",
      "setup status",
      "yellow dot",
      "why is it glowing",
    ],
    targets: ["check:core.models"],
  },
  {
    id: flowTarget("get-started"),
    kind: "flow",
    title: "First-time setup (Get started onboarding)",
    summary:
      'Get started is the 8-step guided setup a new install opens with (on the desktop app, right after choosing the data folder): Your goals → AI brain ("Which of these do you already have?": an existing Claude/ChatGPT/Google/Grok plan via its CLI on the desktop app, a local model via Ollama/vLLM, or a provider key; Google Gemini and Groq have free tiers, OpenRouter is one key for hundreds of models) → Channels (just this app, Telegram, WhatsApp or Discord) → Voice → Phone (pair the mobile app) → Privacy (Secure Mode) → Your plan (recommended plugins and courses) → Finish. Steps can be skipped; Save and exit keeps progress. On the desktop app a personal learning path then walks the user through the app based on their goals.',
    at: "section:setup/wizard",
    steps: [
      "Open Settings › Setup › Get started.",
      "Work through the steps, or press Skip on any step and come back later.",
      "After Finish, send a first message in Chat & Voice › Chat and open Home › Learn for the interactive courses.",
    ],
    keywords: [
      "onboarding",
      "get started",
      "first time setup",
      "setup wizard",
      "how do i start",
      "new install",
      "rerun onboarding",
    ],
    verify: [
      {
        file: "ui/src/ui/views/onboarding-flow.ts",
        contains: [
          "Your goals",
          "AI brain",
          "Channels",
          "Voice",
          "Phone",
          "Privacy",
          "Your plan",
          "Finish",
          "Save and exit",
        ],
      },
    ],
  },
  {
    id: flowTarget("about-infinibot"),
    kind: "flow",
    title: "About InfiniBot: downloads, Mac, cost, API keys, license",
    summary:
      "Desktop app: Windows 10/11 x64 and Linux (AppImage, .deb) from infinibotos.com/download; installed apps update themselves. The Windows installer isn't code-signed yet, so SmartScreen may say \"Windows protected your PC\": click More info, then Run anyway (the SHA-256 checksum is on the download page). macOS app: coming soon; on a Mac use InfiniBot Cloud (cloud.infinibotos.com) or npm i -g infinibot (Node 22.12+). Cost: the desktop app and self-hosting are free; cloud plans run from Free ($0) to $199/mo; some plugins are a one-time purchase ($19 to $49); the AI provider bills separately, or a local model is $0. No API key is required: sign in with an existing Claude/ChatGPT/Google/Grok plan (desktop app), use a free local model (Ollama), or a provider free tier (Google Gemini, Groq). On the desktop app (and self-host), you can sign in with the Claude, ChatGPT, Google (Gemini) or Grok plan you already have: InfiniBot runs agents through that provider's official CLI (Claude Code, Codex CLI, Gemini CLI, Grok Build; also OpenCode), set up in onboarding or Settings › Setup › Coders › Use my subscription. Not on InfiniBot Cloud yet. License: source-available under FSL-1.1-ALv2 (each release becomes Apache-2.0 two years after it ships), © Kingly Intelligence Systems, LLC; self-hosting is free, including internal company use.",
    at: "page:setup",
    keywords: [
      "download",
      "mac",
      "macos",
      "windows",
      "linux",
      "smartscreen",
      "windows protected your pc",
      "price",
      "cost",
      "how much",
      "free",
      "license",
      "open source",
      "api key required",
      "subscription",
      "sign in with chatgpt",
    ],
    related: [flowTarget("cloud-vs-local"), flowTarget("get-started")],
  },
  {
    id: flowTarget("cloud-vs-local"),
    kind: "flow",
    title: "InfiniBot Cloud vs local install",
    summary:
      "Local (self-hosted: the desktop app or npm) InfiniBot runs the gateway on your machine for free: local models (Ollama/vLLM), coding CLIs (Claude Code/Codex), local voice, Secure Mode, local OCR, the local runtime manager, desktop control, mobile pairing, files and terminals; free plugins are included and paid plugins are a one-time purchase. InfiniBot Cloud is hosted per workspace on flat plans (Free $0 with 30 active min/day and no Telegram/Slack, Starter $19/mo, Pro $49/mo, Business $99/mo, Scale $199/mo): sign in with your account, bring your own API keys (BYOK); the cloud runs release 2026.10.16, so desktop 2026.10.18 features (built-in voice engine, learning path, using your subscription via a CLI, Repos & deploy, project knowledge graphs) are not on Cloud yet; Secure Mode is hidden because the cloud has no local models, machine-bound features (coder CLIs, local voice, terminals, desktop control, phone pairing) are absent or platform-managed, plugins follow tenant policy (the CEO plan unlocks paid plugins), and Solatrix keys are envelope-encrypted with Full access off and withdrawals allowlist-only.",
    at: "page:setup",
    keywords: [
      "cloud",
      "local",
      "difference between cloud and local",
      "hosted",
      "self hosted",
      "saas",
      "infinibot cloud",
      "byok",
    ],
    related: ["doc:docs/gateway/setup-status"],
  },
];
