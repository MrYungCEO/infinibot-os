import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildInstallArgs,
  checkForUpdate,
  classifyInstallError,
  classifyRegistryError,
  detectInstallManager,
  installCommandLine,
  installSpec,
  invalidateCheckCache,
  resolveManagerBinary,
} from "./prod-updater.js";

afterEach(() => {
  vi.restoreAllMocks();
  invalidateCheckCache();
});

describe("detectInstallManager", () => {
  it("reads the manager off npm_config_user_agent", () => {
    expect(detectInstallManager("pnpm/8.15.0 npm/? node/v20")).toBe("pnpm");
    expect(detectInstallManager("yarn/1.22.19 npm/? node/v20")).toBe("yarn");
    expect(detectInstallManager("bun/1.1.0")).toBe("bun");
    expect(detectInstallManager("npm/10.2.0 node/v20")).toBe("npm");
  });
  it("falls back to npm for empty / unknown agents", () => {
    expect(detectInstallManager("")).toBe("npm");
    expect(detectInstallManager("node/v20")).toBe("npm");
  });
});

describe("resolveManagerBinary (platform)", () => {
  it("uses .cmd shims on Windows for npm/pnpm/yarn", () => {
    expect(resolveManagerBinary("npm", "win32")).toBe("npm.cmd");
    expect(resolveManagerBinary("pnpm", "win32")).toBe("pnpm.cmd");
    expect(resolveManagerBinary("yarn", "win32")).toBe("yarn.cmd");
    // bun ships as bun.exe and resolves by bare name on PATH
    expect(resolveManagerBinary("bun", "win32")).toBe("bun");
  });
  it("uses bare names on linux/macOS", () => {
    expect(resolveManagerBinary("npm", "linux")).toBe("npm");
    expect(resolveManagerBinary("pnpm", "darwin")).toBe("pnpm");
  });
});

describe("buildInstallArgs / installCommandLine", () => {
  it("builds the right global-install argv per manager", () => {
    expect(buildInstallArgs("npm", "infinibot@1.2.3")).toEqual([
      "install",
      "-g",
      "infinibot@1.2.3",
    ]);
    expect(buildInstallArgs("pnpm", "infinibot@1.2.3")).toEqual(["add", "-g", "infinibot@1.2.3"]);
    expect(buildInstallArgs("yarn", "infinibot@1.2.3")).toEqual([
      "global",
      "add",
      "infinibot@1.2.3",
    ]);
    expect(buildInstallArgs("bun", "infinibot@1.2.3")).toEqual(["add", "-g", "infinibot@1.2.3"]);
  });
  it("renders the exact command line the spawn runs (linux)", () => {
    expect(installCommandLine("npm", "1.2.3", "linux")).toBe("npm install -g infinibot@1.2.3");
  });
  it("renders npm.cmd on Windows", () => {
    expect(installCommandLine("npm", "1.2.3", "win32")).toBe("npm.cmd install -g infinibot@1.2.3");
  });
  it("defaults a missing version to latest", () => {
    expect(installSpec(null)).toBe("infinibot@latest");
    expect(installSpec("")).toBe("infinibot@latest");
    expect(installSpec("2.0.0")).toBe("infinibot@2.0.0");
  });
});

describe("error classification", () => {
  it("classifies registry failures by cause", () => {
    expect(classifyRegistryError("HTTP 429")).toBe("rate-limit");
    expect(classifyRegistryError("HTTP 404")).toBe("version-not-found");
    expect(classifyRegistryError("AbortError: The operation was aborted")).toBe("network");
    expect(classifyRegistryError("getaddrinfo ENOTFOUND registry.npmjs.org")).toBe("network");
    expect(classifyRegistryError("HTTP 500")).toBe("registry");
  });
  it("classifies install failures by cause", () => {
    expect(classifyInstallError("npm ERR! code EACCES\npermission denied")).toBe("permission");
    expect(classifyInstallError("ENOSPC: no space left on device")).toBe("disk");
    expect(classifyInstallError("npm ERR! 404 'infinibot@9.9.9' is not in the registry")).toBe(
      "version-not-found",
    );
    expect(classifyInstallError("getaddrinfo ENOTFOUND registry")).toBe("network");
    expect(classifyInstallError("some other failure")).toBe("unknown");
  });
});

describe("checkForUpdate (mocked registry)", () => {
  function mockRegistry(version: string | null, status = 200) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        if (version === null) {
          return { ok: false, status, json: async () => ({}) } as unknown as Response;
        }
        return { ok: true, status: 200, json: async () => ({ version }) } as unknown as Response;
      }),
    );
  }

  it("reports an update when registry latest is higher than current", async () => {
    mockRegistry("9999.0.0");
    const r = await checkForUpdate({ force: true });
    expect(r.hasUpdate).toBe(true);
    expect(r.latestVersion).toBe("9999.0.0");
    expect(r.error).toBeUndefined();
  });

  it("reports up-to-date when registry latest is not higher", async () => {
    mockRegistry("0.0.1");
    const r = await checkForUpdate({ force: true });
    expect(r.hasUpdate).toBe(false);
  });

  it("serves a cached result within the TTL and refreshes on force", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ version: "9999.0.0" }),
    })) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);

    await checkForUpdate({ force: true }); // 1 network call
    const cached = await checkForUpdate({ force: false }); // served from cache
    expect(cached.fromCache).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await checkForUpdate({ force: true }); // forced refresh
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("surfaces a network error kind without caching it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("getaddrinfo ENOTFOUND registry.npmjs.org");
      }),
    );
    const r = await checkForUpdate({ force: true });
    expect(r.hasUpdate).toBe(false);
    expect(r.errorKind).toBe("network");
    // Error results are not cached → next non-forced check retries.
    expect(r.fromCache).toBe(false);
  });
});
