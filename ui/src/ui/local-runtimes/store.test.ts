import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attachLocalRuntimesClient,
  getLocalRuntimesState,
  handleLocalRuntimesEvent,
  normalizeStatus,
  parseRuntimeStatusNotice,
  resetLocalRuntimesForTests,
  startLocalRuntime,
} from "./store";

const STATUS = {
  enabled: true,
  gpu: { name: "NVIDIA GeForce RTX 5090", totalMb: 32607, usedMb: 5897, freeMb: 26710 },
  swap: null,
  log: [],
  runtimes: [
    { id: "vllm-qwen", label: "vLLM Qwen3.8-27B", kind: "systemd", state: "stopped", healthy: false, holdsGpu: false, loadedModels: [], inflight: 0, idleStopMinutes: 30, vramMb: 28000, etaSec: 90, providers: ["vllm-local"], baseUrl: "x" },
  ],
};

afterEach(() => resetLocalRuntimesForTests());

describe("local runtimes store", () => {
  it("parses runtime_status chat notices", () => {
    const n = parseRuntimeStatusNotice(
      {
        stream: "notice",
        runId: "r1",
        sessionKey: "agent:main:s",
        data: { kind: "runtime_status", phase: "starting", message: "Starting vLLM Qwen3.8-27B… (≈90 s)", etaSec: 90, elapsedSec: 12, runtimeId: "vllm-qwen", label: "vLLM Qwen3.8-27B" },
      },
      100_000,
    )!;
    expect(n).toMatchObject({ phase: "starting", sessionKey: "agent:main:s", etaSec: 90, startedAtLocal: 88_000 });
    expect(parseRuntimeStatusNotice({ stream: "notice", data: { kind: "model_fallback", message: "x" } })).toBeNull();
    expect(parseRuntimeStatusNotice({ stream: "tool", data: {} })).toBeNull();
  });

  it("loads status on hello and reports older gateways as unsupported", async () => {
    const request = vi.fn(async () => STATUS);
    attachLocalRuntimesClient({ request, supports: () => true });
    await vi.waitFor(() => expect(getLocalRuntimesState().status?.runtimes[0]?.id).toBe("vllm-qwen"));
    resetLocalRuntimesForTests();
    attachLocalRuntimesClient({ request, supports: (m) => m !== "localRuntimes.status" });
    expect(getLocalRuntimesState().unsupported).toBe(true);
  });

  it("swap events update progress; Start calls the RPC with the registry id", async () => {
    const request = vi.fn(async (method: string) => (method === "localRuntimes.status" ? STATUS : { ok: true }));
    attachLocalRuntimesClient({ request });
    await vi.waitFor(() => expect(getLocalRuntimesState().status).not.toBeNull());
    expect(handleLocalRuntimesEvent("localRuntimes.status", { swap: { runtimeId: "vllm-qwen", phase: "starting", message: "m", startedAt: 1, elapsedSec: 0, etaSec: 90, label: "v" } })).toBe(true);
    expect(getLocalRuntimesState().status?.swap?.phase).toBe("starting");
    expect(handleLocalRuntimesEvent("chat", {})).toBe(false);
    await startLocalRuntime("vllm-qwen");
    expect(request).toHaveBeenCalledWith("localRuntimes.start", { id: "vllm-qwen" });
    expect(normalizeStatus({})).toBeNull();
  });
});
