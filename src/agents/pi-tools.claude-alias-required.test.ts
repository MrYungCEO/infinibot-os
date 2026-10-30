import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { validateToolArguments } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";

import { normalizeExecArgs } from "./bash-tools.exec.js";
import { createInfiniBotCodingTools } from "./pi-tools.js";
import { patchToolSchemaForClaudeCompatibility } from "./pi-tools.read.js";
import { toToolDefinitions } from "./pi-tool-definition-adapter.js";
import type { AnyAgentTool } from "./pi-tools.types.js";

// Live group chat 2026-10-14: gpt-oss members called read with `file_path`,
// edit with `old_string`/`new_string` and exec with `cmd` — every one was
// rejected by schema validation before our alias normalizer could run, so
// each call cost an extra round trip with the duplicated args.

function validates(tool: AnyAgentTool, args: Record<string, unknown>): boolean {
  try {
    validateToolArguments(tool as never, { type: "toolCall", id: "t", name: tool.name, arguments: args } as never);
    return true;
  } catch {
    return false;
  }
}

describe("Claude-style alias schemas", () => {
  it("drops `required` entirely when every required key got an alias", () => {
    const patched = patchToolSchemaForClaudeCompatibility({
      name: "read",
      label: "read",
      description: "",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, limit: { type: "number" } },
        required: ["path"],
      },
      execute: async () => ({ content: [], details: {} }),
    } as unknown as AnyAgentTool);
    const params = patched.parameters as { required?: string[]; properties: Record<string, unknown> };
    expect(params.required).toBeUndefined();
    expect(Object.keys(params.properties)).toContain("file_path");
  });

  it("read/edit/exec accept the Claude Code / codex argument names the models actually send", () => {
    const tools = createInfiniBotCodingTools({ workspaceDir: os.tmpdir() });
    const byName = (n: string) => tools.find((t) => t.name === n)!;
    expect(validates(byName("read"), { file_path: "package.json", limit: 10 })).toBe(true);
    expect(validates(byName("read"), { path: "package.json" })).toBe(true);
    expect(
      validates(byName("edit"), { path: "a.json", old_string: "x", new_string: "y" }),
    ).toBe(true);
    expect(validates(byName("edit"), { file_path: "a.json", oldText: "x", newText: "y" })).toBe(
      true,
    );
    expect(validates(byName("exec"), { cmd: "git status --porcelain", workdir: "/tmp" })).toBe(
      true,
    );
    expect(validates(byName("exec"), { command: "ls" })).toBe(true);
  });

  it("normalizes exec `cmd` (string or argv) to `command` before any wrapper runs", async () => {
    expect(normalizeExecArgs({ cmd: "echo hi" })).toEqual({ command: "echo hi" });
    expect(normalizeExecArgs({ cmd: ["git", "status"] })).toEqual({ command: "git status" });
    expect(normalizeExecArgs({ command: "ls", cmd: "pwd" })).toEqual({ command: "ls" });

    let seen: unknown;
    const [def] = toToolDefinitions([
      {
        name: "exec",
        label: "exec",
        description: "",
        parameters: { type: "object", properties: {} },
        execute: async (_id: string, args: unknown) => {
          seen = args;
          return { content: [{ type: "text", text: "ok" }], details: {} };
        },
      } as unknown as AnyAgentTool,
    ]);
    await def.execute("t1", { cmd: "pwd" } as never, undefined, undefined as never, undefined);
    expect(seen).toEqual({ command: "pwd" });
  });
});

describe("toolCwd (group chat shared repo)", () => {
  it("roots exec/read/write in toolCwd while workspaceDir stays the agent workspace", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "gc-repo-"));
    const agentWs = fs.mkdtempSync(path.join(os.tmpdir(), "gc-ws-"));
    fs.writeFileSync(path.join(repo, "only-in-repo.txt"), "repo file");
    const tools = createInfiniBotCodingTools({ workspaceDir: agentWs, toolCwd: repo });
    const read = tools.find((t) => t.name === "read")!;
    const res = (await read.execute("r1", { path: "only-in-repo.txt" }, undefined as never)) as {
      content: Array<{ text?: string }>;
    };
    expect(res.content[0].text).toContain("repo file");

    const write = tools.find((t) => t.name === "write")!;
    await write.execute("w1", { file_path: "new.txt", content: "hi" }, undefined as never);
    expect(fs.existsSync(path.join(repo, "new.txt"))).toBe(true);
    expect(fs.existsSync(path.join(agentWs, "new.txt"))).toBe(false);

    const exec = tools.find((t) => t.name === "exec")!;
    const out = (await exec.execute("e1", { command: "pwd" }, undefined as never)) as {
      details?: { cwd?: string };
      content: Array<{ text?: string }>;
    };
    expect(out.content[0].text?.trim()).toBe(fs.realpathSync(repo));
  });
});
