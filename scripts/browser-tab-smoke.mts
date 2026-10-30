#!/usr/bin/env node
/**
 * Smoke for the /browser tab — exercises the browser.setup.* handlers
 * directly (no gateway needed) and verifies the response shape the UI
 * view consumes.
 */

import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { randomBytes } from "node:crypto";

const sandboxDir = path.join(os.tmpdir(), `infinibot-browser-tab-smoke-${randomBytes(3).toString("hex")}`);
process.env.INFINIBOT_STATE_DIR = sandboxDir;

const { browserSetupHandlers } = await import("../src/gateway/server-methods/browser-setup.js");

interface Resp { ok: boolean; payload?: unknown; error?: { code: string; message: string } }
function makeRespond(): { respond: (ok: boolean, payload?: unknown, err?: unknown) => void; result: () => Resp } {
  let captured: Resp = { ok: false };
  return {
    respond: (ok, payload, err) => {
      captured = { ok, payload, error: err as Resp["error"] };
    },
    result: () => captured,
  };
}

async function call(method: string, params: Record<string, unknown> = {}): Promise<Resp> {
  const handler = browserSetupHandlers[method];
  if (!handler) throw new Error(`no handler: ${method}`);
  const { respond, result } = makeRespond();
  await handler({
    req: { type: "req", id: "test", method, params } as never,
    params,                       // ← top-level too; handlers destructure this
    respond: respond as never,
    client: {} as never,
    isWebchatConnect: false,
    context: {} as never,
  } as never);
  return result();
}

function ok(label: string) { console.log(`✓ ${label}`); }
function bad(label: string, detail?: unknown): never {
  console.error(`✗ ${label}`);
  if (detail !== undefined) console.error("  detail:", detail);
  process.exit(1);
}

async function main() {
  console.log("=== sandbox:", sandboxDir, "===\n");

  console.log("--- browser.setup.status ---");
  const r1 = await call("browser.setup.status");
  if (!r1.ok) bad("status returned not-ok", r1.error);
  const status = r1.payload as Record<string, unknown>;
  for (const key of ["chrome", "playwright", "extension", "infini", "profiles", "snapshots", "paths"]) {
    if (!(key in status)) bad(`response missing key: ${key}`, status);
  }
  ok(`status returned all expected keys (${Object.keys(status).length})`);
  console.log("  chrome.found:", (status.chrome as { found: boolean }).found);
  console.log("  playwright:", (status.playwright as { version?: string }).version);
  console.log("  extension.found:", (status.extension as { found: boolean }).found);
  console.log("  infini.exists:", (status.infini as { exists: boolean }).exists);

  console.log("\n--- browser.setup.create_infini ---");
  const r2 = await call("browser.setup.create_infini");
  if (!r2.ok) bad("create_infini failed", r2.error);
  const profile = (r2.payload as { profile?: { exists?: boolean; userDataDir?: string } }).profile;
  if (!profile?.exists) bad("create_infini didn't mark profile exists", r2.payload);
  ok(`infini created at ${profile.userDataDir}`);

  console.log("\n--- status now shows infini ---");
  const r3 = await call("browser.setup.status");
  const infini = (r3.payload as { infini: { exists: boolean } }).infini;
  if (!infini.exists) bad("status didn't reflect created infini");
  ok("status reflects created infini");

  console.log("\n--- snapshot + restore + delete ---");
  // Drop marker
  await fs.writeFile(path.join(profile.userDataDir!, "MARKER.txt"), "original");
  const r4 = await call("browser.setup.snapshot", { profileName: "infini", label: "tab-smoke" });
  if (!r4.ok) bad("snapshot failed", r4.error);
  const snap = (r4.payload as { snapshot: { path: string } }).snapshot;
  ok(`snapshot created: ${path.basename(snap.path)}`);

  await fs.writeFile(path.join(profile.userDataDir!, "MARKER.txt"), "MUTATED");
  const r5 = await call("browser.setup.restore", { archivePath: snap.path, profileName: "infini" });
  if (!r5.ok) bad("restore failed", r5.error);
  const restoredMarker = await fs.readFile(path.join(profile.userDataDir!, "MARKER.txt"), "utf-8");
  if (restoredMarker.trim() !== "original") bad("restore didn't bring marker back", restoredMarker);
  ok("restore brought marker back");

  const r6 = await call("browser.setup.delete_snapshot", { archivePath: snap.path });
  if (!r6.ok) bad("delete_snapshot failed");
  ok("snapshot deleted");

  console.log("\n--- delete_profile typo protection ---");
  const r7 = await call("browser.setup.delete_profile", { profileName: "infini" });
  if (r7.ok) bad("delete_profile on infini should have failed without confirmInfini");
  ok(`delete_profile blocked: ${r7.error?.message?.slice(0, 60)}…`);

  const r8 = await call("browser.setup.delete_profile", { profileName: "infini", confirmInfini: true });
  if (!r8.ok) bad("delete_profile with confirmInfini failed", r8.error);
  ok("delete_profile with confirmInfini succeeded");

  console.log("\n--- cleanup ---");
  await fs.rm(sandboxDir, { recursive: true, force: true });
  ok("sandbox cleaned");

  console.log("\nOK — /browser tab handlers verified");
}

main().catch(async (err) => {
  console.error("FAIL:", err);
  try { await fs.rm(sandboxDir, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
