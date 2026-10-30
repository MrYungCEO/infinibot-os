/**
 * Object thread navigation — the back-stack + breadcrumb that turns the
 * business graph into something you can walk without losing your place.
 *
 * THE PROBLEM
 * Every object surface was a dead end. Open a client, see it is linked to an
 * opportunity, and the only way to look at that opportunity was to leave
 * /clients for /opportunity, find it again, and lose the client you came from.
 * Connections that cost you your context are connections nobody follows.
 *
 * THE MODEL
 * A single ordered stack of `{ type, id, label }`. The first entry is the
 * surface you entered from (a client); each drill-in pushes. The breadcrumb
 * renders the stack (Client › Opportunity › Project) and every crumb is a
 * clickable truncation point, so you can jump back two levels in one click
 * rather than pressing Back three times.
 *
 * HISTORY
 * The stack is mirrored into the URL as a `?thread=` query param, NOT as extra
 * path segments. The app's router (navigation.ts `matchRoute`) parses the
 * pathname to resolve tab + entity detail and ignores the query string, so a
 * thread rides along on the client's own `/clients/:slug` URL without the
 * router ever having to learn about it. That means:
 *   - Back / Forward work, because each push is a real history entry
 *     (ux-guidelines: "preserve navigation history properly" — pushState, not
 *     location.replace)
 *   - a pasted URL restores the whole thread, not just the root
 *   - zero risk of a thread URL 404ing into the dashboard
 *
 * A single module-level popstate listener reconciles the stack with whatever
 * depth the history entry carries.
 */

import { html, nothing, type TemplateResult } from "lit";
import type { AppViewState } from "../app-view-state";

export interface ThreadNode {
  type: string;
  id: string;
  label: string;
}

/** The live thread. Index 0 is the surface the user entered from. */
let stack: ThreadNode[] = [];
/** Host we call requestUpdate on from the popstate listener. */
let host: AppViewState | null = null;
/**
 * How many history entries this thread has pushed. Lets a breadcrumb click
 * TRAVERSE history (history.go) instead of pushing yet another entry — so the
 * breadcrumb and the browser Back button are the same gesture rather than two
 * competing stacks that drift out of sync.
 */
let historyPushes = 0;
let listenerAttached = false;

const THREAD_PARAM = "thread";

// ── URL serialization ────────────────────────────────────────────────

/**
 * Serialize everything ABOVE the root. The root is already addressed by the
 * pathname (`/clients/:slug`), so repeating it in the query would make Back
 * from depth 1 ambiguous.
 */
function serialize(nodes: ThreadNode[]): string {
  return nodes
    .slice(1)
    .map((n) => `${n.type}:${n.id}`)
    .join(",");
}

function parseThreadParam(raw: string): Array<{ type: string; id: string }> {
  return raw
    .split(",")
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const i = chunk.indexOf(":");
      if (i <= 0) return null;
      return { type: chunk.slice(0, i), id: chunk.slice(i + 1) };
    })
    .filter((v): v is { type: string; id: string } => v !== null);
}

/** Read the pending thread from the current URL. */
function pendingThreadFromUrl(): Array<{ type: string; id: string }> {
  if (typeof window === "undefined") return [];
  const raw = new URL(window.location.href).searchParams.get(THREAD_PARAM);
  return raw ? parseThreadParam(raw) : [];
}

/**
 * The thread carried by the URL the page was LOADED with.
 *
 * Snapshotted at module-import time, which is the only moment it is reliably
 * readable: opening the record calls `threadRoot`, which rewrites the URL to
 * the (empty) root thread and so erases the very deep link it is meant to
 * restore. Reading it later means reading it after it is gone.
 */
const bootThread: Array<{ type: string; id: string }> = pendingThreadFromUrl();
let bootThreadConsumed = false;

/**
 * Take the boot-time thread, exactly once. Returns [] on every later call so a
 * re-render cannot replay the deep link over a thread the user has since
 * navigated.
 */
export function consumeBootThread(): Array<{ type: string; id: string }> {
  if (bootThreadConsumed) return [];
  bootThreadConsumed = true;
  return bootThread;
}

function syncUrl(replace: boolean): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  const value = serialize(stack);
  if (value) url.searchParams.set(THREAD_PARAM, value);
  else url.searchParams.delete(THREAD_PARAM);
  const state = { ibThreadDepth: stack.length };
  if (replace) window.history.replaceState(state, "", url.toString());
  else window.history.pushState(state, "", url.toString());
}

/**
 * Reconcile the stack with a history entry. Back from depth 3 lands on a state
 * carrying depth 2, so we truncate rather than rebuild — the node metadata
 * (labels) we already resolved stays intact.
 */
function attachListener(): void {
  if (listenerAttached || typeof window === "undefined") return;
  listenerAttached = true;
  window.addEventListener("popstate", (ev) => {
    if (stack.length === 0) return;
    const raw = new URL(window.location.href).searchParams.get(THREAD_PARAM);
    const depth = raw ? parseThreadParam(raw).length + 1 : 1;
    const stateDepth = (ev.state as { ibThreadDepth?: number } | null)?.ibThreadDepth;
    const target = typeof stateDepth === "number" ? stateDepth : depth;
    if (target < 1) return;
    historyPushes = target - 1;
    if (target < stack.length) {
      stack = stack.slice(0, target);
      host?.requestUpdate?.();
    }
  });
}

// ── Stack API ────────────────────────────────────────────────────────

/**
 * Start (or restart) a thread at `root`. Called when a record surface opens.
 * Replaces rather than pushes: opening a client already pushed its own history
 * entry via pushEntityUrl, and a second entry for the same view would make
 * Back a no-op.
 */
export function threadRoot(state: AppViewState, root: ThreadNode): void {
  host = state;
  attachListener();
  stack = [root];
  historyPushes = 0;
  syncUrl(true);
}

/** Drill into a connected object. */
export function threadPush(state: AppViewState, node: ThreadNode): void {
  host = state;
  attachListener();
  // Re-entering a node already on the thread truncates back to it instead of
  // growing a cycle (Client › Opportunity › Client › Opportunity › …).
  const existing = stack.findIndex((n) => n.type === node.type && n.id === node.id);
  if (existing >= 0) {
    stack = stack.slice(0, existing + 1);
    // A truncating re-entry is a step BACK, so give back the entries it undid.
    historyPushes = Math.max(0, existing);
    syncUrl(true);
    state.requestUpdate?.();
    return;
  } else {
    stack = [...stack, node];
  }
  historyPushes += 1;
  syncUrl(false);
  state.requestUpdate?.();
}

/**
 * Truncate the thread to `index` (a breadcrumb click, or the Back affordance).
 *
 * Traverses real history when this thread owns enough entries, so a breadcrumb
 * click IS a browser Back — pushing a new entry instead would mean the two
 * stacks disagreed, and pressing browser Back after a breadcrumb click would
 * take you DEEPER. The popstate listener does the truncation in that path.
 * The replaceState branch is the fallback for when the entries are gone (a
 * restored `?thread=` deep link has depth but no history behind it).
 */
export function threadPopTo(state: AppViewState, index: number): void {
  if (index < 0 || index >= stack.length - 1) return;
  const delta = stack.length - 1 - index;
  if (typeof window !== "undefined" && historyPushes >= delta) {
    historyPushes -= delta;
    window.history.go(-delta);
    return;
  }
  stack = stack.slice(0, index + 1);
  syncUrl(true);
  state.requestUpdate?.();
}

/** Step back one level. Returns false when already at the root. */
export function threadBack(state: AppViewState): boolean {
  if (stack.length <= 1) return false;
  threadPopTo(state, stack.length - 2);
  return true;
}

/** Drop the thread entirely (the record surface closed). */
export function threadClear(): void {
  stack = [];
  historyPushes = 0;
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (url.searchParams.has(THREAD_PARAM)) {
    url.searchParams.delete(THREAD_PARAM);
    window.history.replaceState({ ibThreadDepth: 0 }, "", url.toString());
  }
}

/** The node currently being viewed, or null when no thread is open. */
export function threadTop(): ThreadNode | null {
  return stack.length ? stack[stack.length - 1]! : null;
}

export function threadStack(): readonly ThreadNode[] {
  return stack;
}

export function threadDepth(): number {
  return stack.length;
}

/** True when the user has drilled past the root (so a focus view is showing). */
export function threadIsDrilled(): boolean {
  return stack.length > 1;
}

/** Patch a crumb's label once its object resolves (pushed refs start as ids). */
export function threadRelabel(type: string, id: string, label: string): void {
  let changed = false;
  stack = stack.map((n) => {
    if (n.type === type && n.id === id && n.label !== label) {
      changed = true;
      return { ...n, label };
    }
    return n;
  });
  if (changed) host?.requestUpdate?.();
}

// ── Breadcrumb ───────────────────────────────────────────────────────

const TYPE_GLYPH: Record<string, string> = {
  client: "◆",
  opportunity: "◇",
  project: "▣",
  task: "▸",
  product: "◈",
  decision: "⚖",
  risk: "⚠",
  commitment: "$",
  person: "☺",
  issue: "!",
  report: "▤",
  lead: "✦",
  funnel: "▽",
};

const TYPE_NAME: Record<string, string> = {
  client: "Client",
  opportunity: "Opportunity",
  project: "Project",
  task: "Task",
  product: "Product",
  decision: "Decision",
  risk: "Risk",
  commitment: "Commitment",
  person: "Person",
  issue: "Issue",
  report: "Report",
  lead: "Lead",
  funnel: "Funnel",
};

export function threadTypeGlyph(type: string): string {
  return TYPE_GLYPH[type] ?? "○";
}

export function threadTypeName(type: string): string {
  return TYPE_NAME[type] ?? type;
}

/**
 * The breadcrumb thread bar.
 *
 * `onExit` fires when the user leaves the whole thread (the leading crumb, e.g.
 * "← Clients"). Every intermediate crumb truncates to itself; the last crumb is
 * the current view and is rendered as static text with an active treatment
 * (ux-guidelines Navigation/Active State: the current location must be visually
 * indicated, not just implied by position).
 */
export function renderThreadBreadcrumb(
  state: AppViewState,
  opts: { exitLabel: string; onExit: () => void },
): TemplateResult {
  const crumbs = stack;
  const drilled = crumbs.length > 1;

  return html`
    <div class="crm-thread-bar" role="navigation" aria-label="Record thread">
      <button
        class="crm-thread-exit"
        title=${drilled ? "Leave this thread" : opts.exitLabel}
        @click=${() => {
          threadClear();
          opts.onExit();
        }}
      >
        ← ${opts.exitLabel}
      </button>
      ${drilled
        ? html`
            <button
              class="crm-thread-back"
              title="Back one step"
              @click=${() => threadBack(state)}
            >
              ↩ Back
            </button>
          `
        : nothing}
      <ol class="crm-thread-crumbs">
        ${crumbs.map((n, i) => {
          const last = i === crumbs.length - 1;
          return html`
            <li class="crm-thread-crumb-item">
              ${i > 0 ? html`<span class="crm-thread-sep" aria-hidden="true">›</span>` : nothing}
              ${last
                ? html`<span class="crm-thread-crumb is-current" aria-current="page">
                    <span class="crm-thread-glyph">${threadTypeGlyph(n.type)}</span>
                    <span class="crm-thread-kind">${threadTypeName(n.type)}</span>
                    <span class="crm-thread-label">${n.label}</span>
                  </span>`
                : html`<button
                    class="crm-thread-crumb"
                    title=${`Back to ${n.label}`}
                    @click=${() => threadPopTo(state, i)}
                  >
                    <span class="crm-thread-glyph">${threadTypeGlyph(n.type)}</span>
                    <span class="crm-thread-kind">${threadTypeName(n.type)}</span>
                    <span class="crm-thread-label">${n.label}</span>
                  </button>`}
            </li>
          `;
        })}
      </ol>
      ${drilled
        ? html`<span class="crm-thread-depth" title="Steps from the record you started on">
            ${crumbs.length - 1} deep
          </span>`
        : nothing}
    </div>
  `;
}
