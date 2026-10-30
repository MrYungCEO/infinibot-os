/**
 * Identity framing.
 *
 * The regression these lock: the workspace's SOUL/IDENTITY/USER files were
 * appended under "# Project Context" AFTER the prompt had opened with "You are
 * a personal assistant running inside InfiniBot", and were hedged with "unless
 * higher-priority instructions override it". The declared identity therefore
 * sat below, and explicitly subordinate to, generic product framing.
 */

import { describe, expect, it } from "vitest";

import {
  buildIdentityFrame,
  isIdentityContextFile,
  selectIdentityFiles,
} from "./identity-frame.js";

const file = (path: string, content: string) => ({ path, content });

const SOUL = file("/w/SOUL.md", "# SOUL.md\n\nI speak with unfiltered flame.");
const IDENTITY = file("/w/IDENTITY.md", "# IDENTITY.md\n\n- **Name:** Nova");
const USER = file("/w/USER.md", "# USER.md\n\n- **Name:** Example User");
const TOOLS = file("/w/TOOLS.md", "# TOOLS.md\n\nuse the read tool");

describe("buildIdentityFrame", () => {
  it("returns null when the workspace declares no identity", () => {
    // A default install must be completely unaffected.
    expect(buildIdentityFrame({ contextFiles: [TOOLS] })).toBeNull();
    expect(buildIdentityFrame({ contextFiles: [] })).toBeNull();
  });

  it("opens with the identity and carries its content verbatim", () => {
    const frame = buildIdentityFrame({ contextFiles: [TOOLS, USER, SOUL, IDENTITY] })!;
    expect(frame.startsWith("# Who is speaking")).toBe(true);
    expect(frame).toContain("I speak with unfiltered flame.");
    expect(frame).toContain("Example User");
  });

  it("never hedges the identity as overridable", () => {
    const frame = buildIdentityFrame({ contextFiles: [SOUL] })!;
    expect(frame).not.toMatch(/unless higher-priority instructions override/i);
    expect(frame).toMatch(/this identity wins/i);
  });

  it("does not frame it as a character to perform", () => {
    const frame = buildIdentityFrame({ contextFiles: [SOUL] })!;
    expect(frame).toMatch(/not a persona to perform/i);
  });

  it("keeps safety and honesty binding", () => {
    // Identity governs voice and stance, never the operational constraints.
    const frame = buildIdentityFrame({ contextFiles: [SOUL] })!;
    expect(frame).toMatch(/still bind/i);
    expect(frame).toMatch(/certainty, memories or capabilities you do not have/i);
  });

  it("demotes a task persona to a role beneath the identity", () => {
    const frame = buildIdentityFrame({
      contextFiles: [SOUL],
      role: "You are AnKHu AI, the assistant for a historical research OS.",
    })!;
    expect(frame.indexOf("unfiltered flame")).toBeLessThan(frame.indexOf("AnKHu AI"));
    expect(frame).toMatch(/role you are filling right now/i);
  });

  it("orders soul, then identity, then user", () => {
    const picked = selectIdentityFiles([USER, IDENTITY, SOUL]).map((f) => f.path);
    expect(picked).toEqual(["/w/SOUL.md", "/w/IDENTITY.md", "/w/USER.md"]);
  });

  it("ignores empty identity files rather than opening with nothing", () => {
    expect(buildIdentityFrame({ contextFiles: [file("/w/SOUL.md", "   ")] })).toBeNull();
  });

  it("recognises identity files by base name on either separator", () => {
    expect(isIdentityContextFile({ path: "C:\\\\w\\\\soul.md" })).toBe(true);
    expect(isIdentityContextFile({ path: "/w/TOOLS.md" })).toBe(false);
  });
});
