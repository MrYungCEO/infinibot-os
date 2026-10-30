/**
 * Browser / device-code sign-in for coder CLIs, surfaced in the Setup › Coders
 * sign-in modal.
 *
 * The CLI's own login command (catalog `auth[].loginArgs`, e.g.
 * `claude auth login`, `codex login --device-auth`) runs inside a PTY so it
 * behaves exactly as in a terminal. We scrape the sign-in URL and one-time
 * code out of its output, and forward a pasted authorization code back into
 * the PTY when the CLI asks for one. The CLI stores the resulting credential
 * itself (under HOME, which is /data/home on a hosted Machine, so it survives
 * restarts); InfiniBot never sees or logs the token.
 *
 * Sessions expire after 15 minutes and are killed on completion, so nothing
 * lingers to keep a hosted Machine awake.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveBin } from "../coder-backend/bin-detect.js";
import { isWindowsBatchCommand, resolveCmdShimTarget } from "../../process/win-spawn.js";
import {
  getCoderEntry,
  type CoderAuthMethod,
  type CoderCatalogEntry,
  type CoderId,
} from "./catalog.js";
import { managedBinPath, scrubbedEnv } from "./installer.js";
import { codersRoot } from "./paths.js";
import { cleanLogText, stripAnsi } from "./redact.js";

export type LoginStatus =
  | "starting"
  | "waiting"
  | "verifying"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "expired";

export interface LoginSessionView {
  sessionId: string;
  coderId: CoderId;
  status: LoginStatus;
  /** Sign-in URL to open in the browser. */
  url?: string;
  /** Device / one-time code to enter on that page. */
  userCode?: string;
  /** The CLI is waiting for a pasted authorization code. */
  needsCode: boolean;
  /** Redacted output tail for the modal's details drawer. */
  output: string;
  startedAt: number;
  finishedAt?: number;
  error?: string;
}

interface PtyLike {
  write(data: string): void;
  kill(signal?: string): void;
  onData(cb: (d: string) => void): unknown;
  onExit(cb: (e: { exitCode: number }) => void): unknown;
}

export type PtySpawner = (
  file: string,
  args: string[],
  opts: { env: NodeJS.ProcessEnv; cols: number; rows: number; cwd?: string },
) => PtyLike;

interface Session extends LoginSessionView {
  scope: string;
  raw: string;
  pty: PtyLike | null;
  timer?: ReturnType<typeof setTimeout>;
  watch?: ReturnType<typeof setInterval>;
  answered?: Set<number>;
}

const AUTH_WATCH_MS = 1500;

/**
 * Size+mtime of the CLI's credential files. A change after the sign-in
 * started means it finished, for CLIs that keep running afterwards (Gemini).
 */
export function authFileStamp(
  entry: Pick<CoderCatalogEntry, "authFiles" | "authHomeEnv">,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string {
  const parts: string[] = [];
  for (const raw of entry.authFiles ?? []) {
    let file = raw;
    const relocated = entry.authHomeEnv && env[entry.authHomeEnv.env]?.trim();
    if (relocated && entry.authHomeEnv && file.startsWith(entry.authHomeEnv.replaces)) {
      file = path.join(relocated, file.slice(entry.authHomeEnv.replaces.length));
    } else if (file.startsWith("~/")) {
      file = path.join(home, file.slice(2));
    }
    try {
      const st = fs.statSync(file);
      if (st.size > 0) parts.push(`${file}:${st.size}:${st.mtimeMs}`);
    } catch {
      /* not there yet */
    }
  }
  return parts.join("|");
}

const SESSION_TTL_MS = 15 * 60_000;
const MAX_SESSIONS = 4;
const sessions = new Map<string, Session>();

let spawner: PtySpawner | null = null;

async function defaultSpawner(): Promise<PtySpawner> {
  const mod = (await import("@lydell/node-pty")) as unknown as {
    spawn: (f: string, a: string[], o: Record<string, unknown>) => PtyLike;
  };
  return (file, args, opts) =>
    mod.spawn(file, args, {
      name: "xterm-256color",
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd,
      env: opts.env,
    });
}

/** Test hook: replace the PTY implementation. */
export function _setPtySpawner(fn: PtySpawner | null): void {
  spawner = fn;
}

const URL_RE_G = /https?:\/\/[^\s"'<>\u0007│]+/g;
// Device codes look like ABCD-EFGH / 3VL0-Z5RSP. Must follow the URL.
const CODE_RE = /\b([A-Z0-9]{4,5}-[A-Z0-9]{4,6})\b/;
const PASTE_RE =
  /paste (?:the )?(?:authorization )?code|enter (?:the )?(?:authorization )?code here|enter the authorization code/i;
// Sign-in pages, as opposed to docs/terms links a CLI prints on its way there.
const AUTH_URL_RE =
  /oauth|authori[sz]e|\/device|\/login|signin|sign-in|accounts\.|auth\.|\/auth\b|user_code=|code_challenge/i;

const NOT_SIGNIN_URL_RE = /\btos\b|privacy|terms|\/docs?\/|\/help\b|github\.com/i;

/** Pull URL / device code / paste prompt out of accumulated CLI output. */
export function parseLoginOutput(raw: string): {
  url?: string;
  userCode?: string;
  needsCode: boolean;
} {
  const text = stripAnsi(raw);
  const all = [...text.matchAll(URL_RE_G)].map((m) => ({
    url: m[0].replace(/[).,]+$/, ""),
    index: m.index ?? 0,
    len: m[0].length,
  }));
  // The last sign-in-looking URL wins. A CLI may print terms/docs links on
  // its way there (Gemini's auth menu shows its ToS page): those are never
  // the sign-in link, so they are skipped rather than opened.
  const pick =
    [...all].reverse().find((u) => AUTH_URL_RE.test(u.url)) ??
    [...all].reverse().find((u) => !NOT_SIGNIN_URL_RE.test(u.url));
  let userCode: string | undefined;
  if (pick) {
    const after = text.slice(pick.index + pick.len);
    userCode = after.match(CODE_RE)?.[1];
  }
  return { url: pick?.url, userCode, needsCode: PASTE_RE.test(text) };
}

function view(s: Session): LoginSessionView {
  const {
    scope: _scope,
    raw: _raw,
    pty: _pty,
    timer: _timer,
    watch: _watch,
    answered: _answered,
    ...rest
  } = s;
  return { ...rest };
}

function finish(s: Session, status: LoginStatus, error?: string) {
  if (s.finishedAt) return;
  s.status = status;
  s.finishedAt = Date.now();
  if (error) s.error = error;
  if (s.timer) clearTimeout(s.timer);
  if (s.watch) clearInterval(s.watch);
  try {
    s.pty?.kill();
  } catch {
    /* already exited */
  }
  s.pty = null;
  // Keep the finished view around briefly for the modal's last poll.
  const t = setTimeout(() => sessions.delete(s.sessionId), 5 * 60_000);
  t.unref?.();
}

function oauthMethod(id: CoderId): CoderAuthMethod | undefined {
  return getCoderEntry(id)?.auth.find((a) => a.kind === "oauth-login" && a.loginArgs?.length);
}

export async function startLogin(
  id: CoderId,
): Promise<{ ok: true; session: LoginSessionView } | { ok: false; code: string; message: string }> {
  const entry = getCoderEntry(id);
  if (!entry) return { ok: false, code: "NOT_FOUND", message: `Unknown coder: ${String(id)}` };
  const method = oauthMethod(entry.id);
  if (!method) {
    return {
      ok: false,
      code: "UNSUPPORTED",
      message: `${entry.name} has no browser sign-in; add an API key instead.`,
    };
  }
  const bin = managedBinPath(entry) ?? resolveBin(entry.bin);
  if (!bin) return { ok: false, code: "NOT_INSTALLED", message: `Install ${entry.name} first.` };

  const scope = codersRoot();
  for (const s of sessions.values()) {
    if (s.scope === scope && s.coderId === entry.id && !s.finishedAt) finish(s, "cancelled");
  }
  const live = [...sessions.values()].filter((s) => !s.finishedAt).length;
  if (live >= MAX_SESSIONS)
    return { ok: false, code: "BUSY", message: "Too many sign-ins in progress." };

  const session: Session = {
    sessionId: randomUUID(),
    coderId: entry.id,
    status: "starting",
    needsCode: false,
    output: "",
    startedAt: Date.now(),
    scope,
    raw: "",
    pty: null,
  };
  sessions.set(session.sessionId, session);

  try {
    const spawn = spawner ?? (await defaultSpawner());
    // Windows: run a .cmd shim's real target (node.exe + script, or the .exe)
    // rather than handing a batch file to the PTY.
    const target = isWindowsBatchCommand(bin) ? resolveCmdShimTarget(bin) : null;
    const file = target?.command ?? bin;
    const args = [...(target?.prefixArgs ?? []), ...method.loginArgs!];
    // Very wide PTY so long OAuth URLs are never wrapped mid-string.
    const pty = spawn(file, args, {
      env: scrubbedEnv({
        TERM: "xterm-256color",
        BROWSER: "true",
        NO_COLOR: "1",
        ...method.loginEnv,
      }),
      cols: 2000,
      rows: 50,
      cwd: process.env.HOME ?? os.homedir(),
    });
    session.pty = pty;
    const answers = method.loginAnswers ?? [];
    session.answered = new Set();
    pty.onData((d) => {
      if (session.raw.length < 200_000) session.raw += d;
      if (answers.length) {
        const plain = stripAnsi(session.raw);
        answers.forEach((a, i) => {
          if (session.answered!.has(i) || !new RegExp(a.when, "i").test(plain)) return;
          session.answered!.add(i);
          // Let the menu finish drawing before the keypress.
          setTimeout(() => {
            if (!session.finishedAt) session.pty?.write(a.send);
          }, 400).unref?.();
        });
      }
      const parsed = parseLoginOutput(session.raw);
      if (parsed.url) session.url = parsed.url;
      if (parsed.userCode) session.userCode = parsed.userCode;
      session.needsCode = parsed.needsCode;
      if (session.status === "starting" && (session.url || session.userCode))
        session.status = "waiting";
      session.output = cleanLogText(session.raw).split("\n").slice(-40).join("\n");
    });
    pty.onExit(({ exitCode }) => {
      session.output = cleanLogText(session.raw).split("\n").slice(-40).join("\n");
      if (session.finishedAt) return;
      if (exitCode === 0) finish(session, "succeeded");
      else finish(session, "failed", `Sign-in exited with code ${exitCode}.`);
    });
    session.timer = setTimeout(
      () => finish(session, "expired", "Sign-in timed out after 15 minutes."),
      SESSION_TTL_MS,
    );
    session.timer.unref?.();
    if (entry.authFiles?.length) {
      const before = authFileStamp(entry);
      session.watch = setInterval(() => {
        const now = authFileStamp(entry);
        if (now && now !== before) {
          session.output = cleanLogText(session.raw).split("\n").slice(-40).join("\n");
          finish(session, "succeeded");
        }
      }, AUTH_WATCH_MS);
      session.watch.unref?.();
    }
  } catch (err) {
    finish(session, "failed", (err as Error).message ?? String(err));
  }
  return { ok: true, session: view(session) };
}

function own(sessionId: unknown): Session | undefined {
  if (typeof sessionId !== "string") return undefined;
  const s = sessions.get(sessionId);
  // A session is only visible from the scope (tenant root) that started it.
  return s && s.scope === codersRoot() ? s : undefined;
}

export function pollLogin(sessionId: unknown): LoginSessionView | undefined {
  const s = own(sessionId);
  return s ? view(s) : undefined;
}

export function submitLoginCode(
  sessionId: unknown,
  code: unknown,
): { ok: boolean; message?: string } {
  const s = own(sessionId);
  if (!s || s.finishedAt || !s.pty) return { ok: false, message: "No active sign-in." };
  if (typeof code !== "string") return { ok: false, message: "Code must be a string." };
  const c = code.trim();
  // eslint-disable-next-line no-control-regex
  if (!c || c.length > 4096 || /[\u0000-\u001f\u007f]/.test(c))
    return { ok: false, message: "That code doesn't look right." };
  s.pty.write(`${c}\r`);
  s.status = "verifying";
  return { ok: true };
}

export function cancelLogin(sessionId: unknown): boolean {
  const s = own(sessionId);
  if (!s) return false;
  finish(s, "cancelled");
  return true;
}

/** Test helper. */
export function _resetLogins(): void {
  for (const s of sessions.values()) finish(s, "cancelled");
  sessions.clear();
}
