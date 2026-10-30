import { describe, expect, it } from "vitest";
import {
  isSecureGroupKey,
  isSecureSessionKey,
  newSecureSessionKey,
  planSecureLaneSwitch,
} from "./session-key";

describe("isSecureSessionKey", () => {
  it("accepts the three secure key shapes", () => {
    expect(isSecureSessionKey("agent:main:secure-abc-123456")).toBe(true);
    expect(isSecureSessionKey("agent:ops:groupchat-sec-xyz")).toBe(true);
    expect(isSecureSessionKey("agent:ops:gcmember-sec-xyz-main")).toBe(true);
  });
  it("accepts nested thread keys under a secure parent", () => {
    expect(isSecureSessionKey("agent:main:subagent:secure-abc:thread:1")).toBe(true);
  });
  it("is case-insensitive like the gateway", () => {
    expect(isSecureSessionKey("Agent:Main:SECURE-abc")).toBe(true);
  });
  it("rejects normal keys and junk", () => {
    expect(isSecureSessionKey("agent:main:webchat-abc")).toBe(false);
    expect(isSecureSessionKey("agent:main:groupchat-abc")).toBe(false);
    expect(isSecureSessionKey("agent:main:gcmember-abc")).toBe(false);
    expect(isSecureSessionKey("agent:main:main")).toBe(false);
    expect(isSecureSessionKey("secure-abc")).toBe(false);
    expect(isSecureSessionKey("")).toBe(false);
    expect(isSecureSessionKey(null)).toBe(false);
    expect(isSecureSessionKey(undefined)).toBe(false);
    // "secure-" must start the rest or follow a colon
    expect(isSecureSessionKey("agent:main:webchat-insecure-x")).toBe(false);
  });
});

describe("isSecureGroupKey", () => {
  it("only matches secure group keys", () => {
    expect(isSecureGroupKey("agent:main:groupchat-sec-1")).toBe(true);
    expect(isSecureGroupKey("agent:main:secure-1")).toBe(false);
    expect(isSecureGroupKey("agent:main:groupchat-1")).toBe(false);
  });
});

describe("newSecureSessionKey", () => {
  it("mints a secure key for the agent", () => {
    const k = newSecureSessionKey("ops", 1_700_000_000_000, 0.5);
    expect(k).toMatch(/^agent:ops:secure-[0-9a-z]+-[0-9a-z]{6}$/);
    expect(isSecureSessionKey(k)).toBe(true);
  });
  it("defaults to main", () => {
    expect(newSecureSessionKey("")).toMatch(/^agent:main:secure-/);
  });
});

describe("planSecureLaneSwitch", () => {
  it("going secure remembers the normal key and reuses the last secure key", () => {
    const p = planSecureLaneSwitch({
      toSecure: true,
      currentKey: "agent:main:webchat-1",
      lastSecureKey: "agent:main:secure-old",
      lastNormalKey: null,
    });
    expect(p).toEqual({ next: "agent:main:secure-old", rememberSecure: "agent:main:secure-old", rememberNormal: "agent:main:webchat-1" });
  });
  it("going secure without a remembered key mints one", () => {
    const p = planSecureLaneSwitch({ toSecure: true, currentKey: null, lastSecureKey: null, lastNormalKey: "agent:main:webchat-0", now: 1, rand: 0 });
    expect(p.next).toMatch(/^agent:main:secure-/);
    expect(p.rememberNormal).toBe("agent:main:webchat-0");
  });
  it("ignores a non-secure value in the secure slot", () => {
    const p = planSecureLaneSwitch({ toSecure: true, currentKey: null, lastSecureKey: "agent:main:webchat-9", lastNormalKey: null });
    expect(isSecureSessionKey(p.next)).toBe(true);
  });
  it("going back returns to the remembered normal key and keeps the secure one", () => {
    const p = planSecureLaneSwitch({
      toSecure: false,
      currentKey: "agent:main:secure-x",
      lastSecureKey: null,
      lastNormalKey: "agent:main:webchat-1",
    });
    expect(p).toEqual({ next: "agent:main:webchat-1", rememberSecure: "agent:main:secure-x", rememberNormal: "agent:main:webchat-1" });
  });
  it("going back never lands on a secure key", () => {
    const p = planSecureLaneSwitch({ toSecure: false, currentKey: "agent:main:secure-x", lastSecureKey: null, lastNormalKey: "agent:main:secure-y" });
    expect(p.next).toBeNull();
  });
});
