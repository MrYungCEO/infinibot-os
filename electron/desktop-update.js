/**
 * Desktop update helpers shared by main.js and its tests.
 *
 * The desktop app updates from the PUBLIC releases repo (electron-updater's
 * latest.yml / latest-linux.yml), never from the npm registry: npm `latest`
 * can be older than the desktop build, which made the sidebar say "Up to
 * date" on stale installs.
 */
'use strict';

const RELEASES_OWNER = 'MrYungCEO';
const RELEASES_REPO = 'infinibot-desktop-releases';
const RELEASES_URL = `https://github.com/${RELEASES_OWNER}/${RELEASES_REPO}/releases`;

/** Which installer this copy came from; decides whether it can self-update. */
function desktopPackageType({ platform = process.platform, isPackaged = true, env = process.env } = {}) {
  if (!isPackaged) return 'dev';
  if (platform === 'win32') return 'nsis';
  // AppImages run with $APPIMAGE set; a packaged Linux build without it is
  // the .deb, which electron-updater can't replace in place without root.
  if (platform === 'linux') return env.APPIMAGE ? 'appimage' : 'deb';
  return 'other';
}

function canSelfUpdate(packageType) {
  return packageType === 'nsis' || packageType === 'appimage';
}

/** Where a human downloads the newest installer for this package type. */
function desktopDownloadUrl(packageType) {
  switch (packageType) {
    case 'nsis':
      return 'https://infinibotos.com/download/windows';
    case 'appimage':
      return 'https://infinibotos.com/download/linux';
    case 'deb':
      return `${RELEASES_URL}/latest/download/infinibot_amd64.deb`;
    default:
      return `${RELEASES_URL}/latest`;
  }
}

/** electron-updater feed file for a platform. */
function feedFileFor(platform = process.platform) {
  return platform === 'linux' ? 'latest-linux.yml' : 'latest.yml';
}

function feedUrlFor(platform = process.platform) {
  return `${RELEASES_URL}/latest/download/${feedFileFor(platform)}`;
}

/** Pull `version:` out of a latest*.yml body (no YAML dependency needed). */
function parseFeedVersion(yml) {
  const m = /^version:\s*['"]?([^'"\s]+)['"]?\s*$/m.exec(String(yml ?? ''));
  return m ? m[1] : null;
}

/**
 * Semver-style compare for calendar versions (2026.10.18, 2026.10.18-beta.1,
 * v2026.10.9). Returns -1 / 0 / 1; unparseable input sorts as 0 so it never
 * claims an update.
 */
function compareVersions(a, b) {
  const parse = (v) => {
    const s = String(v ?? '').trim().replace(/^v/i, '');
    if (!s) return null;
    const [core, pre = ''] = s.split('+')[0].split(/-(.*)/s);
    const nums = core.split('.').map((p) => Number(p));
    if (nums.some((n) => !Number.isFinite(n))) return null;
    return { nums, pre };
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return 0;
  const len = Math.max(pa.nums.length, pb.nums.length);
  for (let i = 0; i < len; i++) {
    const d = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  // A release outranks its own prerelease.
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return 1;
  if (!pb.pre) return -1;
  return pa.pre.localeCompare(pb.pre, undefined, { numeric: true }) > 0 ? 1 : -1;
}

/** Fetch the latest published desktop version from the feed. Throws on failure. */
async function fetchLatestDesktopVersion({ platform = process.platform, fetchImpl = globalThis.fetch } = {}) {
  const res = await fetchImpl(feedUrlFor(platform), { redirect: 'follow' });
  if (!res.ok) throw new Error(`feed HTTP ${res.status}`);
  const version = parseFeedVersion(await res.text());
  if (!version) throw new Error('feed has no version');
  return version;
}

module.exports = {
  RELEASES_OWNER,
  RELEASES_REPO,
  RELEASES_URL,
  desktopPackageType,
  canSelfUpdate,
  desktopDownloadUrl,
  feedFileFor,
  feedUrlFor,
  parseFeedVersion,
  compareVersions,
  fetchLatestDesktopVersion,
};
