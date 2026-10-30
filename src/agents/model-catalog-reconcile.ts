/**
 * Catalog normalization (pure).
 *
 * The built-in model registry (pi-ai) is a snapshot frozen at package build
 * time, so it keeps listing ids the provider has since retired and misses the
 * ones released after. `reconcileCatalog` lines it up with a reference list
 * (the provider's own list-models API, else models.dev — see
 * model-catalog-reference.ts): retired ids go, current ones are added, and
 * anything that can't hold a chat (embeddings, TTS, image/video generation…)
 * is dropped for every provider.
 */

export type CatalogCost = { input: number; output: number };

export type ReconcileEntry = {
  id: string;
  name: string;
  provider: string;
  contextWindow?: number;
  reasoning?: boolean;
  input?: Array<"text" | "image">;
  cost?: CatalogCost;
  /** Where `cost` comes from; absent = the provider's own (unsourced) default. */
  costSource?: string;
};

export type ReferenceSource = "provider-api" | "models.dev" | "openrouter-api";

export type ReferenceModel = {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: Array<"text" | "image">;
  cost?: CatalogCost;
  /** Output modalities when the source reports them (["text"], ["image"], …). */
  output?: string[];
  deprecated?: boolean;
};

export type ReferenceProvider = {
  source: ReferenceSource;
  fetchedAt: number;
  /** Current models for the provider (already narrowed to live ids when known). */
  models: ReferenceModel[];
  /** True when `models` was checked against the provider's own list-models API. */
  live?: boolean;
};

export type CatalogReference = { providers: Record<string, ReferenceProvider> };

const NON_CHAT_ID_RE =
  /(^|[-_/.:])(embed(?:ding)?s?|tts|whisper|transcribe|stt|rerank(?:er)?|moderation|guard|safeguard|content-safety|imagen|veo|lyria|sora|dall-e|image|realtime|live|native-audio|audio|orpheus|deep-research|computer-use|robotics|clip|speech)([-_/.:]|\d|$)/i;

/** Ids that are plainly not chat/text-generation models. */
export function isChatModelId(id: string): boolean {
  return !NON_CHAT_ID_RE.test(id);
}

/** Text-out model the chat picker can use (not embedding / TTS / image-only …). */
export function isChatModel(m: { id: string; output?: string[] }): boolean {
  if (!isChatModelId(m.id)) return false;
  if (!m.output || m.output.length === 0) return true;
  return m.output.length === 1 && m.output[0] === "text";
}

const key = (provider: string, id: string) => `${provider}/${id}`.toLowerCase();

export type ReconcileChange = { provider: string; id: string; reason: string };

export type ReconcileResult<T extends ReconcileEntry> = {
  entries: T[];
  removed: ReconcileChange[];
  added: ReconcileChange[];
};

/** Reference models the picker may list for a provider (chat-capable, not retired). */
export function referenceChatModels(ref: ReferenceProvider): ReferenceModel[] {
  return ref.models.filter((m) => isChatModel(m) && (ref.live || !m.deprecated));
}

export function reconcileCatalog<T extends ReconcileEntry>(
  entries: T[],
  reference: CatalogReference | null | undefined,
  opts: { keep?: ReadonlySet<string> } = {},
): ReconcileResult<T> {
  const removed: ReconcileChange[] = [];
  const added: ReconcileChange[] = [];
  const keep = new Set([...(opts.keep ?? [])].map((k) => k.toLowerCase()));
  const out: T[] = [];
  const seen = new Set<string>();

  const valid = new Map<string, Map<string, ReferenceModel>>();
  for (const [provider, ref] of Object.entries(reference?.providers ?? {})) {
    const models = referenceChatModels(ref);
    // An empty reference means the source was unreachable or changed shape —
    // never let that wipe a provider.
    if (models.length === 0) continue;
    valid.set(provider, new Map(models.map((m) => [m.id.toLowerCase(), m])));
  }

  for (const entry of entries) {
    const k = key(entry.provider, entry.id);
    if (seen.has(k)) continue;
    const pinned = keep.has(k);
    if (!pinned && !isChatModelId(entry.id)) {
      removed.push({ provider: entry.provider, id: entry.id, reason: "not a chat model" });
      continue;
    }
    const ref = valid.get(entry.provider);
    const hit = ref?.get(entry.id.toLowerCase());
    if (ref && !hit && !pinned) {
      const src = reference?.providers[entry.provider];
      removed.push({
        provider: entry.provider,
        id: entry.id,
        reason: `not in ${src?.live ? "the provider's live model list" : src?.source} (retired)`,
      });
      continue;
    }
    seen.add(k);
    if (!hit) {
      out.push(entry);
      continue;
    }
    const source = reference?.providers[entry.provider]?.source;
    out.push({
      ...entry,
      contextWindow: hit.contextWindow ?? entry.contextWindow,
      reasoning: hit.reasoning ?? entry.reasoning,
      input: hit.input ?? entry.input,
      ...(hit.cost ? { cost: hit.cost, costSource: source } : {}),
    });
  }

  for (const [provider, ref] of valid) {
    const source = reference?.providers[provider];
    for (const m of ref.values()) {
      const k = key(provider, m.id);
      if (seen.has(k)) continue;
      seen.add(k);
      added.push({
        provider,
        id: m.id,
        reason: `listed by ${source?.live ? "provider API" : source?.source}`,
      });
      out.push({
        id: m.id,
        name: m.name?.trim() || m.id,
        provider,
        contextWindow: m.contextWindow,
        reasoning: m.reasoning,
        input: m.input,
        ...(m.cost ? { cost: m.cost, costSource: source?.source } : {}),
      } as T);
    }
  }

  return { entries: out, removed, added };
}

function tokens(id: string): string[] {
  return id
    .toLowerCase()
    .replace(/:(free|latest)$/, "")
    .split(/[^a-z0-9.]+/)
    .filter(Boolean);
}

/** Similarity of two model ids: shared leading characters + shared tokens. */
export function modelIdSimilarity(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  let prefix = 0;
  while (prefix < x.length && prefix < y.length && x[prefix] === y[prefix]) prefix++;
  const ta = new Set(tokens(a));
  const tb = tokens(b);
  let shared = 0;
  for (const t of tb) if (ta.has(t)) shared++;
  return prefix + shared * 4 - Math.abs(x.length - y.length) * 0.05;
}

/**
 * Closest id to `target` among `candidates` (same model family first: the one
 * sharing the longest prefix and the most name tokens). Undefined when nothing
 * shares even a family prefix.
 */
export function nearestModelId(target: string, candidates: Iterable<string>): string | undefined {
  let best: string | undefined;
  let bestScore = 0;
  const lower = target.toLowerCase();
  for (const c of candidates) {
    if (c.toLowerCase() === lower) continue;
    const score = modelIdSimilarity(target, c);
    if (score > bestScore) {
      best = c;
      bestScore = score;
    }
  }
  // Need more than a couple of coincidental leading letters.
  return bestScore >= 4 ? best : undefined;
}
