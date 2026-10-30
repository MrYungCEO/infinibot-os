/**
 * profile-store — persisted connection profiles + the active one.
 *
 * Storage: AsyncStorage '@infinibot/connection_profiles_v1' =
 *   { activeId, profiles: [ …profile ] }       (see connection-logic.js)
 *
 * Compatibility: the rest of the app (useGateway, WebSurface, voice, push …)
 * reads `getGatewayUrl()` / `getAuthToken()` / `getGatewayAuthHeaders()` from
 * utils/storage. Activating a profile therefore MIRRORS its URL + secret into
 * those legacy keys, and utils/storage asks this module for a live credential
 * provider first (cloud → fresh Clerk token per call). One source of truth, no
 * caller changes.
 *
 * Migration: an install that only has the legacy '@moltbot/gateway_url' (+
 * '@moltbot/auth_token') becomes a single self-hosted profile on first read.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  PROFILE_KINDS,
  makeSelfHostedProfile,
  buildAuthHeaders,
  buildConnectAuth,
  resolveCloudGateway,
} from './connection-logic';

const KEY = '@infinibot/connection_profiles_v1';
const LEGACY_URL = '@moltbot/gateway_url';
const LEGACY_TOKEN = '@moltbot/auth_token';
const LEGACY_DEVICE_TOKEN = '@moltbot/device_token';

let cache = null; // { activeId, profiles }
const listeners = new Set();

// Cloud sessions register a token getter here (Clerk `getToken`). Kept in
// memory only — a Clerk JWT is never persisted.
let cloudTokenGetter = null;

export function setCloudTokenGetter(fn) {
  cloudTokenGetter = typeof fn === 'function' ? fn : null;
}

export async function getCloudToken(opts) {
  if (!cloudTokenGetter) return null;
  try {
    return (await cloudTokenGetter(opts)) || null;
  } catch {
    return null;
  }
}

export function hasCloudSession() {
  return Boolean(cloudTokenGetter);
}

// Re-resolve the tenant gateway at most this often (a resolve also wakes a
// suspended machine, so a failing socket forces one sooner).
const CLOUD_RESOLVE_TTL_MS = 10 * 60 * 1000;
let resolving = null;

/**
 * Make sure the active cloud profile has a live gateway URL. Returns the
 * resolve outcome ({state:'ready'|'waking'|'serverless'|'error', …}).
 */
export async function ensureCloudGatewayUrl({ force = false, fetchImpl, onWaking } = {}) {
  const p = await getActiveProfile();
  if (!p || p.kind !== PROFILE_KINDS.CLOUD) return { state: 'ready', gatewayUrl: p?.gatewayUrl || '' };
  if (!force && p.gatewayUrl && Date.now() - (p.resolvedAt || 0) < CLOUD_RESOLVE_TTL_MS) {
    return { state: 'ready', gatewayUrl: p.gatewayUrl };
  }
  if (resolving) return resolving;
  resolving = (async () => {
    const out = await resolveCloudGateway({
      orchestratorUrl: p.orchestratorUrl,
      getToken: (opts) => getCloudToken(opts),
      ...(fetchImpl ? { fetchImpl } : {}),
      onWaking,
    });
    if (out.state === 'ready') {
      await updateActiveProfile({ gatewayUrl: out.gatewayUrl, tenantId: out.tenantId ?? p.tenantId, resolvedAt: Date.now() });
    }
    return out;
  })();
  try {
    return await resolving;
  } finally {
    resolving = null;
  }
}

function emit() {
  for (const l of listeners) {
    try { l(cache); } catch {}
  }
}

export function subscribeProfiles(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

async function persist() {
  await AsyncStorage.setItem(KEY, JSON.stringify(cache));
  emit();
}

export async function loadProfiles() {
  if (cache) return cache;
  let parsed = null;
  try {
    const raw = await AsyncStorage.getItem(KEY);
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }
  if (parsed && Array.isArray(parsed.profiles)) {
    cache = { activeId: parsed.activeId || null, profiles: parsed.profiles };
    return cache;
  }
  // First run on this version: migrate a legacy single-gateway install.
  cache = { activeId: null, profiles: [] };
  try {
    const url = await AsyncStorage.getItem(LEGACY_URL);
    if (url) {
      const secret = (await AsyncStorage.getItem(LEGACY_TOKEN)) || '';
      const p = makeSelfHostedProfile({ gatewayUrl: url, secret, authMode: 'password' });
      cache = { activeId: p.id, profiles: [p] };
      await AsyncStorage.setItem(KEY, JSON.stringify(cache));
    }
  } catch {
    /* no legacy install */
  }
  return cache;
}

export async function getActiveProfile() {
  const c = await loadProfiles();
  return c.profiles.find((p) => p.id === c.activeId) || null;
}

/** Synchronous peek for render paths; null until loadProfiles() resolved once. */
export function peekActiveProfile() {
  if (!cache) return null;
  return cache.profiles.find((p) => p.id === cache.activeId) || null;
}

export async function listProfiles() {
  return (await loadProfiles()).profiles.slice();
}

async function mirrorLegacy(profile) {
  // Legacy keys drive the existing WS client / WebSurface / voice code.
  if (profile?.gatewayUrl) await AsyncStorage.setItem(LEGACY_URL, profile.gatewayUrl);
  else await AsyncStorage.removeItem(LEGACY_URL);
  if (profile?.kind === PROFILE_KINDS.SELF_HOSTED && profile.secret) {
    await AsyncStorage.setItem(LEGACY_TOKEN, profile.secret);
  } else {
    await AsyncStorage.removeItem(LEGACY_TOKEN);
  }
  // A device token is bound to the gateway that issued it.
  await AsyncStorage.removeItem(LEGACY_DEVICE_TOKEN);
}

/** Insert or replace a profile and make it active. */
export async function saveAndActivateProfile(profile) {
  const c = await loadProfiles();
  const i = c.profiles.findIndex((p) => p.id === profile.id);
  if (i >= 0) c.profiles[i] = profile;
  else c.profiles.push(profile);
  c.activeId = profile.id;
  await mirrorLegacy(profile);
  await persist();
  return profile;
}

export async function activateProfile(id) {
  const c = await loadProfiles();
  const p = c.profiles.find((x) => x.id === id);
  if (!p) throw new Error('Unknown connection profile');
  c.activeId = id;
  await mirrorLegacy(p);
  await persist();
  return p;
}

export async function updateActiveProfile(patch) {
  const c = await loadProfiles();
  const i = c.profiles.findIndex((p) => p.id === c.activeId);
  if (i < 0) return null;
  c.profiles[i] = { ...c.profiles[i], ...patch };
  await mirrorLegacy(c.profiles[i]);
  await persist();
  return c.profiles[i];
}

export async function removeProfile(id) {
  const c = await loadProfiles();
  c.profiles = c.profiles.filter((p) => p.id !== id);
  if (c.activeId === id) {
    c.activeId = null;
    await mirrorLegacy(null);
  }
  await persist();
}

/** Signs out of the active connection without deleting other profiles. */
export async function clearActiveProfile() {
  const c = await loadProfiles();
  c.activeId = null;
  await mirrorLegacy(null);
  await persist();
}

/** Authorization headers for the ACTIVE profile (fresh Clerk token for cloud). */
export async function activeAuthHeaders() {
  const p = await getActiveProfile();
  if (!p) return null; // caller falls back to the legacy secret
  if (p.kind === PROFILE_KINDS.CLOUD) return buildAuthHeaders(p, { clerkToken: await getCloudToken() });
  return buildAuthHeaders(p);
}

/** WS connect auth block for the ACTIVE profile. */
export async function activeConnectAuth({ deviceToken = null } = {}) {
  const p = await getActiveProfile();
  if (!p) return null;
  if (p.kind === PROFILE_KINDS.CLOUD) return buildConnectAuth(p, { clerkToken: await getCloudToken() });
  return buildConnectAuth(p, { deviceToken });
}

/** Test hook. */
export function __resetProfileCacheForTests() {
  cache = null;
  cloudTokenGetter = null;
  resolving = null;
  listeners.clear();
}
