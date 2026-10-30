import { describe, expect, it } from "vitest";

import {
  coerceSemver,
  compareSemver,
  hostSatisfiesMin,
  isNewerVersion,
  isValidSemver,
  parseSemverStrict,
} from "./semver.js";

describe("plugin package semver", () => {
  it("accepts strict semver, including InfiniBot calver", () => {
    for (const v of [
      "0.1.0",
      "1.2.3",
      "2026.9.28",
      "1.0.0-beta.1",
      "1.0.0+build.5",
      "1.0.0-rc.1+sha.abc",
    ]) {
      expect(isValidSemver(v), v).toBe(true);
    }
  });

  it("rejects loose versions", () => {
    for (const v of ["1", "1.2", "v1.2.3", "1.2.3.4", "01.2.3", "1.2.3-", "latest", "", " "]) {
      expect(isValidSemver(v), v).toBe(false);
    }
    expect(isValidSemver(undefined)).toBe(false);
    expect(parseSemverStrict("1.02.3")).toBeNull();
  });

  it("orders versions by semver precedence", () => {
    const sorted = [
      "1.0.0",
      "1.0.0-alpha",
      "1.0.0-alpha.1",
      "1.0.0-beta",
      "1.0.0-rc.1",
      "0.9.9",
      "1.0.1",
      "1.10.0",
      "1.2.0",
      "1.0.0-alpha.beta",
      "1.0.0-beta.11",
      "1.0.0-beta.2",
    ].sort(compareSemver);
    expect(sorted).toEqual([
      "0.9.9",
      "1.0.0-alpha",
      "1.0.0-alpha.1",
      "1.0.0-alpha.beta",
      "1.0.0-beta",
      "1.0.0-beta.2",
      "1.0.0-beta.11",
      "1.0.0-rc.1",
      "1.0.0",
      "1.0.1",
      "1.2.0",
      "1.10.0",
    ]);
    expect(compareSemver("1.0.0+a", "1.0.0+b")).toBe(0);
    expect(() => compareSemver("1.0", "1.0.0")).toThrow(/invalid semver/);
  });

  it("isNewerVersion never treats an invalid candidate as newer", () => {
    expect(isNewerVersion("1.1.0", "1.0.0")).toBe(true);
    expect(isNewerVersion("1.0.0", "1.0.0")).toBe(false);
    expect(isNewerVersion("0.9.0", "1.0.0")).toBe(false);
    expect(isNewerVersion("banana", "1.0.0")).toBe(false);
    expect(isNewerVersion(undefined, "1.0.0")).toBe(false);
    expect(isNewerVersion("1.0.0", undefined)).toBe(true);
  });

  it("gates on minHostVersion and fails closed on garbage", () => {
    expect(hostSatisfiesMin("2026.6.30", undefined)).toBe(true);
    expect(hostSatisfiesMin("2026.6.30", "2026.6.30")).toBe(true);
    expect(hostSatisfiesMin("2026.6.30", "2026.6.0")).toBe(true);
    expect(hostSatisfiesMin("2026.6.30", "2026.7.0")).toBe(false);
    expect(hostSatisfiesMin("2026.6.30", "2027.1.0")).toBe(false);
    expect(hostSatisfiesMin("2026.6.30", "soon")).toBe(false);
    expect(hostSatisfiesMin("dev", "1.0.0")).toBe(false);
    expect(coerceSemver("v2026.6")).toBe("2026.6.0");
  });
});
