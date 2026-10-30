// Open-source build stub: the real module is part of the hosted product (see docs/licensing/PRIVATE-SPLIT.md).
import {
  activateCommercialLicense,
  commercialLicenseStatus,
} from "../../commercial-licensing/local.js";
import type { GatewayRequestHandlers } from "./types.js";

export const licenseHandlers: GatewayRequestHandlers = {
  // Advisory proof of a commercial grant, read from the local state dir. Never gates use.
  "license.commercial.status": async ({ respond }) => {
    try {
      respond(true, commercialLicenseStatus());
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(err) });
    }
  },
  "license.commercial.activate": async ({ params, respond, context }) => {
    try {
      const token = typeof params?.token === "string" ? params.token : "";
      const result = activateCommercialLicense(token);
      if (!result.valid) {
        respond(false, undefined, {
          code: "INVALID_LICENSE",
          message: result.reason ?? "License verification failed",
        });
        return;
      }
      context.broadcast("license.commercial.updated", result);
      respond(true, result);
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(err) });
    }
  },
};
