import { describe, expect, it } from "vitest";
import { resolveGithubPackageUrl } from "./github-source.js";

function api(releases: Record<string, unknown>) {
  const seen: string[] = [];
  const fetchImpl = (async (url: string) => {
    seen.push(url);
    const key = Object.keys(releases).find((k) => url.endsWith(k));
    return key
      ? new Response(JSON.stringify(releases[key]), { status: 200 })
      : new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

describe("resolveGithubPackageUrl", () => {
  it("leaves non-GitHub URLs alone", async () => {
    expect(await resolveGithubPackageUrl("https://example.com/p.zip")).toEqual({
      kind: "not-github",
    });
    expect(await resolveGithubPackageUrl("http://github.com/a/b")).toEqual({ kind: "not-github" });
  });

  it("repo link → latest release's .ibplugin.zip, else the default branch", async () => {
    const withRelease = api({
      "releases/latest": {
        assets: [
          { name: "notes.txt", browser_download_url: "https://x/notes.txt" },
          { name: "src.zip", browser_download_url: "https://x/src.zip" },
          { name: "demo-1.0.0.ibplugin.zip", browser_download_url: "https://x/demo.ibplugin.zip" },
        ],
      },
    });
    expect(await resolveGithubPackageUrl("https://github.com/acme/demo", withRelease)).toEqual({
      kind: "resolved",
      url: "https://x/demo.ibplugin.zip",
      via: "release-asset",
    });
    expect(await resolveGithubPackageUrl("https://github.com/acme/demo.git", api({}))).toEqual({
      kind: "resolved",
      url: "https://github.com/acme/demo/archive/HEAD.zip",
      via: "source-archive",
    });
  });

  it("branch and tag links", async () => {
    expect(
      await resolveGithubPackageUrl("https://github.com/acme/demo/tree/dev", api({})),
    ).toMatchObject({
      url: "https://github.com/acme/demo/archive/dev.zip",
    });
    expect(
      await resolveGithubPackageUrl("https://github.com/acme/demo/releases/tag/v2", api({})),
    ).toMatchObject({ url: "https://github.com/acme/demo/archive/v2.zip", via: "source-archive" });
    const dl = "https://github.com/acme/demo/releases/download/v2/demo.ibplugin.zip";
    expect(await resolveGithubPackageUrl(dl, api({}))).toEqual({
      kind: "resolved",
      url: dl,
      via: "direct",
    });
  });

  it("refuses a sub-folder link in plain words", async () => {
    const r = await resolveGithubPackageUrl(
      "https://github.com/acme/mono/tree/main/plugins/demo",
      api({}),
    );
    expect(r.kind).toBe("refused");
    if (r.kind === "refused") expect(r.reason).toMatch(/inside a folder/);
  });
});
