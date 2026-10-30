/**
 * infinibot_help — answer "where / how / why" questions about InfiniBot from
 * the knowledge base + the user's live state. Returns an answer SKELETON the
 * agent turns into a reply: diagnosis (facts, not guesses), the exact
 * breadcrumb as it appears in the UI, target ids, the ui_control call that
 * opens the place, and a suggested offer.
 */

import type { InfinibotState } from "./live-state.js";
import { searchKnowledge, type SearchHit } from "./search.js";
import {
  navigateHintFor,
  type NavigateHint,
  type UiControlCaps,
  type UiTargetRegistry,
} from "./targets.js";
import type { KnowledgeBase, KnowledgeEntry } from "./types.js";

export type HelpPlace = {
  id: string;
  title: string;
  breadcrumb: string;
  route?: string;
  targets: string[];
  alsoAt?: string;
};

export type HelpAnswer = {
  ok: true;
  question: string;
  /** Facts from the live state that explain the situation. Say these first. */
  diagnosis: string[];
  /** The single best place to go (null when the question isn't about a place). */
  place: HelpPlace | null;
  steps: string[];
  /** Exact ui_control call(s) to open `place` — use them when the user wants to go there. */
  navigate: NavigateHint | null;
  /** One sentence to offer. */
  suggestedAction: string | null;
  summary: string;
  alsoRelevant: Array<{ id: string; title: string; breadcrumb: string }>;
  /** Compact live facts relevant to the question. */
  state?: Record<string, unknown>;
  stateAvailable: boolean;
  reminders: string[];
};

export type HelpInput = {
  question: string;
  /** Recent conversation text (e.g. your previous reply) — resolves "navigate there". */
  context?: string;
};

export type HelpEnv = {
  kb: KnowledgeBase;
  state: InfinibotState | null;
  caps: UiControlCaps;
  registry: UiTargetRegistry;
  /** Live tool list of the calling agent (names + descriptions). */
  tools?: Array<{ name: string; description?: string }>;
};

const NAV_INTENT =
  /^(please\s+)?(navigate|go|take me|bring me|open|show me|get me|pull (it )?up)( me)?( (there|to it|it|that|this|that page|that screen|the page|that setting))?\s*[.!?]*$/i;
const NAV_WORDS =
  /\b(navigate|take me|go there|open it|open that|bring me|show me where|get me there)\b/i;

const crumb = (e: KnowledgeEntry) => e.breadcrumb.join(" › ");
const toPlace = (e: KnowledgeEntry): HelpPlace => ({
  id: e.id,
  title: e.title,
  breadcrumb: crumb(e),
  route: e.route,
  targets: e.targets,
  alsoAt: typeof e.facts?.alsoAt === "string" ? (e.facts.alsoAt as string) : undefined,
});

type Diagnosis = {
  lines: string[];
  placeId?: string;
  steps?: string[];
  state?: Record<string, unknown>;
};

function mentions(q: string, ...words: RegExp[]): boolean {
  return words.some((w) => w.test(q));
}

/** Topic rules over the live state. Each returns facts, never guesses. */
function diagnose(
  q: string,
  hits: SearchHit[],
  kb: KnowledgeBase,
  state: InfinibotState | null,
): Diagnosis {
  const out: Diagnosis = { lines: [] };
  if (!state) return out;
  const topPlugin = hits[0]?.entry.pluginId;
  const pluginIdsInQ = kb.entries
    .filter((e) => e.kind === "plugin" && e.pluginId)
    .filter((e) => {
      const name = e.title.replace(/ plugin$/, "").toLowerCase();
      return new RegExp(`\\b(${esc(e.pluginId!)}|${esc(name)})\\b`, "i").test(q);
    })
    .map((e) => e.pluginId!);
  const solanaTopic =
    mentions(
      q,
      /\bsolatrix\b/i,
      /\bsolana\b/i,
      /\bwallets?\b/i,
      /\bsol\b/i,
      /\bbubble ?map\b/i,
      /\btokens?\b/i,
      /\bconvergence\b/i,
    ) || topPlugin === "solatrix";

  // Plugin enable state for plugins the user named.
  for (const id of new Set(pluginIdsInQ)) {
    const p = state.plugins.find((x) => x.id === id);
    const entry = kb.byId.get(`plugin:${id}`);
    const name = entry?.title.replace(/ plugin$/, "") ?? id;
    if (!p) {
      out.lines.push(`The ${name} plugin is not installed on this InfiniBot.`);
    } else if (!p.enabled) {
      out.lines.push(
        `The ${name} plugin is DISABLED. Enable it in ${entry ? crumb(entry) : "Home › Plugins"} (turning a plugin on reloads the gateway).`,
      );
      out.placeId ??= `plugin:${id}`;
    } else if (p.status !== "loaded") {
      out.lines.push(
        `The ${name} plugin is enabled but failed to load${p.error ? `: ${p.error}` : ""}. See ${entry ? crumb(entry) : "Home › Plugins"} › Health & Logs.`,
      );
      out.placeId ??= `plugin:${id}/health`;
    } else {
      out.lines.push(`The ${name} plugin is enabled and loaded.`);
    }
  }

  // Solatrix: plugin on/off is NOT the same as agent access.
  if (solanaTopic && state.solatrix) {
    const s = state.solatrix;
    const wantsTrade = mentions(q, /\b(trade|buy|sell|swap|transfer|send)\b/i);
    if (!s.enabled) {
      if (!pluginIdsInQ.includes("solatrix"))
        out.lines.push(
          "The Solatrix plugin is DISABLED, so the solana_* tools don't exist yet. Enable it in Home › Plugins › Solatrix.",
        );
      out.placeId ??= "plugin:solatrix";
      out.steps = kb.byId.get("flow:solatrix-agent-access")?.steps;
    } else if (s.agentAccess === "off") {
      out.lines.push(
        "The Solatrix plugin IS enabled — what's Off is its **Agent access** setting (a separate switch that starts Off). While it is Off agents can't read Solana market data or your wallets.",
        "Fix: set Agent access mode to Read-only (or Trade with approval for trades). Only the owner can change it, in the UI — agents can't set it, so offer to OPEN the page, not to change it.",
      );
      out.placeId = "control:solatrix/agent-access/mode";
    } else if (s.agentAccess === "read" && wantsTrade) {
      out.lines.push(
        "Solatrix Agent access is Read-only: agents can read prices, balances, positions and P&L but cannot trade or transfer. Trading needs Trade with approval (or Full access).",
      );
      out.placeId = "control:solatrix/agent-access/mode";
    } else if (s.agentAccess) {
      out.lines.push(`Solatrix Agent access is ${label(s.agentAccess)}.`);
    }
    if (s.enabled && s.frozen) {
      out.lines.push(
        `Agent trading is FROZEN (${s.frozen.reason}). Only the owner can unfreeze it (Freeze agent trading / Unfreeze in Agent access & limits).`,
      );
      if (wantsTrade) out.placeId = "control:solatrix/agent-access/kill-switch";
    }
    if (
      s.enabled &&
      wantsTrade &&
      s.permissions &&
      !(s.permissions.executeSwaps && s.permissions.transferFunds)
    ) {
      const off = [
        !s.permissions.executeSwaps && "Execute swaps",
        !s.permissions.transferFunds && "Transfer funds",
      ]
        .filter(Boolean)
        .join(" and ");
      out.lines.push(
        `Host permission ${off} is off (Home › Plugins › Solatrix › Permissions) — trades/transfers need it.`,
      );
      if (s.agentAccess !== "off" && s.agentAccess !== "read" && !s.frozen)
        out.placeId ??= "plugin:solatrix/permissions";
    }
    if (
      s.enabled &&
      wantsTrade &&
      s.agentAccess !== "off" &&
      s.agentAccess !== "read" &&
      s.consentAccepted === false
    ) {
      out.lines.push(
        "The Solatrix trading disclosure hasn't been accepted yet (Agent access & limits › Before agents can trade).",
      );
    }
    if (s.enabled && s.walletCount === 0) {
      out.lines.push(
        "There are no Solatrix wallets yet — add or import one in Solatrix › Wallets.",
      );
      if (s.agentAccess !== "off") out.placeId ??= "page:solatrix-wallets";
    }
    if (
      s.enabled &&
      s.rpc &&
      (s.rpc.source === "public" || s.rpc.rateLimited) &&
      mentions(q, /\b(rpc|holders?|bubble|slow|rate|limit|error|fail)/i)
    ) {
      out.lines.push(
        "Solatrix is on the public Solana RPC (rate limited; heavy calls like holder lists fail). Add your own RPC URL in Agent access & limits › Solana RPC.",
      );
      out.placeId ??= "control:solatrix/agent-access/rpc";
    }
    out.state = { solatrix: s };
  }

  const check = (id: string) => state.setup.find((c) => c.id === id);

  if (
    mentions(
      q,
      /\bapi ?keys?\b/i,
      /\bmodel\b/i,
      /\bprovider\b/i,
      /\bllm\b/i,
      /\bopenai|anthropic|openrouter|groq|gemini key\b/i,
    )
  ) {
    const c = check("core.models");
    out.lines.push(
      c
        ? `Model provider: ${c.reason || c.state}`
        : `A model provider is working${state.models.primary ? ` (primary model ${state.models.primary})` : ""}.`,
    );
    out.state = { ...out.state, models: state.models };
  }
  if (mentions(q, /\bgmail\b/i, /\bemail\b/i, /\binbox\b/i, /\bimap\b/i)) {
    const c = check("core.inbox");
    out.lines.push(
      c
        ? `Email: ${c.reason || "no email account connected yet"}.`
        : "An email account is already connected to the Inbox.",
    );
  }
  if (
    mentions(q, /\btelegram\b/i, /\bapprovals?\b/i, /\bchannels?\b/i, /\bwhatsapp|discord|slack\b/i)
  ) {
    const tg = state.channels.telegram;
    if (mentions(q, /\btelegram\b/i, /\bapprovals?\b/i)) {
      out.lines.push(
        tg.configured
          ? `Telegram is connected${tg.ownerChat ? " with an owner chat" : " but has no owner chat id yet (message the bot once)"}.`
          : "Telegram is not connected yet (Settings › Channels › Telegram).",
      );
    }
    if (mentions(q, /\bapprovals?\b/i)) {
      out.lines.push(
        state.approvals.telegram.enabled
          ? "Telegram approvals are ON — approval requests arrive in your Telegram chat with Approve/Deny buttons (and in the topbar Approvals inbox)."
          : `Telegram approvals are OFF: ${state.approvals.telegram.reason ?? "not configured"}.`,
      );
    }
    if (state.channels.configured.length)
      out.lines.push(`Connected channels: ${state.channels.configured.join(", ")}.`);
  }
  if (
    mentions(
      q,
      /\bclaude code\b/i,
      /\bcodex\b/i,
      /\bopencode\b/i,
      /\bcoders?\b/i,
      /\bcoding agent\b/i,
      /\bgemini cli\b/i,
    )
  ) {
    if (state.deployment === "cloud")
      out.lines.push(
        "Coding CLIs (Claude Code, Codex, OpenCode) run on a local InfiniBot; InfiniBot Cloud doesn't install them.",
      );
    else if (state.coders) {
      const inst = state.coders.filter((c) => c.installed);
      out.lines.push(
        inst.length
          ? `Installed coders: ${inst.map((c) => `${c.id}${c.signedIn === false ? " (signed out)" : c.signedIn ? " (signed in)" : ""}${c.isDefault ? " [default]" : ""}`).join(", ")}.`
          : "No coding agent is installed yet.",
      );
    }
  }
  if (mentions(q, /\bvoice\b/i, /\bmicrophone\b/i, /\bwake word\b/i, /\btts\b/i)) {
    if (state.voice.configured !== null)
      out.lines.push(
        state.voice.configured
          ? "Voice is configured."
          : "Voice isn't set up yet (Settings › Setup › Voice).",
      );
  }
  if (mentions(q, /\bcloud\b/i, /\blocal\b/i, /\bself.?host/i, /\bsaas\b/i)) {
    out.lines.push(
      `This workspace is running ${state.deployment === "cloud" ? "on InfiniBot Cloud (hosted)" : "locally (self-hosted gateway)"}.`,
    );
  }
  if (mentions(q, /\bglow(ing)?\b/i, /\bneeds setup\b/i, /\bsetup\b.*\b(left|missing|todo)\b/i)) {
    out.lines.push(
      state.setup.length
        ? `Not ready: ${state.setup.map((c) => `${c.title} — ${c.reason || c.state}`).join("; ")}.`
        : "Every setup check is ready.",
    );
  }
  if (state.mainAgent && !state.mainAgent.hasUiControl) {
    out.lines.push(
      "Note: ui_control is not in the main agent's tool allowlist, so I can't open pages for you until it's added (agents.list[main].tools.allow) and the gateway restarts.",
    );
  }
  return out;
}

function esc(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function label(mode: string): string {
  return (
    { off: "Off", read: "Read-only", approval: "Trade with approval", full: "Full access" }[mode] ??
    mode
  );
}

export function answerHelp(input: HelpInput, env: HelpEnv): HelpAnswer {
  const question = String(input.question ?? "").trim();
  const navIntent =
    NAV_INTENT.test(question) || (NAV_WORDS.test(question) && question.split(/\s+/).length <= 6);
  // "navigate there" carries no topic — resolve the place from the context.
  const searchText = navIntent && input.context ? `${input.context}\n${question}` : question;
  let hits = searchKnowledge(env.kb, searchText, { limit: 10 });
  if (!hits.length && input.context) hits = searchKnowledge(env.kb, input.context, { limit: 10 });

  // Tool catalogue: a question naming a live tool gets its description.
  const toolHit = env.tools?.find((t) => new RegExp(`\\b${esc(t.name)}\\b`).test(question));

  const d = diagnose(`${searchText}`, hits, env.kb, env.state);
  const nonDoc = hits.filter((h) => h.entry.kind !== "doc");
  const placeEntry =
    (d.placeId ? env.kb.byId.get(d.placeId) : undefined) ??
    nonDoc.find((h) => h.entry.route || h.entry.tab)?.entry ??
    null;
  const flow = hits.find(
    (h) =>
      h.entry.kind === "flow" && h.entry.steps?.length && !h.entry.id.startsWith("flow:learn/"),
  )?.entry;
  const steps =
    d.steps ??
    placeEntry?.steps ??
    (flow &&
    (!placeEntry ||
      flow.targets.includes(placeEntry.id) ||
      flow.pluginId === placeEntry.pluginId ||
      hits[0]?.entry === flow)
      ? flow.steps
      : undefined) ??
    [];

  const navigate = placeEntry
    ? navigateHintFor(placeEntry, {
        caps: env.caps,
        registry: env.registry,
        // Human page name for "Opening …" (the tab's own breadcrumb).
        label: (tab) => env.kb.byId.get(`page:${tab}`)?.breadcrumb.join(" › ") ?? tab,
      })
    : null;
  // Where on the landing page the control sits (curated `onPage`).
  const onPage =
    typeof placeEntry?.facts?.onPage === "string" ? (placeEntry.facts.onPage as string) : undefined;
  if (navigate && onPage) navigate.thenLookFor = onPage;
  const place = placeEntry ? toPlace(placeEntry) : null;
  const summary = [
    placeEntry?.summary,
    toolHit
      ? `Tool ${toolHit.name}: ${String(toolHit.description ?? "").split(/(?<=[.!?])\s/)[0]}`
      : undefined,
  ]
    .filter(Boolean)
    .join(" ");

  const suggestedAction = place
    ? navigate
      ? `Offer: "I can open ${navigate.approximate ? `${navigate.say.replace(/^Opening /, "")} for you (then ${navigate.thenLookFor})` : place.breadcrumb} for you." — if the user already asked to go there, call ui_control now with \`navigate.call\`.`
      : `Tell the user the path: ${place.breadcrumb}.`
    : null;

  return {
    ok: true,
    question,
    diagnosis: d.lines,
    place,
    steps,
    navigate,
    suggestedAction,
    summary,
    alsoRelevant: hits
      .filter((h) => h.entry.id !== placeEntry?.id)
      .slice(0, 5)
      .map((h) => ({ id: h.entry.id, title: h.entry.title, breadcrumb: crumb(h.entry) })),
    state: d.state,
    stateAvailable: Boolean(env.state),
    reminders: [
      "Use the breadcrumb exactly as given; don't add gear icons, menus or buttons that aren't in it.",
      navIntent
        ? "The user asked to go there: call ui_control with navigate.call now (no question back), then say what you opened."
        : "If the user asks to go there, call ui_control with navigate.call instead of asking which screen.",
      "Use only option labels that appear in this answer (e.g. Off / Read-only / Trade with approval / Full access) — never invent others.",
      "After navigating, STOP: don't scroll/find/click to hunt for the control. Tell the user where it is on the page (navigate.thenLookFor) and let them change owner settings (agent access, permissions, keys) themselves.",
      "Describe controls only as the summary does (e.g. option cards vs dropdown; applies immediately vs Save). Never add buttons, gear icons or menus.",
      "navigate.call is for YOU to execute with the ui_control tool — never paste it, JSON, tool names or tab ids into your reply. The user only sees the breadcrumb.",
      "Never ask the user to run raw JSON/RPC when a UI control exists.",
    ],
  };
}
