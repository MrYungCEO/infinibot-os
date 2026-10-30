/**
 * Pricing lookup. Reads `pricing.json` so rates can be edited without
 * recompiling. Falls back to provider defaults, then to 0 (local model).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { CostBreakdown, UsageFigures } from "./types.js";

interface RawRate {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  audio?: number;
  image?: number;
}

interface PricingTable {
  models: Record<string, RawRate>;
  providerDefaults: Record<string, RawRate>;
  aliases: Record<string, string>;
}

let cached: PricingTable | null = null;
let cachedAt = 0;
const RELOAD_MS = 60_000;

const DEFAULT_TABLE: PricingTable = {
  models: {},
  providerDefaults: { "ollama-local": { input: 0, output: 0 }, local: { input: 0, output: 0 } },
  aliases: {},
};

function pricingJsonPath(): string {
  // src/credits/pricing.ts is compiled to dist/credits/pricing.js — the
  // JSON sits next to the source. Try the file next to this module first,
  // then fall back to the source tree (helpful in tests / dev runs).
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const local = path.join(here, "pricing.json");
    if (fs.existsSync(local)) return local;
  } catch {
    /* not running as ESM file — fall through */
  }
  // Walk up looking for the repo's src/credits/pricing.json (used during tests).
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, "src", "credits", "pricing.json");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "";
}

function overridePath(): string {
  const stateDir = process.env.INFINIBOT_STATE_DIR?.trim() || path.join(os.homedir(), ".infinibot");
  return path.join(stateDir, "pricing-overrides.json");
}

function readOverrideTable(): Partial<PricingTable> {
  const p = overridePath();
  if (!p || !fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as Partial<PricingTable>;
  } catch {
    return {};
  }
}

export function loadPricingTable(force = false): PricingTable {
  const now = Date.now();
  if (!force && cached && now - cachedAt < RELOAD_MS) return cached;
  const p = pricingJsonPath();
  let base: PricingTable = DEFAULT_TABLE;
  if (p) {
    try {
      const raw = JSON.parse(fs.readFileSync(p, "utf8")) as Partial<PricingTable>;
      base = {
        models: raw.models ?? {},
        providerDefaults: raw.providerDefaults ?? {},
        aliases: raw.aliases ?? {},
      };
    } catch {
      base = DEFAULT_TABLE;
    }
  }
  // Per-host overrides at ~/.infinibot/pricing-overrides.json win against
  // the bundled defaults so users can patch rates without touching the repo.
  const overrides = readOverrideTable();
  cached = {
    models: { ...base.models, ...overrides.models },
    providerDefaults: { ...base.providerDefaults, ...overrides.providerDefaults },
    aliases: { ...base.aliases, ...overrides.aliases },
  };
  cachedAt = now;
  return cached;
}

function normalizeModelKey(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^anthropic\//, "")
    .replace(/^openai\//, "")
    .replace(/^google\//, "");
}

function resolveRate(model: string, provider?: string): RawRate {
  const table = loadPricingTable();
  const key = normalizeModelKey(model);
  const aliased = table.aliases[key];
  if (aliased && table.models[aliased]) return table.models[aliased];
  if (table.models[key]) return table.models[key];
  // Try a more permissive match — some providers append timestamps / dates.
  const base = key.replace(/-\d{6,8}$/, "");
  if (base !== key && table.models[base]) return table.models[base];
  // Fall back to provider defaults.
  if (provider) {
    const p = provider.toLowerCase();
    if (table.providerDefaults[p]) return table.providerDefaults[p];
    if (p.startsWith("ollama") && table.providerDefaults["ollama-local"]) {
      return table.providerDefaults["ollama-local"];
    }
  }
  return {};
}

export interface PriceResult {
  costUsd: number;
  breakdown: CostBreakdown;
  knownModel: boolean;
}

/**
 * Compute USD cost for a model + usage tuple. Returns 0 for unknown models
 * but flags `knownModel = false` so callers can record the gap.
 */
export function priceUsd(model: string, usage: UsageFigures, provider?: string): PriceResult {
  const rate = resolveRate(model, provider);
  const tokensIn = Math.max(0, usage.tokensIn ?? 0);
  const tokensOut = Math.max(0, usage.tokensOut ?? 0);
  const cacheRead = Math.max(0, usage.cacheReadTokens ?? 0);
  const cacheWrite = Math.max(0, usage.cacheWriteTokens ?? 0);

  // cache-read tokens are normally a subset of input tokens; back them out
  // so we don't double-charge if the upstream usage object reports both.
  const billableInput = Math.max(0, tokensIn - cacheRead - cacheWrite);

  const inputUsd = (billableInput / 1_000_000) * (rate.input ?? 0);
  const outputUsd = (tokensOut / 1_000_000) * (rate.output ?? 0);
  const cacheReadUsd = (cacheRead / 1_000_000) * (rate.cacheRead ?? rate.input ?? 0);
  const cacheWriteUsd = (cacheWrite / 1_000_000) * (rate.cacheWrite ?? rate.input ?? 0);

  const total = inputUsd + outputUsd + cacheReadUsd + cacheWriteUsd;
  const knownModel = Boolean(
    rate.input !== undefined ||
    rate.output !== undefined ||
    (provider && provider.toLowerCase().startsWith("ollama")),
  );

  return {
    costUsd: round6(total),
    breakdown: {
      inputUsd: round6(inputUsd),
      outputUsd: round6(outputUsd),
      cacheReadUsd: round6(cacheReadUsd),
      cacheWriteUsd: round6(cacheWriteUsd),
    },
    knownModel,
  };
}

/** List of all priced model keys — used by the UI to show coverage. */
export function listPricedModels(): string[] {
  return Object.keys(loadPricingTable().models).sort();
}

/** Hot-reload the pricing JSON (called by the UI's "reload pricing" button). */
export function reloadPricingTable(): PricingTable {
  return loadPricingTable(true);
}

function round6(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 1_000_000) / 1_000_000;
}
