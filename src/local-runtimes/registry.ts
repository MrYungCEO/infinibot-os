import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { InfinibotConfig } from "../config/config.js";
import type {
  LocalRuntimeConfig,
  LocalRuntimeKind,
  LocalRuntimesConfig,
} from "../config/types.local-runtimes.js";

/** Fully resolved registry entry. Only units/models listed here are ever touched. */
export type LocalRuntimeSpec = {
  id: string;
  label: string;
  kind: LocalRuntimeKind;
  unit?: string;
  baseUrl: string;
  healthUrl: string;
  providers: string[];
  models: string[];
  visionModels: string[];
  vramMb: number;
  /** vLLM `--gpu-memory-utilization`: need = fraction × GPU total (overrides vramMb). */
  vramFraction?: number;
  modelVramMb: Record<string, number>;
  startupTimeoutSec: number;
  etaSec: number;
  idleStopMinutes: number;
  startAtBoot: boolean;
  keepAlive?: string;
};

export type ManagerPolicy = {
  enabled: boolean;
  drainTimeoutMs: number;
  backgroundPriority: "interactive-first" | "fifo";
  backgroundSwapIdleMs: number;
  backgroundWaitTimeoutMs: number;
  reservedVramMb: number;
  gpuIndex: number;
};

export const DEFAULT_VLLM_UNIT = "vllm-qwen.service";
export const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";

function stripSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function userUnitExists(unit: string, home = os.homedir()): boolean {
  const name = unit.endsWith(".service") ? unit : `${unit}.service`;
  const dirs = [
    path.join(home, ".config/systemd/user"),
    "/etc/systemd/user",
    "/usr/lib/systemd/user",
  ];
  return dirs.some((d) => {
    try {
      return fs.existsSync(path.join(d, name));
    } catch {
      return false;
    }
  });
}

/** Port of `--port`/`--host` from the unit's ExecStart, so health hits the real bind. */
/** Unit file + its drop-ins, in systemd order (later ExecStart lines win). */
function readUnitText(unit: string, home = os.homedir()): string {
  const name = unit.endsWith(".service") ? unit : `${unit}.service`;
  const dir = path.join(home, ".config/systemd/user");
  let text = "";
  try {
    text = fs.readFileSync(path.join(dir, name), "utf8");
  } catch {
    return "";
  }
  try {
    const dropDir = path.join(dir, `${name}.d`);
    for (const f of fs
      .readdirSync(dropDir)
      .filter((x) => x.endsWith(".conf"))
      .sort()) {
      text += `\n${fs.readFileSync(path.join(dropDir, f), "utf8")}`;
    }
  } catch {
    // no drop-ins
  }
  return text;
}

function lastMatch(text: string, re: RegExp): string | undefined {
  let out: string | undefined;
  for (const m of text.matchAll(re)) out = m[1];
  return out;
}

/** `--gpu-memory-utilization` from the unit (and drop-ins). */
function readUnitGpuFraction(unit: string, home = os.homedir()): number | undefined {
  const v = Number(lastMatch(readUnitText(unit, home), /--gpu-memory-utilization[\s=]+([\d.]+)/g));
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : undefined;
}

function readUnitBind(unit: string, home = os.homedir()): string | null {
  try {
    const text = readUnitText(unit, home);
    if (!text) return null;
    const host = text.match(/--host[\s=]+([^\s\\]+)/)?.[1];
    const port = text.match(/--port[\s=]+(\d+)/)?.[1];
    if (!port) return null;
    const h = !host || host === "0.0.0.0" ? "127.0.0.1" : host;
    return `http://${h}:${port}/v1`;
  } catch {
    return null;
  }
}

type ProviderCfg = { baseUrl?: string; models?: Array<{ id?: string; input?: string[] }> };

function providers(cfg: InfinibotConfig | undefined): Record<string, ProviderCfg> {
  return ((cfg?.models as { providers?: Record<string, ProviderCfg> } | undefined)?.providers ??
    {}) as Record<string, ProviderCfg>;
}

/**
 * Built-in entries: Ollama always (models load on demand), plus the vLLM
 * systemd unit when this host has it (or a `vllm-local` provider points at
 * one). Owner config in `localRuntimes.runtimes` overrides field by field.
 */
function autoDetected(
  cfg: InfinibotConfig | undefined,
  home?: string,
): Record<string, LocalRuntimeConfig> {
  const out: Record<string, LocalRuntimeConfig> = {};
  const prov = providers(cfg);
  const ollamaUrl = stripSlash(
    (prov.ollama?.baseUrl ?? process.env.OLLAMA_HOST ?? DEFAULT_OLLAMA_URL).replace(/\/v1$/, ""),
  );
  out.ollama = {
    label: "Ollama",
    kind: "ollama",
    baseUrl: /^https?:\/\//.test(ollamaUrl) ? ollamaUrl : `http://${ollamaUrl}`,
    providers: ["ollama"],
    models: ["*"],
    visionModels: ["huihui_ai/Qwen3.8-abliterated:latest"],
    vramMb: 20_000,
    modelVramMb: { "nomic-embed-text:latest": 600 },
    startupTimeoutSec: 240,
    etaSec: 40,
    idleStopMinutes: 0,
  };
  const vllmProvider = prov["vllm-local"];
  if (userUnitExists(DEFAULT_VLLM_UNIT, home)) {
    const base =
      stripSlash(vllmProvider?.baseUrl ?? "") ||
      readUnitBind(DEFAULT_VLLM_UNIT, home) ||
      "http://127.0.0.1:8010/v1";
    out["vllm-qwen"] = {
      label: "vLLM Qwen3.8-27B",
      kind: "systemd",
      unit: DEFAULT_VLLM_UNIT,
      baseUrl: base,
      providers: ["vllm-local"],
      models: (vllmProvider?.models ?? []).map((m) => String(m.id ?? "")).filter(Boolean),
      visionModels: (vllmProvider?.models ?? [])
        .filter((m) => m.input?.includes("image"))
        .map((m) => String(m.id ?? "")),
      // Fallback when the unit has no --gpu-memory-utilization (0.85 of 32 GB).
      vramMb: 28_000,
      vramFraction: readUnitGpuFraction(DEFAULT_VLLM_UNIT, home),
      startupTimeoutSec: 420,
      etaSec: 90,
      idleStopMinutes: 30,
      startAtBoot: false,
    };
  }
  return out;
}

export function resolveRuntimeSpecs(
  cfg: InfinibotConfig | undefined,
  opts?: { home?: string },
): LocalRuntimeSpec[] {
  const lr = (cfg as { localRuntimes?: LocalRuntimesConfig } | undefined)?.localRuntimes;
  if (lr?.enabled === false) return [];
  const merged: Record<string, LocalRuntimeConfig> = autoDetected(cfg, opts?.home);
  for (const [id, entry] of Object.entries(lr?.runtimes ?? {})) {
    if (entry === false) {
      delete merged[id];
      continue;
    }
    merged[id] = { ...merged[id], ...entry };
  }
  const specs: LocalRuntimeSpec[] = [];
  for (const [id, c] of Object.entries(merged)) {
    const kind: LocalRuntimeKind = c.kind ?? (c.unit ? "systemd" : "ollama");
    if (kind === "systemd" && !c.unit) continue;
    const baseUrl = stripSlash(c.baseUrl ?? (kind === "ollama" ? DEFAULT_OLLAMA_URL : ""));
    if (!baseUrl) continue;
    specs.push({
      id,
      label: c.label ?? id,
      kind,
      unit: c.unit,
      baseUrl,
      healthUrl:
        c.healthUrl ?? (kind === "ollama" ? `${baseUrl}/api/version` : `${baseUrl}/models`),
      providers: c.providers ?? [],
      models: c.models ?? (kind === "ollama" ? ["*"] : []),
      visionModels: c.visionModels ?? [],
      vramMb: c.vramMb ?? (kind === "ollama" ? 8_000 : 16_000),
      ...(c.vramFraction ? { vramFraction: c.vramFraction } : {}),
      modelVramMb: c.modelVramMb ?? {},
      startupTimeoutSec: c.startupTimeoutSec ?? (kind === "ollama" ? 240 : 420),
      etaSec: c.etaSec ?? (kind === "ollama" ? 40 : 90),
      idleStopMinutes: c.idleStopMinutes ?? (kind === "systemd" ? 30 : 0),
      startAtBoot: c.startAtBoot ?? false,
      keepAlive: c.keepAlive,
    });
  }
  return specs;
}

export function resolveManagerPolicy(cfg: InfinibotConfig | undefined): ManagerPolicy {
  const lr = (cfg as { localRuntimes?: LocalRuntimesConfig } | undefined)?.localRuntimes ?? {};
  return {
    enabled: lr.enabled !== false,
    drainTimeoutMs: (lr.drainTimeoutSec ?? 120) * 1000,
    backgroundPriority: lr.backgroundPriority ?? "interactive-first",
    backgroundSwapIdleMs: (lr.backgroundSwapIdleSec ?? 600) * 1000,
    backgroundWaitTimeoutMs: (lr.backgroundWaitTimeoutSec ?? 1800) * 1000,
    reservedVramMb: lr.reservedVramMb ?? 512,
    gpuIndex: lr.gpuIndex ?? 0,
  };
}

export function modelMatches(patterns: string[], model: string | undefined): boolean {
  if (!model) return patterns.length > 0;
  return patterns.some((p) => {
    if (p === "*") return true;
    if (p === model) return true;
    // "name" matches "name:latest" and vice versa (Ollama tags).
    const base = (s: string) => s.replace(/:latest$/, "");
    return base(p) === base(model);
  });
}

export function findRuntimeForProvider(
  specs: LocalRuntimeSpec[],
  provider: string,
  model?: string,
): LocalRuntimeSpec | null {
  const p = provider.trim().toLowerCase();
  for (const s of specs) {
    if (!s.providers.some((x) => x.toLowerCase() === p)) continue;
    if (s.kind === "systemd" && s.models.length > 0 && model && !modelMatches(s.models, model)) {
      continue;
    }
    return s;
  }
  return null;
}

function hostPort(url: string): string | null {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || (u.protocol === "https:" ? "443" : "80")}`;
  } catch {
    return null;
  }
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** Runtime serving an arbitrary endpoint URL (OCR's Ollama URL, a provider baseUrl). */
export function findRuntimeForUrl(specs: LocalRuntimeSpec[], url: string): LocalRuntimeSpec | null {
  const target = hostPort(url);
  if (!target) return null;
  const norm = (hp: string) => {
    const [h, port] = [hp.slice(0, hp.lastIndexOf(":")), hp.slice(hp.lastIndexOf(":") + 1)];
    return `${LOOPBACK.has(h) ? "loopback" : h}:${port}`;
  };
  return (
    specs.find((s) => {
      const hp = hostPort(s.baseUrl);
      return hp ? norm(hp) === norm(target) : false;
    }) ?? null
  );
}
