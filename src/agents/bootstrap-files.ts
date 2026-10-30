import type { InfinibotConfig } from "../config/config.js";
import { applyBootstrapHookOverrides } from "./bootstrap-hooks.js";
import {
  filterBootstrapFilesForSession,
  loadWorkspaceBootstrapFiles,
  type WorkspaceBootstrapFile,
} from "./workspace.js";
import { buildBootstrapContextFiles, resolveBootstrapMaxChars } from "./pi-embedded-helpers.js";
import type { EmbeddedContextFile } from "./pi-embedded-helpers.js";

/**
 * Voice-scoped bootstrap cap (chars). A voice turn runs the full agent
 * session but must keep its injected system prompt tiny so the total prompt
 * stays well under the model context window — a "list projects" turn was
 * blowing past 127k tokens and hard-failing with "prompt too long". We cap
 * (or effectively skip) the workspace bootstrap files (TOOLS.md etc.) for
 * voice sessions only. Non-voice (grid/doc/CLI) paths keep the normal
 * bootstrapMaxChars. See src/gateway/server-voice-stream.ts.
 */
const VOICE_BOOTSTRAP_MAX_CHARS = 1_500;

/**
 * Voice session keys look like `agent:main:voice`, `agent:<id>:voice`, or
 * (legacy) `agent:voice:*`. Match those so the trim is scoped to voice only.
 */
export function isVoiceSessionKey(sessionKey: string | undefined): boolean {
  if (!sessionKey) return false;
  return /^agent:[^:]+:voice(?::|$)/.test(sessionKey) || /^agent:voice(?::|$)/.test(sessionKey);
}

export function makeBootstrapWarn(params: {
  sessionLabel: string;
  warn?: (message: string) => void;
}): ((message: string) => void) | undefined {
  if (!params.warn) return undefined;
  return (message: string) => params.warn?.(`${message} (sessionKey=${params.sessionLabel})`);
}

export async function resolveBootstrapFilesForRun(params: {
  workspaceDir: string;
  config?: InfinibotConfig;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
}): Promise<WorkspaceBootstrapFile[]> {
  const sessionKey = params.sessionKey ?? params.sessionId;
  const bootstrapFiles = filterBootstrapFilesForSession(
    await loadWorkspaceBootstrapFiles(params.workspaceDir),
    sessionKey,
  );
  return applyBootstrapHookOverrides({
    files: bootstrapFiles,
    workspaceDir: params.workspaceDir,
    config: params.config,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    agentId: params.agentId,
  });
}

export async function resolveBootstrapContextForRun(params: {
  workspaceDir: string;
  config?: InfinibotConfig;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
  warn?: (message: string) => void;
}): Promise<{
  bootstrapFiles: WorkspaceBootstrapFile[];
  contextFiles: EmbeddedContextFile[];
}> {
  const bootstrapFiles = await resolveBootstrapFilesForRun(params);
  // Voice turns run the full agent but must stay small — cap the injected
  // bootstrap hard for voice sessions so the TOOLS.md workspace bootstrap
  // (and friends) can't push the prompt over the model context window.
  const voiceScoped = isVoiceSessionKey(params.sessionKey ?? params.sessionId);
  const maxChars = voiceScoped
    ? Math.min(VOICE_BOOTSTRAP_MAX_CHARS, resolveBootstrapMaxChars(params.config))
    : resolveBootstrapMaxChars(params.config);
  const contextFiles = buildBootstrapContextFiles(bootstrapFiles, {
    maxChars,
    warn: params.warn,
  });
  return { bootstrapFiles, contextFiles };
}
