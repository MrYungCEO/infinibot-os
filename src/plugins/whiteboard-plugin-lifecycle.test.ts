// Hands jiti the in-process plugin SDK so loading the real plugin stays cheap.
import "../../test/helpers/bundled-plugins.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadInfiniBotPlugins } from "./loader.js";

const extensionsDir = path.resolve(import.meta.dirname, "../../extensions");
const previousBundledDir = process.env.INFINIBOT_BUNDLED_PLUGINS_DIR;
const previousStateDir = process.env.INFINIBOT_STATE_DIR;
let stateDir = "";

beforeEach(() => {
  stateDir = mkdtempSync(path.join(tmpdir(), "whiteboard-plugin-lifecycle-"));
  process.env.INFINIBOT_BUNDLED_PLUGINS_DIR = extensionsDir;
  process.env.INFINIBOT_STATE_DIR = stateDir;
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
  if (previousBundledDir === undefined) delete process.env.INFINIBOT_BUNDLED_PLUGINS_DIR;
  else process.env.INFINIBOT_BUNDLED_PLUGINS_DIR = previousBundledDir;
  if (previousStateDir === undefined) delete process.env.INFINIBOT_STATE_DIR;
  else process.env.INFINIBOT_STATE_DIR = previousStateDir;
});

describe("Whiteboard plugin lifecycle", () => {
  it("is off by default and registers no RPC or agent-tool runtime surface", () => {
    const registry = loadInfiniBotPlugins({
      cache: false,
      config: { plugins: { slots: { memory: "none" } } },
    });
    const whiteboard = registry.plugins.find((plugin) => plugin.id === "whiteboard");
    expect(whiteboard?.status).toBe("disabled");
    expect(whiteboard?.gatewayMethods).toEqual([]);
    expect(
      Object.keys(registry.gatewayHandlers).filter((name) => name.startsWith("whiteboard.")),
    ).toEqual([]);
    expect(registry.tools.filter((tool) => tool.pluginId === "whiteboard")).toEqual([]);
  });

  it("registers its declared RPCs and excalidraw tools only while enabled", () => {
    const enabled = loadInfiniBotPlugins({
      cache: false,
      config: {
        plugins: {
          slots: { memory: "none" },
          entries: { whiteboard: { enabled: true } },
        },
      },
    });
    const loaded = enabled.plugins.find((plugin) => plugin.id === "whiteboard");
    expect(loaded?.status).toBe("loaded");
    expect(loaded?.gatewayMethods).toHaveLength(11);
    expect(loaded?.gatewayMethods.every((name) => name.startsWith("whiteboard."))).toBe(true);
    expect(loaded?.toolNames).toHaveLength(22);
    expect(loaded?.toolNames.every((name) => name.startsWith("excalidraw_"))).toBe(true);

    const disabled = loadInfiniBotPlugins({
      cache: false,
      config: {
        plugins: {
          slots: { memory: "none" },
          entries: { whiteboard: { enabled: false } },
        },
      },
    });
    const off = disabled.plugins.find((plugin) => plugin.id === "whiteboard");
    expect(off?.status).toBe("disabled");
    expect(
      Object.keys(disabled.gatewayHandlers).filter((name) => name.startsWith("whiteboard.")),
    ).toEqual([]);
    expect(disabled.tools.filter((tool) => tool.pluginId === "whiteboard")).toEqual([]);
  });
});
