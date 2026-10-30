import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// If anything in the secure lane reached for Notion, these would record it.
const notionCalls = vi.hoisted(() => [] as string[]);
vi.mock("../tasks/notion-sync.js", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  const wrapped: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(real)) {
    wrapped[k] =
      typeof v === "function"
        ? (...args: unknown[]) => {
            notionCalls.push(k);
            return (v as (...a: unknown[]) => unknown)(...args);
          }
        : v;
  }
  return wrapped;
});

import { secureModeHandlers } from "../gateway/server-methods/secure-mode.js";
import { setSecureModeBroadcaster } from "./events.js";
import type { ExecFn } from "./keyring.js";
import { SecureModeRuntime, setSecureModeRuntimeForTests } from "./runtime.js";

const MARKER = "SECRET-LANE-MARKER-41c2";

function fakeKeyring(): ExecFn {
  const items = new Map<string, string>();
  return async (cmd, args, opts) => {
    if (cmd !== "secret-tool") return { code: 127, stdout: "", stderr: "" };
    const id = args
      .join("|")
      .replace(/^(lookup|store[^|]*|clear)\|/, "")
      .replace(/--label=[^|]*\|/, "");
    if (args[0] === "lookup") {
      const v = items.get(id);
      return { code: v ? 0 : 1, stdout: v ?? "", stderr: "" };
    }
    if (args[0] === "store") {
      items.set(id, String(opts.input ?? ""));
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
}

async function call(method: string, params: Record<string, unknown> = {}) {
  let out: { ok: boolean; payload?: any; error?: any } = { ok: false };
  await secureModeHandlers[method]!({
    params,
    respond: (ok: boolean, payload?: unknown, error?: unknown) => {
      out = { ok, payload, error };
    },
    context: {} as never,
    client: null as never,
    req: { id: "1", type: "req", method } as never,
    isWebchatConnect: () => false,
  } as never);
  return out;
}

let stateDir: string;
let ramDir: string;
let rt: SecureModeRuntime;
const events: Array<[string, unknown]> = [];

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ib-secure-rt-"));
  ramDir = fs.mkdtempSync(path.join(os.tmpdir(), "ib-secure-ram-"));
  rt = new SecureModeRuntime({
    stateDir,
    env: { INFINIBOT_SECURE_RAM_DIR: ramDir },
    exec: fakeKeyring(),
    sealIntervalMs: 0,
  });
  setSecureModeRuntimeForTests(rt);
  events.length = 0;
  notionCalls.length = 0;
  setSecureModeBroadcaster((event, payload) => events.push([event, payload]));
});

afterEach(() => {
  rt.shutdown();
  setSecureModeRuntimeForTests(null);
  setSecureModeBroadcaster(null);
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.rmSync(ramDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function grepTree(dir: string, needle: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return (fs.readdirSync(dir, { recursive: true }) as string[])
    .map((f) => path.join(dir, f))
    .filter((p) => fs.statSync(p).isFile() && fs.readFileSync(p).includes(Buffer.from(needle)));
}

describe("secure.status / secure.set round-trip", () => {
  it("toggles on and off, persists, and broadcasts secure.mode.changed", async () => {
    const before = await call("secure.status");
    expect(before.ok).toBe(true);
    expect(before.payload).toMatchObject({ enabled: false, unlocked: false });

    const on = await call("secure.set", { enabled: true });
    expect(on.ok).toBe(true);
    expect(on.payload).toMatchObject({ enabled: true, unlocked: true, keySource: "secret-tool" });
    expect(events.at(-1)?.[0]).toBe("secure.mode.changed");
    expect(events.at(-1)?.[1]).toMatchObject({ enabled: true });
    expect((await call("secure.status")).payload).toMatchObject({ enabled: true, unlocked: true });
    expect(
      JSON.parse(fs.readFileSync(path.join(stateDir, "secure", "state.json"), "utf8")),
    ).toMatchObject({ enabled: true });

    const off = await call("secure.set", { enabled: false });
    expect(off.payload).toMatchObject({ enabled: false, unlocked: false });
    expect(events.at(-1)?.[1]).toMatchObject({ enabled: false });
  });

  it("is unavailable where local providers are off (InfiniBot Cloud): status says so, enabling is refused", async () => {
    vi.stubEnv("LOCAL_PROVIDERS_ENABLED", "0");
    try {
      const st = await call("secure.status");
      expect(st.ok).toBe(true);
      expect(st.payload.available).toBe(false);
      expect(st.payload.unavailableReason).toMatch(/InfiniBot Cloud/);
      const on = await call("secure.set", { enabled: true });
      expect(on.ok).toBe(false);
      expect(on.error.code).toBe("UNAVAILABLE");
      expect(rt.isUnlocked()).toBe(false);
      // Turning it off stays allowed.
      expect((await call("secure.set", { enabled: false })).ok).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("rejects a non-boolean and fails closed on lane RPCs while off", async () => {
    expect((await call("secure.set", { enabled: "yes" })).ok).toBe(false);
    const locked = await call("secure.kanban.list");
    expect(locked.ok).toBe(false);
    expect(locked.error).toMatchObject({ code: "SECURE_MODE_LOCKED" });
  });

  it("restores the persisted state after a restart (new runtime, same keyring)", async () => {
    await call("secure.set", { enabled: true });
    await call("secure.kanban.tasks.create", { title: "survives restart" });
    const exec = (rt as unknown as { exec: ExecFn }).exec;
    rt.shutdown();
    const rt2 = new SecureModeRuntime({
      stateDir,
      env: { INFINIBOT_SECURE_RAM_DIR: ramDir },
      exec,
      sealIntervalMs: 0,
    });
    setSecureModeRuntimeForTests(rt2);
    expect((await rt2.init()).unlocked).toBe(true);
    expect(
      (await call("secure.kanban.list")).payload.tasks.map((t: { title: string }) => t.title),
    ).toEqual(["survives restart"]);
    rt2.shutdown();
  });
});

describe("secure lane isolation", () => {
  it("keeps secure tasks out of the normal stores and away from Notion", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await call("secure.set", { enabled: true });
    const p = await call("secure.kanban.projects.create", { name: "Secure Mode" });
    const t = await call("secure.kanban.tasks.create", {
      title: MARKER,
      projectId: p.payload.project.id,
    });
    expect(t.ok).toBe(true);
    const u = await call("secure.kanban.tasks.update", {
      id: t.payload.task.id,
      patch: { status: "in_progress" },
    });
    expect(u.payload.task.status).toBe("in_progress");
    await call("secure.docs.create", { title: MARKER, content: MARKER });
    const n = await call("secure.graph.nodes.create", { label: MARKER });
    await call("secure.graph.link", {
      source: n.payload.node.id,
      target: `secure:task:${t.payload.task.id}`,
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(notionCalls).toEqual([]);
    // Nothing but the secure dir exists: no kanban.db / databases.db / documents/ writes.
    expect(fs.readdirSync(stateDir)).toEqual(["secure"]);
    expect(grepTree(stateDir, MARKER)).toEqual([]);
    expect(events.filter(([e]) => e === "secure.lane.changed").length).toBeGreaterThanOrEqual(5);
    for (const [, payload] of events) expect(JSON.stringify(payload)).not.toContain(MARKER);

    const snap = await call("secure.graph.snapshot");
    expect(snap.payload.lane).toBe("secure");
    expect(snap.payload.nodes.some((x: { label: string }) => x.label === MARKER)).toBe(true);
  });

  it("seals RAM transcripts into the vault on lock and restores them on unlock", async () => {
    await call("secure.set", { enabled: true });
    const file = rt.transcriptPath("sess-1");
    expect(file.startsWith(ramDir)).toBe(true);
    fs.writeFileSync(file, `${JSON.stringify({ message: { role: "user", content: MARKER } })}\n`);
    await call("secure.set", { enabled: false });
    expect(fs.existsSync(file)).toBe(false);
    expect(grepTree(stateDir, MARKER)).toEqual([]);
    expect(fs.readdirSync(path.join(stateDir, "secure", "vault"))).toContain("t-sess-1.ibsec");
    await call("secure.set", { enabled: true });
    expect(fs.readFileSync(file, "utf8")).toContain(MARKER);
  });

  it("checks models and tools without running anything", async () => {
    const res = await call("secure.check", {
      model: "anthropic/claude-opus-4-6",
      tool: "web_fetch",
    });
    expect(res.payload.model.allowed).toBe(false);
    expect(res.payload.tool.allowed).toBe(false);
    expect(res.payload.tool.reason).toMatch(/Blocked by Secure Mode/);
  });
});
