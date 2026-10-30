import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// voice.setup.brain reads and writes infinibot.json; keep it in memory here.
let fileConfig: Record<string, unknown> = {};
let written: Record<string, unknown> | null = null;
vi.mock("../../config/io.js", () => ({
  readConfigFileSnapshot: async () => ({ parsed: structuredClone(fileConfig), valid: true }),
  writeConfigFile: async (cfg: Record<string, unknown>) => {
    written = cfg;
  },
}));

const { voiceSetupHandlers } = await import("./voice-setup.js");
const { validateConfigObject } = await import("../../config/validation.js");

async function callBrain(params: Record<string, unknown>) {
  let reply: { ok: boolean; payload?: unknown; error?: unknown } | null = null;
  await voiceSetupHandlers["voice.setup.brain"]!({
    params,
    respond: (ok: boolean, payload?: unknown, error?: unknown) => {
      reply = { ok, payload, error };
    },
  } as never);
  return reply!;
}

describe("voice.setup.brain (ollama)", () => {
  beforeEach(() => {
    written = null;
    // Ollama answers /api/tags with two installed models.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ models: [{ name: "llama3.2" }, { name: "qwen3:8b" }] }), {
            status: 200,
          }),
      ),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("writes a valid provider block on a fresh config (model definitions, not bare names)", async () => {
    fileConfig = { gateway: { mode: "local" } };
    const res = await callBrain({ provider: "ollama", modelId: "qwen3:8b" });
    expect(res.ok).toBe(true);
    const cfg = written as { agents: any; models: any };
    expect(cfg.agents.defaults.model.primary).toBe("ollama/qwen3:8b");
    const ollama = cfg.models.providers.ollama;
    expect(ollama.baseUrl).toMatch(/\/v1$/);
    expect(ollama.models.map((m: { id: string }) => m.id)).toEqual(["llama3.2", "qwen3:8b"]);
    for (const m of ollama.models) expect(typeof m).toBe("object");
    const v = validateConfigObject(cfg as never);
    expect(v.ok ? [] : v.issues).toEqual([]);
  });

  it("repairs bare-name entries an older build wrote and keeps the user's baseUrl", async () => {
    fileConfig = {
      models: {
        providers: { ollama: { baseUrl: "http://10.0.0.5:11434/v1", models: ["llama3.2"] } },
      },
      agents: { defaults: { model: { primary: "ollama/llama3.2", fallbacks: ["x/y"] } } },
    };
    const res = await callBrain({ provider: "ollama", modelId: "mistral" });
    expect(res.ok).toBe(true);
    const cfg = written as { agents: any; models: any };
    expect(cfg.models.providers.ollama.baseUrl).toBe("http://10.0.0.5:11434/v1");
    expect(cfg.models.providers.ollama.models.map((m: { id: string }) => m.id)).toEqual([
      "llama3.2",
      "mistral",
    ]);
    expect(cfg.agents.defaults.model).toEqual({ primary: "ollama/mistral", fallbacks: ["x/y"] });
    const v = validateConfigObject(cfg as never);
    expect(v.ok ? [] : v.issues).toEqual([]);
  });
});
