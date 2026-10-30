import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock retryWithBackoff as passthrough so timer delays don't slow tests
vi.mock("./retry.js", async (importOriginal) => {
  const mod = (await importOriginal()) as typeof import("./retry.js");
  return {
    ...mod,
    retryWithBackoff: async (fn: () => Promise<unknown>) => fn(),
  };
});
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { runOrchestratorTurn, type OrchestratorTurnInput } from "./goal-orchestrator.js";

// ─── Mocks ────────────────────────────────────────────────────────────────

const completeMock = vi.fn();
vi.mock("@mariozechner/pi-ai", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@mariozechner/pi-ai")>();
  return { ...mod, complete: (...args: unknown[]) => completeMock(...args) };
});

const callGatewayMock = vi.fn();
vi.mock("../gateway/call.js", () => ({
  callGateway: (...args: unknown[]) => callGatewayMock(...args),
}));

const setSubagentLineageMock = vi.fn();
const listSubagentRunsByGoalIdMock = vi.fn();
vi.mock("../agents/subagent-registry.js", () => ({
  setSubagentLineage: (...args: unknown[]) => setSubagentLineageMock(...args),
  listSubagentRunsByGoalId: (...args: unknown[]) => listSubagentRunsByGoalIdMock(...args),
  getSubagentRun: vi.fn(),
}));

vi.mock("../agents/pi-embedded-runner/model.js", () => ({
  resolveModel: vi.fn().mockReturnValue({
    model: { provider: "anthropic", id: "claude-sonnet-4-6" },
    authStorage: { setRuntimeApiKey: vi.fn() },
    error: undefined,
  }),
}));

const getApiKeyForModelMock = vi.fn();
vi.mock("../agents/model-auth.js", () => ({
  getApiKeyForModel: (...args: unknown[]) => getApiKeyForModelMock(...args),
}));

const runCliPlannerMock = vi.fn();
const checkCliAvailableMock = vi.fn();
vi.mock("./cli-planner.js", () => ({
  runCliPlanner: (...args: unknown[]) => runCliPlannerMock(...args),
  checkCliAvailable: (...args: unknown[]) => checkCliAvailableMock(...args),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────

function asAssistantMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  } as unknown as AssistantMessage;
}

function plan(reasoning: string, toolCalls: unknown[]): string {
  return JSON.stringify({ reasoning, tool_calls: toolCalls });
}

function baseInput(overrides: Partial<OrchestratorTurnInput> = {}): OrchestratorTurnInput {
  return {
    goalText: "test goal",
    priorIterations: [],
    budget: { maxTurns: 5, turnsUsed: 0 },
    goalId: "test-goal-1",
    iterationIndex: 1,
    priorityMode: "production-reliability" as const,
    ...overrides,
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  getApiKeyForModelMock.mockResolvedValue({ apiKey: "test-key", mode: "api" });
  checkCliAvailableMock.mockReturnValue(true);
  runCliPlannerMock.mockResolvedValue(plan("cli plan", []));
  completeMock.mockResolvedValue(asAssistantMessage(plan("api plan", [])));
  callGatewayMock.mockResolvedValue({ runId: "run-1", childSessionKey: "sk-1" });
  listSubagentRunsByGoalIdMock.mockReturnValue([]);
});

describe("goal-orchestrator auth path selection", () => {
  // The orchestrator prefers the locally installed CLI (own OAuth/login) over
  // the API key path; the API path is used when the CLI binary is missing or
  // INFINIBOT_AUTONOMY_FORCE_API=1.
  it("uses pi-ai complete() when API key is present and the CLI is not installed (claude backend)", async () => {
    getApiKeyForModelMock.mockResolvedValue({ apiKey: "sk-ant-test", mode: "api" });
    checkCliAvailableMock.mockReturnValue(false);

    const result = await runOrchestratorTurn(baseInput({ backend: { kind: "claude" as const } }));

    expect(completeMock).toHaveBeenCalled();
    expect(runCliPlannerMock).not.toHaveBeenCalled();
    expect(result.summary).toBeTruthy();
    expect(result.errors).toBeUndefined();
  });

  it("uses pi-ai complete() when API key is present and the CLI is not installed (opencode backend)", async () => {
    getApiKeyForModelMock.mockResolvedValue({ apiKey: "sk-ant-test", mode: "api" });
    checkCliAvailableMock.mockReturnValue(false);

    const result = await runOrchestratorTurn(baseInput({ backend: { kind: "opencode" as const } }));

    expect(completeMock).toHaveBeenCalled();
    expect(runCliPlannerMock).not.toHaveBeenCalled();
    expect(result.summary).toBeTruthy();
  });

  it("prefers the CLI planner over a valid API key when the CLI is installed", async () => {
    getApiKeyForModelMock.mockResolvedValue({ apiKey: "sk-ant-test", mode: "api" });
    checkCliAvailableMock.mockReturnValue(true);

    const result = await runOrchestratorTurn(baseInput({ backend: { kind: "claude" as const } }));

    expect(runCliPlannerMock).toHaveBeenCalled();
    expect(completeMock).not.toHaveBeenCalled();
    expect(getApiKeyForModelMock).not.toHaveBeenCalled();
    expect(result.errors).toBeUndefined();
  });

  it("INFINIBOT_AUTONOMY_FORCE_API=1 keeps the API path even when the CLI is installed", async () => {
    vi.stubEnv("INFINIBOT_AUTONOMY_FORCE_API", "1");
    try {
      getApiKeyForModelMock.mockResolvedValue({ apiKey: "sk-ant-test", mode: "api" });
      checkCliAvailableMock.mockReturnValue(true);

      const result = await runOrchestratorTurn(baseInput({ backend: { kind: "claude" as const } }));

      expect(completeMock).toHaveBeenCalled();
      expect(runCliPlannerMock).not.toHaveBeenCalled();
      expect(result.errors).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("uses runCliPlanner when no API key and CLI is available (opencode)", async () => {
    getApiKeyForModelMock.mockResolvedValue({ apiKey: undefined, mode: "none" });
    checkCliAvailableMock.mockReturnValue(true);
    runCliPlannerMock.mockResolvedValue(plan("opencode plan", []));

    const result = await runOrchestratorTurn(baseInput({ backend: { kind: "opencode" as const } }));

    expect(checkCliAvailableMock).toHaveBeenCalledWith("opencode");
    expect(runCliPlannerMock).toHaveBeenCalled();
    expect(completeMock).not.toHaveBeenCalled();
    expect(result.summary).toBeTruthy();
    expect(result.errors).toBeUndefined();
  });

  it("uses runCliPlanner when no API key and CLI is available (claude)", async () => {
    getApiKeyForModelMock.mockResolvedValue({ apiKey: undefined, mode: "none" });
    checkCliAvailableMock.mockReturnValue(true);
    runCliPlannerMock.mockResolvedValue(plan("claude plan", []));

    const result = await runOrchestratorTurn(baseInput({ backend: { kind: "claude" as const } }));

    expect(runCliPlannerMock).toHaveBeenCalled();
    expect(completeMock).not.toHaveBeenCalled();
    expect(result.summary).toBeTruthy();
  });

  it("uses runCliPlanner when no API key and CLI is available (codex)", async () => {
    getApiKeyForModelMock.mockResolvedValue({ apiKey: undefined, mode: "none" });
    checkCliAvailableMock.mockReturnValue(true);
    runCliPlannerMock.mockResolvedValue(plan("codex plan", []));

    const result = await runOrchestratorTurn(baseInput({ backend: { kind: "codex" as const } }));

    expect(runCliPlannerMock).toHaveBeenCalled();
    expect(completeMock).not.toHaveBeenCalled();
    expect(result.summary).toBeTruthy();
  });

  it("fails with clear error when no API key and CLI is not available (opencode)", async () => {
    getApiKeyForModelMock.mockResolvedValue({ apiKey: undefined, mode: "none" });
    checkCliAvailableMock.mockReturnValue(false);

    const result = await runOrchestratorTurn(baseInput({ backend: { kind: "opencode" as const } }));

    expect(runCliPlannerMock).not.toHaveBeenCalled();
    expect(completeMock).not.toHaveBeenCalled();
    expect(result.errors).toBeDefined();
    expect(result.errors!.length).toBeGreaterThan(0);
    expect(result.errors![0].message).toContain("credentials unavailable");
    expect(result.errors![0].message).toContain("OpenCode");
  });

  it("fails with clear error when no API key and CLI is not available (claude)", async () => {
    getApiKeyForModelMock.mockResolvedValue({ apiKey: undefined, mode: "none" });
    checkCliAvailableMock.mockReturnValue(false);

    const result = await runOrchestratorTurn(baseInput({ backend: { kind: "claude" as const } }));

    expect(runCliPlannerMock).not.toHaveBeenCalled();
    expect(completeMock).not.toHaveBeenCalled();
    expect(result.errors).toBeDefined();
    expect(result.errors!.length).toBeGreaterThan(0);
    expect(result.errors![0].message).toContain("credentials unavailable");
  });
});
