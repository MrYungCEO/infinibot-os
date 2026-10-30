/**
 * CoderBackendPill — topbar badge showing the active coding backend.
 *
 * Placement: topbar-left, after the satellite pill.
 * Click → navigate to Setup → Coding Backend section.
 * Updates live via the `infinibot:coder-backend-changed` CustomEvent.
 *
 * The pill colour + logo come from the shared brand kit so the topbar matches
 * the activity-feed badges for the same backend.
 *
 * COORDINATION: opencode-swap — new file. Do NOT place near the notification bell.
 */

import { html } from "lit";
import type { AppViewState } from "../app-view-state.js";
import { pathForTab } from "../navigation.js";
import {
  getCoderBackendBrand,
  isCoderBackendId,
  type CoderBackendId,
} from "../lib/coder-backend-brand.js";

/** Navigate to Setup → Coding Backend section, dispatching an event so the
 *  setup view can switch to that section automatically. */
function navigateToCoderBackend(basePath: string): void {
  window.history.pushState({}, "", pathForTab("setup", basePath));
  window.dispatchEvent(new PopStateEvent("popstate"));
  // Signal the setup view to activate the coder-backend section
  window.dispatchEvent(
    new CustomEvent("infinibot:setup-section", { detail: { section: "coder-backend" } }),
  );
}

export function renderCoderBackendPill(state: AppViewState): ReturnType<typeof html> {
  // One-time lazy load
  if (
    state.client &&
    !(state as Record<string, unknown>)._coderPillLoaded &&
    !(state as Record<string, unknown>)._coderPillPending
  ) {
    (state as Record<string, unknown>)._coderPillPending = true;
    fetch("/api/coder/backend")
      .then((r) => r.json())
      .then((res: Record<string, unknown>) => {
        const raw = res?.backend;
        (state as Record<string, unknown>)._coderPillBackend = isCoderBackendId(raw)
          ? raw
          : "claude-code";
        (state as Record<string, unknown>)._coderPillLoaded = true;
        (state as Record<string, unknown>)._coderPillPending = false;
        state.requestUpdate?.();
      })
      .catch(() => {
        (state as Record<string, unknown>)._coderPillLoaded = true;
        (state as Record<string, unknown>)._coderPillPending = false;
      });
  }

  // Subscribe to live backend-change events (once)
  if (
    !(state as Record<string, unknown>)._coderPillListening &&
    typeof window !== "undefined"
  ) {
    (state as Record<string, unknown>)._coderPillListening = true;
    window.addEventListener("infinibot:coder-backend-changed", (ev: Event) => {
      const detail = (ev as CustomEvent<{ backend: CoderBackendId }>).detail;
      const next = detail?.backend;
      (state as Record<string, unknown>)._coderPillBackend = isCoderBackendId(next)
        ? next
        : "claude-code";
      state.requestUpdate?.();
    });
  }

  const raw = (state as Record<string, unknown>)._coderPillBackend;
  const backend: CoderBackendId = isCoderBackendId(raw) ? raw : "claude-code";
  const brand = getCoderBackendBrand(backend);

  return html`
    <div
      class="pill topbar-coder-pill"
      title="Coding backend: ${brand.label} · Click to change"
      style="color:${brand.accent}; border-color:color-mix(in srgb, ${brand.accent} 45%, transparent); background:${brand.tone};"
      @click=${() => navigateToCoderBackend((state as Record<string, unknown>).basePath as string ?? "")}
    >
      ${brand.icon}
      <span class="topbar-coder-label">${brand.shortLabel}</span>
    </div>
  `;
}
