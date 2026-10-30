import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  activeVoiceModel,
  readVoiceCliRoute,
  sanitizeVoiceModelRef,
  setVoiceCliRouteFileForTests,
  writeVoiceCliRoute,
} from "./voice-cli-route.js";
import {
  runVoiceLlmTurn,
  withVoiceModel,
  type GatewayTurnDeps,
  type VoiceLlmTurnRequest,
} from "./voice-llm-turn.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "voice-brain-model-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
beforeEach(() => setVoiceCliRouteFileForTests(path.join(tmp, `route-${Math.random()}.json`)));
afterEach(() => setVoiceCliRouteFileForTests(null));

const base = (over: Partial<VoiceLlmTurnRequest> = {}): VoiceLlmTurnRequest => ({
  agentId: "main",
  backend: "gateway",
  message: "hello",
  callKey: "c1",
  provider: "local",
  callerIsOwner: true,
  onDelta: () => {},
  ...over,
});

describe("voice brain model on the route", () => {
  it("accepts provider/model refs (slashes and colons in the model id)", () => {
    expect(sanitizeVoiceModelRef("ollama-cloud/gpt-oss:120b")).toBe("ollama-cloud/gpt-oss:120b");
    expect(sanitizeVoiceModelRef("openrouter/openai/gpt-oss-120b:free")).toBe(
      "openrouter/openai/gpt-oss-120b:free",
    );
    expect(sanitizeVoiceModelRef("claude-cli/sonnet")).toBe("claude-cli/sonnet");
    expect(sanitizeVoiceModelRef("no-slash")).toBeUndefined();
    expect(sanitizeVoiceModelRef("a/b c")).toBeUndefined();
    expect(sanitizeVoiceModelRef(42)).toBeUndefined();
  });

  it("keeps the model across mode switches and fallbacks; null clears it", () => {
    writeVoiceCliRoute({ mode: "api", model: "ollama-cloud/gpt-oss:120b" });
    expect(readVoiceCliRoute().model).toBe("ollama-cloud/gpt-oss:120b");
    writeVoiceCliRoute({ mode: "cli", target: { kind: "terminal", terminalId: "t1", label: "T" } });
    expect(readVoiceCliRoute()).toMatchObject({ mode: "cli", model: "ollama-cloud/gpt-oss:120b" });
    writeVoiceCliRoute({ mode: "api" });
    expect(readVoiceCliRoute().model).toBe("ollama-cloud/gpt-oss:120b");
    writeVoiceCliRoute({ mode: "api", model: null });
    expect(readVoiceCliRoute().model).toBeUndefined();
  });

  it("applies to the owner only", () => {
    writeVoiceCliRoute({ mode: "api", model: "openrouter/x/y:free" });
    expect(activeVoiceModel({ callerIsOwner: true })).toBe("openrouter/x/y:free");
    expect(activeVoiceModel({ callerIsOwner: false })).toBeUndefined();
  });
});

describe("withVoiceModel", () => {
  it("API model drives the fast step and the full agent", () => {
    const r = withVoiceModel(base({ mode: "auto" }), "ollama-cloud/gpt-oss:120b");
    expect(r).toMatchObject({
      primaryModel: "ollama-cloud/gpt-oss:120b",
      fastModel: "ollama-cloud/gpt-oss:120b",
      mode: "auto",
    });
  });
  it("subscription CLI providers skip the fast step (no direct streaming API)", () => {
    const r = withVoiceModel(base({ mode: "auto" }), "claude-cli/sonnet");
    expect(r.primaryModel).toBe("claude-cli/sonnet");
    expect(r.fastModel).toBeUndefined();
    expect(r.mode).toBe("agent");
  });
});

describe("runVoiceLlmTurn uses the voice brain model", () => {
  const gateway = (seen: Array<string | undefined>): GatewayTurnDeps => ({
    runAgent: async (o) => {
      seen.push(o.primaryModel);
      return { payloads: [{ text: "ok" }] };
    },
    onAgentEvent: () => () => {},
  });

  it("the full agent runs on the persisted model for owner turns", async () => {
    writeVoiceCliRoute({ mode: "api", model: "openrouter/openai/gpt-oss-120b:free" });
    const seen: Array<string | undefined> = [];
    await runVoiceLlmTurn(base({ mode: "agent" }), { gateway: gateway(seen) }).catch(() => null);
    expect(seen[0]).toBe("openrouter/openai/gpt-oss-120b:free");
  });

  it("guests keep the agent's model", async () => {
    writeVoiceCliRoute({ mode: "api", model: "openrouter/openai/gpt-oss-120b:free" });
    const seen: Array<string | undefined> = [];
    await runVoiceLlmTurn(base({ mode: "agent", callerIsOwner: false }), {
      gateway: gateway(seen),
    }).catch(() => null);
    expect(seen[0]).toBeUndefined();
  });
});
