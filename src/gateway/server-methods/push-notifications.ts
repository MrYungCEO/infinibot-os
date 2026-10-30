/**
 * Push Notifications Server Methods
 * Handles device registration and push notification sending.
 *
 * Two device stores coexist for historical reasons:
 *   - push-devices.json (this file): per-device settings (enabled flags,
 *     channel preferences) used by the legacy push.send fanout.
 *   - push_tokens.db (push-token-store.ts): SQLite store consumed by
 *     emitNotification → Expo + the unified history pipeline.
 *
 * Every `device.registerPush` mirrors the token into both so the Alerts
 * page (which reads notifications.history.db, populated by emitNotification)
 * sees the same devices the JSON store knows about. The push.* RPCs below
 * route through emitNotification so their sends also land in history and
 * fire the `notification.created` event the mobile listens on.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { STATE_DIR } from "../../config/paths.js";
import { getPushTokenStore } from "../../notifications/push-token-store.js";
import { emitNotification } from "../../notifications/emit.js";
import type {
  NotificationCategory,
  NotificationSeverity,
} from "../../notifications/history-store.js";
import type { GatewayRequestHandlers } from "./types.js";

interface PushDevice {
  token: string;
  platform: "ios" | "android";
  deviceName: string;
  registeredAt: number;
  lastSeen: number;
  settings: {
    enabled: boolean;
    agentMessages: boolean;
    taskUpdates: boolean;
    systemAlerts: boolean;
    sound: boolean;
    vibration: boolean;
  };
}

interface PushStore {
  devices: Record<string, PushDevice>;
}

const getStorePath = () => {
  // Canonical default = STATE_DIR (~/.infinibot). Earlier this fell back to
  // a bare "state" string, which resolved to <cwd>/state — diverging from
  // STATE_DIR-backed stores and silently splitting the device registry.
  const stateDir = process.env.INFINIBOT_STATE_DIR ?? STATE_DIR;
  return resolve(stateDir, "push-devices.json");
};

// Map the legacy `type` parameter on push.send / sendPushNotification to a
// NotificationCategory the history pipeline understands.
function typeToCategory(type: string | undefined): NotificationCategory {
  switch (type) {
    case "agentMessages":
      return "agent.completed";
    case "taskUpdates":
      return "kanban.task.assigned";
    case "systemAlerts":
      return "system.update.available";
    case "test":
      return "manual";
    default:
      return "manual";
  }
}

// If a legacy push-devices.json exists at <cwd>/state/push-devices.json (the
// pre-fix default), copy it to the canonical STATE_DIR location on first
// load. The mobile re-registers on every boot anyway, but migrating the file
// avoids a window where existing devices aren't recognised.
function migrateLegacyJsonPath(): void {
  try {
    const canonical = getStorePath();
    if (existsSync(canonical)) return;
    const legacy = resolve("state", "push-devices.json");
    if (!existsSync(legacy) || legacy === canonical) return;
    const data = readFileSync(legacy, "utf-8");
    mkdirSync(dirname(canonical), { recursive: true });
    writeFileSync(canonical, data, "utf-8");
  } catch {
    // Best effort.
  }
}

// One-time-per-process migration: copy push tokens from the legacy JSON
// store into push_tokens.db so emitNotification finds them. Runs on module
// load. Idempotent (upsert).
function migrateLegacyDevicesToSqlite(): void {
  try {
    const store = loadStore();
    const devices = Object.values(store.devices);
    if (devices.length === 0) return;
    const tokenStore = getPushTokenStore();
    for (const dev of devices) {
      if (!dev.settings?.enabled) continue;
      tokenStore.upsert(dev.token, dev.platform || "ios", dev.deviceName || "");
    }
  } catch {
    // Migration is best-effort; never fatal.
  }
}

migrateLegacyJsonPath();
migrateLegacyDevicesToSqlite();

function loadStore(): PushStore {
  const path = getStorePath();
  if (existsSync(path)) {
    try {
      return JSON.parse(readFileSync(path, "utf-8"));
    } catch {
      return { devices: {} };
    }
  }
  return { devices: {} };
}

function saveStore(store: PushStore): void {
  const path = getStorePath();
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, JSON.stringify(store, null, 2), "utf-8");
}

async function sendExpoPush(
  token: string,
  title: string,
  body: string,
  data?: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "Accept-Encoding": "gzip, deflate",
      },
      body: JSON.stringify({
        to: token,
        title,
        body,
        data,
        sound: "default",
        priority: "high",
        channelId: "default",
      }),
    });

    const result = await response.json();

    if (result.data?.status === "error") {
      return { ok: false, error: result.data.message };
    }

    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export const pushNotificationHandlers: GatewayRequestHandlers = {
  "device.registerPush": async ({ params, respond }) => {
    try {
      const token = params?.token as string;
      const platform = params?.platform as "ios" | "android";
      const deviceName = params?.deviceName as string;
      const settings = params?.settings as PushDevice["settings"];

      if (!token) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "token required" });
        return;
      }

      const store = loadStore();
      const now = Date.now();

      store.devices[token] = {
        token,
        platform: platform || "ios",
        deviceName: deviceName || "Unknown Device",
        registeredAt: store.devices[token]?.registeredAt || now,
        lastSeen: now,
        settings: settings || {
          enabled: true,
          agentMessages: true,
          taskUpdates: true,
          systemAlerts: true,
          sound: true,
          vibration: true,
        },
      };

      saveStore(store);

      // Mirror into push_tokens.db so emitNotification (the unified history +
      // Expo path) can find this device. Without this, the WS-only RPC leaves
      // the SQLite store stale and history.db never sees the device's pushes.
      try {
        getPushTokenStore().upsert(token, platform || "ios", deviceName || "");
      } catch {
        // Non-fatal: the JSON store still has the token and push.send still works.
      }

      respond(true, { ok: true, deviceCount: Object.keys(store.devices).length });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "device.updatePushSettings": async ({ params, respond }) => {
    try {
      const token = params?.token as string;
      const settings = params?.settings as Partial<PushDevice["settings"]>;

      if (!token) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "token required" });
        return;
      }

      const store = loadStore();

      if (!store.devices[token]) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Device not registered" });
        return;
      }

      store.devices[token].settings = {
        ...store.devices[token].settings,
        ...settings,
      };
      store.devices[token].lastSeen = Date.now();

      saveStore(store);

      respond(true, { ok: true, settings: store.devices[token].settings });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "device.unregisterPush": async ({ params, respond }) => {
    try {
      const token = params?.token as string;

      if (!token) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "token required" });
        return;
      }

      const store = loadStore();
      delete store.devices[token];
      saveStore(store);

      // Also mark the SQLite row invalid so emitNotification stops sending to it.
      try {
        getPushTokenStore().markInvalid(token);
      } catch {
        // Non-fatal.
      }

      respond(true, { ok: true });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "push.send": async ({ params, respond }) => {
    try {
      const title = params?.title as string;
      const body = params?.body as string;
      const data = (params?.data as Record<string, unknown>) ?? {};
      const type = params?.type as string | undefined;
      const severity = (
        typeof params?.severity === "string" ? params.severity : "info"
      ) as NotificationSeverity;

      if (!title || !body) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "title and body required" });
        return;
      }

      // Route through the unified emitter so the send also lands in
      // notifications/history.db and fires the `notification.created` gateway
      // event the mobile Alerts page subscribes to.
      const id = await emitNotification({
        category: typeToCategory(type),
        severity,
        title,
        body,
        source: "push.send",
        data: { ...data, type },
      });

      respond(true, { ok: true, id });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "push.sendToDevice": async ({ params, respond }) => {
    try {
      const token = params?.token as string;
      const title = params?.title as string;
      const body = params?.body as string;
      const data = (params?.data as Record<string, unknown>) ?? {};

      if (!token || !title || !body) {
        respond(false, undefined, {
          code: "INVALID_PARAMS",
          message: "token, title, and body required",
        });
        return;
      }

      // Send the Expo push directly (preserves single-device targeting), but
      // ALSO record an entry in history + broadcast so the Alerts feed
      // reflects the send. Without this, targeted pushes (typically debug/dev
      // tools) never showed up in the backlog.
      const result = await sendExpoPush(token, title, body, data);

      try {
        const id = await emitNotification({
          category: "manual",
          severity: "info",
          title,
          body,
          source: "push.sendToDevice",
          data: { ...data, targetTokenSuffix: token.slice(-10) },
        });
        respond(true, { ...result, id });
        return;
      } catch {
        // History persistence failed — still return the send result.
      }

      respond(true, result);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "push.listDevices": async ({ respond }) => {
    try {
      const store = loadStore();
      const devices = Object.values(store.devices).map((d) => ({
        tokenSuffix: d.token.slice(-10),
        platform: d.platform,
        deviceName: d.deviceName,
        registeredAt: d.registeredAt,
        lastSeen: d.lastSeen,
        enabled: d.settings.enabled,
      }));

      respond(true, { devices, count: devices.length });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "push.test": async ({ params: _params, respond }) => {
    try {
      const id = await emitNotification({
        category: "manual",
        severity: "info",
        title: "🧪 Test Notification",
        body: "Push notifications are working!",
        source: "push.test",
        data: { test: true, ts: Date.now() },
      });

      respond(true, { ok: true, id });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
};

// Helper used by other server-side code paths to push a notification. Routes
// through emitNotification so the send is persisted to history + broadcast as
// a `notification.created` event in addition to fanning out via Expo.
export async function sendPushNotification(
  title: string,
  body: string,
  options?: {
    type?: string;
    data?: Record<string, unknown>;
    severity?: NotificationSeverity;
  },
): Promise<{ sent: number; total: number; id?: string }> {
  try {
    const id = await emitNotification({
      category: typeToCategory(options?.type),
      severity: options?.severity ?? "info",
      title,
      body,
      source: "push.send",
      data: { ...options?.data, type: options?.type },
    });
    // The unified emitter doesn't expose per-token send counts; report the
    // number of valid tokens so existing callers retain a useful shape.
    const tokenCount = (() => {
      try {
        return getPushTokenStore().listValid().length;
      } catch {
        return 0;
      }
    })();
    return { sent: tokenCount, total: tokenCount, id };
  } catch {
    return { sent: 0, total: 0 };
  }
}
