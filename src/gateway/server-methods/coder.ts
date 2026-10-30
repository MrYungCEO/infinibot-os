/**
 * Coder backend RPC handlers.
 *
 * Mirrors `/api/coder/backends` (HTTP) as `coder.backends.list` (RPC) so
 * UI components like <agent-cli-selector> can fetch the list via the same
 * gateway client they already use for everything else.
 */

import type { GatewayRequestHandlers } from "./types.js";
import { listAllBackends } from "../server-coder-backend.js";
import { getCoderBackendId } from "../../agents/coder-backend/registry.js";
import { describeBinSearch } from "../../agents/coder-backend/bin-detect.js";

/** Map a coder backend id to the CLI binary name it ships. */
const BACKEND_BINS: Record<string, string> = {
  "claude-code": "claude",
  claude: "claude",
  codex: "codex",
  gemini: "gemini",
  opencode: "opencode",
  grok: "grok",
  "grok-build": "grok",
};

export const coderHandlers: GatewayRequestHandlers = {
  "coder.backends.list": async ({ respond }) => {
    try {
      const backends = await listAllBackends();
      respond(true, { backends, active: getCoderBackendId() });
    } catch (err) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: (err as Error).message ?? String(err),
      });
    }
  },

  // Diagnostic for the wizard's "Re-check" button: returns every absolute path
  // the resolver inspected for a CLI plus the winning path, so the UI can show
  // "we looked here, nothing matched" instead of a bare "not detected".
  // Accepts either a backend id (claude-code/codex/gemini/opencode/grok) or a raw
  // binary name via `params.bin`.
  // NOTE: new RPC — requires a gateway restart before it is served.
  "coder.binSearch": async ({ params, respond }) => {
    try {
      const requested = String((params as { bin?: string } | undefined)?.bin ?? "").trim();
      if (!requested) {
        respond(false, undefined, {
          code: "INVALID_PARAMS",
          message: "coder.binSearch requires a `bin` param (backend id or CLI name).",
        });
        return;
      }
      const bin = BACKEND_BINS[requested] ?? requested;
      const { tried, resolved } = describeBinSearch(bin);
      respond(true, { bin, tried, resolved, found: Boolean(resolved) });
    } catch (err) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: (err as Error).message ?? String(err),
      });
    }
  },
};
