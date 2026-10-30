// ============================================================
// Shared layout-preset store
// ============================================================
//
// A small localStorage-backed CRUD store for named layout presets, scoped by a
// stable scope id (the active canvas in masonry-grid; the literal "terminals"
// scope in the terminals view). Both views consume this same store so the
// on-disk format never forks — only the storage key and the per-entry payload
// type differ.

/** One saved preset: a named snapshot of `entries`, scoped by `scopeId`. */
export interface LayoutPresetRecord<E> {
  name: string;
  scopeId: string;
  entries: E[];
  savedAt: number;
}

interface LayoutPresetsFile<E> {
  presets: LayoutPresetRecord<E>[];
}

export interface LayoutPresetStore<E> {
  /** All presets, or just those for `scopeId` when provided. */
  list(scopeId?: string): LayoutPresetRecord<E>[];
  /** Save (replacing any same-name preset in the same scope); newest first. */
  save(scopeId: string, name: string, entries: E[]): LayoutPresetRecord<E>;
  /** Delete the named preset within `scopeId`. */
  remove(name: string, scopeId: string): void;
}

export interface LayoutPresetStoreOptions<E> {
  storageKey: string;
  /**
   * Optional upgrade for a legacy on-disk record shape. Receives the raw parsed
   * object and returns a normalised record, or null to drop it.
   */
  migrate?: (raw: unknown) => LayoutPresetRecord<E> | null;
}

function isRecord<E>(value: unknown): value is LayoutPresetRecord<E> {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.name === "string" &&
    typeof v.scopeId === "string" &&
    Array.isArray(v.entries) &&
    typeof v.savedAt === "number"
  );
}

export function createLayoutPresetStore<E>(
  opts: LayoutPresetStoreOptions<E>,
): LayoutPresetStore<E> {
  const { storageKey, migrate } = opts;

  function load(): LayoutPresetRecord<E>[] {
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as LayoutPresetsFile<E>;
      const list = Array.isArray(parsed?.presets) ? parsed.presets : [];
      const out: LayoutPresetRecord<E>[] = [];
      for (const item of list) {
        if (isRecord<E>(item)) {
          out.push(item);
        } else if (migrate) {
          const upgraded = migrate(item);
          if (upgraded) out.push(upgraded);
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  function persist(presets: LayoutPresetRecord<E>[]): void {
    try {
      localStorage.setItem(storageKey, JSON.stringify({ presets }));
    } catch (e) {
      console.warn(`[layout-presets] failed to persist (${storageKey}):`, e);
    }
  }

  return {
    list(scopeId?: string) {
      const all = load();
      return scopeId ? all.filter((p) => p.scopeId === scopeId) : all;
    },

    save(scopeId, name, entries) {
      const trimmed = (name || "").trim() || `Layout ${new Date().toLocaleString()}`;
      const preset: LayoutPresetRecord<E> = {
        name: trimmed,
        scopeId,
        entries,
        savedAt: Date.now(),
      };
      const all = load().filter(
        (p) => !(p.name === trimmed && p.scopeId === scopeId),
      );
      all.unshift(preset);
      persist(all);
      return preset;
    },

    remove(name, scopeId) {
      const all = load().filter(
        (p) => !(p.name === name && p.scopeId === scopeId),
      );
      persist(all);
    },
  };
}
