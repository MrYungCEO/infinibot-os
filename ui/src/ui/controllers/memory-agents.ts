/**
 * Memory › Agents → existing identity editor bridge: switch the Memory host to
 * its "Memory" sub-tab, select the agent in the Agent Identity Files section
 * and open the file in its editor (missing files open empty; saving creates).
 */

import type { AppViewState } from "../app-view-state.js";

export async function openAgentIdentityFile(
  state: AppViewState,
  agentId: string,
  filename: string,
): Promise<void> {
  const client = state.client;
  state.setHostView("memory");
  if (!client) return;
  const m = await import("./agent-identity.js");
  if (!state.agentIdentityState?.agents?.length) await m.loadIdentityAgents(state, client);
  await m.selectIdentityAgent(state, client, agentId);
  await m.openIdentityFile(state, client, filename);
  // Bring the editor into view once the Memory sub-tab has rendered.
  requestAnimationFrame(() => {
    const host = state as unknown as { renderRoot?: ParentNode };
    const el =
      host.renderRoot?.querySelector?.("#agent-identity-files") ??
      document.getElementById("agent-identity-files");
    el?.scrollIntoView({ block: "start", behavior: "smooth" });
  });
}
