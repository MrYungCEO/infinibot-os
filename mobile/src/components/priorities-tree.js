/**
 * Pure tree/ordering helpers for the mobile TodaysPriorities checklist.
 *
 * Extracted so the hierarchy math (visual flattening + ordinal normalization)
 * is unit-testable without React Native. The normalized `order[]` shape here is
 * exactly what `priorities.reorder` expects — the same contract the web
 * component and the shared SQLite store use.
 */

/** Build a depth-annotated, depth-first flat list from flat items. */
export function toVisual(items) {
  const byParent = {};
  for (const it of items) {
    const k = it.parentId || '__root';
    (byParent[k] = byParent[k] || []).push(it);
  }
  for (const k of Object.keys(byParent)) byParent[k].sort((a, b) => a.ordinal - b.ordinal);
  const out = [];
  const walk = (parentKey, depth) => {
    for (const it of byParent[parentKey] || []) {
      out.push({ ...it, depth });
      walk(it.id, depth + 1);
    }
  };
  walk('__root', 0);
  return out;
}

/**
 * Recompute { id, parentId, ordinal } for every item, with each sibling group's
 * ordinals normalized to a dense 0..n (so fractional/duplicate ordinals from an
 * indent/outdent/move settle to clean integers).
 */
export function normalize(items) {
  const byParent = {};
  for (const it of items) {
    const k = it.parentId || '__root';
    (byParent[k] = byParent[k] || []).push(it);
  }
  const order = [];
  for (const k of Object.keys(byParent)) {
    byParent[k].sort((a, b) => a.ordinal - b.ordinal);
    byParent[k].forEach((it, i) => {
      order.push({ id: it.id, parentId: it.parentId || null, ordinal: i });
    });
  }
  return order;
}
