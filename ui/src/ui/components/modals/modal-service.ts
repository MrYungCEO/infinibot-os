/**
 * Unified modal service — the single entry point for the global detail-modal
 * + card system (project / client / task / portfolio).
 *
 * Design mirrors branding-modal.ts: each modal file owns its own module-level
 * state and imperative open/close/render. This service is the *facade* that
 * ties them together so any caller — a view, a controller, an agent via the
 * gateway, or a devtools `window.infinibotModals.openProject(id)` — can open a
 * modal without threading the gateway client or a re-render callback through
 * every layer.
 *
 * Call `initModalService(client, rerender)` once (from app-render.ts, on every
 * render pass — it's idempotent) to hand the service the live gateway client +
 * the app's requestUpdate. After that:
 *   openProjectModal(id) / openClientModal(id) / openTaskModal(id) /
 *   openPortfolioModal(filter?) / closeModal(id) / closeAllModals()
 *
 * Data is fetched lazily inside each modal's opener (kanban.projects.list,
 * kanban.tasks.list, clients.list). Assignee/agent badges are resolved at
 * render time from AppViewState.agentsList, so the render functions take
 * `state`.
 */

import type { GatewayBrowserClient } from "../../gateway.js";

// Side-effect import: Vite injects the shared glassmorphism stylesheet once.
import "./modal-styles.css";

import {
  openProjectDetailModal,
  closeProjectDetailModal,
  isProjectDetailOpen,
} from "./project-detail-modal.js";
import {
  openClientDetailModal,
  closeClientDetailModal,
  isClientDetailOpen,
} from "./client-card-modal.js";
import {
  openTaskDetailModal,
  closeTaskDetailModal,
  isTaskDetailOpen,
} from "./task-detail-modal.js";
import {
  openPortfolioModal as openPortfolioModalImpl,
  closePortfolioModal,
  isPortfolioOpen,
} from "./portfolio-view-modal.js";

// ── Shared context ──────────────────────────────────────────────────────────
export interface ModalContext {
  client: GatewayBrowserClient;
  rerender: () => void;
}

export type ModalId = "project" | "client" | "task" | "portfolio";

let _ctx: ModalContext | null = null;

/** Handle to the live context; individual modal files read this at open time. */
export function getModalContext(): ModalContext | null {
  return _ctx;
}

let _escInstalled = false;

/**
 * Wire the service with the live gateway client + app re-render. Idempotent —
 * safe to call on every render pass (app-render.ts does). Also installs a
 * single document-level ESC handler that closes the top-most open modal, and
 * exposes `window.infinibotModals` so agents / devtools can drive it.
 */
export function initModalService(
  client: GatewayBrowserClient,
  rerender: () => void,
): void {
  _ctx = { client, rerender };

  if (!_escInstalled && typeof document !== "undefined") {
    _escInstalled = true;
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      // Close only the top-most modal so a project→client→task drill unwinds
      // one layer per ESC instead of nuking the whole stack.
      if (isTaskDetailOpen()) { closeTaskDetailModal(); e.stopPropagation(); }
      else if (isClientDetailOpen()) { closeClientDetailModal(); e.stopPropagation(); }
      else if (isProjectDetailOpen()) { closeProjectDetailModal(); e.stopPropagation(); }
      else if (isPortfolioOpen()) { closePortfolioModal(); e.stopPropagation(); }
      else return;
      _ctx?.rerender();
    });
  }

  if (typeof window !== "undefined") {
    (window as unknown as { infinibotModals?: unknown }).infinibotModals = {
      openProject: openProjectModal,
      openClient: openClientModal,
      openTask: openTaskModal,
      openPortfolio: openPortfolioModal,
      close: closeModal,
      closeAll: closeAllModals,
    };
  }
}

function requireCtx(): ModalContext | null {
  if (!_ctx) {
    console.warn("[modal-service] not initialized — call initModalService() first");
    return null;
  }
  return _ctx;
}

// ── Facade openers ──────────────────────────────────────────────────────────
export function openProjectModal(projectId: string): void {
  const ctx = requireCtx();
  if (ctx) openProjectDetailModal(projectId, ctx);
}

export function openClientModal(clientId: string): void {
  const ctx = requireCtx();
  if (ctx) openClientDetailModal(clientId, ctx);
}

export function openTaskModal(taskId: string): void {
  const ctx = requireCtx();
  if (ctx) openTaskDetailModal(taskId, ctx);
}

export function openPortfolioModal(filter?: string): void {
  const ctx = requireCtx();
  if (ctx) openPortfolioModalImpl(ctx, filter);
}

export function closeModal(id: ModalId): void {
  switch (id) {
    case "project": closeProjectDetailModal(); break;
    case "client": closeClientDetailModal(); break;
    case "task": closeTaskDetailModal(); break;
    case "portfolio": closePortfolioModal(); break;
  }
  _ctx?.rerender();
}

export function closeAllModals(): void {
  closeTaskDetailModal();
  closeClientDetailModal();
  closeProjectDetailModal();
  closePortfolioModal();
  _ctx?.rerender();
}

// ════════════════════════════════════════════════════════════════════════════
// Shared render helpers (pure — no imports, safe under the service↔modal cycle)
// ════════════════════════════════════════════════════════════════════════════

/** Kanban task status → accent colour + label. */
export function taskStatusColor(status?: string): { color: string; label: string } {
  switch ((status ?? "").toLowerCase()) {
    case "done": return { color: "#22c55e", label: "Done" };
    case "in_progress": return { color: "#3b82f6", label: "In Progress" };
    case "review": return { color: "#a78bfa", label: "Review" };
    case "todo": return { color: "#eab308", label: "To Do" };
    case "backlog": return { color: "#71717a", label: "Backlog" };
    default: return { color: "#71717a", label: status || "—" };
  }
}

/** Notion-style project status → accent colour. */
export function projectStatusColor(status?: string): string {
  switch ((status ?? "").toLowerCase()) {
    case "completed": return "#22c55e";
    case "in progress": return "#3b82f6";
    case "reviewing": return "#a78bfa";
    case "awaiting client": return "#eab308";
    case "paused": return "#f97316";
    case "updating": return "#06b6d4";
    case "cancelled": return "#ef4444";
    default: return "#71717a"; // Not started / unknown
  }
}

/** Priority → accent colour. Accepts Notion ("High") + kanban ("high"). */
export function priorityColor(priority?: string): string {
  switch ((priority ?? "").toLowerCase()) {
    case "immediate":
    case "critical": return "#ef4444";
    case "high": return "#f97316";
    case "medium":
    case "normal": return "#eab308";
    case "low": return "#22c55e";
    default: return "#71717a";
  }
}

/** Deterministic avatar background from an arbitrary key. */
export function avatarColor(key: string): string {
  const palette = [
    "#6366f1", "#8b5cf6", "#ec4899", "#f43f5e", "#f97316",
    "#eab308", "#22c55e", "#14b8a6", "#06b6d4", "#3b82f6",
  ];
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) | 0;
  return palette[Math.abs(hash) % palette.length];
}

/** Up-to-two-letter initials from a name. */
export function initials(name?: string): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** ISO/epoch → short human date, or "" when absent/invalid. */
export function formatDate(value?: string | number): string {
  if (value === undefined || value === null || value === "") return "";
  const d = typeof value === "number" ? new Date(value) : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
