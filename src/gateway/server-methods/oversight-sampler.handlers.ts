/**
 * Gateway RPC handlers for the oversight sampler (the scheduled second-look
 * overseer). See src/agents/oversight-sampler/index.ts.
 *
 * oversight_sampler_run       — run one sampler pass now, return findings
 * oversight_sampler_findings  — read the latest persisted findings (no re-run)
 *
 * Registered via coreGatewayHandlers; requires a gateway restart to serve.
 */

import { createSubsystemLogger } from "../../logging/subsystem.js";
import { runOversightSample, getSamplerFindings } from "../../agents/oversight-sampler/index.js";
import type { GatewayRequestHandlers } from "./types.js";

const log = createSubsystemLogger("gateway/oversight-sampler");

export const oversightSamplerHandlers: GatewayRequestHandlers = {
  /**
   * Run a sampler pass on demand.
   * params: { limit?: number, sinceDays?: number }
   */
  oversight_sampler_run: ({ params, respond }) => {
    try {
      const limit =
        typeof params?.limit === "number" && params.limit > 0 ? params.limit : undefined;
      const sinceDays =
        typeof params?.sinceDays === "number" && params.sinceDays > 0
          ? params.sinceDays
          : undefined;
      const result = runOversightSample({ limit, sinceDays });
      respond(true, { ok: true, ...result }, undefined);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn("oversight_sampler_run failed", { err: message });
      respond(true, { ok: false, error: message }, undefined);
    }
  },

  /**
   * Read the latest persisted sampler findings.
   * params: { limit?: number }
   */
  oversight_sampler_findings: ({ params, respond }) => {
    const limit =
      typeof params?.limit === "number" && params.limit > 0 ? Math.floor(params.limit) : 50;
    const { lastRunAt, findings } = getSamplerFindings(limit);
    respond(true, { ok: true, lastRunAt, findings, serverTime: Date.now() }, undefined);
  },
};
