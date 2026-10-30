import type { ModelCatalogEntry } from "../../agents/model-catalog.js";
import type { createDefaultDeps } from "../../cli/deps.js";
import type { HealthSummary } from "../../commands/health.js";
import type { CronService } from "../../cron/service.js";
import type { WizardSession } from "../../wizard/session.js";
import type { ChatAbortControllerEntry } from "../chat-abort.js";
import type { NodeRegistry } from "../node-registry.js";
import type { ConnectParams, ErrorShape, RequestFrame } from "../protocol/index.js";
import type { ChannelRuntimeSnapshot } from "../server-channels.js";
import type { DedupeEntry } from "../server-shared.js";
import type { createSubsystemLogger } from "../../logging/subsystem.js";

type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

export type GatewayClient = {
  connect: ConnectParams;
  /**
   * Verified identity attached by the WebSocket handshake. Tailscale Serve
   * connections carry the login returned by `tailscale whois`; password and
   * token connections leave `authUser` empty and are resolved by their normal
   * credential stores. Keeping this on the connection lets business-domain
   * handlers enforce workspace membership without trusting request params.
   */
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
  /**
   * SaaS mode (Clerk): the tenant this connection was authenticated into and the
   * authenticated email. Handlers use these to scope storage/reads to the
   * tenant's namespace. Absent for non-SaaS (local) connections.
   */
  saasTenantId?: string;
  saasNamespace?: string;
  saasEmail?: string;
  saasPlan?: string;
  /** SaaS mode: the authenticated user's role in the tenant (owner/member…). */
  saasRole?: string;
  /**
   * Per-connection id (unique per WebSocket, regardless of what the client
   * claims its `instanceId` is). Surfaced so handlers can disambiguate
   * duplicate-instanceId scenarios (e.g. duplicated browser tabs share
   * sessionStorage). Stable for the life of the connection.
   */
  connId: string;
};

export type RespondFn = (
  ok: boolean,
  payload?: unknown,
  error?: ErrorShape,
  meta?: Record<string, unknown>,
) => void;

export type GatewayRequestContext = {
  deps: ReturnType<typeof createDefaultDeps>;
  cron: CronService;
  cronStorePath: string;
  loadGatewayModelCatalog: () => Promise<ModelCatalogEntry[]>;
  getHealthCache: () => HealthSummary | null;
  refreshHealthSnapshot: (opts?: { probe?: boolean }) => Promise<HealthSummary>;
  logHealth: { error: (message: string) => void };
  logGateway: SubsystemLogger;
  incrementPresenceVersion: () => number;
  getHealthVersion: () => number;
  broadcast: (
    event: string,
    payload: unknown,
    opts?: {
      dropIfSlow?: boolean;
      stateVersion?: { presence?: number; health?: number };
      connIds?: ReadonlySet<string>;
    },
  ) => void;
  nodeSendToSession: (sessionKey: string, event: string, payload: unknown) => void;
  nodeSendToAllSubscribed: (event: string, payload: unknown) => void;
  nodeSubscribe: (nodeId: string, sessionKey: string) => void;
  nodeUnsubscribe: (nodeId: string, sessionKey: string) => void;
  nodeUnsubscribeAll: (nodeId: string) => void;
  hasConnectedMobileNode: () => boolean;
  nodeRegistry: NodeRegistry;
  agentRunSeq: Map<string, number>;
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
  chatAbortedRuns: Map<string, number>;
  chatRunBuffers: Map<string, string>;
  chatDeltaSentAt: Map<string, number>;
  addChatRun: (sessionId: string, entry: { sessionKey: string; clientRunId: string }) => void;
  removeChatRun: (
    sessionId: string,
    clientRunId: string,
    sessionKey?: string,
  ) => { sessionKey: string; clientRunId: string } | undefined;
  dedupe: Map<string, DedupeEntry>;
  wizardSessions: Map<string, WizardSession>;
  findRunningWizard: () => string | null;
  purgeWizardSession: (id: string) => void;
  getRuntimeSnapshot: () => ChannelRuntimeSnapshot;
  startChannel: (
    channel: import("../../channels/plugins/types.js").ChannelId,
    accountId?: string,
  ) => Promise<void>;
  stopChannel: (
    channel: import("../../channels/plugins/types.js").ChannelId,
    accountId?: string,
  ) => Promise<void>;
  markChannelLoggedOut: (
    channelId: import("../../channels/plugins/types.js").ChannelId,
    cleared: boolean,
    accountId?: string,
  ) => void;
  wizardRunner: (
    opts: import("../../commands/onboard-types.js").OnboardOptions,
    runtime: import("../../runtime.js").RuntimeEnv,
    prompter: import("../../wizard/prompts.js").WizardPrompter,
  ) => Promise<void>;
  broadcastVoiceWakeChanged: (triggers: string[]) => void;
};

export type GatewayRequestOptions = {
  req: RequestFrame;
  client: GatewayClient | null;
  isWebchatConnect: (params: ConnectParams | null | undefined) => boolean;
  respond: RespondFn;
  context: GatewayRequestContext;
};

export type GatewayRequestHandlerOptions = {
  req: RequestFrame;
  params: Record<string, unknown>;
  client: GatewayClient | null;
  isWebchatConnect: (params: ConnectParams | null | undefined) => boolean;
  respond: RespondFn;
  context: GatewayRequestContext;
};

export type GatewayRequestHandler = (opts: GatewayRequestHandlerOptions) => Promise<void> | void;

export type GatewayRequestHandlers = Record<string, GatewayRequestHandler>;
