/**
 * Merge target sources into one registry. Pure — used by the gateway
 * (registry.ts, live plugin state) and by the JSON dump script (all
 * first-party manifests).
 *
 * Precedence: curated entries override derived entries with the same id
 * (fields win, keywords/aliases union), so a hand-written description can
 * enrich an auto-derived page without forking it.
 */

import type { UiTarget } from "./types.js";

function union(a?: string[], b?: string[]): string[] | undefined {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of [...(a ?? []), ...(b ?? [])]) {
    const k = v.toLowerCase();
    if (!v || seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out.length ? out : undefined;
}

export function mergeTarget(base: UiTarget, over: Partial<UiTarget>): UiTarget {
  const merged: UiTarget = { ...base, ...stripUndefined(over) } as UiTarget;
  merged.keywords = union(base.keywords, over.keywords);
  merged.aliases = union(base.aliases, over.aliases);
  if (base.availability || over.availability)
    merged.availability = { ...base.availability, ...over.availability };
  if (!merged.keywords) delete merged.keywords;
  if (!merged.aliases) delete merged.aliases;
  return merged;
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(o))
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}

/**
 * `derived` sources in priority order (earlier wins on id clashes), then
 * `curated` merged on top. Aliases that collide with a real id are dropped.
 */
export function assembleTargets(
  derived: UiTarget[][],
  curated: Array<UiTarget | (Partial<UiTarget> & { id: string; extends: true })>,
): UiTarget[] {
  const byId = new Map<string, UiTarget>();
  const order: string[] = [];
  for (const list of derived) {
    for (const t of list) {
      if (byId.has(t.id)) continue;
      byId.set(t.id, t);
      order.push(t.id);
    }
  }
  for (const c of curated) {
    const { extends: ext, ...rest } = c as Partial<UiTarget> & { id: string; extends?: boolean };
    const prev = byId.get(c.id);
    if (prev) byId.set(c.id, mergeTarget(prev, rest));
    else if (!ext) {
      byId.set(c.id, rest as UiTarget);
      order.push(c.id);
    }
    // `extends` entries only enrich a derived target; skipped when it's absent
    // (e.g. a plugin that isn't installed on this gateway).
  }
  const ids = new Set(order);
  const claimed = new Set<string>();
  return order.map((id) => {
    const t = byId.get(id)!;
    if (!t.aliases) return t;
    const aliases = t.aliases.filter((a) => !ids.has(a) && !claimed.has(a));
    for (const a of aliases) claimed.add(a);
    const next = { ...t, aliases };
    if (!aliases.length) delete (next as { aliases?: string[] }).aliases;
    return next;
  });
}
