import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.fn();
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

const { openBrowser, setupBanner } = await import("./setup-ui.js");

describe("setup-ui openBrowser", () => {
  afterEach(() => {
    spawnMock.mockReset();
    vi.restoreAllMocks();
  });

  it("falls back to printing the URL when the opener is missing (ENOENT)", () => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    spawnMock.mockReturnValue(child);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    openBrowser("http://127.0.0.1:18790/#token=abc");
    // Without an 'error' listener this emit throws and crashes the CLI.
    expect(() =>
      child.emit("error", Object.assign(new Error("spawn xdg-open ENOENT"), { code: "ENOENT" })),
    ).not.toThrow();
    expect(log.mock.calls.flat().join("\n")).toContain(
      "Open this URL manually: http://127.0.0.1:18790/#token=abc",
    );
  });
});

describe("setup-ui banner (headless use)", () => {
  it("prints the URL, the one-time token, the port to forward and the TUI fallback", () => {
    const text = setupBanner("http://127.0.0.1:18795/#token=tok123", "tok123").join("\n");
    expect(text).toContain("http://127.0.0.1:18795/#token=tok123");
    expect(text).toContain("One-time setup token: tok123");
    expect(text).toContain("ssh -L 18795:127.0.0.1:18795");
    expect(text).toContain("infinibot onboard");
    expect(text).not.toContain("classic setup page");
  });

  it("says when it falls back to the classic page", () => {
    expect(setupBanner("http://127.0.0.1:18790/#token=t", "t", "legacy").join("\n")).toContain(
      "classic setup page",
    );
  });
});
