import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  onboardingProfileHandlers,
  profilePath,
  readProfile,
  sanitizeProfile,
} from "./onboarding-profile.js";

type Reply = { ok: boolean; payload?: unknown; error?: { code: string; message: string } };

async function call(method: string, params: Record<string, unknown> = {}): Promise<Reply> {
  let reply: Reply = { ok: false };
  await onboardingProfileHandlers[method]!({
    params,
    respond: (ok: boolean, payload?: unknown, error?: { code: string; message: string }) => {
      reply = { ok, payload, error };
    },
  } as never);
  return reply;
}

describe("onboarding.profile RPCs", () => {
  let dir: string;
  let prev: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ib-onb-profile-"));
    prev = process.env.INFINIBOT_STATE_DIR;
    process.env.INFINIBOT_STATE_DIR = dir;
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.INFINIBOT_STATE_DIR;
    else process.env.INFINIBOT_STATE_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns null before anything is saved", async () => {
    const res = await call("onboarding.profile.get");
    expect(res.ok).toBe(true);
    expect(res.payload).toEqual({ profile: null });
  });

  it("saves and reads back a sanitised profile in the state dir", async () => {
    const set = await call("onboarding.profile.set", {
      profile: {
        useCases: ["business", "content", "business", "<script>"],
        courses: ["chat-models", "projects"],
        plugins: ["business-agency"],
        agents: [],
        voice: "local",
        secureMode: true,
        updatedAt: 42,
        extra: "dropped",
      },
    });
    expect(set.ok).toBe(true);
    expect(fs.existsSync(profilePath(dir))).toBe(true);
    const got = await call("onboarding.profile.get");
    expect(got.payload).toEqual({
      profile: {
        useCases: ["business", "content"],
        courses: ["chat-models", "projects"],
        plugins: ["business-agency"],
        agents: [],
        voice: "local",
        secureMode: true,
        updatedAt: 42,
        completedAt: null,
      },
    });
    expect(readProfile(dir)?.useCases).toEqual(["business", "content"]);
  });

  it("rejects non-objects and oversized payloads", async () => {
    expect((await call("onboarding.profile.set", { profile: "nope" })).error?.code).toBe("INVALID_PARAMS");
    expect((await call("onboarding.profile.set", {})).error?.code).toBe("INVALID_PARAMS");
    const big = { useCases: Array.from({ length: 3000 }, (_, i) => `id-${i}`) };
    expect((await call("onboarding.profile.set", { profile: big })).error?.code).toBe("INVALID_PARAMS");
  });

  it("sanitizeProfile drops unknown voice values and caps list length", () => {
    const p = sanitizeProfile({ useCases: Array.from({ length: 60 }, (_, i) => `u${i}`), voice: "loud" }, 7)!;
    expect(p.useCases).toHaveLength(40);
    expect(p.voice).toBeUndefined();
    expect(p.updatedAt).toBe(7);
  });
});
