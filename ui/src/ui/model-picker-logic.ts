/**
 * Pure logic for <webchat-model-picker>: sectioning ("Your models" + provider
 * groups + not-connected providers), the flat row list the menu renders and
 * navigates, and the allowlist bookkeeping. DOM-free so it runs under the node
 * vitest config.
 *
 * "Your models" is the gateway allowlist (agents.defaults.models). Models
 * outside it are still listed and selectable — the picker adds them to the
 * allowlist first, because sessions.patch rejects anything not on it.
 */
import {
  filterModels,
  getUniqueProviders,
  type ModelFilterState,
  type ModelOption,
  type ProviderInfo,
} from "./model-filter";

export const ONLY_MINE_STORAGE_KEY = "infinibot.modelPicker.onlyMine";
/** Model rows rendered per page; the list grows by this much as it scrolls. */
export const PICKER_PAGE_SIZE = 60;

type StorageLike = Pick<Storage, "getItem" | "setItem">;

export function loadOnlyMine(storage: StorageLike | null | undefined): boolean {
  try {
    return storage?.getItem(ONLY_MINE_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveOnlyMine(storage: StorageLike | null | undefined, on: boolean): void {
  try {
    storage?.setItem(ONLY_MINE_STORAGE_KEY, on ? "1" : "0");
  } catch {
    /* storage blocked — the toggle just won't be remembered */
  }
}

/** On the allowlist (explicitly, or implicitly as the default model). */
export function isMine(m: ModelOption): boolean {
  return m.pinned === true || m.allowed === true;
}

/** sessions.patch would reject this model until it is added to the allowlist. */
export function needsAllowlistAdd(m: ModelOption | undefined): boolean {
  return m?.allowed === false;
}

export type PickerSections = {
  /** Allowlisted models matching the filters. */
  mine: ModelOption[];
  /** Every other usable model matching the filters, grouped by provider (A→Z). */
  groups: Array<{ provider: string; models: ModelOption[] }>;
  /** Providers without credentials, with their models that match (browse-only). */
  offline: Array<{ provider: string; count: number; models: ModelOption[] }>;
  /** Selectable models across `mine` + `groups`. */
  total: number;
};

/**
 * A provider the user pays for is connected (it has usable models that aren't
 * free / free tier / local). Without one, the picker leads with free options.
 */
export function hasPaidProviderConnected(models: ModelOption[]): boolean {
  const byProvider = new Map<string, boolean>();
  for (const m of models) {
    if (m.unconfigured || m.available === false || !m.provider) continue;
    byProvider.set(m.provider, (byProvider.get(m.provider) ?? true) && m.free !== undefined);
  }
  // A provider counts as free only when every model it offers is.
  for (const allFree of byProvider.values()) if (!allFree) return true;
  return false;
}

const freeRank = (m: ModelOption) => (m.free ? 0 : 1);

export function buildPickerSections(
  models: ModelOption[],
  filter: ModelFilterState,
  opts: {
    onlyMine?: boolean;
    /** Free providers and models lead (no paid provider connected). */
    freeFirst?: boolean;
    /** models.list `providers` — free-tier facts for group / connect rows. */
    providerInfo?: ReadonlyMap<string, ProviderInfo>;
  } = {},
): PickerSections {
  const info = opts.providerInfo;
  const providerFree = (p: string) => (info?.get(p)?.free ? 0 : 1);
  // Filters run over the whole catalog — never just the allowlisted subset.
  const matching = filterModels(models, filter);
  const usable = matching.filter((m) => m.available !== false);
  const mine = usable.filter(isMine);

  const byProvider = new Map<string, ModelOption[]>();
  if (!opts.onlyMine) {
    for (const m of usable) {
      if (isMine(m)) continue;
      const key = m.provider ?? "other";
      const list = byProvider.get(key);
      if (list) list.push(m);
      else byProvider.set(key, [m]);
    }
  }
  const groups = Array.from(byProvider.entries())
    .sort(([a, x], [b, y]) => {
      if (opts.freeFirst) {
        const fa = x.some((m) => m.free) ? 0 : 1;
        const fb = y.some((m) => m.free) ? 0 : 1;
        if (fa !== fb) return fa - fb;
      }
      return a.localeCompare(b);
    })
    .map(([provider, list]) => ({
      provider,
      // Stable: free models float up, the catalog order is kept otherwise.
      models: opts.freeFirst ? [...list].sort((a, b) => freeRank(a) - freeRank(b)) : list,
    }));

  const offlineModels = new Map<string, ModelOption[]>();
  if (!opts.onlyMine) {
    for (const m of matching) {
      if (m.available !== false || !m.provider) continue;
      const list = offlineModels.get(m.provider);
      if (list) list.push(m);
      else offlineModels.set(m.provider, [m]);
    }
    // "Not connected" placeholders (no models yet) for providers with nothing usable.
    const q = filter.search.trim().toLowerCase();
    const hasUsable = new Set(
      models.filter((m) => !m.unconfigured && m.available !== false).map((m) => m.provider),
    );
    // They have no models to match, so capability / context filters hide them —
    // except the Free filter, which keeps placeholders of free providers
    // (local Ollama) so a beginner still sees the option.
    const onlyFreeFilter =
      !filter.tier && filter.capabilities.size === 1 && filter.capabilities.has("free");
    const placeholders =
      filter.capabilities.size || filter.tier
        ? onlyFreeFilter
          ? models.filter((m) => m.unconfigured && m.provider && info?.get(m.provider)?.free)
          : []
        : models.filter((m) => m.unconfigured);
    for (const p of getUniqueProviders(placeholders)) {
      if (hasUsable.has(p) || offlineModels.has(p)) continue;
      if (filter.provider && filter.provider !== p) continue;
      if (q && !p.toLowerCase().includes(q)) continue;
      offlineModels.set(p, []);
    }
  }
  // Providers a beginner can start on for free come first.
  const offline = Array.from(offlineModels.entries())
    .sort(([a], [b]) => providerFree(a) - providerFree(b) || a.localeCompare(b))
    .map(([provider, list]) => ({ provider, count: list.length, models: list }));

  return {
    mine,
    groups,
    offline,
    total: mine.length + groups.reduce((n, g) => n + g.models.length, 0),
  };
}

export type PickerRow =
  | { kind: "head"; key: string; label: string; count: number; mine: boolean }
  | { kind: "model"; model: ModelOption; mine: boolean };

/** Sections → the flat, in-order row list ("Your models" first). */
export function flattenSections(sections: PickerSections): PickerRow[] {
  const rows: PickerRow[] = [];
  if (sections.mine.length) {
    rows.push({ kind: "head", key: "__mine__", label: "Your models", count: sections.mine.length, mine: true });
    for (const model of sections.mine) rows.push({ kind: "model", model, mine: true });
  }
  for (const g of sections.groups) {
    rows.push({ kind: "head", key: g.provider, label: g.provider, count: g.models.length, mine: false });
    for (const model of g.models) rows.push({ kind: "model", model, mine: false });
  }
  return rows;
}

/**
 * Cap the rendered rows at `limit` models (headers ride along, and a header is
 * never left dangling at the end). `hidden` = models not rendered yet.
 */
export function windowRows(rows: PickerRow[], limit: number): { rows: PickerRow[]; hidden: number } {
  const out: PickerRow[] = [];
  let shown = 0;
  let total = 0;
  for (const row of rows) {
    if (row.kind === "model") {
      total++;
      if (shown >= limit) continue;
      shown++;
      out.push(row);
    } else if (shown < limit) {
      out.push(row);
    }
  }
  while (out.length && out[out.length - 1].kind === "head") out.pop();
  return { rows: out, hidden: total - shown };
}

/** Page count needed for the row at `index` (0-based, model rows only) to be rendered. */
export function limitForIndex(index: number, current: number): number {
  if (index < current) return current;
  return (Math.floor(index / PICKER_PAGE_SIZE) + 1) * PICKER_PAGE_SIZE;
}

/** Above this many matches a not-connected provider stays collapsed until opened. */
export const OFFLINE_AUTO_EXPAND_MAX = 25;

/** Whether a not-connected provider's models are listed (browse-only rows). */
export function offlineExpanded(
  entry: { provider: string; count: number },
  opts: { filtered: boolean; toggled: ReadonlyMap<string, boolean> },
): boolean {
  if (entry.count === 0) return false;
  const explicit = opts.toggled.get(entry.provider);
  if (explicit !== undefined) return explicit;
  // A search/filter that lands on a few of its models shows them straight away.
  return opts.filtered && entry.count <= OFFLINE_AUTO_EXPAND_MAX;
}

/** Optimistic local update after models.allowlist.add / .remove (a catalog reload follows). */
export function applyAllowlistChange(
  models: ModelOption[],
  id: string,
  action: "add" | "remove",
): ModelOption[] {
  return models.map((m) => {
    if (m.id !== id) {
      // First pin on an open (allow-any) catalog turns it into an allowlist.
      return action === "add" && m.allowed === undefined && !m.unconfigured ? { ...m, allowed: false } : m;
    }
    return action === "add" ? { ...m, allowed: true, pinned: true } : { ...m, allowed: false, pinned: false };
  });
}
