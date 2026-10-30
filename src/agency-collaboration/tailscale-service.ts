import {
  enableTailscaleServe,
  findTailscaleBinary,
  getTailscaleBinary,
  readTailscaleStatusJson,
} from "../infra/tailscale.js";
import { runExec } from "../process/exec.js";
import { isFleetTenantMachine } from "../saas/fleet-plugins.js";
import type {
  AgencyJoinUrlOptions,
  TailscaleCollaborationDependencies,
  TailscaleCollaborationStatus,
  TailscaleStatusPayload,
} from "./types.js";

const DEFAULT_JOIN_PATH = "/agency/join";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertGatewayPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Gateway port must be an integer between 1 and 65535");
  }
}

function readBackendState(status: TailscaleStatusPayload): string {
  const value = status.BackendState;
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function readMagicDnsName(status: TailscaleStatusPayload): string | undefined {
  const self = asRecord(status.Self);
  const value = self?.DNSName;
  if (typeof value !== "string") return undefined;
  const hostname = value.trim().replace(/\.$/, "").toLowerCase();
  return hostname || undefined;
}

function valueContainsGatewayProxy(value: unknown, port: number): boolean {
  if (typeof value === "string") {
    try {
      const target = new URL(value);
      const targetPort =
        target.port ||
        (target.protocol === "https:" ? "443" : target.protocol === "http:" ? "80" : "");
      return (
        (target.protocol === "http:" || target.protocol === "https:") &&
        targetPort === String(port) &&
        ["127.0.0.1", "localhost", "::1"].includes(target.hostname)
      );
    } catch {
      return false;
    }
  }
  if (Array.isArray(value)) {
    return value.some((entry) => valueContainsGatewayProxy(entry, port));
  }
  const record = asRecord(value);
  return record
    ? Object.values(record).some((entry) => valueContainsGatewayProxy(entry, port))
    : false;
}

export function isGatewayServed(status: TailscaleStatusPayload, port: number): boolean {
  assertGatewayPort(port);
  return valueContainsGatewayProxy(status, port);
}

async function readDefaultServeStatus(): Promise<TailscaleStatusPayload> {
  const binary = await getTailscaleBinary();
  const { stdout } = await runExec(binary, ["serve", "status", "--json"], {
    timeoutMs: 5_000,
    maxBuffer: 400_000,
  });
  if (!stdout.trim()) return {};
  return JSON.parse(stdout) as TailscaleStatusPayload;
}

async function findDefaultBinary(): Promise<string | null> {
  // InfiniBot Cloud workspace Machines have no Tailscale; don't probe for it.
  if (isFleetTenantMachine()) return null;
  const detected = await findTailscaleBinary();
  if (detected) return detected;
  try {
    await runExec("tailscale", ["--version"], { timeoutMs: 3_000 });
    return "tailscale";
  } catch {
    return null;
  }
}

const defaultDependencies: TailscaleCollaborationDependencies = {
  findBinary: findDefaultBinary,
  readStatus: () => readTailscaleStatusJson(),
  readServeStatus: readDefaultServeStatus,
  enableServe: enableTailscaleServe,
};

export function buildAgencyJoinUrl(options: AgencyJoinUrlOptions): string {
  const token = options.invitationToken.trim();
  if (!token) throw new Error("Invitation token is required");
  if (token.length > 4_096) throw new Error("Invitation token is too long");

  const url = new URL(options.baseUrl);
  if (url.protocol !== "https:") {
    throw new Error("Collaboration links require HTTPS");
  }
  if (url.username || url.password) {
    throw new Error("Collaboration URL must not contain credentials");
  }
  url.pathname = options.path ?? DEFAULT_JOIN_PATH;
  url.search = "";
  url.hash = "";
  url.searchParams.set("token", token);
  return url.toString();
}

export function createTailscaleCollaborationService(
  overrides: Partial<TailscaleCollaborationDependencies> = {},
) {
  const dependencies = { ...defaultDependencies, ...overrides };

  async function getStatus(gatewayPort: number): Promise<TailscaleCollaborationStatus> {
    assertGatewayPort(gatewayPort);
    const binary = await dependencies.findBinary();
    if (!binary) {
      return {
        state: "unavailable",
        installed: false,
        running: false,
        serveEnabled: false,
        gatewayPort,
        message: "Tailscale is not installed. Install and sign in to Tailscale to collaborate.",
      };
    }

    let status: TailscaleStatusPayload;
    try {
      status = await dependencies.readStatus();
    } catch (error) {
      return {
        state: "not_running",
        installed: true,
        running: false,
        serveEnabled: false,
        gatewayPort,
        message: "Tailscale is installed but is not running or signed in.",
        error: errorMessage(error),
      };
    }

    if (readBackendState(status) !== "running") {
      return {
        state: "not_running",
        installed: true,
        running: false,
        serveEnabled: false,
        gatewayPort,
        message: "Tailscale is installed but is not running or signed in.",
      };
    }

    const magicDnsName = readMagicDnsName(status);
    if (!magicDnsName) {
      return {
        state: "error",
        installed: true,
        running: true,
        serveEnabled: false,
        gatewayPort,
        message: "Tailscale is running, but this device has no MagicDNS hostname.",
      };
    }

    const collaborationUrl = `https://${magicDnsName}`;
    let serveEnabled = false;
    try {
      serveEnabled = isGatewayServed(await dependencies.readServeStatus(), gatewayPort);
    } catch {
      // An empty or unavailable Serve configuration is equivalent to not configured.
    }

    return {
      state: serveEnabled ? "ready" : "not_configured",
      installed: true,
      running: true,
      serveEnabled,
      gatewayPort,
      magicDnsName,
      collaborationUrl,
      message: serveEnabled
        ? "Private Tailscale collaboration is ready."
        : "Tailscale Serve is not configured for this gateway.",
    };
  }

  async function enable(gatewayPort: number): Promise<TailscaleCollaborationStatus> {
    const before = await getStatus(gatewayPort);
    if (
      before.state === "unavailable" ||
      before.state === "not_running" ||
      before.state === "error"
    ) {
      return before;
    }
    if (before.state === "ready") return before;

    try {
      await dependencies.enableServe(gatewayPort);
    } catch (error) {
      return {
        ...before,
        state: "error",
        serveEnabled: false,
        message: "Failed to enable private Tailscale Serve collaboration.",
        error: errorMessage(error),
      };
    }

    const after = await getStatus(gatewayPort);
    if (after.state === "not_configured") {
      return {
        ...after,
        state: "error",
        message: "Tailscale Serve completed, but the gateway proxy could not be verified.",
      };
    }
    return after;
  }

  return {
    getStatus,
    enable,
    buildJoinUrl: buildAgencyJoinUrl,
  };
}

export type TailscaleCollaborationService = ReturnType<typeof createTailscaleCollaborationService>;
