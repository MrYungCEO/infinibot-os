import { describe, expect, it } from "vitest";

import { buildCompactSkillsBlock, SKILLS_BLOCK_INLINE_BUDGET } from "./skill-system.js";

describe("compact coder skills block", () => {
  const skills = Array.from({ length: 320 }, (_, i) => ({
    name: `skill-number-${i}`,
    description: `Does task ${i}. `.repeat(40),
    filePath:
      i % 3 === 0
        ? `/home/u/.infinibot/skills/browser/skill-number-${i}/SKILL.md`
        : i === 7
          ? `/repo/skills/odd-folder/SKILL.md`
          : `/repo/skills/skill-number-${i}/SKILL.md`,
  }));

  it("fits the budget, keeps every skill name, and keeps paths derivable", () => {
    const block = buildCompactSkillsBlock(skills, "/state/skills-index/full.xml");
    expect(Buffer.byteLength(block)).toBeLessThanOrEqual(SKILLS_BLOCK_INLINE_BUDGET);
    for (const s of skills) expect(block).toContain(`- ${s.name}`);
    expect(block).toContain("Root: /repo/skills/");
    expect(block).toContain("Root: /home/u/.infinibot/skills/browser/");
    expect(block).toContain("- skill-number-7 [dir: odd-folder]");
    expect(block).toContain("/state/skills-index/full.xml");
  });
});
