import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadInfiniBotPlugins } from "./loader.js";
import { loadPluginManifest } from "./manifest.js";
import { PLUGIN_API_VERSION, parseManifestV2, satisfiesRange } from "./manifest-v2.js";
import { resolvePluginMethodScope, setActivePluginRegistry } from "./runtime.js";
import { setPluginEnabledInConfig } from "../gateway/server-methods/plugins.js";

const SCHEMA = { type: "object", additionalProperties: false, properties: {} };
const tempDirs: string[] = [];

function tempDir() {
  const dir = path.join(os.tmpdir(), `infinibot-plugin-v2-${randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

function v2Manifest(id: string, extra: Record<string, unknown> = {}) {
  return {
    manifestVersion: 2,
    id,
    configSchema: SCHEMA,
    engines: { "infinibot-plugin-api": "^2.0.0" },
    contributes: {
      nav: [{ tab: `${id}-page`, label: "Demo", group: "Agents" }],
      pages: [{ tab: `${id}-page`, route: `/${id}`, builtin: id }],
      rpc: [
        { method: `${id}.list`, scope: "read" },
        { method: `${id}.run`, scope: "write" },
      ],
      http: [`/plugins/${id}/asset.js`],
    },
    permissions: { network: ["api.example.com"] },
    ...extra,
  };
}

function writeV2Plugin(
  id: string,
  body: string,
  manifest: Record<string, unknown> = v2Manifest(id),
) {
  const dir = tempDir();
  const file = path.join(dir, `${id}.js`);
  fs.writeFileSync(file, body, "utf-8");
  fs.writeFileSync(path.join(dir, "infinibot.plugin.json"), JSON.stringify(manifest), "utf-8");
  return file;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("satisfiesRange", () => {
  it("handles caret, tilde, comparators and OR", () => {
    expect(satisfiesRange("2.0.0", "^2.0.0")).toBe(true);
    expect(satisfiesRange("2.5.1", "^2.0.0")).toBe(true);
    expect(satisfiesRange("3.0.0", "^2.0.0")).toBe(false);
    expect(satisfiesRange("0.2.9", "^0.2.0")).toBe(true);
    expect(satisfiesRange("0.3.0", "^0.2.0")).toBe(false);
    expect(satisfiesRange("2.1.4", "~2.1.0")).toBe(true);
    expect(satisfiesRange("2.2.0", "~2.1.0")).toBe(false);
    expect(satisfiesRange("2.0.0", ">=1.5.0 <3")).toBe(true);
    expect(satisfiesRange("3.1.0", "^1.0.0 || ^3.0.0")).toBe(true);
    expect(satisfiesRange("2.0.0", "*")).toBe(true);
    expect(satisfiesRange("garbage", "^2.0.0")).toBe(false);
  });
  it("host API version satisfies the bundled range", () => {
    expect(satisfiesRange(PLUGIN_API_VERSION, "^2.0.0")).toBe(true);
  });
});

describe("parseManifestV2", () => {
  it("parses a complete manifest", () => {
    const res = parseManifestV2("demo", v2Manifest("demo"));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.fields.contributes.rpc).toEqual([
      { method: "demo.list", scope: "read" },
      { method: "demo.run", scope: "write" },
    ]);
    expect(res.fields.permissions.network).toEqual(["api.example.com"]);
    expect(res.fields.permissions.exec).toBe(false);
  });

  it("accepts scoped legacy RPC aliases on a canonical plugin method", () => {
    const manifest = v2Manifest("demo") as any;
    manifest.contributes.rpc[0].aliases = ["legacy.list"];
    const res = parseManifestV2("demo", manifest);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.fields.contributes.rpc[0]?.aliases).toEqual(["legacy.list"]);
  });

  it("allows an explicitly declared RPC namespace for a hyphenated plugin id", () => {
    const manifest = v2Manifest("part-scan", {
      rpcNamespace: "partscan",
      contributes: { rpc: [{ method: "partscan.list", scope: "read" }] },
    });
    const res = parseManifestV2("part-scan", manifest);
    expect(res.ok, res.ok ? "" : res.error).toBe(true);
    if (!res.ok) return;
    expect(res.fields.rpcNamespace).toBe("partscan");
    expect(res.fields.contributes.rpc).toEqual([{ method: "partscan.list", scope: "read" }]);
  });

  it.each([
    ["missing engines", { engines: {} }, "infinibot-plugin-api"],
    [
      "un-namespaced rpc",
      { contributes: { rpc: [{ method: "chat.send" }] } },
      'namespaced "demo.*"',
    ],
    ["http outside plugin prefix", { contributes: { http: ["/api/steal"] } }, "/plugins/demo/"],
    ["nav without page", { contributes: { nav: [{ tab: "x", label: "X" }] } }, "no matching"],
    [
      "page without builtin/entry",
      { contributes: { pages: [{ tab: "x", route: "/x" }] } },
      "builtin or entry",
    ],
    ["bad scope", { contributes: { rpc: [{ method: "demo.x", scope: "root" }] } }, "unknown scope"],
    [
      "navSection item without page",
      {
        contributes: {
          ...v2Manifest("demo").contributes,
          navSection: { items: [{ page: "nope" }] },
        },
      },
      'navSection item "nope" has no matching',
    ],
    [
      "navSection non-numeric order",
      { contributes: { ...v2Manifest("demo").contributes, navSection: { order: "1" } } },
      "order must be a number",
    ],
    [
      "navSection not an object",
      { contributes: { ...v2Manifest("demo").contributes, navSection: [] } },
      "navSection must be an object",
    ],
    [
      "duplicate rpc alias",
      {
        contributes: {
          rpc: [
            { method: "demo.x", aliases: ["legacy.x"] },
            { method: "demo.y", aliases: ["legacy.x"] },
          ],
        },
      },
      "duplicate rpc method or alias",
    ],
    [
      "selfAuthHttp not declared in http",
      { contributes: { http: ["/plugins/demo/a"], selfAuthHttp: ["/plugins/demo/b"] } },
      "must also be listed in contributes.http",
    ],
  ])("rejects %s", (_name, override, message) => {
    const res = parseManifestV2("demo", { ...v2Manifest("demo"), ...override });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain(message);
  });

  it("parses an optional contributes.navSection", () => {
    const base = v2Manifest("demo");
    const res = parseManifestV2("demo", {
      ...base,
      contributes: {
        ...base.contributes,
        navSection: {
          title: "Demo Suite",
          order: 5,
          collapsedByDefault: true,
          items: [{ page: "demo-page", label: "Home", icon: "home" }],
        },
      },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.fields.contributes.navSection).toEqual({
      title: "Demo Suite",
      order: 5,
      collapsedByDefault: true,
      items: [{ page: "demo-page", label: "Home", icon: "home" }],
    });
    // Absent → no key at all (the default section is derived in the UI).
    const plain = parseManifestV2("demo", v2Manifest("demo"));
    expect(plain.ok && "navSection" in plain.fields.contributes).toBe(false);
  });

  it("keeps self-authenticated routes (subset of http)", () => {
    const res = parseManifestV2("demo", {
      ...v2Manifest("demo"),
      contributes: {
        http: ["/plugins/demo/hook", "/plugins/demo/ui"],
        selfAuthHttp: ["/plugins/demo/hook"],
      },
    });
    expect(res.ok && res.fields.contributes.selfAuthHttp).toEqual(["/plugins/demo/hook"]);
    const none = parseManifestV2("demo", v2Manifest("demo"));
    expect(none.ok && none.fields.contributes.selfAuthHttp).toBeUndefined();
  });

  it("loadPluginManifest rejects unknown manifestVersion and keeps v1 untouched", () => {
    const dir = tempDir();
    fs.writeFileSync(
      path.join(dir, "infinibot.plugin.json"),
      JSON.stringify({ id: "x", configSchema: SCHEMA, manifestVersion: 3 }),
    );
    expect(loadPluginManifest(dir).ok).toBe(false);
    fs.writeFileSync(
      path.join(dir, "infinibot.plugin.json"),
      JSON.stringify({ id: "x", configSchema: SCHEMA }),
    );
    const v1 = loadPluginManifest(dir);
    expect(v1.ok && v1.manifest.v2).toBeUndefined();
  });

  it("the bundled infinicode manifest is a valid v2 manifest", () => {
    const res = loadPluginManifest(path.resolve(__dirname, "../../extensions/infinicode"));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.manifest.v2?.contributes.pages[0]).toMatchObject({
      tab: "inficode",
      builtin: "inficode",
    });
    // 8 push/fleet/command methods + 3 push-token methods (HTTPS push for InfiniBot Cloud).
    expect(res.manifest.v2?.contributes.rpc).toHaveLength(11);
    expect(res.manifest.v2?.contributes.selfAuthHttp).toEqual([
      "/plugins/infinicode/push",
      "/plugins/infinicode/node/commands",
    ]);
  });

  it("the bundled Products manifest declares both sub-views and compatibility aliases", () => {
    const res = loadPluginManifest(path.resolve(__dirname, "../../extensions/products"));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.manifest.v2?.contributes.pages.map((p) => p.tab)).toEqual([
      "products",
      "product-portfolio",
    ]);
    expect(
      res.manifest.v2?.contributes.rpc.find((r) => r.method === "products.portfolio.list")?.aliases,
    ).toEqual(["product.list"]);
  });
});

describe("loader: v2 declared capabilities", () => {
  const body = (id: string) => `export default { id: "${id}", register(api) {
    api.registerGatewayMethod("${id}.list", ({ respond }) => respond(true, {}));
    api.registerGatewayMethod("${id}.run", ({ respond }) => respond(true, {}));
    api.registerGatewayMethod("${id}.sneaky", ({ respond }) => respond(true, {}));
    api.registerHttpRoute({ path: "/plugins/${id}/asset.js", handler: () => {} });
    api.registerHttpRoute({ path: "/plugins/${id}/undeclared", handler: () => {} });
    api.registerHttpHandler(() => false);
  } };`;

  it("registers declared methods/routes only and records contributions", () => {
    const file = writeV2Plugin("demo", body("demo"));
    const registry = loadInfiniBotPlugins({
      cache: false,
      config: { plugins: { load: { paths: [file] } } },
    });
    const rec = registry.plugins.find((p) => p.id === "demo");
    expect(rec?.status).toBe("loaded");
    expect(rec?.manifestVersion).toBe(2);
    expect(rec?.gatewayMethods.sort()).toEqual(["demo.list", "demo.run"]);
    expect(Object.keys(registry.gatewayHandlers)).not.toContain("demo.sneaky");
    expect(registry.httpRoutes.map((r) => r.path)).toEqual(["/plugins/demo/asset.js"]);
    expect(registry.httpHandlers).toHaveLength(0);
    const messages = registry.diagnostics.map((d) => d.message).join("\n");
    expect(messages).toContain("not declared in manifest contributes.rpc: demo.sneaky");
    expect(messages).toContain(
      "not declared in manifest contributes.http: /plugins/demo/undeclared",
    );
    expect(messages).toContain("registerHttpHandler");
  });

  it("exposes declared RPC scopes only while the plugin is loaded", () => {
    const file = writeV2Plugin("scoped", body("scoped"));
    const registry = loadInfiniBotPlugins({
      cache: false,
      config: { plugins: { load: { paths: [file] } } },
    });
    setActivePluginRegistry(registry);
    expect(resolvePluginMethodScope("scoped.list")).toBe("read");
    expect(resolvePluginMethodScope("scoped.run")).toBe("write");
    expect(resolvePluginMethodScope("scoped.sneaky")).toBeUndefined();

    const disabled = loadInfiniBotPlugins({
      cache: false,
      config: { plugins: { load: { paths: [file] }, entries: { scoped: { enabled: false } } } },
    });
    setActivePluginRegistry(disabled);
    const rec = disabled.plugins.find((p) => p.id === "scoped");
    expect(rec?.status).toBe("disabled");
    // Contributions stay visible for the Plugins page, but nothing is served.
    expect(rec?.contributes?.nav).toHaveLength(1);
    expect(Object.keys(disabled.gatewayHandlers)).not.toContain("scoped.list");
    expect(resolvePluginMethodScope("scoped.list")).toBeUndefined();
  });

  it("registers a declared alias and gives it the canonical scope", () => {
    const manifest = v2Manifest("aliased") as any;
    manifest.contributes.rpc[0].aliases = ["old.list"];
    const file = writeV2Plugin(
      "aliased",
      `export default { id: "aliased", register(api) {
        api.registerGatewayMethod("aliased.list", ({ respond }) => respond(true, {}));
        api.registerGatewayMethod("old.list", ({ respond }) => respond(true, {}));
        api.registerGatewayMethod("aliased.run", ({ respond }) => respond(true, {}));
        api.registerHttpRoute({ path: "/plugins/aliased/asset.js", handler: () => {} });
      } };`,
      manifest,
    );
    const registry = loadInfiniBotPlugins({
      cache: false,
      config: { plugins: { load: { paths: [file] } } },
    });
    setActivePluginRegistry(registry);
    expect(Object.keys(registry.gatewayHandlers)).toContain("old.list");
    expect(resolvePluginMethodScope("old.list")).toBe("read");
  });

  it("refuses to load a plugin whose API range excludes this host", () => {
    const manifest = { ...v2Manifest("future"), engines: { "infinibot-plugin-api": "^9.0.0" } };
    const file = writeV2Plugin("future", body("future"), manifest);
    const registry = loadInfiniBotPlugins({
      cache: false,
      config: { plugins: { load: { paths: [file] } } },
    });
    const rec = registry.plugins.find((p) => p.id === "future");
    expect(rec?.status).toBe("error");
    expect(rec?.error).toContain("requires plugin API ^9.0.0");
    expect(Object.keys(registry.gatewayHandlers)).not.toContain("future.list");
  });
});

describe("setPluginEnabledInConfig", () => {
  it("sets the entry flag without dropping existing config", () => {
    const next = setPluginEnabledInConfig(
      { plugins: { entries: { infinicode: { config: { a: 1 } } as never } } },
      "infinicode",
      true,
    );
    expect(next.plugins?.entries?.infinicode).toEqual({ config: { a: 1 }, enabled: true });
  });
  it("adds the id to a non-empty allowlist when enabling", () => {
    const next = setPluginEnabledInConfig({ plugins: { allow: ["other"] } }, "infinicode", true);
    expect(next.plugins?.allow).toEqual(["other", "infinicode"]);
    const off = setPluginEnabledInConfig({ plugins: { allow: ["other"] } }, "infinicode", false);
    expect(off.plugins?.allow).toEqual(["other"]);
  });
});
