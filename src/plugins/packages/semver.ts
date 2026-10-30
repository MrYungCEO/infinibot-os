/**
 * Strict semver for plugin packages (version ordering, `minHostVersion`).
 *
 * Plugin versions must be full `MAJOR.MINOR.PATCH` with an optional
 * `-prerelease` and `+build` (semver.org §2, §9–§11). InfiniBot's own calver
 * (`2026.6.30`) is valid semver, so the same compare gates `minHostVersion`.
 * Range matching for `engines["infinibot-plugin-api"]` stays in
 * manifest-v2.ts (`satisfiesRange`).
 */

const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

export type ParsedSemver = {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
  build?: string;
};

export function parseSemverStrict(value: string): ParsedSemver | null {
  const m = SEMVER_RE.exec(value.trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? m[4].split(".") : [],
    ...(m[5] ? { build: m[5] } : {}),
  };
}

export function isValidSemver(value: unknown): value is string {
  return typeof value === "string" && parseSemverStrict(value) !== null;
}

function comparePrerelease(a: string[], b: string[]): number {
  // No prerelease ranks above any prerelease of the same core version.
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (xn !== yn) {
      return xn ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/**
 * -1 / 0 / 1. Build metadata is ignored. Throws on an invalid version: callers
 * validate first (a version that can't be ordered must never look "newer").
 */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemverStrict(a);
  const pb = parseSemverStrict(b);
  if (!pa) throw new Error(`invalid semver "${a}"`);
  if (!pb) throw new Error(`invalid semver "${b}"`);
  for (const key of ["major", "minor", "patch"] as const) {
    if (pa[key] !== pb[key]) return pa[key] < pb[key] ? -1 : 1;
  }
  return comparePrerelease(pa.prerelease, pb.prerelease);
}

/** True when both are valid and `candidate` is strictly newer than `current`. */
export function isNewerVersion(
  candidate: string | undefined,
  current: string | undefined,
): boolean {
  if (!isValidSemver(candidate)) return false;
  if (!isValidSemver(current)) return true;
  return compareSemver(candidate, current) > 0;
}

/**
 * Does this host satisfy a plugin's `minHostVersion`? An absent minimum is
 * satisfied; an unparsable one is not (fail closed).
 */
export function hostSatisfiesMin(hostVersion: string, minHostVersion: string | undefined): boolean {
  if (!minHostVersion) return true;
  if (!isValidSemver(minHostVersion)) return false;
  // Dev builds may carry a non-semver host version; compare its numeric core.
  const host = parseSemverStrict(hostVersion) ? hostVersion : coerceSemver(hostVersion);
  if (!host) return false;
  // A prerelease host (2026.7.0-beta.1) still satisfies a 2026.7.0 minimum's
  // predecessors only; plain compare is the right rule.
  return compareSemver(host, minHostVersion) >= 0;
}

/** Best-effort `1.2` / `v1.2.3-x` → strict semver, or null. */
export function coerceSemver(value: string): string | null {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(value.trim());
  if (!m) return null;
  return `${Number(m[1])}.${Number(m[2] ?? 0)}.${Number(m[3] ?? 0)}`;
}
