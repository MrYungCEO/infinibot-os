/**
 * Proactive Pop-Up System — shared emit core.
 *
 * Both the gateway `proactive.emit` / `proactive.emitMedia` handlers AND
 * server-side producers (e.g. the sub-agent completion → agent-summary popup in
 * subagent-registry) funnel through {@link buildAndInsertPopup} so routing
 * (cooldown / quiet-hours downgrade), persistence, and the `proactive.event`
 * WS broadcast stay identical regardless of caller.
 *
 * The gateway handlers broadcast via their per-request `context.broadcast`; the
 * server-side path uses {@link emitProactiveServerSide}, which reaches the wired
 * gateway broadcaster singleton.
 *
 * Queue behaviour: events emitted before the gateway broadcaster is wired are
 * queued and flushed automatically when the broadcaster registers. Events are
 * always persisted to SQLite first so they surface via `proactive.subscribe`
 * even if the flush never fires (e.g. process restart).
 */

import { getPopupStore } from "./popup-store.js";
import { loadPopupSettings } from "./popup-settings.js";
import { routeEmit, COOLDOWN_MS } from "../agents/coder-runtime/proactive-router.js";
import {
  getGatewayBroadcaster,
  onGatewayBroadcasterReady,
} from "../agents/coder-runtime/subagent-broadcast.js";
import { TIER_ORDER } from "./popup-types.js";
import type { RouteDecision } from "../agents/coder-runtime/proactive-router.js";
import type {
  PopupAction,
  PopupEmitInput,
  PopupEvent,
  PopupLink,
  PopupTier,
} from "./popup-types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { buildDeepLink, normalizeDeepLink, webOpenerUrl } from "../notifications/links.js";
import { getPublicBaseUrl } from "../notifications/public-base.js";

const log = createSubsystemLogger("proactive-emit");

export interface BuiltPopup {
  event: PopupEvent;
  routing: RouteDecision;
}

// ── Pending queue ─────────────────────────────────────────────────────────────
// Events emitted before the gateway broadcaster wires up are queued here.
// The queue is bounded to 64 entries; older entries are dropped on overflow.

const MAX_QUEUE = 64;
const pendingQueue: Array<{ wsEvent: string; payload: unknown }> = [];

// Register flush callback — fires once when the broadcaster becomes available.
onGatewayBroadcasterReady((broadcast) => {
  const count = pendingQueue.length;
  if (count === 0) return;
  log.info("flushing queued proactive events", { count });
  while (pendingQueue.length > 0) {
    const item = pendingQueue.shift()!;
    try {
      broadcast(item.wsEvent, item.payload);
    } catch {
      /* non-fatal — already persisted */
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────

/** Deep link an `open` action points at (payload.href / target / tab), if any. */
function deepLinkFromAction(a: PopupAction): string | null {
  const p = a.payload ?? {};
  for (const key of ["deepLink", "href", "target", "tab"] as const) {
    const v = p[key];
    if (typeof v !== "string" || !v.trim()) continue;
    // Legacy card target: `kanban?task=<id>` → board/task/<id>.
    const kanban = /^kanban\?task=(.+)$/.exec(v.trim());
    if (kanban) return buildDeepLink({ kind: "task", taskId: decodeURIComponent(kanban[1]) });
    const link = normalizeDeepLink(v);
    if (link) return link;
  }
  return null;
}

/**
 * The pop-up's tap target: an explicit `link` / `deepLink` from the emitter,
 * else the (primary) `open` action's target. Adds the https web opener when the
 * gateway has a public base URL. Exported for tests.
 */
export function resolvePopupLink(
  input: Pick<PopupEmitInput, "link" | "deepLink" | "actions">,
  base: string | null = safePublicBase(),
): PopupLink | null {
  let deepLink = normalizeDeepLink(input.link?.deepLink) ?? normalizeDeepLink(input.deepLink);
  if (!deepLink) {
    const opens = (Array.isArray(input.actions) ? input.actions : []).filter(
      (a) => a?.kind === "open",
    );
    opens.sort((a, b) => Number(!!b.primary) - Number(!!a.primary));
    for (const a of opens) {
      deepLink = deepLinkFromAction(a);
      if (deepLink) break;
    }
  }
  if (!deepLink) return null;
  const webUrl = input.link?.webUrl?.trim() || (base ? webOpenerUrl(deepLink, base) : undefined);
  return webUrl ? { deepLink, webUrl } : { deepLink };
}

function safePublicBase(): string | null {
  try {
    return getPublicBaseUrl();
  } catch {
    return null;
  }
}

/**
 * Route + persist a pop-up. Pure of any broadcast side-effect so the caller
 * decides how to fan it out. Throws on invalid tier so callers can surface a
 * structured error.
 */
export function buildAndInsertPopup(input: PopupEmitInput, stateDir: string): BuiltPopup {
  const tier = (input.tier ?? "").toString().toUpperCase() as PopupTier;
  if (!TIER_ORDER.includes(tier)) {
    throw new Error(`tier must be one of ${TIER_ORDER.join(", ")}`);
  }
  const store = getPopupStore(stateDir);
  const settings = loadPopupSettings(stateDir);
  const now = Date.now();
  const priorInWindow = store.countInWindow(input.dedupKey, COOLDOWN_MS[tier] || 0, now);
  const routing = routeEmit(tier, { priorInWindow, settings, now: new Date(now) });

  // Belt-and-suspenders: a CRITICAL pop with no actions is a producer bug that
  // traps the user behind a modal with no exit. Auto-inject a Dismiss action so
  // there is always a way out, and warn so the offending producer gets fixed.
  // (The UI also renders an always-reachable × fallback, but we guard here too
  // so the recovery survives even if a future surface forgets it.)
  let actions = Array.isArray(input.actions) ? input.actions : [];
  if (tier === "CRITICAL" && actions.length === 0) {
    log.warn("CRITICAL proactive popup emitted with no actions — injecting Dismiss", {
      title: input.title,
      dedupKey: input.dedupKey,
      agentId: input.attribution?.agentId,
    });
    actions = [{ id: "dismiss", kind: "dismiss", label: "Dismiss" }];
  }

  const event = store.insert({
    title: input.title,
    body: input.body ?? "",
    attribution: input.attribution,
    actions,
    dedupKey: input.dedupKey,
    requestedTier: routing.requestedTier,
    appliedTier: routing.appliedTier,
    voice: input.voice ?? null,
    media: input.media ?? null,
    link: resolvePopupLink({ ...input, actions }),
    createdAt: now,
  });
  return { event, routing };
}

/**
 * Emit a pop-up from a server-side producer (no request context). Persists then
 * broadcasts `proactive.event` via the wired gateway broadcaster.
 *
 * When the broadcaster isn't wired yet (gateway startup race), the event is
 * queued and flushed once the broadcaster registers. The event is always
 * persisted to SQLite so it surfaces on the next `proactive.subscribe` regardless.
 * Never throws to the caller.
 */
export function emitProactiveServerSide(
  input: PopupEmitInput,
  stateDir: string,
): BuiltPopup | null {
  try {
    const built = buildAndInsertPopup(input, stateDir);
    const payload = { event: built.event, routing: built.routing };
    const broadcast = getGatewayBroadcaster();
    if (broadcast) {
      try {
        broadcast("proactive.event", payload);
      } catch {
        /* non-fatal — persisted, will surface on next subscribe */
      }
    } else {
      log.info("broadcaster not wired — queuing proactive.event for flush on ready", {
        id: built.event.id,
        tier: built.event.tier,
        title: built.event.title,
        subscriberCount: 0,
      });
      if (pendingQueue.length >= MAX_QUEUE) {
        pendingQueue.shift(); // drop oldest when buffer full
      }
      pendingQueue.push({ wsEvent: "proactive.event", payload });
    }
    return built;
  } catch (e) {
    log.warn("server-side proactive emit failed", {
      err: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}
