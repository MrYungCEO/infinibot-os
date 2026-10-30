import type { WebSocket } from "ws";

import type { ConnectParams } from "../protocol/index.js";

export type GatewayWsClient = {
  socket: WebSocket;
  connect: ConnectParams;
  connId: string;
  presenceKey?: string;
  authMethod?:
    | "token"
    | "password"
    | "tailscale"
    | "device-token"
    | "invite-token"
    | "clerk"
    | "user-session";
  /**
   * Multi-user workspaces (auth.multiUser.enabled): set when this connection
   * signed in as a non-owner workspace user. Every RPC from it goes through
   * the central access check (src/access/authz.ts); absent = owner/agent.
   */
  access?: import("../../access/runtime.js").ClientAccess;
  authUser?: string;
  /** SaaS mode: the tenant this connection was authenticated into (Clerk). */
  saasTenantId?: string;
  /** SaaS mode: the tenant's state namespace (maps to resolveStateDir). */
  saasNamespace?: string;
  /** SaaS mode: the authenticated user's email. */
  saasEmail?: string;
  /** SaaS mode: the tenant's plan tier (free/starter/ceo/vip). */
  saasPlan?: string;
  /** SaaS mode: the authenticated user's role in the tenant (owner/member…). */
  saasRole?: string;
};
