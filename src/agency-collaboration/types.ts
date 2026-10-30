export type TailscaleCollaborationState =
  | "unavailable"
  | "not_running"
  | "not_configured"
  | "ready"
  | "error";

export type TailscaleCollaborationStatus = {
  state: TailscaleCollaborationState;
  installed: boolean;
  running: boolean;
  serveEnabled: boolean;
  gatewayPort: number;
  magicDnsName?: string;
  collaborationUrl?: string;
  message: string;
  error?: string;
};

export type TailscaleStatusPayload = Record<string, unknown>;

export type TailscaleCollaborationDependencies = {
  findBinary: () => Promise<string | null>;
  readStatus: () => Promise<TailscaleStatusPayload>;
  readServeStatus: () => Promise<TailscaleStatusPayload>;
  enableServe: (port: number) => Promise<void>;
};

export type AgencyJoinUrlOptions = {
  baseUrl: string;
  invitationToken: string;
  path?: string;
};
