/**
 * `/claude` — route a chat (Telegram, etc.) to an interactive Claude Code
 * terminal session instead of the gateway agent.
 *
 *   /claude              toggle Claude mode
 *   /claude on [cwd]     enable (optionally in another working directory)
 *   /claude off          back to the gateway agent (Claude session kept alive)
 *   /claude status       mode, terminal, session
 *   /claude new          fresh Claude session
 *   /claude esc          interrupt Claude (Esc); /stop does the same in Claude mode
 *   /claude screen       snapshot of the terminal
 *   /claude key <k>      press a key (enter, esc, up, down, tab, 1-9, y, n, ctrl-c)
 *   /claude <message>    send one message to Claude without toggling the mode
 *
 * The bridge itself lives in src/terminal/claude-chat-bridge.ts.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ClaudeBridgeState, SessionEntry } from "../../config/sessions.js";
import { updateSessionStore } from "../../config/sessions.js";
import { logVerbose } from "../../globals.js";
import type { TerminalManager } from "../../terminal/manager.js";
import { resolveTmuxSocketName } from "../../terminal/tmux-socket.js";
import type { ReplyPayload } from "../types.js";
import type {
  CommandHandler,
  CommandHandlerResult,
  HandleCommandsParams,
} from "./commands-types.js";
import { routeReply } from "./route-reply.js";

export type ClaudeCommand =
  | { action: "toggle" | "off" | "status" | "new" | "esc" | "screen" }
  | { action: "on"; cwd?: string }
  | { action: "key"; key: string }
  | { action: "send"; text: string };

const CLAUDE_KEYS: Record<string, string> = {
  enter: "\r",
  esc: "\x1b",
  escape: "\x1b",
  up: "\x1b[A",
  down: "\x1b[B",
  left: "\x1b[D",
  right: "\x1b[C",
  tab: "\t",
  "shift-tab": "\x1b[Z",
  "ctrl-c": "\x03",
  y: "y",
  n: "n",
};

export function resolveClaudeKey(key: string): string | undefined {
  const normalized = key.trim().toLowerCase();
  if (/^[0-9]$/.test(normalized)) return normalized;
  return CLAUDE_KEYS[normalized];
}

/**
 * Parse `/claude …`. `commandBody` is the normalized first line (subcommand
 * detection); `rawBody` keeps every line so multi-line messages survive.
 */
export function parseClaudeCommand(
  commandBody: string,
  rawBody = commandBody,
): ClaudeCommand | null {
  const head = commandBody.match(/^\/claude(?:\s+([\s\S]*))?$/i);
  if (!head) return null;
  const rest = (head[1] ?? "").trim();
  if (!rest) return { action: "toggle" };
  const [word] = rest.split(/\s+/, 1);
  const arg = rest.slice(word.length).trim();
  switch (word.toLowerCase()) {
    case "on":
    case "start":
      return { action: "on", cwd: arg || undefined };
    case "off":
    case "exit":
      return { action: "off" };
    case "status":
      return { action: "status" };
    case "new":
    case "reset":
      return { action: "new" };
    case "esc":
    case "interrupt":
    case "cancel":
      return { action: "esc" };
    case "screen":
    case "peek":
      return { action: "screen" };
    case "key":
    case "press":
      if (arg) return { action: "key", key: arg };
      break;
  }
  const fullText = rawBody.replace(/^\s*\/claude(?:@\S+)?\s*:?/i, "").trim();
  return { action: "send", text: fullText || rest };
}

const reply = (text: string): CommandHandlerResult => ({ shouldContinue: false, reply: { text } });

async function loadTerminalManager(): Promise<TerminalManager | null> {
  const { getTerminalManager } = await import("../../gateway/server-methods/terminal.js");
  return getTerminalManager();
}

/**
 * Press Esc in the session's Claude terminal. Called from the fast-abort path
 * so /stop (and bare "stop"/"esc"/"wait"…) interrupt Claude in Claude mode —
 * those ride Telegram's control lane, so they land mid-turn.
 */
export async function interruptClaudeBridge(
  bridge: ClaudeBridgeState | undefined,
): Promise<boolean> {
  if (!bridge?.enabled) return false;
  const manager = await loadTerminalManager();
  if (!manager?.getTerminal(bridge.terminalId)) return false;
  manager.write(bridge.terminalId, "\x1b");
  return true;
}

function resolveCwd(input: string | undefined, fallback: string): { cwd?: string; error?: string } {
  const raw = input?.trim();
  if (!raw) return { cwd: fallback };
  const expanded = raw.startsWith("~") ? path.join(os.homedir(), raw.slice(1)) : raw;
  const resolved = path.resolve(expanded);
  try {
    if (fs.statSync(resolved).isDirectory()) return { cwd: resolved };
  } catch {
    // fall through
  }
  return { error: `Not a directory: ${resolved}` };
}

function defaultBridgeCwd(): string {
  return process.env.INFINIBOT_CLAUDE_BRIDGE_CWD?.trim() || process.cwd();
}

async function persistBridge(params: HandleCommandsParams, state: ClaudeBridgeState | undefined) {
  const { sessionEntry, sessionStore, sessionKey, storePath } = params;
  if (!sessionEntry || !sessionKey) return;
  if (state) sessionEntry.claudeBridge = state;
  else delete sessionEntry.claudeBridge;
  sessionEntry.updatedAt = Date.now();
  if (sessionStore) sessionStore[sessionKey] = sessionEntry;
  if (storePath) {
    await updateSessionStore(storePath, (store) => {
      store[sessionKey] = sessionEntry as SessionEntry;
    });
  }
}

function describeBridge(state: ClaudeBridgeState): string {
  return [
    `cwd: ${state.cwd}`,
    `session: ${state.claudeSessionId.slice(0, 8)}`,
    `attach: tmux -L ${resolveTmuxSocketName()} attach -t infinibot_${state.terminalId}`,
  ].join("\n");
}

function surfaceLabel(params: HandleCommandsParams): string {
  const surface = params.command.surface || params.command.channel;
  return surface ? surface.charAt(0).toUpperCase() + surface.slice(1) : "Chat";
}

async function ensureBridge(
  params: HandleCommandsParams,
  manager: TerminalManager,
  opts: { cwd?: string; fresh?: boolean },
): Promise<{ state?: ClaudeBridgeState; note?: string; launched?: boolean; error?: string }> {
  const { ensureClaudeBridge } = await import("../../terminal/claude-chat-bridge.js");
  const existing = params.sessionEntry?.claudeBridge;
  const cwd = opts.cwd ?? existing?.cwd ?? defaultBridgeCwd();
  const result = await ensureClaudeBridge({
    manager,
    sessionKey: params.sessionKey,
    cwd,
    title: `💬 Claude · ${surfaceLabel(params)}`,
    existing,
    fresh: opts.fresh || Boolean(existing && opts.cwd && opts.cwd !== existing.cwd),
  });
  if (!result.ok) return { error: result.error };
  return { state: result.state, note: result.note, launched: result.launched };
}

/** Forward one message into the bridge and turn the result into a chat reply. */
async function forwardToClaude(
  params: HandleCommandsParams,
  manager: TerminalManager,
  state: ClaudeBridgeState,
  text: string,
): Promise<ReplyPayload> {
  const { sendToClaudeBridge } = await import("../../terminal/claude-chat-bridge.js");
  const channel = params.ctx.OriginatingChannel || (params.command.channel as never);
  const to = params.ctx.OriginatingTo || params.command.from || params.command.to;
  const onProgress =
    channel && to
      ? async (progress: string) => {
          await routeReply({
            payload: { text: progress },
            channel,
            to,
            sessionKey: params.sessionKey,
            accountId: params.ctx.AccountId,
            threadId: params.ctx.MessageThreadId,
            cfg: params.cfg,
          }).catch((err) => logVerbose(`claude bridge progress delivery failed: ${String(err)}`));
        }
      : undefined;

  const result = await sendToClaudeBridge({ manager, state, text, onProgress });
  if (result.status === "not-accepted") {
    return {
      text: [
        "⚠️ Claude didn't pick up the message. Terminal:",
        "```",
        result.screen || "(empty)",
        "```",
        "Try /claude key enter, /claude esc, or /claude new.",
      ].join("\n"),
    };
  }
  if (result.status === "timeout") {
    return {
      text: `${result.text ? `${result.text}\n\n` : ""}⏳ Claude is still working — check /claude screen.`,
    };
  }
  return { text: result.text || "✅ Claude finished (no text reply)." };
}

function buildForwardText(params: HandleCommandsParams, body: string): string {
  const cleaned = body.replace(/<media:[a-z]+>/gi, "").trim();
  const media = params.ctx.MediaPaths?.length
    ? params.ctx.MediaPaths
    : params.ctx.MediaPath
      ? [params.ctx.MediaPath]
      : [];
  if (!media.length) return cleaned;
  const attachments = media.map((p) => `Attached file: ${p}`).join("\n");
  return cleaned ? `${cleaned}\n\n${attachments}` : attachments;
}

export const handleClaudeBridgeCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) return null;
  const normalized = params.command.commandBodyNormalized;
  const bridge = params.sessionEntry?.claudeBridge;
  const command = parseClaudeCommand(normalized, params.command.rawBodyNormalized);
  if (!command) return null;
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /claude from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  const manager = await loadTerminalManager();
  if (!manager) return reply("⚠️ Terminal manager isn't running on this gateway.");
  const bridgeLib = await import("../../terminal/claude-chat-bridge.js");

  const action = command.action === "toggle" ? (bridge?.enabled ? "off" : "on") : command.action;

  switch (action) {
    case "on":
    case "new": {
      const cwdInput = command.action === "on" ? command.cwd : undefined;
      const cwd = resolveCwd(cwdInput, bridge?.cwd ?? defaultBridgeCwd());
      if (cwd.error) return reply(`⚠️ ${cwd.error}`);
      const ensured = await ensureBridge(params, manager, {
        cwd: cwdInput ? cwd.cwd : undefined,
        fresh: action === "new",
      });
      if (!ensured.state) return reply(`⚠️ Couldn't start Claude: ${ensured.error}`);
      await persistBridge(params, { ...ensured.state, enabled: true });
      const lines = [
        `🟣 Claude mode ON — messages now go to ${ensured.launched ? "a new" : "your"} Claude Code session.`,
        describeBridge(ensured.state),
        "/claude off → back to the agent · /claude esc → interrupt",
      ];
      if (ensured.note) lines.splice(1, 0, `ℹ️ ${ensured.note}`);
      return reply(lines.join("\n"));
    }
    case "off": {
      if (!bridge?.enabled) return reply("Claude mode is already off.");
      await persistBridge(params, { ...bridge, enabled: false });
      return reply(
        "⚪ Claude mode OFF — back to the gateway agent. The Claude session stays alive; /claude resumes it, /claude new starts fresh.",
      );
    }
    case "status": {
      if (!bridge) return reply("Claude mode: off (no Claude session yet). Send /claude to start.");
      const alive = await bridgeLib.isClaudeBridgePaneAlive(manager, bridge.terminalId);
      const running = alive && (await bridgeLib.isClaudeRunningInPane(manager, bridge.terminalId));
      return reply(
        [
          `Claude mode: ${bridge.enabled ? "ON" : "off"}`,
          `terminal: ${alive ? (running ? "running" : "claude exited (next message relaunches)") : "gone (next message starts a new one)"}`,
          describeBridge(bridge),
        ].join("\n"),
      );
    }
    case "esc":
    case "key":
    case "screen": {
      if (!bridge) return reply("No Claude session yet. Send /claude to start one.");
      if (!(await bridgeLib.isClaudeBridgePaneAlive(manager, bridge.terminalId))) {
        return reply("The Claude terminal is gone. Send /claude new to start a fresh one.");
      }
      if (!manager.getTerminal(bridge.terminalId)) {
        await ensureBridge(params, manager, {});
      }
      if (action === "esc") {
        manager.write(bridge.terminalId, "\x1b");
        return reply("⏹ Sent Esc — Claude interrupted.");
      }
      if (action === "key" && command.action === "key") {
        const bytes = resolveClaudeKey(command.key);
        if (!bytes) {
          return reply(
            "Keys: enter, esc, up, down, left, right, tab, shift-tab, ctrl-c, y, n, 0-9",
          );
        }
        manager.write(bridge.terminalId, bytes);
        await new Promise((resolve) => setTimeout(resolve, 800));
      }
      const screen = await bridgeLib.captureClaudeBridgeScreen(manager, bridge.terminalId);
      return reply(["```", screen || "(empty)", "```"].join("\n"));
    }
    case "send": {
      if (command.action !== "send") return null;
      const ensured = await ensureBridge(params, manager, {});
      if (!ensured.state) return reply(`⚠️ Couldn't start Claude: ${ensured.error}`);
      // One-shot: keep the current mode, but remember the session for reuse.
      await persistBridge(params, { ...ensured.state, enabled: bridge?.enabled ?? false });
      const text = buildForwardText(params, command.text);
      return {
        shouldContinue: false,
        reply: await forwardToClaude(params, manager, ensured.state, text),
      };
    }
  }
  return null;
};

/**
 * Last in the handler chain: in Claude mode, any message no built-in command
 * claimed goes to Claude instead of the gateway agent.
 */
export const handleClaudeBridgePassthrough: CommandHandler = async (params) => {
  const bridge = params.sessionEntry?.claudeBridge;
  if (!bridge?.enabled) return null;
  if (!params.command.isAuthorizedSender) return null;
  const text = buildForwardText(params, params.command.rawBodyNormalized);
  if (!text) return null;

  const manager = await loadTerminalManager();
  if (!manager) return reply("⚠️ Claude mode is on, but the terminal manager isn't running.");
  const ensured = await ensureBridge(params, manager, {});
  if (!ensured.state) return reply(`⚠️ Couldn't reach Claude: ${ensured.error}`);
  if (
    ensured.state.terminalId !== bridge.terminalId ||
    ensured.state.claudeSessionId !== bridge.claudeSessionId
  ) {
    await persistBridge(params, ensured.state);
  }
  const payload = await forwardToClaude(params, manager, ensured.state, text);
  if (ensured.note && ensured.launched) {
    payload.text = `ℹ️ ${ensured.note}\n\n${payload.text ?? ""}`;
  }
  return { shouldContinue: false, reply: payload };
};
