import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  applySetupStatus,
  clearSetupSnoozes,
  initNavSetupStatus,
  onSetupGatewayHello,
  isSetupCheckSnoozed,
  isSetupHighlightEnabled,
  navSetupCountFor,
  navSetupFor,
  resetNavSetupStatusForTests,
  setSetupHighlightEnabled,
  setupActionHref,
  setupChecksForPage,
  setupHint,
  snoozeSetupCheck,
  type SetupCheck,
} from "./nav-setup-status";

const inbox: SetupCheck = {
  id: "core.inbox",
  source: "core",
  title: "Email account",
  tabs: ["inbox"],
  state: "needs-setup",
  reason: "No email account connected.",
  action: { label: "Connect email", tab: "inbox" },
};
const keys: SetupCheck = {
  id: "core.models",
  source: "core",
  title: "Model provider",
  tabs: ["apikeys", "webchat"],
  state: "error",
  reason: "The Anthropic key was rejected.",
  action: { label: "Fix API key", tab: "apikeys" },
  priority: 100,
};
const coders: SetupCheck = {
  id: "core.coders",
  source: "core",
  title: "Coding agent",
  tabs: ["coders"],
  state: "optional",
  reason: "No coding agent installed.",
  action: { label: "Install a coder", tab: "setup", view: "coders" },
};
const ready: SetupCheck = { ...inbox, id: "core.channels", tabs: ["channels"], state: "ready", reason: "" };

function fakeClient(result: unknown) {
  const handlers: Array<(evt: { event: string; payload?: unknown }) => void> = [];
  return {
    request: vi.fn(async () => result),
    subscribe: (h: (evt: { event: string; payload?: unknown }) => void) => {
      handlers.push(h);
      return () => handlers.splice(handlers.indexOf(h), 1);
    },
    emit: (event: string, payload?: unknown) => handlers.forEach((h) => h({ event, payload })),
  };
}

describe("nav setup status", () => {
  beforeEach(() => {
    localStorage.clear();
    resetNavSetupStatusForTests();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("maps checks onto sidebar entries; ready checks never glow", () => {
    applySetupStatus({ checks: [inbox, keys, ready] });
    expect(navSetupFor("inbox")?.state).toBe("needs-setup");
    expect(navSetupFor("webchat")?.state).toBe("error");
    expect(navSetupFor("channels")).toBeNull();
    expect(navSetupFor("dashboard")).toBeNull();
  });

  it("a merged sub-tab lights up its host entry (coders → Setup)", () => {
    applySetupStatus({ checks: [coders] });
    expect(navSetupFor("setup")?.primary.id).toBe("core.coders");
    expect(setupChecksForPage("setup").map((c) => c.id)).toEqual(["core.coders"]);
  });

  it("error outranks needs-setup, then priority", () => {
    applySetupStatus({ checks: [inbox, { ...keys, tabs: ["inbox"] }] });
    const e = navSetupFor("inbox")!;
    expect(e.state).toBe("error");
    expect(e.primary.id).toBe("core.models");
    expect(setupHint(e)).toBe("Setup problem: The Anthropic key was rejected. (+1 more)");
  });

  it("group count ignores optional checks", () => {
    applySetupStatus({ checks: [inbox, keys, coders] });
    expect(navSetupCountFor(["inbox", "webchat", "setup", "dashboard"])).toBe(2);
  });

  it("drops malformed checks from the payload", () => {
    applySetupStatus({ checks: [inbox, { id: "x", state: "weird", tabs: ["inbox"] }, null, { state: "error" }] });
    expect(navSetupFor("inbox")?.checks).toHaveLength(1);
  });

  it("the Appearance toggle turns glows off (default on) and persists", () => {
    applySetupStatus({ checks: [inbox] });
    expect(isSetupHighlightEnabled()).toBe(true);
    setSetupHighlightEnabled(false);
    expect(localStorage.getItem("infinibot-nav-setup-highlight")).toBe("off");
    expect(navSetupFor("inbox")).toBeNull();
    expect(navSetupCountFor(["inbox"])).toBe(0);
    // The page banner still explains the page.
    expect(setupChecksForPage("inbox")).toHaveLength(1);
    setSetupHighlightEnabled(true);
    expect(localStorage.getItem("infinibot-nav-setup-highlight")).toBeNull();
    expect(navSetupFor("inbox")).not.toBeNull();
  });

  it("only optional checks can be dismissed or snoozed; both persist", () => {
    applySetupStatus({ checks: [inbox, coders] });
    expect(snoozeSetupCheck("core.inbox")).toBe(false);
    expect(navSetupFor("inbox")).not.toBeNull();

    const now = 1_000_000;
    expect(snoozeSetupCheck("core.coders", 60_000, now)).toBe(true);
    expect(isSetupCheckSnoozed("core.coders", now + 1)).toBe(true);
    expect(isSetupCheckSnoozed("core.coders", now + 60_001)).toBe(false);
    expect(JSON.parse(localStorage.getItem("infinibot-nav-setup-snooze")!)).toEqual({ "core.coders": now + 60_000 });

    snoozeSetupCheck("core.coders"); // dismiss for good
    expect(navSetupFor("setup")).toBeNull();
    clearSetupSnoozes();
    expect(navSetupFor("setup")).not.toBeNull();
  });

  it("survives broken or unavailable storage", () => {
    localStorage.setItem("infinibot-nav-setup-snooze", "{not json");
    applySetupStatus({ checks: [coders] });
    expect(navSetupFor("setup")).not.toBeNull();
    const orig = localStorage.getItem;
    localStorage.getItem = () => {
      throw new Error("SecurityError");
    };
    try {
      expect(isSetupHighlightEnabled()).toBe(true);
      expect(navSetupFor("setup")).not.toBeNull();
    } finally {
      localStorage.getItem = orig;
    }
  });

  it("builds action hrefs with sub-views and base paths", () => {
    expect(setupActionHref({ label: "x", tab: "setup", view: "coders" })).toBe("/setup?view=coders");
    expect(setupActionHref({ label: "x", tab: "inbox" }, "/ui")).toBe("/ui/inbox");
    expect(setupActionHref({ label: "x", href: "https://example.com" })).toBe("https://example.com");
  });

  it("one fetch, then live updates from setup.status pushes (no polling)", async () => {
    vi.useFakeTimers();
    const client = fakeClient({ checks: [inbox] });
    const onChange = vi.fn();
    initNavSetupStatus(client as never, onChange);
    await vi.runAllTimersAsync();
    expect(client.request).toHaveBeenCalledTimes(1);
    expect(client.request).toHaveBeenCalledWith("setup.status", {});
    expect(navSetupFor("inbox")).not.toBeNull();

    // Setup completed elsewhere → the gateway pushes the new snapshot.
    client.emit("setup.status", { checks: [{ ...inbox, state: "ready", reason: "" }] });
    expect(navSetupFor("inbox")).toBeNull();
    expect(onChange).toHaveBeenCalled();

    // Idempotent for the same client; nothing polls.
    initNavSetupStatus(client as never, onChange);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(client.request).toHaveBeenCalledTimes(1);

    // Relevant events (plugin toggles, reconnect hello) → one debounced refetch.
    client.emit("plugins.changed");
    client.emit("coders:progress");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(client.request).toHaveBeenCalledTimes(2);
  });

  it("an unreachable/older gateway leaves nothing glowing", async () => {
    const client = fakeClient(undefined);
    client.request.mockRejectedValueOnce(new Error("unknown method: setup.status"));
    initNavSetupStatus(client as never, () => {});
    await Promise.resolve();
    await Promise.resolve();
    expect(navSetupFor("inbox")).toBeNull();
  });

  it("first fetch racing the socket recovers on the gateway hello (and after restarts)", async () => {
    vi.useFakeTimers();
    const client = fakeClient({ checks: [inbox] });
    client.request.mockRejectedValueOnce(new Error("gateway not connected"));
    initNavSetupStatus(client as never, () => {});
    await vi.runAllTimersAsync();
    expect(navSetupFor("inbox")).toBeNull();
    onSetupGatewayHello(client as never);
    await vi.advanceTimersByTimeAsync(300);
    expect(client.request).toHaveBeenCalledTimes(2);
    expect(navSetupFor("inbox")?.state).toBe("needs-setup");
  });
});
