/**
 * Hand-curated UI targets: the controls, sections and modals people actually
 * ask about ("where do I turn on Solatrix trading", "which button adds an API
 * key", "open the chat with an agent"). Selectors prefer explicit
 * `data-ib-target` attributes (added to the markup) with existing hooks as
 * fallbacks, so a target keeps working if one side lags.
 *
 * Entries with `extends: true` only enrich a derived target (navigation /
 * plugin manifest) — keywords/aliases are unioned, other fields override.
 *
 * Dependency-free data. Every `data-ib-target="…"` literal in ui/ and
 * extensions/*\/ui must be registered here or derived
 * (src/ui-targets/ui-targets.test.ts enforces it).
 */

import { pluginDetailRoute, pluginOpenReveal } from "./derive.js";
import type { UiTarget } from "./types.js";
import { targetAttrSelector as ib } from "./types.js";

type Curated = UiTarget | (Partial<UiTarget> & { id: string; extends: true });

const c = (t: Omit<UiTarget, "source">): UiTarget => ({ ...t, source: "curated" });
const ext = (t: Partial<UiTarget> & { id: string }): Curated => ({ ...t, extends: true });

// ── Setup page sections (`infinibot:setup-section`) ─────────────────────────

const SETUP_SECTIONS: Array<{
  id: string;
  title: string;
  description: string;
  keywords: string[];
  cloud?: false;
}> = [
  {
    id: "quickstart",
    title: "Quick Start",
    description: "Install InfiniBot and connect your first model, channel and apps.",
    keywords: ["getting started", "first run", "onboarding", "install and connect"],
  },
  {
    id: "overview",
    title: "Overview",
    description: "Status summary of everything that is (and isn't) set up.",
    keywords: ["status summary", "setup status"],
  },
  {
    id: "mcp",
    title: "MCP Integration",
    description: "Connect Claude Desktop / Claude Code and other MCP clients to InfiniBot's tools.",
    keywords: ["mcp", "claude desktop", "model context protocol", "connect claude code"],
  },
  {
    id: "docker",
    title: "Docker",
    description: "Run InfiniBot in containers.",
    keywords: ["container", "docker compose"],
    cloud: false,
  },
  {
    id: "wizard",
    title: "Setup Wizard",
    description: "Guided configuration of models, channels and agents.",
    keywords: ["wizard", "guided setup"],
  },
  {
    id: "wizard-advanced",
    title: "Advanced wizard",
    description: "The advanced setup wizard: federation, coding agents and Notion.",
    keywords: ["advanced wizard", "advanced setup", "federation", "notion setup"],
  },
  {
    id: "install",
    title: "Install & Connect",
    description: "Desktop/mobile apps and device pairing (QR).",
    keywords: ["pair device", "mobile app", "desktop app", "qr code", "download"],
  },
  {
    id: "network",
    title: "Network",
    description: "Multi-instance federation: connect other InfiniBot gateways.",
    keywords: ["federation", "instances", "satellite", "multi instance"],
    cloud: false,
  },
  {
    id: "instance",
    title: "Instance",
    description: "This instance's name, role and providers.",
    keywords: ["instance name", "rename instance"],
  },
  {
    id: "coder-backend",
    title: "Coding Backend",
    description: "Pick which coding agent sub-agents use: Claude Code or OpenCode.",
    keywords: ["coding backend", "claude code or opencode", "default coder"],
    cloud: false,
  },
  {
    id: "voice",
    title: "Voice",
    description: "Listen/talk setup and the voice brain (cloud by default, local optional).",
    keywords: ["voice setup", "microphone", "speech", "tts", "stt", "wake word"],
  },
];

const setupSectionTargets: Curated[] = [
  ...SETUP_SECTIONS.map((s) =>
    c({
      id: `section:setup/${s.id}`,
      kind: "section",
      title: `Setup › ${s.title}`,
      description: s.description,
      keywords: [s.title, ...s.keywords, "setup"],
      route: "/setup",
      reveal: [{ kind: "event", name: "infinibot:setup-section", detail: { section: s.id } }],
      selectors: [ib(`section:setup/${s.id}`)],
      parent: "page:setup",
      tab: "setup",
      ...(s.cloud === false ? { availability: { cloud: false } } : {}),
    }),
  ),
  ext({
    id: "page:setup/coders",
    description:
      "Install and sign in to CLI coding agents (Claude Code, Codex, OpenCode, Gemini CLI…) that sub-agents run.",
    keywords: ["coders", "coding agents", "install claude code", "sign in codex", "cli agents"],
    aliases: ["section:setup/coders"],
    selectors: [ib("section:setup/coders")],
    availability: { cloud: false },
  }),
  ext({
    id: "page:setup/components",
    description: "Optional voice / local LLM / video packs for the desktop app.",
    keywords: ["components", "optional packs", "voice pack", "local llm pack"],
    aliases: ["section:setup/components"],
    selectors: [ib("section:setup/components")],
    availability: { cloud: false },
  }),
];

// ── Coders (Setup › Coders) ─────────────────────────────────────────────────

/** Mirrors src/agents/coder-install/catalog.ts CODER_CATALOG (test-enforced). */
export const CURATED_CODERS: ReadonlyArray<{ id: string; name: string }> = [
  { id: "claude-code", name: "Claude Code" },
  { id: "codex", name: "Codex CLI" },
  { id: "opencode", name: "OpenCode" },
  { id: "gemini", name: "Gemini CLI" },
  { id: "grok-build", name: "Grok Build" },
  { id: "qwen-code", name: "Qwen Code" },
  { id: "amp", name: "Amp" },
  { id: "crush", name: "Crush" },
  { id: "aider", name: "Aider" },
  { id: "goose", name: "Goose" },
  { id: "cursor-cli", name: "Cursor CLI" },
];

const coderTargets: Curated[] = CURATED_CODERS.map((k) =>
  c({
    id: `control:coders/${k.id}`,
    kind: "control",
    title: `Setup › Coders › ${k.name}`,
    description: `${k.name}'s card: install, update, sign in, set as default, test.`,
    keywords: [
      k.name,
      k.id.replace(/-/g, " "),
      `install ${k.name}`,
      `sign in ${k.name}`,
      "coder",
      "coding agent",
    ],
    route: `/setup?view=coders&coder=${k.id}`,
    selectors: [`article.card[data-coder="${k.id}"]`],
    parent: "page:setup/coders",
    tab: "setup",
    availability: { cloud: false },
  }),
);

// ── API keys ────────────────────────────────────────────────────────────────

const apiKeyDialogReveal = [
  {
    kind: "click" as const,
    selectors: [ib("control:apikeys/add"), '[data-learn-id="apikeys-add"]'],
    unless: [ib("modal:apikeys/add"), ".dialog-overlay .dialog"],
    label: "Open the Add key dialog",
  },
];

const apiKeyTargets: Curated[] = [
  ext({
    id: "page:apikeys",
    description:
      "Add, test and remove API keys for model providers (OpenAI, Anthropic, OpenRouter, Groq…) and services.",
    keywords: [
      "api keys",
      "api key",
      "add api key",
      "model provider",
      "openai key",
      "anthropic key",
      "openrouter key",
      "provider keys",
      "credentials",
      "secrets",
    ],
  }),
  c({
    id: "control:apikeys/add",
    kind: "control",
    title: "API keys › + Add Key",
    description: "Opens the dialog to add a provider API key.",
    keywords: ["add key", "new key", "add api key", "plus", "add provider"],
    route: "/apikeys",
    selectors: [ib("control:apikeys/add"), '[data-learn-id="apikeys-add"]'],
    parent: "page:apikeys",
    tab: "apikeys",
  }),
  c({
    id: "control:apikeys/search",
    kind: "control",
    title: "API keys › Search providers",
    description: "Filter configured providers by name.",
    keywords: ["search keys", "filter providers"],
    route: "/apikeys",
    selectors: ['[data-learn-id="apikeys-search"]'],
    parent: "page:apikeys",
    tab: "apikeys",
  }),
  c({
    id: "control:apikeys/quick-add",
    kind: "control",
    title: "API keys › Quick add missing providers",
    description: "Tiles for providers without a key yet — one click presets the provider.",
    keywords: ["quick add", "missing providers"],
    route: "/apikeys",
    selectors: [ib("control:apikeys/quick-add"), "button.quick-add-btn"],
    parent: "page:apikeys",
    tab: "apikeys",
  }),
  c({
    id: "modal:apikeys/add",
    kind: "modal",
    title: "API keys › Add key dialog",
    description: "Choose a provider, paste the key, save.",
    keywords: ["add key dialog", "key dialog"],
    route: "/apikeys",
    reveal: apiKeyDialogReveal,
    selectors: [ib("modal:apikeys/add"), ".dialog-overlay .dialog"],
    parent: "page:apikeys",
    tab: "apikeys",
  }),
  c({
    id: "control:apikeys/dialog/provider",
    kind: "control",
    title: "Add key dialog › Provider picker",
    description: "Pick which provider the key is for.",
    keywords: ["choose provider", "select provider", "provider list"],
    route: "/apikeys",
    reveal: apiKeyDialogReveal,
    selectors: [ib("control:apikeys/dialog/provider"), ".dialog .provider-select-btn"],
    parent: "modal:apikeys/add",
    tab: "apikeys",
  }),
  c({
    id: "control:apikeys/dialog/key",
    kind: "control",
    title: "Add key dialog › API key field",
    description: "Paste the provider's secret key here (sk-…). It is stored encrypted.",
    keywords: ["paste key", "key field", "secret", "sk"],
    route: "/apikeys",
    reveal: apiKeyDialogReveal,
    selectors: [ib("control:apikeys/dialog/key"), '.dialog input[placeholder="sk-..."]'],
    parent: "modal:apikeys/add",
    tab: "apikeys",
  }),
  c({
    id: "control:apikeys/dialog/save",
    kind: "control",
    title: "Add key dialog › Save Key",
    description: "Saves the key; models from that provider become available right away.",
    keywords: ["save key", "save"],
    route: "/apikeys",
    reveal: apiKeyDialogReveal,
    selectors: [ib("control:apikeys/dialog/save"), ".dialog .btn.primary"],
    parent: "modal:apikeys/add",
    tab: "apikeys",
  }),
];

// ── Channels ────────────────────────────────────────────────────────────────

const CHANNELS: Array<{ id: string; name: string; kw: string[] }> = [
  { id: "telegram", name: "Telegram", kw: ["telegram bot", "bot token"] },
  { id: "whatsapp", name: "WhatsApp", kw: ["whatsapp qr", "link whatsapp", "pairing code"] },
  { id: "discord", name: "Discord", kw: ["discord bot"] },
  { id: "slack", name: "Slack", kw: ["slack app"] },
  { id: "signal", name: "Signal", kw: [] },
  { id: "imessage", name: "iMessage", kw: ["apple messages"] },
  { id: "googlechat", name: "Google Chat", kw: [] },
  { id: "nostr", name: "Nostr", kw: [] },
];

const channelTargets: Curated[] = [
  ...CHANNELS.map((ch) =>
    c({
      id: `control:channels/${ch.id}`,
      kind: "control",
      title: `Channels › ${ch.name}`,
      description: `The ${ch.name} channel card: connect, configure, probe.`,
      keywords: [ch.name, `connect ${ch.name}`, `set up ${ch.name}`, ...ch.kw, "channel"],
      route: "/channels",
      selectors: [`.channel-card[data-channel-id="${ch.id}"]`],
      parent: "page:channels",
      tab: "channels",
    }),
  ),
  c({
    id: "control:channels/whatsapp/connect",
    kind: "control",
    title: "Channels › WhatsApp › Connect (Show QR)",
    description: "Shows the QR code to link WhatsApp (or use a pairing code).",
    keywords: ["whatsapp qr", "show qr", "link whatsapp", "scan qr"],
    route: "/channels",
    selectors: ['[data-learn-id="channels-whatsapp-actions"]'],
    parent: "control:channels/whatsapp",
    tab: "channels",
  }),
];

// ── Topbar surfaces: chat sidebar, approvals, chart, learn, live ───────────────

const chatOpen = [{ kind: "open" as const, surface: "agent-chat" as const }];
const chartOpen = [
  {
    kind: "click" as const,
    selectors: ['[data-cb] [data-cb-item="chart"] button', '[data-cb] [data-cb-item="chart"]'],
    unless: [ib("modal:chart"), '.sol-chart[role="dialog"]'],
    label: "Open the chart panel",
  },
];

const topbarTargets: Curated[] = [
  ext({ id: "control:topbar/chat", keywords: ["chat button", "quick chat"], parent: "modal:chat" }),
  c({
    id: "modal:chat",
    kind: "modal",
    title: "Chat with an agent (sidebar)",
    description:
      "Right-hand chat sidebar with any agent — switch agents at the top, type below; drag its left edge to resize, collapse it to the edge. Shortcut ⌘/Ctrl+Shift+M.",
    keywords: [
      "chat with an agent",
      "agent chat",
      "quick chat",
      "chat modal",
      "chat sidebar",
      "chat panel",
      "talk to an agent",
      "message an agent",
      "chat window",
    ],
    reveal: chatOpen,
    selectors: ['[data-learn-id="quick-chat"]'],
  }),
  c({
    id: "control:chat/agent-switcher",
    kind: "control",
    title: "Chat sidebar › Agent switcher",
    description: "Pick which agent you're talking to.",
    keywords: ["switch agent", "choose agent", "agent picker", "which agent"],
    reveal: chatOpen,
    selectors: ['[data-learn-id="quick-chat-switcher"]'],
    parent: "modal:chat",
  }),
  c({
    id: "control:chat/model-picker",
    kind: "control",
    title: "Chat sidebar › Model picker",
    description: "Choose which model answers in this chat session.",
    keywords: ["switch model", "choose model", "model picker", "which model"],
    reveal: chatOpen,
    selectors: [
      '[data-ib-target="control:chat/model-picker"]',
      '[data-learn-id="quick-chat-model-picker"]',
    ],
    parent: "modal:chat",
  }),
  c({
    id: "control:chat/sessions",
    kind: "control",
    title: "Chat sidebar › Chats",
    description: "Switch, search or rename this agent's chat sessions.",
    keywords: ["chat sessions", "switch chat", "chat history", "previous chats"],
    reveal: chatOpen,
    selectors: [
      '[data-ib-target="control:chat/sessions"]',
      '[data-learn-id="quick-chat-sessions"]',
    ],
    parent: "modal:chat",
  }),
  c({
    id: "control:chat/new-session",
    kind: "control",
    title: "Chat sidebar › New chat",
    description: "Start a fresh chat session with this agent.",
    keywords: ["new chat", "fresh chat", "start over", "new session"],
    reveal: chatOpen,
    selectors: ['[data-ib-target="control:chat/new-session"]', '[data-learn-id="quick-chat-new"]'],
    parent: "modal:chat",
  }),
  c({
    id: "control:chat/open-full",
    kind: "control",
    title: "Chat sidebar › Open in full Chat",
    description: "Open this chat in the full Chat page.",
    keywords: ["open full chat", "expand chat", "full chat page"],
    reveal: chatOpen,
    selectors: [
      '[data-ib-target="control:chat/open-full"]',
      '[data-learn-id="quick-chat-open-full"]',
    ],
    parent: "modal:chat",
  }),
  c({
    id: "control:chat/load-older",
    kind: "control",
    title: "Chat sidebar › Load earlier messages",
    description: "Scroll back to earlier messages in this chat.",
    keywords: ["load older", "earlier messages", "scroll back", "chat history"],
    reveal: chatOpen,
    selectors: ['[data-ib-target="control:chat/load-older"]'],
    parent: "modal:chat",
  }),
  c({
    id: "control:chat/input",
    kind: "control",
    title: "Chat sidebar › Message box",
    description: "Type your message to the agent here.",
    keywords: ["message box", "composer", "type message", "chat input"],
    reveal: chatOpen,
    selectors: ['[data-learn-id="quick-chat-input"]'],
    parent: "modal:chat",
  }),
  c({
    id: "control:chat/send",
    kind: "control",
    title: "Chat sidebar › Send",
    keywords: ["send message", "send button"],
    reveal: chatOpen,
    selectors: ["agent-chat-modal button.send", 'button.send[aria-label="Send"]'],
    parent: "modal:chat",
  }),
  c({
    id: "control:chat/close",
    kind: "control",
    title: "Chat sidebar › Close",
    reveal: chatOpen,
    selectors: ['[data-learn-id="quick-chat-close"]'],
    parent: "modal:chat",
  }),
  c({
    id: "control:chat/read-aloud",
    kind: "control",
    title: "Chat sidebar › Read aloud",
    description:
      "Read agent replies aloud with your Robovoice voice (needs the Robovoice plugin linked; billed per reply).",
    keywords: ["read aloud", "text to speech", "tts", "speak replies", "voice replies"],
    reveal: chatOpen,
    selectors: ['[data-ib-target="control:chat/read-aloud"]'],
    parent: "modal:chat",
  }),
  c({
    id: "control:chat/talk",
    kind: "control",
    title: "Chat sidebar › Talk",
    description:
      "Dictate a message with Robovoice speech-to-text — click to start/stop, or hold to talk (billed per second).",
    keywords: ["talk", "dictate", "microphone", "speech to text", "stt", "voice input"],
    reveal: chatOpen,
    selectors: ['[data-ib-target="control:chat/talk"]'],
    parent: "modal:chat",
  }),
  ext({
    id: "control:topbar/approvals",
    selectors: ['[data-learn-id="approvals-inbox"]', '[data-cb] [data-cb-item="approvals"]'],
    availability: { note: "Only rendered while agent requests are pending approval." },
  }),
  c({
    id: "modal:approvals",
    kind: "modal",
    title: "Approvals inbox",
    description: "Pending agent requests (commands, trades, messages) — approve, deny or redirect.",
    keywords: ["approvals", "pending approvals", "approve", "deny", "approval inbox", "requests"],
    reveal: [{ kind: "open", surface: "approvals" }],
    selectors: ['[data-learn-id="approvals-panel"]'],
  }),
  ext({ id: "control:topbar/chart", keywords: ["solana chart", "chart button"] }),
  c({
    id: "modal:chart",
    kind: "modal",
    title: "Chart panel",
    description: "Live Solana token chart with a watchlist — data from Solatrix or DexScreener.",
    keywords: ["chart", "chart panel", "price chart", "candles", "token chart", "solana chart"],
    reveal: chartOpen,
    selectors: [ib("modal:chart"), '.sol-chart[role="dialog"]'],
  }),
  c({
    id: "control:chart/source",
    kind: "control",
    title: "Chart panel › Data source switch",
    description: "Switch the chart's data source between Solatrix (plugin) and DexScreener.",
    keywords: [
      "chart source",
      "data source",
      "source switch",
      "solatrix or dexscreener",
      "dexscreener",
      "switch source",
    ],
    reveal: chartOpen,
    selectors: [ib("control:chart/source"), '.sol-source[aria-label="Chart source"]'],
    parent: "modal:chart",
  }),
  c({
    id: "control:chart/token",
    kind: "control",
    title: "Chart panel › Token picker",
    keywords: ["pick token", "token selector", "watchlist token"],
    reveal: chartOpen,
    selectors: ['.sol-chart select.sol-select[aria-label="Token"]'],
    parent: "modal:chart",
  }),
  c({
    id: "modal:learn",
    kind: "modal",
    title: "Learn — guided walkthroughs",
    description: "Courses and interactive tours for every page and plugin.",
    keywords: ["learn", "tutorial", "walkthrough", "tour", "course"],
    reveal: [{ kind: "open", surface: "learn" }],
    selectors: [".learn-hub, learn-missions-panel", '[data-learn-id="learn-topbar"]'],
  }),
  ext({
    id: "control:topbar/learn",
    selectors: ['[data-learn-id="learn-topbar"]', '[data-cb] [data-cb-item="learn"]'],
  }),
  ext({
    id: "control:topbar/live",
    keywords: ["live action", "voice mode", "let the agent drive"],
  }),
];

// ── Launchpad + sidebar search ──────────────────────────────────────────────

const launchpadTargets: Curated[] = [
  c({
    id: "modal:launchpad",
    kind: "modal",
    title: "Launchpad (all pages)",
    description: "Every page as a grid of cards with search. Shortcut ⌘/Ctrl+P.",
    keywords: ["launchpad", "all pages", "page switcher", "app grid", "every page"],
    reveal: [{ kind: "open", surface: "launchpad" }],
    selectors: ['.lp-panel[role="dialog"]'],
  }),
  c({
    id: "control:launchpad/search",
    kind: "control",
    title: "Launchpad › Search",
    keywords: ["search pages", "find a page"],
    reveal: [{ kind: "open", surface: "launchpad" }],
    selectors: ["[data-launchpad-input]"],
    parent: "modal:launchpad",
  }),
  c({
    id: "control:sidebar/search",
    kind: "control",
    title: "Sidebar › Search (⌘K)",
    description: "Filter the sidebar to find any page. Shortcut ⌘/Ctrl+K.",
    keywords: ["search", "find page", "cmd k", "command k", "sidebar search"],
    selectors: ["[data-nav-search]"],
    fallbackSelectors: [".topbar .nav-collapse-toggle"],
    fallbackHint: "Expand the sidebar here to search it.",
  }),
  c({
    id: "control:sidebar/launchpad",
    kind: "control",
    title: "Sidebar › Launchpad button",
    keywords: ["launchpad button"],
    selectors: ["button.nav-launchpad-btn"],
    parent: "modal:launchpad",
  }),
];

// ── Solatrix ────────────────────────────────────────────────────────────────

const SX = "solatrix";
const sxSettingsRoute = pluginDetailRoute(SX, "settings");
const sxAccessReveal = [
  ...pluginOpenReveal(SX, "settings"),
  {
    kind: "wait" as const,
    selectors: [`[data-settings-section="${SX}:agent-access"]`],
    timeoutMs: 8000,
  },
];
const sxAvail = { plugin: SX };

const SX_MODES: Array<{ id: string; title: string; body: string; kw: string[] }> = [
  {
    id: "off",
    title: "Off",
    body: "Agents can't read Solana data or touch wallets.",
    kw: ["disable agent access", "no access"],
  },
  {
    id: "read",
    title: "Read-only",
    body: "Agents read markets and your portfolio; no transactions.",
    kw: ["read only", "view only", "read access"],
  },
  {
    id: "approval",
    title: "Trade with approval",
    body: "Agents may propose trades; each needs your approval (web or Telegram card).",
    kw: ["approval", "approve trades", "ask before trading", "trade with approval"],
  },
  {
    id: "full",
    title: "Full access within limits",
    body: "Agents trade autonomously within your limits; needs typed confirmation and auto-expires.",
    kw: ["full access", "autonomous trading", "auto trade", "let agents trade freely"],
  },
];

const solatrixTargets: Curated[] = [
  ext({
    id: `plugin:${SX}/settings/agent-access`,
    title: "Solatrix › Agent access",
    description:
      "What InfiniBot agents may do with Solana data and your wallets: Off · Read-only · Trade with approval · Full access within limits — plus limits, allowlists, kill switch and audit log.",
    keywords: [
      "agent access",
      "agent trading",
      "turn on trading",
      "enable trading",
      "let agents trade",
      "allow agents to trade",
      "trading permissions",
      "read-only",
      "trade with approval",
      "full access",
      "kill switch",
      "freeze",
      "limits",
      "daily cap",
      "per trade limit",
      "solana agent",
    ],
  }),
  ext({
    id: `plugin:${SX}/enable`,
    keywords: [
      "enable solatrix",
      "turn on solatrix",
      "where solatrix is enabled",
      "solatrix on off",
      "activate solatrix plugin",
    ],
  }),
  c({
    id: `control:${SX}/agent-access/mode`,
    kind: "control",
    title: "Solatrix › Agent access › Mode selector",
    description:
      "The four agent-access modes. Pick one; Full access asks for a typed confirmation and auto-expires.",
    keywords: [
      "access mode",
      "mode selector",
      "agent mode",
      "read only mode",
      "trading mode",
      ...SX_MODES.map((m) => m.title),
    ],
    route: sxSettingsRoute,
    reveal: sxAccessReveal,
    selectors: [
      ib(`control:${SX}/agent-access/mode`),
      '[data-modes] .modes[role="radiogroup"]',
      "[data-modes]",
    ],
    parent: `plugin:${SX}/settings/agent-access`,
    tab: "plugins",
    availability: sxAvail,
    pluginId: SX,
  }),
  ...SX_MODES.map((m) =>
    c({
      id: `control:${SX}/agent-access/mode/${m.id}`,
      kind: "control",
      title: `Solatrix › Agent access › ${m.title}`,
      description: m.body,
      keywords: [m.title, ...m.kw, "agent access mode"],
      route: sxSettingsRoute,
      reveal: sxAccessReveal,
      selectors: [`button.mode[data-mode="${m.id}"]`],
      parent: `control:${SX}/agent-access/mode`,
      tab: "plugins",
      availability: sxAvail,
      pluginId: SX,
    }),
  ),
  c({
    id: `control:${SX}/agent-access/freeze`,
    kind: "control",
    title: "Solatrix › Freeze agent trading (kill switch)",
    description:
      "Instantly stops every agent trade/transfer and cancels pending approvals. Unfreeze here too.",
    keywords: [
      "kill switch",
      "freeze",
      "stop agent trading",
      "panic button",
      "unfreeze",
      "emergency stop",
    ],
    route: sxSettingsRoute,
    reveal: sxAccessReveal,
    selectors: ["button[data-freeze]", "button[data-unfreeze]", "[data-hero]"],
    parent: `plugin:${SX}/settings/agent-access`,
    tab: "plugins",
    availability: sxAvail,
    pluginId: SX,
  }),
  c({
    id: `control:${SX}/agent-access/limits`,
    kind: "control",
    title: "Solatrix › Agent trading limits",
    description:
      "Max per trade (SOL / USD), daily spend cap, allowed agents and wallets. Save applies them to every agent transaction.",
    keywords: [
      "limits",
      "trade limit",
      "daily cap",
      "spend cap",
      "max per trade",
      "allowed agents",
      "allowed wallets",
    ],
    route: sxSettingsRoute,
    reveal: sxAccessReveal,
    selectors: [ib(`control:${SX}/agent-access/limits`), "[data-limits]"],
    parent: `plugin:${SX}/settings/agent-access`,
    tab: "plugins",
    availability: sxAvail,
    pluginId: SX,
  }),
  c({
    id: `control:${SX}/agent-access/consent`,
    kind: "control",
    title: "Solatrix › Risk disclosure (accept first)",
    description: "The disclosure you accept once before any trading mode can be chosen.",
    keywords: ["consent", "disclosure", "i understand", "accept risk"],
    route: sxSettingsRoute,
    reveal: sxAccessReveal,
    selectors: ["[data-consent]"],
    parent: `plugin:${SX}/settings/agent-access`,
    tab: "plugins",
    availability: sxAvail,
    pluginId: SX,
  }),
  c({
    id: `control:${SX}/agent-access/allowlist`,
    kind: "control",
    title: "Solatrix › Transfer allowlist",
    description: "Addresses agents may transfer to (withdrawals only go to allowlisted addresses).",
    keywords: ["allowlist", "whitelist", "withdrawal addresses", "transfer addresses"],
    route: sxSettingsRoute,
    reveal: sxAccessReveal,
    selectors: ["[data-allowlist]"],
    parent: `plugin:${SX}/settings/agent-access`,
    tab: "plugins",
    availability: sxAvail,
    pluginId: SX,
  }),
  c({
    id: `control:${SX}/agent-access/rpc`,
    kind: "control",
    title: "Solatrix › RPC & Birdeye keys (BYOK)",
    keywords: ["rpc url", "helius", "birdeye key", "byok"],
    route: sxSettingsRoute,
    reveal: sxAccessReveal,
    selectors: ["[data-rpc]"],
    parent: `plugin:${SX}/settings/agent-access`,
    tab: "plugins",
    availability: sxAvail,
    pluginId: SX,
  }),
  c({
    id: `control:${SX}/agent-access/audit`,
    kind: "control",
    title: "Solatrix › Agent audit log",
    description: "Every agent request, approval and transaction.",
    keywords: ["audit log", "agent history", "what did the agent do"],
    route: sxSettingsRoute,
    reveal: sxAccessReveal,
    selectors: ["[data-audit]"],
    parent: `plugin:${SX}/settings/agent-access`,
    tab: "plugins",
    availability: sxAvail,
    pluginId: SX,
  }),
  ext({
    id: `plugin:${SX}/topbar/wallet`,
    title: "Topbar › Solatrix wallet chip",
    description:
      "Active wallet balance; click for all wallets, funding (address + QR) and transfers.",
    keywords: ["wallet chip", "wallet", "balance", "fund wallet", "deposit", "sol balance"],
    aliases: ["control:topbar/wallet"],
  }),
];

// ── Mesh, memory, knowledge graph ───────────────────────────────────────────

const meshTargets: Curated[] = [
  c({
    id: "control:mesh/hud",
    kind: "control",
    title: "Agent Mesh › Controls",
    description: "Fit the map and jump to the InfiCode mesh. Zoom with the wheel or + / − keys.",
    keywords: ["mesh controls", "fit map", "zoom", "map controls"],
    route: "/mesh",
    selectors: ['.mesh-hud[role="toolbar"]'],
    parent: "page:mesh",
    tab: "mesh",
  }),
  c({
    id: "control:mesh/stats",
    kind: "control",
    title: "Agent Mesh › Live metrics",
    description: "Agents online, tool calls and tokens right now.",
    keywords: ["live metrics", "agents online", "token usage", "mesh stats"],
    route: "/mesh",
    selectors: [".awv-stats"],
    parent: "page:mesh",
    tab: "mesh",
  }),
  c({
    id: "control:memory/search",
    kind: "control",
    title: "Memory › Semantic search",
    description: "Search everything agents remember, by meaning.",
    keywords: ["search memory", "memory search", "what does the agent remember", "recall"],
    route: "/memory?view=memory",
    selectors: [ib("control:memory/search")],
    parent: "page:memory/memory",
    tab: "memory",
  }),
  c({
    id: "control:knowledge-graph/search",
    kind: "control",
    title: "Knowledge graph › Search",
    keywords: ["graph search", "find node", "search knowledge graph"],
    route: "/memory?view=graph",
    selectors: ["input.kg-search"],
    parent: "page:memory/graph",
    tab: "knowledge-graph",
  }),
  c({
    id: "control:knowledge-graph/fit",
    kind: "control",
    title: "Knowledge graph › Fit all nodes",
    keywords: ["fit graph", "reset view", "zoom to fit"],
    route: "/memory?view=graph",
    selectors: ['.kg-toolbar [title="Fit all nodes into view"]'],
    parent: "page:memory/graph",
    tab: "knowledge-graph",
  }),
  c({
    id: "control:knowledge-graph/back",
    kind: "control",
    title: "Knowledge graph › Back",
    description: "Leave the focused view and return to the full graph.",
    keywords: ["graph back", "exit focus"],
    route: "/memory?view=graph",
    selectors: ['[data-ib-target="control:knowledge-graph/back"]'],
    parent: "page:memory/graph",
    tab: "knowledge-graph",
  }),
  c({
    id: "control:knowledge-graph/bulk-bar",
    kind: "control",
    title: "Knowledge graph › Selection actions",
    description: "Actions for the selected nodes: group, link, archive or consolidate.",
    keywords: ["selected nodes", "bulk actions", "selection bar"],
    route: "/memory?view=graph",
    selectors: ['[data-ib-target="control:knowledge-graph/bulk-bar"]'],
    parent: "page:memory/graph",
    tab: "knowledge-graph",
  }),
  c({
    id: "control:knowledge-graph/details",
    kind: "control",
    title: "Knowledge graph › Details",
    description: "Open the details panel for the selected node.",
    keywords: ["node details", "graph details"],
    route: "/memory?view=graph",
    selectors: ['[data-ib-target="control:knowledge-graph/details"]'],
    parent: "page:memory/graph",
    tab: "knowledge-graph",
  }),
  c({
    id: "control:knowledge-graph/group",
    kind: "control",
    title: "Knowledge graph › Group",
    description: "Group the selected nodes.",
    keywords: ["group nodes", "make group"],
    route: "/memory?view=graph",
    selectors: ['[data-ib-target="control:knowledge-graph/group"]'],
    parent: "page:memory/graph",
    tab: "knowledge-graph",
  }),
  c({
    id: "control:knowledge-graph/hud",
    kind: "control",
    title: "Knowledge graph › Signals HUD",
    description: "Show or hide the graph's signals HUD.",
    keywords: ["graph hud", "signals hud", "toggle hud"],
    route: "/memory?view=graph",
    selectors: ['[data-ib-target="control:knowledge-graph/hud"]'],
    parent: "page:memory/graph",
    tab: "knowledge-graph",
  }),
  c({
    id: "control:knowledge-graph/hulls",
    kind: "control",
    title: "Knowledge graph › Hulls",
    description: "Show or hide the cluster hulls around groups.",
    keywords: ["cluster hulls", "group outlines"],
    route: "/memory?view=graph",
    selectors: ['[data-ib-target="control:knowledge-graph/hulls"]'],
    parent: "page:memory/graph",
    tab: "knowledge-graph",
  }),
  c({
    id: "control:knowledge-graph/link-mode",
    kind: "control",
    title: "Knowledge graph › Link mode",
    description: "Drag between nodes to link them.",
    keywords: ["link nodes", "connect nodes", "link mode"],
    route: "/memory?view=graph",
    selectors: ['[data-ib-target="control:knowledge-graph/link-mode"]'],
    parent: "page:memory/graph",
    tab: "knowledge-graph",
  }),
  c({
    id: "control:knowledge-graph/renderer",
    kind: "control",
    title: "Knowledge graph › 2D/3D renderer",
    description: "Switch the graph between the 2D and 3D renderers.",
    keywords: ["2d graph", "3d graph", "switch renderer"],
    route: "/memory?view=graph",
    selectors: ['[data-ib-target="control:knowledge-graph/renderer"]'],
    parent: "page:memory/graph",
    tab: "knowledge-graph",
  }),
  c({
    id: "control:knowledge-graph/repos",
    kind: "control",
    title: "Knowledge graph › Repos",
    description:
      "Toggle Repos mode: projects' attached git repos as a 3D file graph, with a repo picker.",
    keywords: ["repos", "repo graph", "project repos", "code graph", "file graph", "repository"],
    route: "/memory?view=graph",
    selectors: ['[data-ib-target="control:knowledge-graph/repos"]'],
    parent: "page:memory/graph",
    tab: "knowledge-graph",
  }),
  c({
    id: "control:knowledge-graph/select-mode",
    kind: "control",
    title: "Knowledge graph › Select mode",
    description: "Box-select or click to select several nodes.",
    keywords: ["select nodes", "multi select"],
    route: "/memory?view=graph",
    selectors: ['[data-ib-target="control:knowledge-graph/select-mode"]'],
    parent: "page:memory/graph",
    tab: "knowledge-graph",
  }),
  c({
    id: "control:knowledge-graph/stage",
    kind: "control",
    title: "Knowledge graph › Graph canvas",
    description: "The knowledge graph canvas itself.",
    keywords: ["graph canvas", "knowledge graph view"],
    route: "/memory?view=graph",
    selectors: ['[data-ib-target="control:knowledge-graph/stage"]'],
    parent: "page:memory/graph",
    tab: "knowledge-graph",
  }),
  c({
    id: "control:knowledge-graph/connections-all",
    kind: "control",
    title: "Knowledge graph › Connections: All",
    description: "Show every connection.",
    keywords: ["graph connections", "show links", "hide links", "connections all"],
    route: "/memory?view=graph",
    selectors: ['[data-ib-target="control:knowledge-graph/connections-all"]'],
    parent: "page:memory/graph",
    tab: "knowledge-graph",
  }),
  c({
    id: "control:knowledge-graph/connections-selected",
    kind: "control",
    title: "Knowledge graph › Connections: Selected",
    description: "Only the hovered/selected node's connections.",
    keywords: ["graph connections", "show links", "hide links", "connections selected"],
    route: "/memory?view=graph",
    selectors: ['[data-ib-target="control:knowledge-graph/connections-selected"]'],
    parent: "page:memory/graph",
    tab: "knowledge-graph",
  }),
  c({
    id: "control:knowledge-graph/connections-none",
    kind: "control",
    title: "Knowledge graph › Connections: None",
    description: "Hide connections.",
    keywords: ["graph connections", "show links", "hide links", "connections none"],
    route: "/memory?view=graph",
    selectors: ['[data-ib-target="control:knowledge-graph/connections-none"]'],
    parent: "page:memory/graph",
    tab: "knowledge-graph",
  }),
  c({
    id: "control:knowledge-graph/consolidate-apply",
    kind: "control",
    title: "Knowledge graph › Consolidate › Apply",
    description:
      "Apply the consolidation plan: merge the selected sub-projects or convert them to tasks.",
    keywords: ["consolidate", "merge sub-projects", "convert to tasks", "apply merge"],
    route: "/memory?view=graph",
    selectors: ['[data-ib-target="control:knowledge-graph/consolidate-apply"]'],
    parent: "page:memory/graph",
    tab: "knowledge-graph",
  }),
  c({
    id: "control:knowledge-graph/insights",
    kind: "control",
    title: "Knowledge graph › Insights",
    keywords: ["graph insights", "toggle insights"],
    route: "/memory?view=graph",
    selectors: ['.kg-toolbar [title="Toggle insights"]'],
    parent: "page:memory/graph",
    tab: "knowledge-graph",
  }),
  c({
    id: "control:knowledge-graph/filters",
    kind: "control",
    title: "Knowledge graph › Filters",
    description: "Show or hide node kinds and health states.",
    keywords: ["graph filters", "filter nodes", "node kinds"],
    route: "/memory?view=graph",
    selectors: [".kg-chip"],
    parent: "page:memory/graph",
    tab: "knowledge-graph",
  }),
];

// ── Plugins page (Home › Plugins) ───────────────────────────────────────────

const pluginsPageTargets: Curated[] = [
  c({
    id: "control:plugins/search",
    kind: "control",
    title: "Plugins › Search plugins",
    description: "Search installed and available plugins by name, category or tag.",
    keywords: ["search plugins", "find a plugin", "plugin search"],
    route: "/plugins",
    selectors: ['[data-learn-id="plugins-search"]'],
    parent: "page:plugins",
    tab: "plugins",
  }),
  c({
    id: "control:plugins/installed",
    kind: "control",
    title: "Plugins › Installed plugins",
    description: "The shelf of installed plugins with their on/off state.",
    keywords: ["installed plugins", "my plugins", "which plugins are on"],
    route: "/plugins",
    selectors: ['[data-learn-id="plugins-installed"]'],
    parent: "page:plugins",
    tab: "plugins",
  }),
  ext({
    id: "page:plugins",
    // Plugins was a Setup sub-tab until 2026-10-16; keep the old id resolvable.
    aliases: ["page:setup/plugins"],
    description:
      "Install, turn on/off and configure plugins (Solatrix, Infinitrade, Robovoice, Business & Agency…).",
    keywords: [
      "plugins",
      "plugin marketplace",
      "enable plugin",
      "turn on plugin",
      "install plugin",
      "extensions",
      "add-ons",
    ],
  }),
];

export const CURATED_TARGETS: Curated[] = [
  ...setupSectionTargets,
  ...coderTargets,
  ...apiKeyTargets,
  ...channelTargets,
  ...topbarTargets,
  ...launchpadTargets,
  ...solatrixTargets,
  ...meshTargets,
  ...pluginsPageTargets,
];
