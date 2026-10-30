/**
 * Per-surface Secure Mode lane switch for chat surfaces that are not the
 * /webchat page: the chat sidebar dock (<agent-chat-modal>), grid chat panels
 * (<masonry-panel>), the autopilot side panel (<agent-chat-sidebar>).
 *
 * Every surface keeps its own memory (per surface id + agent), so flipping the
 * sidebar into its secure lane does not yank the grid panel or the main chat
 * along, while the Secure Mode state itself is the one shared store.
 *
 *   ON  → turn Secure Mode on if needed, remember the surface's normal key,
 *         reopen the surface's last secure session for this agent or open a new
 *         one (`secure.session.new`; a locally minted key when the gateway
 *         cannot answer).
 *   OFF → remember the secure key and return to the surface's normal key (or
 *         `fallbackNormalKey`, or `null` = "start a fresh normal chat").
 *
 * The planning half is pure (runs under node vitest); `SecureSurfaceLane` is a
 * small Lit controller holding busy / error for the composer toggle.
 */
import { css, html, nothing, type ReactiveController, type ReactiveControllerHost, type TemplateResult } from "lit";
import { icons } from "../icons";
import { isSecureSessionKey, newSecureSessionKey, readStoredKey, writeStoredKey } from "./session-key";
import { ensureSecureMode, getSecureState, onSecureChange, secureActive, secureRequest } from "./store";

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type RequestFn = (method: string, params: Record<string, unknown>) => Promise<unknown>;

const STORAGE_PREFIX = "ib.secure.surface";

function agentOf(key: string | null | undefined): string | null {
  const m = /^agent:([^:]+):/i.exec((key ?? "").trim());
  return m ? m[1] : null;
}

function cleanAgent(agentId: string | null | undefined): string {
  return (agentId ?? "").trim() || "main";
}

/** localStorage names for one surface + agent. */
export function surfaceLaneStorageKeys(surface: string, agentId: string): { secure: string; normal: string } {
  const base = `${STORAGE_PREFIX}.${surface || "chat"}.${cleanAgent(agentId)}`;
  return { secure: `${base}.secure`, normal: `${base}.normal` };
}

/**
 * Open a new secure 1:1 session for `agentId`: the gateway mints it
 * (`secure.session.new`); if that RPC is unavailable the key is minted locally
 * in the same shape (the gateway creates the session on first send).
 */
export async function openSecureSession(
  agentId: string,
  request: RequestFn = (m, p) => secureRequest(m, p),
): Promise<string> {
  const id = cleanAgent(agentId);
  try {
    const res = (await request("secure.session.new", { agentId: id })) as { sessionKey?: unknown } | null | undefined;
    const key = typeof res?.sessionKey === "string" ? res.sessionKey : "";
    if (isSecureSessionKey(key)) return key;
  } catch {
    /* older gateway / transient — fall back to a local key */
  }
  return newSecureSessionKey(id);
}

export type SurfaceLaneResult = { ok: true; key: string | null } | { ok: false; error: string };

export async function switchSurfaceLane(opts: {
  on: boolean;
  /** Stable surface id, e.g. "sidebar", "grid:<panelId>", "autopilot". */
  surface: string;
  agentId: string;
  currentKey: string | null;
  /** Normal key to use when none is remembered (default: null = fresh chat). */
  fallbackNormalKey?: string | null;
  ensure?: () => Promise<boolean>;
  request?: RequestFn;
  storage?: StorageLike | null;
}): Promise<SurfaceLaneResult> {
  const agentId = cleanAgent(opts.agentId);
  const names = surfaceLaneStorageKeys(opts.surface, agentId);
  const store = opts.storage === undefined ? undefined : opts.storage;
  const read = (n: string) => (store === undefined ? readStoredKey(n) : readStoredKey(n, store));
  const write = (n: string, v: string | null) => (store === undefined ? writeStoredKey(n, v) : writeStoredKey(n, v, store));
  const current = opts.currentKey && opts.currentKey.trim() ? opts.currentKey : null;

  if (opts.on) {
    const ok = await (opts.ensure ?? ensureSecureMode)();
    if (!ok) return { ok: false, error: getSecureState().error ?? "Secure Mode could not be turned on." };
    if (current && !isSecureSessionKey(current)) write(names.normal, current);
    if (current && isSecureSessionKey(current)) return { ok: true, key: current };
    const remembered = read(names.secure);
    const reuse = remembered && isSecureSessionKey(remembered) && agentOf(remembered) === agentId ? remembered : null;
    const key = reuse ?? (await openSecureSession(agentId, opts.request));
    write(names.secure, key);
    return { ok: true, key };
  }

  if (current && isSecureSessionKey(current)) write(names.secure, current);
  if (current && !isSecureSessionKey(current)) return { ok: true, key: current };
  const remembered = read(names.normal);
  const back =
    remembered && !isSecureSessionKey(remembered) && agentOf(remembered) === agentId
      ? remembered
      : opts.fallbackNormalKey && !isSecureSessionKey(opts.fallbackNormalKey)
        ? opts.fallbackNormalKey
        : null;
  return { ok: true, key: back };
}

/**
 * Lit controller for a composer toggle: re-renders on every Secure Mode change
 * and tracks the in-flight switch + its inline error.
 */
export class SecureSurfaceLane implements ReactiveController {
  busy = false;
  error: string | null = null;
  private off: (() => void) | null = null;

  constructor(private readonly host: ReactiveControllerHost) {
    host.addController(this);
  }

  get active(): boolean {
    return secureActive(getSecureState());
  }

  get supported(): boolean {
    return getSecureState().supported !== false;
  }

  hostConnected(): void {
    this.off = onSecureChange(() => this.host.requestUpdate());
  }

  hostDisconnected(): void {
    this.off?.();
    this.off = null;
  }

  /** Resolves to the key to open (`null` = fresh normal chat), `undefined` when the switch failed / was ignored. */
  async switch(opts: Parameters<typeof switchSurfaceLane>[0]): Promise<string | null | undefined> {
    if (this.busy) return undefined;
    this.busy = true;
    this.error = null;
    this.host.requestUpdate();
    try {
      const res = await switchSurfaceLane(opts);
      if (!res.ok) {
        this.error = res.error;
        return undefined;
      }
      return res.key;
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      return undefined;
    } finally {
      this.busy = false;
      this.host.requestUpdate();
    }
  }
}

export const SECURE_SESSION_ON_TEXT = "Secure session · local models only";
export const SECURE_SESSION_LOCKED_TEXT = "Secure session locked — turn on Secure Mode to send";

/**
 * Lock badge for a surface whose session is in the secure lane. `short`
 * renders "Secure" / "Locked" (the full sentence moves to the tooltip).
 */
export function renderSecureSurfaceBadge(key: string | null | undefined, opts: { short?: boolean; surface?: string } = {}): TemplateResult | typeof nothing {
  if (!isSecureSessionKey(key)) return nothing;
  const active = secureActive(getSecureState());
  const full = active ? SECURE_SESSION_ON_TEXT : SECURE_SESSION_LOCKED_TEXT;
  const text = opts.short ? (active ? "Secure" : "Locked") : full;
  return html`<span
    class="ibss-badge ${active ? "" : "ibss-badge--locked"}"
    data-secure-surface-badge=${opts.surface ?? "chat"}
    role="status"
    title=${full}
    aria-label=${full}
  >${active ? icons.lock : icons.unlock}<span class="ibss-badge__text">${text}</span></span>`;
}

/** Shadow-DOM styles for `renderSecureSurfaceBadge` + the `.ibss-row` strip. */
export const secureSurfaceStyles = css`
  .ibss-row {
    display: flex; align-items: center; justify-content: flex-end; gap: 8px;
    min-width: 0; flex-wrap: wrap;
  }
  .ibss-row__spacer { flex: 1 1 auto; min-width: 0; }
  .ibss-badge {
    display: inline-flex; align-items: center; gap: 5px; flex: none;
    padding: 2px 9px; border-radius: 999px; white-space: nowrap;
    font-size: 11.5px; font-weight: 600; letter-spacing: 0.01em; line-height: 1.5;
    color: var(--ib-secure, #34d399);
    background: var(--ib-secure-soft, rgba(52, 211, 153, 0.13));
    border: 1px solid var(--ib-secure-ring, rgba(52, 211, 153, 0.5));
  }
  .ibss-badge svg { width: 12px; height: 12px; flex: none; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  .ibss-badge--locked { color: var(--muted, #9ca3af); background: transparent; border-style: dashed; }
  .ibss-badge__text { overflow: hidden; text-overflow: ellipsis; }
`;
