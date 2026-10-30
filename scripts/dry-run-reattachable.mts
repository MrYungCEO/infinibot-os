/**
 * Dry-run for terminal.listReattachable classification + reattach mapping.
 *
 * Proves the logic against the REAL `-L infinibot` tmux socket without a
 * gateway restart (operator-controlled). Steps:
 *   1. Enumerate live sessions via TmuxBackend.listLiveSessions() (ground truth).
 *   2. Seed the required mix: a claude-coder (cloud) spawn pane, a codex spawn
 *      pane, and rely on existing CLI/shell panes — so the fleet contains all
 *      three kinds.
 *   3. Feed realistic subagent runs to the PURE classifier (registry can't be
 *      imported here: this node_modules-less-of-siblings worktree is missing a
 *      few uncommitted registry deps).
 *   4. Print the unified list grouped by kind and assert the reattach directive
 *      per kind.
 *   5. Prove the ATTACH-NOT-RESPAWN guarantee: record a pane's PID + a marker
 *      line, run the reattach command (`tmux new-session -A`), and confirm the
 *      PID and scrollback survive (no double-attach, no respawn).
 *
 * Run: node_modules/.bin/tsx scripts/dry-run-reattachable.mts
 */
import { execFileSync } from "node:child_process";
import * as TmuxBackend from "../src/terminal/tmux-backend.js";
import {
  classifyReattachable,
  type SpawnRunLite,
  type ClassifyContext,
} from "../src/terminal/reattachable.js";

const SOCK = ["-L", "infinibot"];
function tmux(args: string[]): string {
  try {
    return execFileSync("tmux", [...SOCK, ...args], { encoding: "utf8" });
  } catch (e: any) {
    return e?.stdout?.toString?.() ?? "";
  }
}

const created: string[] = [];
function seedSpawnSession(runIdPrefix: string, cmd: string): string {
  const termId = `spawn-${runIdPrefix}-${Date.now()}`;
  const name = TmuxBackend.tmuxSessionName(termId);
  tmux(["new-session", "-d", "-s", name, "-x", "120", "-y", "40", cmd]);
  created.push(name);
  return termId;
}

async function main() {
  console.log("=== 1. REAL live tmux sessions on -L infinibot (pre-seed) ===");
  const pre = [...(await TmuxBackend.listLiveSessions())];
  console.log(`   ${pre.length} live session(s):`);
  for (const id of pre) console.log(`     • ${id}`);

  console.log("\n=== 2. Seeding required cloud + codex spawn panes ===");
  // Long-running marker processes so the panes stay alive for classification.
  const cloudTerm = seedSpawnSession("11aa22bb", "sh -c 'echo CLAUDE_CODER_MARKER; sleep 600'");
  const codexTerm = seedSpawnSession("33cc44dd", "sh -c 'echo CODEX_MARKER; sleep 600'");
  console.log(`   cloud spawn:  ${cloudTerm}`);
  console.log(`   codex spawn:  ${codexTerm}`);

  console.log("\n=== 3. Enumerate again (ground truth incl. seeded) + classify ===");
  const liveIds = [...(await TmuxBackend.listLiveSessions())];

  // Realistic runs, as listAllSubagentRuns() would return them.
  const runs: SpawnRunLite[] = [
    {
      runId: "11aa22bb-full-run-id-0001",
      terminalId: cloudTerm,
      agentId: "dev",
      workdir: process.cwd(),
      label: "refactor auth flow",
      coderBackend: "claude-code",
      childSessionKey: "agent:dev:run-11aa22bb",
      task: "refactor the auth flow end to end",
    },
    {
      runId: "33cc44dd-full-run-id-0002",
      terminalId: codexTerm,
      agentId: "ops",
      workdir: "/tmp/codex-wt",
      label: "migrate config schema",
      coderBackend: "codex",
      childSessionKey: "agent:ops:run-33cc44dd",
      task: "migrate the config schema to v2",
    },
  ];

  // Best-effort cwd for panes with no run/mem/saved cwd (real CLI/shell ones).
  const cwdFallback = new Map<string, string>();
  for (const id of liveIds) {
    if (runs.some((r) => r.terminalId === id)) continue;
    const cwd = await TmuxBackend.getSessionCwd(id);
    if (cwd) cwdFallback.set(id, cwd);
  }

  const ctx: ClassifyContext = {
    liveIds,
    runs,
    memTerminals: new Map(),
    savedSessions: new Map(),
    cwdFallback,
  };
  const entries = classifyReattachable(ctx);

  const byKind: Record<string, typeof entries> = { cloud: [], codex: [], cli: [], shell: [] };
  for (const e of entries) (byKind[e.kind] ||= []).push(e);

  for (const kind of ["cloud", "codex", "cli", "shell"] as const) {
    const list = byKind[kind] ?? [];
    console.log(`\n   ── ${kind.toUpperCase()} (${list.length}) ──`);
    for (const e of list) {
      console.log(
        `     • ${e.label}\n` +
          `         id=${e.id}\n` +
          `         backend=${e.backend ?? "-"} runId=${e.runId ?? "-"} cwd=${e.cwd}\n` +
          `         reattach → ${e.reattach.method}  params=${JSON.stringify(e.reattach.params)}`,
      );
    }
  }

  console.log("\n=== 4. Assertions ===");
  const cloud = entries.find((e) => e.id === cloudTerm)!;
  const codex = entries.find((e) => e.id === codexTerm)!;
  const shellOrCli = entries.find((e) => e.kind === "shell" || e.kind === "cli");
  const checks: Array<[string, boolean]> = [
    ["cloud pane classified kind=cloud", cloud?.kind === "cloud"],
    ["cloud backend=claude-code", cloud?.backend === "claude-code"],
    ["cloud → reattachSpawnAgent w/ terminalId+runId", cloud?.reattach.method === "terminal.reattachSpawnAgent" && !!(cloud.reattach.params as any).terminalId && !!(cloud.reattach.params as any).runId],
    ["codex pane classified kind=codex", codex?.kind === "codex"],
    ["codex → reattachSpawnAgent", codex?.reattach.method === "terminal.reattachSpawnAgent"],
    ["≥1 real CLI/shell pane present", !!shellOrCli],
    ["CLI/shell → terminal.create (attach)", !shellOrCli || shellOrCli.reattach.method === "terminal.create"],
    ["every entry live:true", entries.every((e) => e.live === true)],
  ];
  let ok = true;
  for (const [name, pass] of checks) {
    console.log(`   ${pass ? "✅" : "❌"} ${name}`);
    if (!pass) ok = false;
  }

  console.log("\n=== 5. Attach-not-respawn proof (core reattach guarantee) ===");
  const proofName = TmuxBackend.tmuxSessionName(cloudTerm);
  const pidBefore = tmux(["display-message", "-p", "-t", proofName, "#{pane_pid}"]).trim();
  // Write a scrollback marker into the live pane.
  tmux(["send-keys", "-t", proofName, "echo SCROLLBACK_SURVIVES_MARKER", "Enter"]);
  await new Promise((r) => setTimeout(r, 400));
  // Reattach the way terminal.create/spawnTmuxPty does: new-session -A -s <name>.
  // -d so we don't block; -A attaches to the existing session if present.
  tmux(["new-session", "-A", "-d", "-s", proofName, "-x", "120", "-y", "40"]);
  const pidAfter = tmux(["display-message", "-p", "-t", proofName, "#{pane_pid}"]).trim();
  const pane = await TmuxBackend.capturePane(cloudTerm, 200);
  const scrollbackOk = pane.includes("SCROLLBACK_SURVIVES_MARKER") || pane.includes("CLAUDE_CODER_MARKER");
  const pidOk = pidBefore !== "" && pidBefore === pidAfter;
  console.log(`   pane_pid before=${pidBefore} after=${pidAfter}`);
  console.log(`   ${pidOk ? "✅" : "❌"} pane PID unchanged after new-session -A (attached, not respawned)`);
  console.log(`   ${scrollbackOk ? "✅" : "❌"} scrollback/marker survived the reattach`);
  if (!pidOk || !scrollbackOk) ok = false;

  console.log("\n=== cleanup: killing seeded panes ===");
  for (const name of created) tmux(["kill-session", "-t", name]);

  console.log(`\n${ok ? "✅ DRY-RUN PASSED" : "❌ DRY-RUN FAILED"}`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error("dry-run crashed:", e);
  for (const name of created) tmux(["kill-session", "-t", name]);
  process.exit(1);
});
