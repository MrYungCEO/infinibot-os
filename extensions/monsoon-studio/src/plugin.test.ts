import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseManifestV2 } from "../../../src/plugins/manifest-v2.js";
import { createAgentTools } from "./agent-tools.js";
import { STUDIO_TOOLS, StudioClient } from "./client.js";
import { DEFAULT_STUDIO_URL, readStudioConfig } from "./config.js";
import { createStudioHandlers } from "./rpc.js";

const manifest = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../infinibot.plugin.json"), "utf8")) as Record<string, any>;
const config = () => readStudioConfig({ studioUrl: "http://studio.test/", timeoutMs: 5000 });
const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("monsoon-studio plugin", () => {
  it("manifest parses and declares exactly the 26 vendored studio tools", () => {
    const res = parseManifestV2("monsoon-studio", manifest);
    expect(res.ok, res.ok ? "" : res.error).toBe(true);
    expect(STUDIO_TOOLS).toHaveLength(26);
    expect(manifest.contributes.tools.map((t: { name: string }) => t.name).sort()).toEqual(STUDIO_TOOLS.map((t) => t.name).sort());
    for (const rpc of manifest.contributes.rpc) expect(rpc.method.startsWith("monsoon-studio.")).toBe(true);
  });

  it("reads config with safe defaults", () => {
    expect(readStudioConfig(undefined)).toEqual({ studioUrl: DEFAULT_STUDIO_URL, timeoutMs: 180_000 });
    expect(readStudioConfig({ studioUrl: "javascript:alert(1)", timeoutMs: 5 })).toEqual({ studioUrl: DEFAULT_STUDIO_URL, timeoutMs: 180_000 });
    expect(readStudioConfig({ studioUrl: "http://host:9/" }).studioUrl).toBe("http://host:9");
  });

  it("proxies agent tools to POST /api/tools/<name>", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ id: "p1", title: "Guide" }));
    const tools = createAgentTools(new StudioClient(config, fetchImpl as typeof fetch));
    expect(tools).toHaveLength(26);
    const create = tools.find((t) => t.name === "studio_create_project")!;
    const result = await create.execute("call-1", { title: "Guide" });
    expect(fetchImpl).toHaveBeenCalledWith("http://studio.test/api/tools/studio_create_project", expect.objectContaining({ method: "POST", body: JSON.stringify({ title: "Guide" }) }));
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({ id: "p1", title: "Guide" });
  });

  it("surfaces studio errors, unknown tools and an unreachable server clearly", async () => {
    const failing = new StudioClient(config, (async () => jsonResponse({ error: "project_not_found" }, 400)) as typeof fetch);
    await expect(failing.call("studio_load_project", { projectId: "x" })).rejects.toThrow("studio_load_project failed: project_not_found");
    await expect(failing.call("rm_rf", {})).rejects.toThrow("Unknown studio tool");
    const down = new StudioClient(config, (async () => { throw new TypeError("fetch failed"); }) as typeof fetch);
    await expect(down.call("studio_list_projects")).rejects.toThrow("systemctl --user start monsoon-studio");
    expect(await down.health()).toMatchObject({ ok: false, url: "http://studio.test", error: "fetch failed" });
  });

  it("status RPC reports health", async () => {
    const client = new StudioClient(config, (async () => jsonResponse({ ok: true, service: "monsoon-studio", tools: 26 })) as typeof fetch);
    const respond = vi.fn();
    await createStudioHandlers(client)["monsoon-studio.status"]!({ params: {}, respond } as never);
    expect(respond).toHaveBeenCalledWith(true, expect.objectContaining({ ok: true, tools: 26, declaredTools: 26, url: "http://studio.test" }));
  });
});
