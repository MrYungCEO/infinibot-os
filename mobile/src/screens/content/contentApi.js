// contentApi — thin wrappers over the live gateway content RPCs.
//
// All methods here map 1:1 to handlers that already ship in the gateway
// (src/gateway/server-methods/content-pages.ts + scripts.ts + send.ts), so
// nothing here needs a gateway restart. Each helper takes the `gateway`
// object the screens already receive as a prop and calls gateway.sendReq.
//
// Image/video generation is routed through the content agent via chat.send.
// When the FlyPic plugin is enabled, its first-party agent tools are included
// in that agent's normal tool set — see ContentGenerationScreen.

import AsyncStorage from '@react-native-async-storage/async-storage';

const DRAFT_PREFIX = 'infinibot.content.draft.';

function req(gateway, method, params) {
  if (!gateway?.sendReq) return Promise.reject(new Error('Gateway not ready'));
  return gateway.sendReq(method, params || {});
}

// ── Content pages ─────────────────────────────────────────────
export const listPages = (gateway, filter = {}) =>
  req(gateway, 'content.pages.list', filter).then((r) => r?.pages || []);

export const getPage = (gateway, id) =>
  req(gateway, 'content.pages.get', { id }).then((r) => r?.page || null);

export const createPage = (gateway, input) =>
  req(gateway, 'content.pages.create', input).then((r) => r?.page || null);

export const updatePage = (gateway, id, patch) =>
  req(gateway, 'content.pages.update', { id, ...patch }).then((r) => r?.page || null);

export const deletePage = (gateway, id, cascadeChildren = true) =>
  req(gateway, 'content.pages.delete', { id, cascadeChildren });

export const getStats = (gateway, id, forceRefresh = false) =>
  req(gateway, 'content.pages.stats', { id, forceRefresh });

export const subscribeStats = (gateway, id) =>
  req(gateway, 'content.pages.stats.subscribe', { id });

export const getInsights = (gateway, id) =>
  req(gateway, 'content.pages.insights', { id }).then((r) => r?.insights || []);

// ── Child databases (scripts | videos | content | ideas) ──────
export const listChildren = (gateway, pageId, kind) =>
  req(gateway, 'content.pages.children.list', { pageId, kind });

export const createChild = (gateway, pageId, kind, title, values = {}) =>
  req(gateway, 'content.pages.children.create', { pageId, kind, title, values }).then(
    (r) => r?.row || null,
  );

export const updateChild = (gateway, pageId, kind, rowId, patch) =>
  req(gateway, 'content.pages.children.update', { pageId, kind, rowId, ...patch }).then(
    (r) => r?.row || null,
  );

export const deleteChild = (gateway, rowId) =>
  req(gateway, 'content.pages.children.delete', { rowId });

// ── Scripts ───────────────────────────────────────────────────
// Default to the AGENTIC pipeline (research → exemplars → draft → lint →
// revise) with research + viral-exemplar injection ON. The editor screen does
// not pass these flags explicitly, so we opt them in here unless the caller
// overrides — the whole point of the upgrade is that mobile gets the better
// pipeline by default. The gateway falls back to one-shot when no Anthropic
// provider is configured, so this is always safe. The response gains a
// `trace[]` (tool calls + drafts) the editor can surface as a "thinking" view.
export const generateScript = (gateway, params) =>
  req(gateway, 'scripts.generate', {
    agentic: true,
    research: true,
    useExemplars: true,
    researchDepth: 'standard',
    ...params,
  });

// ── Viral examples library ────────────────────────────────────
export const listViralExamples = (gateway, filter = {}) =>
  req(gateway, 'viralExamples.list', filter).then((r) => r?.examples || []);

export const getViralExample = (gateway, id) =>
  req(gateway, 'viralExamples.get', { id }).then((r) => r?.example || null);

export const upsertViralExample = (gateway, input) =>
  req(gateway, 'viralExamples.upsert', input).then((r) => r?.example || null);

export const deleteViralExample = (gateway, id) =>
  req(gateway, 'viralExamples.delete', { id });

export const retrieveViralExamples = (gateway, { topic, platform, limit } = {}) =>
  req(gateway, 'viralExamples.retrieve', { topic, platform, limit }).then(
    (r) => r?.examples || [],
  );

export const refineScript = (gateway, scriptText, instructions) =>
  req(gateway, 'scripts.refine', { scriptText, instructions });

export const listScripts = (gateway, pageId) =>
  req(gateway, 'scripts.list', { pageId }).then((r) => r?.rows || []);

export const getScript = (gateway, rowId) =>
  req(gateway, 'scripts.get', { rowId }).then((r) => r?.row || null);

// ── Businesses (needed to scope page creation) ────────────────
export const listBusinesses = (gateway) =>
  req(gateway, 'business.list', {}).then((r) => r?.businesses || []);

// ── Publish to a channel ──────────────────────────────────────
export const sendToChannel = (gateway, { to, message, channel, accountId, mediaUrls }) =>
  req(gateway, 'send', {
    to,
    message,
    channel,
    accountId,
    mediaUrls,
    idempotencyKey: `content-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  });

// ── Offline draft persistence (AsyncStorage) ──────────────────
export async function saveDraft(key, draft) {
  try {
    await AsyncStorage.setItem(DRAFT_PREFIX + key, JSON.stringify({ ...draft, savedAt: Date.now() }));
    return true;
  } catch {
    return false;
  }
}

export async function loadDraft(key) {
  try {
    const raw = await AsyncStorage.getItem(DRAFT_PREFIX + key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export async function clearDraft(key) {
  try {
    await AsyncStorage.removeItem(DRAFT_PREFIX + key);
  } catch {
    // ignore
  }
}

export async function listDrafts() {
  try {
    const keys = await AsyncStorage.getAllKeys();
    const draftKeys = keys.filter((k) => k.startsWith(DRAFT_PREFIX));
    const pairs = await AsyncStorage.multiGet(draftKeys);
    return pairs
      .map(([k, v]) => {
        try {
          return { key: k.slice(DRAFT_PREFIX.length), ...JSON.parse(v) };
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

export const CHILD_KINDS = ['scripts', 'videos', 'content', 'ideas'];

export const SURFACES = [
  'instagram',
  'youtube',
  'tiktok',
  'blog',
  'linkedin',
  'twitter',
  'facebook',
  'newsletter',
  'podcast',
  'other',
];

export const SURFACE_ICON = {
  instagram: 'logo-instagram',
  youtube: 'logo-youtube',
  tiktok: 'musical-notes',
  blog: 'document-text',
  linkedin: 'logo-linkedin',
  twitter: 'logo-twitter',
  facebook: 'logo-facebook',
  newsletter: 'mail',
  podcast: 'mic',
  other: 'globe-outline',
};
