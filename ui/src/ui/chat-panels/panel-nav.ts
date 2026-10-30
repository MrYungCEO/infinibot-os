/**
 * Chat panel navigation + data helpers shared by the inline card and the modal.
 */
import { getGatewayClient } from "../gateway-client";
import { inferBasePathFromPathname, pathForTab, type Tab } from "../navigation";
import type { ChatPanelRef, PanelLink, PanelResult } from "./panel-ref";

export const PANEL_OPEN_EVENT = "chat-panel-open";
/** Re-dispatched by the host for every `chat.panel.show` broadcast (voice transcript listens). */
export const PANEL_SHOWN_EVENT = "chat-panel-shown";

export function hasLink(link?: PanelLink | null): boolean {
  return Boolean(link && (link.path || link.tab || link.action));
}

/** Route hop to the panel's full page (or the Agent Focus modal for runs). */
export function openPanelLink(link: PanelLink): void {
  if (link.action === "agent-focus") {
    const params = link.actionParams ?? {};
    const w = window as unknown as { openAgentFocus?: (t: unknown) => void };
    if (typeof w.openAgentFocus === "function") w.openAgentFocus(params);
    else window.dispatchEvent(new CustomEvent("infinibot:open-agent-focus", { detail: params }));
    return;
  }
  const base = inferBasePathFromPathname(window.location.pathname);
  const path = link.path ? `${base}${link.path}` : link.tab ? pathForTab(link.tab as Tab, base) : "";
  if (!path) return;
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

/** Ask the global <chat-panel-host> to open a panel as a modal. */
export function openPanelModal(ref: ChatPanelRef, initial?: PanelResult | null): void {
  window.dispatchEvent(new CustomEvent(PANEL_OPEN_EVENT, { detail: { ref, initial: initial ?? null } }));
}

export async function refreshPanel(ref: Pick<ChatPanelRef, "kind" | "query" | "title">): Promise<PanelResult> {
  const client = getGatewayClient();
  if (!client) throw new Error("Not connected to the gateway");
  return (await client.request("chat.panel.refresh", {
    kind: ref.kind,
    query: ref.query,
    title: ref.title,
  })) as PanelResult;
}

/** The one write a panel performs: task status change via the existing kanban RPC. */
export async function updateTaskStatus(taskId: string, status: string): Promise<void> {
  const client = getGatewayClient();
  if (!client) throw new Error("Not connected to the gateway");
  await client.request("kanban.tasks.update", { id: taskId, patch: { status } });
}

export function timeAgo(v: unknown): string {
  const t = typeof v === "number" ? v : Date.parse(String(v ?? ""));
  if (!t || Number.isNaN(t)) return "";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function money(n?: number): string {
  const v = Number(n) || 0;
  const sign = v < 0 ? "-" : "";
  const a = Math.abs(v);
  if (a >= 1_000_000) return `${sign}$${(a / 1_000_000).toFixed(1)}M`;
  if (a >= 1000) return `${sign}$${(a / 1000).toFixed(1)}k`;
  return `${sign}$${Math.round(a)}`;
}
