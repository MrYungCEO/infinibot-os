import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runEmbeddedPiAgent } from "../agents/pi-embedded-runner/run.js";
import type { InfinibotConfig } from "../config/config.js";
import { setSecureModelListerForTests } from "./local-models.js";
import { SecureModeRuntime, setSecureModeRuntimeForTests } from "./runtime.js";

let root: string;
let rt: SecureModeRuntime;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ib-secure-run-"));
  rt = new SecureModeRuntime({
    stateDir: path.join(root, "state"),
    env: {
      INFINIBOT_SECURE_RAM_DIR: path.join(root, "ram"),
      INFINIBOT_SECURE_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
    },
    sealIntervalMs: 0,
  });
  setSecureModeRuntimeForTests(rt);
  // No local model server answers in this test: the run must fail closed.
  setSecureModelListerForTests(async () => null);
});

afterEach(() => {
  rt.shutdown();
  setSecureModeRuntimeForTests(null);
  setSecureModelListerForTests(null);
  fs.rmSync(root, { recursive: true, force: true });
});

function run(provider: string, model: string, sessionKey = "agent:main:secure-run1") {
  return runEmbeddedPiAgent({
    sessionId: "secure-run-1",
    sessionKey,
    sessionFile: path.join(root, "normal-dir", "secure-run-1.jsonl"),
    workspaceDir: path.join(root, "ws"),
    agentDir: path.join(root, "agent"),
    config: {} as InfinibotConfig,
    prompt: "hello",
    provider,
    model,
    timeoutMs: 5_000,
    runId: "secure-run-1",
  });
}

describe("embedded runner in Secure Mode", () => {
  it("fails closed while the secure lane is locked", async () => {
    await expect(run("ollama", "llama3")).rejects.toThrow(/Secure Mode is off/);
  });

  it("refuses a hosted model when no local model is reachable, before any request", async () => {
    await rt.setEnabled(true);
    await expect(run("anthropic", "claude-opus-4-6")).rejects.toThrow(/Blocked by Secure Mode/);
    await expect(run("openai", "gpt-5.2")).rejects.toThrow(/no local model is reachable/);
    // The transcript was redirected to RAM, never created in the normal dir.
    expect(fs.existsSync(path.join(root, "normal-dir"))).toBe(false);
  });
});
