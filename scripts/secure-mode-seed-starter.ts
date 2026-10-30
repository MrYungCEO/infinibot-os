/**
 * Create the "Secure Mode" kanban project and its starter tasks INSIDE the
 * secure lane (encrypted vault) of a state dir. Idempotent: existing tasks
 * with the same title are left alone. Does not turn Secure Mode on and does
 * not need a running gateway — it opens the vault with the state dir's master
 * key from the OS keyring (creating it on first use).
 *
 *   node --import tsx scripts/secure-mode-seed-starter.ts --state-dir ~/.infinibot
 */

import os from "node:os";
import path from "node:path";

import { resolveMasterKey } from "../src/secure-mode/keyring.js";
import { SecureLaneStore, type SecureTaskStatus } from "../src/secure-mode/lane-store.js";
import { SecureVault } from "../src/secure-mode/vault.js";

const STARTER: Array<{ title: string; status: SecureTaskStatus; priority: "low" | "medium" | "high"; description: string }> = [
  { title: "Isolated live-data lane: secure kanban, docs and KG stored separately, never synced to Notion or any cloud", status: "review", priority: "high", description: "secure.* RPCs over the encrypted vault; no Notion/cloud code path. Verified by unit tests + side-gateway e2e (zero Notion egress for secure writes)." },
  { title: "Local models only: enforce at model resolution, block hosted providers and remote CLI coders", status: "review", priority: "high", description: "Guards in runEmbeddedPiAgent (configured + resolved baseUrl), compaction and runCliAgent. Hosted / ollama-cloud / CLI backends fail closed with 'Blocked by Secure Mode'." },
  { title: "Separate knowledge-graph slice + optional one-time seed from the current graph", status: "review", priority: "medium", description: "secure.graph.snapshot (same shape as graph.global.snapshot) + secure.graph.seed {confirm:true} (admin, one-time)." },
  { title: "Encryption at rest: AES-256-GCM envelope, master key in the OS keyring", status: "review", priority: "high", description: "vault.ts envelope (fresh DEK + IV per write, AAD-bound to store). Key via secret-tool / libsecret; env or opt-in file fallback." },
  { title: "No external egress for secure runs: local-only tool allowlist, fail closed", status: "review", priority: "high", description: "Secure runs get read + secure_lane only. Link/media understanding, TTS, hooks, notifications text, Telegram completions and memory flush are skipped or redacted." },
  { title: "Secure Mode toggles + persistent indicator on KG, Kanban/Dashboard/HQ, Documents, chat, group chat and mobile", status: "review", priority: "medium", description: "secure.status / secure.set single source of truth, broadcast as secure.mode.changed." },
  { title: "Audit / threat-model doc (docs/security/secure-mode.md)", status: "done", priority: "medium", description: "What is isolated, what is encrypted, known gaps." },
  { title: "Restart the live gateway to activate Secure Mode (restart-pending)", status: "todo", priority: "high", description: "Merged into deploy/flypic-fixes-live; the running gateway does not serve secure.* until restarted." },
  { title: "Verify encrypted swap / no hibernation on this host", status: "todo", priority: "medium", description: "Threat-model gap: live secure transcripts sit in tmpfs while unlocked." },
  { title: "Optional: install libsecret-tools (secret-tool) for the primary keyring path", status: "todo", priority: "low", description: "This host currently uses libsecret through python-gi, which works." },
  { title: "Decide on a local-model exception for coder CLIs (currently always blocked)", status: "todo", priority: "low", description: "The gateway cannot verify where a CLI routes model calls." },
];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const raw = arg("--state-dir") ?? process.env.INFINIBOT_STATE_DIR ?? path.join(os.homedir(), ".infinibot");
  const stateDir = path.resolve(raw.replace(/^~(?=$|\/)/, os.homedir()));
  const key = await resolveMasterKey({ stateDir });
  const lane = new SecureLaneStore(new SecureVault(key.key, path.join(stateDir, "secure", "vault")));
  let project = lane.findProjectByName("Secure Mode");
  if (!project) {
    project = lane.createProject({
      name: "Secure Mode",
      description: "Isolated, encrypted, local-models-only lane. Design + threat model: docs/security/secure-mode.md",
    });
  }
  const existing = new Set(lane.listKanban().tasks.filter((t) => t.projectId === project!.id).map((t) => t.title));
  let created = 0;
  for (const t of STARTER) {
    if (existing.has(t.title)) continue;
    lane.createTask({ ...t, projectId: project.id });
    created += 1;
  }
  const counts = lane.counts();
  key.key.fill(0);
  console.log(
    JSON.stringify({ stateDir, keySource: key.source, keyCreated: key.created, project: project.id, created, counts }),
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
