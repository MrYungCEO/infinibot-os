import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createWorkspaceVersion,
  diffWorkspaceVersion,
  listWorkspaceVersions,
  revertWorkspaceVersion,
} from "./versions.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("workspace versions", () => {
  it("snapshots dirty and untracked files without moving HEAD, then reverts later edits", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ib-version-repo-"));
    roots.push(root);
    const state = fs.mkdtempSync(path.join(os.tmpdir(), "ib-version-state-"));
    roots.push(state);
    const previousState = process.env.INFINIBOT_STATE_DIR;
    process.env.INFINIBOT_STATE_DIR = state;
    try {
      execFileSync("git", ["init", "-q"], { cwd: root });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
      fs.writeFileSync(path.join(root, "app.txt"), "base\n");
      execFileSync("git", ["add", "."], { cwd: root });
      execFileSync("git", ["commit", "-qm", "base"], { cwd: root });
      const head = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      }).trim();
      fs.writeFileSync(path.join(root, "app.txt"), "checkpoint\n");
      fs.writeFileSync(path.join(root, "new.txt"), "included\n");
      const version = createWorkspaceVersion(root, "fixture", "Before agent turn");
      expect(
        execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
      ).toBe(head);
      expect(diffWorkspaceVersion(root, "fixture", version.id).diff).toBe("");
      fs.writeFileSync(path.join(root, "app.txt"), "agent changed this\n");
      fs.writeFileSync(path.join(root, "new.txt"), "agent changed this too\n");
      const turnDiff = diffWorkspaceVersion(root, "fixture", version.id).diff;
      expect(turnDiff).toContain("agent changed this");
      expect(turnDiff).toContain("agent changed this too");
      revertWorkspaceVersion(root, "fixture", version.id);
      expect(fs.readFileSync(path.join(root, "app.txt"), "utf8")).toBe("checkpoint\n");
      expect(fs.readFileSync(path.join(root, "new.txt"), "utf8")).toBe("included\n");
      const backup = listWorkspaceVersions("fixture")[0];
      expect(backup.description).toContain("Before reverting");
      revertWorkspaceVersion(root, "fixture", backup.id);
      expect(fs.readFileSync(path.join(root, "app.txt"), "utf8")).toBe("agent changed this\n");
      expect(fs.readFileSync(path.join(root, "new.txt"), "utf8")).toBe("agent changed this too\n");
    } finally {
      if (previousState === undefined) delete process.env.INFINIBOT_STATE_DIR;
      else process.env.INFINIBOT_STATE_DIR = previousState;
    }
  });
});
