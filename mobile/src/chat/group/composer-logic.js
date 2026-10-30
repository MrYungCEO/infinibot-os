/**
 * Group chat composer parity — pure logic for the native group composer, the
 * model sheet and the "Models & thinking" sheet. Mirrors (parity-tested in
 * __tests__/group-composer-logic.test.js):
 *
 *   src/shared/group-chat/settings.ts   (group / per-member model + thinking)
 *   src/shared/group-chat/commands.ts   (group slash commands)
 *   ui/src/ui/features/group_chat/logic.ts  (attachments, summaries)
 *   ui/src/ui/thinking-levels.ts + model-filter.ts (picker rows)
 */

// ── settings (src/shared/group-chat/settings.ts) ──────────────────────────

export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];

export const THINKING_LABELS = {
  off: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
};

/** Thinking options the 1:1 picker offers (zai is on/off). '' = inherit. */
export function thinkingOptions(provider) {
  return String(provider || '').toLowerCase() === 'zai' ? ['', 'off', 'on'] : ['', 'off', 'minimal', 'low', 'medium', 'high'];
}

/** Picker value → settings patch value (binary providers: on → low). */
export function thinkingPatchValue(value) {
  if (!value) return null;
  return value === 'on' ? 'low' : value;
}

/** Member override > group > agent default, field by field. */
export function effectiveSettings(meta, agentId) {
  const group = meta?.settings || {};
  const mine = meta?.memberSettings?.[agentId] || {};
  const pick = (k) => (mine[k] ? [mine[k], 'member'] : group[k] ? [group[k], 'group'] : [undefined, 'agent']);
  const [model, ms] = pick('model');
  const [thinkingLevel, ts] = pick('thinkingLevel');
  return {
    ...(model ? { model } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
    source: { model: ms, thinkingLevel: ts },
  };
}

/** Short label for a model ref ("openrouter/deepseek/v4" → "v4"). */
export function shortModel(ref) {
  if (!ref) return '';
  const parts = String(ref).split('/');
  return parts[parts.length - 1] || String(ref);
}

/** One-line summary of what the group runs with. */
export function settingsSummary(group) {
  const s = group?.settings || {};
  const parts = [
    s.model ? shortModel(s.model) : '',
    s.thinkingLevel ? `${THINKING_LABELS[s.thinkingLevel] || s.thinkingLevel} thinking` : '',
  ].filter(Boolean);
  const overrides = Object.keys(group?.memberSettings || {}).length;
  const head = parts.length ? parts.join(' · ') : 'Agent defaults';
  return overrides ? `${head} · ${overrides} override${overrides === 1 ? '' : 's'}` : head;
}

export const SOURCE_LABELS = { member: 'Override', group: 'Group', agent: 'Agent default' };

/**
 * The gateway serves composer parity — groupchat.get returns `settings` only
 * from a gateway that has it (older ones silently ignore the params).
 */
export function supportsComposerParity(group) {
  return Boolean(group && group.settings !== undefined);
}

// ── slash commands (src/shared/group-chat/commands.ts) ───────────────────

export const GROUP_COMMANDS = [
  { name: 'model', usage: '/model [@agent] <provider/model | default>', description: 'Model for every member, or one member with @agent', aliases: ['models'] },
  { name: 'think', usage: '/think [@agent] <level | default>', description: 'Thinking level (off, minimal, low, medium, high, xhigh) for every member, or one member', aliases: ['thinking', 'effort', 't'] },
  { name: 'mode', usage: '/mode <everyone|round-robin|moderator>', description: 'Who replies to your messages', aliases: ['reply'] },
  { name: 'stop', usage: '/stop', description: 'Stop every agent that is replying', aliases: ['abort'] },
  { name: 'help', usage: '/help', description: 'List the group commands', aliases: ['commands'] },
];

export function suggestGroupCommands(prefix) {
  const p = String(prefix || '').replace(/^\//, '').toLowerCase();
  return GROUP_COMMANDS.filter((c) => c.name.startsWith(p) || (c.aliases || []).some((a) => a.startsWith(p)));
}

/** Commands to suggest while the draft is a bare `/word` (no argument yet). */
export function slashSuggestions(draft) {
  const m = /^\/([a-z-]*)$/i.exec(String(draft || ''));
  return m ? suggestGroupCommands(m[1]) : [];
}

// ── attachments (same wire shape as chat.send) ───────────────────────────

/** Picked images ({ base64, mimeType }) → groupchat.send `attachments`. */
export function toAttachments(images) {
  return (Array.isArray(images) ? images : [])
    .filter((i) => i && typeof i.base64 === 'string' && i.base64)
    .map((i) => ({ type: 'image', mimeType: i.mimeType || 'image/jpeg', content: i.base64 }));
}

// ── model rows (ui/src/ui/model-filter.ts normalizeModelsList, simplified) ─

/** models.list → picker rows: usable models, "Your models" (allowlist) first, then by provider. */
export function modelRows(res, query = '') {
  const rows = (Array.isArray(res?.models) ? res.models : [])
    .filter((m) => m && typeof m.id === 'string')
    .map((m) => ({
      id: m.provider ? `${m.provider}/${m.id}` : m.id,
      name: (typeof m.name === 'string' && m.name) || m.id,
      provider: m.provider || '',
      reasoning: m.reasoning === true,
      vision: m.vision === true,
      contextWindow: m.contextWindow,
      allowed: m.allowed,
      pinned: m.pinned,
      free: m.free,
      usable: m.unconfigured !== true && m.available !== false && m.unavailable !== true,
    }))
    .filter((m) => m.usable);
  const q = String(query || '').trim().toLowerCase();
  const hit = (m) => !q || m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q);
  const mine = rows.filter((m) => (m.pinned === true || m.allowed === true) && hit(m));
  const rest = rows.filter((m) => !(m.pinned === true || m.allowed === true) && hit(m));
  const byProvider = new Map();
  for (const m of rest) {
    if (!byProvider.has(m.provider)) byProvider.set(m.provider, []);
    byProvider.get(m.provider).push(m);
  }
  const groups = [...byProvider.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([provider, models]) => ({ provider, models }));
  return { mine, groups, total: mine.length + rest.length };
}

/** The gateway rejects models outside the allowlist — add first (as the web picker does). */
export function needsAllowlistAdd(row) {
  return row?.allowed === false;
}
