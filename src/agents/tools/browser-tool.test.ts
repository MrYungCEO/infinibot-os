import { describe, expect, it } from "vitest";

import { BROWSER_TOOL_DESCRIPTION, createBrowserTool, toLegacyParams } from "./browser-tool.js";
import { BROWSER_TOOL_ACTIONS, BrowserToolSchema } from "./browser-tool.schema.js";

function walk(node: unknown, visit: (n: Record<string, unknown>) => void) {
  if (!node || typeof node !== "object") return;
  visit(node as Record<string, unknown>);
  for (const v of Object.values(node as Record<string, unknown>)) walk(v, visit);
}

describe("browser tool schema (local + cloud model friendly)", () => {
  it("is one flat object with a short action list and no unions", () => {
    const schema = JSON.parse(JSON.stringify(BrowserToolSchema)) as Record<string, unknown>;
    expect(schema.type).toBe("object");
    expect(schema.required).toEqual(["action"]);
    let unions = 0;
    let nestedObjects = 0;
    walk(schema.properties, (n) => {
      if (n.anyOf || n.oneOf || n.allOf) unions += 1;
      if (n.type === "object") nestedObjects += 1;
    });
    expect(unions).toBe(0);
    expect(nestedObjects).toBe(0);
    expect(BROWSER_TOOL_ACTIONS.length).toBeLessThanOrEqual(22);
    expect(Object.keys(schema.properties as object).length).toBeLessThanOrEqual(18);
    for (const [name, prop] of Object.entries(
      schema.properties as Record<string, { description?: string }>,
    )) {
      expect(prop.description, `${name} needs a description`).toBeTruthy();
    }
  });

  it("teaches the snapshot → ref loop with few-shot examples", () => {
    expect(BROWSER_TOOL_DESCRIPTION).toMatch(/\[ref=e12\]/);
    const examples = BROWSER_TOOL_DESCRIPTION.split("\n").filter((l) => l.startsWith('{"action"'));
    expect(examples.length).toBeGreaterThanOrEqual(8);
    for (const line of examples) {
      for (const json of line.split(/\s+(?:or|then)\s+/)) {
        const parsed = JSON.parse(json.trim()) as { action: string };
        expect(BROWSER_TOOL_ACTIONS).toContain(parsed.action as never);
      }
    }
    // No more "attach a Chrome tab first" dead end for the default path.
    expect(BROWSER_TOOL_DESCRIPTION).not.toMatch(/ONLY browser automation surface/);
  });

  it("registers as the `browser` tool", () => {
    const tool = createBrowserTool({ agentSessionKey: "agent:main:main" });
    expect(tool.name).toBe("browser");
    expect(tool.parameters).toBe(BrowserToolSchema);
  });
});

describe("federation / sandbox mapping onto the HTTP browser API", () => {
  it("maps the simple actions", () => {
    expect(toLegacyParams({ action: "open", url: "https://a.b", node: "laptop" })).toEqual({
      node: "laptop",
      action: "navigate",
      targetUrl: "https://a.b",
    });
    expect(toLegacyParams({ action: "type", ref: "e3", text: "hi", submit: true })).toMatchObject({
      action: "act",
      request: { kind: "type", ref: "e3", text: "hi", submit: true },
    });
    expect(toLegacyParams({ action: "select", ref: "e9", value: "Billing" })).toMatchObject({
      request: { kind: "select", values: ["Billing"] },
    });
    expect(toLegacyParams({ action: "check", ref: "e4" })).toMatchObject({
      request: { kind: "click", ref: "e4" },
    });
    expect(toLegacyParams({ action: "resize", value: "390x844" })).toMatchObject({
      request: { kind: "resize", width: 390, height: 844 },
    });
    expect(() => toLegacyParams({ action: "tab", index: 2 })).toThrow(
      /not available on federation/,
    );
  });
});
