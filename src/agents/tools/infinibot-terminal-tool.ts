/**
 * InfiniBot Terminal tool — query and orchestrate the *in-app* PTYs
 * hosted by the InfiniBot UI's Terminals view. Parallels
 * `hyprland_window` but targets the gateway-managed terminal sessions
 * (each a UUID-keyed `TerminalProcess`) instead of OS-level windows.
 *
 * Optimized for multi-parallel coding flows: an agent can spawn several
 * Claude Coder / OpenCode / Gemini PTYs at once, write prompts into
 * specific ones by `terminalId`, poll their buffers, wait for them to
 * go idle, and clean them up afterwards.
 *
 * Verbs:
 *   list           — enumerate every live terminal + metadata
 *   info           — full record for one terminal by id
 *   read           — tail the latest N lines of buffer output
 *   write          — send keystrokes (or a full prompt + Enter) to a terminal
 *   spawn          — generic terminal create
 *   spawn-coder    — spawn a CLI agent (claude / opencode / gemini / codex) with a task
 *   wait-for-idle  — poll until a terminal stops producing output for N ms
 *   focus          — ask the UI to surface a terminal in the active grid cell
 *   set-title      — rename a terminal's tab label
 *   is-alive       — boolean health check
 *   kill           — destroy one terminal
 *   kill-all       — destroy every terminal (or every CLI-agent terminal)
 *
 * Every action that mutates a terminal accepts `terminalId` as the
 * stable reference, matching the UUIDs returned by `list`. For
 * `spawn-coder` the tool returns `{ terminalId, sessionKey }` so the
 * caller can write more prompts to that specific session later via
 * `write`.
 */

import { Type } from "@sinclair/typebox";

import { callGateway } from "../../gateway/call.js";
import { stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readNumberParam, readStringParam } from "./common.js";

// ── Schema ───────────────────────────────────────────────────────────

const InfinibotTerminalSchema = Type.Object({
  action: stringEnum([
    "list",
    "info",
    "read",
    "write",
    "spawn",
    "spawn-coder",
    "wait-for-idle",
    "focus",
    "set-title",
    "is-alive",
    "kill",
    "kill-all",
  ]),
  terminalId: Type.Optional(
    Type.String({
      description: "UUID terminal id from a prior `list` / `spawn-coder` result.",
    }),
  ),
  // Generic create / coder spawn knobs
  cli: Type.Optional(
    stringEnum(["claude", "opencode", "gemini", "codex", "grok", "ollama"], {
      description:
        "For spawn-coder: which CLI agent to launch. claude=Claude Code, opencode=OpenCode, gemini=Gemini CLI, codex=Codex CLI, grok=Grok Build (xAI), ollama=Ollama.",
    }),
  ),
  search: Type.Optional(
    Type.Boolean({
      description: "For spawn-coder with cli=codex: enable Codex web search (--search).",
    }),
  ),
  cwd: Type.Optional(
    Type.String({
      description:
        "Working directory for spawn / spawn-coder. Defaults to the gateway's repo root.",
    }),
  ),
  task: Type.Optional(
    Type.String({
      description:
        "For spawn-coder: initial prompt typed into the CLI agent after spawn. Multi-line is supported (each newline becomes Enter).",
    }),
  ),
  label: Type.Optional(Type.String({ description: "Display label for the new terminal's tab." })),
  agentId: Type.Optional(Type.String({ description: "Owning agent id (default 'main')." })),
  sessionKey: Type.Optional(
    Type.String({
      description:
        "Reuse a specific session key (e.g. to resume a prior coder thread). Omit to auto-generate.",
    }),
  ),
  nodeId: Type.Optional(
    Type.String({
      description:
        "Target federation node id for remote spawn (spawn-coder only). Routes via federation.node.invoke to spawn on a satellite.",
    }),
  ),
  cliType: Type.Optional(
    stringEnum(["claude", "opencode", "gemini", "codex", "grok", "ollama"], {
      description: "For spawn: drives session-key prefix + transcript discovery.",
    }),
  ),
  cols: Type.Optional(Type.Number({ description: "PTY cols (default 120)." })),
  rows: Type.Optional(Type.Number({ description: "PTY rows (default 32)." })),
  // Write / read knobs
  data: Type.Optional(
    Type.String({
      description:
        "For write: raw keystrokes to send. Pass plain text; the tool does not auto-append Enter (use `\\n` in the string when you want a newline).",
    }),
  ),
  press: Type.Optional(
    stringEnum(["enter", "esc", "ctrl-c", "ctrl-d", "tab", "up", "down"], {
      description:
        "For write: shorthand for a special key. Sent after `data` when both are provided.",
    }),
  ),
  tailLines: Type.Optional(
    Type.Number({
      description: "For read: how many lines to return from the end of the buffer (default 80).",
    }),
  ),
  // wait-for-idle knobs
  idleMs: Type.Optional(
    Type.Number({
      description:
        "For wait-for-idle: how many ms of no buffer change counts as 'idle' (default 1500).",
    }),
  ),
  pollMs: Type.Optional(
    Type.Number({
      description: "For wait-for-idle: poll interval (default 300ms).",
    }),
  ),
  timeoutMs: Type.Optional(
    Type.Number({
      description: "For wait-for-idle: hard cap, default 60_000.",
    }),
  ),
  // kill-all scope
  scope: Type.Optional(
    stringEnum(["all", "coders"], {
      description:
        "For kill-all: 'all' kills every terminal, 'coders' kills only ones whose cliType is set (Claude/OpenCode/Gemini/Codex sessions).",
    }),
  ),
  title: Type.Optional(Type.String({ description: "For set-title: new label for the terminal." })),
});

// ── Helpers ─────────────────────────────────────────────────────────

interface TerminalRow {
  id: string;
  title?: string | null;
  cwd?: string | null;
  cliType?: string | null;
  sessionKey?: string | null;
  agentId?: string | null;
  isClaudeMode?: boolean;
  isAlive?: boolean;
}

interface TerminalBuffer {
  id: string;
  buffer: string;
  title?: string;
  cwd?: string;
  isClaudeMode?: boolean;
}

const PRESS_TO_BYTES: Record<string, string> = {
  enter: "\r",
  esc: "\x1b",
  "ctrl-c": "\x03",
  "ctrl-d": "\x04",
  tab: "\t",
  up: "\x1b[A",
  down: "\x1b[B",
};

function tailLines(buf: string, n: number): string {
  if (!buf) return "";
  const lines = buf.split("\n");
  if (lines.length <= n) return buf;
  return lines.slice(-n).join("\n");
}

async function listTerminals(): Promise<TerminalRow[]> {
  const res = (await callGateway({
    method: "terminal.list",
    params: {},
    timeoutMs: 5_000,
  })) as { terminals?: TerminalRow[] };
  return res?.terminals ?? [];
}

async function getBuffer(id: string): Promise<TerminalBuffer | null> {
  try {
    const res = (await callGateway({
      method: "terminal.getBuffer",
      params: { id },
      timeoutMs: 5_000,
    })) as TerminalBuffer;
    return res ?? null;
  } catch {
    return null;
  }
}

async function isAlive(id: string): Promise<boolean> {
  try {
    const res = (await callGateway({
      method: "terminal.isAlive",
      params: { id },
      timeoutMs: 3_000,
    })) as { alive?: boolean };
    return res?.alive === true;
  } catch {
    return false;
  }
}

// ── Tool factory ────────────────────────────────────────────────────

export function createInfinibotTerminalTool(): AnyAgentTool {
  return {
    label: "InfiniBot Terminal",
    name: "infinibot_terminal",
    description: [
      "Query + drive the in-app InfiniBot UI terminals (PTYs hosted in the Terminals view).",
      "Parallels hyprland_window but for internal sessions — every terminal has a stable UUID id you can pass to subsequent actions.",
      "Built for multi-parallel coding orchestration: spawn several Claude Coder / OpenCode / Gemini / Codex PTYs at once, write prompts into specific ones, poll buffers, wait for idle, clean up.",
      "Verbs:",
      "  list             — enumerate every live terminal { id, title, cwd, cliType, sessionKey, isAlive }",
      "  info             — full record + buffer tail for one terminal by id",
      "  read             — tail the latest tailLines (default 80) of one terminal's buffer",
      "  write            — send keystrokes; optional press: enter|esc|ctrl-c|ctrl-d|tab|up|down sent after data",
      "  spawn            — generic terminal create (cwd, cliType, cols, rows, label)",
      "  spawn-coder      — launch a fresh CLI agent (cli: claude|opencode|gemini|codex|grok) with an initial task. Returns { terminalId, sessionKey }. Accepts optional nodeId for remote spawn on a federation satellite. Pass search=true with cli=codex for latest web-backed research.",
      "  wait-for-idle    — poll one terminal until its buffer hasn't grown in idleMs (default 1500) or timeoutMs elapses",
      "  focus            — ask the UI to surface a terminal in the active grid cell (best-effort, ignored if no UI client is connected)",
      "  set-title        — rename a terminal's tab label",
      "  is-alive         — boolean health check",
      "  kill             — destroy one terminal by id",
      "  kill-all         — destroy every terminal (scope='all') or every CLI-agent terminal (scope='coders')",
      "Stable reference: terminalId (UUID). spawn-coder also returns sessionKey shaped 'agent:main:terminal-<uuid>' for transcript lookups.",
    ].join(" "),
    parameters: InfinibotTerminalSchema,
    execute: async (_id, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });

      try {
        if (action === "list") {
          const rows = await listTerminals();
          return jsonResult({ count: rows.length, terminals: rows });
        }

        if (action === "info") {
          const tid = readStringParam(params, "terminalId", { required: true });
          const rows = await listTerminals();
          const row = rows.find((r) => r.id === tid);
          if (!row) return jsonResult({ ok: false, error: `terminal ${tid} not found` });
          const buf = await getBuffer(tid);
          const alive = await isAlive(tid);
          return jsonResult({
            ...row,
            isAlive: alive,
            bufferTail: buf?.buffer ? tailLines(buf.buffer, 40) : "",
          });
        }

        if (action === "read") {
          const tid = readStringParam(params, "terminalId", { required: true });
          const n = readNumberParam(params, "tailLines", { integer: true }) ?? 80;
          const buf = await getBuffer(tid);
          if (!buf) return jsonResult({ ok: false, error: `terminal ${tid} not found` });
          return jsonResult({
            id: tid,
            title: buf.title,
            cwd: buf.cwd,
            isClaudeMode: buf.isClaudeMode,
            tail: tailLines(buf.buffer ?? "", n),
            lineCount: (buf.buffer ?? "").split("\n").length,
          });
        }

        if (action === "write") {
          const tid = readStringParam(params, "terminalId", { required: true });
          const data = readStringParam(params, "data") ?? "";
          const press = readStringParam(params, "press");
          let payload = data;
          if (press && PRESS_TO_BYTES[press]) payload += PRESS_TO_BYTES[press];
          if (!payload) return jsonResult({ ok: false, error: "data or press required" });
          await callGateway({
            method: "terminal.write",
            params: { id: tid, data: payload },
            timeoutMs: 5_000,
          });
          return jsonResult({ ok: true, terminalId: tid, bytesWritten: payload.length });
        }

        if (action === "spawn") {
          const cwd = readStringParam(params, "cwd");
          const label = readStringParam(params, "label");
          const cliType = readStringParam(params, "cliType");
          const sessionKey = readStringParam(params, "sessionKey");
          const cols = readNumberParam(params, "cols", { integer: true }) ?? 120;
          const rows = readNumberParam(params, "rows", { integer: true }) ?? 32;
          const res = (await callGateway({
            method: "terminal.create",
            params: { cwd, title: label, cliType, sessionKey, cols, rows },
            timeoutMs: 10_000,
          })) as { success?: boolean; terminalId?: string; error?: string };
          if (!res?.success || !res.terminalId) {
            return jsonResult({ ok: false, error: res?.error ?? "terminal.create failed" });
          }
          return jsonResult({ ok: true, terminalId: res.terminalId });
        }

        if (action === "spawn-coder") {
          const cli = readStringParam(params, "cli", { required: true });
          if (!["claude", "opencode", "gemini", "codex", "grok", "ollama"].includes(cli)) {
            return jsonResult({ ok: false, error: `unsupported cli: ${cli}` });
          }
          const search = params.search === true;
          if (search && cli !== "codex") {
            return jsonResult({ ok: false, error: "search=true is only supported for cli=codex" });
          }
          const cwd = readStringParam(params, "cwd") ?? process.cwd();
          const task = readStringParam(params, "task") ?? "";
          const label = readStringParam(params, "label");
          const agentId = readStringParam(params, "agentId") ?? "main";
          const nodeId = readStringParam(params, "nodeId");
          const options = search ? { extraFlags: ["--search"] } : undefined;
          // Pre-fabricate the canonical session key + runId so the caller
          // can correlate transcript writes back to this spawn even
          // before the gateway echoes anything.
          const sessionKey =
            readStringParam(params, "sessionKey") ??
            `agent:${agentId}:terminal-${cryptoRandomId()}`;
          const runId = cryptoRandomId();

          // Route to a specific federation node when nodeId is provided
          if (nodeId) {
            try {
              const remoteRes = (await callGateway({
                method: "federation.node.invoke",
                params: {
                  nodeId,
                  method: "terminal.spawnAgent",
                  params: {
                    cli,
                    cwd,
                    task,
                    label,
                    runId,
                    sessionKey,
                    agentId,
                    autoClose: false,
                    options,
                  },
                },
                timeoutMs: 25_000,
              })) as {
                status?: string;
                payload?: { success?: boolean; terminalId?: string; error?: string };
                error?: string;
              };
              if (
                remoteRes?.status === "ok" &&
                remoteRes.payload?.success &&
                remoteRes.payload?.terminalId
              ) {
                return jsonResult({
                  ok: true,
                  terminalId: remoteRes.payload.terminalId,
                  sessionKey,
                  runId,
                  cli,
                  cwd,
                  nodeId,
                });
              }
              return jsonResult({
                ok: false,
                error: remoteRes?.payload?.error ?? remoteRes?.error ?? "remote spawnAgent failed",
                nodeId,
              });
            } catch (err) {
              return jsonResult({
                ok: false,
                error: `remote spawn on node ${nodeId} failed: ${(err as Error).message}`,
                nodeId,
              });
            }
          }

          const res = (await callGateway({
            method: "terminal.spawnAgent",
            params: {
              cli,
              cwd,
              task,
              label,
              runId,
              sessionKey,
              agentId,
              autoClose: false,
              options,
            },
            timeoutMs: 20_000,
          })) as { success?: boolean; terminalId?: string; error?: string };
          if (!res?.success || !res.terminalId) {
            return jsonResult({ ok: false, error: res?.error ?? "spawnAgent failed" });
          }
          return jsonResult({
            ok: true,
            terminalId: res.terminalId,
            sessionKey,
            runId,
            cli,
            cwd,
          });
        }

        if (action === "wait-for-idle") {
          const tid = readStringParam(params, "terminalId", { required: true });
          const idleMs = readNumberParam(params, "idleMs", { integer: true }) ?? 1500;
          const pollMs = readNumberParam(params, "pollMs", { integer: true }) ?? 300;
          const timeoutMs = readNumberParam(params, "timeoutMs", { integer: true }) ?? 60_000;
          const start = Date.now();
          let lastLen = -1;
          let lastChangeAt = start;
          while (true) {
            if (Date.now() - start > timeoutMs) {
              return jsonResult({
                ok: false,
                error: `wait-for-idle timed out after ${timeoutMs}ms`,
                lastLen,
                elapsedMs: Date.now() - start,
              });
            }
            const buf = await getBuffer(tid);
            if (!buf) {
              return jsonResult({ ok: false, error: `terminal ${tid} not found` });
            }
            const len = (buf.buffer ?? "").length;
            if (len !== lastLen) {
              lastLen = len;
              lastChangeAt = Date.now();
            }
            if (Date.now() - lastChangeAt >= idleMs && len > 0) {
              return jsonResult({
                ok: true,
                idle: true,
                bufferLen: len,
                tail: tailLines(buf.buffer ?? "", 20),
                elapsedMs: Date.now() - start,
              });
            }
            await new Promise((r) => setTimeout(r, pollMs));
          }
        }

        if (action === "focus") {
          const tid = readStringParam(params, "terminalId", { required: true });
          // Bring the terminal into view by asking the UI control bus to
          // dispatch a `focusTerminal` action against the Terminals view.
          // The bus may not have a UI client attached — in that case the
          // RPC just returns false and we surface it without erroring so
          // headless callers don't fail unnecessarily.
          try {
            const res = (await callGateway({
              method: "ui.control.dispatch",
              params: {
                viewName: "terminals",
                action: { type: "focusTerminal", terminalId: tid },
              },
              timeoutMs: 3_000,
            })) as { ok?: boolean; error?: string };
            return jsonResult({
              ok: res?.ok === true,
              terminalId: tid,
              error: res?.error,
              note:
                res?.ok === true
                  ? undefined
                  : "Focus best-effort: no UI client connected, or terminals view not registered.",
            });
          } catch (err) {
            return jsonResult({
              ok: false,
              terminalId: tid,
              error: (err as Error).message,
              note: "Focus best-effort: no UI client connected.",
            });
          }
        }

        if (action === "set-title") {
          const tid = readStringParam(params, "terminalId", { required: true });
          const title = readStringParam(params, "title", { required: true });
          await callGateway({
            method: "terminal.setTitle",
            params: { id: tid, title },
            timeoutMs: 5_000,
          });
          return jsonResult({ ok: true, terminalId: tid, title });
        }

        if (action === "is-alive") {
          const tid = readStringParam(params, "terminalId", { required: true });
          return jsonResult({ terminalId: tid, alive: await isAlive(tid) });
        }

        if (action === "kill") {
          const tid = readStringParam(params, "terminalId", { required: true });
          await callGateway({
            method: "terminal.destroy",
            params: { id: tid },
            timeoutMs: 5_000,
          });
          return jsonResult({ ok: true, terminalId: tid });
        }

        if (action === "kill-all") {
          const scope = (readStringParam(params, "scope") ?? "coders") as "all" | "coders";
          const rows = await listTerminals();
          const targets = rows.filter((r) =>
            scope === "all" ? true : !!r.cliType && r.cliType.length > 0,
          );
          let killed = 0;
          const errors: Array<{ id: string; error: string }> = [];
          for (const t of targets) {
            try {
              await callGateway({
                method: "terminal.destroy",
                params: { id: t.id },
                timeoutMs: 5_000,
              });
              killed++;
            } catch (e) {
              errors.push({ id: t.id, error: (e as Error).message });
            }
          }
          return jsonResult({
            ok: errors.length === 0,
            scope,
            killed,
            total: targets.length,
            errors,
          });
        }

        return jsonResult({ ok: false, error: `unknown action: ${action}` });
      } catch (err) {
        return jsonResult({ ok: false, error: (err as Error).message });
      }
    },
  };
}

// Crypto-safe random id used for terminal session keys + run ids. Avoids
// pulling in a uuid dep — Node 20+ has webcrypto under `globalThis`.
function cryptoRandomId(): string {
  const buf = new Uint8Array(16);
  globalThis.crypto.getRandomValues(buf);
  // RFC4122 v4 layout
  buf[6] = (buf[6] & 0x0f) | 0x40;
  buf[8] = (buf[8] & 0x3f) | 0x80;
  const hex = Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
