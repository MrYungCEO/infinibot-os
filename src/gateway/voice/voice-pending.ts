/**
 * Background work of a live voice call: runs and tool calls that outlived the
 * turn that started them.
 *
 * A voice turn must never hold the line. When the full agent or a tool takes
 * longer than the turn's speaking budget, or the caller talks over it, the
 * work is DETACHED instead of killed: it keeps running, its result is parked
 * here, and the next turn of the same call says it first ("Quick update: …").
 * The whole text also lands in the session transcript as usual.
 *
 * "Stop" / "cancel that" on the call aborts what is still running.
 */

export type BackgroundItem = {
  id: string;
  label: string;
  startedAt: number;
  /** Final text once done (empty = finished with nothing to say). */
  result?: string;
  error?: string;
  doneAt?: number;
  abort?: () => void;
};

const MAX_CALLS = 200;
const MAX_ITEMS_PER_CALL = 8;
const RESULT_TTL_MS = 30 * 60_000;

const byCall = new Map<string, BackgroundItem[]>();
let seq = 0;

/** Utterances that mean "stop what you are doing". */
export const CANCEL_RE =
  /^(?:(?:ok(?:ay)?|no|hey|wait|actually)[,!. ]+)*(?:stop|cancel|abort|never ?mind|forget (?:it|that|about it)|scratch that|don't (?:do|bother)(?: it| that)?|leave it)(?: (?:it|that|this|everything|all of (?:it|that)|the (?:task|search|agent|job)s?))?(?: (?:please|now|for now))?[\s.!?]*$/i;

function list(callKey: string): BackgroundItem[] {
  let items = byCall.get(callKey);
  if (!items) {
    items = [];
    byCall.set(callKey, items);
    if (byCall.size > MAX_CALLS) byCall.delete(byCall.keys().next().value!);
  }
  return items;
}

/** Park work that keeps running after its turn ended. */
export function trackBackground(
  callKey: string,
  label: string,
  work: Promise<string>,
  abort?: () => void,
  now: () => number = Date.now,
): BackgroundItem {
  const item: BackgroundItem = { id: `bg${++seq}`, label, startedAt: now(), abort };
  const items = list(callKey);
  items.push(item);
  while (items.length > MAX_ITEMS_PER_CALL) items.shift();
  work.then(
    (text) => {
      item.result = (text ?? "").trim();
      item.doneAt = now();
    },
    (err) => {
      item.error = err instanceof Error ? err.message : String(err);
      item.doneAt = now();
    },
  );
  return item;
}

/** Still running for this call. */
export function busyBackground(callKey: string): BackgroundItem[] {
  return (byCall.get(callKey) ?? []).filter((i) => !i.doneAt);
}

/** Finished since the last turn (removed from the registry). */
export function takeFinished(callKey: string, now = Date.now()): BackgroundItem[] {
  const items = byCall.get(callKey);
  if (!items) return [];
  const done = items.filter((i) => i.doneAt && now - i.doneAt < RESULT_TTL_MS);
  byCall.set(
    callKey,
    items.filter((i) => !i.doneAt),
  );
  return done.filter((i) => i.result || i.error);
}

/** Abort everything still running on the call; returns how many were stopped. */
export function cancelBackground(callKey: string): number {
  const running = busyBackground(callKey);
  for (const item of running) {
    try {
      item.abort?.();
    } catch {
      // best effort
    }
    item.doneAt = Date.now();
    item.result = "";
  }
  return running.length;
}

export function isCancelUtterance(text: string): boolean {
  return CANCEL_RE.test(text.trim());
}

export function clearBackgroundForTests(): void {
  byCall.clear();
}
