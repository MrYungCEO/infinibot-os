import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CODERS_ADMIN_METHODS, CODERS_READ_METHODS } from "./coders.js";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ib-coders-rpc-"));
const prev = {
  state: process.env.INFINIBOT_STATE_DIR,
  agent: process.env.INFINIBOT_AGENT_DIR,
  saas: process.env.SAAS_MODE,
};

beforeAll(() => {
  process.env.INFINIBOT_STATE_DIR = TMP;
  process.env.INFINIBOT_AGENT_DIR = path.join(TMP, "agents", "main", "agent");
  process.env.SAAS_MODE = "0";
});
afterAll(() => {
  for (const [k, v] of [
    ["INFINIBOT_STATE_DIR", prev.state],
    ["INFINIBOT_AGENT_DIR", prev.agent],
    ["SAAS_MODE", prev.saas],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(TMP, { recursive: true, force: true });
});

type Res = { ok: boolean; payload?: any; error?: any };

async function ask(
  method: string,
  scopes: string[],
  params: Record<string, unknown> = {},
  saasNamespace?: string,
): Promise<Res> {
  const { handleGatewayRequest } = await import("../server-methods.js");
  let res: Res = { ok: false };
  await handleGatewayRequest({
    req: { type: "req", id: "1", method, params },
    client: { connect: { role: "operator", scopes }, saasNamespace },
    isWebchatConnect: () => false,
    context: { broadcast: () => {} },
    respond: (ok: boolean, payload?: unknown, error?: unknown) => {
      res = { ok, payload, error };
    },
  } as any);
  return res;
}

describe("coders.* RPC scopes", () => {
  it("read methods are served to read-scoped operators", async () => {
    for (const m of CODERS_READ_METHODS) {
      const r = await ask(m, ["operator.read"]);
      expect(r.error?.message ?? "", m).not.toMatch(/missing scope/);
    }
    const cat = await ask("coders.catalog", ["operator.read"]);
    expect(cat.ok).toBe(true);
    expect(cat.payload.coders.map((c: { id: string }) => c.id)).toContain("claude-code");
  }, 60_000);

  it("install / keys / sign-in are admin-only", async () => {
    for (const m of CODERS_ADMIN_METHODS) {
      const r = await ask(m, ["operator.read", "operator.write"], { id: "codex" });
      expect(r.ok, m).toBe(false);
      expect(r.error.message, m).toMatch(/operator.admin/);
    }
  }, 60_000);

  it("admin can set a key; status reports names only, never values", async () => {
    const secret = "sk-proj-THISISASECRETVALUE123";
    const set = await ask("coders.setKey", ["operator.admin"], {
      id: "codex",
      envVar: "OPENAI_API_KEY",
      key: secret,
    });
    expect(set.ok).toBe(true);
    expect(JSON.stringify(set.payload)).not.toContain(secret);
    const st = await ask("coders.status", ["operator.read"], { id: "codex" });
    expect(st.ok).toBe(true);
    expect(st.payload.coder.keys).toEqual(["OPENAI_API_KEY"]);
    expect(JSON.stringify(st.payload)).not.toContain(secret);
    const bad = await ask("coders.setKey", ["operator.admin"], {
      id: "codex",
      envVar: "LD_PRELOAD",
      key: secret,
    });
    expect(bad.ok).toBe(false);
  }, 60_000);

  it("rejects ids outside the catalog", async () => {
    const r = await ask("coders.install", ["operator.admin"], { id: "../../bin/sh" });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("NOT_FOUND");
  }, 60_000);

  it("a tenant request resolves to that tenant's own root and keys", async () => {
    await ask(
      "coders.setKey",
      ["operator.admin"],
      { id: "gemini", key: "AIzaTENANTAKEY12345678" },
      "tenant-a",
    );
    const a = await ask("coders.status", ["operator.read"], {}, "tenant-a");
    const b = await ask("coders.status", ["operator.read"], {}, "tenant-b");
    expect(a.payload.root).toContain(path.join("tenants", "tenant-a"));
    expect(b.payload.root).toContain(path.join("tenants", "tenant-b"));
    const gemA = a.payload.coders.find((c: { id: string }) => c.id === "gemini");
    const gemB = b.payload.coders.find((c: { id: string }) => c.id === "gemini");
    expect(gemA.keys).toEqual(["GEMINI_API_KEY"]);
    expect(gemB.keys).toEqual([]);
    // The operator's codex key (set outside any tenant above) is not inherited.
    const codexA = a.payload.coders.find((c: { id: string }) => c.id === "codex");
    expect(codexA.keys).toEqual([]);
  }, 60_000);
});
