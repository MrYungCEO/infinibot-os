import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { mintInvite, parseDurationToHours } from "./federation-invite.js";
import { decodeInvite, inviteFingerprint } from "../../federation/invite.js";

describe("parseDurationToHours", () => {
  it("parses days/hours/minutes/weeks", () => {
    expect(parseDurationToHours("30d", 1)).toBe(720);
    expect(parseDurationToHours("12h", 1)).toBe(12);
    expect(parseDurationToHours("60m", 1)).toBe(1);
    expect(parseDurationToHours("2w", 1)).toBe(336);
    expect(parseDurationToHours(undefined, 7)).toBe(7);
  });
  it("throws on garbage", () => {
    expect(() => parseDurationToHours("abc", 1)).toThrow(/invalid duration/);
  });
});

describe("mintInvite", () => {
  let tmpDir: string;
  let prevStateDir: string | undefined;
  let prevConfigPath: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "infinibot-invite-test-"));
    prevStateDir = process.env.INFINIBOT_STATE_DIR;
    prevConfigPath = process.env.INFINIBOT_CONFIG_PATH;
    process.env.INFINIBOT_STATE_DIR = tmpDir;
    process.env.INFINIBOT_CONFIG_PATH = path.join(tmpDir, "infinibot.json");
    // Disable config cache so the test-only env var takes effect.
    process.env.INFINIBOT_DISABLE_CONFIG_CACHE = "1";
  });
  afterEach(() => {
    process.env.INFINIBOT_STATE_DIR = prevStateDir;
    process.env.INFINIBOT_CONFIG_PATH = prevConfigPath;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("mints a decodable invite with matching fingerprint", () => {
    const result = mintInvite({ label: "test-host", expires: "1h" });
    const decoded = decodeInvite(result.encoded);
    expect(decoded.label).toBe("test-host");
    expect(decoded.satelliteToken.satelliteId).toBe(result.invite.satelliteIdHint);
    expect(inviteFingerprint(decoded)).toBe(result.fingerprint);
  });

  it("appends a record to the on-disk store", () => {
    const result = mintInvite({ label: "audit-host", expires: "1h" });
    const storeFile = path.join(tmpDir, "federation-invites.json");
    expect(fs.existsSync(storeFile)).toBe(true);
    const records = JSON.parse(fs.readFileSync(storeFile, "utf-8"));
    expect(Array.isArray(records)).toBe(true);
    expect(records[0].fingerprint).toBe(result.fingerprint);
    expect(records[0].label).toBe("audit-host");
    expect(records[0].redeemedAt).toBeNull();
  });

  it("auto-generates a satellite id when not provided", () => {
    const a = mintInvite({ expires: "1h" });
    const b = mintInvite({ expires: "1h" });
    expect(a.invite.satelliteIdHint).toMatch(/^node_/);
    expect(a.invite.satelliteIdHint).not.toBe(b.invite.satelliteIdHint);
  });
});
