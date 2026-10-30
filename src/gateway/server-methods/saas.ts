// Open-source build stub: the real module is part of the hosted product (see docs/licensing/PRIVATE-SPLIT.md).
import type { GatewayRequestHandlers } from "./types.js";

export const saasHandlers: GatewayRequestHandlers = {
  // Still advertised to the UI by the core method list; same answer as off the fleet.
  "fleet.activity": async ({ respond }) => {
    respond(true, { idleSleep: false });
  },
};
