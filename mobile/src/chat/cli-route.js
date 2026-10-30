/**
 * Chat composer Agent | CLI routing for the mobile chat — same rules as the
 * web chat (ui/src/ui/chat/chat-route.ts): a thread talks to the gateway agent
 * (default) or to a coding CLI (Claude Code / Codex / OpenCode / Gemini CLI / Grok Build)
 * in a folder, through the gateway's chat.cli.* RPCs. The choice is saved per
 * thread (AsyncStorage + chat.cli.mode on the gateway).
 */

export const CLI_BACKENDS = ['claude-code', 'codex', 'opencode', 'gemini', 'grok'];

export const CLI_LABELS = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  gemini: 'Gemini CLI',
  grok: 'Grok Build',
};

export const AGENT_ROUTE = { mode: 'agent' };

export function normalizeBackend(raw) {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().toLowerCase().replace(/-cli$/, '');
  if (v === 'claude' || v === 'claude-code' || v === 'claudecode' || v === 'cc') return 'claude-code';
  if (v === 'codex') return 'codex';
  if (v === 'opencode' || v === 'oc') return 'opencode';
  if (v === 'gemini') return 'gemini';
  if (v === 'grok' || v === 'grok-build' || v === 'grokbuild') return 'grok';
  return null;
}

export function parseRoute(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.mode === 'agent') return AGENT_ROUTE;
  if (raw.mode !== 'cli') return null;
  const backend = normalizeBackend(raw.backend);
  if (!backend) return null;
  const out = { mode: 'cli', backend };
  if (typeof raw.cwd === 'string' && raw.cwd.trim()) out.cwd = raw.cwd.trim();
  if (typeof raw.model === 'string' && raw.model.trim()) out.model = raw.model.trim();
  return out;
}

export const routeStorageKey = (threadKey) => `infinibot.chat.route.${threadKey || '__draft'}`;

/** `/cli codex [folder]`, `/cli`, `/codex`, `/agent [id]` → command; anything else → null. */
export function parseRouteCommand(text) {
  const m = String(text || '').trim().match(/^\/(cli|agent|codex|opencode|gemini|claude-code)(?:\s+([\s\S]*))?$/i);
  if (!m) return null;
  const cmd = m[1].toLowerCase();
  const rest = (m[2] || '').trim();
  if (cmd === 'agent') return rest ? { kind: 'agent', agentId: rest.split(/\s+/)[0] } : { kind: 'agent' };
  if (cmd !== 'cli') return { kind: 'cli', backend: normalizeBackend(cmd), ...(rest ? { cwd: rest } : {}) };
  if (!rest) return { kind: 'cli', backend: null };
  const [first, ...more] = rest.split(/\s+/);
  const backend = normalizeBackend(first);
  if (!backend) {
    if (/^[~/.]/.test(first)) return { kind: 'cli', backend: null, cwd: rest };
    return { kind: 'cli-unknown', name: first };
  }
  const cwd = more.join(' ').trim();
  return { kind: 'cli', backend, ...(cwd ? { cwd } : {}) };
}

/** cliRouting.status row → { id, label, status: ready|login|unavailable, version }. */
export function backendInfo(row) {
  const id = normalizeBackend(row?.id);
  if (!id) return null;
  const status = !row.installed ? 'unavailable' : row.auth === 'signed-out' ? 'login' : 'ready';
  return { id, label: CLI_LABELS[id], status, version: String(row.version || '').match(/\d+\.\d+(?:\.\d+)?/)?.[0] };
}

export function folderName(p) {
  if (!p) return 'Home';
  const parts = String(p).replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/** The CLI that wrote a gateway message (its `cli` meta), or null for the agent. */
export function messageCli(m) {
  return normalizeBackend(m?.cli?.backend);
}
