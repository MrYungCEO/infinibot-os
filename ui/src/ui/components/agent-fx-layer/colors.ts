/**
 * Colour tables for <agent-fx-layer>.
 *
 * Two independent palettes:
 *   - STATUS colours drive the glow ring + status-change burst (semantic).
 *   - BACKEND colours drive the particle trail (provider identity), matching
 *     the per-backend accents the world viz already uses.
 *
 * Status synonyms are normalised so both the dashboard MeshAgent.status values
 * ('working' | 'idle' | 'blocked' | 'finishing' | 'completed' | 'failed' |
 * 'starting') and looser strings ('running', 'error', 'done') land on a sane
 * colour. Everything is kept as an {r,g,b} triple so the canvas can build
 * rgba()/gradients without re-parsing hex every frame.
 */

export interface RGB {
  r: number;
  g: number;
  b: number;
}

const hex = (h: string): RGB => ({
  r: parseInt(h.slice(1, 3), 16),
  g: parseInt(h.slice(3, 5), 16),
  b: parseInt(h.slice(5, 7), 16),
});

export const rgba = (c: RGB, a: number): string =>
  `rgba(${c.r},${c.g},${c.b},${a})`;

// ── Status → glow / burst colour ──────────────────────────────────────────
export const STATUS_COLORS = {
  running: hex("#d4af37"), // gold
  idle: hex("#64748b"), // dim slate
  failed: hex("#dc143c"), // crimson
  completed: hex("#34d399"), // mint
  blocked: hex("#f59e0b"), // amber
} as const;

export type StatusKey = keyof typeof STATUS_COLORS;

/** Map any free-form status string to one of the five canonical colours. */
export function statusKey(status: string | undefined): StatusKey {
  const s = (status ?? "").toLowerCase();
  if (s === "failed" || s === "error" || s === "errored") return "failed";
  if (s === "blocked" || s === "waiting" || s === "paused") return "blocked";
  if (s === "completed" || s === "done" || s === "finished" || s === "success")
    return "completed";
  if (
    s === "running" ||
    s === "working" ||
    s === "active" ||
    s === "starting" ||
    s === "finishing" ||
    s === "busy"
  )
    return "running";
  return "idle";
}

export const statusColor = (status: string | undefined): RGB =>
  STATUS_COLORS[statusKey(status)];

// ── Backend → trail colour ────────────────────────────────────────────────
const BACKEND_COLORS: Record<string, RGB> = {
  "claude-code": hex("#d97757"), // claude clay
  claude: hex("#d97757"),
  opencode: hex("#2dd4bf"), // teal
  codex: hex("#e5e7eb"), // openai light
  gemini: hex("#4285f4"), // google blue
};

const DEFAULT_BACKEND = hex("#7dd3fc"); // sky (matches viz default)

export const backendColor = (backend: string | undefined): RGB =>
  (backend && BACKEND_COLORS[backend.toLowerCase()]) || DEFAULT_BACKEND;
