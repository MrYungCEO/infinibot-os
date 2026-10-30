/**
 * capture-queue — offline-safe saving for quick captures.
 *
 * A confirmed capture (note / idea / task / project / log) is saved with
 * `capture.save { draft, clientRequestId }`. If the phone is offline or the
 * gateway is unreachable, the capture is queued in AsyncStorage and retried
 * (on reconnect, on an interval, and when the call page opens). The gateway
 * remembers each clientRequestId, so a retry of a save that actually landed
 * returns the first item instead of creating a duplicate.
 */

export const CAPTURE_QUEUE_KEY = '@infini/capture-queue';
const MAX_ITEMS = 200;

/** Errors that mean "try again later" rather than "this capture is invalid". */
export function isRetryableError(err) {
  const msg = String((err && err.message) || err || '').toLowerCase();
  if (!msg) return true;
  // A bad draft won't get better by retrying; everything else (offline, socket
  // closed, gateway restarting, method not served yet) might.
  return !/invalid|required|must be one of|bad_request|forbidden|unauthori[sz]ed/.test(msg);
}

export function newClientRequestId() {
  return `cap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * @param {{
 *   storage: { getItem(k: string): Promise<string|null>, setItem(k: string, v: string): Promise<void> },
 *   save: (draft: object, clientRequestId: string) => Promise<object>,
 *   now?: () => number,
 * }} deps
 */
export function createCaptureQueue({ storage, save, now = () => Date.now() }) {
  let flushing = null;

  async function read() {
    try {
      const raw = await storage.getItem(CAPTURE_QUEUE_KEY);
      const v = raw ? JSON.parse(raw) : [];
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  }

  async function write(items) {
    await storage.setItem(CAPTURE_QUEUE_KEY, JSON.stringify(items.slice(-MAX_ITEMS)));
  }

  return {
    list: read,

    async size() {
      return (await read()).length;
    },

    async enqueue(draft, clientRequestId, lastError) {
      const items = await read();
      if (items.some((i) => i.clientRequestId === clientRequestId)) return items.length;
      items.push({ clientRequestId, draft, queuedAt: now(), attempts: 0, lastError: lastError ? String(lastError) : undefined });
      await write(items);
      return items.length;
    },

    async remove(clientRequestId) {
      await write((await read()).filter((i) => i.clientRequestId !== clientRequestId));
    },

    /**
     * Save now; on a retryable failure queue it. Resolves
     * `{ status: 'saved', result }`, `{ status: 'queued', error }` or throws for
     * a permanent error (bad draft) so the UI can show it.
     */
    async submit(draft, clientRequestId) {
      try {
        const result = await save(draft, clientRequestId);
        return { status: 'saved', result };
      } catch (err) {
        if (!isRetryableError(err)) throw err;
        await this.enqueue(draft, clientRequestId, err && err.message);
        return { status: 'queued', error: err && err.message };
      }
    },

    /** Retry everything queued (one flush at a time). */
    flush() {
      if (flushing) return flushing;
      flushing = (async () => {
        const items = await read();
        const sent = [];
        const kept = [];
        const dropped = [];
        let offline = false;
        for (const item of items) {
          if (offline) {
            kept.push(item);
            continue;
          }
          try {
            const result = await save(item.draft, item.clientRequestId);
            sent.push({ ...item, result });
          } catch (err) {
            const message = String((err && err.message) || err);
            if (!isRetryableError(err)) {
              dropped.push({ ...item, lastError: message });
              continue;
            }
            kept.push({ ...item, attempts: (item.attempts || 0) + 1, lastError: message });
            // Still offline: don't hammer the rest of the queue this round.
            offline = true;
          }
        }
        // Items enqueued while we were flushing must survive.
        const latest = await read();
        const handled = new Set([...sent, ...dropped, ...kept].map((i) => i.clientRequestId));
        await write([...kept, ...latest.filter((i) => !handled.has(i.clientRequestId))]);
        return { sent, kept, dropped };
      })().finally(() => {
        flushing = null;
      });
      return flushing;
    },
  };
}
