/**
 * Guard for `spawn-*` tmux panes — the substrate of live sub-agent runs.
 *
 * A durable coder sub-agent (see `agents/coder-backend/durable-spawn.ts`) runs
 * inside a detached tmux session named after its terminal id `spawn-<runId>`.
 * The terminal subsystem can ATTACH a node-pty client to that pane (the
 * reattach dropdown, boot recovery, "open in terminal"), which makes the run
 * look like an ordinary terminal — and closing that view ran the ordinary
 * destroy path, `tmux kill-session`, killing a live agent mid-turn.
 *
 * The rule this module encodes: **a pty client is a VIEW of a spawn pane,
 * never its owner.** Dropping the view must not end the run. Only the subagent
 * registry's explicit stop path (`subagents.stop` → `killDurableRun`), a real
 * process exit, or the run's own timeout may kill the session.
 *
 * The check is deliberately process-local (id shape + tmux liveness) rather
 * than registry-based, so it stays correct when the pane belongs to a DIFFERENT
 * gateway instance sharing the same state-scoped tmux socket. That case
 * is exactly how two live coder runs were killed on 2026-09-04: the
 * `~/.infinibot` gateway listed the `~/.infinibot-omnitrade` gateway's durable
 * panes as its own reattachable agents, and closing those tabs ran
 * `tmux kill-session` on runs it did not own.
 */

import { isSpawnSessionId } from "./reattachable.js";
import { hasLiveSessionSync } from "./tmux-backend.js";

export { isSpawnSessionId };

/**
 * True when `terminalId` names a sub-agent spawn pane whose tmux session is
 * still alive — i.e. destroying the terminal would kill running agent work.
 *
 * Both the original (`spawn-…`) and tmux-sanitized (`spawn_…`) id forms are
 * recognised; `hasLiveSessionSync` sanitizes before probing, so either resolves
 * the same pane.
 */
export function isLiveAgentPane(terminalId: string): boolean {
  if (!terminalId || !isSpawnSessionId(terminalId)) return false;
  return hasLiveSessionSync(terminalId);
}
