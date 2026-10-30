import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resolveStateDir,
  resolveSharedDir,
  setCurrentUserId,
  getCurrentUserId,
  DEFAULT_USER_ID,
} from "../config/paths.js";
import {
  listProfiles,
  createProfile,
  switchProfile,
  deleteProfile,
  profileDataDir,
  initCurrentUserFromRegistry,
} from "./profiles.js";

let tmp: string;
const origEnv = process.env.INFINIBOT_STATE_DIR;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ib-profiles-"));
  process.env.INFINIBOT_STATE_DIR = tmp;
  setCurrentUserId(DEFAULT_USER_ID);
});

afterEach(() => {
  if (origEnv === undefined) delete process.env.INFINIBOT_STATE_DIR;
  else process.env.INFINIBOT_STATE_DIR = origEnv;
  setCurrentUserId(DEFAULT_USER_ID);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("profiles + per-user state dir", () => {
  it("default user resolves to the shared root (no migration)", () => {
    setCurrentUserId(DEFAULT_USER_ID);
    expect(resolveStateDir()).toBe(resolveSharedDir());
  });

  it("seeds a default profile registry", () => {
    const { profiles, currentUserId } = listProfiles();
    expect(currentUserId).toBe(DEFAULT_USER_ID);
    expect(profiles.some((p) => p.id === DEFAULT_USER_ID)).toBe(true);
  });

  it("creates a profile with its own data dir under users/<id>", () => {
    const p = createProfile({ name: "Alice", avatar: "🦊" });
    expect(p.id).not.toBe(DEFAULT_USER_ID);
    const dir = profileDataDir(p.id);
    expect(dir.startsWith(path.join(resolveSharedDir(), "users"))).toBe(true);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it("switching re-points resolveStateDir but keeps shared dir constant", () => {
    const p = createProfile({ name: "Bob" });
    const sharedBefore = resolveSharedDir();
    switchProfile(p.id);
    expect(getCurrentUserId()).toBe(p.id);
    expect(resolveStateDir()).toBe(profileDataDir(p.id));
    // Shared services root is unchanged across the switch.
    expect(resolveSharedDir()).toBe(sharedBefore);
  });

  it("cannot delete the default or active profile", () => {
    expect(() => deleteProfile(DEFAULT_USER_ID)).toThrow();
    const p = createProfile({ name: "Carol" });
    switchProfile(p.id);
    expect(() => deleteProfile(p.id)).toThrow();
  });

  it("initCurrentUserFromRegistry honors INFINIBOT_USER_ID override", () => {
    const id = initCurrentUserFromRegistry({
      ...process.env,
      INFINIBOT_USER_ID: "someone",
    } as NodeJS.ProcessEnv);
    expect(id).toBe("someone");
    expect(getCurrentUserId()).toBe("someone");
  });
});
