/**
 * Auto-Update Gateway Methods
 *
 * Provides gateway API for controlling the auto-update server.
 */

import {
  getAutoUpdateServer,
  type AutoUpdateCheckResult,
  type AutoUpdateConfig,
} from "../../infra/auto-update.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

export const autoUpdateHandlers: GatewayRequestHandlers = {
  /**
   * Get current auto-update status
   */
  "update.auto.status": async ({ respond }) => {
    const server = getAutoUpdateServer();
    if (!server) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "auto-update server not initialized"),
      );
      return;
    }

    const state = server.getState();
    respond(true, { status: state }, undefined);
  },

  /**
   * Enable auto-update
   */
  "update.auto.enable": async ({ respond }) => {
    const server = getAutoUpdateServer();
    if (!server) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "auto-update server not initialized"),
      );
      return;
    }

    await server.enable();
    const state = server.getState();
    respond(true, { ok: true, status: state }, undefined);
  },

  /**
   * Disable auto-update
   */
  "update.auto.disable": async ({ respond }) => {
    const server = getAutoUpdateServer();
    if (!server) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "auto-update server not initialized"),
      );
      return;
    }

    await server.disable();
    const state = server.getState();
    respond(true, { ok: true, status: state }, undefined);
  },

  /**
   * Update auto-update configuration
   */
  "update.auto.config": async ({ params, respond }) => {
    const server = getAutoUpdateServer();
    if (!server) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "auto-update server not initialized"),
      );
      return;
    }

    const config = params as Partial<AutoUpdateConfig>;

    // Validate config
    if (config.intervalMinutes !== undefined) {
      if (typeof config.intervalMinutes !== "number" || config.intervalMinutes < 15) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "intervalMinutes must be at least 15"),
        );
        return;
      }
    }

    if (config.applyDelaySeconds !== undefined) {
      if (typeof config.applyDelaySeconds !== "number" || config.applyDelaySeconds < 0) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "applyDelaySeconds must be non-negative"),
        );
        return;
      }
    }

    server.updateConfig(config);
    const state = server.getState();
    respond(true, { ok: true, status: state }, undefined);
  },

  /**
   * Manually trigger an update check
   */
  "update.check": async ({ respond }) => {
    const server = getAutoUpdateServer();
    if (!server) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "auto-update server not initialized"),
      );
      return;
    }

    const result = await server.triggerCheck();
    respond(true, { result }, undefined);
  },

  /**
   * Manually trigger an update apply (if update available)
   */
  "update.auto.apply": async ({ params, respond }) => {
    const server = getAutoUpdateServer();
    if (!server) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "auto-update server not initialized"),
      );
      return;
    }

    const sessionKey =
      typeof (params as { sessionKey?: unknown }).sessionKey === "string"
        ? (params as { sessionKey?: string }).sessionKey?.trim() || undefined
        : undefined;
    const note =
      typeof (params as { note?: unknown }).note === "string"
        ? (params as { note?: string }).note?.trim() || undefined
        : undefined;
    const restartDelayMsRaw = (params as { restartDelayMs?: unknown }).restartDelayMs;
    const restartDelayMs =
      typeof restartDelayMsRaw === "number" && Number.isFinite(restartDelayMsRaw)
        ? Math.max(0, Math.floor(restartDelayMsRaw))
        : undefined;

    const result = await server.triggerUpdate({
      sessionKey,
      note,
      restartDelayMs,
    });

    respond(true, { result }, undefined);
  },

  /**
   * Check for update and apply if available (combined operation)
   */
  "update.auto.checkAndApply": async ({ params, respond }) => {
    const server = getAutoUpdateServer();
    if (!server) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "auto-update server not initialized"),
      );
      return;
    }

    // First check for updates
    const checkResult = await server.triggerCheck();

    if (!checkResult.hasUpdate) {
      respond(
        true,
        {
          checkResult,
          applyResult: null,
          message: "no update available",
        },
        undefined,
      );
      return;
    }

    // Apply the update
    const sessionKey =
      typeof (params as { sessionKey?: unknown }).sessionKey === "string"
        ? (params as { sessionKey?: string }).sessionKey?.trim() || undefined
        : undefined;
    const note =
      typeof (params as { note?: unknown }).note === "string"
        ? (params as { note?: string }).note?.trim() || undefined
        : undefined;
    const restartDelayMsRaw = (params as { restartDelayMs?: unknown }).restartDelayMs;
    const restartDelayMs =
      typeof restartDelayMsRaw === "number" && Number.isFinite(restartDelayMsRaw)
        ? Math.max(0, Math.floor(restartDelayMsRaw))
        : undefined;

    const applyResult = await server.triggerUpdate({
      sessionKey,
      note,
      restartDelayMs,
    });

    respond(
      true,
      {
        checkResult,
        applyResult,
        message: applyResult.applied
          ? "update applied, restarting..."
          : (applyResult.error ?? "update failed"),
      },
      undefined,
    );
  },
};
