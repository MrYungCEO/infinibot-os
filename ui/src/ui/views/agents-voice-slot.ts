/**
 * Voice slot for the Agents page detail drawer ("Voice" tab).
 *
 * The Agents page owns the tab; this module owns what renders inside it.
 *
 * Built in (robovoice:voice-slot): when the Robovoice plugin is enabled the
 * tab shows its <robovoice-agent-voice> card (voice-agent toggle, answers-with,
 * backend, TTS voice, test turn); otherwise a neutral note. The component is
 * lazy-loaded the first time the tab renders with the plugin on, so the Agents
 * page carries no Robovoice code until it's needed.
 *
 * Another voice provider can replace the built-in renderer at startup:
 *
 *   import { registerAgentVoiceSlot } from "./agents-voice-slot";
 *   registerAgentVoiceSlot((ctx) => html`<my-agent-voice-settings .agentId=${ctx.agentId}></my-agent-voice-settings>`);
 *
 * The renderer gets the agent id/name/type plus the app state + client, and
 * should call `ctx.requestUpdate()` after saving. Voice stays core; nothing is
 * "skipped" — the default voice pipeline keeps working for every agent.
 */

import { html, type TemplateResult } from "lit";
import type { AppViewState } from "../app-view-state";
import type { GatewayBrowserClient } from "../gateway";
import { PLUGIN_HOST_EVENT, isTabAvailable } from "../plugin-host.js";

export interface AgentVoiceSlotContext {
  agentId: string;
  agentName: string;
  agentType: "native" | "cli";
  state: AppViewState;
  client: GatewayBrowserClient;
  requestUpdate: () => void;
}

export type AgentVoiceSlotRenderer = (ctx: AgentVoiceSlotContext) => TemplateResult | null;

let registered: AgentVoiceSlotRenderer | null = null;
const listeners = new Set<() => void>();

function notify() {
  for (const l of listeners) l();
}

/** Register (or replace) the Voice tab renderer. Returns an unregister function. */
export function registerAgentVoiceSlot(fn: AgentVoiceSlotRenderer): () => void {
  registered = fn;
  notify();
  return () => {
    if (registered === fn) {
      registered = null;
      notify();
    }
  };
}

/** True when the Robovoice plugin (and so the built-in slot's backend) is on. */
export function isAgentVoiceSlotAvailable(): boolean {
  return isTabAvailable("robovoice");
}

let robovoiceLoaded: Promise<unknown> | null = null;

/** Microphone glyph for the empty states (glass orb, currentColor). */
const MIC_ICON = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M8.5 21h7"/></svg>`;

/** Built-in renderer: Robovoice voice-agent card, or a neutral note when it's off. */
export function renderAgentVoiceSlot(agentId: string): TemplateResult {
  if (!isAgentVoiceSlotAvailable()) {
    return html`<div class="gt-empty agp-voice-empty" data-testid="agent-voice-slot-off">
      <div class="gt-empty-orb">${MIC_ICON}</div>
      <div class="gt-empty-title">Give this agent a voice</div>
      <p class="gt-empty-sub">Per-agent voice agents run on the Robovoice plugin. Turn it on in Setup › Plugins to give this agent a Robovoice voice. The default voice pipeline keeps working for every agent.</p>
      <span class="gt-chip"><span class="gt-light" data-state="idle"></span>Robovoice off</span>
    </div>`;
  }
  if (agentId.startsWith("cli:")) {
    // Virtual CLI-coder nodes aren't roster agents; they're a voice agent's backend.
    return html`<div class="gt-empty agp-voice-empty" data-testid="agent-voice-slot-cli">
      <div class="gt-empty-orb">${MIC_ICON}</div>
      <div class="gt-empty-title">Voice runs through a roster agent</div>
      <p class="gt-empty-sub">This CLI coder isn't a roster agent, so it has no voice agent of its own. Pick it as the <b>Backend</b> in a roster agent's Voice tab to have it answer Robovoice calls.</p>
    </div>`;
  }
  robovoiceLoaded ??= import("../components/robovoice-agent-voice.js");
  return html`<div class="agp-voice-card" data-testid="agent-voice-slot">
    <robovoice-agent-voice variant="card" agent-id=${agentId}></robovoice-agent-voice>
  </div>`;
}

const builtin: AgentVoiceSlotRenderer = (ctx) => renderAgentVoiceSlot(ctx.agentId);

/** The active renderer: a registered provider, else the built-in Robovoice slot. */
export function getAgentVoiceSlot(): AgentVoiceSlotRenderer {
  return registered ?? builtin;
}

let hostListening = false;

/**
 * The Agents page re-renders when a renderer registers after it mounted, or
 * when the plugin host changes (Robovoice turned on/off while the tab is open).
 */
export function onAgentVoiceSlotChange(fn: () => void): () => void {
  listeners.add(fn);
  if (!hostListening && typeof window !== "undefined") {
    hostListening = true;
    window.addEventListener(PLUGIN_HOST_EVENT, notify);
  }
  return () => {
    listeners.delete(fn);
    if (!listeners.size && hostListening) {
      hostListening = false;
      window.removeEventListener(PLUGIN_HOST_EVENT, notify);
    }
  };
}
