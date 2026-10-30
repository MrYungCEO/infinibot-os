import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { friendlyError } from "../local-setup/plan.js";
import {
  chooseBackend,
  nativeFailureKind,
  parseBackendPref,
  preferBundledDlls,
  probeNativeOnnx,
} from "./backend.js";
import {
  VoiceEngineSupervisor,
  claimEnginePort,
  isOurEngineHealth,
  shouldFallBackToWasm,
} from "./supervisor.js";

// The exact error the 2026.10.18 desktop app hit on a Windows laptop.
const DLL_INIT =
  "A dynamic link library (DLL) initialization routine failed.\r\n\\\\?\\C:\\Program Files\\InfiniBot\\resources\\app\\node_modules\\onnxruntime-node\\bin\\napi-v3\\win32\\x64\\onnxruntime_binding.node";

describe("backend selection", () => {
  it("uses native when onnxruntime-node loads", () => {
    const c = chooseBackend("auto", () => ({ ok: true }));
    expect(c.backend).toBe("native");
  });

  it("falls back to wasm when the native runtime fails to load", () => {
    const c = chooseBackend("auto", () =>
      probeNativeOnnx(() => {
        throw new Error(DLL_INIT);
      }),
    );
    expect(c.backend).toBe("wasm");
    expect(c.reason).toMatch(/Visual C\+\+ runtime is out of date/);
    expect(c.reason).not.toMatch(/onnxruntime_binding|\\\\/);
    expect(c.detail).toContain("onnxruntime_binding.node");
  });

  it("honours a forced backend without probing", () => {
    let probed = false;
    const c = chooseBackend("wasm", () => {
      probed = true;
      return { ok: true };
    });
    expect(c.backend).toBe("wasm");
    expect(probed).toBe(false);
    // "native" still reports a failure as wasm (the engine itself can't do better in-process)
    expect(chooseBackend("native", () => ({ ok: false, error: "x" })).backend).toBe("wasm");
  });

  it("treats a module without InferenceSession as broken", () => {
    expect(probeNativeOnnx(() => ({})).ok).toBe(false);
    expect(probeNativeOnnx(() => ({ InferenceSession: class {} })).ok).toBe(true);
  });

  it("parses the preference", () => {
    expect(parseBackendPref("wasm")).toBe("wasm");
    expect(parseBackendPref("native")).toBe("native");
    expect(parseBackendPref("gpu")).toBe("auto");
    expect(parseBackendPref(undefined)).toBe("auto");
  });

  it("names the failure in plain words", () => {
    expect(nativeFailureKind(DLL_INIT)).toMatch(/out of date/);
    expect(nativeFailureKind("No access to memory location.")).toMatch(/out of date/);
    expect(nativeFailureKind("The specified module could not be found.")).toMatch(/missing/);
    expect(nativeFailureKind("The specified procedure could not be found.")).toMatch(
      /another program/,
    );
    expect(nativeFailureKind("weird")).toBe("the native runtime didn't start");
  });

  it("puts the onnxruntime folder first on the Windows PATH, once", () => {
    const env: NodeJS.ProcessEnv = { Path: "C:\\Windows\\System32;C:\\Windows" };
    const resolve = () => "C:\\app\\node_modules\\onnxruntime-node\\package.json";
    const dir = preferBundledDlls(resolve, env, "win32", "x64");
    expect(dir).toBe("C:\\app\\node_modules\\onnxruntime-node\\bin\\napi-v3\\win32\\x64");
    expect(env.Path!.split(";")[0]).toBe(dir);
    preferBundledDlls(resolve, env, "win32", "x64");
    expect(env.Path!.split(";").filter((p) => p === dir)).toHaveLength(1);
    expect(preferBundledDlls(resolve, {}, "linux", "x64")).toBeNull();
  });
});

describe("plain errors", () => {
  it("never shows the DLL path, and says what to do", () => {
    const f = friendlyError(
      `voice engine did not answer at http://127.0.0.1:8886 (health timed out): ${DLL_INIT}`,
    );
    expect(f.code).toBe("vcredist");
    for (const t of [f.title, f.message, f.action]) {
      expect(t).not.toMatch(/onnxruntime_binding|\.node|\\\\\?/);
    }
    expect(f.action).toMatch(/vc_redist/);
  });
});

describe("fallback decision", () => {
  const base = {
    pref: "auto" as const,
    backend: null,
    everReady: false,
    stopping: false,
    loadFailed: false,
    exitCode: 3 as number | null,
  };
  it("retries on wasm after a native load failure or crash before ready", () => {
    expect(shouldFallBackToWasm({ ...base, loadFailed: true })).toBe(true);
    expect(shouldFallBackToWasm({ ...base, exitCode: null })).toBe(true); // killed by a signal
    expect(shouldFallBackToWasm({ ...base, exitCode: 3221225477 })).toBe(true); // 0xC0000005
  });
  it("does not retry when it makes no sense", () => {
    expect(shouldFallBackToWasm({ ...base, everReady: true })).toBe(false);
    expect(shouldFallBackToWasm({ ...base, stopping: true })).toBe(false);
    expect(shouldFallBackToWasm({ ...base, pref: "wasm" })).toBe(false);
    expect(shouldFallBackToWasm({ ...base, pref: "native" })).toBe(false);
    expect(shouldFallBackToWasm({ ...base, backend: "wasm", loadFailed: true })).toBe(false);
    expect(shouldFallBackToWasm({ ...base, exitCode: 0 })).toBe(false);
  });
});

describe("single instance", () => {
  it("recognises our engine's /health, old and new", () => {
    expect(isOurEngineHealth({ engine: "infinibot-voice", pid: 5 })).toBe(true);
    expect(isOurEngineHealth({ tts: false, stt: false, sttModel: "x", pid: 7 })).toBe(true);
    expect(isOurEngineHealth({ status: "ok" })).toBe(false);
    expect(isOurEngineHealth({ engine: "infinibot-voice", pid: 0 })).toBe(false);
    expect(isOurEngineHealth(null)).toBe(false);
  });

  const fakeDeps = (answers: unknown[]) => {
    const killed: number[] = [];
    let i = 0;
    return {
      killed,
      deps: {
        fetchFn: (async () => {
          const a = answers[Math.min(i++, answers.length - 1)];
          if (a === null) throw new Error("ECONNREFUSED");
          return new Response(JSON.stringify(a));
        }) as typeof fetch,
        kill: (pid: number) => void killed.push(pid),
        sleep: async () => {},
      },
    };
  };

  it("stops a stray engine on the port and waits until the port is free", async () => {
    const { deps, killed } = fakeDeps([
      { engine: "infinibot-voice", pid: 22944, status: "error" },
      { engine: "infinibot-voice", pid: 22944, status: "error" },
      null,
    ]);
    expect(await claimEnginePort("http://127.0.0.1:8886", null, deps)).toBe("free");
    expect(killed).toEqual([22944]);
  });

  it("never kills another program on the port", async () => {
    const { deps, killed } = fakeDeps([{ hello: "world" }]);
    expect(await claimEnginePort("http://127.0.0.1:8886", null, deps)).toBe("foreign");
    expect(killed).toEqual([]);
  });

  it("leaves a free port alone", async () => {
    const { deps, killed } = fakeDeps([null]);
    expect(await claimEnginePort("http://127.0.0.1:8886", null, deps)).toBe("free");
    expect(killed).toEqual([]);
  });
});

/**
 * Supervisor end-to-end with a fake engine process: the "native" run reports a
 * DLL load error and then hangs instead of exiting (what left pid 22944 alive);
 * the supervisor must kill it, relaunch once on wasm, and never run two at once.
 */
describe("supervisor with a fake engine", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ib-voice-sup-"));
  const runs = path.join(tmp, "runs.log");
  const fake = path.join(tmp, "fake-engine.cjs");
  fs.writeFileSync(
    fake,
    `
const http = require("node:http");
const fs = require("node:fs");
const a = process.argv;
const port = Number(a[a.indexOf("--port") + 1]);
const backend = a[a.indexOf("--backend") + 1];
const pidOffset = a.includes("--pid-offset") ? Number(a[a.indexOf("--pid-offset") + 1]) : 0;
fs.appendFileSync(${JSON.stringify(runs)}, "start " + process.pid + " " + backend + "\\n");
const state = { ready: false, error: null };
const server = http.createServer((q, r) => {
  r.writeHead(state.ready ? 200 : 503, { "content-type": "application/json" });
  r.end(JSON.stringify({ engine: "infinibot-voice", pid: process.pid + pidOffset, backend, status: state.ready ? "ok" : "loading", tts: state.ready, stt: state.ready, sttModel: "m" }));
});
server.listen(port, "127.0.0.1", () => {
  if (backend === "wasm") {
    state.ready = true;
    process.send({ type: "ready", sttDevice: "wasm", backend: "wasm", backendReason: "fallback" });
  } else {
    process.send({ type: "error", error: ${JSON.stringify(DLL_INIT)}, backend: "native" });
    // Simulate a process stuck in exit that still holds the port.
    setInterval(() => {}, 1000);
  }
});
process.on("disconnect", () => {});
`,
  );

  let sup: VoiceEngineSupervisor | null = null;
  afterEach(() => sup?.stop());

  it("kills the stuck native engine, restarts on wasm, one process at a time", async () => {
    const port = await new Promise<number>((resolve) => {
      const s = http.createServer().listen(0, "127.0.0.1", () => {
        const p = (s.address() as { port: number }).port;
        s.close(() => resolve(p));
      });
    });
    const lines: string[] = [];
    sup = new VoiceEngineSupervisor(
      (l) => lines.push(l),
      undefined,
      () => ({ cmd: process.execPath, args: [fake] }),
    );
    sup.start({ port, modelsDir: tmp, sttRepo: "m" });
    const ok = await sup.waitReady(20_000);
    expect(ok).toBe(true);
    expect(sup.state.backend).toBe("wasm");
    expect(sup.state.status).toBe("running");
    const started = fs.readFileSync(runs, "utf8").trim().split("\n");
    expect(started.map((l) => l.split(" ")[2])).toEqual(["auto", "wasm"]);
    const firstPid = Number(started[0]!.split(" ")[1]);
    expect(() => process.kill(firstPid, 0)).toThrow(); // the stuck one is gone
    expect(lines.join("\n")).toMatch(/compatibility engine/);

    // Starting again with the same config must not spawn a second engine.
    sup.start({ port, modelsDir: tmp, sttRepo: "m" });
    await new Promise((r) => setTimeout(r, 500));
    expect(fs.readFileSync(runs, "utf8").trim().split("\n")).toHaveLength(2);
  }, 30_000);

  it("is ready even when the engine reports a different pid than child.pid (Wine)", async () => {
    fs.writeFileSync(runs, "");
    const port = await new Promise<number>((resolve) => {
      const s = http.createServer().listen(0, "127.0.0.1", () => {
        const p = (s.address() as { port: number }).port;
        s.close(() => resolve(p));
      });
    });
    sup = new VoiceEngineSupervisor(
      () => {},
      undefined,
      () => ({ cmd: process.execPath, args: [fake, "--pid-offset", "100000"] }),
    );
    sup.start({ port, modelsDir: tmp, sttRepo: "m", backend: "wasm" });
    const t0 = Date.now();
    expect(await sup.waitReady(20_000)).toBe(true);
    expect(Date.now() - t0).toBeLessThan(10_000);
  }, 30_000);

  it("replaces a stray engine left on the port by an earlier gateway", async () => {
    fs.writeFileSync(runs, "");
    const port = await new Promise<number>((resolve) => {
      const s = http.createServer().listen(0, "127.0.0.1", () => {
        const p = (s.address() as { port: number }).port;
        s.close(() => resolve(p));
      });
    });
    const entry = () => ({ cmd: process.execPath, args: [fake] });
    const first = new VoiceEngineSupervisor(() => {}, undefined, entry);
    first.start({ port, modelsDir: tmp, sttRepo: "m", backend: "wasm" });
    expect(await first.waitReady(20_000)).toBe(true);
    const strayPid = first.state.pid!;
    // Simulate the old gateway vanishing without stopping its engine.
    (first as unknown as { child: unknown }).child = null;

    sup = new VoiceEngineSupervisor(() => {}, undefined, entry);
    sup.start({ port, modelsDir: tmp, sttRepo: "m", backend: "wasm" });
    expect(await sup.waitReady(20_000)).toBe(true);
    expect(sup.state.pid).not.toBe(strayPid);
    await new Promise((r) => setTimeout(r, 300));
    expect(() => process.kill(strayPid, 0)).toThrow();
  }, 30_000);
});
