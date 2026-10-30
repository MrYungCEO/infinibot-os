import { isSecureSessionKey } from "../secure-mode/session-key.js";

/**
 * Up-front guidance for Secure Mode turns. The web-research line appears only
 * when the `secure_research` tool is actually registered for this run (it is
 * owned by the secure web-research work and may not exist yet).
 */
export function buildSecureSessionPromptNote(params: {
  sessionKey?: string;
  toolNames: Iterable<string>;
}): string | undefined {
  if (!isSecureSessionKey(params.sessionKey)) return undefined;
  const names = new Set(params.toolNames);
  const lines = [
    "## Secure Mode",
    "This is a Secure Mode session: local models only, no direct internet access, files stay encrypted on this machine.",
    'Files, images and videos here are already analyzed and SAVED locally. To review many of them, fetch the saved results in ONE batch call (file_context action "digest", or get with ids[]; video_analysis get with ids[]); never one call per file, and don\'t re-run vision (inspect / analyze / ask) unless the saved analysis cannot answer.',
  ];
  if (names.has("secure_research")) {
    lines.push(
      "If the request needs information from the web (prices, valuations, current facts), say so up front and use the `secure_research` tool (it sends only sanitized queries, after approval). Otherwise answer from your own knowledge and say that it may be out of date.",
    );
  } else {
    lines.push(
      "Web research is not available in Secure Mode. If the request needs current web information (prices, valuations), say so up front and answer from your own knowledge, clearly marked as an estimate that may be out of date.",
    );
  }
  return lines.join("\n");
}

export function joinPromptParts(...parts: Array<string | undefined>): string | undefined {
  const kept = parts.map((p) => p?.trim()).filter((p): p is string => Boolean(p));
  return kept.length ? kept.join("\n\n") : undefined;
}
