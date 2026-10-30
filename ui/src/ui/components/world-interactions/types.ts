/**
 * Shared types + window-level data contracts for <world-interactions>.
 *
 * The overlay is a *consumer* of state published by the world host
 * (<agency-world-viz>) and the gateway app shell. It never reaches into the
 * host's internals — it reads documented window globals, mirroring the
 * `window.__agentFxState` contract that <agent-fx-layer> already relies on.
 *
 * ── DATA CONTRACTS ─────────────────────────────────────────────────────────
 *   window.__agentFxState   FxAgent[]    — live agent screen positions (CSS px,
 *                                          relative to the world host's box).
 *   window.__worldSectors   WorldSector[] — sector/building screen rects (CSS
 *                                          px, same space) usable as drop zones.
 *   window.__infinibotGatewayClient        — gateway WS RPC client (request()).
 *   window.openAgentFocus(target)          — opens the focus modal (focus-modal
 *                                            agent owns this).
 *
 * If __worldSectors is absent the drag-to-assign drop targets simply don't
 * render; nothing throws. This keeps the overlay forward-compatible with
 * whatever the parallel world-* agents choose to publish.
 */

/** A single agent as published by the world viz, in host-relative screen px. */
export interface FxAgent {
  /** Stable id — usually the sessionKey; used for selection + RPC fallback. */
  id: string;
  /** Screen X (CSS px, relative to the world host box). */
  x: number;
  /** Screen Y (CSS px, relative to the world host box). */
  y: number;
  status?: string;
  backend?: string;
  /** Human label, if the viz publishes one (falls back to id). */
  label?: string;
  /** Run id, when known — preferred for subagents.* RPCs. */
  runId?: string;
  /** Session key, when known — preferred for sessions.* RPCs. */
  sessionKey?: string;
}

/** A drop-zone building/sector as published by the world viz, in screen px. */
export interface WorldSector {
  id: string;
  name: string;
  /** Center X (CSS px, host-relative). */
  x: number;
  /** Center Y (CSS px, host-relative). */
  y: number;
  /** Optional half-width / half-height for rect hit-testing (default radius). */
  w?: number;
  h?: number;
  /** Coarse category, e.g. "kanban" | "tool" | "hq". */
  kind?: string;
}

/** Minimal shape of the gateway browser client we depend on. */
export interface GatewayClientLike {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
}

/** Options for the shared inline prompt (group/single send-message). */
export interface PromptOptions {
  title: string;
  placeholder?: string;
  value?: string;
  confirmLabel?: string;
  onSubmit: (value: string) => void;
}

/**
 * Slim surface the interaction modules use to talk back to the host element —
 * keeps drag/radial/director decoupled from Lit rendering internals.
 */
export interface InteractionHost {
  /** Schedule a re-render of the overlay. */
  requestUpdate(): void;
  /** Show a transient glass toast. */
  toast(message: string, kind?: "ok" | "err"): void;
  /** Open the shared modal prompt (used by single + group send-message). */
  openPrompt(opts: PromptOptions): void;
}

declare global {
  interface Window {
    // NB: __agentFxState is declared by <agent-fx-layer> with its own (narrower)
    // FxAgent shape; we intentionally do NOT re-declare it here to avoid a
    // duplicate-global type clash. world-state.ts reads it via a structural cast.
    __worldSectors?: WorldSector[];
    __infinibotGatewayClient?: GatewayClientLike;
    openAgentFocus?: (target: unknown) => void;
  }
}
