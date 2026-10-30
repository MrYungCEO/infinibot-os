/**
 * Plugin topbar slots (`contributes.topbarSlots`, docs/plugins/TOPBAR-SLOTS.md).
 *
 * A loaded plugin can add a control to the app topbar. `builtin` names a
 * renderer compiled into the control UI (below); unknown builtins render
 * nothing, so a manifest can never inject markup. A disabled plugin — or a
 * slot the owner switched off in Setup › Plugins — leaves the topbar.
 */

import { html, nothing, type TemplateResult } from "lit";

import type { AppViewState } from "../app-view-state";
import { pluginTopbarSlots, type PluginTopbarSlot } from "../plugin-host.js";
import { renderAgencySwitcher } from "./agency-switcher";

type SlotRenderer = (state: AppViewState) => TemplateResult | typeof nothing;

/** First-party topbar renderers, keyed by the manifest's `builtin`. */
export const TOPBAR_SLOT_RENDERERS: Readonly<Record<string, SlotRenderer>> = {
  // Business & Agency plugin: the active-agency picker (scopes projects,
  // clients, workforce and personas while the plugin is on).
  "agency-selector": (state) => renderAgencySwitcher(state),
  // Solatrix plugin: active wallet balance chip + wallets/funding popover.
  // Lazy: the element (and its styles) load only once the plugin is on. It
  // renders nothing (data-cb-empty) until at least one wallet exists.
  "solatrix-wallet": (state) => {
    void import("../../../../extensions/solatrix/ui/wallet-chip.js");
    return html`<solatrix-wallet-chip .client=${state.client ?? null} .basePath=${state.basePath ?? ""}></solatrix-wallet-chip>`;
  },
  // Infinitrade plugin: read-only open P&L + balance chip of the connected
  // TradeLocker account (hidden until an account is connected).
  "infinitrade-pnl": (state) => {
    void import("../../../../extensions/infinitrade/ui/topbar-chip.js");
    return html`<infinitrade-pnl-chip .client=${state.client ?? null} .basePath=${state.basePath ?? ""}></infinitrade-pnl-chip>`;
  },
};

/**
 * Render one slot, or nothing for an unknown builtin. The wrapper is
 * `display: contents` so the control lays out exactly as a direct topbar
 * child (no extra flex box); it only carries the slot/scope attributes.
 */
export function renderTopbarSlot(state: AppViewState, slot: PluginTopbarSlot) {
  const render = TOPBAR_SLOT_RENDERERS[slot.builtin];
  if (!render) return nothing;
  return html`<span
    class="topbar-slot"
    data-topbar-slot=${slot.key}
    data-plugin-scope=${slot.pluginId}
    style="display:contents"
    >${render(state)}</span
  >`;
}

/**
 * Every loaded plugin's topbar controls for one group, in slot order. Left
 * slots sit in the control bar's "agency" item; right slots in "plugin-right".
 */
export function renderTopbarSlots(state: AppViewState, placement: "left" | "right" = "left") {
  const slots = pluginTopbarSlots().filter((s) => (s.placement ?? "left") === placement);
  if (!slots.length) return nothing;
  return html`${slots.map((slot) => renderTopbarSlot(state, slot))}`;
}
