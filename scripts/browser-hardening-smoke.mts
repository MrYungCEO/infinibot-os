#!/usr/bin/env node
/**
 * Smoke test for the browser hardening + Infini Chrome profile work.
 *
 * Verifies:
 *   1. nav-policy: scheme allowlist (http/https vs file/data/javascript)
 *   2. nav-policy: SSRF (private IPs, cloud metadata) — bypass via allowPrivateHosts
 *   3. manager: ensureProfile creates ~/.infinibot/chrome-profile/infini/
 *   4. manager: profile list / info / sanitization rejects bad names
 *   5. manager: snapshot → restore round-trip (file-based, no browser)
 *   6. agent tool: profile.use_infini returns the canonical path
 *   7. agent tool: profile.delete refuses 'infini' without confirmInfini
 *
 * Uses a throwaway test profile dir so we never touch the user's real
 * ~/.infinibot/chrome-profile/infini/.
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { randomBytes } from "node:crypto";

// Force a sandboxed CONFIG_DIR for the duration of the smoke.
const sandboxDir = path.join(os.tmpdir(), `infinibot-browser-smoke-${randomBytes(3).toString("hex")}`);
process.env.INFINIBOT_STATE_DIR = sandboxDir;

const {
  assertNavigable,
  DEFAULT_NAV_POLICY,
  NavigationBlockedError,
} = await import("../src/browser/security/nav-policy.js");
const {
  ensureProfile,
  listProfiles,
  describeProfile,
  deleteProfile,
  snapshotProfile,
  restoreProfileFromSnapshot,
  listSnapshots,
  deleteSnapshot,
  userDataDirFor,
  chromeProfileRoot,
  chromeProfileSnapshotRoot,
  sanitizeProfileName,
} = await import("../src/browser/manager.js");
const { INFINI_PROFILE_NAME } = await import("../src/browser/profiles/types.js");
const { createBrowserTool } = await import("../src/agents/tools/browser-tool.js");

function ok(label: string) { console.log(`✓ ${label}`); }
function fail(label: string, detail?: unknown): never {
  console.error(`✗ ${label}`);
  if (detail !== undefined) console.error("  detail:", detail);
  process.exit(1);
}

async function expectBlocked(url: string, reason: string, label: string): Promise<void> {
  try {
    await assertNavigable(url, DEFAULT_NAV_POLICY);
  } catch (err) {
    if (err instanceof NavigationBlockedError && err.reason === reason) {
      ok(`${label}: blocked (${reason})`);
      return;
    }
    fail(label, err);
  }
  fail(`${label}: expected block, got success`);
}

async function expectAllowed(url: string, label: string): Promise<void> {
  try {
    const parsed = await assertNavigable(url, DEFAULT_NAV_POLICY);
    ok(`${label}: allowed (host=${parsed.hostname})`);
  } catch (err) {
    fail(label, err);
  }
}

function readJsonFromToolResult(r: unknown): Record<string, unknown> {
  const x = r as { content?: Array<{ type: string; text?: string }> };
  const t = x.content?.find((c) => c.type === "text")?.text ?? "{}";
  try { return JSON.parse(t) as Record<string, unknown>; } catch { return {}; }
}

async function main() {
  console.log("=== sandbox CONFIG_DIR:", sandboxDir, "===\n");

  /* 1. Scheme allowlist */
  console.log("--- 1. URL scheme allowlist ---");
  await expectBlocked("file:///etc/passwd", "scheme", "file://");
  await expectBlocked("data:text/html,<h1>x", "scheme", "data:");
  await expectBlocked("javascript:alert(1)", "scheme", "javascript:");
  await expectBlocked("chrome://settings/", "scheme", "chrome://");

  /* 2. SSRF + private IP */
  console.log("\n--- 2. Private-IP / SSRF guard ---");
  await expectBlocked("http://127.0.0.1:8080/", "private_ip", "127.0.0.1");
  await expectBlocked("http://10.0.0.5/", "private_ip", "10.0.0.5");
  await expectBlocked("http://169.254.169.254/latest/meta-data/", "private_ip", "AWS metadata");
  await expectAllowed("https://example.com/", "https://example.com");

  // localhost is allowed by an explicit policy bypass.
  const localPolicy = { ...DEFAULT_NAV_POLICY, allowPrivateHosts: ["localhost", "127.0.0.1"] };
  try {
    await assertNavigable("http://127.0.0.1:3000/", localPolicy);
    ok("127.0.0.1 allowed with allowPrivateHosts=['127.0.0.1']");
  } catch (err) {
    fail("private host should be allowed via allowPrivateHosts", err);
  }

  /* 3. Manager: ensureProfile, paths */
  console.log("\n--- 3. Manager profile lifecycle ---");
  const root = chromeProfileRoot();
  if (!root.endsWith(path.join("chrome-profile"))) fail("profile root path", root);
  ok(`chrome profile root resolves to ${root}`);

  const desc = await ensureProfile(INFINI_PROFILE_NAME);
  if (!desc.exists) fail("ensureProfile didn't create the dir");
  if (!desc.userDataDir.endsWith(path.join("chrome-profile", "infini"))) {
    fail("infini profile path", desc.userDataDir);
  }
  ok(`infini profile created at ${desc.userDataDir}`);

  await ensureProfile("work");
  await ensureProfile("research");
  const profiles = await listProfiles();
  if (profiles.length < 3) fail("expected ≥3 profiles", profiles);
  ok(`listed ${profiles.length} profiles: ${profiles.map((p) => p.name).join(", ")}`);

  try {
    sanitizeProfileName("../etc/passwd");
    fail("sanitizeProfileName should reject ../etc/passwd");
  } catch {
    ok("sanitizeProfileName rejects path-traversal");
  }
  try {
    sanitizeProfileName("hi there");
    fail("sanitizeProfileName should reject spaces");
  } catch {
    ok("sanitizeProfileName rejects spaces");
  }

  /* 4. Snapshot/restore round-trip */
  console.log("\n--- 4. Snapshot / restore round-trip ---");
  // Drop a marker file in the profile so we can verify restore
  await fsp.writeFile(path.join(desc.userDataDir, "MARKER.txt"), "infini-original\n");
  const snap = await snapshotProfile(INFINI_PROFILE_NAME, "smoke-test");
  if (!fs.existsSync(snap.path)) fail("snapshot file missing", snap.path);
  ok(`snapshot created: ${path.basename(snap.path)} (${snap.size} bytes)`);

  // Mutate the marker, then restore.
  await fsp.writeFile(path.join(desc.userDataDir, "MARKER.txt"), "MUTATED\n");
  const restored = await restoreProfileFromSnapshot(snap.path, INFINI_PROFILE_NAME);
  const final = await fsp.readFile(path.join(restored.userDataDir, "MARKER.txt"), "utf-8");
  if (final.trim() !== "infini-original") fail("restore did not bring marker back", final);
  ok("restore brought the marker file back to its pre-mutation content");

  const snaps = await listSnapshots(INFINI_PROFILE_NAME);
  if (snaps.length < 1) fail("expected ≥1 snapshot in listing");
  ok(`listed ${snaps.length} snapshot(s) for infini`);
  await deleteSnapshot(snap.path);
  ok("snapshot deleted");

  /* 5. Tool surface */
  console.log("\n--- 5. Agent tool surface ---");
  const tool = createBrowserTool();
  const r1 = await tool.execute("s1", { action: "profile.use_infini" });
  const j1 = readJsonFromToolResult(r1);
  if (!j1.ok || j1.profile !== INFINI_PROFILE_NAME) fail("profile.use_infini result", j1);
  ok(`profile.use_infini → ${j1.userDataDir}`);

  const r2 = await tool.execute("s2", { action: "profile.list" });
  const j2 = readJsonFromToolResult(r2);
  if (typeof j2.count !== "number" || j2.count < 1) fail("profile.list result", j2);
  ok(`profile.list → ${j2.count} profile(s)`);

  // Delete should refuse 'infini' without confirmInfini.
  const r3 = await tool.execute("s3", { action: "profile.delete", profileName: INFINI_PROFILE_NAME });
  const j3 = readJsonFromToolResult(r3);
  if (!j3.error && j3.ok !== false) fail("profile.delete should have surfaced an error", j3);
  // The tool wraps errors via jsonResult — check the content includes the typo-protection message
  const text = ((r3 as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? "");
  if (!/typo protection|confirmInfini/i.test(text)) {
    fail("expected typo-protection error in tool result", text);
  }
  ok("profile.delete on 'infini' is typo-protected (requires confirmInfini)");

  const r4 = await tool.execute("s4", { action: "profile.create", profileName: "test-create" });
  const j4 = readJsonFromToolResult(r4);
  if (!j4.ok) fail("profile.create", j4);
  ok(`profile.create → ${(j4.profile as Record<string, unknown>).userDataDir}`);

  // Now delete the test profile without confirmInfini (should work).
  const r5 = await tool.execute("s5", { action: "profile.delete", profileName: "test-create" });
  const j5 = readJsonFromToolResult(r5);
  if (!j5.ok) fail("profile.delete on test-create", j5);
  ok("non-infini profile deleted without confirmInfini");

  // Snapshot via tool.
  const r6 = await tool.execute("s6", {
    action: "profile.snapshot",
    profileName: INFINI_PROFILE_NAME,
    label: "tool-smoke",
  });
  const j6 = readJsonFromToolResult(r6);
  if (!j6.ok) fail("profile.snapshot via tool", j6);
  ok(`profile.snapshot via tool → ${path.basename(((j6.snapshot as { path: string }).path))}`);

  const r7 = await tool.execute("s7", {
    action: "profile.snapshots",
    profileName: INFINI_PROFILE_NAME,
  });
  const j7 = readJsonFromToolResult(r7);
  if ((j7.count as number) < 1) fail("profile.snapshots count", j7);
  ok(`profile.snapshots → ${j7.count} entry`);

  // Clean up the smoke-created snapshot.
  await deleteSnapshot((j6.snapshot as { path: string }).path);
  ok("cleaned up tool-created snapshot");

  /* 6. Cleanup */
  console.log("\n--- 6. Cleanup sandbox ---");
  await fsp.rm(sandboxDir, { recursive: true, force: true });
  ok("sandbox dir removed");

  console.log("\nOK — browser hardening verified");
  // Suppress reference to chromeProfileSnapshotRoot lint
  void chromeProfileSnapshotRoot;
  void userDataDirFor;
  void describeProfile;
  void deleteProfile;
}

main().catch((err) => {
  console.error("FAIL:", err);
  // Try to clean the sandbox regardless
  try { fs.rmSync(sandboxDir, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
