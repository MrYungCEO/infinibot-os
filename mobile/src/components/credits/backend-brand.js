/**
 * Coder-backend brand kit (mobile mirror of ui/src/ui/lib/coder-backend-brand.ts).
 *
 * Single source of truth for the accent colour + friendly label of every
 * agent_backend the credits ledger groups by. Colours stay hex (not theme
 * tokens) so coder runs read as "provider-branded" — exactly like the desktop
 * /credits timeseries and the <credit-usage-breakdown> widget — instead of
 * dissolving into the gold palette.
 *
 * Keep the four canonical accents in lock-step with the desktop table:
 *   claude-code #d97706 · opencode #10b981 · codex #0ea5e9 · gemini #a855f7
 */

const BRAND = {
  'claude-code': { label: 'Claude Code', accent: '#d97706' },
  claude:        { label: 'Claude Code', accent: '#d97706' },
  opencode:      { label: 'OpenCode',    accent: '#10b981' },
  codex:         { label: 'Codex',       accent: '#0ea5e9' },
  gemini:        { label: 'Gemini',      accent: '#a855f7' },
  native:        { label: 'Native',      accent: '#fbbf24' },
  'infinibot':   { label: 'Native',      accent: '#fbbf24' },
  voice:         { label: 'Voice',       accent: '#ec4899' },
  'direct-api':  { label: 'Direct API',  accent: '#60a5fa' },
  mcp:           { label: 'MCP',         accent: '#22d3ee' },
  gateway:       { label: 'Gateway',     accent: '#94a3b8' },
  'ollama-local':{ label: 'Ollama (Local)',  accent: '#64748b' },
  'ollama-cloud':{ label: 'Ollama (Cloud)',  accent: '#38bdf8' },
};

const FALLBACK = { label: 'Unknown', accent: '#71717a' };

// Deterministic fallback hue for any backend not in the table — stable across
// renders so the same backend always paints the same colour.
function hashColor(key) {
  let h = 0;
  for (let i = 0; i < String(key).length; i++) h = (h * 31 + String(key).charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 60% 60%)`;
}

export function backendAccent(backend) {
  const b = BRAND[backend];
  if (b) return b.accent;
  if (!backend || backend === 'unknown' || backend === '') return FALLBACK.accent;
  return hashColor(backend);
}

export function backendLabel(backend) {
  const b = BRAND[backend];
  if (b) return b.label;
  if (!backend || backend === 'unknown' || backend === '') return FALLBACK.label;
  // Title-case any future backend slug.
  return String(backend).replace(/(^|[-_])(\w)/g, (_, sep, c) => (sep ? ' ' : '') + c.toUpperCase());
}

// Friendly label for the *provider* axis used by plan cards (anthropic→Claude…)
const PROVIDER_LABEL = {
  anthropic: 'Claude',
  openai: 'Codex',
  opencode: 'OpenCode',
  google: 'Gemini',
};

const PROVIDER_ACCENT = {
  anthropic: '#d97706',
  openai: '#0ea5e9',
  opencode: '#10b981',
  google: '#a855f7',
};

export function providerLabel(provider) {
  return PROVIDER_LABEL[provider] ?? (provider ? provider[0].toUpperCase() + provider.slice(1) : '—');
}

export function providerAccent(provider) {
  return PROVIDER_ACCENT[provider] ?? '#fbbf24';
}

// Stable display order for plan cards: Claude, Codex, OpenCode, Gemini, rest.
export const PROVIDER_ORDER = ['anthropic', 'openai', 'opencode', 'google'];
