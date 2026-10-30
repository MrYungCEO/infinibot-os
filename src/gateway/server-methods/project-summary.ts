/**
 * Gateway RPCs for the project-page "AI Current-State Summary" + voice/text
 * revision feature.
 *
 *   - project-summary.get      (read)  → stored summary + revision log
 *   - project-summary.generate (write) → regenerate on-demand via the PM agent
 *   - project-summary.revise   (write) → fold a typed/voice dump into the state
 *
 * All heavy lifting lives in `src/project-summary/*`; these handlers are thin
 * validation + response wrappers. Methods are classified in the READ/WRITE
 * scope sets in ../server-methods.ts (default scope is admin-only).
 */
import type { GatewayRequestHandlers } from "./types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("project-summary");

/** A summary older than this is considered stale even if the data is unchanged. */
const STALE_AGE_MS = 24 * 60 * 60 * 1000;

export const projectSummaryHandlers: GatewayRequestHandlers = {
  "project-summary.get": async ({ params, respond }) => {
    try {
      const projectId = typeof params.projectId === "string" ? params.projectId.trim() : "";
      if (!projectId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "projectId required" });
        return;
      }
      const { getProjectSummary } = await import("../../project-summary/store.js");
      const { computeProjectInputHash } = await import("../../project-summary/generate.js");
      const record = await getProjectSummary(projectId);

      // Cheap staleness check — never calls the LLM. Stale when: no summary yet,
      // the input signature changed since generation, the stored record predates
      // the hash field (legacy), or the summary is older than STALE_AGE_MS.
      let currentHash: string | null = null;
      try {
        currentHash = computeProjectInputHash(projectId);
      } catch (e) {
        log.warn(`could not compute input hash for ${projectId}: ${String(e)}`);
      }
      const ageMs = record ? Date.now() - (record.generatedAt ?? 0) : Infinity;
      const stale =
        !record ||
        !record.inputHash ||
        (currentHash != null && record.inputHash !== currentHash) ||
        ageMs > STALE_AGE_MS;

      respond(true, { projectId, summary: record, stale, currentHash });
    } catch (e) {
      log.error(`project-summary.get failed: ${String(e)}`);
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "project-summary.generate": async ({ params, respond }) => {
    try {
      const projectId = typeof params.projectId === "string" ? params.projectId.trim() : "";
      if (!projectId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "projectId required" });
        return;
      }
      const { generateProjectSummary } = await import("../../project-summary/generate.js");
      const record = await generateProjectSummary(projectId, "manual");
      respond(true, { projectId, summary: record });
    } catch (e) {
      log.error(`project-summary.generate failed: ${String(e)}`);
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "project-summary.revise": async ({ params, respond }) => {
    try {
      const projectId = typeof params.projectId === "string" ? params.projectId.trim() : "";
      const text = typeof params.text === "string" ? params.text : "";
      const source = params.source === "voice" ? "voice" : "text";
      if (!projectId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "projectId required" });
        return;
      }
      if (!text.trim()) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "text required" });
        return;
      }
      const { reviseProjectSummary } = await import("../../project-summary/generate.js");
      const record = await reviseProjectSummary(projectId, text, source);
      respond(true, { projectId, summary: record });
    } catch (e) {
      log.error(`project-summary.revise failed: ${String(e)}`);
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
};
