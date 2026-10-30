/**
 * `terminal.peek` — READ-ONLY tail of a terminal's output, for the voice
 * call's live terminal stream panel.
 *
 * `terminal.getBuffer` only knows terminals held by this process's
 * TerminalManager. A coder run (claude_coder / codex_coder / opencode_coder)
 * lives in a tmux `spawn-*` pane that is not in that map after a gateway
 * restart (or until a Terminals tab reattaches it), so the panel could not
 * show it. This method answers from the manager's buffer when it has the
 * terminal and otherwise from `tmux capture-pane` (preferred for any live
 * tmux-backed terminal: clean screen + scrollback, no status-bar redraws) — never attaching a PTY,
 * never writing, never resizing.
 *
 * tmux panes are only read when THIS gateway owns them (a run in our
 * registry, a durable run dir under our state dir, or one of our persisted
 * terminal sessions) — the same ownership rule `terminal.listReattachable`
 * applies, so another instance's run on the shared tmux socket is never read.
 *
 * Params: { id: string, maxChars?: number (default 64k, max 512k), lines?: number (tmux scrollback, default 2000) }
 * Result: { id, text, source: "pty" | "tmux" | "none", alive, title, cwd }
 */

import type { GatewayRequestHandlers } from "./types.js";
import { getTerminalManager } from "./terminal.js";

const DEFAULT_MAX_CHARS = 64 * 1024;
const MAX_MAX_CHARS = 512 * 1024;
const DEFAULT_LINES = 2000;
const MAX_LINES = 5000;

function clampInt(v: unknown, def: number, max: number): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.min(Math.floor(v), max) : def;
}

async function ownedTmuxIds(): Promise<Set<string>> {
  const [{ sanitizeTerminalId }, registry, durable] = await Promise.all([
    import("../../terminal/reattachable.js"),
    import("../../agents/subagent-registry.js"),
    import("../../agents/coder-backend/durable-spawn.js"),
  ]);
  const owned = new Set<string>();
  for (const r of registry.listAllSubagentRuns()) {
    if (r.terminalId) owned.add(sanitizeTerminalId(r.terminalId));
  }
  for (const runId of durable.listDurableRunIds()) {
    owned.add(sanitizeTerminalId(durable.durableTerminalId(runId)));
  }
  const manager = getTerminalManager();
  for (const s of manager?.getSavedSessions() ?? []) owned.add(sanitizeTerminalId(s.id));
  return owned;
}

export const terminalPeekHandlers: GatewayRequestHandlers = {
  "terminal.peek": async ({ params, respond }) => {
    const p = (params ?? {}) as { id?: unknown; maxChars?: unknown; lines?: unknown };
    const id = typeof p.id === "string" ? p.id.trim() : "";
    if (!id) {
      respond(false, undefined, { code: "INVALID_REQUEST", message: "id is required" });
      return;
    }
    const maxChars = clampInt(p.maxChars, DEFAULT_MAX_CHARS, MAX_MAX_CHARS);
    const manager = getTerminalManager();
    const term = manager?.getTerminal(id);
    const lines = clampInt(p.lines, DEFAULT_LINES, MAX_LINES);
    // tmux-backed terminals: the pane capture is the clean screen + scrollback
    // (the raw PTY stream is a tmux client redraw with the status bar in it).
    if (term) {
      try {
        const tmux = await import("../../terminal/tmux-backend.js");
        if (await tmux.hasLiveSession(id)) {
          const text = await tmux.capturePane(id, lines);
          if (text) {
            respond(true, {
              id,
              text: text.length > maxChars ? text.slice(-maxChars) : text,
              source: "tmux",
              alive: true,
              title: term.title ?? null,
              cwd: term.cwd ?? null,
            });
            return;
          }
        }
      } catch {
        /* fall back to the PTY buffer */
      }
      const buf = typeof term.outputBuffer === "string" ? term.outputBuffer : "";
      respond(true, {
        id,
        text: buf.length > maxChars ? buf.slice(-maxChars) : buf,
        source: "pty",
        alive: manager?.isTerminalAlive(id) ?? true,
        title: term.title ?? null,
        cwd: term.cwd ?? null,
      });
      return;
    }
    try {
      const [{ sanitizeTerminalId }, tmux] = await Promise.all([
        import("../../terminal/reattachable.js"),
        import("../../terminal/tmux-backend.js"),
      ]);
      const owned = await ownedTmuxIds();
      if (!owned.has(sanitizeTerminalId(id)) || !(await tmux.hasLiveSession(id))) {
        respond(true, { id, text: "", source: "none", alive: false, title: null, cwd: null });
        return;
      }
      const text = await tmux.capturePane(id, lines);
      respond(true, {
        id,
        text: text.length > maxChars ? text.slice(-maxChars) : text,
        source: "tmux",
        alive: true,
        title: null,
        cwd: null,
      });
    } catch (err) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: err instanceof Error ? err.message : "terminal.peek failed",
      });
    }
  },
};
