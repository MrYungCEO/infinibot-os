import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  setVoiceCliHostForTests,
  voiceCliRouteHandlers,
} from "../server-methods/voice-cli-route.js";
import { interruptKeysFor } from "./voice-cli-output.js";
import { setVoiceCliRouteFileForTests } from "./voice-cli-route.js";
import {
  listVoiceCliCatalogue,
  openCliSessionPort,
  startVoiceCliSession,
  type VoiceCliHost,
} from "./voice-cli-sessions.js";
import { resetVoiceCliTurnsForTests } from "./voice-cli-turn.js";

type Term = {
  id: string;
  title: string;
  cwd: string;
  cliType?: string;
  outputBuffer: string;
  alive: boolean;
};

function fakeHost(
  opts: {
    bins?: string[];
    onWrite?: (id: string, data: string, emit: (chunk: string) => void) => void;
  } = {},
) {
  const terms = new Map<string, Term>();
  const writes: Array<[string, string]> = [];
  const coderMsgs: Array<[string, string]> = [];
  const invoked: Array<[string, string]> = [];
  const listeners = new Map<string, Set<(c: string) => void>>();
  let n = 0;
  terms.set("term-a", {
    id: "term-a",
    title: "Claude · api",
    cwd: "/repo/api",
    cliType: "claude",
    outputBuffer: "",
    alive: true,
  });
  terms.set("term-b", { id: "term-b", title: "zsh", cwd: "/home", outputBuffer: "", alive: true });
  terms.set("term-dead", {
    id: "term-dead",
    title: "old",
    cwd: "/",
    outputBuffer: "",
    alive: false,
  });
  terms.set("spawn-run1", {
    id: "spawn-run1",
    title: "coder",
    cwd: "/repo/web",
    outputBuffer: "",
    alive: true,
  });
  const runs = [
    {
      runId: "run1",
      label: "fix login",
      task: "fix the login bug",
      workdir: "/repo/web",
      coderBackend: "codex",
      terminalId: "spawn-run1",
      running: true,
    },
    { runId: "run0", label: "old run", workdir: "/x", coderBackend: "claude-code", running: false },
  ];
  const host: VoiceCliHost = {
    listTerminals: () =>
      [...terms.values()].map((t) => ({
        id: t.id,
        title: t.title,
        cwd: t.cwd,
        cliType: t.cliType,
      })),
    getTerminal: (id) => terms.get(id),
    isTerminalAlive: (id) => !!terms.get(id)?.alive,
    write: (id, d) => {
      writes.push([id, d]);
      opts.onWrite?.(id, d, (chunk) => {
        for (const listener of listeners.get(id) ?? []) listener(chunk);
      });
    },
    subscribeOutput: (id, cb) => {
      const s = listeners.get(id) ?? new Set();
      s.add(cb);
      listeners.set(id, s);
      return () => s.delete(cb);
    },
    createTerminal: async (o) => {
      const id = o.id ?? `term-new${++n}`;
      terms.set(id, { id, title: o.title ?? id, cwd: o.cwd ?? "/", outputBuffer: "", alive: true });
      return { success: true, terminalId: id };
    },
    invokeAgentCli: async (id, cli) => {
      invoked.push([id, cli]);
      const t = terms.get(id);
      if (t) t.cliType = cli;
    },
    listDetached: async () => [
      { id: "term-tmux", cwd: "/srv", label: "survivor", cliType: "opencode" },
    ],
    capturePane: async () => "",
    listCoderRuns: () => runs,
    sendToCoder: async (runId, text) => {
      coderMsgs.push([runId, text]);
      return { ok: true, status: "queued" };
    },
    resolveBin: (bin) =>
      (opts.bins ?? ["claude", "codex", "aider"]).includes(bin) ? `/usr/bin/${bin}` : undefined,
    coderBackendId: () => "codex",
  };
  return { host, terms, writes, coderMsgs, invoked };
}

describe("catalogue", () => {
  it("lists live terminals, running coder runs, tmux survivors and installed CLIs", async () => {
    const { host } = fakeHost();
    const c = await listVoiceCliCatalogue(host);
    expect(c.open.map((o) => `${o.kind}:${o.id}:${o.status}`)).toEqual([
      "coder:run1:running",
      "terminal:term-a:live",
      "terminal:term-b:live",
      "terminal:term-tmux:detached",
    ]);
    expect(c.open[0]).toMatchObject({ cliType: "codex", cwd: "/repo/web", label: "fix login" });
    expect(c.open[1]).toMatchObject({ cliType: "claude", cwd: "/repo/api" });
    expect(c.open[2]).toMatchObject({ cliType: "shell" });
    expect(c.installed.map((i) => i.id)).toEqual(["claude", "codex", "aider"]);
    expect(c.installed.find((i) => i.id === "codex")?.coderBackend).toBe(true);
    expect(c.missing).toContain("opencode");
    expect(c.runtime).toBe("local");
  });

  it("reports a clear tenant-container empty state without inventing host CLIs", async () => {
    const { host } = fakeHost({ bins: [] });
    const isolated: VoiceCliHost = {
      ...host,
      listTerminals: () => [],
      listDetached: async () => [],
      listCoderRuns: () => [],
    };
    const c = await listVoiceCliCatalogue(isolated, { cloud: true });
    expect(c).toMatchObject({
      open: [],
      installed: [],
      runtime: "tenant-container",
      unavailableReason: "No CLI available on Cloud for this workspace.",
    });
  });

  it("starts a new session in a cwd: managed CLIs via invokeAgentCli, others typed", async () => {
    const { host, invoked, writes } = fakeHost();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "vcs-"));
    const t = await startVoiceCliSession(host, { cli: "claude", cwd });
    expect(t).toMatchObject({ kind: "terminal", cliType: "claude", cwd });
    expect(invoked).toEqual([[t.terminalId, "claude"]]);
    const a = await startVoiceCliSession(host, { cli: "aider", cwd });
    expect(writes).toContainEqual([a.terminalId, "aider\r"]);
    await expect(startVoiceCliSession(host, { cli: "opencode" })).rejects.toThrow(/not installed/);
    await expect(
      startVoiceCliSession(host, { cli: "claude", cwd: "/no/such/dir" }),
    ).rejects.toThrow(/folder not found/);
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});

describe("session port", () => {
  it("terminal: words then Enter, keys raw, interrupt per CLI", async () => {
    const { host, writes } = fakeHost();
    const p = (await openCliSessionPort(
      host,
      { kind: "terminal", terminalId: "term-a", cliType: "claude", label: "api" },
      { interruptKeys: interruptKeysFor },
    ))!;
    await p.send("run the\ntests");
    expect(writes).toEqual([
      ["term-a", "run the tests"],
      ["term-a", "\r"],
    ]);
    await p.keys("1");
    expect(await p.interrupt()).toBe("keys");
    expect(writes.slice(-2)).toEqual([
      ["term-a", "1"],
      ["term-a", "\x1b"],
    ]);
  });

  it("terminal: a startup question on screen is answered before the words are typed", async () => {
    const { host, writes } = fakeHost();
    let screen =
      "Quick safety check: Is this a project you created or one you trust?\n❯ No, exit\n  Yes, I trust this folder";
    host.screen = async () => screen;
    host.paneCommand = async () => "claude";
    const origWrite = host.write.bind(host);
    host.write = (id, d) => {
      origWrite(id, d);
      if (d === "\x1b[B\r") screen = "❯ \n⏵⏵ bypass permissions on";
    };
    const p = (await openCliSessionPort(
      host,
      { kind: "terminal", terminalId: "term-a", cliType: "claude", label: "api" },
      { interruptKeys: interruptKeysFor },
    ))!;
    await p.send("hello");
    expect(writes).toEqual([
      ["term-a", "\x1b[B\r"],
      ["term-a", "hello"],
      ["term-a", "\r"],
    ]);
  });

  it("terminal: the CLI exiting back to the shell makes the session not alive", async () => {
    const { host } = fakeHost();
    let cmd = "claude";
    host.paneCommand = async () => cmd;
    const p = (await openCliSessionPort(
      host,
      { kind: "terminal", terminalId: "term-a", cliType: "claude", label: "api" },
      { interruptKeys: interruptKeysFor },
    ))!;
    expect(await p.isAlive()).toBe(true);
    cmd = "bash";
    expect(await p.isAlive()).toBe(false);
    // A plain shell session is alive at its prompt.
    const sh = (await openCliSessionPort(
      host,
      { kind: "terminal", terminalId: "term-b", cliType: "shell", label: "zsh" },
      { interruptKeys: interruptKeysFor },
    ))!;
    expect(await sh.isAlive()).toBe(true);
  });

  it("start: waits until the CLI is up, answering its trust question", async () => {
    const { host, writes } = fakeHost();
    let screen = "$ claude";
    let cmd = "bash";
    host.paneCommand = async () => cmd;
    host.screen = async () => screen;
    const origInvoke = host.invokeAgentCli.bind(host);
    host.invokeAgentCli = async (id, cli) => {
      await origInvoke(id, cli);
      setTimeout(() => {
        cmd = "claude";
        screen = "Do you trust the files in this folder?\n❯ 1. Yes, proceed\n  2. No, exit";
      }, 100);
    };
    const origWrite = host.write.bind(host);
    host.write = (id, d) => {
      origWrite(id, d);
      if (d === "\r") screen = "Claude Code\n❯ \n? for shortcuts";
    };
    const t = await startVoiceCliSession(host, { cli: "claude", cwd: os.tmpdir() });
    expect(writes.map(([, d]) => d)).toEqual(["\r"]);
    expect(t).toMatchObject({ kind: "terminal", cliType: "claude" });
  }, 10_000);

  it("coder run: words through the inbox, interrupt is a stop request (never a kill)", async () => {
    const { host, coderMsgs } = fakeHost();
    const p = (await openCliSessionPort(
      host,
      { kind: "coder", runId: "run1", label: "fix login" },
      { interruptKeys: interruptKeysFor },
    ))!;
    expect(p.acceptsKeys).toBe(false);
    expect(await p.isAlive()).toBe(true);
    await p.send("also add a test");
    expect(await p.interrupt()).toBe("inbox");
    expect(coderMsgs[0]).toEqual(["run1", "also add a test"]);
    expect(coderMsgs[1][1]).toMatch(/^STOP:/);
  });

  it("an ended / unknown session has no port", async () => {
    const { host } = fakeHost();
    expect(
      await openCliSessionPort(
        host,
        { kind: "coder", runId: "nope", label: "x" },
        { interruptKeys: interruptKeysFor },
      ),
    ).toBeNull();
    const dead = await openCliSessionPort(
      host,
      { kind: "terminal", terminalId: "term-dead", label: "x" },
      { interruptKeys: interruptKeysFor },
    );
    expect(await dead!.isAlive()).toBe(false);
  });
});

describe("voice.cliRoute RPCs", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "vcr-rpc-"));
    setVoiceCliRouteFileForTests(path.join(dir, "route.json"));
    resetVoiceCliTurnsForTests();
  });
  afterEach(() => {
    setVoiceCliHostForTests(null);
    setVoiceCliRouteFileForTests(null);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function call(method: string, params: unknown) {
    let out: { ok: boolean; payload?: any; error?: any } = { ok: false };
    await (voiceCliRouteHandlers as any)[method]({
      params,
      respond: (ok: boolean, payload?: unknown, error?: unknown) => (out = { ok, payload, error }),
    });
    return out;
  }

  it("set → get round-trips; a dead session is refused; api switches back", async () => {
    const { host } = fakeHost();
    setVoiceCliHostForTests(host);
    expect((await call("voice.cliRoute.get", {})).payload.route.mode).toBe("api");
    const ok = await call("voice.cliRoute.set", {
      mode: "cli",
      target: { kind: "terminal", terminalId: "term-a", cliType: "claude", label: "api" },
    });
    expect(ok.ok).toBe(true);
    expect(ok.payload).toMatchObject({
      route: { mode: "cli", target: { terminalId: "term-a" } },
      alive: true,
    });
    const dead = await call("voice.cliRoute.set", {
      mode: "cli",
      target: { kind: "terminal", terminalId: "term-dead", label: "old" },
    });
    expect(dead.ok).toBe(false);
    expect((await call("voice.cliRoute.set", { mode: "api" })).payload.route).toMatchObject({
      mode: "api",
      target: { terminalId: "term-a" },
    });
  });

  it("test turn is refused on the API route (never a billed LLM call)", async () => {
    setVoiceCliHostForTests(fakeHost().host);
    const r = await call("voice.cliRoute.test", { text: "hello" });
    expect(r.ok).toBe(false);
    expect(r.error.message).toMatch(/API LLM/);
  });

  it("start opens a session and routes to it", async () => {
    const { host } = fakeHost();
    setVoiceCliHostForTests(host);
    const r = await call("voice.cliRoute.start", { cli: "codex", cwd: os.tmpdir() });
    expect(r.ok).toBe(true);
    expect(r.payload.route).toMatchObject({
      mode: "cli",
      target: { kind: "terminal", cliType: "codex" },
    });
  });

  it("runs the mock RPC route end-to-end: clean output, no relay ack, voice approval", async () => {
    let pending = "";
    const { host } = fakeHost({
      onWrite: (_id, data, emit) => {
        if (data === "\r") {
          const command = pending;
          pending = "";
          if (command === "confirm the mock route") {
            setTimeout(
              () =>
                emit(
                  `${command}\r\n\x1b[1mClean mock answer.\x1b[0m\r\nProceed with mock work? [y/N] `,
                ),
              5,
            );
          }
          return;
        }
        if (data === "y\r") {
          setTimeout(() => emit("y\r\nApproved work complete.\r\n$ "), 5);
          return;
        }
        pending += data;
      },
    });
    setVoiceCliHostForTests(host);

    const selected = await call("voice.cliRoute.set", {
      mode: "cli",
      target: { kind: "terminal", terminalId: "term-a", cliType: "shell", label: "mock" },
    });
    expect(selected).toMatchObject({ ok: true, payload: { alive: true } });

    const first = await call("voice.cliRoute.test", { text: "confirm the mock route" });
    expect(first.ok).toBe(true);
    const firstSpoken = first.payload.spoken.map((part: { text: string }) => part.text).join("");
    expect(firstSpoken).toMatch(/^Clean mock answer\./);
    expect(firstSpoken).not.toMatch(/sending (that )?to|passing that/i);
    expect(first.payload.text).toBe(
      "Clean mock answer.\nThe terminal asks: Proceed with mock work? Say yes or no.",
    );
    expect(first.payload.text).not.toContain("\x1b");
    expect(first.payload.approval.question).toContain("Proceed with mock work?");

    const approved = await call("voice.cliRoute.test", { text: "yes" });
    expect(approved.ok).toBe(true);
    expect(approved.payload.spoken.map((part: { text: string }) => part.text).join("")).toMatch(
      /^Approved\./,
    );
    expect(approved.payload.text).toBe("Approved work complete.");
    expect(approved.payload.approval).toBeUndefined();
  });
});

describe("catalogue after a restart", () => {
  it("a re-adopted terminal without a saved CLI type is named by what runs in its pane", async () => {
    const { host } = fakeHost();
    host.paneCommand = async (id) => (id === "term-b" ? "codex" : "bash");
    const cat = await listVoiceCliCatalogue(host);
    expect(cat.open.find((s) => s.id === "term-b")?.cliType).toBe("codex");
    expect(cat.open.find((s) => s.id === "term-a")?.cliType).toBe("claude");
  });
});
