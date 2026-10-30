/**
 * shared-feed.ts — one AgencyDataBridge shared by every ambient overlay.
 *
 * Both <voice-world-connectors> and <voice-world-graph> consume the same
 * normalized WorldEvent stream. Rather than each spinning up its own bridge
 * (= duplicate snapshot fetch + WS subscription), they share a single
 * reference-counted bridge keyed by gateway client. The bridge is torn down
 * when the last subscriber disconnects.
 *
 * Utterance events have no WorldEvent kind, so we also surface the window-level
 * `assistant:text:delta` (assistant speech) as a throttled synthetic event.
 */

import type { GatewayBrowserClient } from "../../gateway";
import { AgencyDataBridge, type WorldEvent } from "../../controllers/agency-data-bridge";

type Cb = (events: WorldEvent[]) => void;

interface Shared {
  bridge: AgencyDataBridge;
  unsub: () => void;
  subs: Set<Cb>;
}

let shared: { client: GatewayBrowserClient; rec: Shared } | null = null;

export function subscribeWorld(client: GatewayBrowserClient, cb: Cb): () => void {
  if (!shared || shared.client !== client) {
    // Tear down any stale bridge bound to a different client.
    shared?.rec.unsub();
    const subs = new Set<Cb>();
    const bridge = new AgencyDataBridge(client);
    const unsub = bridge.subscribe((events) => {
      for (const s of subs) {
        try {
          s(events);
        } catch (err) {
          console.error("[voice-ambient] subscriber error:", err);
        }
      }
    });
    shared = { client, rec: { bridge, unsub, subs } };
  }
  const rec = shared.rec;
  rec.subs.add(cb);
  return () => {
    rec.subs.delete(cb);
    if (rec.subs.size === 0) {
      rec.unsub();
      try {
        (rec.bridge as unknown as { destroy?: () => void }).destroy?.();
      } catch {
        /* best-effort */
      }
      if (shared && shared.rec === rec) shared = null;
    }
  };
}

/**
 * Synthetic utterance feed. `assistant:text:delta` fires per token; we coalesce
 * a burst into one "utterance" emitted once the stream goes quiet (≥600ms gap).
 * Returns an unsubscribe fn.
 */
export function subscribeUtterances(onUtterance: (text: string) => void): () => void {
  let buf = "";
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    const t = buf.trim();
    buf = "";
    timer = null;
    if (t) onUtterance(t);
  };
  const handler = (e: Event) => {
    const payload = (e as CustomEvent).detail;
    const piece =
      typeof payload === "string"
        ? payload
        : (payload?.text ?? payload?.delta ?? payload?.content ?? "");
    if (typeof piece === "string") buf += piece;
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, 600);
  };
  window.addEventListener("assistant:text:delta", handler as EventListener);
  return () => {
    window.removeEventListener("assistant:text:delta", handler as EventListener);
    if (timer) clearTimeout(timer);
  };
}
