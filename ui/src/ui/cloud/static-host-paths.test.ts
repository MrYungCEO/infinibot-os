/**
 * Every Netlify Function route (netlify/functions/*.mts config.path) must stay on
 * the static host once the cloud app has resolved its tenant gateway; a route
 * missing from STATIC_HOST_PATHS is re-pointed at the gateway and 404s (live
 * 2026-10-06: /api/usage/heartbeat froze hosted Free's meter, upsells and gate).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isStaticHostPath } from "../gateway-endpoint.ts";

const FN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../netlify/functions");

function functionPaths(): string[] {
  const out: string[] = [];
  for (const f of fs.readdirSync(FN_DIR).filter((n) => n.endsWith(".mts"))) {
    const src = fs.readFileSync(path.join(FN_DIR, f), "utf8");
    const cfg = /export const config[\s\S]*?path:\s*(\[[^\]]*\]|"[^"]*")/.exec(src)?.[1] ?? "";
    for (const m of cfg.matchAll(/"(\/api\/[^"]*)"/g)) out.push(m[1].replace(/\*$/, "x"));
  }
  return out;
}

describe("static host paths (cloud fetch routing)", () => {
  it("keeps the daily-usage meter and the voice broker on the static host", () => {
    expect(isStaticHostPath("/api/usage")).toBe(true);
    expect(isStaticHostPath("/api/usage/heartbeat")).toBe(true);
    expect(isStaticHostPath("/api/voice/connection-details")).toBe(true);
    expect(isStaticHostPath("/api/stt")).toBe(false); // a gateway route
  });

  it("covers every Netlify Function route except /api/channels (the gateway's nostr route)", () => {
    const paths = functionPaths();
    expect(paths.length).toBeGreaterThan(15);
    const missing = paths.filter((p) => !p.startsWith("/api/channels") && !isStaticHostPath(p));
    expect(missing).toEqual([]);
  });
});
