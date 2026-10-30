import { describe, it, expect } from "vitest";
import { buildProfileContextBlock } from "./profile-context.js";
import type { Profile } from "./profiles.js";

/** Minimal valid Profile with no operator-context fields set. */
function baseProfile(over: Partial<Profile> = {}): Profile {
  return {
    id: "usr_test",
    name: "Bee",
    avatar: "👤",
    theme: "system",
    createdAt: 0,
    ...over,
  };
}

describe("buildProfileContextBlock", () => {
  it("renders every section when all fields are set", () => {
    const block = buildProfileContextBlock(
      baseProfile({
        role: "Running Example Studio",
        preferredLanguage: "th",
        secondaryLanguage: "en",
        skillLevel: "beginner",
        goals: "Learn to ship features\nUnderstand the codebase",
        projectContext: "Profiles + operator notes",
        communicationStyle: "explain concepts before jargon",
        notes: "Prefers Thai\nNew to coding",
      }),
    );

    expect(block).toContain("USER CONTEXT");
    expect(block).toContain("Name: Bee");
    expect(block).toContain("Role: Running Example Studio");
    expect(block).toContain("Languages: th (primary) + en (secondary)");
    expect(block).toContain("Skill level: beginner");
    expect(block).toContain("Goals:");
    expect(block).toContain("  Learn to ship features");
    expect(block).toContain("  Understand the codebase");
    expect(block).toContain("Current focus:");
    expect(block).toContain("  Profiles + operator notes");
    expect(block).toContain("Communication style: explain concepts before jargon");
    expect(block).toContain("Operator notes:");
    expect(block).toContain("  Prefers Thai");
    expect(block).toContain("  New to coding");
  });

  it("renders only the populated sections when half the fields are set", () => {
    const block = buildProfileContextBlock(
      baseProfile({
        role: "Operator",
        preferredLanguage: "en",
        // no secondary → single-language form
        goals: "Ship the thing",
        // no skillLevel / projectContext / communicationStyle / notes
      }),
    );

    expect(block).toContain("USER CONTEXT");
    expect(block).toContain("Name: Bee");
    expect(block).toContain("Role: Operator");
    expect(block).toContain("Languages: en (primary)");
    expect(block).not.toContain("(secondary)");
    expect(block).toContain("Goals:");
    expect(block).toContain("  Ship the thing");
    // omitted sections must not appear
    expect(block).not.toContain("Skill level:");
    expect(block).not.toContain("Current focus:");
    expect(block).not.toContain("Communication style:");
    expect(block).not.toContain("Operator notes:");
  });

  it("returns an empty string when no operator-context fields are set", () => {
    // Name/avatar/theme alone must NOT trigger injection.
    expect(buildProfileContextBlock(baseProfile())).toBe("");
  });

  it("returns an empty string for null / undefined profiles", () => {
    expect(buildProfileContextBlock(null)).toBe("");
    expect(buildProfileContextBlock(undefined)).toBe("");
  });

  it("renders a secondary-only language as (secondary)", () => {
    const block = buildProfileContextBlock(baseProfile({ secondaryLanguage: "en" }));
    expect(block).toContain("Languages: en (secondary)");
    expect(block).not.toContain("(primary)");
  });
});
