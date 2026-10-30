/**
 * "Import from URL / GitHub": turn a GitHub link someone pastes into the
 * package download it stands for.
 *
 *   github.com/<o>/<r>                    latest release's .ibplugin.zip (or
 *                                         .zip) asset, else the default
 *                                         branch as a zip
 *   github.com/<o>/<r>/tree/<ref>         that branch / tag as a zip
 *   github.com/<o>/<r>/releases/tag/<t>   that release's plugin asset, else
 *                                         the tag as a zip
 *   github.com/<o>/<r>/releases/download/…, codeload links, other https URLs
 *                                         used as they are
 *
 * A source archive wraps the repo in one top-level folder, which the package
 * reader already accepts (the manifest may sit inside exactly one folder).
 * A sub-folder of a repo (`/tree/<ref>/<path>`) is refused in plain words:
 * the plugin must be the repo root or a release asset.
 */

export type GithubResolution =
  | { kind: "not-github" }
  | { kind: "resolved"; url: string; via: "release-asset" | "source-archive" | "direct" }
  | { kind: "refused"; reason: string };

type Fetch = typeof fetch;

const NAME = /^[A-Za-z0-9_.-]{1,100}$/;

function parseGithub(raw: string): { owner: string; repo: string; rest: string[] } | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || (u.hostname !== "github.com" && u.hostname !== "www.github.com")) {
    return null;
  }
  const parts = u.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (parts.length < 2) return null;
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/, "");
  if (!NAME.test(owner) || !NAME.test(repo)) return null;
  return { owner, repo, rest: parts.slice(2) };
}

function pickAsset(assets: unknown): string | null {
  if (!Array.isArray(assets)) return null;
  const urls = assets
    .map((a) => a as { name?: unknown; browser_download_url?: unknown })
    .filter((a) => typeof a.name === "string" && typeof a.browser_download_url === "string")
    .map((a) => ({
      name: (a.name as string).toLowerCase(),
      url: a.browser_download_url as string,
    }));
  return (
    urls.find((a) => a.name.endsWith(".ibplugin.zip"))?.url ??
    urls.find((a) => a.name.endsWith(".zip"))?.url ??
    null
  );
}

async function releaseAsset(
  fetchImpl: Fetch,
  owner: string,
  repo: string,
  tag: string | null,
): Promise<string | null> {
  const path = tag ? `releases/tags/${encodeURIComponent(tag)}` : "releases/latest";
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${owner}/${repo}/${path}`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "infinibot-plugins" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { assets?: unknown };
    return pickAsset(body.assets);
  } catch {
    return null;
  }
}

const archive = (owner: string, repo: string, ref: string) =>
  `https://github.com/${owner}/${repo}/archive/${ref.split("/").map(encodeURIComponent).join("/")}.zip`;

export async function resolveGithubPackageUrl(
  raw: string,
  opts: { fetchImpl?: Fetch } = {},
): Promise<GithubResolution> {
  const gh = parseGithub(raw.trim());
  if (!gh) return { kind: "not-github" };
  const fetchImpl = opts.fetchImpl ?? fetch;
  const { owner, repo, rest } = gh;
  const [section, ...more] = rest;

  if (!section) {
    const asset = await releaseAsset(fetchImpl, owner, repo, null);
    if (asset) return { kind: "resolved", url: asset, via: "release-asset" };
    return { kind: "resolved", url: archive(owner, repo, "HEAD"), via: "source-archive" };
  }
  if (section === "archive" || (section === "releases" && more[0] === "download")) {
    return { kind: "resolved", url: raw.trim(), via: "direct" };
  }
  if (section === "releases") {
    const tag = more[0] === "tag" && more[1] ? more.slice(1).join("/") : null;
    if (more.length === 0 || more[0] === "latest") {
      const asset = await releaseAsset(fetchImpl, owner, repo, null);
      if (asset) return { kind: "resolved", url: asset, via: "release-asset" };
      return {
        kind: "refused",
        reason: `${owner}/${repo} has no release with a .zip plugin attached.`,
      };
    }
    if (tag) {
      const asset = await releaseAsset(fetchImpl, owner, repo, tag);
      if (asset) return { kind: "resolved", url: asset, via: "release-asset" };
      return { kind: "resolved", url: archive(owner, repo, tag), via: "source-archive" };
    }
  }
  if (section === "tree" && more.length >= 1) {
    if (more.length > 1) {
      return {
        kind: "refused",
        reason:
          "That link points inside a folder of the repository. Use a link to the repository itself (its root must be the plugin), or to a release's .zip.",
      };
    }
    return { kind: "resolved", url: archive(owner, repo, more[0]), via: "source-archive" };
  }
  return {
    kind: "refused",
    reason:
      "That GitHub link isn't a repository, branch or release. Paste the repository link, e.g. https://github.com/owner/my-plugin.",
  };
}
