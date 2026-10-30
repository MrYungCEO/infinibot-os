import fs from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";
import { loadConfig } from "../../config/config.js";
import { secureOnlyBlockReason } from "../../secure-mode/agent-policy.js";
import { assertSecureModelAllowed, SecureModeBlockedError } from "../../secure-mode/policy.js";
import { getSecureModeRuntime, SecureModeLockedError } from "../../secure-mode/runtime.js";
import { resolveSecureRunModel } from "../../secure-mode/local-models.js";
import { isSecureSessionKey } from "../../secure-mode/session-key.js";
import { emitSecureModelNotice } from "../turn-failure.js";
import type { ThinkLevel } from "../../auto-reply/thinking.js";
import { enqueueCommandInLane } from "../../process/command-queue.js";
import { resolveUserPath } from "../../utils.js";
import { isMarkdownCapableMessageChannel } from "../../utils/message-channel.js";
import { resolveInfiniBotAgentDir } from "../agent-paths.js";
import {
  isProfileInCooldown,
  markAuthProfileFailure,
  markAuthProfileGood,
  markAuthProfileUsed,
} from "../auth-profiles.js";
import {
  CONTEXT_WINDOW_HARD_MIN_TOKENS,
  CONTEXT_WINDOW_WARN_BELOW_TOKENS,
  evaluateContextWindowGuard,
  resolveContextWindowInfo,
} from "../context-window-guard.js";
import { DEFAULT_CONTEXT_TOKENS, DEFAULT_MODEL, DEFAULT_PROVIDER } from "../defaults.js";
import { FailoverError, resolveFailoverStatus } from "../failover-error.js";
import {
  ensureAuthProfileStore,
  getApiKeyForModel,
  resolveAuthProfileOrder,
  type ResolvedProviderAuth,
} from "../model-auth.js";
import { isCliProvider, normalizeProviderId } from "../model-selection.js";
import { ensureInfiniBotModelsJson } from "../models-config.js";
import {
  classifyFailoverReason,
  formatAssistantErrorText,
  isAuthAssistantError,
  isCompactionFailureError,
  isContextOverflowError,
  isFailoverAssistantError,
  isFailoverErrorMessage,
  isModelNotFoundErrorMessage,
  parseImageDimensionError,
  isRateLimitAssistantError,
  isTimeoutErrorMessage,
  pickFallbackThinkingLevel,
  type FailoverReason,
} from "../pi-embedded-helpers.js";
import { normalizeUsage, type UsageLike } from "../usage.js";

import { compactEmbeddedPiSessionDirect } from "./compact.js";
import { resolveGlobalLane, resolveSessionLane } from "./lanes.js";
import { log } from "./logger.js";
import { resolveModel } from "./model.js";
import { runEmbeddedAttempt } from "./run/attempt.js";
import type { RunEmbeddedPiAgentParams } from "./run/params.js";
import { buildEmbeddedRunPayloads } from "./run/payloads.js";
import type { EmbeddedPiAgentMeta, EmbeddedPiRunResult } from "./types.js";
import { describeUnknownError } from "./utils.js";
import { withLocalRuntimeForRun } from "../../local-runtimes/run-gate.js";
import { captureCompletion } from "../skills/cumulative/index.js";
import { isLocalModelTurn } from "../local-model-turn.js";
import { resolveTurnTimeoutMs } from "../timeout.js";
import { beginInteractiveTurn } from "../../ocr/interactive-gate.js";
import {
  appendTurnTimeoutNotice,
  broadcastTurnTimeoutNotice,
  buildTurnTimeoutNotice,
  endTimedOutRunLifecycle,
} from "./turn-timeout.js";

type ApiKeyInfo = ResolvedProviderAuth;

// Avoid Anthropic's refusal test token poisoning session transcripts.
const ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL = "ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL";
const ANTHROPIC_MAGIC_STRING_REPLACEMENT = "ANTHROPIC MAGIC STRING TRIGGER REFUSAL (redacted)";

function scrubAnthropicRefusalMagic(prompt: string): string {
  if (!prompt.includes(ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL)) return prompt;
  return prompt.replaceAll(
    ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL,
    ANTHROPIC_MAGIC_STRING_REPLACEMENT,
  );
}

async function runOnCliProvider(params: RunEmbeddedPiAgentParams): Promise<EmbeddedPiRunResult> {
  const { runCliAgent } = await import("../cli-runner.js");
  const onPartialReply = params.onPartialReply;
  return runCliAgent({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    sessionFile: params.sessionFile,
    workspaceDir: params.workspaceDir,
    config: params.config,
    prompt: params.prompt,
    provider: params.provider!,
    model: params.model,
    thinkLevel: params.thinkLevel,
    timeoutMs: params.timeoutMs,
    runId: params.runId,
    extraSystemPrompt: params.extraSystemPrompt,
    ownerNumbers: params.ownerNumbers,
    images: params.images,
    abortSignal: params.abortSignal,
    onPartialReply: onPartialReply ? ({ text }) => onPartialReply({ text }) : undefined,
  });
}

export async function runEmbeddedPiAgent(
  params: RunEmbeddedPiAgentParams,
): Promise<EmbeddedPiRunResult> {
  if (!isSecureSessionKey(params.sessionKey)) {
    // Per-agent policy: an agent marked secureOnly never runs in the normal lane.
    const blocked = secureOnlyBlockReason(params.config ?? loadConfig(), params.sessionKey);
    if (blocked) throw new SecureModeBlockedError(blocked);
    // A subscription CLI model (claude-cli/…, grok-cli/…) handed to a direct
    // caller (voice-call plugin, llm-task, …) runs on the CLI runner; the
    // embedded runner has no such provider.
    if (params.provider && isCliProvider(params.provider, params.config)) {
      return runOnCliProvider(params);
    }
    return withLocalRuntimeForRun(params, () => runEmbeddedPiAgentInner(params));
  }
  // Secure Mode lane: fail closed while the lane is locked, keep the
  // transcript in RAM, and seal it into the encrypted vault after the run.
  const secure = getSecureModeRuntime();
  if (!secure.isUnlocked()) throw new SecureModeLockedError();
  // Local models only. Callers that go through runWithModelFallback already
  // arrive on a local model; direct callers with a remote model are moved to
  // the agent's local model / secureMode.defaultModel here. Never remote: no
  // reachable local model throws SecureModeBlockedError. The resolved model's
  // baseUrl is checked again inside the run.
  const secureModel = await resolveSecureRunModel({
    cfg: params.config ?? loadConfig(),
    sessionKey: params.sessionKey,
    provider: (params.provider ?? DEFAULT_PROVIDER).trim() || DEFAULT_PROVIDER,
    model: (params.model ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL,
  });
  if (secureModel.switchedFrom) {
    emitSecureModelNotice({
      runId: params.runId,
      sessionKey: params.sessionKey,
      from: secureModel.switchedFrom,
      to: `${secureModel.provider}/${secureModel.model}`,
    });
    params = { ...params, provider: secureModel.provider, model: secureModel.model };
  }
  const sessionFile = secure.isRamTranscriptPath(params.sessionFile)
    ? params.sessionFile
    : secure.transcriptPath(params.sessionId);
  try {
    const run = { ...params, sessionFile };
    return await withLocalRuntimeForRun(run, () => runEmbeddedPiAgentInner(run));
  } finally {
    try {
      secure.sealTranscripts();
    } catch {
      // the interval sealer retries
    }
  }
}

async function runEmbeddedPiAgentInner(
  params: RunEmbeddedPiAgentParams,
): Promise<EmbeddedPiRunResult> {
  const sessionLane = resolveSessionLane(params.sessionKey?.trim() || params.sessionId);
  const globalLane = resolveGlobalLane(params.lane);
  const enqueueGlobal =
    params.enqueue ?? ((task, opts) => enqueueCommandInLane(globalLane, task, opts));
  const enqueueSession =
    params.enqueue ?? ((task, opts) => enqueueCommandInLane(sessionLane, task, opts));
  const channelHint = params.messageChannel ?? params.messageProvider;
  const resolvedToolResultFormat =
    params.toolResultFormat ??
    (channelHint
      ? isMarkdownCapableMessageChannel(channelHint)
        ? "markdown"
        : "plain"
      : "markdown");
  const isProbeSession = params.sessionId?.startsWith("probe-") ?? false;

  return enqueueSession(() =>
    enqueueGlobal(async () => {
      const started = Date.now();
      const resolvedWorkspace = resolveUserPath(params.workspaceDir);
      const prevCwd = process.cwd();

      const provider = (params.provider ?? DEFAULT_PROVIDER).trim() || DEFAULT_PROVIDER;
      const modelId = (params.model ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL;
      const agentDir = params.agentDir ?? resolveInfiniBotAgentDir();
      const fallbackConfigured =
        (params.config?.agents?.defaults?.model?.fallbacks?.length ?? 0) > 0;
      // Secure Mode: provider discovery (e.g. ollama-cloud) calls hosted APIs,
      // so a secure run reuses the existing models.json instead of refreshing it.
      if (
        !isSecureSessionKey(params.sessionKey) ||
        !existsSync(path.join(agentDir, "models.json"))
      ) {
        await ensureInfiniBotModelsJson(params.config, agentDir);
      }

      const { model, error, authStorage, modelRegistry } = resolveModel(
        provider,
        modelId,
        agentDir,
        params.config,
      );
      if (!model) {
        // Typed so runWithModelFallback moves on (configured fallbacks, then
        // the self-healing candidates) instead of failing the whole turn.
        throw new FailoverError(
          `${error ?? `Unknown model: ${provider}/${modelId}`} (not in the provider's model catalog — retired upstream?)`,
          {
            reason: "model_not_found",
            provider,
            model: modelId,
            status: resolveFailoverStatus("model_not_found"),
            code: "MODEL_NOT_FOUND",
          },
        );
      }

      // Secure Mode: local models only, enforced on the resolved endpoint.
      // A plain (non-Failover) error so the fallback chain stops here instead
      // of walking on to hosted models.
      await assertSecureModelAllowed({
        sessionKey: params.sessionKey,
        provider,
        modelId,
        baseUrl: (model as { baseUrl?: string }).baseUrl,
        cfg: params.config,
      });

      const modelRejected = (detail: string) =>
        new FailoverError(
          `Model unavailable: ${provider}/${modelId} was rejected by the provider as not found (${detail.trim().slice(0, 200)})`,
          {
            reason: "model_not_found",
            provider,
            model: modelId,
            status: resolveFailoverStatus("model_not_found"),
            code: "MODEL_NOT_FOUND",
          },
        );

      const ctxInfo = resolveContextWindowInfo({
        cfg: params.config,
        provider,
        modelId,
        modelContextWindow: model.contextWindow,
        defaultTokens: DEFAULT_CONTEXT_TOKENS,
      });
      const ctxGuard = evaluateContextWindowGuard({
        info: ctxInfo,
        warnBelowTokens: CONTEXT_WINDOW_WARN_BELOW_TOKENS,
        hardMinTokens: CONTEXT_WINDOW_HARD_MIN_TOKENS,
      });
      if (ctxGuard.shouldWarn) {
        log.warn(
          `low context window: ${provider}/${modelId} ctx=${ctxGuard.tokens} (warn<${CONTEXT_WINDOW_WARN_BELOW_TOKENS}) source=${ctxGuard.source}`,
        );
      }
      if (ctxGuard.shouldBlock) {
        log.error(
          `blocked model (context window too small): ${provider}/${modelId} ctx=${ctxGuard.tokens} (min=${CONTEXT_WINDOW_HARD_MIN_TOKENS}) source=${ctxGuard.source}`,
        );
        throw new FailoverError(
          `Model context window too small (${ctxGuard.tokens} tokens). Minimum is ${CONTEXT_WINDOW_HARD_MIN_TOKENS}.`,
          { reason: "unknown", provider, model: modelId },
        );
      }

      const authStore = ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });
      const preferredProfileId = params.authProfileId?.trim();
      let lockedProfileId = params.authProfileIdSource === "user" ? preferredProfileId : undefined;
      if (lockedProfileId) {
        const lockedProfile = authStore.profiles[lockedProfileId];
        if (
          !lockedProfile ||
          normalizeProviderId(lockedProfile.provider) !== normalizeProviderId(provider)
        ) {
          lockedProfileId = undefined;
        }
      }
      const profileOrder = resolveAuthProfileOrder({
        cfg: params.config,
        store: authStore,
        provider,
        preferredProfile: preferredProfileId,
      });
      if (lockedProfileId && !profileOrder.includes(lockedProfileId)) {
        throw new Error(`Auth profile "${lockedProfileId}" is not configured for ${provider}.`);
      }
      const profileCandidates = lockedProfileId
        ? [lockedProfileId]
        : profileOrder.length > 0
          ? profileOrder
          : [undefined];
      let profileIndex = 0;

      const initialThinkLevel = params.thinkLevel ?? "off";
      let thinkLevel = initialThinkLevel;
      const attemptedThinking = new Set<ThinkLevel>();
      let apiKeyInfo: ApiKeyInfo | null = null;
      let lastProfileId: string | undefined;

      const resolveAuthProfileFailoverReason = (params: {
        allInCooldown: boolean;
        message: string;
      }): FailoverReason => {
        if (params.allInCooldown) return "rate_limit";
        const classified = classifyFailoverReason(params.message);
        return classified ?? "auth";
      };

      const throwAuthProfileFailover = (params: {
        allInCooldown: boolean;
        message?: string;
        error?: unknown;
      }): never => {
        const fallbackMessage = `No available auth profile for ${provider} (all in cooldown or unavailable).`;
        const message =
          params.message?.trim() ||
          (params.error ? describeUnknownError(params.error).trim() : "") ||
          fallbackMessage;
        const reason = resolveAuthProfileFailoverReason({
          allInCooldown: params.allInCooldown,
          message,
        });
        if (fallbackConfigured) {
          throw new FailoverError(message, {
            reason,
            provider,
            model: modelId,
            status: resolveFailoverStatus(reason),
            cause: params.error,
          });
        }
        if (params.error instanceof Error) throw params.error;
        throw new Error(message);
      };

      const resolveApiKeyForCandidate = async (candidate?: string) => {
        return getApiKeyForModel({
          model,
          cfg: params.config,
          profileId: candidate,
          store: authStore,
          agentDir,
        });
      };

      const applyApiKeyInfo = async (candidate?: string): Promise<void> => {
        apiKeyInfo = await resolveApiKeyForCandidate(candidate);
        const resolvedProfileId = apiKeyInfo.profileId ?? candidate;
        if (!apiKeyInfo.apiKey) {
          if (apiKeyInfo.mode !== "aws-sdk") {
            throw new Error(
              `No API key resolved for provider "${model.provider}" (auth mode: ${apiKeyInfo.mode}).`,
            );
          }
          lastProfileId = resolvedProfileId;
          return;
        }
        if (model.provider === "github-copilot") {
          const { resolveCopilotApiToken } =
            await import("../../providers/github-copilot-token.js");
          const copilotToken = await resolveCopilotApiToken({
            githubToken: apiKeyInfo.apiKey,
          });
          authStorage.setRuntimeApiKey(model.provider, copilotToken.token);
        } else {
          authStorage.setRuntimeApiKey(model.provider, apiKeyInfo.apiKey);
        }
        lastProfileId = apiKeyInfo.profileId;
      };

      const advanceAuthProfile = async (): Promise<boolean> => {
        if (lockedProfileId) return false;
        let nextIndex = profileIndex + 1;
        while (nextIndex < profileCandidates.length) {
          const candidate = profileCandidates[nextIndex];
          if (candidate && isProfileInCooldown(authStore, candidate)) {
            nextIndex += 1;
            continue;
          }
          try {
            await applyApiKeyInfo(candidate);
            profileIndex = nextIndex;
            thinkLevel = initialThinkLevel;
            attemptedThinking.clear();
            return true;
          } catch (err) {
            if (candidate && candidate === lockedProfileId) throw err;
            nextIndex += 1;
          }
        }
        return false;
      };

      try {
        while (profileIndex < profileCandidates.length) {
          const candidate = profileCandidates[profileIndex];
          if (
            candidate &&
            candidate !== lockedProfileId &&
            isProfileInCooldown(authStore, candidate)
          ) {
            profileIndex += 1;
            continue;
          }
          await applyApiKeyInfo(profileCandidates[profileIndex]);
          break;
        }
        if (profileIndex >= profileCandidates.length) {
          throwAuthProfileFailover({ allInCooldown: true });
        }
      } catch (err) {
        if (err instanceof FailoverError) throw err;
        if (profileCandidates[profileIndex] === lockedProfileId) {
          throwAuthProfileFailover({ allInCooldown: false, error: err });
        }
        const advanced = await advanceAuthProfile();
        if (!advanced) {
          throwAuthProfileFailover({ allInCooldown: false, error: err });
        }
      }

      // Local model (or Secure Mode): longer turn timeout, and background
      // OCR/vision on the shared GPU pauses while this interactive turn runs.
      const localTurn = isLocalModelTurn({
        cfg: params.config,
        provider,
        sessionKey: params.sessionKey,
        baseUrl: (model as { baseUrl?: string }).baseUrl,
      });
      const turnTimeoutMs = resolveTurnTimeoutMs({
        cfg: params.config,
        timeoutMs: params.timeoutMs,
        local: localTurn,
      });
      const releaseGpuHold =
        localTurn && resolveGlobalLane(params.lane) === "main" && !isProbeSession
          ? beginInteractiveTurn(
              { runId: params.runId, sessionKey: params.sessionKey, provider, model: modelId },
              { maxHoldMs: turnTimeoutMs + 60_000 },
            )
          : null;

      let overflowCompactionAttempted = false;
      try {
        while (true) {
          attemptedThinking.add(thinkLevel);
          await fs.mkdir(resolvedWorkspace, { recursive: true });

          const prompt =
            provider === "anthropic" ? scrubAnthropicRefusalMagic(params.prompt) : params.prompt;

          const attempt = await runEmbeddedAttempt({
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
            messageChannel: params.messageChannel,
            messageProvider: params.messageProvider,
            agentAccountId: params.agentAccountId,
            messageTo: params.messageTo,
            messageThreadId: params.messageThreadId,
            groupId: params.groupId,
            groupChannel: params.groupChannel,
            groupSpace: params.groupSpace,
            spawnedBy: params.spawnedBy,
            currentChannelId: params.currentChannelId,
            currentThreadTs: params.currentThreadTs,
            replyToMode: params.replyToMode,
            hasRepliedRef: params.hasRepliedRef,
            sessionFile: params.sessionFile,
            workspaceDir: params.workspaceDir,
            agentDir,
            config: params.config,
            skillsSnapshot: params.skillsSnapshot,
            prompt,
            images: params.images,
            disableTools: params.disableTools,
            provider,
            modelId,
            model,
            authStorage,
            modelRegistry,
            thinkLevel,
            verboseLevel: params.verboseLevel,
            reasoningLevel: params.reasoningLevel,
            toolResultFormat: resolvedToolResultFormat,
            execOverrides: params.execOverrides,
            bashElevated: params.bashElevated,
            timeoutMs: turnTimeoutMs,
            runId: params.runId,
            abortSignal: params.abortSignal,
            shouldEmitToolResult: params.shouldEmitToolResult,
            shouldEmitToolOutput: params.shouldEmitToolOutput,
            onPartialReply: params.onPartialReply,
            onAssistantMessageStart: params.onAssistantMessageStart,
            onBlockReply: params.onBlockReply,
            onBlockReplyFlush: params.onBlockReplyFlush,
            blockReplyBreak: params.blockReplyBreak,
            blockReplyChunking: params.blockReplyChunking,
            onReasoningStream: params.onReasoningStream,
            onToolResult: params.onToolResult,
            onAgentEvent: params.onAgentEvent,
            extraSystemPrompt: params.extraSystemPrompt,
            streamParams: params.streamParams,
            ownerNumbers: params.ownerNumbers,
            enforceFinalTag: params.enforceFinalTag,
          });

          const { aborted, promptError, timedOut, sessionIdUsed, lastAssistant } = attempt;
          const compactForOverflow = () =>
            compactEmbeddedPiSessionDirect({
              sessionId: params.sessionId,
              sessionKey: params.sessionKey,
              messageChannel: params.messageChannel,
              messageProvider: params.messageProvider,
              agentAccountId: params.agentAccountId,
              authProfileId: lastProfileId,
              sessionFile: params.sessionFile,
              workspaceDir: params.workspaceDir,
              agentDir,
              config: params.config,
              skillsSnapshot: params.skillsSnapshot,
              provider,
              model: modelId,
              thinkLevel,
              reasoningLevel: params.reasoningLevel,
              bashElevated: params.bashElevated,
              extraSystemPrompt: params.extraSystemPrompt,
              ownerNumbers: params.ownerNumbers,
            });

          if (promptError && !aborted) {
            const errorText = describeUnknownError(promptError);
            if (isContextOverflowError(errorText)) {
              const isCompactionFailure = isCompactionFailureError(errorText);
              // Attempt auto-compaction on context overflow (not compaction_failure)
              if (!isCompactionFailure && !overflowCompactionAttempted) {
                log.warn(
                  `context overflow detected; attempting auto-compaction for ${provider}/${modelId}`,
                );
                overflowCompactionAttempted = true;
                const compactResult = await compactForOverflow();
                if (compactResult.compacted) {
                  log.info(`auto-compaction succeeded for ${provider}/${modelId}; retrying prompt`);
                  continue;
                }
                log.warn(
                  `auto-compaction failed for ${provider}/${modelId}: ${compactResult.reason ?? "nothing to compact"}`,
                );
              }
              const kind = isCompactionFailure ? "compaction_failure" : "context_overflow";
              return {
                payloads: [
                  {
                    text:
                      "Context overflow: prompt too large for the model. " +
                      "Try again with less input or a larger-context model.",
                    isError: true,
                  },
                ],
                meta: {
                  durationMs: Date.now() - started,
                  agentMeta: {
                    sessionId: sessionIdUsed,
                    provider,
                    model: model.id,
                  },
                  systemPromptReport: attempt.systemPromptReport,
                  error: { kind, message: errorText },
                },
              };
            }
            // Handle role ordering errors with a user-friendly message
            if (/incorrect role information|roles must alternate/i.test(errorText)) {
              return {
                payloads: [
                  {
                    text:
                      "Message ordering conflict - please try again. " +
                      "If this persists, use /new to start a fresh session.",
                    isError: true,
                  },
                ],
                meta: {
                  durationMs: Date.now() - started,
                  agentMeta: {
                    sessionId: sessionIdUsed,
                    provider,
                    model: model.id,
                  },
                  systemPromptReport: attempt.systemPromptReport,
                  error: { kind: "role_ordering", message: errorText },
                },
              };
            }
            if (isModelNotFoundErrorMessage(errorText)) throw modelRejected(errorText);
            const promptFailoverReason = classifyFailoverReason(errorText);
            if (promptFailoverReason && promptFailoverReason !== "timeout" && lastProfileId) {
              await markAuthProfileFailure({
                store: authStore,
                profileId: lastProfileId,
                reason: promptFailoverReason,
                cfg: params.config,
                agentDir: params.agentDir,
              });
            }
            if (
              isFailoverErrorMessage(errorText) &&
              promptFailoverReason !== "timeout" &&
              (await advanceAuthProfile())
            ) {
              continue;
            }
            const fallbackThinking = pickFallbackThinkingLevel({
              message: errorText,
              attempted: attemptedThinking,
            });
            if (fallbackThinking) {
              log.warn(
                `unsupported thinking level for ${provider}/${modelId}; retrying with ${fallbackThinking}`,
              );
              thinkLevel = fallbackThinking;
              continue;
            }
            // FIX: Throw FailoverError for prompt errors when fallbacks configured
            // This enables model fallback for quota/rate limit errors during prompt submission
            if (fallbackConfigured && isFailoverErrorMessage(errorText)) {
              throw new FailoverError(errorText, {
                reason: promptFailoverReason ?? "unknown",
                provider,
                model: modelId,
                profileId: lastProfileId,
                status: resolveFailoverStatus(promptFailoverReason ?? "unknown"),
              });
            }
            throw promptError;
          }

          const fallbackThinking = pickFallbackThinkingLevel({
            message: lastAssistant?.errorMessage,
            attempted: attemptedThinking,
          });
          if (fallbackThinking && !aborted) {
            log.warn(
              `unsupported thinking level for ${provider}/${modelId}; retrying with ${fallbackThinking}`,
            );
            thinkLevel = fallbackThinking;
            continue;
          }

          // Overflow surfacing mid-turn as an assistant error (e.g. Ollama's
          // "no user query found in messages" once tool results push the prompt
          // past its runtime num_ctx): compact once and retry, like a prompt
          // error, instead of ending the turn with an empty reply.
          if (
            !aborted &&
            lastAssistant?.stopReason === "error" &&
            !overflowCompactionAttempted &&
            isContextOverflowError(lastAssistant.errorMessage ?? "") &&
            !isCompactionFailureError(lastAssistant.errorMessage ?? "")
          ) {
            log.warn(
              `context overflow in assistant reply; attempting auto-compaction for ${provider}/${modelId}`,
            );
            overflowCompactionAttempted = true;
            const compactResult = await compactForOverflow();
            if (compactResult.compacted) {
              log.info(`auto-compaction succeeded for ${provider}/${modelId}; retrying prompt`);
              continue;
            }
            log.warn(
              `auto-compaction failed for ${provider}/${modelId}: ${compactResult.reason ?? "nothing to compact"}`,
            );
          }

          // The provider rejected the model id itself: no profile is at fault and
          // retrying it is pointless — hand over to the fallback runner, which
          // heals onto the nearest valid model (works without configured fallbacks).
          if (
            !aborted &&
            lastAssistant?.stopReason === "error" &&
            isModelNotFoundErrorMessage(lastAssistant.errorMessage ?? "")
          ) {
            throw modelRejected(lastAssistant.errorMessage ?? "");
          }

          const authFailure = isAuthAssistantError(lastAssistant);
          const rateLimitFailure = isRateLimitAssistantError(lastAssistant);
          const failoverFailure = isFailoverAssistantError(lastAssistant);
          const assistantFailoverReason = classifyFailoverReason(lastAssistant?.errorMessage ?? "");
          const cloudCodeAssistFormatError = attempt.cloudCodeAssistFormatError;
          const imageDimensionError = parseImageDimensionError(lastAssistant?.errorMessage ?? "");

          if (imageDimensionError && lastProfileId) {
            const details = [
              imageDimensionError.messageIndex !== undefined
                ? `message=${imageDimensionError.messageIndex}`
                : null,
              imageDimensionError.contentIndex !== undefined
                ? `content=${imageDimensionError.contentIndex}`
                : null,
              imageDimensionError.maxDimensionPx !== undefined
                ? `limit=${imageDimensionError.maxDimensionPx}px`
                : null,
            ]
              .filter(Boolean)
              .join(" ");
            log.warn(
              `Profile ${lastProfileId} rejected image payload${details ? ` (${details})` : ""}.`,
            );
          }

          // Timed out after gathering tool results: keep them and tell the user
          // (with a Continue) instead of silently re-running on another model.
          const timeoutNotice =
            timedOut && !isProbeSession
              ? buildTurnTimeoutNotice({
                  timeoutMs: turnTimeoutMs,
                  messages: attempt.messagesSnapshot,
                })
              : null;
          const keepPartial = Boolean(timeoutNotice && (timeoutNotice.gathered > 0 || localTurn));

          // Treat timeout as potential rate limit (Antigravity hangs on rate limit)
          const shouldRotate = (!aborted && failoverFailure) || (timedOut && !keepPartial);

          if (shouldRotate) {
            if (lastProfileId) {
              const reason =
                timedOut || assistantFailoverReason === "timeout"
                  ? "timeout"
                  : (assistantFailoverReason ?? "unknown");
              await markAuthProfileFailure({
                store: authStore,
                profileId: lastProfileId,
                reason,
                cfg: params.config,
                agentDir: params.agentDir,
              });
              if (timedOut && !isProbeSession) {
                log.warn(
                  `Profile ${lastProfileId} timed out (possible rate limit). Trying next account...`,
                );
              }
              if (cloudCodeAssistFormatError) {
                log.warn(
                  `Profile ${lastProfileId} hit Cloud Code Assist format error. Tool calls will be sanitized on retry.`,
                );
              }
            }

            const rotated = await advanceAuthProfile();
            if (rotated) continue;

            if (fallbackConfigured) {
              // Prefer formatted error message (user-friendly) over raw errorMessage
              const message =
                (lastAssistant
                  ? formatAssistantErrorText(lastAssistant, {
                      cfg: params.config,
                      sessionKey: params.sessionKey ?? params.sessionId,
                    })
                  : undefined) ||
                lastAssistant?.errorMessage?.trim() ||
                (timedOut
                  ? "LLM request timed out."
                  : rateLimitFailure
                    ? "LLM request rate limited."
                    : authFailure
                      ? "LLM request unauthorized."
                      : "LLM request failed.");
              const status =
                resolveFailoverStatus(assistantFailoverReason ?? "unknown") ??
                (isTimeoutErrorMessage(message) ? 408 : undefined);
              throw new FailoverError(message, {
                reason: assistantFailoverReason ?? "unknown",
                provider,
                model: modelId,
                profileId: lastProfileId,
                status,
                rawMessage: lastAssistant?.errorMessage?.trim() || undefined,
              });
            }
          }

          const usage = normalizeUsage(lastAssistant?.usage as UsageLike);
          const agentMeta: EmbeddedPiAgentMeta = {
            sessionId: sessionIdUsed,
            provider: lastAssistant?.provider ?? provider,
            model: lastAssistant?.model ?? model.id,
            usage,
          };

          const builtPayloads = buildEmbeddedRunPayloads({
            assistantTexts: attempt.assistantTexts,
            toolMetas: attempt.toolMetas,
            lastAssistant: attempt.lastAssistant,
            lastToolError: attempt.lastToolError,
            config: params.config,
            sessionKey: params.sessionKey ?? params.sessionId,
            verboseLevel: params.verboseLevel,
            reasoningLevel: params.reasoningLevel,
            toolResultFormat: resolvedToolResultFormat,
            inlineToolResultsAllowed: false,
          });
          const payloads = timeoutNotice
            ? [...builtPayloads.filter((p) => !p.isError), { text: timeoutNotice.text }]
            : builtPayloads;
          if (timeoutNotice) {
            log.warn(
              `embedded run timed out with ${timeoutNotice.gathered} tool result(s) gathered: runId=${params.runId} timeoutMs=${turnTimeoutMs}`,
            );
            appendTurnTimeoutNotice({
              sessionFile: params.sessionFile,
              sessionId: sessionIdUsed,
              sessionKey: params.sessionKey,
              prompt: params.prompt,
              text: timeoutNotice.text,
            });
            // Close the turn first (clears the spinner), then show the notice.
            endTimedOutRunLifecycle(params.runId);
            broadcastTurnTimeoutNotice({
              runId: params.runId,
              sessionKey: params.sessionKey,
              text: timeoutNotice.text,
            });
          }

          log.debug(
            `embedded run done: runId=${params.runId} sessionId=${params.sessionId} durationMs=${Date.now() - started} aborted=${aborted}`,
          );
          if (lastProfileId) {
            await markAuthProfileGood({
              store: authStore,
              provider,
              profileId: lastProfileId,
              agentDir: params.agentDir,
            });
            await markAuthProfileUsed({
              store: authStore,
              profileId: lastProfileId,
              agentDir: params.agentDir,
            });
          }

          // Cumulative-skills capture. Fire-and-forget — the trajectory store is
          // a synchronous JSONL append, so this returns immediately; we don't
          // run reflection inline (no LLM call here) to keep the response path
          // hot. Reflection happens in the periodic self-improve pass.
          if (!isProbeSession) {
            try {
              const usage = normalizeUsage(agentMeta.usage as UsageLike | undefined);
              const totalTokens =
                usage?.total ??
                (typeof usage?.input === "number" || typeof usage?.output === "number"
                  ? (usage?.input ?? 0) + (usage?.output ?? 0)
                  : undefined);
              const finalOutput = (attempt.lastAssistant?.content ?? [])
                .map((c) => (c.type === "text" ? c.text : ""))
                .join("")
                .slice(0, 4000);
              void captureCompletion({
                trajectory: {
                  source: {
                    agentId: params.agentAccountId ?? "default",
                    sessionKey: params.sessionKey ?? params.sessionId ?? "unknown",
                  },
                  taskPrompt: (params.prompt ?? "").slice(0, 4000),
                  steps: [],
                  finalOutput,
                  metrics: {
                    durationMs: Date.now() - started,
                    totalTokens,
                    toolCalls: attempt.toolMetas?.length ?? 0,
                    clarifications: 0,
                    errored: aborted || Boolean(attempt.lastAssistant?.errorMessage),
                    reportedSuccess: !aborted && !attempt.lastAssistant?.errorMessage,
                  },
                },
              }).catch((err) => {
                log.debug(`captureCompletion failed: ${(err as Error).message}`);
              });
            } catch (err) {
              log.debug(`captureCompletion wiring threw: ${(err as Error).message}`);
            }
          }

          return {
            payloads: payloads.length ? payloads : undefined,
            meta: {
              durationMs: Date.now() - started,
              agentMeta,
              aborted,
              systemPromptReport: attempt.systemPromptReport,
              // Handle client tool calls (OpenResponses hosted tools)
              stopReason: attempt.clientToolCall ? "tool_calls" : undefined,
              pendingToolCalls: attempt.clientToolCall
                ? [
                    {
                      id: `call_${Date.now()}`,
                      name: attempt.clientToolCall.name,
                      arguments: JSON.stringify(attempt.clientToolCall.params),
                    },
                  ]
                : undefined,
            },
            didSendViaMessagingTool: attempt.didSendViaMessagingTool,
            messagingToolSentTexts: attempt.messagingToolSentTexts,
            messagingToolSentTargets: attempt.messagingToolSentTargets,
          };
        }
      } finally {
        releaseGpuHold?.();
        process.chdir(prevCwd);
      }
    }),
  );
}
