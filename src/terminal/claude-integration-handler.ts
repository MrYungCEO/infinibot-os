import * as OutputParser from "./output-parser.js";
import * as SessionHandler from "./session-handler.js";
import { debugLog } from "./utils/debug-logger.js";
import type { TerminalProcess, RateLimitEvent, OnboardingCompleteEvent } from "./types.js";

export type BroadcastFn = (event: string, payload: any) => void;

/**
 * Handle Claude session ID detection
 */
export function handleClaudeSessionId(
  terminal: TerminalProcess,
  sessionId: string,
  broadcast: BroadcastFn,
): void {
  if (terminal.claudeSessionId === sessionId) {
    return;
  }

  terminal.claudeSessionId = sessionId;
  terminal.isClaudeMode = true;

  // Persist session if project path is available
  if (terminal.projectPath) {
    void SessionHandler.persistSessionAsync(terminal);
  }

  // Broadcast session ID update
  broadcast("terminal.claudeSessionId", {
    terminalId: terminal.id,
    sessionId,
  });
}

/**
 * Handle rate limit detection
 */
export function handleRateLimit(
  terminal: TerminalProcess,
  data: string,
  lastNotifiedRateLimitReset: Map<string, string>,
  broadcast: BroadcastFn,
): void {
  const resetTime = OutputParser.extractRateLimitReset(data);
  if (!resetTime) {
    return;
  }

  const lastNotifiedReset = lastNotifiedRateLimitReset.get(terminal.id);
  if (resetTime === lastNotifiedReset) {
    return;
  }

  lastNotifiedRateLimitReset.set(terminal.id, resetTime);
  debugLog("[ClaudeIntegration] Rate limit detected, reset:", resetTime);

  broadcast("terminal.rateLimit", {
    terminalId: terminal.id,
    resetTime,
    detectedAt: new Date().toISOString(),
  } as RateLimitEvent);
}

/**
 * Handle OAuth token detection
 */
export function handleOAuthToken(
  terminal: TerminalProcess,
  data: string,
  broadcast: BroadcastFn,
): void {
  const token = OutputParser.extractOAuthToken(data);
  const authUrl = OutputParser.extractOAuthUrl(data);
  const hasLoginSuccess = OutputParser.hasLoginSuccess(data);

  if (token) {
    debugLog("[ClaudeIntegration] OAuth token detected");
    broadcast("terminal.oauthToken", {
      terminalId: terminal.id,
      success: true,
      detectedAt: new Date().toISOString(),
    });
  } else if (authUrl) {
    debugLog("[ClaudeIntegration] OAuth URL detected");
    broadcast("terminal.oauthUrl", {
      terminalId: terminal.id,
      url: authUrl,
      detectedAt: new Date().toISOString(),
    });
  } else if (hasLoginSuccess) {
    debugLog("[ClaudeIntegration] Login success detected");
    broadcast("terminal.loginSuccess", {
      terminalId: terminal.id,
      success: true,
      detectedAt: new Date().toISOString(),
    });
  }
}

/**
 * Handle onboarding complete detection
 */
export function handleOnboardingComplete(
  terminal: TerminalProcess,
  data: string,
  broadcast: BroadcastFn,
): void {
  if (OutputParser.isOnboardingCompleteOutput(data)) {
    debugLog("[ClaudeIntegration] Onboarding complete detected");
    broadcast("terminal.onboardingComplete", {
      terminalId: terminal.id,
      detectedAt: new Date().toISOString(),
    });
  }
}

/**
 * Handle Claude exit
 */
export function handleClaudeExit(terminal: TerminalProcess, broadcast: BroadcastFn): void {
  if (terminal.isClaudeMode) {
    terminal.isClaudeMode = false;

    if (terminal.projectPath) {
      void SessionHandler.persistSessionAsync(terminal);
    }

    broadcast("terminal.claudeExit", {
      terminalId: terminal.id,
    });
  }
}

// Stub for async invocation - will implement fully later
export async function invokeClaudeAsync(
  terminal: TerminalProcess,
  cwd: string | undefined,
  profileId: string | undefined,
  dangerouslySkipPermissions: boolean | undefined,
): Promise<void> {
  // TODO: Implement full Claude invocation logic with profiles
}
