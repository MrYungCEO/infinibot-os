import { describe, expect, it } from "vitest";
import { emitAgentEvent, getAgentEventSeqRunCountForTest } from "./agent-events.js";

describe("agent-events per-run sequence counters", () => {
  it("are bounded: finished runs are forgotten once they age out", () => {
    const before = getAgentEventSeqRunCountForTest();
    for (let i = 0; i < 3000; i++) {
      const runId = `bounds-run-${i}`;
      emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "start" } });
      emitAgentEvent({ runId, stream: "assistant", data: { text: "x" } });
      emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "end" } });
    }
    // ~1000 recent finished runs kept (MAX_TERMINAL_LIFECYCLE_RUNS), not 3000.
    expect(getAgentEventSeqRunCountForTest() - before).toBeLessThanOrEqual(1001);
  });
});
