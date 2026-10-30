/**
 * license-telemetry — append-only upgrade-funnel logger (renderer side).
 *
 * One record == one event in the upgrade funnel, from first chip impression
 * through replay success. Two sinks, chosen at runtime:
 *   • Electron: forwarded to the main process over the `license:telemetry:append`
 *     IPC, which writes ~/.infinibot/license-telemetry.jsonl (rotated at 5 MB).
 *   • Web: stashed in `localStorage["infinibot.license.telemetry"]` (capped at
 *     200 entries) and best-effort flushed to the gateway via the
 *     `license.telemetry.flush` RPC (which appends to the same JSONL).
 *
 * Never throws — telemetry must not break an upgrade flow.
 */

import { type Plan, getLicenseState, __setReplayTelemetrySink } from "./license";

export type TelemetryAction =
  | "viewed_chip"
  | "clicked_chip"
  | "opened_modal"
  | "clicked_upgrade"
  | "completed_upgrade"
  | "replay_succeeded"
  | "maybe_later";

export interface TelemetryRecord {
  at: number;
  plan: Plan | string;
  feature: string;
  action: TelemetryAction;
}

const LS_KEY = "infinibot.license.telemetry";
const LS_CAP = 200;

interface ElectronTelemetryBridge {
  telemetryAppend?: (record: TelemetryRecord) => unknown;
}

function electronTelemetry(): ElectronTelemetryBridge | null {
  const b = (window as unknown as { license?: ElectronTelemetryBridge }).license;
  return b && typeof b.telemetryAppend === "function" ? b : null;
}

interface RpcClient {
  call?<T = unknown>(method: string, params?: unknown): Promise<T>;
  request?<T = unknown>(method: string, params?: unknown): Promise<T>;
}

function gatewayClient(): RpcClient | null {
  const c = (window as unknown as { __infinibotGatewayClient?: RpcClient })
    .__infinibotGatewayClient;
  return c && typeof c === "object" ? c : null;
}

function rpcInvoke(client: RpcClient, method: string, params?: unknown): Promise<unknown> {
  if (typeof client.call === "function") return client.call(method, params);
  if (typeof client.request === "function") return client.request(method, params);
  return Promise.reject(new Error("no rpc method"));
}

function readLocal(): TelemetryRecord[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? (arr as TelemetryRecord[]) : [];
  } catch {
    return [];
  }
}

function writeLocal(records: TelemetryRecord[]): void {
  try {
    // Cap at the most-recent LS_CAP entries.
    const capped = records.slice(-LS_CAP);
    localStorage.setItem(LS_KEY, JSON.stringify(capped));
  } catch {
    /* storage unavailable / quota — ignore */
  }
}

/**
 * Best-effort flush of the localStorage buffer to the gateway. Clears the
 * buffer only when the RPC reports success. Safe to call repeatedly.
 */
export async function flushTelemetry(): Promise<void> {
  const client = gatewayClient();
  if (!client) return;
  const pending = readLocal();
  if (!pending.length) return;
  try {
    await rpcInvoke(client, "license.telemetry.flush", { records: pending });
    writeLocal([]); // delivered — clear buffer
  } catch {
    /* gateway unreachable / method not served yet — keep buffer for later */
  }
}

/** Append a single funnel event. */
export function logTelemetry(rec: {
  at?: number;
  plan?: Plan | string;
  feature: string;
  action: TelemetryAction;
}): void {
  const record: TelemetryRecord = {
    at: typeof rec.at === "number" ? rec.at : Date.now(),
    plan: rec.plan ?? getLicenseState().plan,
    feature: rec.feature,
    action: rec.action,
  };

  const eb = electronTelemetry();
  if (eb) {
    try {
      eb.telemetryAppend!(record);
      return;
    } catch {
      /* fall through to web buffer */
    }
  }

  const buf = readLocal();
  buf.push(record);
  writeLocal(buf);
  // Opportunistic flush (non-blocking).
  void flushTelemetry();
}

// Bridge replay-success telemetry emitted from license.ts back through here so
// the queue module stays free of a telemetry import cycle.
__setReplayTelemetrySink((feature, action, plan) => {
  logTelemetry({ feature, action: action as TelemetryAction, plan });
});
