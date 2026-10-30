import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { InfinibotConfig } from "../config/config.js";
import { buildWorkspaceSkillSnapshot } from "./skills.js";

async function writeSkill(dir: string, name: string) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} skill\n---\n\n# ${name}\n`,
    "utf-8",
  );
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infinibot-skills-profile-"));
  const bundled = path.join(root, "bundled");
  await writeSkill(path.join(bundled, "weather"), "weather");
  await writeSkill(path.join(bundled, "atlas-cloud"), "atlas-cloud");
  await writeSkill(path.join(bundled, "_drafts", "private-draft"), "private-draft");
  await writeSkill(path.join(root, "workspace", "skills", "_wip", "ws-draft"), "ws-draft");
  await writeSkill(path.join(root, "workspace", "skills", "mine"), "mine");
  return { root, bundled, workspace: path.join(root, "workspace") };
}

function names(workspace: string, bundled: string, config?: InfinibotConfig): string[] {
  return buildWorkspaceSkillSnapshot(workspace, {
    config,
    bundledSkillsDir: bundled,
    managedSkillsDir: path.join(workspace, ".managed"),
  })
    .skills.map((s) => s.name)
    .sort();
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("first-run skill loading", () => {
  it("never loads skills from _-prefixed folders (e.g. skills/_drafts)", async () => {
    const { bundled, workspace } = await fixture();
    const loaded = names(workspace, bundled, { skills: { profile: "full" } } as InfinibotConfig);
    expect(loaded).toEqual(["atlas-cloud", "mine", "weather"]);
  });

  it("INFINIBOT_LOAD_DRAFT_SKILLS=1 includes drafts for authors", async () => {
    vi.stubEnv("INFINIBOT_LOAD_DRAFT_SKILLS", "1");
    const { bundled, workspace } = await fixture();
    expect(names(workspace, bundled, { skills: { profile: "full" } } as InfinibotConfig)).toContain(
      "private-draft",
    );
  });

  it("fresh install uses the core profile and hides owner-pack bundled skills", async () => {
    const { bundled, workspace } = await fixture();
    expect(names(workspace, bundled, {} as InfinibotConfig)).toEqual(["mine", "weather"]);
  });

  it("an explicit enable or allowlist entry wins over the core profile", async () => {
    const { bundled, workspace } = await fixture();
    const viaEntry = {
      skills: { entries: { "atlas-cloud": { enabled: true } } },
    } as unknown as InfinibotConfig;
    expect(names(workspace, bundled, viaEntry)).toContain("atlas-cloud");
  });

  it("existing install with the full roster keeps every bundled skill", async () => {
    const { bundled, workspace } = await fixture();
    const legacy = {
      // Any non-core roster id marks a pre-profiles install (head-of-dev is in
      // the `dev` pack; content-director now ships with the content-studio plugin).
      agents: { list: [{ id: "main" }, { id: "head-of-dev" }] },
    } as unknown as InfinibotConfig;
    expect(names(workspace, bundled, legacy)).toContain("atlas-cloud");
  });

  it("the shipped skills/_drafts tree is not loaded", () => {
    const repoSkills = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../skills");
    const snapshot = buildWorkspaceSkillSnapshot(os.tmpdir(), {
      config: { skills: { profile: "full" } } as InfinibotConfig,
      bundledSkillsDir: repoSkills,
      managedSkillsDir: path.join(os.tmpdir(), "infinibot-no-managed-skills"),
    });
    const loaded = new Set(snapshot.skills.map((skill) => skill.name));
    expect(loaded.size).toBeGreaterThan(0);
    for (const skill of snapshot.resolvedSkills ?? []) {
      expect(path.relative(repoSkills, skill.filePath).split(path.sep), skill.name).not.toContain(
        "_drafts",
      );
    }
    // skills/_drafts is gitignored (no longer shipped) but agents still write
    // local drafts there; when present, none of them may load.
    const draftsDir = path.join(repoSkills, "_drafts");
    const drafts = fsSync.existsSync(draftsDir) ? fsSync.readdirSync(draftsDir) : [];
    for (const draft of drafts) expect(loaded.has(draft), draft).toBe(false);
  });
});
