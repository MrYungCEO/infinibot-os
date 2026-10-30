import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { setFolderUsersProviderForTests } from "./activity.js";
import { clearBranchHealthCaches, scanRepoHealth, type HealthReport } from "./branch-health.js";
import {
  classifyBranch,
  cleanupBlockReason,
  type BranchFacts,
  type WorktreeFacts,
} from "./classify.js";
import { executeCleanup, listManifests, previewCleanup, restoreCleanup } from "./cleanup.js";
import { ciDeployBranches, detectTargets, suggestDeploy } from "./deploy-detect.js";
import {
  findBinding,
  readRegistry,
  registryPath,
  resolveRepoKeySync,
  setBinding,
  updateRegistry,
} from "./registry.js";
import { buildFixtureRepo, type FixtureRepo } from "./test-fixture.js";

let tmp: string;
let fx: FixtureRepo;
const FUTURE = Date.now() + 60_000;

function scan(extra: Partial<Parameters<typeof scanRepoHealth>[1]> = {}): Promise<HealthReport> {
  return scanRepoHealth(fx.root, {
    deployBranch: fx.deployBranch,
    github: false,
    sizes: true,
    now: FUTURE,
    ...extra,
  });
}

function branch(r: HealthReport, name: string) {
  const b = r.branches.find((x) => x.kind === "local" && x.shortName === name);
  if (!b) throw new Error(`no branch ${name}`);
  return b;
}

beforeAll(() => {
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ib-branch-health-"));
  fx = buildFixtureRepo(tmp);
  setFolderUsersProviderForTests(async () => [
    { cwd: path.join(fx.worktrees.busyWt, "src"), who: "agent: fixture-coder" },
  ]);
});

afterAll(() => {
  setFolderUsersProviderForTests(null);
  fs.rmSync(tmp, { recursive: true, force: true });
});

afterEach(() => clearBranchHealthCaches());

describe("branch health classification (fixture repo)", () => {
  it("proves merges four ways and groups every branch", async () => {
    const r = await scan();
    expect(r.comparedAgainst).toBe("deploy");
    expect(branch(r, "feat/merged")).toMatchObject({ group: "safe", mergedBy: "ancestor" });
    expect(branch(r, "feat/squashed")).toMatchObject({ group: "safe", mergedBy: "content" });
    expect(branch(r, "feat/squash-edit")).toMatchObject({ group: "safe", mergedBy: "squash" });
    expect(branch(r, "feat/picked")).toMatchObject({ group: "safe", mergedBy: "cherry" });
    const un = branch(r, "feat/unmerged");
    expect(un).toMatchObject({
      group: "review",
      mergedBy: null,
      uniqueCommits: 2,
      uniqueWork: true,
    });
    expect(un.reasons[0]).toContain("2 commits not in the deploy branch");
    expect(branch(r, "feat/dirty-wt").group).toBe("review");
    expect(branch(r, "feat/dirty-wt").reasons[0]).toContain("uncommitted changes");
    expect(branch(r, "feat/busy-wt")).toMatchObject({ group: "active" });
    expect(branch(r, "feat/busy-wt").reasons[0]).toContain("agent: fixture-coder");
    expect(branch(r, "release/live")).toMatchObject({ group: "protected" });
    expect(branch(r, "main")).toMatchObject({ group: "protected" });
    expect(r.totals.uniqueWork).toBe(1);
  });

  it("classifies worktrees and lists stashes", async () => {
    const r = await scan();
    const wt = (p: string) => r.worktrees.find((w) => w.path === p);
    expect(r.worktrees.find((w) => w.main)?.group).toBe("protected");
    expect(wt(fx.worktrees.mergedWt)?.group).toBe("safe");
    expect(wt(fx.worktrees.mergedWt)?.sizeBytes).toBeGreaterThan(0);
    expect(wt(fx.worktrees.dirtyWt)).toMatchObject({ group: "review", dirty: true });
    expect(wt(fx.worktrees.dirtyWt)?.dirtySample?.[0]).toContain("src/dirty.txt");
    expect(wt(fx.worktrees.busyWt)?.group).toBe("active");
    expect(r.stashes).toHaveLength(1);
    expect(r.stashes[0].message).toContain("fixture stash: half-done idea");
    expect(r.stashes[0].branch).toBe("main");
    expect(r.totals.reclaimBytes).toBe(wt(fx.worktrees.mergedWt)?.sizeBytes);
  });

  it("falls back to the default branch when no deploy branch is set", async () => {
    const r = await scan({ deployBranch: undefined });
    expect(r.comparedAgainst).toBe("default");
    expect(r.defaultBranch).toBe("main"); // no origin/HEAD → local main
    expect(r.baseRef).toBe("refs/heads/main");
  });

  it("recent commits are active, not safe", () => {
    const now = Date.now();
    const f: BranchFacts = {
      name: "feat/x",
      shortName: "feat/x",
      kind: "local",
      sha: "a",
      lastCommitAt: now - 3600_000,
      mergedBy: "ancestor",
      uniqueCommits: 0,
      worktreePaths: [],
    };
    expect(classifyBranch(f, { now, worktreesByPath: new Map() }).group).toBe("active");
    expect(
      classifyBranch(
        { ...f, lastCommitAt: now - 10 * 86_400_000 },
        { now, worktreesByPath: new Map() },
      ).group,
    ).toBe("safe");
    // A PR merged into a side branch does not make unmerged work safe.
    const side = classifyBranch(
      {
        ...f,
        lastCommitAt: now - 10 * 86_400_000,
        mergedBy: null,
        uniqueCommits: 3,
        pr: { number: 17, state: "MERGED", baseRefName: "feat/other" },
      },
      { now, deployBranch: "release/live", worktreesByPath: new Map() },
    );
    expect(side.group).toBe("review");
    expect(side.reasons.join(" ")).toContain(
      "PR #17 merged into feat/other, not the deploy branch",
    );
  });
});

describe("deploy folder behind origin", () => {
  it("flags work merged on origin's deploy branch that the local deploy branch has not pulled", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ib-bh-origin-"));
    try {
      const f = buildFixtureRepo(dir);
      const g = (cwd: string, ...a: string[]) =>
        execFileSync("git", a, {
          cwd,
          env: {
            ...process.env,
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_AUTHOR_NAME: "t",
            GIT_AUTHOR_EMAIL: "t@t",
            GIT_COMMITTER_NAME: "t",
            GIT_COMMITTER_EMAIL: "t@t",
          },
          stdio: ["ignore", "pipe", "pipe"],
        }).toString();
      const bare = path.join(dir, "origin.git");
      g(dir, "init", "-q", "--bare", bare);
      g(f.root, "remote", "add", "origin", bare);
      g(f.root, "push", "-q", "origin", "release/live", "feat/unmerged");
      // Someone merges feat/unmerged on GitHub (another clone).
      const other = path.join(dir, "other");
      g(dir, "clone", "-q", "-b", "release/live", bare, other);
      g(other, "merge", "-q", "--no-ff", "-m", "Merge PR #17", "origin/feat/unmerged");
      g(other, "push", "-q", "origin", "release/live");
      g(f.root, "fetch", "-q", "origin");
      const r = await scanRepoHealth(f.root, {
        deployBranch: "release/live",
        github: false,
        now: FUTURE,
      });
      const b = r.branches.find((x) => x.kind === "local" && x.shortName === "feat/unmerged");
      expect(b?.mergedBy).toBeNull();
      expect(b?.inOriginDeploy).toBe(true);
      expect(b?.uniqueWork).toBe(false);
      expect(b?.reasons.join(" ")).toContain("not pulled it yet");
      expect(r.warnings.join(" ")).toContain("behind origin/release/live");
      expect(r.totals.notPulled).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("cleanup safety rules", () => {
  const wt = (over: Partial<WorktreeFacts>): WorktreeFacts => ({
    path: "/x",
    head: "h",
    main: false,
    detached: false,
    dirty: false,
    dirtyCount: 0,
    activeBy: [],
    ...over,
  });
  const safe = { group: "safe" as const, reasons: ["merged"], uniqueWork: false };
  const b = (over: Partial<BranchFacts>): BranchFacts => ({
    name: "feat/x",
    shortName: "feat/x",
    kind: "local",
    sha: "s",
    lastCommitAt: 0,
    mergedBy: "ancestor",
    worktreePaths: [],
    ...over,
  });
  const ctx = { deployBranch: "release/live", deployWorktreePath: "/deploy" };

  it("never deletes the deploy branch, unmerged work or busy/dirty worktrees", () => {
    expect(
      cleanupBlockReason(
        { type: "branch", name: "release/live" },
        { branch: b({ shortName: "release/live" }), branchClass: safe },
        ctx,
      ),
    ).toBe("deploy branch");
    expect(
      cleanupBlockReason(
        { type: "branch", name: "feat/x" },
        { branch: b({ mergedBy: null }), branchClass: safe },
        ctx,
      ),
    ).toContain("not in the deploy branch");
    expect(
      cleanupBlockReason(
        { type: "branch", name: "feat/x" },
        { branch: b({}), branchClass: safe, otherCheckouts: ["/wt"] },
        ctx,
      ),
    ).toContain("checked out in /wt");
    expect(
      cleanupBlockReason(
        { type: "worktree", name: "/x" },
        { worktree: wt({ dirty: true, dirtyCount: 1 }), worktreeClass: safe },
        ctx,
      ),
    ).toContain("uncommitted");
    expect(
      cleanupBlockReason(
        { type: "worktree", name: "/x" },
        { worktree: wt({ activeBy: ["agent: a"] }), worktreeClass: safe },
        ctx,
      ),
    ).toContain("in use");
    expect(
      cleanupBlockReason(
        { type: "worktree", name: "/deploy" },
        { worktree: wt({ path: "/deploy" }), worktreeClass: safe },
        ctx,
      ),
    ).toBe("deploy folder");
    expect(
      cleanupBlockReason(
        { type: "worktree", name: "/m" },
        { worktree: wt({ main: true }), worktreeClass: safe },
        ctx,
      ),
    ).toContain("main folder");
    expect(
      cleanupBlockReason(
        { type: "branch", name: "feat/x" },
        { branch: b({}), branchClass: safe },
        ctx,
      ),
    ).toBeNull();
  });

  it("remote branches only when explicitly selected", () => {
    const remote = b({ kind: "remote", name: "origin/feat/x" });
    expect(
      cleanupBlockReason(
        { type: "remote-branch", name: "origin/feat/x" },
        { branch: remote, branchClass: safe },
        ctx,
      ),
    ).toContain("explicitly selected");
    expect(
      cleanupBlockReason(
        { type: "remote-branch", name: "origin/feat/x" },
        { branch: remote, branchClass: safe },
        { ...ctx, allowRemote: true },
      ),
    ).toBeNull();
  });
});

describe("cleanup: preview → execute → restore", () => {
  it("removes only safe items, writes the manifest first and restores exactly", async () => {
    const stateDir = path.join(tmp, "state");
    const before = {
      merged: fx.sha("feat/merged"),
      mergedWt: fx.sha("feat/merged-wt"),
      squash: fx.sha("feat/squashed"),
    };
    const plan = await previewCleanup(fx.root, {
      deployBranch: fx.deployBranch,
      report: await scan(),
    });
    const names = plan.items.map((i) => `${i.type}:${i.name}`);
    expect(names).toContain("branch:feat/merged");
    expect(names).toContain("branch:feat/squashed");
    expect(names).toContain("branch:feat/squash-edit");
    expect(names).toContain("branch:feat/picked");
    expect(names).toContain(`worktree:${fx.worktrees.mergedWt}`);
    expect(names).toContain("branch:feat/merged-wt");
    for (const kept of ["feat/unmerged", "feat/dirty-wt", "feat/busy-wt", "release/live", "main"]) {
      expect(names).not.toContain(`branch:${kept}`);
    }
    expect(
      names.some((n) => n.includes(fx.worktrees.dirtyWt) || n.includes(fx.worktrees.busyWt)),
    ).toBe(false);
    expect(plan.items.some((i) => i.type === "remote-branch")).toBe(false);
    // The preview touched nothing.
    expect(fs.existsSync(fx.worktrees.mergedWt)).toBe(true);

    const { manifest, manifestPath } = await executeCleanup(stateDir, plan.planId, {
      confirm: true,
      report: await scan(),
    });
    expect(manifestPath.startsWith(path.join(stateDir, "repo-cleanup", "app"))).toBe(true);
    expect(fs.existsSync(manifestPath)).toBe(true);
    const deleted = manifest.entries.filter((e) => e.status === "deleted").map((e) => e.name);
    expect(deleted).toContain("feat/merged");
    expect(deleted).toContain(fx.worktrees.mergedWt);
    expect(manifest.entries.find((e) => e.name === "feat/merged")?.sha).toBe(before.merged);
    expect(fs.existsSync(fx.worktrees.mergedWt)).toBe(false);
    expect(() => fx.sha("refs/heads/feat/merged")).toThrow();
    // Untouched: unmerged work, dirty worktree (with its edit), stash.
    expect(fx.sha("feat/unmerged")).toBeTruthy();
    expect(fs.readFileSync(path.join(fx.worktrees.dirtyWt, "src/dirty.txt"), "utf8")).toContain(
      "uncommitted",
    );
    expect(execFileSync("git", ["-C", fx.root, "stash", "list"]).toString()).toContain(
      "half-done idea",
    );
    // Backup refs keep the commits reachable.
    expect(fx.sha(`refs/infinibot-cleanup/${manifest.id}/feat/merged`)).toBe(before.merged);
    expect(listManifests(stateDir, "app")[0].id).toBe(manifest.id);

    const restored = await restoreCleanup(stateDir, "app", manifest.id);
    expect(restored.restoreLog?.every((l) => l.ok)).toBe(true);
    expect(fx.sha("feat/merged")).toBe(before.merged);
    expect(fx.sha("feat/merged-wt")).toBe(before.mergedWt);
    expect(fx.sha("feat/squashed")).toBe(before.squash);
    expect(fs.existsSync(path.join(fx.worktrees.mergedWt, "src/merged-wt.txt"))).toBe(true);
  });

  it("re-validates at execute time: an item that got dirty is skipped, not forced", async () => {
    const stateDir = path.join(tmp, "state2");
    const plan = await previewCleanup(fx.root, {
      deployBranch: fx.deployBranch,
      report: await scan(),
    });
    expect(plan.items.some((i) => i.name === fx.worktrees.mergedWt)).toBe(true);
    fs.writeFileSync(path.join(fx.worktrees.mergedWt, "new-idea.txt"), "not committed\n");
    const { manifest } = await executeCleanup(stateDir, plan.planId, {
      confirm: true,
      report: await scan(),
    });
    const wtEntry = manifest.entries.find((e) => e.name === fx.worktrees.mergedWt);
    expect(wtEntry?.status).toBe("skipped");
    expect(fs.existsSync(path.join(fx.worktrees.mergedWt, "new-idea.txt"))).toBe(true);
    // Its branch is still checked out there → also kept.
    expect(manifest.entries.find((e) => e.name === "feat/merged-wt")?.status).not.toBe("deleted");
    expect(fx.sha("feat/merged-wt")).toBeTruthy();
    await restoreCleanup(stateDir, "app", manifest.id);
  });

  it("refuses to run without confirm or with an unknown plan", async () => {
    await expect(executeCleanup(tmp, "nope", { confirm: false })).rejects.toThrow(/confirm/);
    await expect(executeCleanup(tmp, "nope", { confirm: true })).rejects.toThrow(/expired/);
  });
});

describe("deploy detection", () => {
  it("reads fly.toml app names and CI deploy branches", () => {
    const d = path.join(tmp, "detect");
    fs.mkdirSync(path.join(d, "deploy", "fly"), { recursive: true });
    fs.mkdirSync(path.join(d, ".github", "workflows"), { recursive: true });
    fs.writeFileSync(path.join(d, "deploy", "fly", "fly.toml"), 'app = "flypic-web"\n');
    fs.writeFileSync(
      path.join(d, ".github", "workflows", "deploy.yml"),
      "on:\n  push:\n    branches: [release/live]\njobs:\n  d:\n    steps:\n      - run: flyctl deploy --remote-only\n",
    );
    expect(detectTargets(d)).toEqual([
      {
        kind: "fly",
        name: "flypic-web",
        file: "deploy/fly/fly.toml",
        command: "fly deploy -c deploy/fly/fly.toml",
      },
    ]);
    expect(ciDeployBranches(d)).toEqual([
      { branch: "release/live", file: "deploy.yml", tool: "flyctl deploy" },
    ]);
  });

  it("suggests the newest release branch over the default branch", async () => {
    const s = await suggestDeploy(fx.root);
    expect(s.best?.branch).toBe("release/live");
    expect(s.best?.signals.map((x) => x.kind)).toContain("release");
    expect(s.best?.confidence).toBeGreaterThan(0);
  });
});

describe("registry persistence", () => {
  it("survives a reload, serializes concurrent writers and falls back to .bak", async () => {
    const sd = path.join(tmp, "reg");
    await Promise.all([
      updateRegistry(sd, (r) =>
        setBinding(r, { projectId: "p1", projectName: "One", path: fx.root }),
      ),
      updateRegistry(sd, (r) =>
        setBinding(r, { projectId: "p2", projectName: "Two", path: fx.root }),
      ),
      updateRegistry(sd, (r) =>
        setBinding(r, { projectId: "p1", projectName: "One", path: fx.root }),
      ),
    ]);
    const reg = readRegistry(sd);
    expect(Object.keys(reg.bindings).sort()).toEqual(["p1", "p2"]);
    expect(reg.bindings.p1.rev).toBe(2);
    // Re-match by name when the project id changes (local row ↔ Notion page).
    expect(findBinding(reg, "notion-page-id", "Two")?.projectId).toBe("p2");
    // Detach leaves a tombstone.
    await updateRegistry(sd, (r) =>
      setBinding(r, { projectId: "p2", projectName: "Two", path: null }),
    );
    expect(readRegistry(sd).bindings.p2).toMatchObject({ path: null, detachedPath: fx.root });
    // Corrupt primary → the previous copy.
    fs.writeFileSync(registryPath(sd), "{not json");
    expect(readRegistry(sd).bindings.p1?.path).toBe(fx.root);
  });

  it("keys every worktree of a repo to the same common dir", () => {
    const a = resolveRepoKeySync(fx.root);
    const b = resolveRepoKeySync(path.join(fx.worktrees.dirtyWt, "src"));
    expect(a?.key).toBe(b?.key);
    expect(b?.root).toBe(fx.worktrees.dirtyWt);
  });
});
