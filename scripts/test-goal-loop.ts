/**
 * E2E test for the goal loop.
 *
 * 1. Connects to the running gateway via callGateway
 * 2. Enqueues a trivial goal (budget: 3 turns)
 * 3. Polls status every 1s for up to 60s
 * 4. Asserts completed + at least one done=true verdict
 * 5. Prints conversation tail + verdict history
 */

import { callGateway } from "../src/gateway/call.js";

const args = process.argv.slice(2);
const SINGLE_MODE = args.includes("--single");
const GOAL_TEXT = "Count from 1 to 5 in your response, then say 'done'.";
const BUDGET = 3;
const POLL_INTERVAL_MS = 2_000;
const TIMEOUT_MS = 90_000;

function log(msg: string) {
  console.log(`[test-goal-loop] ${new Date().toISOString()} ${msg}`);
}

async function gw(method: string, params: unknown): Promise<unknown> {
  return callGateway({ method, params, timeoutMs: 15_000 });
}

async function main() {
  log(`Enqueuing goal: "${GOAL_TEXT}" (budget: ${BUDGET} turns, mode: ${SINGLE_MODE ? "single" : "orchestrator"})`);

  let enqueueResult: any;
  try {
    enqueueResult = await gw("autonomy:goal.enqueue", { text: GOAL_TEXT, budget: BUDGET, goalMode: SINGLE_MODE ? "single" : "orchestrator" });
  } catch (e) {
    console.error("FAIL: autonomy:goal.enqueue threw:", e);
    process.exit(1);
  }

  if (!enqueueResult?.taskId) {
    console.error("FAIL: enqueue did not return taskId:", enqueueResult);
    process.exit(1);
  }

  const taskId = enqueueResult.taskId as string;
  log(`Goal enqueued — taskId: ${taskId}`);
  log("Polling status…");

  const deadline = Date.now() + TIMEOUT_MS;
  let lastStatus: any = null;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

    let statusResult: any;
    try {
      statusResult = await gw("autonomy:goal.status", { taskId });
    } catch (e) {
      log(`status poll error (retrying): ${String(e)}`);
      continue;
    }

    lastStatus = statusResult;
    const { status, budget, judgeVerdicts, currentPhase } = statusResult as any;
    log(
      `  status=${status} phase=${currentPhase ?? "—"} turnsUsed=${budget?.turnsUsed ?? "?"}/${budget?.maxTurns ?? "?"}`,
    );

    if (status === "completed" || status === "failed" || status === "cancelled") {
      log(`Goal reached terminal status: ${status}`);
      break;
    }
  }

  if (!lastStatus) {
    console.error("FAIL: never got a status response");
    process.exit(1);
  }

  // ── Print Results ──────────────────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════");
  console.log("GOAL LOOP TEST RESULTS");
  console.log("═══════════════════════════════════════");
  console.log(`taskId: ${taskId}`);
  console.log(`Final status: ${lastStatus.status}`);
  console.log(`Turns used: ${lastStatus.budget?.turnsUsed ?? "?"}/${lastStatus.budget?.maxTurns ?? "?"}`);

  const verdicts: any[] = lastStatus.judgeVerdicts ?? [];
  console.log(`\nJudge Verdicts (${verdicts.length}):`);
  for (const v of verdicts) {
    const ts = new Date(v.at).toISOString();
    console.log(
      `  [${ts}] done=${v.done} | ${v.rationale}${v.nextPrompt ? ` | next: ${v.nextPrompt}` : ""}`,
    );
  }

  // ── Assertions ─────────────────────────────────────────────────────────────
  let passed = true;

  if (lastStatus.status !== "completed") {
    console.error(`\nASSERT FAIL: expected status=completed, got ${lastStatus.status}`);
    passed = false;
  }

  const hasDoneVerdict = verdicts.some((v: any) => v.done === true);
  if (!hasDoneVerdict) {
    console.error(`\nASSERT FAIL: no judge verdict with done=true found`);
    passed = false;
  }

  if (passed) {
    console.log("\n✓ ALL ASSERTIONS PASSED");
    process.exit(0);
  } else {
    console.log("\n✗ TEST FAILED — see above for details");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("FAIL (uncaught):", e);
  process.exit(1);
});
