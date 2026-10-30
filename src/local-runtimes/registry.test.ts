import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FailoverError } from "../agents/failover-error.js";
import { humanizeProviderError } from "../agents/provider-error-messages.js";
import type { InfinibotConfig } from "../config/config.js";
import { validateConfigObject } from "../config/config.js";
import { onAgentEvent, type AgentEventPayload } from "../infra/agent-events.js";
import { LocalRuntimeManager } from "./manager.js";
import {
  findRuntimeForProvider,
  findRuntimeForUrl,
  resolveManagerPolicy,
  resolveRuntimeSpecs,
} from "./registry.js";
import { withLocalRuntimeForRun } from "./run-gate.js";
import { setLocalRuntimeManagerForTest } from "./runtime.js";

const tmpHomes: string[] = [];
function fakeHome(withUnit: boolean): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "lrt-home-"));
  tmpHomes.push(home);
  if (withUnit) {
    const dir = path.join(home, ".config/systemd/user");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "vllm-qwen.service"),
      "[Service]\nExecStart=/x/vllm serve m \\\n    --host 172.17.0.1 \\\n    --port 8010 \\\n",
    );
  }
  return home;
}
afterEach(() => {
  for (const h of tmpHomes.splice(0)) fs.rmSync(h, { recursive: true, force: true });
  setLocalRuntimeManagerForTest(null);
});

describe("registry", () => {
  it("auto-detects Ollama always and vLLM only when the unit exists", () => {
    expect(resolveRuntimeSpecs({}, { home: fakeHome(false) }).map((s) => s.id)).toEqual(["ollama"]);
    const specs = resolveRuntimeSpecs({}, { home: fakeHome(true) });
    const vllm = specs.find((s) => s.id === "vllm-qwen")!;
    expect(vllm).toMatchObject({
      kind: "systemd",
      unit: "vllm-qwen.service",
      baseUrl: "http://172.17.0.1:8010/v1",
      healthUrl: "http://172.17.0.1:8010/v1/models",
      providers: ["vllm-local"],
      idleStopMinutes: 30,
      startAtBoot: false,
    });
  });

  it("reads --gpu-memory-utilization from the unit, drop-ins winning", () => {
    const home = fakeHome(true);
    const unit = path.join(home, ".config/systemd/user/vllm-qwen.service");
    fs.appendFileSync(unit, "    --gpu-memory-utilization 0.85 \\\n");
    expect(resolveRuntimeSpecs({}, { home }).find((s) => s.id === "vllm-qwen")?.vramFraction).toBe(
      0.85,
    );
    fs.mkdirSync(`${unit}.d`);
    fs.writeFileSync(
      `${unit}.d/memory.conf`,
      "[Service]\nExecStart=\nExecStart=/x/vllm serve m --gpu-memory-utilization 0.78\n",
    );
    expect(resolveRuntimeSpecs({}, { home }).find((s) => s.id === "vllm-qwen")?.vramFraction).toBe(
      0.78,
    );
  });

  it("uses the vllm-local provider's baseUrl + models and owner overrides", () => {
    const cfg = {
      models: {
        providers: {
          "vllm-local": {
            baseUrl: "http://172.17.0.1:8010/v1",
            models: [{ id: "qwen3.8-27b", input: ["text"] }],
          },
        },
      },
      localRuntimes: {
        runtimes: { "vllm-qwen": { idleStopMinutes: 5, startAtBoot: true }, ollama: false },
      },
    } as unknown as InfinibotConfig;
    const specs = resolveRuntimeSpecs(cfg, { home: fakeHome(true) });
    expect(specs.map((s) => s.id)).toEqual(["vllm-qwen"]);
    expect(specs[0]).toMatchObject({
      models: ["qwen3.8-27b"],
      idleStopMinutes: 5,
      startAtBoot: true,
    });
  });

  it("disabled manager has an empty registry", () => {
    expect(resolveRuntimeSpecs({ localRuntimes: { enabled: false } } as InfinibotConfig)).toEqual(
      [],
    );
    expect(
      resolveManagerPolicy({ localRuntimes: { enabled: false } } as InfinibotConfig).enabled,
    ).toBe(false);
  });

  it("maps providers and endpoint URLs to runtimes", () => {
    const specs = resolveRuntimeSpecs({}, { home: fakeHome(true) });
    expect(findRuntimeForProvider(specs, "vllm-local", "qwen3.8-27b")?.id).toBe("vllm-qwen");
    expect(findRuntimeForProvider(specs, "ollama", "anything")?.id).toBe("ollama");
    expect(findRuntimeForProvider(specs, "openrouter", "x")).toBeNull();
    expect(findRuntimeForUrl(specs, "http://localhost:11434")?.id).toBe("ollama");
    expect(findRuntimeForUrl(specs, "http://127.0.0.1:11434/api/chat")?.id).toBe("ollama");
    expect(findRuntimeForUrl(specs, "http://172.17.0.1:8010/v1/chat/completions")?.id).toBe(
      "vllm-qwen",
    );
    expect(findRuntimeForUrl(specs, "http://10.0.0.5:11434")).toBeNull();
  });

  it("the config schema accepts localRuntimes", () => {
    const res = validateConfigObject({
      localRuntimes: {
        drainTimeoutSec: 60,
        backgroundPriority: "fifo",
        runtimes: {
          "vllm-qwen": { kind: "systemd", unit: "vllm-qwen.service", idleStopMinutes: 10 },
          ollama: false,
        },
      },
    });
    expect(res.ok).toBe(true);
  });
});

describe("run gate", () => {
  function stubManager(acquire: LocalRuntimeManager["acquire"]) {
    const m = { acquire, spec: () => undefined } as unknown as LocalRuntimeManager;
    setLocalRuntimeManagerForTest(m);
  }
  const cfg = {
    localRuntimes: {
      runtimes: {
        "vllm-qwen": {
          kind: "systemd",
          unit: "vllm-qwen.service",
          baseUrl: "http://172.17.0.1:8010/v1",
          providers: ["vllm-local"],
        },
      },
    },
  } as unknown as InfinibotConfig;

  it("holds a lease for the run and streams runtime_status notices to the chat", async () => {
    let released = 0;
    stubManager(async (_id, opts) => {
      opts?.onProgress?.({
        runtimeId: "vllm-qwen",
        label: "vLLM Qwen3.8-27B",
        phase: "starting",
        message: "Starting vLLM Qwen3.8-27B… (≈90 s)",
        startedAt: 1,
        elapsedSec: 0,
        etaSec: 90,
      });
      return { runtimeId: "vllm-qwen", swapped: true, release: () => (released += 1) };
    });
    const events: AgentEventPayload[] = [];
    const off = onAgentEvent((e) => events.push(e));
    const out = await withLocalRuntimeForRun(
      {
        config: cfg,
        provider: "vllm-local",
        model: "qwen3.8-27b",
        runId: "run-1",
        sessionKey: "agent:main:s1",
      },
      async () => {
        expect(released).toBe(0);
        return "reply";
      },
    );
    off();
    expect(out).toBe("reply");
    expect(released).toBe(1);
    const notice = events.find((e) => e.stream === "notice");
    expect(notice?.data).toMatchObject({
      kind: "runtime_status",
      phase: "starting",
      message: "Starting vLLM Qwen3.8-27B… (≈90 s)",
    });
    expect(notice?.sessionKey).toBe("agent:main:s1");
  });

  it("models no runtime serves pass straight through", async () => {
    stubManager(async () => {
      throw new Error("should not be called");
    });
    await expect(
      withLocalRuntimeForRun(
        { config: cfg, provider: "openrouter", model: "x", runId: "r" },
        async () => 42,
      ),
    ).resolves.toBe(42);
  });

  it("a failed start becomes a FailoverError with a humanized, non-connection message", async () => {
    const { LocalRuntimeError } = await import("./manager.js");
    stubManager(async () => {
      throw new LocalRuntimeError(
        "Couldn't start vLLM Qwen3.8-27B: vllm-qwen.service exited (failed). Back on Ollama.",
        { runtimeId: "vllm-qwen", restoredTo: "Ollama" },
      );
    });
    const err = await withLocalRuntimeForRun(
      { config: cfg, provider: "vllm-local", model: "qwen3.8-27b", runId: "r" },
      async () => 1,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FailoverError);
    expect((err as FailoverError).code).toBe("local_runtime_unavailable");
    const h = humanizeProviderError(err, { provider: "vllm-local", model: "qwen3.8-27b" });
    expect(h.kind).toBe("local_runtime");
    expect(h.message).toContain("Couldn't start vLLM Qwen3.8-27B");
    expect(h.message).not.toMatch(/Temporary connection issue/);
    // Also recognised inside runWithModelFallback's "All models failed" summary.
    const summary = new Error(
      "All models failed (2): vllm-local/qwen3.8-27b: Couldn't start vLLM Qwen3.8-27B: no health response. Back on Ollama. (timeout) | ollama/x: boom",
    );
    expect(humanizeProviderError(summary).kind).toBe("local_runtime");
  });
});
