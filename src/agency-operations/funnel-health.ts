import type { AgencyFunnelConnection, FunnelHealthStatus } from "./funnel-types.js";

export interface ConnectionProbeResult {
  status: FunnelHealthStatus;
  message: string;
  latencyMs: number | null;
  details: Record<string, unknown>;
}

export interface ConnectionHealthProbe {
  readonly name: string;
  supports(connection: AgencyFunnelConnection): boolean;
  probe(connection: AgencyFunnelConnection, signal: AbortSignal): Promise<ConnectionProbeResult>;
}

type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<{ ok: boolean; status: number }>;

export class HttpEndpointProbe implements ConnectionHealthProbe {
  readonly name = "http_endpoint";

  constructor(private readonly fetchImpl: FetchLike = fetch) {}

  supports(connection: AgencyFunnelConnection): boolean {
    return typeof this.endpoint(connection) === "string";
  }

  async probe(
    connection: AgencyFunnelConnection,
    signal: AbortSignal,
  ): Promise<ConnectionProbeResult> {
    const endpoint = this.endpoint(connection);
    if (!endpoint) throw new Error("HTTP health endpoint not configured");
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      return this.failure("Health endpoint is not a valid URL", "invalid_url");
    }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
      return this.failure(
        "Health endpoint must be HTTP(S) without embedded credentials",
        "unsafe_url",
      );
    }
    const startedAt = Date.now();
    try {
      // Deliberately do not forward connection config, tokens, headers, query
      // values, or response bodies into telemetry.
      const response = await this.fetchImpl(url, {
        method: "GET",
        redirect: "error",
        signal,
        headers: { accept: "application/json, text/plain;q=0.5" },
      });
      const latencyMs = Date.now() - startedAt;
      return {
        status: response.ok ? "healthy" : response.status < 500 ? "degraded" : "unhealthy",
        message: response.ok
          ? `${connection.provider} endpoint is reachable`
          : `${connection.provider} endpoint returned HTTP ${response.status}`,
        latencyMs,
        details: {
          source: this.name,
          endpointOrigin: url.origin,
          statusCode: response.status,
        },
      };
    } catch {
      const timedOut = signal.aborted;
      return {
        status: "unhealthy",
        message: timedOut
          ? `${connection.provider} health check timed out`
          : `${connection.provider} endpoint is unreachable`,
        latencyMs: Date.now() - startedAt,
        details: {
          source: this.name,
          endpointOrigin: url.origin,
          errorKind: timedOut ? "timeout" : "network_error",
          // No raw exception text: networking libraries may include full URLs.
        },
      };
    }
  }

  private endpoint(connection: AgencyFunnelConnection): string | null {
    const direct = connection.config.healthUrl ?? connection.config.healthEndpoint;
    return typeof direct === "string" && direct.trim() ? direct.trim() : null;
  }

  private failure(message: string, errorKind: string): ConnectionProbeResult {
    return {
      status: "unhealthy",
      message,
      latencyMs: null,
      details: { source: this.name, errorKind },
    };
  }
}

export class DeclaredStateProbe implements ConnectionHealthProbe {
  readonly name = "declared_state";

  supports(): boolean {
    return true;
  }

  async probe(connection: AgencyFunnelConnection): Promise<ConnectionProbeResult> {
    const status: FunnelHealthStatus =
      connection.status === "connected"
        ? "healthy"
        : connection.status === "degraded"
          ? "degraded"
          : connection.status === "configuring"
            ? "unknown"
            : "unhealthy";
    return {
      status,
      message:
        status === "healthy"
          ? `${connection.provider} is manually declared connected`
          : `${connection.provider} is ${connection.status}`,
      latencyMs: null,
      details: { source: this.name, declaredStatus: connection.status },
    };
  }
}

export class AgencyFunnelHealthService {
  private readonly probes: ConnectionHealthProbe[];

  constructor(options?: {
    probes?: ConnectionHealthProbe[];
    fetchImpl?: FetchLike;
    timeoutMs?: number;
  }) {
    this.probes = options?.probes ?? [
      new HttpEndpointProbe(options?.fetchImpl),
      new DeclaredStateProbe(),
    ];
    this.timeoutMs = Math.min(Math.max(options?.timeoutMs ?? 5000, 250), 10_000);
  }

  private readonly timeoutMs: number;

  async check(connection: AgencyFunnelConnection): Promise<ConnectionProbeResult> {
    const probe = this.probes.find((candidate) => candidate.supports(connection));
    if (!probe) throw new Error("no connection health probe available");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const result = await probe.probe(connection, controller.signal);
      return {
        ...result,
        details: {
          ...result.details,
          probe: probe.name,
          checkedAt: Date.now(),
        },
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
