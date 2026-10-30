/**
 * ui_control — single agent tool that drives the InfiniBot browser UI in
 * real time.
 *
 * Verbs:
 *   list_views   — enumerate all registered views, with descriptions and
 *                  the actions each view accepts. The agent should call
 *                  this once per session to learn the UI surface.
 *   get_state    — read the current observable state of one view.
 *   dispatch     — execute an action against a view. Action shapes are
 *                  view-specific; consult list_views first.
 *   list_tabs    — enumerate visible UI tabs across addressable clients.
 *   set_label    — set the user-visible label for a UI tab pill.
 *   focus_tab    — focus a specific UI tab/window.
 *   navigate / highlight / clear_highlight / guide / back / open_panel /
 *   open_modal / find_targets / list_targets
 *                — universal navigation + live highlighting over the UI
 *                  target registry (src/ui-targets, src/gateway/ui-guide.ts).
 *                  Delivered to the user's own active tab only.
 *
 * Local routing happens in-process; pass `node` to route the same action to
 * another federation node through ui_control.invoke.
 */

import fs from "node:fs/promises";
import path from "node:path";

import { Type } from "@sinclair/typebox";

import { resolveStateDir } from "../../config/paths.js";

import { invokeUIControlAction } from "../../gateway/server-methods/ui-control.js";
import { GUIDE_ACTIONS } from "../../gateway/ui-guide.js";
import { stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, imageResult, jsonResult } from "./common.js";
import { OVERLAY_ACTIONS, handleOverlayAction, isOverlayAction } from "./ui-control-overlay.js";
import { coerceString } from "../../shared/text/coerce.js";

const UIControlSchema = Type.Object({
  action: stringEnum([
    "list_views",
    "list_clients",
    "list_tabs",
    "set_label",
    "focus_tab",
    "get_state",
    "dispatch",
    "list_nodes",
    "list_windows",
    "screenshot",
    "window_state",
    "mirror",
    "capabilities",
    "audit",
    ...GUIDE_ACTIONS,
    ...OVERLAY_ACTIONS,
  ]),
  target: Type.Optional(
    Type.String({
      description:
        "navigate/highlight/open_panel: a UI target id from the registry (e.g. 'plugin:solatrix/settings/agent-access', 'control:solatrix/agent-access/mode', 'page:plugins', 'control:topbar/chat', 'nav:sidebar/mesh', 'setup-check:models'), a tab id ('apikeys'), or a route ('/setup?view=coders').",
    }),
  ),
  query: Type.Optional(
    Type.String({
      description:
        "navigate/highlight/find_targets: the user's own words when you don't know the id ('where do I turn on solatrix trading'). Resolved with a confidence; ambiguous → candidates come back instead of a guess.",
    }),
  ),
  text: Type.Optional(
    Type.String({
      description:
        "highlight: the callout shown next to the element, in your voice ('Set this to Read-only').",
    }),
  ),
  style: Type.Optional(
    stringEnum(["pulse", "spotlight", "outline", "arrow"], {
      description:
        "highlight: pulse (default, glowing ring), spotlight (dims the rest), outline (quiet), arrow (bouncing pointer).",
    }),
  ),
  durationMs: Type.Optional(
    Type.Number({
      description:
        "highlight: auto-dismiss after this many ms (default 20000; 0 = until the user dismisses).",
    }),
  ),
  steps: Type.Optional(
    Type.Array(
      Type.Object(
        {
          target: Type.Optional(Type.String()),
          query: Type.Optional(Type.String()),
          route: Type.Optional(Type.String()),
          text: Type.Optional(Type.String()),
          title: Type.Optional(Type.String()),
          style: Type.Optional(stringEnum(["pulse", "spotlight", "outline", "arrow"])),
          advance: Type.Optional(
            stringEnum(["next", "click", "auto"], {
              description:
                "next (user presses Next, default) · click (advances when the user clicks the highlighted control) · auto (after durationMs).",
            }),
          ),
          durationMs: Type.Optional(Type.Number()),
        },
        { additionalProperties: false },
      ),
      { description: "guide: ordered walkthrough steps (max 12)." },
    ),
  ),
  scope: Type.Optional(
    stringEnum(["active", "all"], {
      description:
        "'active' (default) = only the tab the user is chatting from / using; 'all' = every open tab of this user (only when they ask). Applies to dispatch/get_state/list_views and navigation/guide actions.",
    }),
  ),
  node: Type.Optional(
    Type.String({
      description:
        "Federation node that owns the target window: a node id or its name (e.g. 'laptop', 'master'). Omit for this node. Every action (navigate, dispatch, get_state, screenshot, focus_tab…) is forwarded there and answers exactly as it would locally. 'all' with list_tabs = every node.",
    }),
  ),
  source: Type.Optional(
    Type.Object(
      {
        node: Type.Optional(
          Type.String({ description: "Node of the screen to show (omit = this node)." }),
        ),
        tab: Type.String({ description: "Window codename/label of the screen to show." }),
      },
      {
        description:
          "mirror: which screen to display. The window chosen by node+tab gets a live view of source.node/source.tab.",
      },
    ),
  ),
  view: Type.Optional(
    Type.String({ description: "View name (snake_case). Required for get_state and dispatch." }),
  ),
  op: Type.Optional(
    Type.String({
      description:
        "Specific action to dispatch (e.g. 'select_card', 'send_message', 'open_modal'). Required for dispatch. Run list_views first to discover the actions each view supports.",
    }),
  ),
  args: Type.Optional(
    Type.Object({}, { additionalProperties: true, description: "Action arguments (object)." }),
  ),
  timeoutMs: Type.Optional(
    Type.Number({ description: "Override the default 10s wait for the browser response." }),
  ),
  instanceId: Type.Optional(
    Type.String({
      description:
        "Target a browser tab by client instance id (UUID from list_clients). If duplicated tabs share the id, the focused/most-recently-used match is selected; prefer connId for an exact tab.",
    }),
  ),
  connId: Type.Optional(
    Type.String({
      description:
        "Target a specific browser tab by WebSocket connection id from list_tabs/list_clients.",
    }),
  ),
  tab: Type.Optional(
    Type.String({
      description:
        "Voice-friendly tab handle. Accepts NATO phonetic codenames like 'Alpha', 'Bravo', or with disambiguation 'Alpha-2'. Listed in ui.list_clients output and visible in each window's title bar (e.g. '[Alpha] InfiniBot — Master Terminal'). Easier to use than raw instanceId in voice flows.",
    }),
  ),
  label: Type.Optional(
    Type.String({
      description: "User-visible label for action='set_label'. Empty labels are rejected.",
    }),
  ),
  routing: Type.Optional(
    stringEnum(["first", "active"], {
      description:
        "'active' (default) targets the tab bound to this chat session, then the focused/most-recently-used tab. 'first' targets only the first connected tab. Use tab/connId for an exact tab, or scope='all' only when the user explicitly wants every tab changed.",
    }),
  ),
});

export function createUIControlTool(opts: { agentSessionKey?: string } = {}): AnyAgentTool {
  return {
    label: "UI Control",
    name: "ui_control",
    description: [
      "Drive the InfiniBot browser UI in real time. The browser registers per-view controllers on a UIControlBus; this tool sends RPC over the gateway and returns structured responses.",
      "Workflow:",
      "  1. action='list_views' AT THE START OF EVERY TASK. The action set evolves — older list_views answers from earlier in this conversation are stale and missing newer verbs (open_by_name, find_*, run_by_name, spawn_session, etc.). Do NOT rely on memory; re-list_views before deciding what a view can do.",
      "  2. action='get_state' { view } to read what the user is currently looking at (selected items, open modals, loaded data).",
      "  3. action='dispatch' { view, op, args } to take an action — open a modal, send a message, move a card, switch tabs, fill a form.",
      "  4. action='list_tabs' lists user-visible UI tab pills. action='set_label' changes a pill label. action='focus_tab' focuses a tab.",
      "If a dispatch returns `unknown action: X`, that does NOT mean the view doesn't support X — it may mean the *responding* browser tab is running an older bundle. Call list_views again to get the authoritative action list, then retry.",
      "Pass timeoutMs to override the default 10s wait.",
      "FEDERATION (other devices) — every window is addressed as node + tab, e.g. node='laptop', tab='Foxtrot' (or tab='laptop/Foxtrot'):",
      "  • action='list_windows' → every window on every connected node (node, nodeName, codename/label, route, focused, lastSeenAt) plus per-node online/version/latencyMs. action='list_nodes' → just the nodes.",
      "  • Any action with node set runs on that node exactly as locally: { action:'navigate', node:'laptop', tab:'Foxtrot', route:'/research' }, { action:'dispatch', node:'laptop', tab:'Foxtrot', view:'grid', op:'list_panels' }, { action:'get_state', node:'laptop', view:'whiteboard' }.",
      "  • action='screenshot' { node?, tab? } → the window's current screen as an image (saved to a file). action='window_state' → its route/title/size.",
      "  • action='mirror' { node, tab, source:{ node, tab } } shows source's screen live inside node/tab (e.g. show the master's Research page on the laptop's Foxtrot window).",
      "  • code NODE_UPDATE_REQUIRED → that node runs an older build; tell the user and offer `update` (federation.node.update) — never run it without their go-ahead. NODE_UNREACHABLE → the node is offline.",
      "MULTI-MONITOR TARGETING (in priority order):",
      "  • tab='Alpha' — voice-friendly handle. Every connected InfiniBot tab is auto-assigned a NATO phonetic codename (Alpha, Bravo, Charlie...) visible in its window title bar and in ui.list_clients. Best for natural language: user says \"open notes on Bravo\" → pass tab='Bravo'. Collisions get suffixes: 'Alpha-2', 'Alpha-3'.",
      '  • routing=\'active\' (the default) — target the tab bound to this chat session, then the focused/most-recently-used tab. Best when the user implies "this screen" / "the page I\'m looking at" without naming a tab.',
      "  • instanceId='<uuid>' — explicit raw UUID from list_clients. Use when you've already resolved the target programmatically.",
      "  • with none of the above, exactly one active tab is selected. Ordinary dispatches such as nav.switch_tab and nav.open_page never mirror across tabs unless scope='all' is explicit.",
      "If no browser is connected, the tool returns ok=false with a clear message — open the InfiniBot web UI to enable agent-driven UI control.",
      'Grid panels: dispatch { view: "grid", op: "list_panels"|"refresh_panel"|"scroll_panel"|"focus_panel"|"add_panel"|"remove_panel"|"edit_in_panel"|"get_panel_state"|"list_voice_panels"|"set_voice_injection_mode" } — run list_views first to see the full per-op args.',
      "",
      "SHOWING THE USER WHERE THINGS ARE (use these instead of describing click-paths from memory — never invent menus like 'gear → Settings'):",
      "  • action='find_targets' { query:'where do I add an API key' } → ranked UI targets (id, title, route, available). action='list_targets' { args:{ kind?, plugin?, prefix? } } lists the registry.",
      "  • action='navigate' { target | query | route } opens the exact page / host sub-tab / plugin page / settings section / modal and reports the final route. Example: { action:'navigate', target:'plugin:solatrix/settings/agent-access' }.",
      "  • action='highlight' { target | query, text, style? } reveals the element (navigating, opening sub-tabs/sections/modals as needed) and draws a live gold highlight with a callout carrying your name. Example: { action:'highlight', target:'control:solatrix/agent-access/mode', text:'Set this to Read-only' }. Example: { action:'highlight', query:'chart source switch', text:'Switch the data source here', style:'arrow' }.",
      "  • action='guide' { steps:[…], title? } runs a multi-step walkthrough the user advances (advance:'click' moves on when they click the highlighted control). Example (add an API key): steps:[{ target:'control:apikeys/add', text:'Click + Add Key', advance:'click' }, { target:'control:apikeys/dialog/provider', text:'Pick your provider' }, { target:'control:apikeys/dialog/key', text:'Paste the key, then Save' }].",
      "  • action='clear_highlight' removes it; action='back' goes back; action='open_panel'/'open_modal' { target|query } opens modals (modal:chat, modal:approvals, modal:chart, modal:launchpad, modal:learn).",
      "  • Results: ok=false code AMBIGUOUS_TARGET → ask the user which of `candidates` they mean (or pick one) and retry with target=<id>. code TARGET_UNAVAILABLE → relay `error`; `fixTarget` is where to fix it (e.g. plugin:solatrix/enable) — offer a guide: step 1 fixTarget, step 2 the original target.",
      "  • Delivery: goes to the user you're talking to — the tab bound to this chat session, else their most recently active tab. Never every tab (pass scope:'all' only if asked). Works the same from voice, Telegram, sub-agents and MCP.",
      "  • After it succeeds, tell the user briefly what you opened/highlighted (resolved.title) — the highlight is already on their screen.",
    ].join(" "),
    parameters: UIControlSchema,
    execute: async (_id, args) => {
      const params = args as Record<string, unknown>;
      try {
        // clear_highlight clears both kinds: overlay-card text highlights
        // (args.id) and the live element highlight / running guide.
        if (params.action === "clear_highlight") {
          const overlay = handleOverlayAction("clear_highlight", params.args);
          const ui = await invokeUIControlAction({
            ...params,
            sessionKey: opts.agentSessionKey,
          } as Record<string, unknown>);
          return jsonResult({
            ...ui,
            ok: ui.ok !== false || overlay.ok === true,
            overlayCleared: overlay.ok === true,
          });
        }
        // Overlay verbs (spawn_overlay, highlight_text, …) run against the
        // in-process overlay router rather than the browser UIControlBus.
        if (isOverlayAction(params.action)) {
          return jsonResult(handleOverlayAction(params.action, params.args));
        }
        const result = await invokeUIControlAction({ ...params, sessionKey: opts.agentSessionKey });
        if (params.action === "screenshot") return await screenshotResult(result);
        return jsonResult(result);
      } catch (err: unknown) {
        const e = err as { code?: string; message?: string };
        return jsonResult({
          ok: false,
          error: e?.message ?? String(err),
          code: e?.code,
          action: typeof params.action === "string" ? params.action : undefined,
        });
      }
    },
  };
}

/**
 * Screenshots come back as a data URL; save them under the state dir and hand
 * the model the image (plus the path) instead of a megabyte of base64 text.
 */
async function screenshotResult(result: Record<string, unknown>) {
  const payload = (result.payload ?? null) as { dataUrl?: unknown } | null;
  const dataUrl = typeof payload?.dataUrl === "string" ? payload.dataUrl : "";
  const m = /^data:(image\/(png|jpeg|webp));base64,(.+)$/.exec(dataUrl);
  if (result.ok === false || !m) return jsonResult(result);
  const [, mimeType, ext, base64] = m;
  const dir = path.join(resolveStateDir(), "media", "ui-screenshots");
  await fs.mkdir(dir, { recursive: true });
  const node = coerceString(result.node, "local").replace(/[^\w.-]+/g, "_");
  const file = path.join(dir, `${node}-${Date.now()}.${ext === "jpeg" ? "jpg" : ext}`);
  await fs.writeFile(file, Buffer.from(base64!, "base64"));
  const { dataUrl: _drop, ...meta } = payload as Record<string, unknown>;
  const details = { ...result, payload: { ...meta, path: file } };
  return imageResult({
    label: "ui_control screenshot",
    path: file,
    base64: base64!,
    mimeType: mimeType!,
    extraText: JSON.stringify({ ...details, media: `MEDIA:${file}` }, null, 2),
    details,
  });
}
