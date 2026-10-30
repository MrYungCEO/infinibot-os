import { describe, expect, it } from "vitest";
import type { RuntimeDeps } from "./drivers.js";
import {
  LocalRuntimeError,
  LocalRuntimeManager,
  type SwapLogEntry,
  type SwapProgress,
} from "./manager.js";
import { resolveManagerPolicy, type LocalRuntimeSpec, type ManagerPolicy } from "./registry.js";

const VLLM: LocalRuntimeSpec = {
  id: "vllm-qwen",
  label: "vLLM Qwen3.8-27B",
  kind: "systemd",
  unit: "vllm-qwen.service",
  baseUrl: "http://172.17.0.1:8010/v1",
  healthUrl: "http://172.17.0.1:8010/v1/models",
  providers: ["vllm-local"],
  models: ["qwen3.8-27b"],
  visionModels: [],
  vramMb: 28_000,
  modelVramMb: {},
  startupTimeoutSec: 420,
  etaSec: 90,
  idleStopMinutes: 30,
  startAtBoot: false,
};

const QWEN = "huihui_ai/Qwen3.8-abliterated:latest";

const OLLAMA: LocalRuntimeSpec = {
  id: "ollama",
  label: "Ollama",
  kind: "ollama",
  baseUrl: "http://127.0.0.1:11434",
  healthUrl: "http://127.0.0.1:11434/api/version",
  providers: ["ollama"],
  models: ["*"],
  visionModels: [QWEN],
  vramMb: 20_000,
  modelVramMb: { "nomic-embed-text:latest": 600 },
  startupTimeoutSec: 240,
  etaSec: 40,
  idleStopMinutes: 0,
  startAtBoot: false,
};

/**
 * Simulated host: one 32 GB GPU, speaches holding 2.5 GB (never touched),
 * the vLLM user unit, and an Ollama server. Time is virtual.
 */
class World {
  clock = 1_000_000;
  totalMb = 32_607;
  foreignMb = 2_500; // speaches containers — not ours
  vllm: "inactive" | "activating" | "active" | "failed" = "inactive";
  vllmHealthyAfterPolls = 3;
  vllmFailsToStart = false;
  /** Restart=on-failure loop: stays "activating" with SubState auto-restart. */
  vllmCrashLoop = false;
  private polls = 0;
  ollamaUp = true;
  ollamaLoaded = new Map<string, number>(); // name → MiB
  calls: string[] = [];
  journal = "CUDA error: out of memory";

  usedMb() {
    let used = this.foreignMb;
    if (this.vllm === "active" || this.vllm === "activating") used += 28_000;
    for (const v of this.ollamaLoaded.values()) used += v;
    return used;
  }

  deps(): RuntimeDeps {
    return {
      now: () => this.clock,
      sleep: (ms) =>
        new Promise((r) => {
          this.clock += ms;
          setTimeout(r, 1);
        }),
      exec: async (cmd, args) => {
        this.calls.push(`${cmd} ${args.join(" ")}`);
        if (cmd === "nvidia-smi") {
          const used = this.usedMb();
          return {
            code: 0,
            stdout: `NVIDIA GeForce RTX 5090, ${this.totalMb}, ${used}, ${this.totalMb - used}\n`,
            stderr: "",
          };
        }
        if (cmd === "journalctl") return { code: 0, stdout: this.journal, stderr: "" };
        if (cmd === "systemctl") {
          const verb = args[1];
          if (verb === "show") {
            return {
              code: 0,
              stdout:
                this.vllm === "activating" && this.vllmCrashLoop ? "auto-restart\n" : "running\n",
              stderr: "",
            };
          }
          if (verb === "is-active")
            return { code: this.vllm === "active" ? 0 : 3, stdout: `${this.vllm}\n`, stderr: "" };
          if (verb === "start") {
            if (this.usedMb() + 28_000 > this.totalMb || this.vllmFailsToStart) {
              this.vllm = "activating";
              this.polls = -1000; // never healthy
              setTimeout(() => (this.vllm = "failed"), 3);
            } else {
              this.vllm = "activating";
              this.polls = 0;
            }
            return { code: 0, stdout: "", stderr: "" };
          }
          if (verb === "stop") {
            this.vllm = "inactive";
            return { code: 0, stdout: "", stderr: "" };
          }
        }
        return { code: 1, stdout: "", stderr: `unexpected ${cmd}` };
      },
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const json = (body: unknown, status = 200) =>
          new Response(JSON.stringify(body), {
            status,
            headers: { "content-type": "application/json" },
          });
        if (url.endsWith("/v1/models")) {
          if (this.vllm === "activating") {
            this.polls += 1;
            if (this.polls >= this.vllmHealthyAfterPolls) this.vllm = "active";
            else throw new TypeError("fetch failed");
          }
          if (this.vllm === "active") return json({ data: [{ id: "qwen3.8-27b" }] });
          throw new TypeError("fetch failed");
        }
        if (!this.ollamaUp) throw new TypeError("fetch failed");
        if (url.endsWith("/api/version")) return json({ version: "0.20" });
        if (url.endsWith("/api/ps")) {
          return json({
            models: [...this.ollamaLoaded].map(([name, mb]) => ({
              name,
              size_vram: mb * 1024 * 1024,
            })),
          });
        }
        if (url.endsWith("/api/generate")) {
          const body = JSON.parse((init?.body as string | undefined) ?? "{}") as {
            model: string;
            keep_alive?: number | string;
          };
          this.calls.push(`ollama generate ${body.model} keep_alive=${String(body.keep_alive)}`);
          if (body.keep_alive === 0) this.ollamaLoaded.delete(body.model);
          else this.ollamaLoaded.set(body.model, body.model.includes("nomic") ? 600 : 20_000);
          return json({ done: true });
        }
        return json({}, 404);
      }) as typeof fetch,
    };
  }
}

function makeManager(
  world: World,
  opts?: { specs?: LocalRuntimeSpec[]; policy?: Partial<ManagerPolicy> },
) {
  const log: SwapLogEntry[] = [];
  const m = new LocalRuntimeManager({
    deps: world.deps(),
    getSpecs: () => opts?.specs ?? [VLLM, OLLAMA],
    getPolicy: () => ({ ...resolveManagerPolicy(undefined), ...opts?.policy }),
    appendLog: (e) => log.push(e),
    pollMs: 2000,
  });
  return { m, log };
}

const systemctlVerbs = (w: World, verb: string) =>
  w.calls.filter((c) => c.startsWith(`systemctl --user ${verb}`)).length;

describe("LocalRuntimeManager swap state machine", () => {
  it("swaps Ollama → vLLM: unloads Ollama models, starts the unit, waits for health", async () => {
    const w = new World();
    w.ollamaLoaded.set(QWEN, 20_000);
    const { m, log } = makeManager(w);
    const phases: SwapProgress[] = [];
    const lease = await m.acquire("vllm-qwen", {
      model: "qwen3.8-27b",
      onProgress: (p) => phases.push(p),
    });
    expect(lease.swapped).toBe(true);
    expect(w.vllm).toBe("active");
    expect(w.ollamaLoaded.size).toBe(0);
    expect(w.calls).toContain(`ollama generate ${QWEN} keep_alive=0`);
    expect(systemctlVerbs(w, "start")).toBe(1);
    const kinds = phases.map((p) => p.phase);
    expect(kinds).toContain("freeing");
    expect(kinds).toContain("starting");
    expect(kinds.at(-1)).toBe("ready");
    expect(phases.find((p) => p.phase === "freeing")?.message).toBe(
      "Switching GPU to vLLM Qwen3.8-27B…",
    );
    expect(phases.find((p) => p.phase === "starting")?.message).toMatch(
      /^Starting vLLM Qwen3\.8-27B… \(≈90 s\)$/,
    );
    expect(log.map((e) => e.kind)).toEqual(["stop", "swap"]);
    expect(log[1]).toMatchObject({ runtimeId: "vllm-qwen", from: "ollama" });
    expect(log[1]!.durationMs).toBeGreaterThan(0);
    lease.release();
  });

  it("does nothing when the runtime is already healthy", async () => {
    const w = new World();
    w.vllm = "active";
    const { m, log } = makeManager(w);
    const lease = await m.acquire("vllm-qwen", { model: "qwen3.8-27b" });
    expect(lease.swapped).toBe(false);
    expect(systemctlVerbs(w, "start")).toBe(0);
    expect(log).toEqual([]);
    lease.release();
  });

  it("lets Ollama load on demand when the GPU is free (no swap)", async () => {
    const w = new World();
    const { m } = makeManager(w);
    const lease = await m.acquire("ollama", { model: QWEN, priority: "background" });
    expect(lease.swapped).toBe(false);
    expect(w.calls.some((c) => c.startsWith("ollama generate"))).toBe(false);
    lease.release();
  });

  it("swaps vLLM → Ollama: stops the unit and preloads the model", async () => {
    const w = new World();
    w.vllm = "active";
    const { m, log } = makeManager(w);
    const phases: string[] = [];
    const lease = await m.acquire("ollama", {
      model: QWEN,
      onProgress: (p) => phases.push(p.message),
    });
    expect(w.vllm).toBe("inactive");
    expect(w.ollamaLoaded.has(QWEN)).toBe(true);
    expect(phases).toContain("Switching GPU to Ollama…");
    expect(
      phases.some((p) => p.startsWith("Loading huihui_ai/Qwen3.8-abliterated on Ollama")),
    ).toBe(true);
    expect(log.map((e) => e.kind)).toEqual(["stop", "swap"]);
    lease.release();
  });

  it("batches concurrent requests for the same runtime onto one start", async () => {
    const w = new World();
    w.ollamaLoaded.set(QWEN, 20_000);
    const { m } = makeManager(w);
    const leases = await Promise.all([
      m.acquire("vllm-qwen", { model: "qwen3.8-27b" }),
      m.acquire("vllm-qwen", { model: "qwen3.8-27b" }),
      m.acquire("vllm-qwen", { model: "qwen3.8-27b" }),
    ]);
    expect(systemctlVerbs(w, "start")).toBe(1);
    expect((await m.status()).runtimes.find((r) => r.id === "vllm-qwen")?.inflight).toBe(3);
    for (const l of leases) l.release();
  });

  it("a swap waits for in-flight requests on the old runtime to finish", async () => {
    const w = new World();
    w.ollamaLoaded.set(QWEN, 20_000);
    const { m } = makeManager(w);
    const ollamaLease = await m.acquire("ollama", { model: QWEN });
    const phases: string[] = [];
    const pending = m.acquire("vllm-qwen", { onProgress: (p) => phases.push(p.phase) });
    await new Promise((r) => setTimeout(r, 15));
    // Still draining: Ollama untouched while its request runs.
    expect(w.ollamaLoaded.has(QWEN)).toBe(true);
    expect(systemctlVerbs(w, "start")).toBe(0);
    expect(phases).toContain("draining");
    ollamaLease.release();
    const lease = await pending;
    expect(w.vllm).toBe("active");
    expect(w.ollamaLoaded.size).toBe(0);
    lease.release();
  });

  it("drain has a timeout: logs it and swaps anyway", async () => {
    const w = new World();
    w.ollamaLoaded.set(QWEN, 20_000);
    const { m, log } = makeManager(w, { policy: { drainTimeoutMs: 10_000 } });
    const stuck = await m.acquire("ollama", { model: QWEN });
    const lease = await m.acquire("vllm-qwen");
    expect(log.some((e) => e.kind === "drain-timeout")).toBe(true);
    expect(w.vllm).toBe("active");
    stuck.release();
    lease.release();
  });

  it("failed start: clear error, stops the broken unit, restores the previous runtime", async () => {
    const w = new World();
    w.ollamaLoaded.set(QWEN, 20_000);
    w.vllmFailsToStart = true;
    const { m, log } = makeManager(w);
    const phases: SwapProgress[] = [];
    const err = await m
      .acquire("vllm-qwen", { onProgress: (p) => phases.push(p) })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LocalRuntimeError);
    const e = err as LocalRuntimeError;
    expect(e.code).toBe("local_runtime_unavailable");
    expect(e.restoredTo).toBe("Ollama");
    expect(e.message).toMatch(
      /^Couldn't start vLLM Qwen3\.8-27B: .*exited \(failed\).*Back on Ollama\.$/,
    );
    expect(w.ollamaLoaded.has(QWEN)).toBe(true);
    expect(w.vllm).toBe("inactive");
    expect(log.map((x) => x.kind)).toEqual(["stop", "failed", "restore"]);
    expect(phases.at(-1)?.phase).toBe("failed");
    const st = await m.status();
    expect(st.runtimes.find((r) => r.id === "vllm-qwen")?.error).toMatch(/exited/);
  });

  it("a crash-looping unit fails fast with the exception line from its journal", async () => {
    const w = new World();
    w.vllmHealthyAfterPolls = 10_000;
    w.vllmCrashLoop = true;
    w.journal = [
      "(APIServer pid=1) Traceback (most recent call last):",
      "(APIServer pid=1)     raise LocalEntryNotFoundError(",
      "(APIServer pid=1) huggingface_hub.errors.LocalEntryNotFoundError: Cannot find an appropriate cached snapshot folder",
    ].join("\n");
    const { m } = makeManager(w);
    const t0 = w.clock;
    await expect(m.acquire("vllm-qwen")).rejects.toThrow(
      /vllm-qwen\.service is crash-looping — huggingface_hub\.errors\.LocalEntryNotFoundError: Cannot find/,
    );
    expect(w.clock - t0).toBeLessThan(30_000); // not the 420 s health timeout
  });

  it("health timeout counts as a failed start", async () => {
    const w = new World();
    w.vllmHealthyAfterPolls = 10_000;
    const { m, log } = makeManager(w, { specs: [{ ...VLLM, startupTimeoutSec: 20 }, OLLAMA] });
    await expect(m.acquire("vllm-qwen")).rejects.toThrow(/no health response .* after 20 s/);
    expect(w.vllm).toBe("inactive");
    expect(log.at(-1)?.kind).toBe("failed");
  });

  it("refuses when other GPU processes leave too little VRAM — never kills them", async () => {
    const w = new World();
    w.foreignMb = 10_000;
    w.ollamaLoaded.set(QWEN, 20_000);
    const { m } = makeManager(w);
    await expect(m.acquire("vllm-qwen")).rejects.toThrow(/not enough VRAM: .* < ~28512 MiB needed/);
    // Refused up front: Ollama was never unloaded.
    expect(w.calls.some((c) => c.includes("keep_alive=0"))).toBe(false);
    // Only registry units/models were touched; Ollama put back.
    expect(
      w.calls
        .filter((c) => c.startsWith("systemctl"))
        .every((c) => c.includes("vllm-qwen.service")),
    ).toBe(true);
    expect(w.ollamaLoaded.has(QWEN)).toBe(true);
    expect(w.foreignMb).toBe(10_000);
  });

  it("vramFraction sizes the need from the GPU total (vLLM --gpu-memory-utilization)", async () => {
    const w = new World();
    w.foreignMb = 3_000; // desktop + speaches
    w.ollamaLoaded.set(QWEN, 20_000);
    // 0.9 × 32607 = 29347 MiB + 512 reserve = 29859 > 29607 free once Ollama is gone.
    const { m } = makeManager(w, { specs: [{ ...VLLM, vramFraction: 0.9 }, OLLAMA] });
    await expect(m.acquire("vllm-qwen")).rejects.toThrow(/needs ~29859 MiB/); // passes the padded pre-check, caught after eviction
    expect(w.ollamaLoaded.has(QWEN)).toBe(true);
  });

  it("only unloads Ollama models listed in the registry", async () => {
    const w = new World();
    w.ollamaLoaded.set(QWEN, 20_000);
    w.ollamaLoaded.set("someone-elses-model:7b", 100);
    const { m } = makeManager(w, { specs: [VLLM, { ...OLLAMA, models: [QWEN] }] });
    const lease = await m.acquire("vllm-qwen");
    expect(w.ollamaLoaded.has("someone-elses-model:7b")).toBe(true);
    expect(w.ollamaLoaded.has(QWEN)).toBe(false);
    lease.release();
  });
});

describe("background priority", () => {
  it("background OCR waits instead of evicting vLLM while chat uses it", async () => {
    const w = new World();
    w.vllm = "active";
    const { m } = makeManager(w, { policy: { backgroundSwapIdleMs: 60_000 } });
    const chat = await m.acquire("vllm-qwen", { priority: "interactive" });
    const phases: string[] = [];
    let got = false;
    const ocr = m
      .acquire("ollama", {
        model: QWEN,
        priority: "background",
        onProgress: (p) => phases.push(p.phase),
      })
      .then((l) => {
        got = true;
        return l;
      });
    await new Promise((r) => setTimeout(r, 20));
    expect(got).toBe(false);
    expect(phases).toEqual(["waiting"]);
    expect(w.vllm).toBe("active");
    chat.release();
    // Chat idle past the window → background may now swap.
    const lease = await ocr;
    expect(w.vllm).toBe("inactive");
    expect(w.ollamaLoaded.has(QWEN)).toBe(true);
    lease.release();
  });

  it("fifo policy lets background swap immediately once nothing is in flight", async () => {
    const w = new World();
    w.vllm = "active";
    const { m } = makeManager(w, { policy: { backgroundPriority: "fifo" } });
    const chat = await m.acquire("vllm-qwen");
    chat.release();
    const lease = await m.acquire("ollama", { model: QWEN, priority: "background" });
    expect(w.vllm).toBe("inactive");
    lease.release();
  });

  it("background gives up after backgroundWaitTimeoutMs", async () => {
    const w = new World();
    w.vllm = "active";
    const { m } = makeManager(w, { policy: { backgroundWaitTimeoutMs: 20_000 } });
    const chat = await m.acquire("vllm-qwen");
    await expect(m.acquire("ollama", { model: QWEN, priority: "background" })).rejects.toThrow(
      /waiting for the GPU/,
    );
    chat.release();
  });
});

describe("idle policy", () => {
  it("stops vLLM after idleStopMinutes with nothing in flight", async () => {
    const w = new World();
    w.vllm = "active";
    const { m, log } = makeManager(w);
    const lease = await m.acquire("vllm-qwen");
    lease.release();
    w.clock += 29 * 60_000;
    expect(await m.idleSweep()).toEqual([]);
    w.clock += 2 * 60_000;
    expect(await m.idleSweep()).toEqual(["vllm-qwen"]);
    expect(w.vllm).toBe("inactive");
    expect(log.at(-1)).toMatchObject({ kind: "idle-stop", runtimeId: "vllm-qwen" });
  });

  it("never idle-stops with a request in flight, or when idleStopMinutes is 0", async () => {
    const w = new World();
    w.vllm = "active";
    const { m } = makeManager(w);
    const lease = await m.acquire("vllm-qwen");
    w.clock += 120 * 60_000;
    expect(await m.idleSweep()).toEqual([]);
    lease.release();
    const w2 = new World();
    w2.vllm = "active";
    const { m: m2 } = makeManager(w2, { specs: [{ ...VLLM, idleStopMinutes: 0 }, OLLAMA] });
    await m2.status();
    w2.clock += 999 * 60_000;
    expect(await m2.idleSweep()).toEqual([]);
    expect(w2.vllm).toBe("active");
  });
});

describe("manual control + status", () => {
  it("start/stop buttons and status snapshot", async () => {
    const w = new World();
    const { m } = makeManager(w);
    await m.start("vllm-qwen");
    let st = await m.status();
    const v = st.runtimes.find((r) => r.id === "vllm-qwen")!;
    expect(v.state).toBe("ready");
    expect(v.inflight).toBe(0);
    expect(v.idleStopAt).toBeGreaterThan(w.clock);
    expect(st.gpu).toMatchObject({ name: "NVIDIA GeForce RTX 5090", totalMb: 32_607 });
    await m.stop("vllm-qwen");
    st = await m.status();
    expect(st.runtimes.find((r) => r.id === "vllm-qwen")?.state).toBe("stopped");
    expect(st.log.map((e) => e.kind)).toEqual(["stop", "start"]);
  });

  it("unknown runtime ids are rejected", async () => {
    const { m } = makeManager(new World());
    await expect(m.acquire("speaches")).rejects.toThrow(/Unknown local runtime/);
    await expect(m.stop("speaches")).rejects.toThrow(/Unknown local runtime/);
  });
});

describe("interactive priority on the same runtime", () => {
  it("background leases pause while a chat turn uses the runtime, resume on idle", async () => {
    const w = new World();
    w.ollamaLoaded.set(QWEN, 20_000);
    const { m } = makeManager(w);
    const events: string[] = [];
    m.onInteractive((e) => events.push(`${e.runtimeId}:${e.state}`));
    let releaseChat!: () => void;
    const chatDone = new Promise<void>((r) => (releaseChat = r));
    const chat = m.withInteractive("ollama", () => chatDone, { model: QWEN });
    await new Promise((r) => setTimeout(r, 5));
    expect(m.isInteractiveBusy("ollama")).toBe(true);
    const phases: SwapProgress[] = [];
    let got = false;
    const ocr = m
      .acquire("ollama", { model: QWEN, priority: "background", onProgress: (p) => phases.push(p) })
      .then((l) => {
        got = true;
        return l;
      });
    await new Promise((r) => setTimeout(r, 20));
    expect(got).toBe(false);
    expect(phases[0]).toMatchObject({ phase: "waiting", message: "Paused — chat is using Ollama" });
    const idle = m.waitForInteractiveIdle("ollama", 60_000);
    releaseChat();
    await chat;
    expect(await idle).toBe(true);
    const lease = await ocr;
    expect(got).toBe(true);
    expect(events).toEqual(["ollama:busy", "ollama:idle"]);
    lease.release();
  });

  it("fifo policy does not pause background on the same runtime", async () => {
    const w = new World();
    const { m } = makeManager(w, { policy: { backgroundPriority: "fifo" } });
    const chat = await m.acquire("ollama", { model: QWEN });
    const lease = await m.acquire("ollama", { model: QWEN, priority: "background" });
    lease.release();
    chat.release();
  });
});
