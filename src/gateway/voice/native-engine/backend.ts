/**
 * Which ONNX runtime the built-in voice engine runs on.
 *
 *   native  onnxruntime-node (C++; fastest, can use DirectML/CUDA)
 *   wasm    onnxruntime-web's WebAssembly CPU backend (slower, but has no DLLs,
 *           so it works on any computer Node runs on)
 *
 * On Windows the native runtime fails to load on machines whose Microsoft
 * Visual C++ runtime is older than the one onnxruntime was built with
 * (onnxruntime 1.21 + msvcp140 14.29 crashes inside DllMain →
 * "A dynamic link library (DLL) initialization routine failed"), or when it
 * is missing ("The specified module could not be found"). The desktop
 * installer ships the runtime DLLs next to onnxruntime_binding.node, and
 * whatever still fails falls back to wasm here instead of failing voice setup.
 */

import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

export type BackendPref = "auto" | "native" | "wasm";
export type OnnxBackend = "native" | "wasm";

export interface BackendChoice {
  backend: OnnxBackend;
  /** Plain-language reason, safe to show in the UI. */
  reason: string;
  /** Raw load error (logs only, never the UI). */
  detail?: string;
}

export function parseBackendPref(v: unknown): BackendPref {
  return v === "native" || v === "wasm" ? v : "auto";
}

/** Load onnxruntime-node and report whether it works. Never throws. */
export function probeNativeOnnx(
  load: () => unknown = () => createRequire(import.meta.url)("onnxruntime-node"),
): { ok: true } | { ok: false; error: string } {
  try {
    const ort = load() as { InferenceSession?: unknown } | null;
    if (!ort || typeof ort !== "object" || !ort.InferenceSession)
      return { ok: false, error: "onnxruntime-node loaded without an InferenceSession" };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message ?? err) };
  }
}

/** Pick the backend from the preference and (for auto/native) a probe of the native runtime. */
export function chooseBackend(
  pref: BackendPref,
  probe: () => ReturnType<typeof probeNativeOnnx>,
): BackendChoice {
  if (pref === "wasm")
    return { backend: "wasm", reason: "compatibility mode was selected for this computer" };
  const p = probe();
  if (p.ok) return { backend: "native", reason: "fast native engine" };
  return {
    backend: "wasm",
    reason: `the fast engine can't run on this computer (${nativeFailureKind(p.error)})`,
    detail: p.error,
  };
}

/** Short, non-technical label for why the native runtime didn't load. */
export function nativeFailureKind(raw: string): string {
  const s = raw.toLowerCase();
  if (/initialization routine failed|dll_init|no access to memory location|0x8007045a/.test(s))
    return "its Microsoft Visual C++ runtime is out of date";
  if (/specified module could not be found|module not found|0x8007007e/.test(s))
    return "a Microsoft Visual C++ runtime file is missing";
  if (/specified procedure could not be found|0x8007007f/.test(s))
    return "another program's copy of ONNX Runtime got in the way";
  if (/cannot find module|err_module_not_found/.test(s)) return "part of the engine is missing";
  if (/glibc|version `glibc|wrong elf class|invalid elf/.test(s))
    return "the system libraries are too old";
  return "the native runtime didn't start";
}

/**
 * Windows: put onnxruntime's own folder first on PATH so anything it loads
 * lazily (DirectML.dll, the app-local VC++ runtime) resolves to the bundled
 * copies. The binding itself already searches its own folder first.
 */
export function preferBundledDlls(
  resolveFrom: (id: string) => string = (id) => createRequire(import.meta.url).resolve(id),
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | null {
  if (platform !== "win32") return null;
  try {
    const pkg = path.win32.dirname(resolveFrom("onnxruntime-node/package.json"));
    const dir = path.win32.join(pkg, "bin", "napi-v3", "win32", arch);
    const key = Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "Path";
    const parts = (env[key] ?? "").split(";").filter(Boolean);
    if (!parts.some((p) => p.toLowerCase() === dir.toLowerCase()))
      env[key] = [dir, ...parts].join(";");
    return dir;
  } catch {
    return null;
  }
}

/**
 * Switch transformers.js (and kokoro-js, which uses it) to onnxruntime-web's
 * WebAssembly backend. Must run BEFORE the first import of
 * @huggingface/transformers: its node build imports onnxruntime-node at the
 * top, and that import is redirected here to onnxruntime-web. onnxruntime-web
 * registers its wasm backend under the "cpu" name too, so transformers' Node
 * code path (device "cpu") runs unchanged on WebAssembly.
 */
export async function installWasmOnnx(opts: { threads?: number } = {}): Promise<{
  version: string;
  threads: number;
}> {
  const req = createRequire(import.meta.url);
  // The onnxruntime-web transformers.js was built against (it pins its own).
  const tfReq = createRequire(req.resolve("@huggingface/transformers"));
  const webDist = path.dirname(tfReq.resolve("onnxruntime-web"));
  const esm = path.join(webDist, "ort.node.min.mjs");
  const webUrl = pathToFileURL(fs.existsSync(esm) ? esm : tfReq.resolve("onnxruntime-web")).href;

  const mod = (await import(webUrl)) as { default?: OrtWebLike } & OrtWebLike;
  const ort: OrtWebLike = mod.default ?? mod;
  const threads = Math.max(1, Math.min(opts.threads ?? 4, 8));
  ort.env.wasm.numThreads = threads;
  ort.env.wasm.proxy = false;
  // Local files only: transformers would otherwise point this at a CDN.
  const base = pathToFileURL(webDist + path.sep).href;
  ort.env.wasm.wasmPaths = {
    mjs: `${base}ort-wasm-simd-threaded.mjs`,
    wasm: `${base}ort-wasm-simd-threaded.wasm`,
  };
  redirectNativeOnnx(webUrl);
  const version = String(ort.env.versions?.web ?? ort.env.versions?.common ?? "?");
  return { version, threads };
}

interface OrtWebLike {
  env: {
    wasm: { numThreads?: number; proxy?: boolean; wasmPaths?: unknown };
    versions?: Record<string, string>;
  };
}

let redirected = false;
function redirectNativeOnnx(url: string): void {
  if (redirected) return;
  redirected = true;
  const mod = createRequire(import.meta.url)("node:module") as {
    registerHooks?: (h: {
      resolve: (spec: string, ctx: unknown, next: (s: string, c: unknown) => unknown) => unknown;
    }) => void;
    register?: (url: string) => void;
  };
  if (typeof mod.registerHooks === "function") {
    // Node ≥ 22.15 (Electron 37+): synchronous, in-thread.
    mod.registerHooks({
      resolve: (spec, ctx, next) =>
        spec === "onnxruntime-node" ? { url, shortCircuit: true } : next(spec, ctx),
    });
    return;
  }
  // Older Node: an off-thread ESM resolve hook.
  const hook = `export async function resolve(s, c, n) { return s === "onnxruntime-node" ? { url: ${JSON.stringify(
    url,
  )}, shortCircuit: true } : n(s, c); }`;
  mod.register?.(`data:text/javascript,${encodeURIComponent(hook)}`);
}
