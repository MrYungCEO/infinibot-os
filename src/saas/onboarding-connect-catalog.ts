/**
 * Connector catalogue for the SaaS quickstart's "full setup" steps: messaging
 * channels, integrations, and MCP connectors.
 *
 * Channels and integrations are derived from the canonical registry
 * (src/agents/known-providers.ts, `category: "channel" | "integration"`), so a
 * provider added there shows up here. WhatsApp is the one channel the registry
 * doesn't carry (it links a device, there is no token to paste).
 *
 * MCP connectors have no registry in source: the servers a gateway runs come
 * from the operator's mcp-servers.json (src/mcp/local-discovery.ts), Supabase's
 * hosted MCP from src/gateway/server-methods/supabase.ts, and Canva's OAuth from
 * src/gateway/canva-oauth-http.ts. The ids below match those server names.
 *
 * Every connector has one honest mode:
 *   - `token`  paste a token; it's checked with the service before it's saved
 *   - `link`   link a device in the flow (WhatsApp QR / pairing code)
 *   - `toggle` no credential, or reuses a key from another connector
 *   - `later`  can't be completed from the hosted onboarding yet; `laterReason` says why
 *
 * Zero imports beyond the registry and the KeyCheck type, and no I/O, so the
 * visual harness can bundle it.
 */
import { KNOWN_PROVIDERS } from "../agents/known-providers.js";
import type { KeyCheck } from "./onboarding-catalog.js";

export type ConnectorGroup = "channel" | "integration" | "mcp";
export type ConnectorMode = "token" | "link" | "toggle" | "later";

export interface ConnectorField {
  id: "token" | "appToken";
  label: string;
  hint: string;
  /** Auth-profile provider id the secret is stored under (`<provider>:default`). */
  profile: string;
  check?: KeyCheck;
}

export interface ConnectorSpec {
  id: string;
  label: string;
  group: ConnectorGroup;
  mode: ConnectorMode;
  /** One line on what connecting it does. */
  blurb: string;
  signupUrl?: string;
  fields: ConnectorField[];
  /** `toggle` connectors that run on another connector's token (Notion MCP → Notion). */
  reusesKeyOf?: string;
  /** Why a `later` connector can't be completed here. Shown verbatim. */
  laterReason?: string;
  /** Cost or side effect of the key check, when there is one. */
  checkNote?: string;
}

const bearer = (key: string) => ({ Authorization: `Bearer ${key}` });

type Extras = Omit<ConnectorSpec, "id" | "label" | "group">;

/** Registry channels and integrations: what the registry doesn't carry. */
const REGISTRY_EXTRAS: Record<string, Extras> = {
  // Same endpoints as probeTelegram / probeDiscord / probeSlack (src/*/probe.ts),
  // expressed as KeyChecks so the validate-base-url test hook covers them.
  telegram: {
    mode: "token",
    blurb: "Chat with your assistant from a Telegram bot.",
    signupUrl: "https://core.telegram.org/bots#how-do-i-create-a-bot",
    fields: [
      {
        id: "token",
        label: "Bot token",
        hint: "123456:ABC-…",
        profile: "telegram",
        check: {
          kind: "get",
          url: (key) => `https://api.telegram.org/bot${key}/getMe`,
          headers: () => ({}),
          okField: "ok",
          accountField: "result.username",
        },
      },
    ],
  },
  discord: {
    mode: "token",
    blurb: "Add your assistant to a Discord server as a bot.",
    signupUrl: "https://discord.com/developers/applications",
    fields: [
      {
        id: "token",
        label: "Bot token",
        hint: "Discord bot token",
        profile: "discord",
        check: {
          kind: "get",
          url: "https://discord.com/api/v10/users/@me",
          headers: (key) => ({ Authorization: `Bot ${key.replace(/^Bot\s+/i, "")}` }),
          accountField: "username",
        },
      },
    ],
  },
  slack: {
    mode: "token",
    blurb: "Answer in Slack channels and DMs over Socket Mode.",
    signupUrl: "https://api.slack.com/apps",
    fields: [
      {
        id: "token",
        label: "Bot token",
        hint: "xoxb-…",
        profile: "slack",
        check: {
          kind: "get",
          url: "https://slack.com/api/auth.test",
          headers: bearer,
          okField: "ok",
          accountField: "team",
        },
      },
      {
        id: "appToken",
        label: "App token (Socket Mode)",
        hint: "xapp-…",
        profile: "slack-app",
        // Opening a Socket Mode ticket authenticates the app token; nothing connects to it.
        check: {
          kind: "get",
          method: "POST",
          url: "https://slack.com/api/apps.connections.open",
          headers: bearer,
          okField: "ok",
        },
      },
    ],
  },
  notion: {
    mode: "token",
    blurb: "Read and write your Notion pages and databases.",
    signupUrl: "https://www.notion.so/profile/integrations",
    fields: [
      {
        id: "token",
        label: "Integration secret",
        hint: "ntn_…",
        profile: "notion",
        check: {
          kind: "get",
          url: "https://api.notion.com/v1/users/me",
          headers: (key) => ({ ...bearer(key), "Notion-Version": "2022-06-28" }),
          accountField: "name",
        },
      },
    ],
  },
  loops: {
    mode: "token",
    blurb: "Send product email and newsletters through Loops.",
    signupUrl: "https://app.loops.so/settings?page=api",
    fields: [
      {
        id: "token",
        label: "API key",
        hint: "Loops API key",
        profile: "loops",
        check: {
          kind: "get",
          url: "https://app.loops.so/api/v1/api-key",
          headers: bearer,
          accountField: "teamName",
        },
      },
    ],
  },
  github: {
    mode: "token",
    blurb: "Work with your repositories, issues and pull requests.",
    signupUrl: "https://github.com/settings/personal-access-tokens",
    fields: [
      {
        id: "token",
        label: "Personal access token",
        hint: "github_pat_…",
        profile: "github",
        check: {
          kind: "get",
          url: "https://api.github.com/user",
          headers: (key) => ({
            ...bearer(key),
            Accept: "application/vnd.github+json",
            "User-Agent": "InfiniBot",
          }),
          accountField: "login",
        },
      },
    ],
  },
  brave: {
    mode: "token",
    blurb: "Live web search for research and lead finding.",
    signupUrl: "https://api-dashboard.search.brave.com/app/keys",
    checkNote: "The check runs one search, which counts toward your Brave quota.",
    fields: [
      {
        id: "token",
        label: "Subscription token",
        hint: "Brave Search API key",
        profile: "brave",
        check: {
          kind: "get",
          url: "https://api.search.brave.com/res/v1/web/search?q=infinibot&count=1",
          headers: (key) => ({ "X-Subscription-Token": key, Accept: "application/json" }),
        },
      },
    ],
  },
  hunter: {
    mode: "token",
    blurb: "Find and verify business email addresses.",
    signupUrl: "https://hunter.io/api-keys",
    fields: [
      {
        id: "token",
        label: "API key",
        hint: "Hunter API key",
        profile: "hunter",
        check: {
          kind: "get",
          url: "https://api.hunter.io/v2/account",
          headers: (key) => ({ "X-API-KEY": key }),
          accountField: "data.email",
        },
      },
    ],
  },
  gmail: {
    mode: "later",
    blurb: "Triage and draft email from your inbox.",
    fields: [],
    laterReason:
      "Google sign-in needs a hosted OAuth redirect, which isn't set up yet. Connect Gmail from Inbox after setup.",
  },
  "google-calendar": {
    mode: "later",
    blurb: "See and schedule events on your calendar.",
    fields: [],
    laterReason:
      "Google sign-in needs a hosted OAuth redirect, which isn't set up yet. Connect your calendar after setup.",
  },
};

/** WhatsApp links a device through InfiniBot's existing QR / pairing-code login. */
const WHATSAPP: ConnectorSpec = {
  id: "whatsapp",
  label: "WhatsApp",
  group: "channel",
  mode: "link",
  blurb: "Link a WhatsApp number by QR code or pairing code.",
  fields: [],
};

export const ONBOARDING_MCP_CONNECTORS: ConnectorSpec[] = [
  {
    id: "notion-mcp",
    label: "Notion MCP",
    group: "mcp",
    mode: "toggle",
    reusesKeyOf: "notion",
    blurb: "Notion search and editing tools for your agents.",
    fields: [],
  },
  {
    id: "supabase",
    label: "Supabase",
    group: "mcp",
    mode: "token",
    blurb: "Query and manage your Supabase projects through the hosted MCP.",
    signupUrl: "https://supabase.com/dashboard/account/tokens",
    fields: [
      {
        id: "token",
        label: "Access token",
        hint: "sbp_…",
        profile: "supabase",
        check: {
          kind: "get",
          url: "https://api.supabase.com/v1/projects",
          headers: bearer,
          countField: "*",
        },
      },
    ],
  },
  {
    id: "excalidraw",
    label: "Excalidraw",
    group: "mcp",
    mode: "toggle",
    blurb: "Whiteboard diagrams your agents can draw. No account needed.",
    fields: [],
  },
  {
    id: "canva",
    label: "Canva",
    group: "mcp",
    mode: "later",
    blurb: "Create and export designs from your Canva account.",
    fields: [],
    laterReason:
      "Canva sign-in uses an OAuth redirect on the gateway host, which a hosted workspace can't complete yet.",
  },
  {
    id: "flypic",
    label: "Flypic",
    group: "mcp",
    mode: "later",
    blurb: "Brand-consistent image generation.",
    fields: [],
    laterReason:
      "Flypic runs as an operator-hosted service. Per-workspace access isn't available yet.",
  },
];

function fromRegistry(category: "channel" | "integration"): ConnectorSpec[] {
  return KNOWN_PROVIDERS.filter((p) => p.category === category).map((p) => {
    const extras = REGISTRY_EXTRAS[p.id];
    return {
      id: p.id,
      label: p.label,
      group: category,
      // A registry entry this file doesn't know yet can't be checked: offer it later.
      ...(extras ?? {
        mode: "later" as const,
        blurb: "",
        fields: [],
        laterReason: "Not available in onboarding yet. Connect it from Settings.",
      }),
    };
  });
}

export const ONBOARDING_CHANNELS: ConnectorSpec[] = [...fromRegistry("channel"), WHATSAPP];
export const ONBOARDING_INTEGRATIONS: ConnectorSpec[] = fromRegistry("integration");

export const ONBOARDING_CONNECTORS: ConnectorSpec[] = [
  ...ONBOARDING_CHANNELS,
  ...ONBOARDING_INTEGRATIONS,
  ...ONBOARDING_MCP_CONNECTORS,
];

export function getConnector(id: unknown): ConnectorSpec | undefined {
  return ONBOARDING_CONNECTORS.find((c) => c.id === id);
}

// ── Business context ───────────────────────────────────────────────────────

export const BUSINESS_INDUSTRIES = [
  "Agency",
  "E-commerce",
  "SaaS",
  "Consulting",
  "Creator",
  "Health",
  "Real estate",
  "Finance",
  "Education",
  "Local services",
] as const;

export const BUSINESS_TONES = ["Professional", "Friendly", "Bold", "Playful", "Minimal"] as const;
