// Build-time InfiniBot Cloud settings (app.config.js → extra.cloud). Both
// values are public (a Clerk *publishable* key and the orchestrator origin);
// nothing secret is baked into the app.
import Constants from 'expo-constants';

export function getCloudConfig() {
  const c = Constants.expoConfig?.extra?.cloud || {};
  const clerkPublishableKey = typeof c.clerkPublishableKey === 'string' && /^pk_(test|live)_/.test(c.clerkPublishableKey)
    ? c.clerkPublishableKey
    : null;
  const orchestratorUrl = typeof c.orchestratorUrl === 'string' && /^https:\/\//.test(c.orchestratorUrl)
    ? c.orchestratorUrl.replace(/\/+$/, '')
    : null;
  return { clerkPublishableKey, orchestratorUrl, enabled: Boolean(clerkPublishableKey && orchestratorUrl) };
}
