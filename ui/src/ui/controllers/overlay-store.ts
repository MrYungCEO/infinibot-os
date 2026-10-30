/**
 * overlay-store.ts — client-side store for the InfiniBot Agentic Overlay System.
 *
 * Single source of truth the `<agent-overlay-layer>` host renders from. It:
 *   • subscribes to the gateway WS topic `overlay.events`
 *     (`{kind:'spawn'|'update'|'close'|'highlight'|'clearHighlight', record?, id?}`)
 *   • on (re)connect, hydrates from the `ui.overlay.list` RPC (graceful no-op if
 *     the backend RPC isn't live yet — frontend ships ahead of the gateway)
 *   • also listens for a dev hook `window` CustomEvent `overlay.spawn`
 *     (`{detail:{type, payload?, position?, anchor?, ttlMs?}}`) so cards can be
 *     spawned from devtools BEFORE the WS pipe exists, per the build spec.
 *
 * Highlights are routed straight to the OverlayHighlightController and are NOT
 * stored as overlay records (they are transient effects, not cards).
 *
 * No persistence here — positions live in-memory for v1 (spec §8).
 */

import type { GatewayBrowserClient } from "../gateway";
import { OverlayHighlightController } from "./overlay-highlight";

export type OverlayPosition = { x: number; y: number; w: number; h: number };

export type OverlayRecord = {
  overlayId: string;
  type: string;
  payload: Record<string, unknown>;
  position: OverlayPosition;
  createdAt: number;
  ttlMs: number | null;
  /** local-only: true when spawned via the dev hook (no backend round-trip) */
  local?: boolean;
};

type OverlayEvent =
  | { kind: "spawn"; record: OverlayRecord }
  | { kind: "update"; record: OverlayRecord }
  | { kind: "close"; id: string }
  | { kind: "highlight"; id: string; query: string; color?: string; durationMs?: number; scope?: string }
  | { kind: "clearHighlight"; id?: string };

let SEQ = 0;
const nextLocalId = () => `ov-local-${Date.now().toString(36)}-${(SEQ++).toString(36)}`;

/**
 * Default geometry for a freshly spawned card, cascaded so multiple cards don't
 * stack exactly on top of one another.
 */
function defaultPosition(index: number): OverlayPosition {
  const step = 28;
  return {
    x: 96 + (index % 6) * step,
    y: 96 + (index % 6) * step,
    w: 420,
    h: 320,
  };
}

export class OverlayStore {
  private overlays = new Map<string, OverlayRecord>();
  private listeners = new Set<() => void>();
  private unsubWs: (() => void) | null = null;
  private gateway: GatewayBrowserClient | null = null;
  private highlight: OverlayHighlightController;
  private spawnCount = 0;
  private expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private dismissed = new Set<string>();
  private boundDevHook = (e: Event) => this.onDevSpawn(e as CustomEvent);

  constructor(highlight?: OverlayHighlightController) {
    this.highlight = highlight ?? new OverlayHighlightController();
  }

  // ── lifecycle ─────────────────────────────────────────────────────────
  connect(gateway: GatewayBrowserClient | null) {
    if (this.gateway === gateway) return;
    const changingGateway = this.gateway !== null && this.gateway !== gateway;
    this.gateway = gateway;
    this.unsubWs?.();
    this.unsubWs = null;
    if (changingGateway) {
      this.dismissed.clear();
      for (const [id, record] of this.overlays) {
        if (!record.local) this.removeLocal(id);
      }
      this.emit();
    }
    if (gateway) {
      this.unsubWs = gateway.subscribe((evt) => {
        if (evt.event === "overlay.events") this.applyEvent(evt.payload as OverlayEvent);
      });
      void this.hydrate();
    }
  }

  /** Begin listening for the devtools `overlay.spawn` hook. */
  startDevHook() {
    if (typeof window !== "undefined") {
      window.addEventListener("overlay.spawn", this.boundDevHook as EventListener);
    }
  }

  dispose() {
    this.unsubWs?.();
    this.unsubWs = null;
    if (typeof window !== "undefined") {
      window.removeEventListener("overlay.spawn", this.boundDevHook as EventListener);
    }
    this.listeners.clear();
    this.highlight.clear();
    for (const timer of this.expiryTimers.values()) clearTimeout(timer);
    this.expiryTimers.clear();
  }

  // ── subscription ──────────────────────────────────────────────────────
  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit() {
    for (const cb of this.listeners) {
      try {
        cb();
      } catch {
        /* a listener throwing must not wedge the others */
      }
    }
  }

  // ── reads ─────────────────────────────────────────────────────────────
  list(): OverlayRecord[] {
    return [...this.overlays.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  get highlights(): OverlayHighlightController {
    return this.highlight;
  }

  // ── hydration ─────────────────────────────────────────────────────────
  private async hydrate() {
    if (!this.gateway) return;
    try {
      const res = await this.gateway.request<{ overlays?: OverlayRecord[] }>("ui.overlay.list", {});
      const rows = res?.overlays;
      if (Array.isArray(rows)) {
        const serverIds = new Set(rows.map((row) => row?.overlayId).filter(Boolean));
        for (const [id, record] of this.overlays) {
          if (!record.local && !serverIds.has(id)) this.removeLocal(id);
        }
        for (const row of rows) {
          if (!row?.overlayId || this.dismissed.has(row.overlayId)) continue;
          this.put(normalize(row));
        }
        this.emit();
      }
    } catch {
      // Backend RPC not live yet (frontend ships ahead). Silent — dev hook + WS
      // still drive the UI for visual verification.
    }
  }

  // ── WS event application ──────────────────────────────────────────────
  private applyEvent(evt: OverlayEvent | undefined) {
    if (!evt || typeof evt !== "object") return;
    switch (evt.kind) {
      case "spawn":
        if (evt.record?.overlayId) {
          this.dismissed.delete(evt.record.overlayId);
          this.put(normalize(evt.record));
          this.emit();
        }
        break;
      case "update":
        if (evt.record?.overlayId && !this.dismissed.has(evt.record.overlayId)) {
          this.put(normalize(evt.record));
          this.emit();
        }
        break;
      case "close":
        if (evt.id && this.removeLocal(evt.id)) this.emit();
        break;
      case "highlight":
        if (evt.query) {
          this.highlight.paint({
            id: evt.id,
            query: evt.query,
            color: evt.color,
            durationMs: evt.durationMs,
            scope: evt.scope,
          });
        }
        break;
      case "clearHighlight":
        this.highlight.clear(evt.id);
        break;
    }
  }

  // ── dev hook ──────────────────────────────────────────────────────────
  private onDevSpawn(e: CustomEvent) {
    const detail = (e.detail ?? {}) as {
      type?: string;
      payload?: Record<string, unknown>;
      position?: Partial<OverlayPosition>;
      ttlMs?: number;
    };
    if (!detail.type) return;
    if (detail.type === "highlight") {
      const p = detail.payload ?? {};
      this.highlight.paint({
        query: String(p.query ?? ""),
        color: p.color as string | undefined,
        durationMs: p.durationMs as number | undefined,
        scope: p.scope as string | undefined,
      });
      return;
    }
    const base = defaultPosition(this.spawnCount++);
    const record: OverlayRecord = {
      overlayId: nextLocalId(),
      type: detail.type,
      payload: detail.payload ?? {},
      position: { ...base, ...detail.position },
      createdAt: Date.now(),
      ttlMs: detail.ttlMs ?? null,
      local: true,
    };
    this.put(record);
    this.emit();
  }

  // ── local mutations (drag/resize/close handlers call these) ───────────
  /** Persist a moved/resized card. Optimistic locally; best-effort to backend. */
  updatePosition(overlayId: string, position: OverlayPosition) {
    const rec = this.overlays.get(overlayId);
    if (!rec) return;
    rec.position = position;
    // Don't emit() — the card already owns its geometry; re-rendering mid-drag
    // would fight the pointer. Just sync to backend when it's a server card.
    if (!rec.local) {
      void this.gateway?.request("ui.overlay.update", { overlayId, position }).catch(() => {});
    }
  }

  /** Close a card: optimistic local removal + best-effort backend close. */
  close(overlayId: string) {
    const rec = this.overlays.get(overlayId);
    if (!rec) return;
    if (!rec.local) this.dismissed.add(overlayId);
    this.removeLocal(overlayId);
    this.emit();
    if (!rec.local) {
      void this.gateway?.request("ui.overlay.close", { overlayId }).catch(() => {});
    }
  }

  /** Close the newest visible card. Used by the global Escape fallback. */
  closeNewest(): void {
    const newest = this.list().at(-1);
    if (newest) this.close(newest.overlayId);
  }

  /** Clear every card without allowing stale hydration to resurrect it. */
  clearAll(): void {
    for (const record of this.list()) this.close(record.overlayId);
  }

  private put(record: OverlayRecord): void {
    const expiresAt =
      record.ttlMs === null ? null : record.createdAt + Math.max(0, Number(record.ttlMs) || 0);
    if (expiresAt !== null && expiresAt <= Date.now()) {
      this.removeLocal(record.overlayId);
      return;
    }

    this.overlays.set(record.overlayId, record);
    const existing = this.expiryTimers.get(record.overlayId);
    if (existing) clearTimeout(existing);
    this.expiryTimers.delete(record.overlayId);

    if (expiresAt !== null) {
      const timer = setTimeout(() => {
        this.expiryTimers.delete(record.overlayId);
        if (this.removeLocal(record.overlayId)) this.emit();
      }, Math.max(0, expiresAt - Date.now()));
      this.expiryTimers.set(record.overlayId, timer);
    }
  }

  private removeLocal(overlayId: string): boolean {
    const timer = this.expiryTimers.get(overlayId);
    if (timer) clearTimeout(timer);
    this.expiryTimers.delete(overlayId);
    return this.overlays.delete(overlayId);
  }
}

function normalize(r: OverlayRecord): OverlayRecord {
  return {
    overlayId: r.overlayId,
    type: r.type,
    payload: (r.payload as Record<string, unknown>) ?? {},
    position: {
      x: r.position?.x ?? 96,
      y: r.position?.y ?? 96,
      w: r.position?.w ?? 420,
      h: r.position?.h ?? 320,
    },
    createdAt: r.createdAt ?? Date.now(),
    ttlMs: r.ttlMs ?? null,
    local: r.local,
  };
}
