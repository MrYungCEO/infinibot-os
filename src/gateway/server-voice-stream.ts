/**
 * Voice chat streaming endpoint for faster TTS response
 * SSE-based streaming of agent responses
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

import { resolveSessionAgentId, listAgentIds } from "../agents/agent-scope.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { resolveEffectiveMessagesConfig, resolveIdentityName } from "../agents/identity.js";
import { dispatchInboundMessage } from "../auto-reply/dispatch.js";
import {
  setLiveActionForSession,
  setGridContextForSession,
  getDocScopeForSession,
  getDocModalitiesForSession,
  type GridContext,
} from "./live-action-context.js";
import { buildGridLiveActionPreamble } from "./grid-live-action-prompt.js";
import { buildDocLiveActionPreamble } from "./doc-live-action-prompt.js";
import { getVoiceRoute } from "./server-voice-config.js";
import { voiceTurnNeedsTools } from "./voice-fast-path.js";
import {
  VOICE_ORCHESTRATOR_LINES,
  voiceProductMapLines,
} from "../agents/voice-orchestrator-prompt.js";
import { buildActiveProfileContextBlock } from "../users/profile-context.js";
import { createClaudeCoderTool } from "../agents/tools/claude-coder-tool.js";
import { createReplyDispatcher } from "../auto-reply/reply/reply-dispatcher.js";
import {
  extractShortModelName,
  type ResponsePrefixContext,
} from "../auto-reply/reply/response-prefix-template.js";
import type { MsgContext } from "../auto-reply/templating.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel.js";
import { loadSessionEntry } from "./session-utils.js";
import { formatForLog } from "./ws-log.js";
import { STATE_DIR } from "../config/paths.js";
import { isCoderBackendId } from "../agents/coder-backend/types.js";

interface VoiceAttachment {
  id?: string;
  dataUrl?: string;
  mimeType?: string;
  name?: string;
}

/**
 * Persists each base64 data URL to a file under STATE_DIR/voice-attachments
 * and returns local paths + mime types that line up positionally. The voice
 * stream populates MediaPaths / MediaTypes on the MsgContext with these so
 * vision-capable agents pick them up through the existing media pipeline.
 */
function materializeAttachments(attachments: VoiceAttachment[]): {
  paths: string[];
  types: string[];
  names: string[];
} {
  const baseDir = join(STATE_DIR, "voice-attachments");
  if (!existsSync(baseDir)) mkdirSync(baseDir, { recursive: true });
  const paths: string[] = [];
  const types: string[] = [];
  const names: string[] = [];
  for (const a of attachments) {
    if (!a?.dataUrl || typeof a.dataUrl !== "string") continue;
    const m = a.dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!m) continue;
    const mime = a.mimeType || m[1] || "image/png";
    const buf = Buffer.from(m[2], "base64");
    // Extension from mime; default to .png so vision pipelines that key
    // on extension still see something parseable.
    const ext =
      mime === "image/jpeg"
        ? ".jpg"
        : mime === "image/webp"
          ? ".webp"
          : mime === "image/gif"
            ? ".gif"
            : mime === "image/svg+xml"
              ? ".svg"
              : ".png";
    const id = a.id || randomUUID();
    const p = join(baseDir, `${id}${ext}`);
    try {
      writeFileSync(p, buf);
      paths.push(p);
      types.push(mime);
      names.push(a.name || `${id}${ext}`);
    } catch {
      // Skip the attachment if write fails — don't drop the whole turn.
    }
  }
  return { paths, types, names };
}

// ── Barge-in cancellation registry ──────────────────────────────────────
// Maps an in-flight voice runId → its AbortController so a LiveKit barge-in
// can stop the gateway DISPATCH (not just the played audio). This is the
// SSE-voice equivalent of the WS chat path's ChatRunRegistry
// (src/gateway/server-chat.ts): keyed by the same runId we now surface to the
// client as the first SSE event. Additive — nothing else reads this map.
const voiceRunAbortControllers = new Map<string, AbortController>();

/**
 * Abort the in-flight voice dispatch for `runId`, if one is registered.
 * Returns true when a live run was found and aborted. Invoked by the cancel
 * endpoint below when the LiveKit agent detects a barge-in.
 */
export function cancelVoiceRun(runId: string): boolean {
  const controller = voiceRunAbortControllers.get(runId);
  if (!controller) return false;
  try {
    controller.abort();
  } finally {
    voiceRunAbortControllers.delete(runId);
  }
  return true;
}

/**
 * POST /api/voice/chat/cancel  { runId }
 *
 * Barge-in cancel endpoint: stops the in-flight gateway run keyed by runId.
 * Must be wired BEFORE handleVoiceChatRequest (which matches the broader
 * `/api/voice/chat` prefix) so it isn't swallowed. Additive/minimal — does not
 * touch the existing dispatch handlers.
 */
export async function handleVoiceChatCancelRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (!req.url?.startsWith("/api/voice/chat/cancel")) return false;
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return true;
  }
  try {
    let body = "";
    for await (const chunk of req) body += chunk;
    const data = body ? JSON.parse(body) : {};
    const runId = typeof data.runId === "string" ? data.runId : "";
    if (!runId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "runId required" }));
      return true;
    }
    const cancelled = cancelVoiceRun(runId);
    console.log(`[VoiceChatStream] cancel runId=${runId} → ${cancelled ? "aborted" : "not-found"}`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, cancelled, runId }));
    return true;
  } catch (err: any) {
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err?.message ?? "cancel failed" }));
    }
    return true;
  }
}

export async function handleVoiceChatStreamRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (!req.url?.startsWith("/api/voice/chat/stream")) return false;
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return true;
  }

  try {
    console.log("[VoiceChatStream] Request received");

    // Read request body
    let body = "";
    for await (const chunk of req) {
      body += chunk;
    }

    const data = JSON.parse(body);
    const message: string = typeof data.message === "string" ? data.message : "";
    const sessionKey = data.sessionKey || "agent:main:voice";
    const liveActionMode = data.liveActionMode === true;
    // gridContext (shape from live-action-context.ts → GridContext) is sent by
    // A1's voice panel when the user is operating the multi-panel Grid view.
    // We accept the loose shape from JSON and treat it as GridContext only if
    // it has the required arrays — anything else is ignored.
    const rawGridContext = data.gridContext;
    const gridContext: GridContext | null =
      rawGridContext &&
      typeof rawGridContext === "object" &&
      Array.isArray(rawGridContext.panelIds) &&
      Array.isArray(rawGridContext.panels)
        ? (rawGridContext as GridContext)
        : null;
    const rawAttachments: VoiceAttachment[] = Array.isArray(data.attachments)
      ? data.attachments
      : [];
    const materialized =
      rawAttachments.length > 0
        ? materializeAttachments(rawAttachments)
        : { paths: [], types: [], names: [] };

    // Allow an attachment-only turn (e.g. "look at this screenshot"). Reject
    // only when BOTH the text and the attachments are empty.
    if (!message && materialized.paths.length === 0) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Message or attachments required" }));
      return true;
    }

    // Live Action Mode preamble — when the user has the sidebar engaged
    // we want the agent to drive the *running* InfiniBot UI via the
    // ui_control tool, not launch a separate browser. Without this block
    // the model treats requests like "open my projects page" as URL
    // navigations and reaches for the browser tool because that's the
    // pattern it sees most often in training data.
    //
    // The instructions are stacked: we tell it (a) what Live Action is,
    // (b) which tool to use, (c) what NOT to use, and (d) how common
    // requests map to ui_control actions. (a)+(b)+(c) is what makes it
    // deterministic — without the explicit denial the model still grabs
    // browser on URL-shaped inputs.
    //
    // Routing decision — three branches, picked by sessionKey + context:
    //   1. Doc-scoped session (`agent:<id>:doc:<type>:<docId>`) AND a
    //      registered DocScope → buildDocLiveActionPreamble. Doc voice
    //      sessions IGNORE any gridContext the client might still ship —
    //      a stale UI bundle could send it, but the doc-scoped agent must
    //      stay focused on its document. Log a breadcrumb when this
    //      happens so a future "doc voice used grid prompt" report has
    //      something to trace.
    //   2. liveAction + gridContext + injection allowed → grid preamble.
    //   3. liveAction (everything else) → generic ui_control preamble.
    const isDocScopedSession = /^agent:[^:]+:doc:[^:]+:/.test(sessionKey);
    const docScope = isDocScopedSession ? getDocScopeForSession(sessionKey) : null;
    const docModalities = isDocScopedSession ? getDocModalitiesForSession(sessionKey) : null;

    // Voice gate: a doc-scoped session can have voice OFF via
    // doc_agent.set_modalities. If so, refuse the stream with a clear
    // error so the UI's voice toggle can show the failure instead of
    // silently dispatching turns the agent shouldn't be answering.
    if (isDocScopedSession && docModalities && docModalities.voice === false) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "voice modality is disabled for this doc-scoped session",
          sessionKey,
        }),
      );
      return true;
    }

    if (isDocScopedSession && liveActionMode && gridContext) {
      console.log(
        `[VoiceChatStream] doc-scoped session ${sessionKey} received gridContext from client — ignoring (using doc preamble)`,
      );
    }

    // ── Voice fast-path decision ─────────────────────────────────────────
    // A purely conversational turn doesn't need the full tool-capable agent.
    // Running it LLM-only skips serializing every tool schema into the system
    // prompt (the dominant prefill cost on the 128k-window local voice models)
    // and skips the agentic tool round-trip before the model speaks. We only
    // take it when we're confident no tool is needed — live-action, doc-scoped,
    // attachment (vision), or any task/data/self-reference utterance keeps the
    // full path so data/action questions are still answered with real tools.
    const voiceFastPath =
      !liveActionMode &&
      !isDocScopedSession &&
      materialized.paths.length === 0 &&
      !voiceTurnNeedsTools(message);
    console.log(
      `[VoiceChatStream] path=${voiceFastPath ? "fast(no-tools)" : "full(agent)"} ` +
        `msg="${message.slice(0, 60)}"`,
    );

    const useDocPreamble = isDocScopedSession && docScope !== null && liveActionMode;
    const useGridPreamble =
      !useDocPreamble &&
      liveActionMode &&
      gridContext !== null &&
      (gridContext.injectionMode === undefined ||
        gridContext.injectionMode === "grid" ||
        gridContext.injectionMode === "custom");

    if (liveActionMode && gridContext && !useDocPreamble) {
      console.log(
        `[VoiceChatStream] grid context: ${gridContext.panels.length} panels, voice=${gridContext.activeVoicePanelId ?? "<none>"}, mode=${gridContext.injectionMode ?? "grid"}`,
      );
    }

    const liveActionPreamble = useDocPreamble
      ? buildDocLiveActionPreamble(docScope!)
      : useGridPreamble
        ? buildGridLiveActionPreamble(gridContext as GridContext)
        : liveActionMode
          ? [
              "[Live Action Mode is ON — your tool calls drive the InfiniBot UI the user is watching in real time]",
              "The user has the InfiniBot app open and a Live Action sidebar engaged. Your tool calls dispatch INTO that running UI. They are NOT browsing the web. There is no separate Firefox or Chrome window to open — the UI is already in front of them.",
              "REQUIRED tool: `ui_control`. Workflow: call `ui_control` action='list_views' once to discover what's available, then action='dispatch' { view, op, args } to act. The browser instance that responds is the user's own UI.",
              "FORBIDDEN this turn:",
              "  • The `browser` tool (Chrome relay / navigate / open).",
              "  • The `mcp` tool with action='invoke' targeting a browser MCP — never call `playwright`, `browsermcp`, `browser-use`, `puppeteer`, etc., and never invoke a tool whose name starts with `browser_` or is `navigate`/`goto`.",
              "  • The `hyprland_launch` tool (or any tool that spawns a process) to start firefox/chromium/chrome/brave/edge/vivaldi/opera/xdg-open/open/start with a URL — that is still launching a browser, just by a different path.",
              "  • The `exec` / `process` / shell tools when the command would launch a browser — never run `firefox`, `xdg-open`, `chromium`, `google-chrome`, `open <url>`, `start <url>`, or similar.",
              '  • Speaking or returning URLs (no "localhost:18789/...", no "go to /projects"). You are NOT giving directions to a website; you are operating the UI directly.',
              "  • Asking for a password — the UI is already authenticated in front of the user. Just act.",
              "Mapping common requests:",
              '  • "Open my X page" / "take me to X" / "where is X"  →  ui_control { action:"navigate", query:"X" } (or target:"<id>" from find_targets). It opens nested places too: host sub-tabs, plugin pages, settings sections, modals.',
              '  • "Show me where / which button …"   →  ui_control { action:"highlight", query:"…", text:"<what to do there>" } — draws a live gold highlight with your callout on their screen. Multi-step how-tos → action:"guide" { steps:[…] }.',
              '  • "Open the X project"               →  ui_control dispatch { view:"kanban", op:"select_project", args:{ projectId:"..." } }. If you do not know the id, first dispatch op:"refresh" then op:"set_gallery_search" with the project name to surface it.',
              '  • "Search for X" / "find X"          →  ui_control dispatch the search action on whatever view is active (e.g. kanban set_gallery_search, notes set_search, etc.).',
              "If `ui_control` returns ok:false saying no browser is connected, the user's sidebar is not actually live — say so briefly and stop. Do NOT fall back to `browser` or `exec firefox` as a substitute.",
              "",
            ]
          : [];

    // Voice-mode turn preamble — steers the model toward short, speakable
    // replies and forces narration around every tool call so the user hears
    // *what* the agent is about to do while it happens (each narration line
    // hits TTS on the next sentence boundary, before the tool result comes
    // back). Prepended to each inbound voice turn.
    //
    // The "Voice mode style" block enforces TTS-safe output (no markdown, no
    // typographic punctuation, no smart quotes / em-dashes / ellipsis) for
    // defense-in-depth. Kokoro's pre-synthesis pass does strip some markdown
    // server-side, but the model is still asked to avoid it here because clean
    // text also surfaces in the Live Action transcript and sub-agent logs.
    //
    // Extra emphasis on between-step beats and progress updates for long
    // tasks — the previous version still left ~30s gaps during multi-step
    // tool chains where the LLM thought silently between calls.
    // Repo root is the canonical cwd for tool-spawned shells in voice mode.
    // Stating it explicitly in the preamble helps the model avoid asking
    // "what's my working directory?" or running pwd as a first step — common
    // failure mode that wastes a TTS-narrated tool call.
    const repoRoot = (await import("../config/paths.js")).resolveRepoRoot();

    // Layer-1 operator context for the ACTIVE profile (role / goals / languages
    // / notes), prepended above everything so the voice agent always carries
    // the user's context. Empty string when no operator context is set — then
    // nothing is injected (single-profile installs unaffected).
    const profileContextBlock = buildActiveProfileContextBlock();

    const voicePreamble = [
      ...(profileContextBlock ? [profileContextBlock, ""] : []),
      ...liveActionPreamble,
      // ── Voice mode style / Speakable replies ─────────────────────────────
      "[Voice mode style - Speakable replies]",
      "You are responding in a live voice call. Kokoro TTS will read your words aloud. Follow every rule below for ALL output: replies, narration beats, and summaries.",
      "",
      "CONTENT:",
      "- Max 3 short conversational sentences per reply unless the user explicitly asks for detail.",
      "- No filler openers: skip 'Sure!', 'Great!', 'Of course!', 'Here is...' and start with the substance.",
      "- Confirm actions concisely: 'Done. Build passed.' not 'I have successfully completed the build for you!'",
      "- No parenthetical asides; if context is needed, fold it into the sentence.",
      "",
      "FORMATTING - critical for Kokoro TTS (it reads symbols as literal characters):",
      "- NO markdown in your output: no **bold**, no _italic_, no # headings, no bullet lists with -, no numbered lists, no tables, no code fences, no inline backticks.",
      "- When mentioning a command or path, say it in plain words: say 'run npm run build' not the backtick-quoted form.",
      "- NO typographic punctuation: use only straight ASCII. Never output curly apostrophes, curly quotes, em-dashes, en-dashes, or the Unicode ellipsis character. Use a plain hyphen instead of a dash; use plain '...' (three dots, sparingly) instead of the ellipsis symbol.",
      "- No emoji, no ASCII art, no decorative symbols.",
      "",
      "NUMBERS AND ABBREVIATIONS:",
      "- Spell small numbers as words: 'three files', 'forty-two seconds'. Keep large numbers numeric when cleaner: 'twelve thousand lines'.",
      "- Spell out abbreviations TTS mangles. 'GitHub' and 'API' are fine for technical users. Prefer 'link' or 'address' over 'URL' when context is non-technical.",
      "",
      "NARRATION - speak first, no silent tool calls:",
      '- Before EVERY tool call, emit one short natural sentence: e.g. "Let me check your screen." "One moment, pulling that up." "Reading that file now." Never call a tool silently.',
      '- After a tool returns and before the next call, briefly say what you found or what comes next: e.g. "Got it, found the project." "That file is large, skimming now." "Okay, three options here, picking the right one."',
      '- On multi-step work (3 or more tools), give a brief progress beat every 2 to 3 calls: "Still on it, about halfway." "Almost done, one more step."',
      '- Casual fillers welcome: "Hmm", "Got it", "One sec", "Okay". Sounds human, fills micro-gaps.',
      "- After the final tool, summarize in 1 to 3 sentences. Do not repeat earlier narration verbatim.",
      "",
      // ── Voice response discipline (task requests) ────────────────────────
      // Voice runs the full agent with tools but a tiny context budget. Keep
      // it answering the actual question and reporting tool results as short
      // summaries — never dumping a full dataset back, which blows the prompt.
      "[Voice response discipline]",
      "- Answer the actual question directly and briefly: one to three sentences unless the user explicitly asks for detail.",
      "- When the user asks for data (projects, tasks, revenue, status, counts), CALL the appropriate tool and report the result concisely. Do not guess or answer from memory.",
      "- If a tool returns a lot, summarize it: give the count plus the top few items by name, not the whole list. Example: 'You have twelve in-progress projects. The top three are Alpha, Beta, and Gamma. Want the rest?'",
      "- Never ramble about identity, resonance, or your persona during a task request. Just do the task and report back.",
      "",
      // Orchestrator role — fast spoken replies, delegate medium/heavy work to
      // background sub-agents, stay open for more dialogue, guard parallel work.
      // Shared with the mobile voice path (single source of truth).
      ...VOICE_ORCHESTRATOR_LINES,
      "",
      ...voiceProductMapLines(),
      "",
      "[Tool execution context]",
      `- Your terminal / exec / process / claude_coder tools spawn at: ${repoRoot}. That's the InfiniBot repo root. Default to that when you need a cwd — don't ask, don't \`pwd\`, just act.`,
      "- Read/write/edit tools resolve relative paths against the same root. Use relative paths like `src/...` and `ui/src/ui/...` for repo files.",
      "- For multi-file or build-shaped work, prefer `claude_coder` over chains of `exec` — it spins up a focused sub-agent and reports back via subagent progress, so you can keep talking to the user while it works.",
      "- Desktop control: `ui_control` drives the running UI (tabs, panels, kanban, notes). `hyprland_*` tools drive the host window manager (focus, capture, launch, pick). Prefer `ui_control` when the action is inside InfiniBot; reach for `hyprland_*` only for system-level windows (other apps, screenshots, picking a window).",
      "- If a tool returns ok:false with a context-mismatch reason (no UI connected, no permission, file not found), DON'T retry with a different tool that has the same precondition. Say what's missing in one sentence and stop.",
      "",
      "User said:",
      message || "(no text — see attached images)",
      ...(materialized.paths.length > 0
        ? [
            "",
            `[User attached ${materialized.paths.length} image${materialized.paths.length === 1 ? "" : "s"}: ${materialized.names.join(", ")}]`,
            "These were saved to local paths and surfaced as MediaPaths on this turn — read them with your vision/screen tools when relevant.",
          ]
        : []),
    ].join("\n");

    const agentMessage = voicePreamble;

    // Set up SSE headers
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const sendEvent = (data: object) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    // Load Session. `entry` may be undefined the first time the user
    // joins agent mode on a fresh install — there's no `agent:main:voice`
    // row in the session store yet. The dispatch path doesn't read
    // `entry` directly (it derives from `cfg` + `ctx.SessionKey`) so
    // we don't fail here, but we log it so a future "voice mode silent"
    // report has a breadcrumb instead of looking like a hang.
    const { cfg, entry } = loadSessionEntry(sessionKey);
    if (!entry) {
      console.log(
        `[VoiceChatStream] No prior session entry for ${sessionKey} — first message will create it.`,
      );
    }
    const runId = randomUUID();

    // Surface the runId as the FIRST SSE event so the LiveKit voice agent can
    // capture it and later cancel this exact run on barge-in
    // (POST /api/voice/chat/cancel). The browser web-voice client only reads
    // events that carry a `text` field, so an id-only event is ignored there —
    // fully backward-compatible with the existing web-voice SSE path.
    sendEvent({ runId });

    // Build Context — BodyForAgent carries the voice preamble so the LLM
    // sees the style directives, but RawBody / CommandBody keep the clean
    // user utterance for anything that logs or key-matches on content.
    const ctx: MsgContext = {
      Body: agentMessage,
      BodyForAgent: agentMessage,
      BodyForCommands: message,
      RawBody: message,
      CommandBody: message,
      SessionKey: sessionKey,
      Provider: INTERNAL_MESSAGE_CHANNEL,
      Surface: INTERNAL_MESSAGE_CHANNEL,
      OriginatingChannel: INTERNAL_MESSAGE_CHANNEL,
      ChatType: "direct",
      CommandAuthorized: true,
      MessageSid: runId,
      SenderId: "voice-user",
      SenderName: "Voice User",
      SenderUsername: "voice-user",
    };
    if (materialized.paths.length > 0) {
      // Existing media pipeline ingests MediaPaths/MediaTypes — vision-capable
      // agents see the images as attached media, terminal-only agents see a
      // textual hint via the appended note below.
      ctx.MediaPaths = materialized.paths;
      ctx.MediaTypes = materialized.types;
      ctx.MediaPath = materialized.paths[0];
      ctx.MediaType = materialized.types[0];
      console.log(
        `[VoiceChatStream] Persisted ${materialized.paths.length} attachment(s) for ${sessionKey} → ${materialized.paths.join(", ")}`,
      );
    }

    let agentId = resolveSessionAgentId({
      sessionKey: sessionKey,
      config: cfg,
    });

    // VOICE-SCOPED AI-EMPLOYEE ROUTING.
    // The browser voice terminal encodes the selected AI-employee into the
    // LiveKit room name as `voice-emp_<enc>-<uuid>`, and the Python voice-agent
    // derives its gateway sessionKey as `agent:voice:<room.name>`. So a routed
    // voice session arrives here as `agent:voice:voice-emp_<enc>-<uuid>`, where
    // <enc> is the selected agent id sanitized to [A-Za-z0-9_]. We match <enc>
    // against configured agent ids sanitized the SAME way and, on a hit, run the
    // live conversation as THAT agent. This override ONLY touches voice sessions
    // carrying the marker — every other path keeps the resolved default.
    {
      const voiceEmpMatch = /^agent:voice:voice-emp_(.+)-[0-9a-fA-F-]{36}$/.exec(
        String(sessionKey),
      );
      if (voiceEmpMatch) {
        const enc = voiceEmpMatch[1];
        const sanitize = (id: string) => id.replace(/[^A-Za-z0-9]/g, "_");
        const matched = listAgentIds(cfg).find((id) => sanitize(normalizeAgentId(id)) === enc);
        if (matched) {
          const routedId = normalizeAgentId(matched);
          if (routedId !== agentId) {
            console.log(`[VoiceChatStream] routing voice → agent ${routedId}`);
          }
          agentId = routedId;
        }
      }
    }

    let prefixContext: ResponsePrefixContext = {
      identityName: resolveIdentityName(cfg, agentId),
    };

    // Buffer for accumulating text
    let buffer = "";
    let sentenceCount = 0;
    // Track whether ANY real (non-heartbeat) spoken text reached the client
    // this turn. A tool-only turn (agent runs tools, emits no narration/final
    // text) would otherwise finish in silence — we backstop it with a spoken
    // confirmation below. `dispatchErrored` suppresses that backstop when the
    // turn failed (the error is surfaced separately), so we never say "done"
    // over a failure.
    let emittedRealText = false;
    let dispatchErrored = false;

    // Chunk at phrase boundaries, not just sentence boundaries, so TTS can
    // start speaking before the model has finished the full sentence.
    // - Hard breaks (.!?): always split.
    // - Soft breaks (,;:—–): only split if the pending phrase is long
    //   enough to be worth speaking on its own (avoids micro-chunks like
    //   "Yes," going to Kokoro as their own synthesis call).
    const HARD_BREAK = /[.!?]/;
    const SOFT_BREAK = /[,;:—–]/;
    const MIN_PHRASE_CHARS = 24;
    // The FIRST chunk of a turn drives time-to-first-audio, so flush it on a
    // shorter opening clause ("Let me see," / "Okay, so,") instead of waiting
    // for a full 24-char phrase. Later chunks keep the larger threshold to
    // avoid choppy micro-synthesis calls to TTS.
    const FIRST_PHRASE_CHARS = 12;

    // Detach-mode claude_coder spawn receipts arrive as the literal tool-result
    // JSON when the agent's only "reply" was a claude_coder.spawn call (no
    // narration). Replacing the buffer with a spoken ack stops TTS from
    // reading raw JSON aloud and gives the user a runId reference. Subagent
    // progress updates arrive on a separate channel and are still spoken
    // when they fire.
    const isCoderSpawnReceipt = (s: string): boolean =>
      /"status"\s*:\s*"accepted"/.test(s) &&
      /"mode"\s*:\s*"detach"/.test(s) &&
      /"runId"\s*:\s*"coder-[A-Za-z0-9_-]+"/.test(s);

    const flushChunks = (final: boolean) => {
      // Intercept claude_coder spawn-receipt JSON before any TTS chunking.
      // Done here (not in deliver) so partial-streamed JSON only triggers
      // once the full receipt has accumulated.
      if (isCoderSpawnReceipt(buffer)) {
        const m = buffer.match(/"runId"\s*:\s*"(coder-[A-Za-z0-9_-]+)"/);
        const ref = m ? m[1].slice(-6) : "started";
        console.log(`[VoiceChatStream] claude_coder receipt intercepted (ref=${ref})`);
        buffer = `On it — I'll let you know when that's done. Reference ${ref}.`;
      }

      let i = 0;
      let chunkStart = 0;
      while (i < buffer.length) {
        // Need i+1 to know the next char isn't a digit (avoids splitting
        // "3.14" or "1,000") — bail if we don't have it yet.
        if (!final && i + 1 >= buffer.length) break;

        const c = buffer[i];
        const next = i + 1 < buffer.length ? buffer[i + 1] : "";
        const nextIsBoundary = next === "" || /\s/.test(next);
        const phraseLen = i + 1 - chunkStart;

        const minPhrase = sentenceCount === 0 ? FIRST_PHRASE_CHARS : MIN_PHRASE_CHARS;
        let isBreak = false;
        if (HARD_BREAK.test(c) && nextIsBoundary) {
          isBreak = true;
        } else if (SOFT_BREAK.test(c) && nextIsBoundary && phraseLen >= minPhrase) {
          isBreak = true;
        }

        if (isBreak) {
          const chunk = buffer.slice(chunkStart, i + 1).trim();
          if (chunk) {
            sentenceCount++;
            emittedRealText = true;
            console.log(`[Stream] Chunk ${sentenceCount}: ${chunk.slice(0, 50)}...`);
            sendEvent({ text: chunk, index: sentenceCount });
          }
          chunkStart = i + 1;
        }
        i++;
      }

      buffer = buffer.slice(chunkStart);

      if (final && buffer.trim()) {
        sentenceCount++;
        emittedRealText = true;
        sendEvent({ text: buffer.trim(), index: sentenceCount, final: true });
        buffer = "";
      }
    };

    // Heartbeat: if the LLM goes silent for >HEARTBEAT_GAP_MS (e.g. during a
    // long tool call), emit a short filler so the user hears the agent is
    // still alive. Cycles through a few options to feel less canned. Stops
    // once the dispatch completes.
    let lastDeliveryAt = Date.now();
    const HEARTBEAT_GAP_MS = 6000;
    const HEARTBEAT_FILLERS = [
      "Still working on it.",
      "One moment.",
      "Almost there.",
      "Still going.",
      "Hang tight.",
    ];
    let heartbeatIdx = 0;
    const heartbeatTimer = setInterval(() => {
      const idleMs = Date.now() - lastDeliveryAt;
      if (idleMs < HEARTBEAT_GAP_MS) return;
      const filler = HEARTBEAT_FILLERS[heartbeatIdx % HEARTBEAT_FILLERS.length];
      heartbeatIdx++;
      sentenceCount++;
      sendEvent({ text: filler, index: sentenceCount, heartbeat: true });
      lastDeliveryAt = Date.now();
    }, 2000);

    const dispatcher = createReplyDispatcher({
      responsePrefix: resolveEffectiveMessagesConfig(cfg, agentId).responsePrefix,
      responsePrefixContextProvider: () => prefixContext,
      onError: (err) => {
        dispatchErrored = true;
        console.warn(`[VoiceChatStream] dispatch failed: ${formatForLog(err)}`);
        sendEvent({ error: String(err) });
        // Speak a short apology so a dispatch failure isn't dead air — the
        // raw `error` event only shows in the transcript/log, not TTS.
        sentenceCount++;
        sendEvent({
          text: "Sorry, I hit an error handling that. Please try again.",
          index: sentenceCount,
          final: true,
        });
      },
      deliver: async (payload, info) => {
        const text = payload.text?.trim() ?? "";
        if (!text) return;
        // Real LLM chunk arrived — reset the heartbeat clock so we don't
        // talk over the model.
        lastDeliveryAt = Date.now();
        buffer += text;
        flushChunks(info.kind === "final");
      },
    });

    const abortController = new AbortController();
    // Register this run so a barge-in on the LiveKit side can abort the
    // dispatch by runId via cancelVoiceRun() (see cancel endpoint above).
    voiceRunAbortControllers.set(runId, abortController);

    // Handle client disconnect
    req.on("close", () => {
      console.log("[VoiceChatStream] Client disconnected");
      abortController.abort();
      voiceRunAbortControllers.delete(runId);
      clearInterval(heartbeatTimer);
    });

    // Record live-action mode for this session BEFORE we dispatch. The
    // tool-builder (src/agents/pi-tools.ts) reads it keyed by sessionKey;
    // it survives the command-queue boundary that ALS would lose.
    setLiveActionForSession(sessionKey, liveActionMode);

    // Grid context shares the same lifecycle: write it when live-action is on
    // (so grid:* verbs can resolve panel ids even with injectionMode:"default"),
    // and clear it the moment live-action flips off so a future non-grid turn
    // can't see stale panel state.
    //
    // Doc-scoped sessions: NEVER store grid context (we've already chosen
    // the doc preamble above), so any downstream prompt builder that reads
    // gridContextBySession sees `null` and can't accidentally inject panel
    // inventory into a per-document agent.
    if (isDocScopedSession) {
      setGridContextForSession(sessionKey, null);
    } else if (liveActionMode && gridContext) {
      setGridContextForSession(sessionKey, gridContext);
    } else {
      setGridContextForSession(sessionKey, null);
    }

    // ── Voice routing branch ──────────────────────────────────────
    // The persisted voice_route setting (gateway_agent | claude_code |
    // opencode | codex) decides who handles the transcript. The browser
    // UI normally takes the CLI path locally (terminal.write), so the SSE
    // endpoint mostly serves gateway_agent traffic — but headless clients,
    // the mobile bridge, or a stale UI bundle can still land here with the
    // route flipped. Honor the setting: any non-gateway_agent route → spawn
    // a CLI coding sub-agent in detach mode with the transcript as the task,
    // gateway_agent → fall through to the normal dispatch loop.
    const voiceRoute = getVoiceRoute();
    if (voiceRoute !== "gateway_agent") {
      try {
        const coder = createClaudeCoderTool({ agentId });
        // Per-call backend override: surfaces with the universal
        // <agent-cli-selector> pass a CoderBackendId in `data.backend`.
        // Falls back to the configured default when omitted/invalid.
        const reqBackend = isCoderBackendId(data.backend) ? data.backend : undefined;
        const spawnResult = (await coder.execute(`voice-${runId}`, {
          task: message,
          mode: "detach",
          ...(reqBackend ? { backend: reqBackend } : {}),
        })) as { content?: Array<{ text?: string }> } | undefined;
        // Surface a single SSE chunk so the voice loop has something to
        // speak / log. The actual claude-code work continues async; the
        // subagent-progress system tracks it from here on.
        const rawSummary =
          spawnResult?.content?.[0]?.text ??
          "Spawned Claude Code sub-agent for your request. Track its progress in the Subagents tab.";
        // Replace the raw spawn-receipt JSON with a spoken acknowledgement
        // — same intercept the gateway_agent path uses inside flushChunks.
        // Without this, TTS would read the JSON keys/punctuation aloud.
        let summary = rawSummary;
        if (isCoderSpawnReceipt(rawSummary)) {
          const m = rawSummary.match(/"runId"\s*:\s*"(coder-[A-Za-z0-9_-]+)"/);
          const ref = m ? m[1].slice(-6) : "started";
          console.log(`[VoiceChatStream] claude_coder receipt intercepted (ref=${ref})`);
          summary = `On it — I'll let you know when that's done. Reference ${ref}.`;
        }
        sentenceCount++;
        sendEvent({ text: summary, index: sentenceCount, final: true });
      } catch (err) {
        sendEvent({
          error: `claude_code voice route failed: ${(err as Error).message ?? String(err)}`,
        });
      } finally {
        clearInterval(heartbeatTimer);
        voiceRunAbortControllers.delete(runId);
      }
      res.write("data: [DONE]\n\n");
      res.end();
      return true;
    }

    try {
      await dispatchInboundMessage({
        ctx,
        cfg,
        dispatcher,
        replyOptions: {
          runId: runId,
          abortSignal: abortController.signal,
          disableBlockStreaming: false, // Enable streaming
          // Fast-path: LLM-only turn (no tool schemas in the prompt, no skills)
          // for conversational utterances → much lower time-to-first-token.
          disableTools: voiceFastPath,
          ...(voiceFastPath ? { skillFilter: [] } : {}),
          onModelSelected: (ctx) => {
            prefixContext.provider = ctx.provider;
            prefixContext.model = extractShortModelName(ctx.model);
            prefixContext.modelFull = `${ctx.provider}/${ctx.model}`;
            prefixContext.thinkingLevel = ctx.thinkLevel ?? "off";
          },
        },
      });
    } finally {
      clearInterval(heartbeatTimer);
      voiceRunAbortControllers.delete(runId);
    }

    // Send any remaining buffer
    if (buffer.trim()) {
      sentenceCount++;
      emittedRealText = true;
      sendEvent({ text: buffer.trim(), index: sentenceCount, final: true });
    }

    // Tool-only / silent-turn backstop: if the agent completed without ever
    // emitting speakable text (e.g. it only ran tools and returned no
    // narration or final reply) AND didn't error, speak a short confirmation
    // so the user always hears the turn finish instead of dead air. Heartbeat
    // fillers don't set emittedRealText, so a turn that only heartbeated still
    // gets a proper closing line here.
    if (!emittedRealText && !dispatchErrored) {
      sentenceCount++;
      console.log("[VoiceChatStream] silent turn — emitting spoken backstop");
      sendEvent({
        text: "Okay, that's done.",
        index: sentenceCount,
        final: true,
      });
    }

    // Send done signal
    res.write("data: [DONE]\n\n");
    res.end();

    return true;
  } catch (err: any) {
    console.error("[VoiceChatStream] Error:", err.message);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error" }));
    }
    return true;
  }
}
