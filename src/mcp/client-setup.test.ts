import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  addInfinibotToClient,
  buildMcpClientEntry,
  mcpClientDefs,
  mcpClientSnippet,
  mcpClientStatus,
  parseJsonc,
  redactMcpEntry,
  stripCodexEntry,
  type McpClientDef,
} from "./client-setup.js";

let home: string;
const entry = buildMcpClientEntry({
  gatewayUrl: "ws://127.0.0.1:18789",
  execPath: "/usr/bin/node",
  entryPath: "/opt/infinibot/dist/cli/mcp-stdio.js",
  electron: false,
  env: {},
});

function defs(): Record<string, McpClientDef> {
  return Object.fromEntries(
    mcpClientDefs({ home, platform: "linux", env: { HOME: home } }).map((d) => [d.id, d]),
  );
}

function write(file: string, content: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function backups(file: string): string[] {
  const dir = path.dirname(file);
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(`${path.basename(file)}.infinibot-backup-`));
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "ib-mcp-home-"));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe("buildMcpClientEntry", () => {
  it("carries no secret, only the URL and the config-auth marker", () => {
    expect(entry).toEqual({
      command: "/usr/bin/node",
      args: ["/opt/infinibot/dist/cli/mcp-stdio.js"],
      env: { MOLTBOT_GATEWAY_URL: "ws://127.0.0.1:18789", INFINIBOT_MCP_AUTH: "config" },
    });
    const electron = buildMcpClientEntry({
      gatewayUrl: "ws://x",
      electron: true,
      env: { INFINIBOT_STATE_DIR: "/s" },
    });
    expect(electron.env.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(electron.env.INFINIBOT_STATE_DIR).toBe("/s");
  });

  it("redacts secret-looking env values", () => {
    const red = redactMcpEntry({
      env: { MOLTBOT_GATEWAY_PASSWORD: "hunter2", MOLTBOT_GATEWAY_URL: "ws://x" },
    });
    expect(red.env.MOLTBOT_GATEWAY_PASSWORD).toBe("••••••");
    expect(red.env.MOLTBOT_GATEWAY_URL).toBe("ws://x");
  });
});

describe("addInfinibotToClient (JSON)", () => {
  it("backs up, merges, and keeps every other server and setting", () => {
    const d = defs()["claude-desktop"]!;
    const before = {
      globalShortcut: "Ctrl+Space",
      mcpServers: {
        github: { command: "gh-mcp", env: { GITHUB_TOKEN: "keep-me" } },
        infinibot: { command: "old", args: ["old.js"], env: { MOLTBOT_GATEWAY_PASSWORD: "x" } },
      },
    };
    write(d.configPath, JSON.stringify(before, null, 2));
    const res = addInfinibotToClient(d, entry, { now: new Date("2026-10-28T10:00:00Z") });
    expect(res.changed).toBe(true);
    expect(res.backupPath).toBeDefined();
    expect(JSON.parse(fs.readFileSync(res.backupPath!, "utf8"))).toEqual(before);
    const after = JSON.parse(fs.readFileSync(d.configPath, "utf8"));
    expect(after.globalShortcut).toBe("Ctrl+Space");
    expect(after.mcpServers.github).toEqual(before.mcpServers.github);
    expect(after.mcpServers.infinibot).toEqual(entry);
    expect(JSON.stringify(after.mcpServers.infinibot)).not.toMatch(/PASSWORD|TOKEN/);

    // Idempotent: second run writes nothing and makes no second backup.
    const again = addInfinibotToClient(d, entry);
    expect(again.changed).toBe(false);
    expect(backups(d.configPath)).toHaveLength(1);
  });

  it("creates a missing config without a backup", () => {
    const d = defs().cursor!;
    const res = addInfinibotToClient(d, entry);
    expect(res).toMatchObject({ changed: true, created: true, backupPath: undefined });
    expect(JSON.parse(fs.readFileSync(d.configPath, "utf8")).mcpServers.infinibot).toEqual(entry);
  });

  it("adds type:stdio for Claude Code and VS Code (servers key, JSONC kept readable)", () => {
    const cc = defs()["claude-code"]!;
    write(
      cc.configPath,
      JSON.stringify({ numStartups: 3, projects: { "/a": {} }, mcpServers: {} }),
    );
    addInfinibotToClient(cc, entry);
    const ccAfter = JSON.parse(fs.readFileSync(cc.configPath, "utf8"));
    expect(ccAfter.numStartups).toBe(3);
    expect(ccAfter.projects).toEqual({ "/a": {} });
    expect(ccAfter.mcpServers.infinibot.type).toBe("stdio");

    const vs = defs().vscode!;
    write(
      vs.configPath,
      `{\n  // my servers\n  "servers": { "other": { "type": "http", "url": "https://x", }, },\n}\n`,
    );
    addInfinibotToClient(vs, entry);
    const vsAfter = JSON.parse(fs.readFileSync(vs.configPath, "utf8"));
    expect(vsAfter.servers.other).toEqual({ type: "http", url: "https://x" });
    expect(vsAfter.servers.infinibot).toEqual({ type: "stdio", ...entry });
  });

  it("refuses to touch an unparseable config", () => {
    const d = defs().cursor!;
    write(d.configPath, "{ not json");
    expect(() => addInfinibotToClient(d, entry)).toThrow(/not valid JSON/);
    expect(fs.readFileSync(d.configPath, "utf8")).toBe("{ not json");
    expect(backups(d.configPath)).toHaveLength(0);
  });

  it("keeps the file mode", () => {
    const d = defs()["claude-code"]!;
    write(d.configPath, "{}");
    fs.chmodSync(d.configPath, 0o600);
    addInfinibotToClient(d, entry);
    expect(fs.statSync(d.configPath).mode & 0o777).toBe(0o600);
  });
});

describe("addInfinibotToClient (Codex TOML)", () => {
  it("replaces only our tables and keeps the rest", () => {
    const d = defs().codex!;
    const before = [
      'model = "gpt-5"',
      "",
      "[mcp_servers.github]",
      'command = "gh-mcp"',
      "",
      "[mcp_servers.infinibot]",
      'command = "old"',
      "",
      "[mcp_servers.infinibot.env]",
      'MOLTBOT_GATEWAY_PASSWORD = "secret"',
      "",
      "[profiles.fast]",
      'model = "mini"',
      "",
    ].join("\n");
    write(d.configPath, before);
    const res = addInfinibotToClient(d, entry);
    expect(res.changed).toBe(true);
    expect(fs.readFileSync(res.backupPath!, "utf8")).toBe(before);
    const after = fs.readFileSync(d.configPath, "utf8");
    expect(after).toContain('model = "gpt-5"');
    expect(after).toContain("[mcp_servers.github]");
    expect(after).toContain("[profiles.fast]");
    expect(after).not.toContain("secret");
    expect(after.match(/\[mcp_servers\.infinibot\]/g)).toHaveLength(1);
    expect(after).toContain('args = ["/opt/infinibot/dist/cli/mcp-stdio.js"]');
    expect(addInfinibotToClient(d, entry).changed).toBe(false);
  });

  it("strips nothing when we were never there", () => {
    expect(stripCodexEntry("[a]\nb = 1\n").had).toBe(false);
  });
});

describe("mcpClientStatus", () => {
  it("detects installs by folder and reports configured/current/secret", () => {
    const d = defs()["claude-code"]!;
    const none = mcpClientStatus(d, entry, { which: () => false });
    expect(none.detected).toBe(false);
    write(
      d.configPath,
      JSON.stringify({
        mcpServers: { infinibot: { args: ["/other.js"], env: { MOLTBOT_GATEWAY_PASSWORD: "x" } } },
      }),
    );
    const old = mcpClientStatus(d, entry, { which: () => false });
    expect(old).toMatchObject({
      detected: true,
      configured: true,
      current: false,
      embedsSecret: true,
    });
    addInfinibotToClient(d, entry);
    expect(mcpClientStatus(d, entry, { which: () => false })).toMatchObject({
      configured: true,
      current: true,
      embedsSecret: false,
    });
  });

  it("flags unreadable configs", () => {
    const d = defs().cursor!;
    write(d.configPath, "nope");
    expect(mcpClientStatus(d, entry, { which: () => false }).unreadable).toMatch(/JSON/);
  });
});

describe("snippets", () => {
  it("renders per-client copy-paste text without secrets", () => {
    for (const id of [
      "generic",
      "claude-code",
      "claude-desktop",
      "cursor",
      "codex",
      "vscode",
    ] as const) {
      const text = mcpClientSnippet(id, entry);
      expect(text).toContain("mcp-stdio.js");
      expect(text).not.toMatch(/PASSWORD|TOKEN/);
    }
    expect(mcpClientSnippet("claude-code", entry)).toMatch(/^claude mcp add --scope user/);
  });

  it("parses JSONC comments and trailing commas without touching strings", () => {
    expect(parseJsonc('{ "a": "http://x//y", /* c */ "b": [1,], }')).toEqual({
      a: "http://x//y",
      b: [1],
    });
  });
});
