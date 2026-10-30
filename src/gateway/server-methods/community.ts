/**
 * Community Gateway Methods
 * 
 * Re-exports community Discord handlers for gateway integration.
 */

import { communityDiscordHandlers } from "../../community/gateway-handlers.js";

export { communityDiscordHandlers };
export const communityHandlers = communityDiscordHandlers;
