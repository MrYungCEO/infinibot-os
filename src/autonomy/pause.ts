/**
 * Autonomy Architecture — Pause Control System
 * Simple file-based pause mechanism for human control
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "fs";
import { dirname } from "path";
import { PauseState } from "./types.js";
import { logAudit } from "./audit.js";

let pauseFilePath = "state/autonomy/PAUSE";

/**
 * Initialize pause system
 */
export function initPause(path?: string): void {
  if (path) {
    pauseFilePath = path;
  }

  // Ensure directory exists
  const dir = dirname(pauseFilePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Check if autonomy is paused
 */
export function isPaused(): boolean {
  return existsSync(pauseFilePath);
}

/**
 * Get pause state details
 */
export function getPauseState(): PauseState {
  if (!existsSync(pauseFilePath)) {
    return { isPaused: false };
  }

  try {
    const content = readFileSync(pauseFilePath, "utf-8").trim();

    if (content) {
      const parsed = JSON.parse(content);
      return {
        isPaused: true,
        pausedAt: parsed.pausedAt,
        pausedBy: parsed.pausedBy || "user",
        reason: parsed.reason,
        resumeAt: parsed.resumeAt,
      };
    }
  } catch {
    // File exists but no JSON content — simple pause
  }

  return {
    isPaused: true,
    pausedBy: "user",
  };
}

/**
 * Activate pause
 */
export function activatePause(
  reason?: string,
  options: {
    pausedBy?: "user" | "system" | "cage_detection";
    resumeAt?: number;
  } = {},
): PauseState {
  const state: PauseState = {
    isPaused: true,
    pausedAt: Date.now(),
    pausedBy: options.pausedBy || "user",
    reason,
    resumeAt: options.resumeAt,
  };

  const dir = dirname(pauseFilePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(pauseFilePath, JSON.stringify(state, null, 2), "utf-8");

  logAudit("pause_activated", `Autonomy paused: ${reason || "No reason given"}`, {
    category: "system",
    details: { ...state },
  });

  return state;
}

/**
 * Deactivate pause
 */
export function deactivatePause(): PauseState {
  if (existsSync(pauseFilePath)) {
    unlinkSync(pauseFilePath);
  }

  logAudit("pause_deactivated", "Autonomy resumed", {
    category: "system",
  });

  return { isPaused: false };
}

/**
 * Check if pause should auto-expire
 */
export function checkPauseExpiry(): boolean {
  const state = getPauseState();

  if (!state.isPaused || !state.resumeAt) {
    return false;
  }

  if (Date.now() >= state.resumeAt) {
    deactivatePause();
    logAudit("pause_deactivated", "Autonomy auto-resumed (scheduled)", {
      category: "system",
    });
    return true;
  }

  return false;
}

/**
 * Create pause file from command line
 * Usage: touch state/autonomy/PAUSE
 */
export function createPauseInstructions(): string {
  return `
To pause Infini's autonomous work:
  Create file: ${pauseFilePath}
  
To pause with details:
  echo {"reason":"doing maintenance"} > ${pauseFilePath}
  
To resume:
  Delete file: ${pauseFilePath}
  
Current status: ${isPaused() ? "PAUSED" : "ACTIVE"}
`.trim();
}

/**
 * Get pause state as a plain object (for JSON serialization)
 */
export function getPauseStateObject(): Record<string, unknown> {
  const state = getPauseState();
  return {
    isPaused: state.isPaused,
    pausedAt: state.pausedAt,
    pausedBy: state.pausedBy,
    reason: state.reason,
    resumeAt: state.resumeAt,
  };
}

// Export convenience object
export const pause = {
  init: initPause,
  isPaused,
  getState: getPauseState,
  activate: activatePause,
  deactivate: deactivatePause,
  checkExpiry: checkPauseExpiry,
  instructions: createPauseInstructions,
};
