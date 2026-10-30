/**
 * Voice brain picker — pure state (no DOM, no gateway: tested in node).
 *
 * The gateway owns the choice: `voice.cliRoute.set { mode: "api", model }`
 * stores the voice brain model in the per-profile route file, and every voice
 * provider's API turn runs on it (src/gateway/voice/voice-llm-turn.ts). The
 * catalogue comes from `voice.brain.catalog` (configured API providers with
 * their live curated models, local models, subscription CLIs).
 */

import { FEATURED_BRAIN_PROVIDER_IDS } from "../../lib/brain-providers.js";

export type BrainModel = { id: string; label?: string; free?: boolean };

export type BrainApiProvider = {
  id: string;
  label: string;
  configured: boolean;
  models: BrainModel[];
  defaultModel?: string;
  error?: string;
};

export type BrainLocalModel = { ref: string; provider: string; model: string; reachable: boolean; onDemand?: boolean; note?: string };

export type BrainCliProvider = {
  id: string;
  label: string;
  account: string;
  installed: boolean;
  auth: string;
  ready: boolean;
  model: string;
  version?: string;
  installUrl: string;
};

export type BrainCatalog = {
  current: string | null;
  agentModel: string | null;
  api: BrainApiProvider[];
  local: BrainLocalModel[];
  cli: BrainCliProvider[];
};

export const BRAIN_CATALOG_STORAGE_KEY = "infinibot.voice.brainCatalog";

type Store = Pick<Storage, "getItem" | "setItem">;

function browserStore(): Store | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** Last catalogue (instant paint while the live lists load). */
export function loadCachedCatalog(store: Store | null = browserStore()): BrainCatalog | null {
  try {
    const raw = store?.getItem(BRAIN_CATALOG_STORAGE_KEY);
    const v = raw ? (JSON.parse(raw) as BrainCatalog) : null;
    return v && Array.isArray(v.api) && Array.isArray(v.local) && Array.isArray(v.cli) ? v : null;
  } catch {
    return null;
  }
}

export function saveCachedCatalog(c: BrainCatalog, store: Store | null = browserStore()): void {
  try {
    store?.setItem(BRAIN_CATALOG_STORAGE_KEY, JSON.stringify(c));
  } catch {
    /* quota / private mode */
  }
}

/** Configured first in the onboarding card order, then the rest alphabetically. */
export function splitApiProviders(api: BrainApiProvider[]): { configured: BrainApiProvider[]; unconfigured: BrainApiProvider[] } {
  const featured = FEATURED_BRAIN_PROVIDER_IDS as readonly string[];
  const rank = (p: BrainApiProvider) => (featured.includes(p.id) ? featured.indexOf(p.id) : featured.length);
  const sorted = [...api].sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));
  return { configured: sorted.filter((p) => p.configured), unconfigured: sorted.filter((p) => !p.configured) };
}

export function isFeaturedProvider(id: string): boolean {
  return (FEATURED_BRAIN_PROVIDER_IDS as readonly string[]).includes(id);
}

/** Search + Free-only filter of a model list. */
export function filterModels(models: BrainModel[], query: string, freeOnly: boolean): BrainModel[] {
  const q = query.trim().toLowerCase();
  return models.filter(
    (m) => (!freeOnly || m.free) && (!q || m.id.toLowerCase().includes(q) || (m.label ?? "").toLowerCase().includes(q)),
  );
}

/** `provider/model` → [provider, model]; model ids may contain "/" (OpenRouter). */
export function splitRef(ref: string): { provider: string; model: string } {
  const i = ref.indexOf("/");
  return i < 0 ? { provider: "", model: ref } : { provider: ref.slice(0, i), model: ref.slice(i + 1) };
}

export function cliModelRef(cli: Pick<BrainCliProvider, "id" | "model">): string {
  return `${cli.id}/${cli.model}`;
}

export const CLI_MODEL_PROVIDER = /^(claude|codex|gemini|grok|opencode)-cli$/;

/** Plain-language state of a subscription CLI. */
export function cliState(c: BrainCliProvider): { tone: "ok" | "warn" | "off"; text: string; usable: boolean } {
  if (!c.installed) return { tone: "off", text: "Not installed", usable: false };
  if (c.auth === "signed-out") return { tone: "warn", text: "Signed out", usable: false };
  if (c.auth === "signed-in") return { tone: "ok", text: "Signed in", usable: true };
  if (c.auth === "api-key" || c.auth === "env") return { tone: "ok", text: "Key set", usable: true };
  return { tone: "ok", text: "Installed", usable: true };
}

/**
 * Short, whole-word chip label for a model ref: the model's own name without
 * vendor prefixes ("openai/gpt-oss-120b:free" → "gpt-oss-120b:free").
 */
export function shortModelName(ref: string): string {
  const { model } = splitRef(ref);
  const last = (model.split("/").pop() ?? model).replace(/:latest$/, "");
  return last || ref;
}

/** Display name of the provider behind a ref (catalogue label, else the id). */
export function providerLabel(ref: string, catalog: BrainCatalog | null): string {
  const { provider } = splitRef(ref);
  const api = catalog?.api.find((p) => p.id === provider);
  if (api) return api.label;
  const cli = catalog?.cli.find((c) => c.id === provider);
  if (cli) return cli.account || cli.label;
  if (provider === "ollama") return "Ollama (local)";
  if (provider === "vllm-local") return "vLLM (local)";
  return provider;
}

export type BrainSummary = { kind: "agent" | "api" | "local" | "cli"; title: string; detail: string };

/** What the chip and the picker header say about the active voice brain. */
export function brainSummary(model: string | null | undefined, catalog: BrainCatalog | null): BrainSummary {
  if (!model) {
    const agent = catalog?.agentModel;
    return { kind: "agent", title: agent ? shortModelName(agent) : "Agent model", detail: agent ? `Agent default · ${agent}` : "The agent's own model" };
  }
  const { provider } = splitRef(model);
  const kind = CLI_MODEL_PROVIDER.test(provider)
    ? "cli"
    : catalog?.local.some((l) => l.ref === model) || provider === "ollama" || provider === "vllm-local"
      ? "local"
      : "api";
  return { kind, title: shortModelName(model), detail: `${providerLabel(model, catalog)} · ${splitRef(model).model}` };
}
