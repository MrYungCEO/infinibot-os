/**
 * Agent Mesh embed mode — the SAME /mesh (<agent-mesh-page> → <agency-world-viz
 * review-layer>: isometric districts, live sub-agent runs, worker ↔ Auditor
 * review, recently-completed rail, agent cards, screenshot gallery, review
 * threads, plugin rooms, federation nodes) running chromeless inside the
 * mobile app's WebView: `/mesh?embed=mobile`.
 *
 * Transport, host detection and shell chrome are shared with the Knowledge
 * Graph embed (embed-host.ts); this module only owns the mesh's vocabulary:
 *
 *   page → app  `{ source: "infinibot-mesh", type, … }`
 *     ready   { agents, nodes }           first data on screen (lifts the app's veil)
 *     haptic  { style }
 *     back                                 nothing left to close on the page
 *     chat    { sessionKey, label? }       continue with this agent in the app's chat
 *     run     { runId, sessionKey?, label? } open the run in the app (Reviews)
 *     task    { taskId }                   open the kanban task in the app
 *   app → page  `window.__meshEmbed.*` (RN) / postMessage `{ source: "infinibot-mesh-host", cmd }`
 *     focus   { id }    an agent sessionKey or runId → fly there + pin its card
 *     review  { runId } open the run's review thread
 *     fit / back
 *
 *   Deep-link params: `?focus=<sessionKey|runId>&review=<runId>`.
 */
import {
  EMBED_CHROME_CSS,
  applyEmbedChrome,
  cleanStr,
  createEmbedBridge,
  hasNativeHost,
  isEmbedRequest,
  surfaceLockCss,
  type NativeHaptic,
} from "./embed-host";

export const MESH_BRIDGE_SOURCE = "infinibot-mesh";
export const MESH_HOST_SOURCE = "infinibot-mesh-host";

export type MeshNativeMessage =
  | { type: "ready"; agents: number; nodes: number }
  | { type: "haptic"; style: NativeHaptic }
  | { type: "back" }
  | { type: "chat"; sessionKey: string; label?: string }
  | { type: "run"; runId: string; sessionKey?: string; label?: string }
  | { type: "task"; taskId: string };

export type MeshHostCommand =
  | { cmd: "focus"; id: string }
  | { cmd: "review"; runId: string }
  | { cmd: "fit" }
  | { cmd: "back" };

export interface MeshDeepLink {
  focus: string | null;
  review: string | null;
}

const bridge = createEmbedBridge<MeshNativeMessage, MeshHostCommand>({
  source: MESH_BRIDGE_SOURCE,
  hostSource: MESH_HOST_SOURCE,
  parseCommand: (o) => {
    switch (o.cmd) {
      case "focus": {
        const id = cleanStr(o.id);
        return id ? { cmd: "focus", id } : null;
      }
      case "review": {
        const runId = cleanStr(o.runId);
        return runId ? { cmd: "review", runId } : null;
      }
      case "fit":
        return { cmd: "fit" };
      case "back":
        return { cmd: "back" };
      default:
        return null;
    }
  },
});

/** Pure: validate a host → page command (unknown / malformed → null). */
export const parseMeshHostCommand = bridge.parseHostCommand;
/** Commands from a same-origin parent frame (the app's web export). */
export const listenMeshHostCommands = bridge.listenHostCommands;

/** Send a message to the native app; false when there is no native host. */
export function postMeshNative(msg: MeshNativeMessage): boolean {
  return bridge.postNative(msg);
}

/** Haptic tick: native host first, else the Vibration API on Android browsers. */
export function meshHaptic(style: NativeHaptic): void {
  bridge.haptic(style);
}

/** True when the mesh runs chromeless (`?embed=1|mobile`). */
export function isMeshEmbed(): boolean {
  return isEmbedRequest();
}

/** True inside the app (RN WebView or its same-origin web export). */
export function meshHasNativeHost(): boolean {
  return hasNativeHost();
}

/** Pure: the deep-link params of a URL search string. */
export function parseMeshDeepLink(search: string): MeshDeepLink {
  let sp: URLSearchParams;
  try {
    sp = new URLSearchParams(search);
  } catch {
    sp = new URLSearchParams();
  }
  return { focus: cleanStr(sp.get("focus")), review: cleanStr(sp.get("review")) };
}

/**
 * Pure: resolve a focus id (a sessionKey, or a runId) against the agents on
 * the map. Exact sessionKey wins, then an agent whose runId matches.
 */
export function resolveMeshFocus(
  id: string | null | undefined,
  agents: Iterable<{ sessionKey: string; runId?: string | null }>,
): string | null {
  const want = (id ?? "").trim();
  if (!want) return null;
  let byRun: string | null = null;
  for (const a of agents) {
    if (a.sessionKey === want) return a.sessionKey;
    if (!byRun && a.runId && a.runId === want) byRun = a.sessionKey;
  }
  return byRun;
}

const EMBED_STYLE_ID = "__mesh_embed_chrome";
export const MESH_EMBED_BG = "#07060c";

/** The page-level CSS for the mesh embed (exported for tests). */
export const MESH_EMBED_CSS = [
  EMBED_CHROME_CSS,
  surfaceLockCss("data-mesh-embed", MESH_EMBED_BG),
  // Global overlays the mesh opens on document.body: keep them inside the
  // phone's safe area and above the app's floating dock.
  'html[data-mesh-embed="1"] .mesh-ctx-sheet{bottom:var(--mesh-host-bottom,0px)!important}',
].join("");

/** Put the page in mesh embed mode (idempotent). */
export function applyMeshEmbedChrome(): void {
  applyEmbedChrome({ attr: "data-mesh-embed", styleId: EMBED_STYLE_ID, css: MESH_EMBED_CSS });
}
