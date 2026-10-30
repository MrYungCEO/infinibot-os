import { describe, expect, it, vi } from "vitest";
import { agentIdFromSessionKey, chatCallButtonState, chatCallFailure, isMainSessionKey, resolveCallTarget, sessionLabel } from "./call-target";
import { robovoiceConnectionUrl } from "./call-session";

describe("call target (which chat a call is bound to)", () => {
  it("derives the agent from agent:<id>:… session keys", () => {
    expect(agentIdFromSessionKey("agent:main:webchat:xyz")).toBe("main");
    expect(agentIdFromSessionKey("agent:ops:main")).toBe("ops");
    expect(agentIdFromSessionKey("agent:main")).toBeNull();
    expect(agentIdFromSessionKey("webchat:xyz")).toBeNull();
    expect(agentIdFromSessionKey("")).toBeNull();
    expect(agentIdFromSessionKey(undefined)).toBeNull();
  });

  it("resolveCallTarget: session-only surfaces get the agent from the key", () => {
    expect(resolveCallTarget({ sessionKey: "agent:ops:webchat:1" })).toEqual({ agentId: "ops", sessionKey: "agent:ops:webchat:1" });
    expect(resolveCallTarget({ agentId: "ops", sessionKey: "agent:ops:grid:p2" })).toEqual({ agentId: "ops", sessionKey: "agent:ops:grid:p2" });
  });

  it("resolveCallTarget: no session → the agent (or fallback) on its main session", () => {
    expect(resolveCallTarget({})).toEqual({ agentId: "main" });
    expect(resolveCallTarget({ agentId: "coder" })).toEqual({ agentId: "coder" });
    expect(resolveCallTarget({}, "ops")).toEqual({ agentId: "ops" });
  });

  it("resolveCallTarget: a key that belongs to another agent is dropped (never write into another agent's chat)", () => {
    expect(resolveCallTarget({ agentId: "main", sessionKey: "agent:ops:webchat:1" })).toEqual({ agentId: "main" });
  });

  it("isMainSessionKey", () => {
    expect(isMainSessionKey("agent:main:main")).toBe(true);
    expect(isMainSessionKey("agent:main:webchat:x")).toBe(false);
    expect(isMainSessionKey("agent:ops:main", "main")).toBe(false);
    expect(isMainSessionKey(null)).toBe(true);
  });

  it("sessionLabel shows the part after the agent, or a known title", () => {
    expect(sessionLabel("agent:main:webchat:xyz")).toBe("webchat:xyz");
    expect(sessionLabel("agent:main:webchat:xyz", { "agent:main:webchat:xyz": "Launch plan" })).toBe("Launch plan");
    expect(sessionLabel(null)).toBe("main");
  });

  it("connection-details URL carries the url-encoded sessionKey only when bound", () => {
    expect(robovoiceConnectionUrl("main", "http://gw")).toBe("http://gw/plugins/robovoice/connection-details?agent=main");
    expect(robovoiceConnectionUrl("main", "", "agent:main:webchat:x y")).toBe(
      "/plugins/robovoice/connection-details?agent=main&sessionKey=agent%3Amain%3Awebchat%3Ax%20y",
    );
  });

  it("chat call button: this chat's call vs another chat's call", () => {
    expect(chatCallButtonState("agent:main:webchat:a", null)).toBe("idle");
    expect(chatCallButtonState("agent:main:webchat:a", { phase: "ended", sessionKey: "agent:main:webchat:a" })).toBe("idle");
    expect(chatCallButtonState("agent:main:webchat:a", { phase: "active", agentId: "main", sessionKey: "agent:main:webchat:a" })).toBe("this-call");
    expect(chatCallButtonState("agent:main:webchat:b", { phase: "active", agentId: "main", sessionKey: "agent:main:webchat:a" })).toBe("other-call");
    // An unbound call is the agent's main session.
    expect(chatCallButtonState("agent:main:main", { phase: "connecting", agentId: "main", sessionKey: null })).toBe("this-call");
    expect(chatCallButtonState("agent:main:webchat:a", { phase: "connecting", agentId: "main", sessionKey: null })).toBe("other-call");
  });
});

describe("chat call failure (no silent fallback to idle)", () => {
  const sk = "agent:coder:webchat-abc";
  it("a failed start from THIS chat is shown with a readable reason", () => {
    const call = { phase: "failed", agentId: "coder", sessionKey: sk, error: 'InfiniBot agent "coder" is not linked to a character' };
    expect(chatCallFailure(sk, call)).toMatch(/no Robovoice voice yet/);
    expect(chatCallButtonState(sk, call)).toBe("idle");
  });
  it("another chat's failure, a live call, or no error are not this chat's failure", () => {
    expect(chatCallFailure("agent:coder:other", { phase: "failed", agentId: "coder", sessionKey: sk, error: "x" })).toBeNull();
    expect(chatCallFailure(sk, { phase: "active", agentId: "coder", sessionKey: sk })).toBeNull();
    expect(chatCallFailure(sk, null)).toBeNull();
    expect(chatCallFailure(sk, { phase: "failed", agentId: "coder", sessionKey: sk, error: "boom" })).toBe("Call failed: boom");
  });
});

describe("fetchRobovoiceConnection", () => {
  it("requests connection-details with the session key", async () => {
    const { fetchRobovoiceConnection } = await import("./call-session");
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ serverUrl: "wss://lk", participantToken: "t", roomName: "r" }) }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await fetchRobovoiceConnection("main", "http://gw", "agent:main:webchat:xyz");
      expect(fetchMock).toHaveBeenCalledWith("http://gw/plugins/robovoice/connection-details?agent=main&sessionKey=agent%3Amain%3Awebchat%3Axyz");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("link enforcement errors on the chat call button", () => {
  const fail = (error: string) => chatCallFailure("agent:main:main", { phase: "failed", agentId: "main", sessionKey: "agent:main:main", error });
  it("maps the gateway's link refusals to one actionable line", () => {
    expect(fail("Connect Robovoice first: voice runs on your own Robovoice organization")).toBe("Connect Robovoice on the Voice page to call.");
    expect(fail('Agent "main" has no Robovoice voice in Org yet')).toMatch(/no Robovoice voice yet/);
    expect(fail("Character magnus isn't one of Org's agents at this location")).toMatch(/isn't in your Robovoice organization/);
    // Cloud voice is free: a legacy credit refusal or the fair-use cap reads as busy, never a top-up.
    expect(fail("This account is out of Robovoice credit. Top up at https://robovoice.io/settings/billing")).toMatch(/cloud voice is busy.*switch to local voice/i);
    expect(fail("Cloud voice is busy right now. Switch to local voice to keep talking.")).toMatch(/switch to local voice/i);
    expect(fail("Cloud voice is busy right now. Switch to local voice to keep talking.")).not.toMatch(/top up|wallet|credit/i);
  });
});
