// KinglyVault Connect: the "brains" this InfiniBot can run right now.
//
// KinglyVault never supplies or pays for inference. Every KV AI feature runs
// on the member's own InfiniBot with ITS models: API providers with a key,
// subscription CLIs (Claude Code, Codex, Gemini, Grok, OpenCode) that are
// signed in, and local models (Ollama, vLLM, LM Studio). This module builds
// the catalogue the relay advertises to KV (names + availability only, never
// a key, path or account id) and validates a model KV asks for, falling back
// to this InfiniBot's own default.
//
// Pure helpers are unit-tested in brains.test.mjs; collectBrains() reads the
// live gateway through the relay's operator connection.

import { createHash } from 'node:crypto';

export const BRAINS_VERSION = 1;
/** Keeps the advertised catalogue small: it rides on every device.pull. */
export const MAX_MODELS_PER_PROVIDER = 40;
export const MAX_MODELS_TOTAL = 300;

const LOCAL_PROVIDERS = new Set(['ollama', 'vllm', 'lmstudio', 'lm-studio', 'llamacpp']);
/** Model choices KV may offer for a subscription CLI (besides "default"). */
const CLI_MODEL_CHOICES = {
  'claude-cli': [
    { id: 'sonnet', name: 'Claude Sonnet' },
    { id: 'opus', name: 'Claude Opus' },
    { id: 'haiku', name: 'Claude Haiku' },
  ],
};
/** Coder backend (coder.spawn / cli sessions) → its subscription-CLI provider. */
export const CODER_BACKEND_PROVIDER = {
  'claude-code': 'claude-cli',
  codex: 'codex-cli',
  gemini: 'gemini-cli',
  grok: 'grok-cli',
  opencode: 'opencode-cli',
};
const PROVIDER_LABELS = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  'google-gemini-cli': 'Google (Gemini CLI auth)',
  openrouter: 'OpenRouter',
  xai: 'xAI',
  groq: 'Groq',
  mistral: 'Mistral',
  deepseek: 'DeepSeek',
  ollama: 'Ollama (local)',
  'ollama-cloud': 'Ollama Cloud',
  vllm: 'vLLM (local)',
  lmstudio: 'LM Studio (local)',
};

const SAFE_PROVIDER = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
// Model ids can carry ":" (ollama tags), "/" (openrouter vendor paths) and "@".
const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,159}$/;

/** "desktop" for a member's own computer, "cloud" for an InfiniBot Cloud instance. */
export function instanceKind(env = process.env) {
  const on = (v) => /^(1|true|yes|on)$/i.test(String(v ?? '').trim());
  // Same test as relay-client isCloudMachine() (pairing method "cloud"), plus the SaaS switches.
  if (String(env.FLY_APP_NAME ?? '').trim() || String(env.FLEET_TENANT_ID ?? '').trim() || on(env.SAAS_MODE) || on(env.CLOUD_MODE)) return 'cloud';
  return 'desktop';
}

export function refOf(provider, model) {
  return `${provider}/${model}`;
}

function providerKind(id) {
  if (id.endsWith('-cli')) return 'cli';
  if (LOCAL_PROVIDERS.has(id)) return 'local';
  return 'api';
}

function cliStatus(b) {
  if (!b.installed) return 'not-installed';
  if (b.ready) return 'ready';
  if (b.auth === 'signed-out') return 'signed-out';
  return 'not-ready';
}

/**
 * Pure: turns gateway answers into the advertised catalogue.
 *  models:   models.list → { models, providers }
 *  cli:      cliRouting.status (optional; old gateways lack it)
 *  defaults: sessions.list → defaults { modelProvider, model }
 */
export function buildBrainCatalog({ models = null, cli = null, defaults = null, kind = 'desktop', now = Date.now() } = {}) {
  const groups = new Map();
  const group = (id) => {
    let g = groups.get(id);
    if (!g) {
      g = { id, label: PROVIDER_LABELS[id] || id, kind: providerKind(id), available: false, models: [], total: 0 };
      groups.set(id, g);
    }
    return g;
  };

  const providerAvail = new Map((models?.providers || []).map((p) => [p?.id, p?.available]));
  let total = 0;
  for (const m of models?.models || []) {
    if (!m || typeof m.provider !== 'string' || typeof m.id !== 'string') continue;
    if (!SAFE_PROVIDER.test(m.provider)) continue;
    // Subscription CLIs come from cliRouting.status (it knows sign-in state).
    if (providerKind(m.provider) === 'cli' && cli) continue;
    const g = group(m.provider);
    if (m.unconfigured) continue; // "not connected" placeholder row
    const usable = m.available !== false && m.allowed !== false && m.unavailable !== true;
    if (!usable || !SAFE_MODEL.test(m.id)) continue;
    g.total += 1; // usable models, including ones trimmed from the advertised list
    g.available = true;
    if (g.models.length >= MAX_MODELS_PER_PROVIDER || total >= MAX_MODELS_TOTAL) continue;
    total += 1;
    g.models.push({ id: m.id, name: String(m.name || m.id).slice(0, 80), ref: refOf(m.provider, m.id), ...(m.free ? { free: true } : {}) });
  }
  for (const [id, available] of providerAvail) {
    if (typeof id !== 'string' || !SAFE_PROVIDER.test(id)) continue;
    if (providerKind(id) === 'cli' && cli) continue;
    const g = group(id);
    if (available === false && !g.models.length) g.available = false;
  }
  for (const g of groups.values()) {
    if (!g.models.length) g.available = false;
    if (g.kind !== 'cli') g.status = g.available ? 'ready' : g.kind === 'local' ? 'not-running' : 'no-key';
  }

  const cliUsable = cli ? cli.available !== false : false;
  for (const b of cli?.backends || []) {
    if (!b || typeof b.id !== 'string' || !SAFE_PROVIDER.test(b.id)) continue;
    const g = group(b.id);
    g.label = String(b.label || b.id).slice(0, 40);
    g.kind = 'cli';
    g.status = cliUsable ? cliStatus(b) : 'unavailable-here';
    g.available = cliUsable && b.ready === true;
    const choices = [{ id: 'default', name: `${g.label} (its default model)` }, ...(CLI_MODEL_CHOICES[b.id] || [])];
    g.models = choices.map((c) => ({ id: c.id, name: c.name, ref: refOf(b.id, c.id) }));
    g.total = g.models.length;
  }

  const order = { cli: 0, api: 1, local: 2 };
  const providers = [...groups.values()].sort(
    (a, b) => Number(b.available) - Number(a.available) || order[a.kind] - order[b.kind] || a.label.localeCompare(b.label),
  );
  const dp = typeof defaults?.modelProvider === 'string' ? defaults.modelProvider : null;
  const dm = typeof defaults?.model === 'string' ? defaults.model : null;
  return {
    v: BRAINS_VERSION,
    kind,
    default: dp && dm ? { provider: dp, model: dm, ref: refOf(dp, dm) } : null,
    providers,
    updatedAt: new Date(now).toISOString(),
  };
}

/** Stable fingerprint (ignores updatedAt) so callers can tell when brains changed. */
export function brainsDigest(catalog) {
  if (!catalog) return '';
  const { updatedAt: _u, ...rest } = catalog;
  return createHash('sha256').update(JSON.stringify(rest)).digest('hex').slice(0, 16);
}

/** Reads the live gateway. Every source is optional: an older gateway just advertises less. */
export async function collectBrains(gw, { kind = instanceKind() } = {}) {
  const [models, cli, sessions] = await Promise.all([
    gw.request('models.list', {}, { timeoutMs: 20_000 }).catch(() => null),
    gw.request('cliRouting.status', {}, { timeoutMs: 20_000 }).catch(() => null),
    gw.request('sessions.list', { limit: 1 }, { timeoutMs: 10_000 }).catch(() => null),
  ]);
  if (!models && !cli) return null;
  return buildBrainCatalog({ models, cli, defaults: sessions?.defaults ?? null, kind });
}

/**
 * Validates the model KV asked for against the catalogue.
 * Returns { kind: 'none' } when KV sent nothing (old clients: leave the
 * session as it is), { kind: 'default' } for "use my default", { kind: 'ok',
 * ref, provider, model } for a usable brain, or { kind: 'unavailable', reason, label }.
 */
export function resolveBrainChoice(catalog, params = {}) {
  const rawModel = typeof params.model === 'string' ? params.model.trim() : '';
  let provider = typeof params.provider === 'string' ? params.provider.trim() : '';
  let model = rawModel;
  if (!provider && !model) return { kind: 'none' };
  if (!provider && (model === 'default' || model === 'auto')) return { kind: 'default' };
  // "provider/model" in model alone.
  if (!provider && model.includes('/')) {
    const i = model.indexOf('/');
    provider = model.slice(0, i);
    model = model.slice(i + 1);
  }
  const label = provider ? `${provider}/${model || 'default'}` : model;
  if ((provider && !SAFE_PROVIDER.test(provider)) || (model && !SAFE_MODEL.test(model))) {
    return { kind: 'unavailable', label, reason: 'That model name is not valid.' };
  }
  if (!catalog) {
    // No catalogue yet (gateway still starting): trust a well-formed ref, the gateway validates it again.
    if (!provider) return { kind: 'unavailable', label, reason: 'Pick a provider for that model.' };
    return { kind: 'ok', provider, model: model || 'default', ref: refOf(provider, model || 'default') };
  }
  const groups = catalog.providers || [];
  const g = provider ? groups.find((x) => x.id === provider) : groups.find((x) => x.models.some((m) => m.id === model));
  if (!g) return { kind: 'unavailable', label, reason: provider ? `${provider} is not set up on this InfiniBot.` : `${model} is not available on this InfiniBot.` };
  if (!g.available) {
    const why = {
      'not-installed': `${g.label} is not installed on this InfiniBot.`,
      'signed-out': `${g.label} is not signed in on this InfiniBot.`,
      'unavailable-here': `${g.label} can't run on this InfiniBot.`,
      'not-running': `${g.label} is not running.`,
      'no-key': `${g.label} has no API key on this InfiniBot.`,
    };
    return { kind: 'unavailable', label, reason: why[g.status] || `${g.label} is not ready on this InfiniBot.` };
  }
  const id = model || (g.kind === 'cli' ? 'default' : '');
  const m = g.models.find((x) => x.id === id);
  if (!m) {
    // Big catalogues are trimmed when advertised; a well-formed id of a
    // usable API provider is still worth trying (the gateway re-validates).
    if (id && g.kind !== 'cli' && (g.total || 0) > g.models.length) return { kind: 'ok', provider: g.id, model: id, ref: refOf(g.id, id) };
    return { kind: 'unavailable', label, reason: `${id || 'That model'} is not available from ${g.label} on this InfiniBot.` };
  }
  return { kind: 'ok', provider: g.id, model: m.id, ref: m.ref };
}

/** Human label of a ref for notices ("Claude Code · sonnet"). */
export function brainLabel(catalog, ref) {
  if (!ref) return 'your default model';
  const i = ref.indexOf('/');
  const provider = ref.slice(0, i);
  const model = ref.slice(i + 1);
  const g = catalog?.providers?.find((x) => x.id === provider);
  const m = g?.models.find((x) => x.id === model);
  return `${g?.label || provider} · ${m?.name || model}`;
}
