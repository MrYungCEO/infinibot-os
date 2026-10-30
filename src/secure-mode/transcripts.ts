/**
 * Keep secure-session transcripts in the RAM directory.
 *
 * Every secure session entry's `sessionFile` is pinned to the runtime's RAM
 * dir whenever the session store is read or written, so the many transcript
 * writers (chat.send, group chat, the embedded runner, compaction) all land
 * in tmpfs without each needing a secure-mode branch. The runtime seals that
 * dir into the encrypted vault.
 */

import { getSecureModeRuntime } from "./runtime.js";
import { isSecureSessionKey } from "./session-key.js";

type EntryLike = { sessionId?: string; sessionFile?: string };

/** RAM transcript path for a secure session; `fallback` for normal ones. */
export function secureSessionFileFor(
  sessionKey: string | undefined,
  sessionId: string,
  fallback: string,
): string {
  if (!isSecureSessionKey(sessionKey)) return fallback;
  return getSecureModeRuntime().transcriptPath(sessionId);
}

/** Mutates in place: pins sessionFile for every secure key in a store. */
export function pinSecureTranscriptPaths(store: Record<string, EntryLike | undefined>): void {
  let rt: ReturnType<typeof getSecureModeRuntime> | null = null;
  for (const [key, entry] of Object.entries(store)) {
    if (!entry || typeof entry !== "object" || !entry.sessionId) continue;
    if (!isSecureSessionKey(key)) continue;
    rt ??= getSecureModeRuntime();
    if (Object.isFrozen(entry)) continue;
    if (!rt.isRamTranscriptPath(entry.sessionFile)) {
      entry.sessionFile = rt.transcriptPath(entry.sessionId);
    }
  }
}
