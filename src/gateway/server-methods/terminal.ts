/**
 * Terminal Gateway Handlers
 * Exposes terminal lifecycle methods to the gateway
 */

import type { GatewayRequestHandlers } from "./types.js";
import { TerminalManager } from "../../terminal/manager.js";
import type { TerminalCreateOptions, AgentCLI } from "../../terminal/types.js";
import type { GatewayBroadcaster } from "../server-broadcast.js";
import {
  spawnAgentInTerminal,
  reattachSpawnAgentTerminal,
  handleSpawnTerminalExit,
} from "../../terminal/spawn-agent.js";
import { forwardGatewayCall } from "../../federation/hub-forward.js";
import { isLocalNodeId } from "../../federation/local-node.js";
import { getIdempotentResult, recordIdempotentResult } from "../../federation/spawn-idempotency.js";
import { resolveDefaultSessionStorePath } from "../../config/sessions/paths.js";
import { updateSessionStore } from "../../config/sessions/store.js";
import { mergeSessionEntry } from "../../config/sessions/types.js";
import {
  findCodexTranscriptForTerminal,
  findOpenCodeSessionForTerminal,
  findTranscriptBySessionId,
  findTranscriptForTerminal,
  startTerminalAssistantStream,
  startTerminalOpenCodeAssistantStream,
  startTerminalPtyAssistantStream,
  stopTerminalAssistantStream,
} from "./terminal-assistant-stream.js";

// Singleton terminal manager instance
let terminalManager: TerminalManager | null = null;
let gatewayBroadcaster: GatewayBroadcaster | null = null;

/**
 * Initialize terminal manager and wire up events
 */
export function initializeTerminalManager(broadcaster?: GatewayBroadcaster): void {
  if (terminalManager) return; // Already initialized

  // Use adapter to map TerminalManager events to Gateway events
  // TerminalManager emits "terminal:output", Gateway expects "terminal.output"
  const adapter = (event: string, payload: any) => {
    const eventName = event === "terminal:output" ? "terminal.output" : event;
    if (gatewayBroadcaster) {
      gatewayBroadcaster.broadcast(eventName, payload);
    }
  };

  terminalManager = new TerminalManager(adapter);

  // Bind the transcript / assistant-text stream's lifetime to the terminal's.
  // Without this, destroying a terminal leaves chokidar watchers and PTY
  // taps running for a dead id — TTS keeps speaking, fds leak, and the
  // ptyOutputListeners map accumulates dead entries. The hook runs before
  // the PTY is killed so listeners unwind cleanly.
  terminalManager.addBeforeDestroyHook((terminalId) => {
    stopTerminalAssistantStream(terminalId);
  });

  if (broadcaster) {
    gatewayBroadcaster = broadcaster;
    console.log("[Terminal] Manager initialized with broadcaster");
  } else {
    console.log("[Terminal] Manager initialized (no broadcaster yet)");
  }
}

/** The gateway's terminal manager, or null before `initializeTerminalManager` ran. */
export function getTerminalManager(): TerminalManager | null {
  return terminalManager;
}

/**
 * Set the broadcaster for terminal events (can be called after initialization)
 */
export function setTerminalBroadcaster(broadcaster: GatewayBroadcaster): void {
  gatewayBroadcaster = broadcaster;
  if (terminalManager) {
    // Update adapter if needed, or just set broadcaster reference since adapter closure uses it
    // But TerminalManager allows setting new broadcaster function
    terminalManager.setBroadcaster((event, payload) => {
      const eventName = event === "terminal:output" ? "terminal.output" : event;
      broadcaster.broadcast(eventName, payload);
    });
    console.log("[Terminal] Broadcaster attached");
  }
}

/**
 * Broadcast terminal event to all connected clients
 */
function broadcastTerminalEvent(event: string, data: any): void {
  if (gatewayBroadcaster) {
    gatewayBroadcaster.broadcast(event, data);
  }
}

export const terminalHandlers: GatewayRequestHandlers = {
  /** Create a new terminal */
  "terminal.create": async ({ params, respond }) => {
    if (!terminalManager) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: "Terminal manager not initialized",
      });
      return;
    }

    const rawParams = (params ?? {}) as Record<string, unknown>;
    // CLI-mode terminals (claude/opencode/gemini/codex) get an auto-derived
    // sessionKey so the InfiniBot MCP server inside the PTY can attribute
    // its tool calls to a real session, and so the activity feed can list
    // the agent. Plain-shell terminals don't need a session record.
    const cliType = typeof rawParams.cliType === "string" ? rawParams.cliType : undefined;
    const isAgentCli =
      cliType === "claude" ||
      cliType === "opencode" ||
      cliType === "gemini" ||
      cliType === "codex" ||
      cliType === "grok";
    const explicitSessionKey =
      typeof rawParams.sessionKey === "string" && rawParams.sessionKey.length > 0
        ? rawParams.sessionKey
        : undefined;
    const presetTerminalId =
      typeof rawParams.id === "string" && rawParams.id.length > 0 ? rawParams.id : undefined;
    const derivedSessionKey =
      explicitSessionKey ??
      (isAgentCli && presetTerminalId ? `agent:main:terminal-${presetTerminalId}` : undefined);

    const options: TerminalCreateOptions = {
      ...(rawParams as any),
      agentId: rawParams.agentId as string | undefined,
      sessionKey: derivedSessionKey,
    };

    const result = await terminalManager.create(options);

    if (result.success && result.terminalId) {
      const term = terminalManager.getTerminal(result.terminalId);

      // Register a SessionEntry so the activity feed (sessions.list) can
      // see this terminal-spawned agent. Without this, MCP-originated
      // tool calls broadcast through agent-tools.invoke have no
      // matching session in the store and never show up.
      const sessionKeyForRegistration =
        term?.sessionKey ??
        derivedSessionKey ??
        (isAgentCli ? `agent:main:terminal-${result.terminalId}` : undefined);

      if (sessionKeyForRegistration && (isAgentCli || term?.isClaudeMode)) {
        try {
          const storePath = resolveDefaultSessionStorePath(term?.agentId);
          const now = Date.now();
          const labelCli = (cliType ?? "claude").toUpperCase();
          const titlePart = term?.title || `Terminal ${result.terminalId.slice(0, 6)}`;
          await updateSessionStore(storePath, (store) => {
            const existing = store[sessionKeyForRegistration];
            const patch = {
              updatedAt: now,
              label: existing?.label ?? `${labelCli} · ${titlePart}`,
              displayName: existing?.displayName ?? titlePart,
              channel: existing?.channel ?? "terminal",
              origin: existing?.origin ?? {
                label: "Terminal CLI",
                provider: "terminal",
                surface: cliType ?? "claude",
              },
            };
            store[sessionKeyForRegistration] = mergeSessionEntry(existing, patch);
          });
        } catch (e) {
          console.warn("[Terminal] Failed to register SessionEntry:", e);
        }
      }

      // Broadcast richer "created" payload so other browser tabs/windows
      // can mirror the new terminal without a full page reload.
      broadcastTerminalEvent("terminal.created", {
        terminalId: result.terminalId,
        id: result.terminalId,
        title: term?.title ?? null,
        cwd: term?.cwd ?? null,
        createdAt:
          term?.createdAt instanceof Date ? term.createdAt.toISOString() : new Date().toISOString(),
        cliType: term?.cliType ?? cliType ?? null,
        projectPath: term?.projectPath ?? null,
        agentId: term?.agentId ?? null,
        sessionKey: term?.sessionKey ?? sessionKeyForRegistration ?? null,
        isClaudeMode: !!term?.isClaudeMode,
      });
    }

    respond(true, result);
  },

  /** Destroy a terminal */
  "terminal.destroy": async ({ params, respond }) => {
    if (!terminalManager) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: "Terminal manager not initialized",
      });
      return;
    }

    const id = (params as any).id;
    // Closing a terminal is closing a VIEW. When that view happens to be a
    // live `spawn-*` sub-agent pane, the tmux session (and the agent inside
    // it) is preserved unless the caller explicitly asks to kill the agent.
    // Stopping a sub-agent is `subagents.stop`, not `terminal.destroy`.
    const killAgentPane = (params as any).killAgentPane === true || (params as any).force === true;
    const result = await terminalManager.destroy(id, { killAgentPane });

    if (result.success) {
      // Carry both shapes so legacy listeners ({terminalId}) and new
      // ones ({id}) both work.
      broadcastTerminalEvent("terminal.destroyed", {
        terminalId: id,
        id,
        tmuxSessionPreserved: result.tmuxSessionPreserved === true,
      });
    }

    respond(true, result);
  },

  /** List terminals */
  "terminal.list": async ({ params, respond }) => {
    if (!terminalManager) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: "Terminal manager not initialized",
      });
      return;
    }

    const p = params as any;
    const terminals = terminalManager.list(p.projectPath, p.agentId);
    respond(true, { terminals });
  },

  /**
   * List every LIVE tmux session as a unified, reattachable entry — including
   * the `spawn-*` cloud/codex agent panes that `terminal.list` (in-memory
   * only) omits after a restart, plus CLI/shell terminals that may not have
   * been reconciled yet.
   *
   * Queries tmux directly (never the in-memory map) so it works immediately
   * post-restart, cross-references the subagent registry to classify agent
   * panes, and returns each entry with the exact reattach RPC + params for
   * its kind. Local-only: the UI fans this out per federation node the same
   * way it fans out `terminal.list`.
   */
  "terminal.listReattachable": async ({ params, respond }) => {
    if (!terminalManager) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: "Terminal manager not initialized",
      });
      return;
    }
    try {
      const p = (params ?? {}) as { nodeId?: string; includeForeign?: boolean };
      const [
        { classifyReattachable, splitForeignEntries, sanitizeTerminalId },
        tmux,
        registry,
        durable,
      ] = await Promise.all([
        import("../../terminal/reattachable.js"),
        import("../../terminal/tmux-backend.js"),
        // Dynamic import keeps the registry (which pulls in gamification /
        // proactive) off this module's load path and avoids any cycle.
        import("../../agents/subagent-registry.js"),
        import("../../agents/coder-backend/durable-spawn.js"),
      ]);

      const liveIds = [...(await tmux.listLiveSessions())];

      // Runs → lite shape for the classifier.
      const runs = registry.listAllSubagentRuns().map((r) => ({
        runId: r.runId,
        terminalId: r.terminalId,
        agentId: r.agentId,
        workdir: r.workdir,
        label: r.label,
        coderBackend: r.coderBackend,
        childSessionKey: r.childSessionKey,
        task: r.task,
      }));

      // In-memory terminals → lite map for CLI/shell enrichment.
      const memTerminals = new Map<
        string,
        {
          cliType?: string;
          title?: string;
          cwd?: string;
          sessionKey?: string;
          isClaudeMode?: boolean;
        }
      >();
      for (const id of liveIds) {
        const t = terminalManager.getTerminal(id);
        if (t) {
          memTerminals.set(id, {
            cliType: (t as any).cliType,
            title: t.title,
            cwd: t.cwd,
            sessionKey: t.sessionKey,
            isClaudeMode: t.isClaudeMode,
          });
        }
      }

      // Persisted sessions → lite map.
      const savedSessions = new Map<
        string,
        { title?: string; cwd?: string; cliType?: string; isClaudeMode?: boolean }
      >();
      for (const s of terminalManager.getSavedSessions()) {
        savedSessions.set(s.id, {
          title: s.title,
          cwd: s.cwd,
          cliType: (s as any).cliType,
          isClaudeMode: s.isClaudeMode,
        });
      }

      // Best-effort cwd for ids we have no in-memory/persisted cwd for.
      const cwdFallback = new Map<string, string>();
      await Promise.all(
        liveIds
          .filter((id) => !memTerminals.get(id)?.cwd && !savedSessions.get(id)?.cwd)
          .map(async (id) => {
            const cwd = await tmux.getSessionCwd(id);
            if (cwd) cwdFallback.set(id, cwd);
          }),
      );

      // Which `spawn-*` panes are OURS. The tmux socket is shared by every
      // InfiniBot instance on the host, so live-session enumeration alone will
      // happily hand us another instance's running coder panes. Three
      // independent proofs of ownership, unioned:
      //   1. a run in our registry carrying that terminalId,
      //   2. a durable run dir under OUR state dir (survives an unrecovered
      //      registry after a restart),
      //   3. one of our own persisted terminal sessions.
      const ownedSpawnIds = new Set<string>();
      for (const r of runs) {
        if (r.terminalId) ownedSpawnIds.add(sanitizeTerminalId(r.terminalId));
      }
      for (const runId of durable.listDurableRunIds()) {
        ownedSpawnIds.add(sanitizeTerminalId(durable.durableTerminalId(runId)));
      }
      for (const id of savedSessions.keys()) ownedSpawnIds.add(sanitizeTerminalId(id));

      const classified = classifyReattachable({
        liveIds,
        runs,
        memTerminals,
        savedSessions,
        cwdFallback,
        nodeId: typeof p.nodeId === "string" && p.nodeId ? p.nodeId : undefined,
        ownedSpawnIds,
      });
      const split = splitForeignEntries(classified);
      // Foreign agent panes are reported, never offered: reattaching to one
      // puts a pty viewer on another instance's live run.
      const entries = p.includeForeign === true ? classified : split.entries;

      respond(true, { entries, foreignCount: split.foreign.length });
    } catch (err) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: err instanceof Error ? err.message : "Failed to list reattachable sessions",
      });
    }
  },

  /** Write to a terminal */
  "terminal.write": async ({ params, respond }) => {
    if (!terminalManager) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: "Terminal manager not initialized",
      });
      return;
    }

    const p = params as any;
    terminalManager.write(p.id, p.data);
    respond(true, { success: true });
  },

  /** Resize a terminal */
  "terminal.resize": async ({ params, respond }) => {
    if (!terminalManager) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: "Terminal manager not initialized",
      });
      return;
    }

    const p = params as any;
    terminalManager.resize(p.id, p.cols, p.rows);
    respond(true, { success: true });
  },

  /** Get saved sessions */
  "terminal.sessions.get": async ({ params, respond }) => {
    if (!terminalManager) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: "Terminal manager not initialized",
      });
      return;
    }

    const p = params as any;
    const sessions = terminalManager.getSavedSessions(p.projectPath, p.agentId);
    respond(true, { sessions });
  },

  /** Restore a terminal session */
  "terminal.sessions.restore": async ({ params, respond }) => {
    if (!terminalManager) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: "Terminal manager not initialized",
      });
      return;
    }

    const p = params as any;
    const result = await terminalManager.restore(p.session, p.cols, p.rows);
    respond(true, result);
  },

  /** Clear saved sessions */
  "terminal.sessions.clear": async ({ params, respond }) => {
    if (!terminalManager) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: "Terminal manager not initialized",
      });
      return;
    }

    const p = params as any;
    terminalManager.clearSavedSessions(p.projectPath, p.agentId);
    respond(true, { success: true });
  },

  /** Update terminal title */
  "terminal.setTitle": async ({ params, respond }) => {
    if (!terminalManager) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: "Terminal manager not initialized",
      });
      return;
    }

    const p = params as any;
    terminalManager.setTitle(p.id, p.title);
    respond(true, { success: true });
  },

  /** Update display orders */
  "terminal.updateDisplayOrders": async ({ params, respond }) => {
    if (!terminalManager) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: "Terminal manager not initialized",
      });
      return;
    }

    const p = params as any;
    terminalManager.updateDisplayOrders(p.projectPath, p.agentId, p.orders);
    respond(true, { success: true });
  },

  /** Check if terminal is alive */
  "terminal.isAlive": async ({ params, respond }) => {
    if (!terminalManager) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: "Terminal manager not initialized",
      });
      return;
    }

    const p = params as any;
    const alive = terminalManager.isTerminalAlive(p.id);
    respond(true, { alive });
  },

  /**
   * Return the retained output buffer for a live terminal, so the UI can
   * replay history on reconnect after a page refresh. Empty string when
   * terminal is unknown or has no buffered output.
   */
  "terminal.getBuffer": async ({ params, respond }) => {
    if (!terminalManager) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: "Terminal manager not initialized",
      });
      return;
    }
    const p = params as any;
    const term = terminalManager.getTerminal(p.id);
    const buffer = typeof term?.outputBuffer === "string" ? term.outputBuffer : "";
    respond(true, {
      id: p.id,
      buffer,
      title: term?.title ?? null,
      cwd: term?.cwd ?? null,
      isClaudeMode: !!term?.isClaudeMode,
    });
  },
  /**
   * Start streaming assistant text from the transcript file / PTY output the
   * given terminal is producing. Emits `assistant.text.delta` gateway events
   * with `{terminalId, text, chunkIndex, uuid, ts}`. Used by voice-chat's
   * terminal mode for read-aloud.
   *
   * If the transcript can't be located yet (Claude Code may not have written
   * its first line) the call still succeeds — the watcher will pick the
   * file up via mtime as soon as it appears, then start streaming. The
   * caller can also pass `transcriptPath` directly to skip the heuristic.
   */
  "terminal.assistantStream.start": async ({ params, respond }) => {
    if (!terminalManager) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: "Terminal manager not initialized",
      });
      return;
    }
    const p = params as { id?: string; transcriptPath?: string; opencodeSessionId?: string };
    if (!p.id || typeof p.id !== "string") {
      respond(false, undefined, { code: "INVALID_REQUEST", message: "id is required" });
      return;
    }
    const term = terminalManager.getTerminal(p.id);
    // The assistant stream is bound to a *live* terminal — destroying the
    // terminal triggers a before-destroy hook that tears the stream down.
    // Attaching to an id that's already gone would silently leak (no
    // hook will ever fire to stop it), so refuse here regardless of
    // whether the caller pre-resolved transcriptPath themselves.
    if (!term) {
      respond(false, undefined, { code: "NOT_FOUND", message: `terminal ${p.id} not found` });
      return;
    }

    // Dispatch by CLI backend. Claude Code and Codex write JSONL transcripts
    // we can tail for assistant-only text. OpenCode exposes clean session
    // export JSON, which avoids speaking TUI redraws/tool chrome from PTY.
    const cliType = (term?.cliType ?? "").toLowerCase();
    if (cliType === "opencode" && !p.transcriptPath) {
      const sessionId =
        typeof p.opencodeSessionId === "string" && p.opencodeSessionId
          ? p.opencodeSessionId
          : findOpenCodeSessionForTerminal({
              cwd: term.cwd,
              createdAtMs: term.createdAt instanceof Date ? term.createdAt.getTime() : 0,
            });
      if (!sessionId) {
        respond(true, { started: false, reason: "no matching opencode session yet" });
        return;
      }

      startTerminalOpenCodeAssistantStream({
        terminalId: p.id,
        sessionId,
        emit: (delta) => {
          broadcastTerminalEvent("assistant.text.delta", delta);
        },
      });
      respond(true, { started: true, mode: "opencode-export", opencodeSessionId: sessionId });
      return;
    }

    const useFileTranscript = cliType === "claude" || cliType === "codex" || !!p.transcriptPath;

    if (useFileTranscript) {
      // Resolution order:
      //   1. Caller passed an explicit transcriptPath — trust it.
      //   2. terminal.claudeSessionId is set (infinibot launched Claude Code
      //      with `--session-id <UUID>`, or we extracted it from output) —
      //      the transcript filename is exactly that UUID. Robust against
      //      multiple parallel Claude Codes in the same cwd.
      //   3. Cwd+mtime heuristic — best-effort fallback for sessions
      //      infinibot didn't launch.
      const transcriptKind = cliType === "codex" ? "codex" : "claude";
      let transcriptPath: string | null = p.transcriptPath ?? null;
      if (transcriptKind === "claude" && !transcriptPath && term?.claudeSessionId) {
        transcriptPath = findTranscriptBySessionId({ sessionId: term.claudeSessionId });
      }
      if (transcriptKind === "claude" && !transcriptPath && term) {
        transcriptPath = findTranscriptForTerminal({
          cwd: term.cwd,
          createdAtMs: term.createdAt instanceof Date ? term.createdAt.getTime() : 0,
        });
      }
      if (transcriptKind === "codex" && !transcriptPath && term) {
        transcriptPath = findCodexTranscriptForTerminal({
          cwd: term.cwd,
          createdAtMs: term.createdAt instanceof Date ? term.createdAt.getTime() : 0,
        });
      }
      if (!transcriptPath) {
        // Interactive Claude Code in our PTY spawn context replies on screen but
        // does NOT persist a findable jsonl transcript (verified empirically:
        // it runs with --session-id + --append-system-prompt-file, answers, yet
        // writes no <id>.jsonl anywhere). The file tailer can therefore never
        // attach and read-aloud stays silent forever. Rather than give up, fall
        // back to reading Claude's reply straight from the terminal output (its
        // `●` assistant bullet) via the PTY tap — the only reliable source here.
        if (cliType === "claude") {
          console.warn(
            `[assistant-stream] no transcript for ${p.id} (claude writes none here) — ` +
              `falling back to PTY output tap`,
          );
          const mgr = terminalManager;
          startTerminalPtyAssistantStream({
            terminalId: p.id,
            cliType: "claude",
            subscribePtyOutput: (tid, cb) => mgr.subscribePtyOutput(tid, cb),
            subscribePtyInput: (tid, cb) => mgr.subscribePtyInput(tid, cb),
            emit: (delta) => {
              broadcastTerminalEvent("assistant.text.delta", delta);
            },
          });
          respond(true, { started: true, mode: "pty-fallback", cliType: "claude" });
          return;
        }
        console.warn(
          `[assistant-stream] no transcript for terminal ${p.id}: cliType=${cliType} ` +
            `cwd=${JSON.stringify(term?.cwd)} claudeSessionId=${term?.claudeSessionId ?? "(none)"} ` +
            `createdAt=${term?.createdAt instanceof Date ? term.createdAt.toISOString() : "(none)"}`,
        );
        respond(true, { started: false, reason: "no matching transcript yet" });
        return;
      }
      console.log(
        `[assistant-stream] streaming terminal ${p.id} from ${transcriptPath} ` +
          `(viaSessionId=${!!term?.claudeSessionId && !p.transcriptPath})`,
      );
      startTerminalAssistantStream({
        terminalId: p.id,
        transcriptPath,
        transcriptKind,
        emit: (delta) => {
          broadcastTerminalEvent("assistant.text.delta", delta);
        },
      });
      respond(true, {
        started: true,
        transcriptPath,
        viaSessionId: !!term?.claudeSessionId && !p.transcriptPath,
        mode: "file",
        transcriptKind,
      });
      return;
    }

    // Generic backend → PTY tap. Hands the manager's per-terminal
    // subscribe API to the stream so it can register a listener without
    // reaching into the manager singleton itself.
    const mgr = terminalManager;
    startTerminalPtyAssistantStream({
      terminalId: p.id,
      cliType: cliType || "unknown",
      subscribePtyOutput: (tid, cb) => mgr.subscribePtyOutput(tid, cb),
      subscribePtyInput: (tid, cb) => mgr.subscribePtyInput(tid, cb),
      emit: (delta) => {
        broadcastTerminalEvent("assistant.text.delta", delta);
      },
    });
    respond(true, { started: true, mode: "pty", cliType: cliType || "unknown" });
  },

  /** Stop the assistant-text stream for a terminal. */
  "terminal.assistantStream.stop": async ({ params, respond }) => {
    const p = params as { id?: string };
    if (!p.id || typeof p.id !== "string") {
      respond(false, undefined, { code: "INVALID_REQUEST", message: "id is required" });
      return;
    }
    stopTerminalAssistantStream(p.id);
    respond(true, { stopped: true });
  },

  /** Invoke Claude in terminal */
  "terminal.claude.invoke": async ({ params, respond }) => {
    if (!terminalManager) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: "Terminal manager not initialized",
      });
      return;
    }

    const p = params as any;
    await terminalManager.invokeClaude(
      p.id,
      p.profileId,
      p.dangerouslySkipPermissions,
      p.voiceOrchestrator,
    );
    respond(true, { success: true });
  },

  /** Invoke Agent CLI in terminal */
  "terminal.agent.invoke": async ({ params, respond }) => {
    if (!terminalManager) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: "Terminal manager not initialized",
      });
      return;
    }

    const p = params as any;
    await terminalManager.invokeAgentCLI(p.id, p.cli, p.options);
    respond(true, { success: true });
  },

  /**
   * Spawn a sub-agent task in a terminal (terminal-first execution).
   *
   * If `nodeId` is supplied and refers to a remote federation node, the call
   * is forwarded to that satellite's gateway via `hub.invokeOnNode` →
   * `gateway.proxy.invoke`. The satellite spawns the PTY in its own
   * TerminalManager; output is streamed back to all gateway clients through
   * the existing `terminal.output` federation broadcast pipe. When `nodeId`
   * is `"local"`, empty, or omitted, the spawn happens locally as before.
   */
  "terminal.spawnAgent": async ({ params, respond }) => {
    const p = (params ?? {}) as Record<string, unknown>;
    const cli = p.cli as AgentCLI;
    if (!cli || !["claude", "opencode", "gemini", "codex", "grok", "ollama"].includes(cli)) {
      respond(false, undefined, { code: "INVALID_PARAMS", message: `Invalid CLI: ${cli}` });
      return;
    }

    // ── Cross-node forwarding ────────────────────────────────────────────
    // Only the master can route — a satellite that receives a nodeId param
    // simply spawns locally (the caller upstream is responsible for picking
    // the right node before forwarding here).
    const rawNodeId = typeof p.nodeId === "string" ? p.nodeId.trim() : "";
    // isLocalNodeId centralises local-vs-remote (empty/"local"/own id → local;
    // "master" → local only when we ARE the master). A forwarded call that
    // lands on its target therefore runs locally instead of re-forwarding.
    const wantsRemote = !isLocalNodeId(rawNodeId);

    // ── Idempotency ──────────────────────────────────────────────────────
    // A retry/replay with the same key returns the original spawn result
    // instead of launching a duplicate CLI. The key rides in forwardParams,
    // so the node that actually spawns is the one that dedupes.
    const idemKey = typeof p.idempotencyKey === "string" ? p.idempotencyKey.trim() : "";
    if (idemKey) {
      const cached = getIdempotentResult<Record<string, unknown>>(idemKey);
      if (cached !== undefined) {
        respond(true, cached);
        return;
      }
    }

    if (wantsRemote) {
      // forwardGatewayCall handles every direction: master → satellite via
      // the hub, and satellite → master/sibling by tunnelling up to the
      // master, which re-routes (hub-and-spoke). A satellite has no direct
      // peer link, so sat → sat always hops through the master.
      const { nodeId: _drop, ...forwardParams } = p;
      const fwd = await forwardGatewayCall<{
        success?: boolean;
        terminalId?: string;
        error?: string;
      }>(rawNodeId, "terminal.spawnAgent", forwardParams);
      if (fwd.success) {
        const remotePayload = { ...fwd.payload, nodeId: rawNodeId };
        if (idemKey) recordIdempotentResult(idemKey, remotePayload);
        respond(!!fwd.payload?.success, remotePayload);
        return;
      }
      // Surface genuine routing failures (target down, master unreachable,
      // remote error) — never silently launch the CLI on the wrong node.
      // Only NOT_FEDERATED (standalone install, no hub/satellite) falls
      // through to a local spawn.
      if (fwd.code !== "NOT_FEDERATED") {
        respond(false, undefined, {
          code: fwd.code ?? "FORWARD_FAILED",
          message: fwd.error ?? `Failed to forward terminal.spawnAgent to node ${rawNodeId}`,
        });
        return;
      }
    }

    if (!terminalManager) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: "Terminal manager not initialized",
      });
      return;
    }

    const result = await spawnAgentInTerminal({
      manager: terminalManager,
      cli,
      cwd: (p.cwd as string) || ".",
      task: (p.task as string) || "",
      label: p.label as string | undefined,
      runId: (p.runId as string) || "",
      sessionKey: (p.sessionKey as string) || "",
      agentId: (p.agentId as string) || "",
      autoClose: p.autoClose !== false,
      autoCloseDelayMs: typeof p.autoCloseDelayMs === "number" ? p.autoCloseDelayMs : 5000,
      options: (() => {
        const base =
          p.options && typeof p.options === "object"
            ? { ...(p.options as import("../../terminal/types.js").AgentCLIOptions) }
            : ({} as import("../../terminal/types.js").AgentCLIOptions);
        // Top-level `orchestrator: true` is the UI convenience: the spawn
        // dialog / terminals view sets it as a sibling of `cli`, while the
        // CLI coder tools (claude_coder / codex_coder / opencode_coder) leave
        // it unset so their sub-agent PTYs stay vanilla. Fold it into the
        // CLI options for invokeAgentCLI to act on.
        if (typeof p.orchestrator === "boolean") base.orchestrator = p.orchestrator;
        return Object.keys(base).length ? base : undefined;
      })(),
      broadcast: gatewayBroadcaster
        ? (event: string, payload: any) => gatewayBroadcaster!.broadcast(event, payload)
        : undefined,
    });

    if (idemKey && result.success) recordIdempotentResult(idemKey, result);
    respond(result.success, result);
  },

  /**
   * Reattach to a spawn terminal whose tmux session survived a gateway restart.
   * Called by subagent recovery (resumeSubagentRun → reattachTmuxSubagentRun)
   * when a run's tmux session is still live. Re-binds the exit listener without
   * re-invoking the CLI. Local-only: reattach always targets this node's manager.
   */
  "terminal.reattachSpawnAgent": async ({ params, respond }) => {
    if (!terminalManager) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: "Terminal manager not initialized",
      });
      return;
    }
    const p = params as {
      terminalId?: string;
      runId?: string;
      sessionKey?: string;
      agentId?: string;
      label?: string;
      cwd?: string;
      autoClose?: boolean;
      autoCloseDelayMs?: number;
    };
    if (!p.terminalId || !p.runId) {
      respond(false, undefined, {
        code: "INVALID_PARAMS",
        message: "terminal.reattachSpawnAgent requires terminalId and runId",
      });
      return;
    }
    const result = await reattachSpawnAgentTerminal({
      manager: terminalManager,
      terminalId: p.terminalId,
      cwd: p.cwd,
      runId: p.runId,
      sessionKey: p.sessionKey || "",
      agentId: p.agentId || "agent",
      label: p.label,
      autoClose: p.autoClose !== false,
      autoCloseDelayMs: typeof p.autoCloseDelayMs === "number" ? p.autoCloseDelayMs : 5000,
      broadcast: gatewayBroadcaster
        ? (event: string, payload: any) => gatewayBroadcaster!.broadcast(event, payload)
        : undefined,
    });
    respond(result.success, result);
  },

  /** Report spawn terminal exit (called internally when PTY exits) */
  "terminal.spawnExit": async ({ params, respond }) => {
    if (!terminalManager) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: "Terminal manager not initialized",
      });
      return;
    }

    const p = params as any;
    const handled = handleSpawnTerminalExit(
      p.terminalId,
      typeof p.exitCode === "number" ? p.exitCode : 1,
      terminalManager,
      gatewayBroadcaster
        ? (event: string, payload: any) => gatewayBroadcaster!.broadcast(event, payload)
        : undefined,
    );

    respond(true, { handled });
  },
};
