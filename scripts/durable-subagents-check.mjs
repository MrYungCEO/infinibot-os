#!/usr/bin/env node
/**
 * Integration proof for durable (tmux-backed) sub-agent spawns.
 *
 * Exercises the REAL code path — src/agents/coder-backend/durable-spawn.ts —
 * against a REAL tmux server on the `-L infinibot` socket, and proves the four
 * properties the fix is supposed to deliver:
 *
 *   1. a detached spawn creates a live `infinibot_spawn_<runId>` tmux session
 *   2. its stdout streams to the gateway while it runs (log tailing works)
 *   3. simulating a gateway shutdown (interruptAllSubagentRuns) leaves the
 *      session ALIVE and the run marked for recovery, not killed
 *   4. reattaching after that "restart" resumes the stream, and the run
 *      completes with its real exit code
 *   5. an explicit stop still destroys the session (durable != unkillable)
 *   6. a sweep / liveness-reconcile pass leaves a live run alone even when
 *      its recorded childPid is dead (the pid is the tmux pane's shell)
 *   7. closing the TERMINAL VIEW over the pane (destroyTerminal) leaves the
 *      run running — the 2026-09-04 kill vector
 *
 * Uses a `sleep`-style shell task rather than a real CLI so it is fast,
 * hermetic and does not burn tokens. Writes evidence to the path given as
 * argv[2] (default /tmp/durable-subagents-verify.txt).
 *
 *   node --import tsx scripts/durable-subagents-check.mjs [outfile]
 */
import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const OUT = process.argv[2] || "/tmp/durable-subagents-verify.txt";
const lines = [];
let failures = 0;

const log = (s) => {
  console.log(s);
  lines.push(s);
};
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmux = (...args) => {
  try {
    return execFileSync("tmux", ["-L", "infinibot", ...args], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
};

const {
  spawnDurableTmux,
  reattachDurableTmux,
  durableTmuxSession,
  durableTerminalId,
  isDurableSpawnEnabled,
  killDurableRun,
} = await import("../src/agents/coder-backend/durable-spawn.ts");
const { interruptAllSubagentRuns, isDurableSubagentRun } = await import(
  "../src/agents/subagent-registry.ts"
);

log("=== durable sub-agent verification ===");
log(`date: ${new Date().toISOString()}`);
log(`tmux: ${tmux("-V") ?? "NOT AVAILABLE"}`);
log(`durable spawns enabled: ${isDurableSpawnEnabled()}`);
log("");

if (!isDurableSpawnEnabled()) {
  log("FAIL  tmux unavailable — durable spawns would silently fall back.");
  writeFileSync(OUT, lines.join("\n") + "\n");
  process.exit(1);
}

const runId = `verify-${randomUUID()}`;
const session = durableTmuxSession(runId);
log(`runId:       ${runId}`);
log(`terminalId:  ${durableTerminalId(runId)}`);
log(`tmuxSession: ${session}`);
log("");

// ── 1. spawn a long-running "sub-agent" ────────────────────────────────────
// Emits a line a second (so we can observe streaming) then exits 0.
const chunks = [];
const shim = spawnDurableTmux({
  runId,
  command: "/bin/sh",
  args: ["-c", 'i=0; while [ $i -lt 12 ]; do echo "tick $i"; i=$((i+1)); sleep 1; done; exit 0'],
  cwd: process.cwd(),
  env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
});
shim.stdout.on("data", (c) => chunks.push(c));

let exitCode = null;
const exited = new Promise((resolve) => shim.on("close", (code) => { exitCode = code; resolve(); }));

await sleep(1500);
check("[1] tmux session is live after spawn", tmux("has-session", "-t", session) !== null, session);
check(
  "[1] session is listed on the infinibot socket",
  (tmux("list-sessions", "-F", "#{session_name}") ?? "").includes(session),
);

// ── 2. output streams while the run is in flight ───────────────────────────
await sleep(2500);
const streamedBeforeRestart = chunks.join("");
check(
  "[2] stdout streamed to the gateway while running",
  streamedBeforeRestart.includes("tick 0"),
  JSON.stringify(streamedBeforeRestart.split("\n")[0] ?? ""),
);

// ── 3. simulate the gateway shutdown sequence ──────────────────────────────
// Register the run the way claude-coder-tool's detach mode does, then run the
// exact function the gateway close handler calls.
const registry = await import("../src/agents/subagent-registry.ts");
registry.addSubagentRunForTests({
  runId,
  childSessionKey: `agent:coder:${runId}`,
  requesterSessionKey: "agent:verify",
  requesterDisplayKey: "agent:verify",
  task: "durable verification task",
  label: "durable verify",
  cleanup: "delete",
  createdAt: Date.now(),
  startedAt: Date.now(),
  childPid: shim.pid,
  coderBackend: "claude-code",
  durableSpawn: "tmux-coder",
  terminalId: durableTerminalId(runId),
  tmuxSession: session,
});
const entry = registry.getRunForTests(runId);
check("[3] run classified as durable", isDurableSubagentRun(entry) === true);

log("");
log("--- simulating gateway shutdown: interruptAllSubagentRuns() ---");
interruptAllSubagentRuns();

// Drop the in-process shim exactly as a dying gateway would.
shim.removeAllListeners?.();

const afterShutdown = registry.getRunForTests(runId);
check(
  "[3] tmux session SURVIVED the shutdown sweep",
  tmux("has-session", "-t", session) !== null,
  `tmux -L infinibot has-session -t ${session}`,
);
check("[3] run marked interrupted (for recovery)", typeof afterShutdown?.interruptedAt === "number");
check("[3] run NOT marked ended/failed", afterShutdown?.endedAt === undefined);
check("[3] pane pid still alive", (() => {
  try { process.kill(shim.pid, 0); return true; } catch { return false; }
})(), `pid ${shim.pid}`);

// ── 4. reattach as a restarted gateway would ───────────────────────────────
log("");
log("--- simulating gateway boot: reattachDurableTmux() ---");
const reattached = reattachDurableTmux(runId);
check("[4] reattach returned a live handle", reattached !== null);

const replayed = [];
let reattachedExit = null;
if (reattached) {
  reattached.stdout.on("data", (c) => replayed.push(c));
  await new Promise((resolve) => {
    reattached.on("close", (code) => { reattachedExit = code; resolve(); });
    setTimeout(resolve, 30_000);
  });
}
const replayedText = replayed.join("");
check("[4] reattached stream replayed history", replayedText.includes("tick 0"));
check("[4] reattached stream captured later output", replayedText.includes("tick 11"));
check("[4] run completed with its real exit code", reattachedExit === 0, `exitCode=${reattachedExit}`);
check("[4] tmux session cleaned up after the run finished", tmux("has-session", "-t", session) === null);

// ── 5. explicit stop still kills (subagents.stop path) ─────────────────────
// Durability must not make a run unstoppable: an operator Stop destroys the
// session, which is the ONE path allowed to do so.
log("");
log("--- explicit stop: killDurableRun() ---");
const stopId = `verify-stop-${randomUUID()}`;
const stopSession = durableTmuxSession(stopId);
const stopShim = spawnDurableTmux({
  runId: stopId,
  command: "/bin/sh",
  args: ["-c", "sleep 300"],
  cwd: process.cwd(),
  env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
});
let stopClosed = false;
stopShim.on("close", () => { stopClosed = true; });
await sleep(1000);
check("[5] stoppable run is live before stop", tmux("has-session", "-t", stopSession) !== null);
stopShim.kill("SIGTERM");
await sleep(1200);
check("[5] tmux session destroyed by explicit stop", tmux("has-session", "-t", stopSession) === null);
check("[5] shim reported close after the stop", stopClosed === true);

// ── 6. a sweep / liveness-reconcile pass must never end a live run ─────────
// Regression: the sweeper's ground truth for a normal run is its childPid, but
// a durable run's recorded pid is the tmux PANE's shell, which the gateway does
// not own. A stale/dead pid must NOT be read as "the agent died".
log("");
log("--- sweep pass: reconcileSubagentLiveness() + sweepSubagentRuns() ---");
const sweepId = `verify-sweep-${randomUUID()}`;
const sweepSession = durableTmuxSession(sweepId);
const sweepShim = spawnDurableTmux({
  runId: sweepId,
  command: "/bin/sh",
  args: ["-c", "sleep 300"],
  cwd: process.cwd(),
  env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
});
await sleep(1000);
// A pid that is definitely dead: spawnSync has already reaped it.
const deadPid = spawnSync("/bin/true").pid;
registry.addSubagentRunForTests({
  runId: sweepId,
  childSessionKey: `agent:coder:${sweepId}`,
  requesterSessionKey: "agent:verify",
  requesterDisplayKey: "agent:verify",
  task: "sweep verification task",
  label: "sweep verify",
  cleanup: "keep",
  createdAt: Date.now() - 60_000,
  startedAt: Date.now() - 60_000, // past the PID-race grace window
  childPid: deadPid,
  coderBackend: "claude-code",
  durableSpawn: "tmux-coder",
  terminalId: durableTerminalId(sweepId),
  tmuxSession: sweepSession,
});
check("[6] run is live before the sweep", tmux("has-session", "-t", sweepSession) !== null);
registry.reconcileSubagentLiveness();
await registry.runSweepForTests();
const afterSweep = registry.getRunForTests(sweepId);
check(
  "[6] tmux session SURVIVED the sweep",
  tmux("has-session", "-t", sweepSession) !== null,
  sweepSession,
);
check("[6] run NOT marked ended by the sweep", afterSweep?.endedAt === undefined);
check("[6] run has no failure outcome", afterSweep?.outcome === undefined);

// ── 7. closing the terminal VIEW must not kill the run ─────────────────────
// The 2026-09-04 kill: a gateway attached a pty client to these panes via the
// reattach dropdown, then `terminal.destroy` ran the ordinary teardown —
// `tmux kill-session` — on runs that were mid-turn.
log("");
log("--- terminal view close: destroyTerminal() on a live agent pane ---");
const { destroyTerminal } = await import("../src/terminal/terminal-lifecycle.ts");
const viewTerminalId = durableTerminalId(sweepId);
const fakeTerminals = new Map([
  [
    viewTerminalId,
    {
      id: viewTerminalId,
      // Unique projectPath → no persisted session file → removePersistedSession
      // is a no-op and this check never touches real terminal state.
      projectPath: `/tmp/durable-check-${randomUUID()}`,
      pty: { kill() {} },
    },
  ],
]);
const destroyResult = await destroyTerminal(viewTerminalId, fakeTerminals, () => {});
check("[7] destroy reported success", destroyResult.success === true);
check("[7] destroy reported the session preserved", destroyResult.tmuxSessionPreserved === true);
check(
  "[7] tmux session SURVIVED closing the terminal view",
  tmux("has-session", "-t", sweepSession) !== null,
  sweepSession,
);
check(
  "[7] pane pid still alive after the view closed",
  (() => {
    try { process.kill(sweepShim.pid, 0); return true; } catch { return false; }
  })(),
  `pid ${sweepShim.pid}`,
);

// …but an explicit kill still works, so a stuck pane is never unkillable.
fakeTerminals.set(viewTerminalId, {
  id: viewTerminalId,
  projectPath: `/tmp/durable-check-${randomUUID()}`,
  pty: { kill() {} },
});
await destroyTerminal(viewTerminalId, fakeTerminals, () => {}, { killAgentPane: true });
await sleep(800);
check(
  "[7] explicit killAgentPane DOES destroy the session",
  tmux("has-session", "-t", sweepSession) === null,
);

// ── cleanup ────────────────────────────────────────────────────────────────
killDurableRun(runId);
killDurableRun(stopId);
killDurableRun(sweepId);
void exited;
void exitCode;

log("");
log(`RESULT: ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
writeFileSync(OUT, lines.join("\n") + "\n");
log(`evidence written to ${OUT}`);
process.exit(failures === 0 ? 0 : 1);
