/**
 * Shared "Pull from Notion" button.
 *
 * Drops onto any page that has at least one Notion binding for a given
 * role (projects / notes / clients / products / etc) — triggers the
 * `notion.import.refresh` RPC, which force-pulls every matching binding
 * through the bidirectional sync's poll path (so the smart-picker logic,
 * deep block fetcher, file collector all run again). After the RPC
 * settles, calls onSuccess so the page can reload its local data.
 *
 * Each page owns its own NotionPullState block so the button can show
 * spinner / last-pull timestamp / error without bleeding cross-page.
 */
import { html, nothing, type TemplateResult } from "lit";
import type { GatewayBrowserClient } from "./gateway";

export interface NotionPullState {
  pulling: boolean;
  lastError: string | null;
  lastPullAt: number | null;
  lastPullSummary: string | null;
  /** Cached binding count for this role so we hide the button when no
   *  binding exists yet — saves a "nothing happened" click. */
  hasBindings: boolean | null;
  bindingsCheckedAt: number;
}

export function createNotionPullState(): NotionPullState {
  return {
    pulling: false,
    lastError: null,
    lastPullAt: null,
    lastPullSummary: null,
    hasBindings: null,
    bindingsCheckedAt: 0,
  };
}

const BINDING_CACHE_TTL_MS = 30_000;

/**
 * Check whether a binding exists for the given role/dbId. Cached for
 * 30s so re-renders don't hammer the RPC. Updates state.hasBindings in
 * place; caller should requestUpdate() if it changes.
 */
async function ensureBindingsKnown(
  client: GatewayBrowserClient,
  pullState: NotionPullState,
  opts: { role?: string; dbId?: string; businessId?: string },
): Promise<void> {
  if (
    pullState.hasBindings !== null &&
    Date.now() - pullState.bindingsCheckedAt < BINDING_CACHE_TTL_MS
  ) {
    return;
  }
  try {
    const res = (await client.request("notion.import.listBindings")) as {
      bindings?: Array<{ notionDbId: string; role: string; businessId?: string | null }>;
    };
    const all = res.bindings ?? [];
    const match = all.some((b) => {
      if (opts.dbId && b.notionDbId !== opts.dbId) return false;
      if (opts.role && b.role !== opts.role) return false;
      if (opts.businessId && b.businessId && b.businessId !== opts.businessId) return false;
      return true;
    });
    pullState.hasBindings = match;
    pullState.bindingsCheckedAt = Date.now();
  } catch {
    // Couldn't check — assume yes so the button still renders. The RPC
    // itself returns NOT_FOUND if nothing matches; the user sees a
    // friendly error, no crash.
    pullState.hasBindings = true;
    pullState.bindingsCheckedAt = Date.now();
  }
}

interface PullButtonOpts {
  client: GatewayBrowserClient | undefined;
  pullState: NotionPullState;
  role?: string;
  dbId?: string;
  businessId?: string;
  /** Called after a successful pull — typically reloads local data. */
  onSuccess?: () => void | Promise<void>;
  requestUpdate: () => void;
  /** Button label override (default: "Pull from Notion"). */
  label?: string;
  /** Hide the button if no matching binding exists. Default true. */
  hideIfNoBinding?: boolean;
  /** Optional class merged into the button element. */
  className?: string;
}

export function renderNotionPullButton(opts: PullButtonOpts): TemplateResult {
  const {
    client,
    pullState,
    role,
    dbId,
    businessId,
    onSuccess,
    requestUpdate,
    label = "Pull from Notion",
    hideIfNoBinding = true,
    className = "",
  } = opts;

  if (!client) return html``;

  // Kick off a binding check on first render so we know whether to show
  // the button. Async — initial render hides nothing while the check
  // runs, so the operator doesn't see a flash.
  if (pullState.hasBindings === null) {
    void ensureBindingsKnown(client, pullState, { role, dbId, businessId }).then(requestUpdate);
  }

  if (hideIfNoBinding && pullState.hasBindings === false) return html``;

  const handleClick = async () => {
    if (pullState.pulling) return;
    pullState.pulling = true;
    pullState.lastError = null;
    requestUpdate();

    try {
      const params: Record<string, unknown> = {};
      if (dbId) params.dbId = dbId;
      if (role) params.role = role;
      if (businessId) params.businessId = businessId;
      const res = (await client.request("notion.import.refresh", params)) as {
        ok?: boolean;
        refreshed?: Array<{ dbId: string; role: string; title?: string | null }>;
        result?: Record<string, unknown>;
      };
      const refreshed = res.refreshed ?? [];
      const titles = refreshed.map((r) => r.title || r.dbId.slice(0, 8)).slice(0, 3).join(", ");
      pullState.lastPullAt = Date.now();
      pullState.lastPullSummary = refreshed.length === 1
        ? `Pulled ${titles}`
        : `Pulled ${refreshed.length} DB${refreshed.length === 1 ? "" : "s"}${titles ? ` (${titles}${refreshed.length > 3 ? "…" : ""})` : ""}`;
      if (onSuccess) await onSuccess();
    } catch (err) {
      pullState.lastError = err instanceof Error ? err.message : String(err);
    } finally {
      pullState.pulling = false;
      requestUpdate();
    }
  };

  return html`
    <button
      class="notion-pull-btn ${className}"
      ?disabled=${pullState.pulling}
      title=${pullState.lastError
        ? `Last error: ${pullState.lastError}`
        : pullState.lastPullSummary
          ? pullState.lastPullSummary
          : "Force a fresh pull of every connected Notion database for this page"}
      @click=${handleClick}
    >
      <span class="notion-pull-btn__icon ${pullState.pulling ? "spinning" : ""}">
        ${pullState.pulling ? "⟳" : "⤓"}
      </span>
      <span class="notion-pull-btn__label">
        ${pullState.pulling
          ? "Pulling…"
          : label}
      </span>
      ${pullState.lastError
        ? html`<span class="notion-pull-btn__err" title=${pullState.lastError}>!</span>`
        : nothing}
    </button>
  `;
}

/** CSS the consuming page should drop into its style block. */
export const notionPullStyles = `
  .notion-pull-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    background: color-mix(in srgb, #8b5cf6 22%, transparent);
    border: 1px solid color-mix(in srgb, #8b5cf6 45%, transparent);
    color: #c4b5fd;
    border-radius: 8px;
    cursor: pointer;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.4px;
    text-transform: uppercase;
    transition: background 0.12s ease, border-color 0.12s ease, transform 0.08s ease;
  }
  .notion-pull-btn:hover:not(:disabled) {
    background: color-mix(in srgb, #8b5cf6 32%, transparent);
    border-color: color-mix(in srgb, #8b5cf6 60%, transparent);
    color: #ddd6fe;
  }
  .notion-pull-btn:active:not(:disabled) { transform: translateY(1px); }
  .notion-pull-btn:disabled { opacity: 0.7; cursor: progress; }
  .notion-pull-btn__icon {
    display: inline-block;
    font-size: 14px;
    line-height: 1;
  }
  .notion-pull-btn__icon.spinning {
    animation: notion-pull-spin 0.9s linear infinite;
  }
  @keyframes notion-pull-spin {
    from { transform: rotate(0deg); }
    to   { transform: rotate(360deg); }
  }
  .notion-pull-btn__err {
    display: inline-block;
    width: 16px; height: 16px;
    border-radius: 50%;
    background: rgba(239, 68, 68, 0.25);
    color: #fca5a5;
    font-weight: 700;
    text-align: center;
    line-height: 16px;
    font-size: 10px;
  }
`;
