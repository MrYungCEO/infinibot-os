/**
 * Host API v0 additions for first-party plugins (Infinitrade): declared agent
 * tools, chat panel kinds, legacy RPC aliases and gated permissions.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { chatPanelHandlers } from "../gateway/server-methods/chat-panel.js";
import { loadInfiniBotPlugins } from "./loader.js";
import { parseManifestV2 } from "./manifest-v2.js";
import {
  getPluginPanelKinds,
  resolvePluginMethodScope,
  setActivePluginRegistry,
} from "./runtime.js";
import type { PluginRegistry } from "./registry.js";

const SCHEMA = { type: "object", additionalProperties: false, properties: {} };
const tempDirs: string[] = [];

function manifest(
  id: string,
  contributes: Record<string, unknown> = {},
  permissions: Record<string, unknown> = {},
) {
  return {
    manifestVersion: 2,
    id,
    configSchema: SCHEMA,
    engines: { "infinibot-plugin-api": "^2.0.0" },
    contributes: {
      rpc: [
        { method: `${id}.data`, scope: "read" },
        { method: `${id}.write`, scope: "write" },
      ],
      rpcAliases: [
        { method: "legacy.data", target: `${id}.data` },
        { method: "taken.method", target: `${id}.data` },
      ],
      tools: [`${id}_tool`],
      panels: [`${id}.summary`],
      ...contributes,
    },
    permissions,
  };
}

function writePlugin(id: string, body: string, m: Record<string, unknown> = manifest(id)) {
  const dir = path.join(os.tmpdir(), `infinibot-plugin-v2c-${randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  const file = path.join(dir, `${id}.js`);
  fs.writeFileSync(file, body, "utf-8");
  fs.writeFileSync(path.join(dir, "infinibot.plugin.json"), JSON.stringify(m), "utf-8");
  return file;
}

const emptyRegistry = (): PluginRegistry => ({
  plugins: [],
  tools: [],
  hooks: [],
  typedHooks: [],
  channels: [],
  providers: [],
  gatewayHandlers: {},
  httpHandlers: [],
  httpRoutes: [],
  cliRegistrars: [],
  services: [],
  commands: [],
  panelKinds: [],
  diagnostics: [],
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  setActivePluginRegistry(emptyRegistry());
});

describe("parseManifestV2: tools, panels, aliases, gated permissions", () => {
  it("parses the new contribution fields; aliases inherit their target's scope", () => {
    const res = parseManifestV2(
      "demo",
      manifest("demo", {}, { gated: [{ id: "orders", label: "Place orders" }] }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.fields.contributes.tools).toEqual(["demo_tool"]);
    expect(res.fields.contributes.panels).toEqual(["demo.summary"]);
    expect(res.fields.contributes.rpcAliases[0]).toEqual({
      method: "legacy.data",
      target: "demo.data",
      scope: "read",
    });
    expect(res.fields.permissions.gated).toEqual([
      { id: "orders", label: "Place orders", description: undefined },
    ]);
  });

  it.each([
    [
      "alias to an undeclared target",
      { rpcAliases: [{ method: "old.x", target: "demo.nope" }] },
      "undeclared method",
    ],
    [
      "alias inside the plugin namespace",
      { rpcAliases: [{ method: "demo.alias", target: "demo.data" }] },
      "already in the plugin namespace",
    ],
    ["un-namespaced panel kind", { panels: ["summary"] }, 'namespaced "demo.*"'],
  ])("rejects %s", (_n, contributes, message) => {
    const res = parseManifestV2("demo", manifest("demo", contributes));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain(message);
  });

  it("rejects a gated permission without a label", () => {
    const res = parseManifestV2("demo", manifest("demo", {}, { gated: [{ id: "orders" }] }));
    expect(res.ok).toBe(false);
  });
});

describe("loader: declared tools, panel kinds and aliases", () => {
  const body = (id: string) => `export default { id: "${id}", register(api) {
    api.registerGatewayMethod("${id}.data", ({ respond }) => respond(true, { rows: [1, 2] }));
    api.registerGatewayMethod("${id}.write", ({ respond }) => respond(true, {}));
    api.registerTool({ name: "${id}_tool", description: "d", parameters: {}, execute: async () => ({}) });
    api.registerTool({ name: "${id}_sneaky_tool", description: "d", parameters: {}, execute: async () => ({}) });
    const kind = (id, methods) => ({ id, title: "T", description: "d", queryHelp: "query: {}", refreshMs: 0, methods,
      resolve: async (_q, call) => { const r = await call(methods[0], {}); return { data: r, summary: "ok " + r.rows.length, count: r.rows.length, empty: false }; },
      toText: () => "text", link: () => ({ tab: "${id}", label: "Open" }) });
    api.registerPanelKind(kind("${id}.summary", ["${id}.data"]));
    api.registerPanelKind(kind("${id}.undeclared", ["${id}.data"]));
  } };`;

  it("registers only declared tools, wires aliases without shadowing core methods", () => {
    const file = writePlugin("demo", body("demo"));
    const registry = loadInfiniBotPlugins({
      cache: false,
      coreGatewayHandlers: { "taken.method": () => {} },
      config: { plugins: { load: { paths: [file] } } },
    });
    expect(registry.tools.filter((t) => t.pluginId === "demo").flatMap((t) => t.names)).toEqual([
      "demo_tool",
    ]);
    expect(registry.plugins.find((p) => p.id === "demo")?.gatewayMethods.sort()).toEqual([
      "demo.data",
      "demo.write",
      "legacy.data",
    ]);
    expect(Object.keys(registry.gatewayHandlers)).not.toContain("taken.method");
    expect(registry.gatewayHandlers["legacy.data"]).toBe(registry.gatewayHandlers["demo.data"]);
    expect((registry.panelKinds ?? []).map((p) => p.def.id)).toEqual(["demo.summary"]);
    const messages = registry.diagnostics.map((d) => d.message).join("\n");
    expect(messages).toContain("tool not declared in manifest contributes.tools: demo_sneaky_tool");
    expect(messages).toContain(
      "panel kind not declared in manifest contributes.panels: demo.undeclared",
    );
    expect(messages).toContain("rpc alias taken.method skipped: method already registered");

    setActivePluginRegistry(registry);
    expect(resolvePluginMethodScope("legacy.data")).toBe("read");
    expect(resolvePluginMethodScope("taken.method")).toBeUndefined();
  });

  it("rejects a panel kind that calls a write-scoped method", () => {
    const m = manifest("wr", { panels: ["wr.summary"] });
    const file = writePlugin(
      "wr",
      `export default { id: "wr", register(api) {
        api.registerGatewayMethod("wr.data", ({ respond }) => respond(true, {}));
        api.registerGatewayMethod("wr.write", ({ respond }) => respond(true, {}));
        api.registerPanelKind({ id: "wr.summary", title: "T", description: "d", queryHelp: "", refreshMs: 0, methods: ["wr.write"],
          resolve: async () => ({ data: {}, summary: "", count: 0, empty: true }), toText: () => "", link: () => ({ tab: "", label: "" }) });
      } };`,
      m,
    );
    const registry = loadInfiniBotPlugins({
      cache: false,
      config: { plugins: { load: { paths: [file] } } },
    });
    expect(registry.panelKinds ?? []).toHaveLength(0);
    expect(registry.diagnostics.map((d) => d.message).join("\n")).toContain("read-scoped rpc");
  });

  it("chat.panel.* resolve plugin kinds through the plugin's own handlers, and drop them when disabled", async () => {
    const file = writePlugin("pk", body("pk"));
    const registry = loadInfiniBotPlugins({
      cache: false,
      config: { plugins: { load: { paths: [file] } } },
    });
    setActivePluginRegistry(registry);
    const call = (method: string, params: Record<string, unknown>) =>
      new Promise<{
        ok: boolean;
        payload: Record<string, unknown> | undefined;
        err?: { message?: string };
      }>((resolve) => {
        void chatPanelHandlers[method]({
          req: { type: "req", id: "1", method, params },
          params,
          client: null,
          isWebchatConnect: () => false,
          respond: (ok: boolean, payload?: unknown, err?: { message?: string }) =>
            resolve({ ok, payload: payload as Record<string, unknown>, err }),
          context: { broadcast: () => {} },
        } as never);
      });
    const kinds = await call("chat.panel.kinds", {});
    expect((kinds.payload?.kinds as Array<{ id: string }>).map((k) => k.id)).toContain(
      "pk.summary",
    );
    const r = await call("chat.panel.resolve", { kind: "pk.summary" });
    expect(r.ok).toBe(true);
    expect(r.payload).toMatchObject({ kind: "pk.summary", summary: "ok 2", error: null });

    const disabled = loadInfiniBotPlugins({
      cache: false,
      config: { plugins: { load: { paths: [file] }, entries: { pk: { enabled: false } } } },
    });
    setActivePluginRegistry(disabled);
    expect(getPluginPanelKinds()).toHaveLength(0);
    const gone = await call("chat.panel.resolve", { kind: "pk.summary" });
    expect(gone.ok).toBe(false);
  });
});
