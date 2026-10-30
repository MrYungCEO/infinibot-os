import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { roleFromSystemPrompt } from "./member-profile.js";
import { BindingError, normalizeBindingPatch, probeRepo } from "./repo-info.js";

function tempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gc-probe-"));
  const g = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
  g("init", "-q", "-b", "main");
  g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  return dir;
}

describe("repo binding probe", () => {
  it("reports branch, HEAD and an explicit empty remote list", () => {
    const dir = tempRepo();
    const info = probeRepo(dir);
    expect(info).toMatchObject({ exists: true, isGitRepo: true, branch: "main", remotes: [], dirty: 0 });
    expect(info.head).toMatch(/^[0-9a-f]{7,}$/);
    execFileSync("git", ["remote", "add", "origin", "/tmp/nowhere.git"], { cwd: dir });
    expect(probeRepo(dir).remotes).toEqual([{ name: "origin", url: "/tmp/nowhere.git" }]);
  });

  it("validates workdir and merges/clears fields", () => {
    const dir = tempRepo();
    expect(normalizeBindingPatch({ workdir: dir, purpose: " p " }, undefined)).toEqual({ workdir: dir, purpose: "p" });
    expect(normalizeBindingPatch({ purpose: "" }, { workdir: dir, purpose: "p" })).toEqual({ workdir: dir });
    expect(normalizeBindingPatch(null, { workdir: dir })).toBeUndefined();
    expect(() => normalizeBindingPatch({ workdir: "relative/x" }, undefined)).toThrow(BindingError);
    expect(() => normalizeBindingPatch({ workdir: "/definitely/not/here" }, undefined)).toThrow(/not found/);
    expect(probeRepo("/definitely/not/here")).toMatchObject({ exists: false, isGitRepo: false });
  });

  it("derives member roles from the agent's system prompt first line", () => {
    expect(roleFromSystemPrompt("You are DEV — the primary coding agent for this workspace.\n…")).toBe(
      "the primary coding agent for this workspace",
    );
    expect(roleFromSystemPrompt("You are INFINI, Chief Executive of the InfiniBot Agency.")).toBe(
      "Chief Executive of the InfiniBot Agency",
    );
    expect(roleFromSystemPrompt(undefined)).toBeUndefined();
  });
});
