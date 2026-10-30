import { afterEach, describe, expect, it } from "vitest";
import { createAgentTools } from "./agent-tools.js";
import { configureLocalCanvasBridge } from "./gateway-bridge.js";

describe("Whiteboard agent tools", () => {
  afterEach(() => configureLocalCanvasBridge(null));

  it("broadcasts in-process mutations through the gateway bridge", async () => {
    const scenes: unknown[][] = [];
    configureLocalCanvasBridge({
      update: (elements) => scenes.push(elements),
      view: () => undefined,
      clear: () => undefined,
    });
    const tool = createAgentTools().find((entry) => entry.name === "excalidraw_create_element");
    expect(tool).toBeDefined();
    await tool!.execute("test-call", { type: "rectangle", x: 10, y: 20, text: "Plugin" });
    expect(scenes).toHaveLength(1);
    expect(scenes[0].some((element: any) => element.type === "rectangle")).toBe(true);
    expect(scenes[0].some((element: any) => element.type === "text")).toBe(true);
  });
});
