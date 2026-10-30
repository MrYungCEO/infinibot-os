/**
 * setup.status (read) — the "needs setup" registry: every core and plugin
 * setup check, evaluated server-side and cached a few seconds per tenant.
 * Pass `{ force: true }` to bypass the cache. Changes are also pushed as a
 * `setup.status` event after write RPCs (server-methods.ts).
 * Design: docs/gateway/setup-status.md.
 */

import { getSetupStatus } from "../setup-status/registry.js";
import { installCoreSetupChecks } from "../setup-status/core-checks.js";
import type { GatewayRequestHandlers } from "./types.js";

export const SETUP_STATUS_READ_METHODS = ["setup.status"] as const;

installCoreSetupChecks();

export const setupStatusHandlers: GatewayRequestHandlers = {
  "setup.status": async ({ params, respond }) => {
    try {
      respond(true, await getSetupStatus({ force: params?.force === true }));
    } catch (err) {
      respond(false, undefined, {
        code: "SETUP_STATUS_FAILED",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  },
};
