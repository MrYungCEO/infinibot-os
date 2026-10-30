/**
 * Chat panel resolver — the ONE place that maps an agent-requested panel
 * (`{ kind, query }`) onto real gateway RPCs and a factual summary.
 *
 * Generalised from src/omnitrade/panel/resolve.ts (OmniTrade fork, 9a6ead3f):
 *   - the `show_panel` agent tool → `chat.panel.show` RPC → this resolver;
 *   - the live UI card/modal → `chat.panel.refresh` RPC → this resolver.
 * Pure mapping: the RPC transport is injected (`call`), so the exact same code
 * runs in-process on the gateway and under unit test with a stub caller.
 *
 * SAFETY: each kind declares the RPCs it may call; the caller handed to a kind
 * is wrapped so anything else is rejected. `chat.panel.*` are READ-scoped
 * methods, so they must never become a proxy to write methods.
 */

import { getPluginPanelKinds } from "../plugins/runtime.js";
import { PANEL_KIND_DEFS } from "./kinds.js";
import type {
  ChatPanelRef,
  PanelCaller,
  PanelDisplay,
  PanelKindDef,
  PanelQuery,
  PanelResult,
} from "./types.js";

export type {
  ChatPanelRef,
  PanelCaller,
  PanelDisplay,
  PanelKindDef,
  PanelLink,
  PanelQuery,
  PanelResult,
} from "./types.js";

const REGISTRY = new Map<string, PanelKindDef>(PANEL_KIND_DEFS.map((k) => [k.id, k]));

export const PANEL_KINDS: readonly string[] = PANEL_KIND_DEFS.map((k) => k.id);

/** Every RPC any panel kind may call (the in-process dispatch allowlist). */
export const PANEL_METHODS: ReadonlySet<string> = new Set(
  PANEL_KIND_DEFS.flatMap((k) => k.methods),
);

/**
 * Kinds contributed by loaded manifest-v2 plugins (`<pluginId>.<kind>`). They
 * appear and disappear with the plugin; core kinds always win on id clashes.
 */
function pluginKind(kind: string): PanelKindDef | undefined {
  if (REGISTRY.has(kind)) return undefined;
  return getPluginPanelKinds().find((p) => p.def.id === kind)?.def;
}

export function isPanelKind(v: unknown): v is string {
  return typeof v === "string" && (REGISTRY.has(v) || Boolean(pluginKind(v)));
}

export function getPanelKind(kind: string): PanelKindDef | undefined {
  return REGISTRY.get(kind) ?? pluginKind(kind);
}

/** True for a kind a loaded plugin contributed (its RPCs are plugin handlers). */
export function isPluginPanelKind(kind: string): boolean {
  return Boolean(pluginKind(kind));
}

/** Core + currently-loaded plugin kinds. */
export function allPanelKindDefs(): PanelKindDef[] {
  const seen = new Set(PANEL_KINDS);
  return [
    ...PANEL_KIND_DEFS,
    ...getPluginPanelKinds()
      .map((p) => p.def)
      .filter((d) => !seen.has(d.id)),
  ];
}

/** Cap the markdown fallback so a huge table can't flood a Telegram message. */
const TEXT_CAP = 3000;

function capText(t: string): string {
  return t.length > TEXT_CAP ? `${t.slice(0, TEXT_CAP - 1)}…` : t;
}

/** Keep only JSON-safe data in a query (it is echoed back to every UI). */
export function sanitizeQuery(q: unknown): PanelQuery {
  if (!q || typeof q !== "object" || Array.isArray(q)) return {};
  try {
    return JSON.parse(JSON.stringify(q)) as PanelQuery;
  } catch {
    return {};
  }
}

function guardedCaller(def: PanelKindDef, call: PanelCaller): PanelCaller {
  const allowed = new Set(def.methods);
  return (method, params) => {
    if (!allowed.has(method)) {
      return Promise.reject(new Error(`panel kind "${def.id}" may not call ${method}`));
    }
    return call(method, params);
  };
}

export async function resolvePanel(
  kind: string,
  rawQuery: unknown,
  call: PanelCaller,
  opts: { title?: string } = {},
): Promise<PanelResult> {
  const def = getPanelKind(kind);
  const query = sanitizeQuery(rawQuery);
  if (!def) {
    const error = `unknown panel kind "${kind}" — use one of ${allPanelKindDefs()
      .map((k) => k.id)
      .join(" | ")}`;
    return {
      kind,
      title: opts.title || kind,
      data: null,
      summary: error,
      count: 0,
      empty: true,
      error,
      text: error,
      link: { tab: "", label: "" },
      refreshMs: 0,
      fetchedAt: Date.now(),
    };
  }
  try {
    const out = await def.resolve(query, guardedCaller(def, call));
    const title = opts.title?.trim() || out.title || def.title;
    const summary =
      out.empty && !out.summary ? `No ${def.title.toLowerCase()} data to show` : out.summary;
    return {
      kind,
      title,
      data: out.data,
      summary,
      count: out.count,
      empty: out.empty,
      error: null,
      text: capText(`${def.toText(out.data)}`),
      link: out.link ?? def.link(query),
      refreshMs:
        typeof out.refreshMs === "number" && out.refreshMs >= 0 ? out.refreshMs : def.refreshMs,
      fetchedAt: Date.now(),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      kind,
      title: opts.title?.trim() || def.title,
      data: null,
      summary: `Could not load ${def.title.toLowerCase()}: ${message}`,
      count: 0,
      empty: true,
      error: message,
      text: `Could not load ${def.title.toLowerCase()}: ${message}`,
      link: def.link(query),
      refreshMs: def.refreshMs,
      fetchedAt: Date.now(),
    };
  }
}

/** Build the data-free reference a chat transcript carries for a panel. */
export function buildPanelRef(
  result: PanelResult,
  query: PanelQuery,
  opts: { panelId: string; display: PanelDisplay },
): ChatPanelRef {
  return {
    v: 1,
    panelId: opts.panelId,
    kind: result.kind,
    // The table kind's rows ARE its data — keep them so the card can render
    // on history reload without the agent re-supplying them.
    query,
    title: result.title,
    display: opts.display,
    summary: result.summary,
    count: result.count,
    empty: result.empty,
    error: result.error,
    link: result.link,
    refreshMs: result.refreshMs,
    ts: Date.now(),
  };
}

/** Tool description snippet: one line per kind (core + loaded plugins) with its query params. */
export function describePanelKinds(): string {
  return allPanelKindDefs()
    .map((k) => `• ${k.id} — ${k.description}. Query ${k.queryHelp.replace(/^\w+:\s*/, "")}`)
    .join("\n");
}
