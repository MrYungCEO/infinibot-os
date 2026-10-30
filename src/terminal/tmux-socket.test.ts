import path from "node:path";
import { describe, expect, it } from "vitest";

import { resolveTmuxSocketName } from "./tmux-socket.js";

describe("resolveTmuxSocketName", () => {
  it("keeps the historic socket for the default state directory", () => {
    expect(resolveTmuxSocketName("/home/alice/.infinibot", () => "/home/alice")).toBe("infinibot");
  });

  it("isolates custom state directories with stable socket names", () => {
    const first = resolveTmuxSocketName("/srv/infinibot/team-a", () => "/home/alice");
    const again = resolveTmuxSocketName(
      path.join("/srv/infinibot", ".", "team-a"),
      () => "/home/alice",
    );
    const second = resolveTmuxSocketName("/srv/infinibot/team-b", () => "/home/alice");

    expect(first).toMatch(/^infinibot-[a-f0-9]{12}$/);
    expect(again).toBe(first);
    expect(second).not.toBe(first);
    expect(second).not.toBe("infinibot");
  });
});
