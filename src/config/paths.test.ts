import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";

import {
  backfillStateFromRepo,
  ensureStateDir,
  resolveDefaultConfigCandidates,
  resolveOAuthDir,
  resolveOAuthPath,
  resolveStateDir,
  resolveStateDirWithLegacyEnv,
} from "./paths.js";

describe("ensureStateDir", () => {
  it("creates a fresh state directory with mode 0700", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "infinibot-state-mode-"));
    const stateDir = path.join(root, "nested", ".infinibot");
    try {
      ensureStateDir({ INFINIBOT_STATE_DIR: stateDir } as NodeJS.ProcessEnv);
      expect(statSync(stateDir).mode & 0o777).toBe(0o700);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not tighten an existing operator-owned directory", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "infinibot-state-existing-"));
    const stateDir = path.join(root, ".infinibot");
    try {
      mkdirSync(stateDir);
      chmodSync(stateDir, 0o775);
      ensureStateDir({ INFINIBOT_STATE_DIR: stateDir } as NodeJS.ProcessEnv);
      expect(statSync(stateDir).mode & 0o777).toBe(0o775);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("oauth paths", () => {
  it("prefers INFINIBOT_OAUTH_DIR over INFINIBOT_STATE_DIR", () => {
    const env = {
      INFINIBOT_OAUTH_DIR: "/custom/oauth",
      INFINIBOT_STATE_DIR: "/custom/state",
    } as NodeJS.ProcessEnv;

    expect(resolveOAuthDir(env, "/custom/state")).toBe(path.resolve("/custom/oauth"));
    expect(resolveOAuthPath(env, "/custom/state")).toBe(
      path.join(path.resolve("/custom/oauth"), "oauth.json"),
    );
  });

  it("derives oauth path from INFINIBOT_STATE_DIR when unset", () => {
    const env = {
      INFINIBOT_STATE_DIR: "/custom/state",
    } as NodeJS.ProcessEnv;

    expect(resolveOAuthDir(env, "/custom/state")).toBe(path.join("/custom/state", "credentials"));
    expect(resolveOAuthPath(env, "/custom/state")).toBe(
      path.join("/custom/state", "credentials", "oauth.json"),
    );
  });
});

describe("state + config path candidates", () => {
  it("honors INFINIBOT_STATE_DIR override", () => {
    const env = {
      INFINIBOT_STATE_DIR: "/new/state",
    } as NodeJS.ProcessEnv;

    expect(resolveStateDir(env, () => "/home/test")).toBe(path.resolve("/new/state"));
  });

  it("returns the canonical default config candidate", () => {
    const home = "/home/test";
    const candidates = resolveDefaultConfigCandidates({} as NodeJS.ProcessEnv, () => home);
    expect(candidates).toEqual([path.join(home, ".infinibot", "infinibot.json")]);
  });

  it("resolves to ~/.infinibot when no env vars are set (business + databases share this)", () => {
    const home = "/home/test";
    const expected = path.join(home, ".infinibot");
    // business.ts getStateDir() and store.ts getDatabasesStore() both delegate
    // to these resolvers, so equality here guarantees they agree on the dir.
    expect(resolveStateDir({} as NodeJS.ProcessEnv, () => home)).toBe(expected);
    expect(resolveStateDirWithLegacyEnv({} as NodeJS.ProcessEnv, () => home)).toBe(expected);
  });
});

describe("resolveStateDirWithLegacyEnv (MOLTBOT_STATE_DIR back-compat)", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("honors legacy MOLTBOT_STATE_DIR and emits a deprecation warning", () => {
    const env = { MOLTBOT_STATE_DIR: "/legacy/state" } as NodeJS.ProcessEnv;
    expect(resolveStateDirWithLegacyEnv(env, () => "/home/test")).toBe(
      path.resolve("/legacy/state"),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("MOLTBOT_STATE_DIR is deprecated"),
    );
  });

  it("prefers INFINIBOT_STATE_DIR over the legacy var (no warning)", () => {
    const env = {
      INFINIBOT_STATE_DIR: "/new/state",
      MOLTBOT_STATE_DIR: "/legacy/state",
    } as NodeJS.ProcessEnv;
    warnSpy.mockClear();
    expect(resolveStateDirWithLegacyEnv(env, () => "/home/test")).toBe(path.resolve("/new/state"));
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe("backfillStateFromRepo", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "infinibot-backfill-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function makeRepoWithState(): { repoRoot: string; home: string } {
    const repoRoot = path.join(tmp, "repo");
    const home = path.join(tmp, "home");
    mkdirSync(path.join(repoRoot, "state"), { recursive: true });
    mkdirSync(home, { recursive: true });
    // resolveRepoRoot only honors INFINIBOT_REPO_ROOT when it has a package.json.
    writeFileSync(path.join(repoRoot, "package.json"), JSON.stringify({ name: "infinibot" }));
    writeFileSync(path.join(repoRoot, "state", "business.json"), '{"businesses":[]}');
    writeFileSync(path.join(repoRoot, "state", "databases.db"), "stale-repo-db");
    return { repoRoot, home };
  }

  it("copies stale repo state into ~/.infinibot when target files are missing", () => {
    const { repoRoot, home } = makeRepoWithState();
    const env = { INFINIBOT_REPO_ROOT: repoRoot } as NodeJS.ProcessEnv;
    backfillStateFromRepo(env, () => home);

    const target = path.join(home, ".infinibot");
    expect(readFileSync(path.join(target, "business.json"), "utf-8")).toBe('{"businesses":[]}');
    expect(readFileSync(path.join(target, "databases.db"), "utf-8")).toBe("stale-repo-db");
  });

  it("never overwrites an existing target file (favors the home copy)", () => {
    const { repoRoot, home } = makeRepoWithState();
    const target = path.join(home, ".infinibot");
    mkdirSync(target, { recursive: true });
    writeFileSync(path.join(target, "databases.db"), "real-home-db-7mb");
    const env = { INFINIBOT_REPO_ROOT: repoRoot } as NodeJS.ProcessEnv;

    backfillStateFromRepo(env, () => home);

    expect(readFileSync(path.join(target, "databases.db"), "utf-8")).toBe("real-home-db-7mb");
    // business.json was still missing, so it gets backfilled.
    expect(readFileSync(path.join(target, "business.json"), "utf-8")).toBe('{"businesses":[]}');
  });

  it("is a no-op when INFINIBOT_STATE_DIR is set (operator owns that path)", () => {
    const { repoRoot, home } = makeRepoWithState();
    const stateOverride = path.join(tmp, "override");
    mkdirSync(stateOverride, { recursive: true });
    const env = {
      INFINIBOT_REPO_ROOT: repoRoot,
      INFINIBOT_STATE_DIR: stateOverride,
    } as NodeJS.ProcessEnv;

    backfillStateFromRepo(env, () => home);

    expect(() => readFileSync(path.join(stateOverride, "business.json"))).toThrow();
  });
});
