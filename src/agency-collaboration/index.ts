export {
  buildAgencyJoinUrl,
  createTailscaleCollaborationService,
  isGatewayServed,
  readMagicDnsName,
} from "./tailscale-service.js";
export type { TailscaleCollaborationService } from "./tailscale-service.js";
export type {
  AgencyJoinUrlOptions,
  TailscaleCollaborationDependencies,
  TailscaleCollaborationState,
  TailscaleCollaborationStatus,
  TailscaleStatusPayload,
} from "./types.js";
