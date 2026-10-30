import { describe, expect, it } from "vitest";
import { QUICKSTART_HTML } from "./quickstart-ui.js";

describe("quickstart UI copy for npm installs", () => {
  it("lists Ollama Cloud among the first provider cards (visible without scrolling)", () => {
    const start = QUICKSTART_HTML.indexOf("const PROV_CATALOG = [");
    expect(start).toBeGreaterThan(-1);
    const ids = [...QUICKSTART_HTML.slice(start).matchAll(/\{ id: "([a-z-]+)",/g)].map((m) => m[1]);
    expect(ids.indexOf("ollama-cloud")).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf("ollama-cloud")).toBeLessThan(6);
  });

  it("does not tell users to run pnpm while building the control UI", () => {
    expect(QUICKSTART_HTML).not.toContain("Running <code>pnpm ui:build</code>");
    expect(QUICKSTART_HTML).not.toContain("pnpm infinibot");
  });
});
