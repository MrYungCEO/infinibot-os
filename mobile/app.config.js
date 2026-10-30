// Dynamic Expo config. app.json holds the neutral base (and is the marker the
// gateway uses to find this Expo project); this file overlays the identifiers
// that belong to whoever builds the app: EAS project, Expo owner, bundle ids.
//
// Values come from process.env first, then from an optional dotenv file:
//   INFINIBOT_MOBILE_ENV_FILE=/path/to/file  (explicit), else ./.env.owner
// Both .env.owner and google-services.json are gitignored. See README.md.
// Optional: INFINIBOT_CLERK_PUBLISHABLE_KEY + INFINIBOT_CLOUD_ORCHESTRATOR_URL
// (InfiniBot Cloud sign-in), INFINIBOT_APP_LINK_HOSTS (https alert links).
const fs = require('fs');
const path = require('path');

const DEFAULT_BUNDLE_ID = 'com.example.infinibot';

function readEnvFile(file) {
  const out = {};
  if (!file || !fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

const envFile =
  process.env.INFINIBOT_MOBILE_ENV_FILE || path.join(__dirname, '.env.owner');
const fileEnv = readEnvFile(envFile);
const env = (key) => {
  const v = process.env[key] ?? fileEnv[key];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
};

// The web export is served by the gateway under /mobile-web/ (and through
// Tailscale Serve as https://<host>/mobile-web/). Expo emits absolute asset
// URLs (/_expo/static/...), which would hit the control UI there instead, so a
// WEB export gets baseUrl=/mobile-web. Native / update exports are untouched.
// INFINIBOT_WEB_BASE_URL overrides ('' = serve from the domain root).
function webExportBaseUrl() {
  if (process.env.INFINIBOT_WEB_BASE_URL !== undefined) return process.env.INFINIBOT_WEB_BASE_URL || undefined;
  const argv = process.argv.join(' ');
  const exporting = /\bexport\b/.test(argv);
  const web = /(?:--platform|-p)[ =]web\b/.test(argv);
  return exporting && web ? '/mobile-web' : undefined;
}

module.exports = ({ config }) => {
  const iosBundleId = env('INFINIBOT_IOS_BUNDLE_ID') || DEFAULT_BUNDLE_ID;
  const androidPackage = env('INFINIBOT_ANDROID_PACKAGE') || iosBundleId;
  const easProjectId = env('INFINIBOT_EAS_PROJECT_ID');
  const owner = env('INFINIBOT_EXPO_OWNER');
  const slug = env('INFINIBOT_EXPO_SLUG');

  // FCM push needs a real google-services.json for *your* Firebase project.
  // Only wire it when one exists, so a clean clone still builds.
  const googleServicesFile =
    env('INFINIBOT_GOOGLE_SERVICES_FILE') ||
    (fs.existsSync(path.join(__dirname, 'google-services.json'))
      ? './google-services.json'
      : undefined);

  const extra = { ...(config.extra || {}) };
  if (easProjectId) extra.eas = { ...(extra.eas || {}), projectId: easProjectId };

  // InfiniBot Cloud (optional). Both values are public: a Clerk *publishable*
  // key and the fleet orchestrator origin. Without them the connection chooser
  // only offers "Self-hosted gateway".
  const clerkPublishableKey = env('INFINIBOT_CLERK_PUBLISHABLE_KEY');
  const orchestratorUrl = env('INFINIBOT_CLOUD_ORCHESTRATOR_URL');
  if (clerkPublishableKey || orchestratorUrl) {
    extra.cloud = { ...(extra.cloud || {}), clerkPublishableKey, orchestratorUrl };
  }

  // Universal / App Link hosts for https://<host>/m/<path> alert links
  // (docs/mobile/DEEP-LINKS.md). Comma-separated; defaults to app.json's.
  const linkHosts = (env('INFINIBOT_APP_LINK_HOSTS') || '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
  const intentFilters = linkHosts.length
    ? [
        ...(config.android?.intentFilters || []).filter(
          (f) => !(f.data || []).some((d) => d.scheme === 'https'),
        ),
        {
          action: 'VIEW',
          autoVerify: true,
          category: ['BROWSABLE', 'DEFAULT'],
          data: linkHosts.map((host) => ({ scheme: 'https', host, pathPrefix: '/m/' })),
        },
      ]
    : config.android?.intentFilters;
  const associatedDomains = linkHosts.length
    ? linkHosts.map((h) => `applinks:${h}`)
    : config.ios?.associatedDomains;

  const baseUrl = webExportBaseUrl();

  return {
    ...config,
    ...(baseUrl ? { experiments: { ...(config.experiments || {}), baseUrl } } : {}),
    ...(slug ? { slug } : {}),
    ...(owner ? { owner } : {}),
    ios: { ...config.ios, bundleIdentifier: iosBundleId, ...(associatedDomains ? { associatedDomains } : {}) },
    android: {
      ...config.android,
      package: androidPackage,
      ...(intentFilters ? { intentFilters } : {}),
      ...(googleServicesFile ? { googleServicesFile } : {}),
    },
    extra,
  };
};
