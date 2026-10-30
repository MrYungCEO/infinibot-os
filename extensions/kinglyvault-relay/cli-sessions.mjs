// Persistent CLI sessions: ONE session concept shared by every InfiniBot
// surface (KinglyVault Agent HQ over the relay today; the InfiniBot chat UI's
// CLI mode can adopt the same store + RPCs; see docs/cli-sessions.md).
//
// A session is a long-lived conversation with one CLI coder (Claude Code,
// Codex, OpenCode, Gemini) in one folder, or with one gateway agent. Every
// message CONTINUES that same conversation:
//
//   claude-code  first turn `claude -p --session-id <uuid>`, then `--resume <uuid>`
//   codex        first turn `codex exec --json`, then `codex exec resume <thread_id>`
//   opencode     first turn `opencode run --format json`, then `--session <ses_…>`
//   gemini       first turn `gemini -p … --output-format stream-json`, then `--resume <id>`
//   agent        the gateway session agent:<id>:kv-<conn>-<session id> (chat.send)
//   helper       a one-off coder/sub-agent run (stuck-tutor helpers); follow-ups go
//                through subagent_message while it runs. Listed, never auto-created.
//
// Nothing here creates a session implicitly: `create` is the only way in, so a
// message can never fan out into a new coder run.
//
// Storage (plain files, survives restarts of the relay link and the gateway):
//   <stateDir>/cli-sessions/sessions.json      index (metadata only)
//   <stateDir>/cli-sessions/<id>.jsonl         history (user / assistant / event lines)

import { spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CLI_BACKENDS = {
  'claude-code': { name: 'Claude Code', bin: 'claude' },
  codex: { name: 'Codex', bin: 'codex' },
  opencode: { name: 'OpenCode', bin: 'opencode' },
  gemini: { name: 'Gemini CLI', bin: 'gemini' },
};
export const SESSION_KINDS = ['cli', 'agent', 'helper'];
export const TURN_TIMEOUT_MS = 25 * 60_000;
const HISTORY_TEXT_MAX = 20_000;
const TITLE_MAX = 80;

const stateDir = () => process.env.INFINIBOT_STATE_DIR || path.join(os.homedir(), '.infinibot');
export const cliSessionsDir = () => path.join(stateDir(), 'cli-sessions');

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === 'EPERM';
  }
}

const cleanTitle = (t, fallback) => String(t ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, TITLE_MAX) || fallback;
const isSessionId = (id) => typeof id === 'string' && /^cs_[a-z0-9]{6,40}$/i.test(id);

// ── store ─────────────────────────────────────────────────────────────

export class CliSessionStore {
  constructor({ dir = cliSessionsDir(), now = () => Date.now() } = {}) {
    this.dir = dir;
    this.now = now;
  }

  get indexPath() {
    return path.join(this.dir, 'sessions.json');
  }

  historyPath(id) {
    if (!isSessionId(id)) throw new Error('Bad session id.');
    return path.join(this.dir, `${id}.jsonl`);
  }

  readAll() {
    let sessions = [];
    try {
      const raw = JSON.parse(fs.readFileSync(this.indexPath, 'utf8'));
      sessions = Array.isArray(raw?.sessions) ? raw.sessions : [];
    } catch {
      /* first run */
    }
    // A turn whose process is gone (link restarted mid-turn) is not running any more.
    for (const s of sessions) {
      if (s.status === 'running' && !(s.pid && pidAlive(s.pid) && s.ownerPid && pidAlive(s.ownerPid))) {
        s.status = 'idle';
        s.pid = null;
        s.lastError = s.lastError || 'The last turn was interrupted (InfiniBot restarted).';
      }
    }
    return sessions;
  }

  writeAll(sessions) {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.indexPath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, sessions }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.indexPath);
  }

  get(id) {
    return this.readAll().find((s) => s.id === id) || null;
  }

  findByRunId(runId) {
    return this.readAll().find((s) => s.kind === 'helper' && s.runId === runId) || null;
  }

  create(fields) {
    const at = new Date(this.now()).toISOString();
    const s = {
      id: `cs_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
      kind: 'cli',
      backend: null,
      agentId: null,
      title: 'New session',
      folder: null,
      nativeId: null,
      nativeStarted: false,
      runId: null,
      origin: 'infinibot',
      status: 'idle',
      archived: false,
      turns: 0,
      lastPreview: null,
      lastError: null,
      pid: null,
      ownerPid: null,
      createdAt: at,
      lastActivityAt: at,
      ...fields,
    };
    const all = this.readAll();
    all.push(s);
    this.writeAll(all);
    return s;
  }

  update(id, patch) {
    const all = this.readAll();
    const i = all.findIndex((s) => s.id === id);
    if (i < 0) return null;
    all[i] = { ...all[i], ...(typeof patch === 'function' ? patch(all[i]) : patch) };
    this.writeAll(all);
    return all[i];
  }

  append(id, entry) {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const line = { at: new Date(this.now()).toISOString(), ...entry };
    if (typeof line.text === 'string' && line.text.length > HISTORY_TEXT_MAX) line.text = `${line.text.slice(0, HISTORY_TEXT_MAX)}…`;
    fs.appendFileSync(this.historyPath(id), `${JSON.stringify(line)}\n`, { mode: 0o600 });
  }

  history(id, limit = 200) {
    let lines = [];
    try {
      lines = fs.readFileSync(this.historyPath(id), 'utf8').split('\n').filter(Boolean);
    } catch {
      return [];
    }
    const out = [];
    for (const l of lines.slice(-Math.max(1, Math.min(limit, 1000)))) {
      try {
        out.push(JSON.parse(l));
      } catch {
        /* torn line */
      }
    }
    return out;
  }
}

// ── backend argv + output parsing ─────────────────────────────────────

/**
 * argv for one turn. `bypass` mirrors InfiniBot's coder auto-approve policy
 * (tools.coder.autoApprove): the same permission flag the coder tools emit.
 * The message goes on stdin (Claude Code, Codex) or after `--` (OpenCode), so
 * text starting with "-" is never read as a flag.
 */
export function buildTurnArgs(backend, { nativeId, nativeStarted, bypass, message }) {
  switch (backend) {
    case 'claude-code':
      return {
        args: [
          '-p',
          '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
          ...(nativeStarted ? ['--resume', nativeId] : ['--session-id', nativeId]),
          ...(bypass ? ['--dangerously-skip-permissions'] : ['--permission-mode', 'acceptEdits']),
        ],
        stdin: message,
      };
    case 'codex':
      return {
        // `-` = read the prompt from stdin (works for `exec` and `exec resume`).
        args: [
          'exec', '--json', '--skip-git-repo-check',
          ...(bypass ? ['--dangerously-bypass-approvals-and-sandbox'] : ['-c', 'sandbox_mode=workspace-write']),
          ...(nativeStarted && nativeId ? ['resume', nativeId] : []),
          '-',
        ],
        stdin: message,
      };
    case 'opencode':
      return {
        args: ['run', '--format', 'json', ...(bypass ? ['--dangerously-skip-permissions'] : []), ...(nativeStarted && nativeId ? ['--session', nativeId] : []), '--', message],
      };
    case 'gemini':
      return {
        // `--prompt=<text>` keeps a message that starts with "-" from being read as a flag.
        args: ['--output-format', 'stream-json', '--approval-mode', bypass ? 'yolo' : 'auto_edit', ...(nativeStarted && nativeId ? ['--resume', nativeId] : []), `--prompt=${message}`],
      };
    default:
      throw new Error(`Unknown CLI backend ${backend}.`);
  }
}

/**
 * Folds one JSON line of a CLI's stream into the turn state:
 * { nativeId, text (reply so far), final (authoritative final reply), events[], error }.
 */
export function parseTurnLine(backend, line, t) {
  let e;
  try {
    e = JSON.parse(line);
  } catch {
    return t;
  }
  if (!e || typeof e !== 'object') return t;
  const addText = (s) => {
    if (typeof s === 'string' && s) t.text = t.text ? `${t.text}${s}` : s;
  };
  switch (backend) {
    case 'claude-code': {
      if (e.session_id) t.nativeId = e.session_id;
      if (e.type === 'stream_event' && e.event?.type === 'content_block_delta' && e.event.delta?.type === 'text_delta') {
        addText(e.event.delta.text);
        t.streamed = true;
      } else if (e.type === 'stream_event' && e.event?.type === 'message_start' && t.text) {
        t.text += '\n\n';
      } else if (e.type === 'assistant' && Array.isArray(e.message?.content)) {
        for (const c of e.message.content) {
          if (c?.type === 'text' && !t.streamed) addText((t.text ? '\n\n' : '') + c.text);
          if (c?.type === 'tool_use') t.events.push(toolLabel(c.name, c.input));
        }
      } else if (e.type === 'result') {
        if (typeof e.result === 'string') t.final = e.result;
        if (e.is_error || (e.subtype && e.subtype !== 'success')) t.error = typeof e.result === 'string' && e.result ? e.result : `Claude Code ended: ${e.subtype || 'error'}`;
      }
      return t;
    }
    case 'codex': {
      if (e.type === 'thread.started' && e.thread_id) t.nativeId = e.thread_id;
      const item = e.item;
      if (e.type === 'item.completed' && item?.type === 'agent_message') addText((t.text ? '\n\n' : '') + (item.text || ''));
      if (e.type === 'item.started' && item?.type === 'command_execution') t.events.push(`Run: ${String(item.command || '').slice(0, 140)}`);
      if (e.type === 'item.completed' && item?.type === 'file_change') t.events.push(`Edit: ${(item.changes || []).map((c) => c.path).join(', ').slice(0, 140)}`);
      if (e.type === 'turn.failed' || e.type === 'error') t.error = e.error?.message || e.message || 'Codex failed.';
      return t;
    }
    case 'opencode': {
      if (e.sessionID) t.nativeId = e.sessionID;
      if (e.type === 'text' && e.part?.text) addText((t.text ? '\n\n' : '') + e.part.text);
      if (e.type === 'tool_use' && e.part?.tool) t.events.push(toolLabel(e.part.tool, e.part.state?.input));
      if (e.type === 'error') t.error = e.error?.data?.message || e.error?.message || 'OpenCode failed.';
      return t;
    }
    case 'gemini': {
      if (e.session_id) t.nativeId = e.session_id;
      if (e.type === 'message' && e.role === 'assistant' && typeof e.content === 'string') addText(e.content);
      if (e.type === 'tool_use') t.events.push(toolLabel(e.tool_name, e.parameters));
      if (e.type === 'error') t.error = e.message || 'Gemini failed.';
      if (e.type === 'result' && e.status === 'error') t.error = e.error?.message || 'Gemini failed.';
      return t;
    }
    default:
      return t;
  }
}

function toolLabel(name, input) {
  const i = input && typeof input === 'object' ? input : {};
  const arg = i.file_path || i.path || i.command || i.pattern || i.url || i.description || '';
  return `${name}${arg ? `: ${String(arg).slice(0, 140)}` : ''}`;
}

// ── binaries / policy ─────────────────────────────────────────────────

function extraBinDirs() {
  const home = os.homedir();
  return [path.dirname(process.execPath), path.join(home, '.local', 'bin'), path.join(home, '.bun', 'bin'), path.join(home, '.npm-global', 'bin'), '/usr/local/bin', '/opt/homebrew/bin'];
}

/** PATH for CLI children: the service PATH is minimal under systemd. */
export function childPath(base = process.env.PATH || '') {
  const parts = base.split(path.delimiter).filter(Boolean);
  for (const d of extraBinDirs()) if (!parts.includes(d)) parts.push(d);
  return parts.join(path.delimiter);
}

export function findBinary(bin, envPath = childPath()) {
  for (const d of envPath.split(path.delimiter)) {
    const p = path.join(d, bin);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      /* next */
    }
  }
  return null;
}

/** Same switch as the coder tools: tools.coder.autoApprove "never" (or SaaS mode) turns the bypass flags off. */
export function coderBypassAllowed() {
  if (/^(1|true|yes)$/i.test(process.env.SAAS_MODE || '')) return false;
  try {
    const cfg = JSON.parse(fs.readFileSync(process.env.INFINIBOT_CONFIG_PATH || path.join(stateDir(), 'infinibot.json'), 'utf8'));
    return cfg?.tools?.coder?.autoApprove !== 'never';
  } catch {
    return true;
  }
}

// ── manager ───────────────────────────────────────────────────────────

/**
 * Runs session operations. Hosts inject:
 *   resolveFolder(requested) → { ok, dir } | { ok:false, reason }   (allow-dir rule)
 *   isFolderAllowed(dir) → boolean                                     (listing filter)
 *   agentTurn(session, message, { onText }) → { text }                 (gateway agents)
 *   helperMessage(session, message) → { delivered, … }                 (one-off helper runs)
 *   spawn (tests) — child_process.spawn compatible
 */
export class CliSessionManager {
  constructor({ store = new CliSessionStore(), resolveFolder, isFolderAllowed = () => true, agentTurn, helperMessage, spawn = nodeSpawn, bypass = coderBypassAllowed, findBin = findBinary, turnTimeoutMs = TURN_TIMEOUT_MS } = {}) {
    this.store = store;
    this.resolveFolder = resolveFolder;
    this.isFolderAllowed = isFolderAllowed;
    this.agentTurn = agentTurn;
    this.helperMessage = helperMessage;
    this.spawn = spawn;
    this.bypass = bypass;
    this.findBin = findBin;
    this.turnTimeoutMs = turnTimeoutMs;
    this.children = new Map(); // session id → child process
  }

  backends() {
    return Object.entries(CLI_BACKENDS).map(([id, b]) => ({ id, name: b.name, installed: !!this.findBin(b.bin), resumable: true }));
  }

  visible(s) {
    if (s.kind === 'agent') return true;
    return !!s.folder && this.isFolderAllowed(s.folder);
  }

  publicView(s) {
    return {
      id: s.id,
      kind: s.kind,
      backend: s.backend,
      agentId: s.agentId,
      title: s.title,
      folder: s.folder,
      status: this.children.has(s.id) ? 'running' : s.status,
      archived: !!s.archived,
      turns: s.turns,
      origin: s.origin,
      runId: s.runId,
      lastPreview: s.lastPreview,
      lastError: s.lastError,
      createdAt: s.createdAt,
      lastActivityAt: s.lastActivityAt,
    };
  }

  list({ includeArchived = false, backend } = {}) {
    const sessions = this.store
      .readAll()
      .filter((s) => this.visible(s) && (includeArchived || !s.archived) && (!backend || s.backend === backend))
      .sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt))
      .map((s) => this.publicView(s));
    return { sessions, backends: this.backends() };
  }

  mustGet(id) {
    const s = isSessionId(id) ? this.store.get(id) : null;
    if (!s || !this.visible(s)) throw new Error('No such session on this InfiniBot.');
    return s;
  }

  history(id, limit = 200) {
    const s = this.mustGet(id);
    return { session: this.publicView(s), history: this.store.history(id, limit) };
  }

  create({ backend, folder, title, agentId, origin = 'infinibot' }) {
    if (backend === 'agent') {
      if (!agentId || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(agentId)) throw new Error('Pick a gateway agent.');
      const s = this.store.create({ kind: 'agent', backend: 'agent', agentId, title: cleanTitle(title, `Chat with ${agentId}`), origin });
      return this.publicView(s);
    }
    const spec = CLI_BACKENDS[backend];
    if (!spec) throw new Error('Unknown CLI backend.');
    if (!this.findBin(spec.bin)) throw new Error(`${spec.name} is not installed on this InfiniBot.`);
    const wd = this.resolveFolder ? this.resolveFolder(folder) : { ok: true, dir: folder };
    if (!wd.ok) throw new Error(wd.reason);
    const s = this.store.create({
      kind: 'cli',
      backend,
      folder: wd.dir,
      title: cleanTitle(title, `${spec.name} · ${path.basename(wd.dir)}`),
      // Claude Code takes OUR id up front (--session-id); the others hand theirs back on turn 1.
      nativeId: backend === 'claude-code' ? randomUUID() : null,
      origin,
    });
    return this.publicView(s);
  }

  /** Records a one-off helper run (agents.spawn / coder.spawn) so it shows in the list. */
  recordHelper({ runId, backend, folder, title, origin = 'kinglyvault' }) {
    if (!runId) return null;
    const existing = this.store.findByRunId(runId);
    if (existing) return this.publicView(existing);
    const s = this.store.create({ kind: 'helper', backend: backend || 'agent', folder: folder || null, runId, title: cleanTitle(title, 'One-off helper'), status: 'running', origin });
    return this.publicView(s);
  }

  helperFinished(runId, { status, summary }) {
    const s = this.store.findByRunId(runId);
    if (!s) return;
    this.store.update(s.id, { status: status === 'running' ? 'running' : 'done', lastPreview: summary ? String(summary).slice(0, 200) : s.lastPreview, lastActivityAt: new Date(this.store.now()).toISOString() });
  }

  rename(id, title) {
    this.mustGet(id);
    return this.publicView(this.store.update(id, { title: cleanTitle(title, 'Session') }));
  }

  archive(id, archived = true) {
    this.mustGet(id);
    if (archived) this.stop(id);
    return this.publicView(this.store.update(id, { archived: !!archived }));
  }

  stop(id) {
    const s = this.mustGet(id);
    const child = this.children.get(id);
    if (!child) {
      // The turn may be running in the other host process (relay link vs gateway plugin).
      if (s.status === 'running' && s.pid && pidAlive(s.pid) && s.ownerPid && pidAlive(s.ownerPid)) {
        try {
          process.kill(-s.pid, 'SIGTERM');
          return { stopped: true };
        } catch {
          /* fall through */
        }
      }
      return { stopped: false };
    }
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      try {
        child.kill('SIGTERM');
      } catch {
        /* gone */
      }
    }
    return { stopped: true };
  }

  /**
   * Sends one message into the SAME session and resolves with the reply.
   * onText(fullTextSoFar) streams the reply; onEvent(label) reports tool use.
   */
  async send(id, message, { onText = () => {}, onEvent = () => {} } = {}) {
    const s = this.mustGet(id);
    if (s.archived) throw new Error('This session is archived. Unarchive it to continue.');
    if (this.children.has(id) || (s.kind !== 'helper' && s.status === 'running')) throw new Error('This session is still answering. Wait for it, or stop it first.');
    const text = String(message ?? '').trim();
    if (!text) throw new Error('Empty message.');
    const at = () => new Date(this.store.now()).toISOString();
    this.store.append(id, { role: 'user', text });

    if (s.kind === 'helper') {
      if (!this.helperMessage) throw new Error('Helpers cannot take follow-ups here.');
      const out = await this.helperMessage(s, text);
      const note = 'Delivered to the running helper. Its result shows up when it finishes.';
      this.store.append(id, { role: 'event', text: note });
      this.store.update(id, { lastActivityAt: at() });
      return { session: this.publicView(this.store.get(id)), text: note, delivered: out };
    }

    if (s.kind === 'agent') {
      if (!this.agentTurn) throw new Error('Gateway agents are not reachable from here.');
      this.store.update(id, { status: 'running', lastActivityAt: at(), lastError: null });
      try {
        const out = await this.agentTurn(s, text, { onText });
        return this.finishTurn(id, { text: out?.text || '' });
      } catch (e) {
        return this.failTurn(id, e);
      }
    }

    const spec = CLI_BACKENDS[s.backend];
    const bin = spec && this.findBin(spec.bin);
    if (!bin) throw new Error(`${spec?.name || s.backend} is not installed on this InfiniBot.`);
    // The folder rule is re-checked on every turn: revoking allow-dir stops old sessions too.
    const wd = this.resolveFolder ? this.resolveFolder(s.folder) : { ok: true, dir: s.folder };
    if (!wd.ok) throw new Error(wd.reason);

    const { args, stdin } = buildTurnArgs(s.backend, { nativeId: s.nativeId, nativeStarted: s.nativeStarted, bypass: this.bypass(), message: text });
    const env = { ...process.env, PATH: childPath() };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    const child = this.spawn(bin, args, { cwd: wd.dir, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.children.set(id, child);
    this.store.update(id, { status: 'running', pid: child.pid ?? null, ownerPid: process.pid, lastActivityAt: at(), lastError: null });

    const t = { nativeId: s.nativeId, text: '', final: null, events: [], error: null, streamed: false };
    let seenEvents = 0;
    let buf = '';
    let stderr = '';
    let lastEmit = 0;
    const flushEvents = () => {
      while (seenEvents < t.events.length) {
        const ev = t.events[seenEvents++];
        this.store.append(id, { role: 'event', text: ev });
        onEvent(ev);
      }
    };
    const result = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        t.error = `The turn ran longer than ${Math.round(this.turnTimeoutMs / 60_000)} minutes and was stopped.`;
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          child.kill?.('SIGTERM');
        }
      }, this.turnTimeoutMs);
      timer.unref?.();
      child.stdout.setEncoding?.('utf8');
      child.stdout.on('data', (chunk) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) parseTurnLine(s.backend, line, t);
        }
        flushEvents();
        if (t.text && Date.now() - lastEmit > 300) {
          lastEmit = Date.now();
          onText(t.text);
        }
      });
      child.stderr.on('data', (c) => {
        stderr = `${stderr}${c}`.slice(-4000);
      });
      child.on('error', (e) => {
        t.error = e.message;
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        if (buf.trim()) parseTurnLine(s.backend, buf.trim(), t);
        flushEvents();
        if (!t.error && code !== 0 && !(t.final || t.text)) t.error = signal ? 'Stopped.' : stderr.trim().split('\n').slice(-3).join(' ').slice(0, 400) || `${spec.name} exited with code ${code}.`;
        resolve(t);
      });
      if (stdin !== undefined) child.stdin.end(stdin);
      else child.stdin.end();
    });
    this.children.delete(id);
    const reply = result.final || result.text;
    const patch = { pid: null };
    // Only a turn that really reached the CLI makes its conversation resumable.
    if (result.nativeId && (reply || !result.error)) {
      patch.nativeId = result.nativeId;
      patch.nativeStarted = true;
    }
    this.store.update(id, patch);
    if (result.error && !reply) return this.failTurn(id, new Error(result.error));
    return this.finishTurn(id, { text: reply || '(no reply)', warning: result.error });
  }

  finishTurn(id, { text, warning }) {
    this.store.append(id, { role: 'assistant', text });
    const s = this.store.update(id, (cur) => ({
      status: 'idle',
      turns: (cur.turns || 0) + 1,
      lastPreview: text.replace(/\s+/g, ' ').slice(0, 200),
      lastError: warning || null,
      lastActivityAt: new Date(this.store.now()).toISOString(),
    }));
    return { session: this.publicView(s), text };
  }

  failTurn(id, e) {
    const msg = e instanceof Error ? e.message : String(e);
    this.store.append(id, { role: 'error', text: msg });
    this.store.update(id, { status: 'error', lastError: msg.slice(0, 400), pid: null, lastActivityAt: new Date(this.store.now()).toISOString() });
    throw new Error(msg);
  }
}
