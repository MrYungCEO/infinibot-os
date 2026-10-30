/**
 * HTTP GET /api/proactive/audio/:hash.mp3 — serve baked per-scene narration.
 *
 * The infinite-canvas walkthrough media kind pre-bakes each scene's narration
 * into an mp3 under `<stateDir>/proactive-audio/` (see proactive/canvas-narration
 * .ts) and rewrites the scene's `narration.audioUrl` to this route. The overlay
 * fetches the clip and locks its beat animations to the audio clock.
 *
 * These clips are non-secret TTS of agent-authored walkthrough content (the same
 * trust surface as the live /api/voice/tts proxy, which is also unauthenticated
 * same-origin). We only ever serve a sanitized hash filename that resolves
 * inside the audio dir — no path traversal, no arbitrary file reads.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";

import { STATE_DIR } from "../config/paths.js";
import { proactiveAudioDir } from "../proactive/canvas-narration.js";

const ROUTE_PREFIX = "/api/proactive/audio/";
/** hash filenames are [a-f0-9] (sha1 slice) + .mp3 — nothing else is served. */
const SAFE_NAME = /^[a-f0-9]{8,64}\.mp3$/;

export async function handleProactiveAudioRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (!url.pathname.startsWith(ROUTE_PREFIX)) return false;

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { "Content-Type": "application/json", Allow: "GET, HEAD" });
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return true;
  }

  const name = decodeURIComponent(url.pathname.slice(ROUTE_PREFIX.length));
  if (!SAFE_NAME.test(name)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid audio id" }));
    return true;
  }

  const dir = proactiveAudioDir(STATE_DIR);
  const file = path.join(dir, name);
  // Defense-in-depth: ensure the resolved path stays inside the audio dir.
  if (path.relative(dir, file).startsWith("..")) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid path" }));
    return true;
  }

  let size: number;
  try {
    const s = await stat(file);
    if (!s.isFile()) throw new Error("not a file");
    size = s.size;
  } catch {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
    return true;
  }

  const headers: Record<string, string> = {
    "Content-Type": "audio/mpeg",
    "Content-Length": String(size),
    // Content-addressed by hash → immutable.
    "Cache-Control": "public, max-age=31536000, immutable",
    "Accept-Ranges": "bytes",
  };

  if (req.method === "HEAD") {
    res.writeHead(200, headers);
    res.end();
    return true;
  }

  res.writeHead(200, headers);
  createReadStream(file).pipe(res);
  return true;
}
