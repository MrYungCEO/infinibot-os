import { describe, expect, it, vi } from "vitest";
import { SETUP_AREAS, describeApply, paramForStep, patchConfigLive, stepFromParam, summarizeSetup } from "./setup-areas";

describe("stepFromParam (/setup?step=…)", () => {
  it("maps every area's own name and the friendly aliases", () => {
    expect(stepFromParam("voice")).toBe("voice");
    expect(stepFromParam("brain")).toBe("model");
    expect(stepFromParam("AI")).toBe("model");
    expect(stepFromParam("goals")).toBe("usecases");
    expect(stepFromParam("remote")).toBe("phone");
    expect(stepFromParam("secure")).toBe("privacy");
    expect(stepFromParam("plugins")).toBe("recommend");
    expect(stepFromParam("plan")).toBe("recommend");
  });

  it("ignores unknown or empty values and the finish step", () => {
    expect(stepFromParam(null)).toBeNull();
    expect(stepFromParam("")).toBeNull();
    expect(stepFromParam("finish")).toBeNull();
    expect(stepFromParam("../../etc")).toBeNull();
  });

  it("round-trips every area through its URL name", () => {
    for (const a of SETUP_AREAS) expect(stepFromParam(paramForStep(a.id))).toBe(a.id);
  });
});

describe("patchConfigLive", () => {
  it("patches with restart:auto and reports a hot change as live", async () => {
    const rpc = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === "config.get") return { hash: "h1" };
      expect(params).toMatchObject({ baseHash: "h1", restart: "auto" });
      expect(JSON.parse(String(params?.raw))).toEqual({ channels: { discord: { botToken: "x" } } });
      return { reload: { restartRequired: false, restartReasons: [] } };
    });
    const r = await patchConfigLive(rpc as never, { channels: { discord: { botToken: "x" } } });
    expect(r).toEqual({ restartRequired: false, reasons: [], legacy: false });
    expect(describeApply(r, "Saved")).toBe("Saved. Applied live, no restart needed.");
  });

  it("says plainly when the change still needs a restart", async () => {
    const rpc = vi.fn(async (method: string) =>
      method === "config.get" ? { hash: "h" } : { reload: { restartRequired: true, restartReasons: ["plugins.entries.flypic.enabled"] } },
    );
    const r = await patchConfigLive(rpc as never, { plugins: { entries: { flypic: { enabled: true } } } });
    expect(r.restartRequired).toBe(true);
    expect(describeApply(r, "Saved")).toMatch(/restarts for a few seconds.*plugins\.entries\.flypic\.enabled/);
  });

  it("falls back to a plain config.patch on an older gateway", async () => {
    const calls: Array<Record<string, unknown> | undefined> = [];
    const rpc = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === "config.get") return { hash: "h" };
      calls.push(params);
      if (params?.restart) throw new Error("invalid config.patch params: at root: unexpected property 'restart'");
      return { ok: true, restart: { ok: true } };
    });
    const r = await patchConfigLive(rpc as never, { voice: { backend: "auto" } });
    expect(calls).toHaveLength(2);
    expect(calls[1]).not.toHaveProperty("restart");
    expect(r).toEqual({ restartRequired: true, reasons: [], legacy: true });
  });

  it("does not retry on a real error (bad hash, invalid config)", async () => {
    const rpc = vi.fn(async (method: string) => {
      if (method === "config.get") return { hash: "h" };
      throw new Error("config changed since last load; re-run config.get");
    });
    await expect(patchConfigLive(rpc as never, { a: 1 })).rejects.toThrow(/config changed/);
    expect(rpc).toHaveBeenCalledTimes(2);
  });
});

describe("browser + AI apps areas", () => {
  it("deep-links ?step=browser / chrome / mcp", () => {
    expect(stepFromParam("browser")).toBe("browser");
    expect(stepFromParam("chrome")).toBe("browser");
    expect(stepFromParam("mcp")).toBe("aiapps");
    expect(stepFromParam("kv")).toBe("kinglyvault");
    expect(paramForStep("aiapps")).toBe("mcp");
  });

  it("summarizes paired-but-closed Chrome and no apps", () => {
    const rows = Object.fromEntries(
      summarizeSetup({ browser: { paired: true, connected: false }, aiapps: { added: [] } }).map((r) => [r.id, r]),
    );
    expect(rows.browser).toMatchObject({ value: "Paired, Chrome not open right now", state: "off" });
    expect(rows.aiapps).toMatchObject({ value: "Not added to any app yet", state: "off" });
  });
});

describe("summarizeSetup", () => {
  const byId = (rows: ReturnType<typeof summarizeSetup>) => Object.fromEntries(rows.map((r) => [r.id, r]));

  it("shows the current value of every area", () => {
    const rows = byId(
      summarizeSetup({
        useCases: ["content", "coding"],
        brain: { primary: "ollama/llama3.2", account: null },
        channels: { telegram: { configured: true }, discord: { configured: false } },
        channelLabels: { telegram: "Telegram" },
        voice: { backend: "auto", ttsReachable: true },
        phone: { url: "https://box.tail1.ts.net:8454", tailscale: true },
        browser: { paired: true, connected: true, name: "Main" },
        aiapps: { added: ["Claude Code", "Cursor"] },
        kinglyvault: { connected: true, account: "o****@gmail.com" },
        secure: { enabled: true, available: true },
        plugins: { enabled: ["flypic", "discipline"], names: { flypic: "FlyPic", discipline: "Discipline" } },
      }),
    );
    expect(Object.keys(rows)).toEqual(SETUP_AREAS.map((a) => a.id));
    expect(rows.kinglyvault!.value).toBe("Connected as o****@gmail.com");
    expect(rows.usecases!.value).toMatch(/Content/i);
    expect(rows.model!.value).toBe("ollama/llama3.2");
    expect(rows.channels!.value).toBe("This app + Telegram");
    expect(rows.voice!.value).toBe("Local voice, running");
    expect(rows.phone!.value).toBe("box.tail1.ts.net:8454");
    expect(rows.browser!.value).toBe("Chrome connected (Main)");
    expect(rows.aiapps!.value).toBe("Added to Claude Code, Cursor");
    expect(rows.privacy!.value).toBe("Secure Mode on");
    expect(rows.recommend!.value).toBe("2 on: FlyPic, Discipline");
    expect(Object.values(rows).every((r) => r.state === "ok")).toBe(true);
  });

  it("prefers the connected subscription account for the brain and names cloud voice", () => {
    const rows = byId(summarizeSetup({ brain: { primary: "x/y", account: "ChatGPT account" }, voice: { backend: "robovoice" } }));
    expect(rows.model!.value).toBe("Your ChatGPT account");
    expect(rows.voice!.value).toBe("Cloud voice (Robovoice)");
  });

  it("says 'couldn't read' instead of guessing when an RPC failed", () => {
    const rows = byId(summarizeSetup({}));
    expect(rows.model!.state).toBe("unknown");
    expect(rows.privacy!.value).toMatch(/Couldn't read/);
    expect(rows.recommend!.state).toBe("unknown");
  });

  it("marks areas that are off", () => {
    const rows = byId(
      summarizeSetup({
        useCases: [],
        channels: {},
        voice: { choice: "later" },
        phone: { url: null, tailscale: false },
        secure: { enabled: false, available: true },
        plugins: { enabled: [] },
      }),
    );
    expect(rows.usecases!.value).toBe("General (nothing picked)");
    expect(rows.channels!.value).toBe("This app only");
    expect(rows.voice!.value).toBe("Off (set up later)");
    expect(rows.phone!.value).toBe("Off (Tailscale not installed)");
    expect(rows.privacy!.state).toBe("off");
    expect(rows.recommend!.value).toBe("No plugins on");
  });
});
