import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  loadProfiles, saveAndActivateProfile, activateProfile, getActiveProfile, removeProfile,
  activeAuthHeaders, activeConnectAuth, setCloudTokenGetter, ensureCloudGatewayUrl,
  __resetProfileCacheForTests,
} from '../connection/profile-store';
import { getGatewayAuthHeaders, getGatewayUrl, getAuthToken } from '../utils/storage';
import { makeSelfHostedProfile, makeCloudProfile } from '../connection/connection-logic';

beforeEach(() => {
  AsyncStorage._reset();
  __resetProfileCacheForTests();
});

test('legacy single-gateway install migrates to one self-hosted profile', async () => {
  await AsyncStorage.setItem('@moltbot/gateway_url', 'ws://192.168.1.120:18789');
  await AsyncStorage.setItem('@moltbot/auth_token', 'pw');
  const c = await loadProfiles();
  expect(c.profiles).toHaveLength(1);
  expect(c.profiles[0]).toMatchObject({ kind: 'self-hosted', gatewayUrl: 'ws://192.168.1.120:18789', secret: 'pw', authMode: 'password' });
  expect(await activeAuthHeaders()).toEqual({ Authorization: 'Bearer pw' });
});

test('fresh install has no active profile (→ connection chooser)', async () => {
  expect(await getActiveProfile()).toBeNull();
  expect(await getGatewayAuthHeaders()).toEqual({});
});

test('activating mirrors URL+secret into the legacy keys the rest of the app reads', async () => {
  const a = await saveAndActivateProfile(makeSelfHostedProfile({ gatewayUrl: 'box.ts.net', secret: 'tok', authMode: 'token' }));
  await AsyncStorage.setItem('@moltbot/device_token', 'stale');
  expect(await getGatewayUrl()).toBe('ws://box.ts.net:18789');
  expect(await getAuthToken()).toBe('tok');
  expect(await getGatewayAuthHeaders()).toEqual({ Authorization: 'Bearer tok' });
  expect(await activeConnectAuth()).toEqual({ token: 'tok' });

  const b = await saveAndActivateProfile(makeSelfHostedProfile({ gatewayUrl: '10.0.0.9', secret: 'pw2', authMode: 'password' }));
  expect(await getGatewayUrl()).toBe('ws://10.0.0.9:18789');
  expect(await AsyncStorage.getItem('@moltbot/device_token')).toBeNull(); // bound to the old gateway
  await activateProfile(a.id);
  expect(await getAuthToken()).toBe('tok');
  await removeProfile(a.id);
  expect(await getActiveProfile()).toBeNull();
  expect(await getGatewayUrl()).toBe('');
  expect((await loadProfiles()).profiles.map((p) => p.id)).toEqual([b.id]);
});

test('cloud: headers + connect auth use a fresh Clerk token each call; secret never stored', async () => {
  await saveAndActivateProfile(makeCloudProfile({ orchestratorUrl: 'https://orch.test' }));
  let n = 0;
  setCloudTokenGetter(async () => `jwt-${++n}`);
  expect(await getGatewayAuthHeaders()).toEqual({ Authorization: 'Bearer jwt-1' });
  expect(await getGatewayAuthHeaders()).toEqual({ Authorization: 'Bearer jwt-2' });
  expect(await activeConnectAuth({ deviceToken: 'x' })).toEqual({ token: 'jwt-3' });
  expect(await getAuthToken()).toBeNull();
});

test('cloud: ensureCloudGatewayUrl resolves via mocked /fleet/resolve and caches', async () => {
  await saveAndActivateProfile(makeCloudProfile({ orchestratorUrl: 'https://orch.test' }));
  setCloudTokenGetter(async () => 'jwt');
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push([url, init.headers.Authorization]);
    return { status: 200, json: async () => ({ status: 'ready', gatewayWsUrl: 'wss://tenant-1.fly.dev/ws', tenantId: 'tenant-1' }), headers: { get: () => null } };
  };
  const out = await ensureCloudGatewayUrl({ fetchImpl });
  expect(out).toMatchObject({ state: 'ready', gatewayUrl: 'wss://tenant-1.fly.dev/ws' });
  expect(calls).toEqual([['https://orch.test/fleet/resolve', 'Bearer jwt']]);
  expect(await getGatewayUrl()).toBe('wss://tenant-1.fly.dev/ws');
  expect((await getActiveProfile()).tenantId).toBe('tenant-1');
  await ensureCloudGatewayUrl({ fetchImpl }); // cached
  expect(calls).toHaveLength(1);
  await ensureCloudGatewayUrl({ fetchImpl, force: true });
  expect(calls).toHaveLength(2);
});

test('editing a profile keeps its id and replaces the secret; deleting removes it', async () => {
  const a = await saveAndActivateProfile(makeSelfHostedProfile({ gatewayUrl: 'box.ts.net', secret: 'stale', authMode: 'password', label: 'Home' }));
  const b = await saveAndActivateProfile(makeSelfHostedProfile({ gatewayUrl: '10.0.0.9', secret: 'pw2', authMode: 'password' }));
  // Edit (the chooser rebuilds the profile from the form, then keeps the id).
  const edited = { ...makeSelfHostedProfile({ gatewayUrl: 'box.ts.net', secret: 'fresh', authMode: 'token', label: 'Home PC' }), id: a.id };
  await saveAndActivateProfile(edited);
  let c = await loadProfiles();
  expect(c.profiles.map((p) => p.id)).toEqual([a.id, b.id]);
  expect(c.profiles[0]).toMatchObject({ secret: 'fresh', authMode: 'token', label: 'Home PC' });
  expect(await getAuthToken()).toBe('fresh');
  expect(await activeConnectAuth()).toEqual({ token: 'fresh' });
  // Delete the active one: no active profile left, legacy keys cleared.
  await removeProfile(a.id);
  c = await loadProfiles();
  expect(c.profiles.map((p) => p.id)).toEqual([b.id]);
  expect(await getActiveProfile()).toBeNull();
  expect(await getAuthToken()).toBeNull();
});
