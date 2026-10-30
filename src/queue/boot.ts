/**
 * Queue orchestrator boot wiring.
 *
 * The orchestrator (src/queue/orchestrator.ts) is dependency-injected so it
 * can be tested without the gateway. This module is the production wiring:
 * the backend-agnostic phase runner (durable CLI spawns + verified
 * completion, or gateway agents), the cached CLI availability probe, the
 * completion contract, and the W5 permission-bypass policy.
 *
 * Called once from server-runtime-state.ts after the broadcaster is ready.
 * `INFINIBOT_QUEUE=0` disables the orchestrator (RPCs still read the store).
 */

import { createSubsystemLogger } from "../logging/subsystem.js";
import { getQueueOrchestrator, peekQueueOrchestrator } from "./orchestrator.js";
import { createPhaseRunner } from "./phase-runner.js";
import { createAvailabilityCache } from "./backends.js";
import { COMPLETION_CONTRACT_PROMPT } from "../verification/contract.js";
import { resolveCoderAutoApprove } from "../agents/coder-backend/approval-policy.js";
import { loadConfig } from "../config/config.js";
import { listAllSubagentRuns, isSubagentRunActive } from "../agents/subagent-registry.js";

const log = createSubsystemLogger("queue-boot");

let started = false;

/** Shared cache so queue.backends and the dispatcher see the same probe results. */
export const queueAvailability = createAvailabilityCache();

export function startQueueOrchestrator(): void {
  if (started) return;
  if (process.env.INFINIBOT_QUEUE === "0") {
    log.info("queue orchestrator disabled (INFINIBOT_QUEUE=0)");
    return;
  }
  started = true;
  try {
    const orch = getQueueOrchestrator({
      runner: createPhaseRunner(),
      availability: queueAvailability,
      contractPrompt:
        process.env.INFINIBOT_VERIFIED_COMPLETION !== "0" ? COMPLETION_CONTRACT_PROMPT : undefined,
      // W5 trust model: only trusted (operator-created) entries get the CLI
      // permission bypass, and tools.coder.autoApprove=never always wins.
      autoApprove: (entry) =>
        resolveCoderAutoApprove({
          requested: true,
          trustedOrigin: entry.trusted,
          cfg: loadConfig(),
        }),
      listActiveRuns: () =>
        listAllSubagentRuns()
          .filter(isSubagentRunActive)
          .filter((r) => !r.runId.startsWith("q-"))
          .map((r) => ({ runId: r.runId, workdir: r.workdir, task: r.task })),
    });
    orch.start();
    log.info("queue orchestrator booted", { id: orch.id });
  } catch (err) {
    log.warn("queue orchestrator failed to boot", { error: String(err) });
    started = false; // allow a manual retry later
  }
}

/** Gateway shutdown: stop ticking and release the dispatch lease (agents keep running in tmux). */
export function stopQueueOrchestrator(): void {
  peekQueueOrchestrator()?.stop();
}
