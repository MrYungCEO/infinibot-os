import { describe, expect, it } from "vitest";
import {
  checkDesktopFeed,
  compareVersions,
  desktopChipModel,
  detectDesktopMode,
  fetchLatestDesktopVersion,
  parseFeedVersion,
  type DesktopUpdateState,
} from "./desktop-update";

const LATEST_YML = `version: 2026.10.18
files:
  - url: InfiniBot-Setup-x64.exe
    sha512: abc==
path: InfiniBot-Setup-x64.exe
releaseDate: '2026-10-16T17:58:54.478Z'
`;

function state(p: Partial<DesktopUpdateState>): DesktopUpdateState {
  return {
    status: "idle",
    currentVersion: "2026.10.9",
    version: null,
    percent: 0,
    error: null,
    canSelfUpdate: true,
    downloadUrl: "https://infinibotos.com/download/windows",
    ...p,
  };
}

describe("compareVersions", () => {
  it("compares calendar versions numerically, not lexically", () => {
    expect(compareVersions("2026.10.18", "2026.10.9")).toBe(1);
    expect(compareVersions("2026.10.9", "2026.10.18")).toBe(-1);
    expect(compareVersions("2026.10.7", "2026.10.9")).toBe(-1); // npm latest vs desktop
    expect(compareVersions("2026.10.18", "2026.10.18")).toBe(0);
    expect(compareVersions("2027.1.1", "2026.12.31")).toBe(1);
  });
  it("accepts a v prefix and uneven lengths", () => {
    expect(compareVersions("v2026.10.18", "2026.10.18")).toBe(0);
    expect(compareVersions("2026.10.18.1", "2026.10.18")).toBe(1);
  });
  it("ranks a release above its prerelease", () => {
    expect(compareVersions("2026.10.18", "2026.10.18-beta.1")).toBe(1);
    expect(compareVersions("2026.10.18-beta.2", "2026.10.18-beta.10")).toBe(-1);
  });
  it("never claims an update for unparseable input", () => {
    expect(compareVersions("garbage", "2026.10.9")).toBe(0);
    expect(compareVersions(null, "2026.10.9")).toBe(0);
  });
});

describe("parseFeedVersion", () => {
  it("reads the version from latest.yml", () => {
    expect(parseFeedVersion(LATEST_YML)).toBe("2026.10.18");
    expect(parseFeedVersion("version: '2026.10.19'\n")).toBe("2026.10.19");
    expect(parseFeedVersion("files: []\n")).toBeNull();
  });
});

describe("detectDesktopMode", () => {
  const bridge = {
    getState: async () => state({}),
    check: async () => state({}),
    download: async () => state({}),
    install: async () => true,
    openDownload: async () => true,
    onState: () => () => {},
  };
  it("uses the IPC bridge when the preload exposes it", () => {
    expect(detectDesktopMode({ desktopUpdater: bridge })?.kind).toBe("ipc");
  });
  it("falls back to the feed in older desktop shells (Electron UA / desktop-shell class)", () => {
    const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 InfiniBot/2026.10.9 Chrome/134 Electron/35.0.0 Safari/537.36";
    expect(detectDesktopMode({ navigator: { userAgent: ua } })).toEqual({ kind: "feed", platform: "win32" });
    expect(
      detectDesktopMode({
        platform: { os: "linux" },
        navigator: { userAgent: "Mozilla/5.0 (X11; Linux x86_64)" },
        document: { documentElement: { classList: { contains: (c: string) => c === "desktop-shell" } } },
      }),
    ).toEqual({ kind: "feed", platform: "linux" });
  });
  it("keeps the npm path in a plain browser", () => {
    expect(detectDesktopMode({ navigator: { userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/134" } })).toBeNull();
    expect(detectDesktopMode(undefined)).toBeNull();
  });
});

describe("fetchLatestDesktopVersion", () => {
  it("reads latest.yml first", async () => {
    const urls: string[] = [];
    const v = await fetchLatestDesktopVersion("win32", async (url) => {
      urls.push(url);
      return { ok: true, status: 200, text: async () => LATEST_YML };
    });
    expect(v).toBe("2026.10.18");
    expect(urls[0]).toMatch(/infinibot-desktop-releases\/releases\/latest\/download\/latest\.yml$/);
  });
  it("uses latest-linux.yml on Linux and falls back to the GitHub API (CORS)", async () => {
    const urls: string[] = [];
    const v = await fetchLatestDesktopVersion("linux", async (url) => {
      urls.push(url);
      if (url.endsWith(".yml")) throw new TypeError("Failed to fetch");
      return { ok: true, status: 200, text: async () => JSON.stringify({ tag_name: "v2026.10.18" }) };
    });
    expect(v).toBe("2026.10.18");
    expect(urls[0]).toMatch(/latest-linux\.yml$/);
    expect(urls[1]).toMatch(/^https:\/\/api\.github\.com\/repos\/MrYungCEO\/infinibot-desktop-releases\/releases\/latest$/);
  });
});

describe("checkDesktopFeed", () => {
  const feed = async () => ({ ok: true, status: 200, text: async () => LATEST_YML });
  it("10.9 vs feed 10.18 → available with a download link", async () => {
    const s = await checkDesktopFeed("win32", "2026.10.9", feed);
    expect(s).toMatchObject({ status: "available", version: "2026.10.18", canSelfUpdate: false });
    expect(s.downloadUrl).toBe("https://infinibotos.com/download/windows");
    expect(desktopChipModel(s).text).toBe("Download v2026.10.18");
  });
  it("same version → up to date", async () => {
    expect((await checkDesktopFeed("linux", "2026.10.18", feed)).status).toBe("up-to-date");
  });
  it("unreachable feed → error, never up to date", async () => {
    const s = await checkDesktopFeed("linux", "2026.10.9", async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(s.status).toBe("error");
    expect(s.downloadUrl).toBe("https://infinibotos.com/download/linux");
    expect(desktopChipModel(s).text).not.toMatch(/up to date/i);
  });
});

describe("desktopChipModel", () => {
  it("available + self-updating → Update → version", () => {
    const m = desktopChipModel(state({ status: "available", version: "2026.10.18" }));
    expect(m).toMatchObject({ kind: "highlight", text: "Update → 2026.10.18", action: "download" });
  });
  it("available on .deb → Download vX", () => {
    const m = desktopChipModel(state({ status: "available", version: "2026.10.18", canSelfUpdate: false }));
    expect(m).toMatchObject({ text: "Download v2026.10.18", action: "open-download" });
  });
  it("downloading shows percent; ready offers restart", () => {
    expect(desktopChipModel(state({ status: "downloading", version: "2026.10.18", percent: 42.4 }))).toMatchObject({
      text: "Downloading 2026.10.18… 42%",
      progress: 42.4,
      action: null,
    });
    expect(desktopChipModel(state({ status: "ready", version: "2026.10.18" }))).toMatchObject({
      text: "Restart to update → 2026.10.18",
      action: "install",
    });
  });
  it("updater error with a newer version known → Update vX available — Download", () => {
    const m = desktopChipModel(
      state({ status: "error", version: "2026.10.18", error: "New version 2026.10.18 is not signed by the application owner" }),
    );
    expect(m).toMatchObject({ text: "Update v2026.10.18 available — Download", action: "open-download" });
  });
  it("error without a newer version → retry, never 'up to date'", () => {
    const m = desktopChipModel(state({ status: "error", error: "net::ERR_INTERNET_DISCONNECTED" }));
    expect(m).toMatchObject({ kind: "error", text: "Update check failed — retry", action: "check" });
  });
  it("up to date shows the running version", () => {
    expect(desktopChipModel(state({ status: "up-to-date", currentVersion: "2026.10.18" })).text).toBe(
      "Up to date — v2026.10.18",
    );
  });
});
