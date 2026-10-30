/**
 * Grok Build (xAI `grok`) as a coder backend: argv, output parsing, MCP
 * config.toml writes, registry + id lists, and every enum/schema that picks a
 * coder backend.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CLIAgentConfig } from "../types/agent-types.js";
import {
  GrokCliBackend,
  buildGrokArgsForTest,
  buildGrokLaunch,
  grokMcpTomlLines,
  isInfinibotRegisteredInGrok,
  parseGrokOutput,
  registerInfinibotInGrok,
} from "./grok.js";
import { _clearBackendCache, createCoderBackend } from "./registry.js";
import { CODER_BACKEND_IDS, coderCliCommand, isCoderBackendId } from "./types.js";
import { normalizeCoderModelOverride } from "./model-normalization.js";
import { getStreamParser } from "../coder-runtime/stream-parsers.js";
import { createCliCreditHook } from "./cli-credit-hook.js";

const cfg = (over: Partial<CLIAgentConfig> = {}): CLIAgentConfig => ({
  id: "grok-test",
  name: "Grok test",
  type: "cli",
  cliCommand: "grok",
  autoApprove: false,
  timeoutMinutes: 1,
  ...over,
});

describe("grok coder backend: argv", () => {
  it("headless streaming-json with the prompt last", () => {
    const args = buildGrokArgsForTest(cfg(), "fix the bug");
    expect(args.slice(0, 3)).toEqual(["--output-format", "streaming-json", "--no-auto-update"]);
    expect(args.slice(-2)).toEqual(["-p", "fix the bug"]);
    expect(args).not.toContain("--always-approve");
    expect(args).not.toContain("-m");
  });

  it("model, resume, cwd and extra cliArgs", () => {
    const args = buildGrokArgsForTest(
      cfg({ cliArgs: ["--max-turns", "9"] }),
      "go",
      { model: "grok-4.6", resumeSessionId: "sess-1" },
      "/tmp/repo",
    );
    expect(args).toEqual([
      "--output-format",
      "streaming-json",
      "--no-auto-update",
      "-m",
      "grok-4.6",
      "--resume",
      "sess-1",
      "--cwd",
      "/tmp/repo",
      "--max-turns",
      "9",
      "-p",
      "go",
    ]);
  });

  it("autoApprove → --always-approve", () => {
    expect(buildGrokArgsForTest(cfg({ autoApprove: true }), "go")).toContain("--always-approve");
  });

  it("a prompt past the argv limit goes through --prompt-file", () => {
    const big = "x".repeat(200 * 1024);
    const { args } = buildGrokLaunch(cfg(), big, {}, `grok-test-${process.pid}-${Date.now()}`);
    const i = args.indexOf("--prompt-file");
    expect(i).toBeGreaterThan(-1);
    expect(args).not.toContain("-p");
    expect(fs.readFileSync(args[i + 1], "utf8")).toBe(big);
  });
});

describe("grok coder backend: output", () => {
  it("joins text chunks and takes the session id from end", () => {
    const out = [
      JSON.stringify({ type: "thought", data: "hmm" }),
      JSON.stringify({ type: "text", data: "Hello " }),
      JSON.stringify({ type: "tool_call", toolCallId: "c1", toolName: "read_file", rawInput: {} }),
      JSON.stringify({ type: "text", data: "world" }),
      JSON.stringify({ type: "end", stopReason: "end_turn", sessionId: "s-9", usage: {} }),
    ].join("\n");
    const parsed = parseGrokOutput(out);
    expect(parsed.text).toBe("Hello world");
    expect(parsed.sessionId).toBe("s-9");
    expect(parsed.json?.type).toBe("end");
  });

  it("surfaces an error event", () => {
    const parsed = parseGrokOutput(JSON.stringify({ type: "error", message: "not signed in" }));
    expect(parsed.error).toBe("not signed in");
    expect(parsed.text).toBe("not signed in");
  });
});

describe("grok activity stream parser", () => {
  it("tool calls map to Claude-style names; text flushes at tool boundaries and end", () => {
    const parse = getStreamParser("grok");
    expect(parse(JSON.stringify({ type: "text", data: "Reading" }))).toBeNull();
    const start = parse(
      JSON.stringify({
        type: "tool_call",
        toolCallId: "c1",
        toolName: "read_file",
        rawInput: { path: "/repo/src/main.ts" },
      }),
    );
    expect(start?.toolStarts?.[0]).toMatchObject({ toolCallId: "c1", name: "Read" });
    expect(start?.transcript).toContain("💬 Reading");
    const end = parse(
      JSON.stringify({
        type: "tool_call_update",
        toolCallId: "c1",
        status: "completed",
        rawOutput: "ok",
      }),
    );
    expect(end?.toolEnds?.[0]).toMatchObject({ toolCallId: "c1" });
    const fin = parse(JSON.stringify({ type: "end", stopReason: "end_turn", sessionId: "s-1" }));
    expect(fin?.claudeSessionId).toBe("s-1");
    expect(fin?.activity?.kind).toBe("done");
  });
});

describe("grok credit hook", () => {
  it("records the end event's usage once", () => {
    const hook = createCliCreditHook({ backend: "grok", agentId: "a", taskId: "t" });
    hook.feed(`${JSON.stringify({ type: "usage", usage: { input_tokens: 5 } })}\n`);
    hook.feed(`${JSON.stringify({ type: "end", usage: { input_tokens: 7, output_tokens: 5 } })}\n`);
    hook.end();
    expect(hook.count()).toBe(1);
  });
});

describe("grok MCP config (~/.grok/config.toml)", () => {
  let home: string;
  const prev = process.env.GROK_HOME;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "grok-home-"));
    process.env.GROK_HOME = home;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("renders [mcp_servers.<name>] the way Grok Build reads it", () => {
    expect(grokMcpTomlLines({ command: "node", args: ["a.js"], env: { K: "v" } })).toEqual([
      'command = "node"',
      'args = ["a.js"]',
      'env = { "K" = "v" }',
    ]);
    expect(grokMcpTomlLines({ url: "http://x/mcp", headers: { A: "b" } })).toEqual([
      'url = "http://x/mcp"',
      'headers = { "A" = "b" }',
    ]);
  });

  it("install / list / uninstall keep the user's other settings", async () => {
    fs.writeFileSync(path.join(home, "config.toml"), "[marketplace]\nx = true\n");
    const b = new GrokCliBackend();
    await b.installMcp("demo", { command: "demo-mcp" });
    expect(await b.listInstalledMcps()).toEqual(["demo"]);
    const raw = fs.readFileSync(path.join(home, "config.toml"), "utf8");
    expect(raw).toContain("[marketplace]");
    expect(raw).toContain("[mcp_servers.demo]");
    await b.uninstallMcp("demo");
    expect(await b.listInstalledMcps()).toEqual([]);
    expect(fs.readFileSync(path.join(home, "config.toml"), "utf8")).toContain("[marketplace]");
  });

  it("registerInfinibotInGrok is idempotent", () => {
    const opts = { gatewayUrl: "ws://127.0.0.1:28999", gatewayToken: "t" };
    expect(registerInfinibotInGrok(opts).changed).toBe(true);
    expect(registerInfinibotInGrok(opts).changed).toBe(false);
    expect(isInfinibotRegisteredInGrok().registered).toBe(true);
    expect(fs.readFileSync(path.join(home, "config.toml"), "utf8")).toContain(
      '"MOLTBOT_GATEWAY_URL" = "ws://127.0.0.1:28999"',
    );
  });
});

describe("grok in the coder backend registry and id lists", () => {
  beforeEach(() => _clearBackendCache());

  it("registry builds a GrokCliBackend", () => {
    const b = createCoderBackend("grok");
    expect(b).toBeInstanceOf(GrokCliBackend);
    expect(b.getCapabilities()).toMatchObject({
      id: "grok",
      displayName: "Grok Build",
      supportsMcpConfig: true,
      supportsSessionResume: true,
    });
  });

  it("CODER_BACKEND_IDS / isCoderBackendId / coderCliCommand", () => {
    expect(CODER_BACKEND_IDS).toContain("grok");
    expect(isCoderBackendId("grok")).toBe(true);
    expect(isCoderBackendId("grok-cli")).toBe(false);
    expect(coderCliCommand("grok")).toBe("grok");
    expect(coderCliCommand("claude-code")).toBe("claude");
  });

  it('"grok" as model is a backend name, not a model', () => {
    expect(normalizeCoderModelOverride("grok", "grok").model).toBeUndefined();
    expect(normalizeCoderModelOverride("grok-4.6", "grok").model).toBe("grok-4.6");
  });
});
