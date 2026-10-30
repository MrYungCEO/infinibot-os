/**
 * CLI sessions a voice call can be routed to — the catalogue the Voice page's
 * selector shows, and the I/O port a routed turn talks through.
 *
 * Catalogue (`listVoiceCliCatalogue`):
 *   open       every live InfiniBot terminal (in memory, plus tmux sessions
 *              that survived a restart and can be re-attached), and every
 *              running CLI coder run (claude_coder / codex / opencode /
 *              gemini) with its label, cwd and status;
 *   installed  every agent CLI found on the (enriched) PATH — claude, codex,
 *              opencode, gemini, grok, aider, qwen, goose, cursor-agent, amp, crush,
 *              ollama — marking the configured coder backend; each can start
 *              a new terminal session in a chosen cwd (`startVoiceCliSession`).
 *
 * Port (`openCliSessionPort`), per target kind:
 *   terminal   type the words + Enter into the PTY; output = the PTY tap;
 *              raw keys answer permission prompts and interrupt (Esc/Ctrl-C).
 *   coder      deliver the words through the run's in-flight inbox (the
 *              channel coder runs actually read mid-turn); output = its pane
 *              (PTY tap, else tmux capture polling). Coder runs run headless
 *              without permission prompts; "interrupt" is an inbox stop
 *              request, never a kill.
 */

import fs from "node:fs";

import { isFleetTenantMachineEnv } from "../../saas/fleet-config-guard.js";
import { detectStartupPrompt, stripAnsi } from "./voice-cli-output.js";
import type { VoiceCliTarget } from "./voice-cli-route.js";
import { openCliTranscript, type CliTranscriptSource } from "./voice-cli-transcript.js";

export type VoiceCliOpenSession = {
  kind: "terminal" | "coder";
  /** Stable id for the selector: terminal id or run id. */
  id: string;
  terminalId?: string;
  runId?: string;
  label: string;
  cliType: string;
  cwd: string;
  status: "live" | "running" | "detached";
  /** Terminal only in tmux (survived a restart): selecting it re-attaches. */
  needsAttach?: boolean;
  createdAt?: string;
  lastActiveAt?: string;
  task?: string;
};

export type VoiceCliInstalled = {
  id: string;
  name: string;
  bin: string;
  path: string;
  /** The coder backend configured in `coder.backend`. */
  coderBackend?: boolean;
  /** Can be launched by TerminalManager.invokeAgentCLI (flags, session ids). */
  managed: boolean;
};

export type VoiceCliCatalogue = {
  open: VoiceCliOpenSession[];
  installed: VoiceCliInstalled[];
  missing: string[];
  /** Cloud catalogues are resolved inside this tenant's container only. */
  runtime: "local" | "tenant-container";
  /** Explicit empty state for hosted workspaces whose image has no agent CLI. */
  unavailableReason?: string;
};

/** Agent CLIs we look for. `managed` = TerminalManager knows how to launch it. */
export const KNOWN_CLIS: Array<{
  id: string;
  name: string;
  bin: string;
  managed: boolean;
  coderId?: string;
}> = [
  { id: "claude", name: "Claude Code", bin: "claude", managed: true, coderId: "claude-code" },
  { id: "codex", name: "Codex", bin: "codex", managed: true, coderId: "codex" },
  { id: "opencode", name: "OpenCode", bin: "opencode", managed: true, coderId: "opencode" },
  { id: "gemini", name: "Gemini CLI", bin: "gemini", managed: true, coderId: "gemini" },
  { id: "grok", name: "Grok Build", bin: "grok", managed: true, coderId: "grok" },
  { id: "aider", name: "Aider", bin: "aider", managed: false },
  { id: "qwen", name: "Qwen Code", bin: "qwen", managed: false },
  { id: "goose", name: "Goose", bin: "goose", managed: false },
  { id: "cursor-agent", name: "Cursor Agent", bin: "cursor-agent", managed: false },
  { id: "amp", name: "Amp", bin: "amp", managed: false },
  { id: "crush", name: "Crush", bin: "crush", managed: false },
  { id: "ollama", name: "Ollama", bin: "ollama", managed: true },
];

type TerminalLike = {
  id: string;
  title?: string;
  cwd?: string;
  cliType?: string;
  isClaudeMode?: boolean;
  outputBuffer?: string;
  createdAt?: Date | string;
  /** Claude Code `--session-id` the terminal launched it with (its transcript file name). */
  claudeSessionId?: string;
};

/** The pieces of the gateway this module needs (injectable for tests). */
export type VoiceCliHost = {
  listTerminals(): Array<{
    id: string;
    title?: string;
    cwd?: string;
    cliType?: string;
    isClaudeMode?: boolean;
    createdAt?: string;
    lastActiveAt?: string;
  }>;
  getTerminal(id: string): TerminalLike | undefined;
  isTerminalAlive(id: string): boolean;
  write(id: string, data: string): void;
  subscribeOutput(id: string, cb: (chunk: string) => void): () => void;
  createTerminal(opts: {
    id?: string;
    cwd?: string;
    title?: string;
  }): Promise<{ success: boolean; terminalId?: string; error?: string }>;
  invokeAgentCli(id: string, cli: string): Promise<void>;
  /** tmux sessions that are live but not in memory (id, cwd, label, kind). */
  listDetached(): Promise<Array<{ id: string; cwd: string; label: string; cliType?: string }>>;
  capturePane(id: string): Promise<string>;
  listCoderRuns(): Array<{
    runId: string;
    label?: string;
    task?: string;
    workdir?: string;
    coderBackend?: string;
    terminalId?: string;
    startedAt?: number;
    running: boolean;
  }>;
  sendToCoder(
    runId: string,
    text: string,
  ): Promise<{ ok: boolean; status: string; error?: string }>;
  resolveBin(bin: string): string | undefined;
  coderBackendId(): string | undefined;
  /** Foreground process of the terminal's pane ("claude", "bash"…); null = unknown. */
  paneCommand?(id: string): Promise<string | null>;
  /** The terminal's visible screen as rendered text (ANSI stripped). */
  screen?(id: string): Promise<string>;
};

/** Pane foreground commands that mean "the CLI exited back to the shell prompt". */
const SHELLS = new Set(["bash", "zsh", "sh", "dash", "fish", "ksh", "tcsh", "csh", "nu", "pwsh"]);

/** A CLI still booting (its questions may follow). */
const STARTING = /waiting for startup|starting up|initializing|loading…/i;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The CLI (not just the terminal) is running: false once the pane is back at a shell. */
export async function cliRunning(
  host: VoiceCliHost,
  id: string,
  cliType: string,
): Promise<boolean> {
  if (!host.paneCommand || cliType === "shell") return true;
  const cmd = await host.paneCommand(id).catch(() => null);
  return !cmd || !SHELLS.has(cmd.toLowerCase());
}

/**
 * Answer startup questions on screen (folder trust / bypass-permissions
 * confirmation) so typed words never land in them. Returns how many were answered.
 */
export async function settleStartupPrompts(
  host: VoiceCliHost,
  id: string,
  opts: { maxAnswers?: number; waitMs?: number } = {},
): Promise<number> {
  if (!host.screen) return 0;
  let answered = 0;
  const deadline = Date.now() + (opts.waitMs ?? 6_000);
  while (answered < (opts.maxAnswers ?? 3)) {
    const prompt = detectStartupPrompt(await host.screen(id).catch(() => ""));
    if (!prompt) return answered;
    host.write(id, prompt.keys);
    answered++;
    // Wait for that question to leave the screen before looking again.
    while (Date.now() < deadline) {
      await sleep(250);
      const next = detectStartupPrompt(await host.screen(id).catch(() => ""));
      if (!next || next.raw !== prompt.raw) break;
    }
    if (Date.now() >= deadline) return answered;
  }
  return answered;
}

/**
 * After launching a CLI in a terminal: answer its startup questions and wait
 * until it is up (the pane runs the CLI and its screen has stopped changing),
 * so the first voice turn is typed into the CLI, not into bash or a prompt.
 */
export async function waitForCliReady(
  host: VoiceCliHost,
  id: string,
  cliType: string,
  timeoutMs = 25_000,
): Promise<boolean> {
  if (!host.screen) return true;
  const deadline = Date.now() + timeoutMs;
  let last = "";
  let stable = 0;
  let answers = 0;
  while (Date.now() < deadline) {
    await sleep(400);
    const screen = await host.screen(id).catch(() => "");
    if (answers < 3 && detectStartupPrompt(screen)) {
      answers += await settleStartupPrompts(host, id, { maxAnswers: 1 });
      stable = 0;
      continue;
    }
    const cmd = host.paneCommand ? await host.paneCommand(id).catch(() => null) : null;
    const inCli = cliType === "shell" || (cmd !== null && !SHELLS.has(cmd.toLowerCase()));
    // Up = the CLI owns the pane and its screen held still for ~1.2 s, past its
    // own startup banner (Codex asks its questions only after "Waiting for startup").
    if (inCli && screen.trim() && screen === last && !STARTING.test(screen)) {
      if (++stable >= 3) return true;
    } else stable = 0;
    last = screen;
  }
  return false;
}

function cliOfTerminal(t: { cliType?: string; isClaudeMode?: boolean }): string {
  if (t.cliType) return t.cliType;
  return t.isClaudeMode ? "claude" : "shell";
}

function cliOfBackend(b: string | undefined): string {
  if (!b) return "claude";
  return b === "claude-code" ? "claude" : b;
}

export async function listVoiceCliCatalogue(
  host: VoiceCliHost,
  opts: { cloud?: boolean } = {},
): Promise<VoiceCliCatalogue> {
  const open: VoiceCliOpenSession[] = [];
  const seenTerminals = new Set<string>();
  const runs = host.listCoderRuns().filter((r) => r.running);
  const coderTerminals = new Set(runs.map((r) => r.terminalId).filter(Boolean) as string[]);

  for (const r of runs) {
    open.push({
      kind: "coder",
      id: r.runId,
      runId: r.runId,
      ...(r.terminalId ? { terminalId: r.terminalId } : {}),
      label: (r.label || r.task || r.runId).replace(/\s+/g, " ").slice(0, 80),
      cliType: cliOfBackend(r.coderBackend),
      cwd: r.workdir ?? "",
      status: "running",
      ...(r.startedAt ? { createdAt: new Date(r.startedAt).toISOString() } : {}),
      ...(r.task ? { task: r.task.slice(0, 200) } : {}),
    });
  }
  for (const t of host.listTerminals()) {
    if (coderTerminals.has(t.id)) continue;
    if (!host.isTerminalAlive(t.id)) continue;
    seenTerminals.add(t.id.replace(/[^a-zA-Z0-9_]/g, "_"));
    let cliType = cliOfTerminal(t);
    // Re-adopted after a restart, the CLI type can be lost: ask the pane what runs in it.
    if (cliType === "shell" && host.paneCommand) {
      const cmd = (await host.paneCommand(t.id).catch(() => null))?.toLowerCase();
      const known = cmd ? KNOWN_CLIS.find((c) => c.bin === cmd) : undefined;
      if (known) cliType = known.id;
    }
    open.push({
      kind: "terminal",
      id: t.id,
      terminalId: t.id,
      label: t.title || t.id,
      cliType,
      cwd: t.cwd ?? "",
      status: "live",
      ...(t.createdAt ? { createdAt: t.createdAt } : {}),
      ...(t.lastActiveAt ? { lastActiveAt: t.lastActiveAt } : {}),
    });
  }
  try {
    for (const d of await host.listDetached()) {
      const canon = d.id.replace(/[^a-zA-Z0-9_]/g, "_");
      if (seenTerminals.has(canon) || coderTerminals.has(d.id)) continue;
      open.push({
        kind: "terminal",
        id: d.id,
        terminalId: d.id,
        label: d.label || d.id,
        cliType: d.cliType || "shell",
        cwd: d.cwd,
        status: "detached",
        needsAttach: true,
      });
    }
  } catch {
    /* tmux missing / not reachable: in-memory terminals are still listed */
  }

  const coderBackend = host.coderBackendId();
  const installed: VoiceCliInstalled[] = [];
  const missing: string[] = [];
  for (const c of KNOWN_CLIS) {
    const p = host.resolveBin(c.bin);
    if (!p) {
      missing.push(c.id);
      continue;
    }
    installed.push({
      id: c.id,
      name: c.name,
      bin: c.bin,
      path: p,
      managed: c.managed,
      ...(c.coderId && c.coderId === coderBackend ? { coderBackend: true } : {}),
    });
  }
  const runtime = opts.cloud ? "tenant-container" : "local";
  return {
    open,
    installed,
    missing,
    runtime,
    ...(opts.cloud && open.length === 0 && installed.length === 0
      ? { unavailableReason: "No CLI available on Cloud for this workspace." }
      : {}),
  };
}

/** Start a new terminal in `cwd` running `cli`; returns the target to route to. */
export async function startVoiceCliSession(
  host: VoiceCliHost,
  opts: { cli: string; cwd?: string; title?: string },
): Promise<VoiceCliTarget> {
  const known = KNOWN_CLIS.find((c) => c.id === opts.cli);
  if (!known && opts.cli !== "shell") throw new Error(`unknown CLI "${opts.cli}"`);
  if (known && !host.resolveBin(known.bin))
    throw new Error(`${known.name} is not installed on this machine`);
  const cwd = opts.cwd?.trim() || undefined;
  if (cwd && !fs.existsSync(cwd)) throw new Error(`folder not found: ${cwd}`);
  const title = opts.title?.trim() || `Voice · ${known?.name ?? "Shell"}`;
  const created = await host.createTerminal({ cwd, title });
  if (!created.success || !created.terminalId)
    throw new Error(created.error || "could not open a terminal");
  const id = created.terminalId;
  if (known) {
    if (known.managed) await host.invokeAgentCli(id, known.id);
    else host.write(id, `${known.bin}\r`);
    await waitForCliReady(host, id, known.id);
  }
  const term = host.getTerminal(id);
  return {
    kind: "terminal",
    terminalId: id,
    cliType: known?.id ?? "shell",
    label: title,
    cwd: term?.cwd ?? cwd,
  };
}

// ── the port a routed turn uses ────────────────────────────────────────────────

export type CliSessionPort = {
  readonly label: string;
  readonly cliType: string;
  /** Raw keys can be written (approval answers, Esc / Ctrl-C). */
  readonly acceptsKeys: boolean;
  isAlive(): Promise<boolean>;
  /** Deliver the caller's words as input. */
  send(text: string): Promise<void>;
  keys(data: string): Promise<void>;
  /** Live output; returns unsubscribe. */
  subscribe(cb: (chunk: string) => void): () => void;
  /** Recent raw output (approval prompt already on screen, etc.). */
  snapshot(): Promise<string>;
  /** Stop the session's current work. Returns how it was done. */
  interrupt(): Promise<"keys" | "inbox" | "none">;
  /**
   * The CLI's own transcript, positioned at "now" (Claude Code / Codex): the
   * authoritative reply text and end-of-turn. Absent / null → no transcript.
   */
  transcript?(): CliTranscriptSource | null;
  /** The rendered screen (ANSI stripped) — the reply source when there is no transcript. */
  screen?(): Promise<string>;
};

/** Words, then Enter after a beat: agent TUIs treat one fast write with \r as a paste. */
export const ENTER_DELAY_MS = 120;
const CAPTURE_POLL_MS = 700;

export async function openCliSessionPort(
  host: VoiceCliHost,
  target: VoiceCliTarget,
  opts: { interruptKeys: (cliType: string) => string },
): Promise<CliSessionPort | null> {
  if (target.kind === "terminal" && target.terminalId) {
    let id = target.terminalId;
    if (!host.getTerminal(id)) {
      // Survived a restart in tmux only: attach (idempotent `new-session -A`).
      const attached = await host
        .createTerminal({ id, cwd: target.cwd, title: target.label })
        .catch(() => null);
      if (!attached?.success) return null;
      id = attached.terminalId ?? id;
    }
    const term = host.getTerminal(id);
    const cliType = target.cliType || (term ? cliOfTerminal(term) : "shell");
    const screen = host.screen?.bind(host);
    return {
      label: target.label,
      cliType,
      acceptsKeys: true,
      // The terminal alone is not enough: a CLI that exited leaves a live bash,
      // and words typed there run as shell commands.
      isAlive: async () =>
        !!host.getTerminal(id) && host.isTerminalAlive(id) && (await cliRunning(host, id, cliType)),
      send: async (text) => {
        await settleStartupPrompts(host, id);
        host.write(id, text.replace(/[\r\n]+/g, " "));
        await new Promise((r) => setTimeout(r, ENTER_DELAY_MS));
        host.write(id, "\r");
      },
      keys: async (data) => host.write(id, data),
      subscribe: (cb) => host.subscribeOutput(id, cb),
      snapshot: async () => (host.getTerminal(id)?.outputBuffer ?? "").slice(-8_000),
      interrupt: async () => {
        host.write(id, opts.interruptKeys(cliType));
        return "keys";
      },
      transcript: () => {
        const t = host.getTerminal(id);
        const created = t?.createdAt ? new Date(t.createdAt).getTime() : undefined;
        return openCliTranscript({
          cliType,
          sessionId: t?.claudeSessionId,
          cwd: t?.cwd ?? target.cwd,
          ...(created && Number.isFinite(created) ? { createdAtMs: created } : {}),
        });
      },
      ...(screen ? { screen: () => screen(id) } : {}),
    };
  }
  if (target.kind === "coder" && target.runId) {
    const runId = target.runId;
    const runOf = () => host.listCoderRuns().find((r) => r.runId === runId);
    const run = runOf();
    if (!run) return null;
    const paneId = run.terminalId;
    const inMemory = () => (paneId ? host.getTerminal(paneId) : undefined);
    const cliType = target.cliType || cliOfBackend(run.coderBackend);
    return {
      label: target.label,
      cliType,
      acceptsKeys: false,
      isAlive: async () => !!runOf()?.running,
      send: async (text) => {
        const r = await host.sendToCoder(runId, text);
        if (!r.ok) throw new Error(r.error || `message not delivered (${r.status})`);
      },
      keys: async () => {
        /* headless coder runs take no raw keys */
      },
      subscribe: (cb) => {
        if (paneId && inMemory()) return host.subscribeOutput(paneId, cb);
        if (!paneId) return () => {};
        // Pane not attached in memory: poll tmux and pass on what is new.
        let last = "";
        let stopped = false;
        const tick = async () => {
          if (stopped) return;
          const now = await host.capturePane(paneId).catch(() => "");
          if (now && now !== last) {
            const fresh = now.startsWith(last)
              ? now.slice(last.length)
              : now.split("\n").slice(-40).join("\n");
            last = now;
            if (fresh.trim()) cb(fresh);
          }
        };
        void host
          .capturePane(paneId)
          .then((s) => (last = s))
          .catch(() => {});
        const timer = setInterval(() => void tick(), CAPTURE_POLL_MS);
        timer.unref?.();
        return () => {
          stopped = true;
          clearInterval(timer);
        };
      },
      snapshot: async () => {
        const mem = inMemory()?.outputBuffer;
        if (mem) return mem.slice(-8_000);
        return paneId ? (await host.capturePane(paneId).catch(() => "")).slice(-8_000) : "";
      },
      interrupt: async () => {
        const r = await host.sendToCoder(
          runId,
          "STOP: the owner interrupted you by voice. Stop the current step now and wait for their next instruction.",
        );
        return r.ok ? "inbox" : "none";
      },
    };
  }
  return null;
}

// ── the real gateway host ──────────────────────────────────────────────────────

/** Wire the catalogue / port to the gateway's terminal manager and coder runs. */
export async function defaultVoiceCliHost(): Promise<VoiceCliHost> {
  const [{ getTerminalManager }, tmux, reattach, registry, inbox, binDetect, coderRegistry] =
    await Promise.all([
      import("../server-methods/terminal.js"),
      import("../../terminal/tmux-backend.js"),
      import("../../terminal/reattachable.js"),
      import("../../agents/subagent-registry.js"),
      import("../../agents/subagent-inbox/service.js"),
      import("../../agents/coder-backend/bin-detect.js"),
      import("../../agents/coder-backend/registry.js"),
    ]);
  const mgr = () => {
    const m = getTerminalManager();
    if (!m) throw new Error("terminal manager not initialized");
    return m;
  };
  return {
    listTerminals: () =>
      (getTerminalManager()?.list() ?? []).map((s) => ({
        id: s.id,
        title: s.title,
        cwd: s.cwd,
        cliType: s.cliType,
        isClaudeMode: s.isClaudeMode,
        createdAt: s.createdAt,
        lastActiveAt: s.lastActiveAt,
      })),
    getTerminal: (id) => getTerminalManager()?.getTerminal(id) as TerminalLike | undefined,
    isTerminalAlive: (id) => getTerminalManager()?.isTerminalAlive(id) ?? false,
    write: (id, data) => mgr().write(id, data),
    subscribeOutput: (id, cb) => mgr().subscribePtyOutput(id, cb),
    createTerminal: async (o) => {
      // TerminalManager needs the caller's id (the UI mints `term_<ts>_<rand>` too).
      const id = o.id ?? `term_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const r = await mgr().create({ id, cwd: o.cwd, title: o.title });
      return { success: r.success, terminalId: r.terminalId ?? id, error: r.error };
    },
    invokeAgentCli: (id, cli) => mgr().invokeAgentCLI(id, cli as never),
    listDetached: async () => {
      const m = getTerminalManager();
      if (!m || !tmux.isTmuxAvailable()) return [];
      const live = [...(await tmux.listLiveSessions())];
      const saved = new Map(
        m.getSavedSessions().map((s) => [reattach.sanitizeTerminalId(s.id), s]),
      );
      const out: Array<{ id: string; cwd: string; label: string; cliType?: string }> = [];
      for (const id of live) {
        if (m.getTerminal(id) || reattach.isSpawnSessionId(id)) continue;
        // Only our own terminals (the tmux socket can be shared).
        const s = saved.get(reattach.sanitizeTerminalId(id));
        if (!s) continue;
        out.push({
          id: s.id,
          cwd: s.cwd || (await tmux.getSessionCwd(id)) || "",
          label: s.title || s.id,
          cliType: s.cliType || (s.isClaudeMode ? "claude" : undefined),
        });
      }
      return out;
    },
    capturePane: (id) => tmux.capturePane(id, 200),
    listCoderRuns: () =>
      registry
        .listAllSubagentRuns()
        .filter((r) => inbox.isCoderRun(r))
        .map((r) => ({
          runId: r.runId,
          label: r.label,
          task: r.task,
          workdir: r.workdir,
          coderBackend: r.coderBackend,
          terminalId: r.terminalId,
          startedAt: r.startedAt ?? r.createdAt,
          running: inbox.isRunAcceptingMessages(r),
        })),
    sendToCoder: async (runId, text) => {
      const r = await inbox.sendSubagentMessage({ runId, message: text, from: "voice" });
      return { ok: r.ok, status: String(r.status), error: r.error };
    },
    resolveBin: (bin) => binDetect.resolveBin(bin),
    ...(tmux.isTmuxAvailable()
      ? {
          paneCommand: (id: string) => tmux.getPaneCurrentCommand(id),
          // Visible screen only (-S -0): what the CLI shows now, not the scrollback.
          screen: async (id: string) => stripAnsi(await tmux.capturePane(id, 0)),
        }
      : {}),
    coderBackendId: () => {
      try {
        return coderRegistry.getCoderBackendId();
      } catch {
        return undefined;
      }
    },
  };
}

/** True only on a per-tenant fleet Machine; never inferred from the browser. */
export function voiceCliRunsInTenantContainer(env: NodeJS.ProcessEnv = process.env): boolean {
  return isFleetTenantMachineEnv(env);
}
