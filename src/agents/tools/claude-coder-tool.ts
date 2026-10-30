/**
 * Per-backend coder sub-agent tools.
 *
 * Each CoderBackend is exposed as its own MCP tool so workflows can declare
 * `requires: [{ kind: "tool", name: "opencode_coder" }]`. The internal
 * `createCoderToolForBackend` factory pins a specific backend at tool
 * registration time; `createClaudeCoderTool` is the legacy generic tool that
 * accepts an optional `backend` parameter at call time for voice surfaces that
 * let the user pick the CLI via the agent-cli-selector.
 */

import { coderFailureHint } from "../../infinibot-knowledge/fix-hints.js";
import crypto from "node:crypto";
import { spawn as spawnProc } from "node:child_process";
import { statSync } from "node:fs";

import { Type } from "@sinclair/typebox";
import { stringEnum } from "../schema/typebox.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam, readNumberParam } from "./common.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { loadConfig } from "../../config/config.js";
import { resolveRepoRoot } from "../../config/paths.js";
import { resolveStorePath, updateSessionStore } from "../../config/sessions.js";
import { scanChildOutputForAcks } from "../subagent-inbox/service.js";
import { getEventBus } from "../../federation/event-bus.js";
import { normalizeAgentId } from "../../routing/session-key.js";
// COORDINATION: opencode-swap — replaced direct launcher imports with registry.
// The registry reads `coder.backend` from config and delegates to the right
// backend (ClaudeCodeBackend or OpenCodeBackend). Default = "claude-code".
import { createCoderBackend } from "../coder-backend/registry.js";
import { normalizeCoderModelOverride } from "../coder-backend/model-normalization.js";
import { resolveCoderAutoApprove } from "../coder-backend/approval-policy.js";
import { getDurableSpawnInfo, isDurableSpawnEnabled } from "../coder-backend/durable-spawn.js";
import { COMPLETION_CONTRACT_PROMPT } from "../../verification/contract.js";
import {
  buildCoderContinuationSpawner,
  RawOutputBuffer,
  readDurableStdout,
  startCoderVerification,
} from "../../verification/coder-integration.js";
import {
  isVerificationEnabled,
  superviseRunExit,
  type ContinuationSpawner,
} from "../../verification/pipeline.js";
import type { CoderBackend, CoderBackendId } from "../coder-backend/types.js";
import { CODER_BACKEND_IDS, coderCliCommand, isCoderBackendId } from "../coder-backend/types.js";
import {
  type CoderLaunchAttempt,
  probeBackgroundStart,
  spawnCoderWithFallback,
} from "../coder-backend/spawn-with-fallback.js";
import { resolveAgentCoderBackends } from "../agent-integration-config.js";
import { gateAgentSpawn } from "../agent-concurrency-gate.js";
import type { BackgroundSession, SessionInfo } from "../claude-code/launcher.js";
import type { CLIAgentConfig } from "../types/agent-types.js";
import { broadcastSubagentToolEvent } from "../coder-runtime/subagent-broadcast.js";
import {
  appendCoderTranscriptEntry,
  appendCoderStdoutChunk,
  resolveTranscriptPath,
  flushTranscriptQueue,
  type CoderTranscriptContext,
} from "../coder-runtime/transcript.js";
import { indexTranscript, finalizeTranscriptIndex } from "../coder-runtime/transcript-index.js";
import { getStreamParser } from "../coder-runtime/stream-parsers.js";
import {
  initProgressTracking,
  reportProgress,
  recordActivity,
  completeProgress,
  hasProgressRun,
  registerCheckpointConfig,
} from "../subagent-progress.js";
import { makeCoderRunId } from "../run-id.js";
import { findOrCreateProject, mcpAppendTaskNote, mcpCreateTask } from "./kanban-tool.js";
import { verifyAndFinalizeKanban } from "../verification-gate.js";
import { getKanbanStore } from "../../tasks/store.js";
import {
  registerSubagentRunForCoder,
  updateSubagentRunContinuation,
  updateSubagentRunClaudeSessionId,
  updateSubagentRunTranscriptPath,
  markSubagentRunComplete,
  appendFileTouched,
} from "../subagent-registry.js";
import { buildActiveProfileContextBlock } from "../../users/profile-context.js";
import { appendSpawnEvent } from "../spawn-ledger.js";

const log = createSubsystemLogger("claude-coder-tool");

/**
 * How long (ms) to watch a freshly-spawned detached backend before deciding it
 * launched successfully, when a fallback backend is configured. Resolves early
 * the instant the backend produces output or exits; this is only the ceiling
 * for a backend that is slow to emit its first line. Only applies when a
 * fallback is set — agents without one keep the original zero-latency path.
 */
const LAUNCH_PROBE_GRACE_MS = 8000;

// ── Schemas ──────────────────────────────────────────────────────────────────

// Shared props used by all per-backend schemas (no `backend` override — the
// tool identity IS the backend choice for opencode_coder / codex_coder).
const coderSchemaProps = {
  task: Type.String({
    description: "The coding task to perform (fix, build, refactor, etc.)",
  }),
  workdir: Type.Optional(
    Type.String({ description: "Working directory (defaults to moltbot project root)" }),
  ),
  model: Type.Optional(
    Type.String({
      description:
        "Model override. Accepted format depends on the backend: " +
        "Claude Code → 'opus' | 'sonnet' | 'haiku' (or a full model id). " +
        "OpenCode → 'provider/name' (e.g. 'anthropic/claude-sonnet', 'openai/gpt-4', 'ollama-cloud/glm-5.1'). " +
        "Codex → bare model name passed to `codex --model`. " +
        "Gemini → bare gemini-* name. Grok Build → bare grok-* name passed to `grok -m`. " +
        "Omit to use the backend's configured default. Never pass a backend/tool name " +
        "('codex', 'claude', 'claude-code', 'opencode', 'gemini', 'grok', or 'default') as the model.",
    }),
  ),
  timeoutMinutes: Type.Optional(
    Type.Number({
      minimum: 1,
      maximum: 240,
      description: "Max runtime in minutes (default 30 detach / 15 sync)",
    }),
  ),
  systemPrompt: Type.Optional(
    Type.String({ description: "Extra system prompt appended to the CLI agent" }),
  ),
  enabledMCPs: Type.Optional(
    Type.Array(Type.String(), {
      description: "MCP server names to enable (default: none)",
    }),
  ),
  autoApprove: Type.Optional(
    Type.Boolean({
      description:
        "Auto-approve all tool calls (--dangerously-skip-permissions). Default true for autonomous fixes on operator turns. Ignored (always off) for untrusted turns and when tools.coder.autoApprove=never.",
    }),
  ),
  mode: Type.Optional(
    stringEnum(["sync", "detach"] as const, {
      description:
        "sync = block until child exits (legacy). detach (default) = return immediately, run in background; await with subagents_wait / subagents_events.",
    }),
  ),
  projectId: Type.Optional(
    Type.String({ description: "Existing kanban project ID to attach this task to." }),
  ),
  projectHint: Type.Optional(
    Type.String({
      description:
        "Project name hint. The server will reuse an existing matching project (exact or fuzzy >=70% token overlap on active recent projects) before creating a new one. Avoids project proliferation.",
    }),
  ),
  label: Type.Optional(
    Type.String({ description: "Short label for this run (used as kanban task title)." }),
  ),
  respawnOfRunId: Type.Optional(
    Type.String({
      description:
        "Internal: when this spawn is a retry of a failed run, the original runId. " +
        "Set by `subagents.respawn`; surfaces as a 'Respawn of …' badge in the UI.",
    }),
  ),
  requireCheckpointApproval: Type.Optional(
    Type.Boolean({
      description:
        "Strict drift gate. When true, each report_checkpoint the agent emits PAUSES the run until the operator clicks Approve / Redirect / Stop in the focus modal. Default false (soft gate: check-ins surface live but never block).",
    }),
  ),
  offLimits: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Path fragments the agent must not touch. Used for soft drift detection: a check-in mentioning one of these is flagged 'Drift suspected' in the UI. Does not block on its own.",
    }),
  ),
} as const;

/** Schema for per-backend tools — no runtime `backend` override (the tool IS the backend). */
const BaseCoderSchema = Type.Object(coderSchemaProps);

/** Schema for the generic claude_coder tool — retains the optional `backend` override
 *  so voice surfaces with the agent-cli-selector can pass the user's choice through. */
const ClaudeCoderSchema = Type.Object({
  ...coderSchemaProps,
  backend: Type.Optional(
    stringEnum(CODER_BACKEND_IDS, {
      description:
        "Override the CoderBackend used for this spawn. Defaults to the configured backend (coder.backend in infinibot.json). Voice surfaces pass the user's <agent-cli-selector> choice through here.",
    }),
  ),
});

// ── Shared execute factory ────────────────────────────────────────────────────

type CoderToolOptions = {
  agentId?: string;
  agentSessionKey?: string;
  workspaceDir?: string;
  /**
   * Origin trust of the turn that owns this tool instance. false → the spawn
   * never gets the CLI permission bypass (unless tools.coder.autoApprove=always).
   * Undefined → operator surface (MCP / RPC / autonomy), historical behavior.
   */
  trustedOrigin?: boolean;
};

/**
 * Internal factory that creates the AnyAgentTool for any coder backend.
 *
 * @param pinnedBackendId - When non-null the backend is fixed at registration
 *   time and the tool schema has no `backend` param (the tool IS the backend).
 *   When null the backend is resolved at call time from the `backend` param or
 *   the global `coder.backend` config (used by the generic `claude_coder` tool).
 * @param identity - Tool name, UI label, description, and TypeBox schema.
 * @param options  - Caller-supplied agent context (agentId, sessionKey, workspaceDir).
 */
// biome-ignore lint/suspicious/noExplicitAny: TypeBox schema from pi-agent-core uses any
function createCoderToolForBackend(
  pinnedBackendId: CoderBackendId | null,
  identity: { name: string; label: string; description: string; schema: any },
  options?: CoderToolOptions,
): AnyAgentTool {
  return {
    label: identity.label,
    name: identity.name,
    description: identity.description,
    parameters: identity.schema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const task = readStringParam(params, "task", { required: true });
      // PLAN GATE (SaaS/hosted only — a no-op locally): refuse the spawn before
      // any side effect when the tenant is at its plan's concurrent-agent or
      // concurrent-coder cap. See src/agents/agent-concurrency-gate.ts.
      const planLimit = await gateAgentSpawn({ kind: "coder" });
      if (planLimit) return jsonResult({ status: "error", error: planLimit.message, ...planLimit });
      // Workdir precedence: explicit param → caller-supplied workspaceDir →
      // resolved repo root (env / package.json walk) → process.cwd(). The
      // repo-root step is what makes voice-spawned terminals land in the
      // right directory regardless of how the gateway was started.
      const requestedWorkdir = readStringParam(params, "workdir");
      const preferredWorkdir = requestedWorkdir || options?.workspaceDir || resolveRepoRoot();
      const workdir = [requestedWorkdir, options?.workspaceDir, resolveRepoRoot(), process.cwd()]
        .filter((candidate): candidate is string => Boolean(candidate))
        .find((candidate) => {
          try {
            return statSync(candidate).isDirectory();
          } catch {
            return false;
          }
        });
      if (!workdir) {
        return jsonResult({
          status: "error",
          error: `No usable coder working directory was found (requested: "${preferredWorkdir}").`,
        });
      }
      let workdirWarning: string | undefined;
      if (workdir !== preferredWorkdir) {
        workdirWarning = `Ignored unavailable workdir "${preferredWorkdir}"; using "${workdir}".`;
        log.warn(workdirWarning);
      }
      const rawModel = readStringParam(params, "model");
      const callerSystemPrompt = readStringParam(params, "systemPrompt");
      // Every spawn gets the InfiniBot integration preamble appended so the
      // child Claude actually USES the memory / workflows / skills tools
      // we expose to it via the auto-injected `infinibot` MCP. Caller's
      // own systemPrompt is preserved verbatim after the preamble.
      // GitHub context (if available) is injected after project resolution below.
      let systemPrompt = composeSpawnSystemPrompt(callerSystemPrompt);
      const explicitProjectId = readStringParam(params, "projectId");
      const projectHint = readStringParam(params, "projectHint");
      const labelInput = readStringParam(params, "label");
      const respawnOfRunId = readStringParam(params, "respawnOfRunId");
      const requireCheckpointApproval = params.requireCheckpointApproval === true;
      const offLimits = Array.isArray(params.offLimits)
        ? (params.offLimits as unknown[]).filter((s): s is string => typeof s === "string")
        : [];
      const enabledMCPs = Array.isArray(params.enabledMCPs) ? (params.enabledMCPs as string[]) : [];
      // Auto-enable supabase when the PAT is configured so every spawn gets DB access without opting in manually.
      if (process.env.SUPABASE_PAT && !enabledMCPs.includes("supabase")) {
        enabledMCPs.push("supabase");
      }
      const autoApprove = resolveCoderAutoApprove({
        requested: params.autoApprove !== false,
        trustedOrigin: options?.trustedOrigin,
        cfg: loadConfig(),
      });
      const mode: "sync" | "detach" = params.mode === "sync" ? "sync" : "detach";

      // Explicit per-call backend choice (only the literal forms count):
      //   - pinned tools (opencode_coder, codex_coder): backend fixed at registration time.
      //   - claude_coder (pinnedBackendId=null): optional per-call `backend` param.
      // The agent's defaultCoderBackend / global default are applied below once
      // the requester agent id and config are known.
      const explicitBackendId: CoderBackendId | null = (() => {
        if (pinnedBackendId) return pinnedBackendId;
        const raw = readStringParam(params, "backend");
        return isCoderBackendId(raw) ? raw : null;
      })();
      const defaultTimeout = mode === "sync" ? 15 : 30;
      const timeoutMinutes = readNumberParam(params, "timeoutMinutes") || defaultTimeout;

      const runId = makeCoderRunId(labelInput, task, hasProgressRun);
      const requesterAgentId = normalizeAgentId(options?.agentId);
      const childSessionKey = `agent:${requesterAgentId}:subagent:${crypto.randomUUID()}`;
      const labelText = (labelInput || task).slice(0, 120);
      const cfg = loadConfig();
      const storePath = resolveStorePath(cfg.session?.store, { agentId: requesterAgentId });
      const startedAt = Date.now();
      const requesterSessionKey = options?.agentSessionKey || `agent:${requesterAgentId}:main`;

      // Resolve the primary backend (explicit arg → agent default → global) and
      // an optional fallback (agent.fallbackCoderBackend). These start as the
      // primary; if a fallback launch is needed in detach mode, the *actual*
      // backend used is reassigned below so labels/records reflect reality.
      const { primary: primaryBackendId, fallback: fallbackBackendId } = resolveAgentCoderBackends(
        cfg,
        requesterAgentId,
        explicitBackendId,
      );
      const normalizedModel = normalizeCoderModelOverride(rawModel, primaryBackendId);
      const model = normalizedModel.model;
      const modelWarning = normalizedModel.warning;
      if (modelWarning) {
        log.warn(modelWarning, { requestedModel: rawModel, backend: primaryBackendId });
      }
      let resolvedBackend: CoderBackend = createCoderBackend(primaryBackendId);
      let backendId: CoderBackendId = primaryBackendId;
      let backendDisplayName = resolvedBackend.getCapabilities().displayName;

      const subagentEnv: Record<string, string> = {
        INFINIBOT_SUBAGENT_RUN_ID: runId,
        INFINIBOT_SUBAGENT_SESSION_KEY: childSessionKey,
        INFINIBOT_PARENT_SESSION_KEY: requesterSessionKey,
        MOLTBOT_DEFAULT_SESSION_KEY: childSessionKey,
      };

      log.info("Spawning coder sub-agent", {
        runId,
        childSessionKey,
        mode,
        backend: backendId,
        task: task.slice(0, 100),
        workdir,
        timeoutMinutes,
        model,
        modelWarning,
        workdirWarning,
        hasProjectHint: Boolean(projectHint),
      });

      // Activity-page session row. Capture the resolved sessionId so we can
      // also stream a transcript that the activity page's preview reader sees.
      let resolvedSessionId: string | null = null;
      void updateSessionStore(storePath, (store) => {
        const existing = store[childSessionKey];
        const sessionId = existing?.sessionId ?? crypto.randomUUID();
        resolvedSessionId = sessionId;
        store[childSessionKey] = {
          ...existing,
          sessionId,
          updatedAt: startedAt,
          label: labelText,
          displayName: `${backendDisplayName}: ${labelText}`,
          model: model || existing?.model,
          coderBackend: backendId,
        };
        return store[childSessionKey];
      }).catch((err) => {
        log.warn("Failed to write claude-coder session entry", { error: err?.message });
      });

      // Build a transcript context for live progress updates. We use a small
      // helper that resolves the sessionId once the store write settles —
      // best-effort: if the store write hasn't landed yet we retry on the next
      // call. This file is what the /activity page reads via sessions.preview.
      let transcriptCtx: CoderTranscriptContext | null = null;
      const ensureTranscriptCtx = async (): Promise<CoderTranscriptContext | null> => {
        if (transcriptCtx) return transcriptCtx;
        if (!resolvedSessionId) {
          // Wait one tick for the store update.
          await new Promise((r) => setTimeout(r, 50));
          if (!resolvedSessionId) return null;
        }
        transcriptCtx = { sessionId: resolvedSessionId, storePath, agentId: requesterAgentId };
        // Persist the resolved path on the run record so it survives registry sweeps.
        const tPath = resolveTranscriptPath(transcriptCtx);
        updateSubagentRunTranscriptPath(runId, tPath);
        // Index at spawn time so the transcript is findable even if the gateway crashes.
        void indexTranscript({
          runId,
          sessionKey: childSessionKey,
          agentId: requesterAgentId,
          label: labelText,
          spawnedAt: startedAt,
          transcriptPath: tPath,
        });
        return transcriptCtx;
      };

      // Seed transcript with the user prompt so the activity page has
      // something to render the moment the run is spawned.
      void (async () => {
        const ctx = await ensureTranscriptCtx();
        if (!ctx) return;
        await appendCoderTranscriptEntry(ctx, {
          role: "user",
          content: task,
          ts: startedAt,
          meta: { runId, mode, model, workdir, source: "claude-coder" },
        });
        await appendCoderTranscriptEntry(ctx, {
          role: "assistant",
          content: `▶ Spawning ${backendDisplayName} (${mode}, ${model || "default model"})…`,
          ts: startedAt + 1,
        });
      })();

      getEventBus().publish("session.spawned", {
        sessionKey: childSessionKey,
        runId,
        agentId: requesterAgentId,
        label: labelText,
        executionMode: "claude-coder",
        coderBackend: backendId,
      });

      // Resolve project (dedup) + create kanban task. Best-effort: if Notion is
      // unavailable we still spawn the run.
      let projectId: string | undefined = explicitProjectId || undefined;
      let projectMatched: "exact" | "fuzzy" | "created" | "explicit" | "none" = explicitProjectId
        ? "explicit"
        : "none";
      if (!projectId && projectHint) {
        // Derive an implicit parent hint from the workdir basename so that e.g.
        // workdir="/home/user/InfiniBot-fresh" suggests parent "InfiniBot" even
        // when the projectHint doesn't contain the parent name as a prefix.
        // Strip common suffixes (-fresh, -v2, -prod, -local, -dev, -staging, etc.)
        // and convert separators to spaces for the fuzzy matcher.
        let parentHintFromWorkdir: string | undefined;
        if (workdir) {
          const base = workdir.split(/[/\\]/).filter(Boolean).pop() || "";
          const stripped = base
            .replace(/-?(fresh|v\d+|prod|local|dev|staging|main|test|new|beta|alpha)$/i, "")
            .replace(/[-_]/g, " ")
            .trim();
          if (stripped && stripped.toLowerCase() !== (projectHint || "").toLowerCase()) {
            parentHintFromWorkdir = stripped;
          }
        }
        const resolved = await findOrCreateProject(projectHint, {
          description: `Auto-created from claude_coder run for: ${labelText}`,
          parentProjectHint: parentHintFromWorkdir,
        });
        if (resolved) {
          projectId = resolved.projectId;
          projectMatched = resolved.matched;
        }
      }

      // ── GitHub context injection ──────────────────────────
      // If the linked project has a GitHub repo, surface it in the system prompt
      // so the spawned agent knows where to push code and can use git commands.
      if (projectId) {
        try {
          const meta = getKanbanStore().getProjectMeta(projectId);
          if (meta?.githubRepoOwner && meta?.githubRepoName) {
            const ghLines: string[] = [
              "## GitHub Repository",
              `- Repo: https://github.com/${meta.githubRepoOwner}/${meta.githubRepoName}`,
            ];
            if (meta.githubLocalPath) ghLines.push(`- Local clone: ${meta.githubLocalPath}`);
            if (meta.githubDefaultBranch)
              ghLines.push(`- Default branch: ${meta.githubDefaultBranch}`);
            if (meta.githubSyncStatus) ghLines.push(`- Sync status: ${meta.githubSyncStatus}`);
            // Fetch recent commits via gh
            try {
              const { stdout } = await new Promise<{ stdout: string }>((res) => {
                const child = spawnProc(
                  "gh",
                  [
                    "api",
                    `repos/${meta.githubRepoOwner}/${meta.githubRepoName}/commits`,
                    "--jq",
                    '.[0:5] | .[] | "  " + .sha[0:7] + " " + .commit.message',
                  ],
                  { stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 },
                );
                let out = "";
                child.stdout.on("data", (d: Buffer) => {
                  out += d.toString();
                });
                child.on("close", () => res({ stdout: out }));
                child.on("error", () => res({ stdout: "" }));
              });
              if (stdout.trim()) {
                ghLines.push("- Recent commits (last 5):");
                ghLines.push(stdout.trim());
              }
            } catch {
              /* non-fatal */
            }
            systemPrompt = systemPrompt + "\n\n---\n\n" + ghLines.join("\n");
          }
        } catch (e) {
          log.debug("GitHub context injection failed (non-fatal)", {
            error: (e as Error)?.message,
          });
        }
      }

      // ── Deploy target injection ───────────────────────────
      // When the workdir or project belongs to a repo with a deploy branch
      // (Repos › Deploy branch), tell the agent exactly where it deploys from.
      try {
        const { deployContextForSpawn } = await import("../../projects/repos/service.js");
        const deployBlock = deployContextForSpawn({ workdir, projectId });
        if (deployBlock) systemPrompt = systemPrompt + "\n\n---\n\n" + deployBlock;
      } catch (e) {
        log.debug("Deploy target injection failed (non-fatal)", { error: (e as Error)?.message });
      }

      let kanbanTaskId: string | undefined;
      // A respawn continues the original run's card (no duplicate task).
      if (respawnOfRunId) {
        try {
          const { claimRespawnTask } = await import("../../verification/kanban-reconcile.js");
          kanbanTaskId = await claimRespawnTask(respawnOfRunId, runId);
        } catch (err) {
          log.debug("respawn kanban claim failed (creating a new task)", {
            error: (err as Error)?.message,
          });
        }
      }
      try {
        const created = kanbanTaskId
          ? { id: kanbanTaskId }
          : await mcpCreateTask({
              title: labelText,
              projectId,
              status: "in_progress",
              priority: "medium",
              assignee: requesterAgentId,
            });
        if (created?.id) {
          kanbanTaskId = created.id;
          // FIX C: embed recovery footer so boot-time reconciliation can rebuild
          // the registry entry if runs.json was lost or corrupted.
          void mcpAppendTaskNote(
            kanbanTaskId,
            [
              `▶ ${identity.name} run ${runId}`,
              `mode: ${mode}`,
              `backend: ${backendId}`,
              `session: ${childSessionKey}`,
              `workdir: ${workdir}`,
              `timeout: ${timeoutMinutes}m`,
              "",
              "Task:",
              task,
              "",
              `<!-- subagent runId:${runId} childKey:${childSessionKey} requester:${requesterSessionKey} -->`,
            ].join("\n"),
          );
        }
      } catch (err) {
        log.warn("kanban task create failed (continuing)", { error: (err as Error)?.message });
      }

      // Make the run visible to subagents_list / subagent_progress.
      initProgressTracking({
        runId,
        sessionKey: childSessionKey,
        label: labelText,
        task,
        requesterSessionKey,
      });

      // VERIFIED COMPLETION: open the completion record (captures HEAD as the
      // evidence baseline) before the CLI can possibly exit.
      const verificationOn = isVerificationEnabled();
      if (verificationOn) {
        try {
          startCoderVerification({
            runId,
            childSessionKey,
            requesterSessionKey,
            label: labelText,
            task,
            backend: backendId,
            model,
            workdir,
            startedAt,
          });
        } catch (err) {
          log.warn("verification record create failed", { runId, error: (err as Error)?.message });
        }
      }
      const rawOut = new RawOutputBuffer();
      const rawErr = new RawOutputBuffer();

      /**
       * Drive the exited attempt through verified completion: premature exits
       * and unverified reviews resume the SAME session (bounded), then the run
       * settles in exactly one terminal state. Returns the SessionInfo of the
       * last attempt plus whether the verdict allows marking it succeeded.
       */
      const superviseCoderRun = async (
        info: SessionInfo,
        opts: { durable: boolean; onStdout?: (chunk: string) => void },
      ): Promise<{ info: SessionInfo; verified: boolean | null; failed: boolean }> => {
        if (!verificationOn) return { info, verified: null, failed: false };
        let last = info;
        const base = buildCoderContinuationSpawner({
          runId,
          backend: backendId,
          workdir,
          model,
          env: subagentEnv,
          timeoutMinutes,
          autoApprove,
          enabledMCPs,
          systemPrompt,
          durable: opts.durable,
          onStdout: opts.onStdout,
          onSpawned: ({ pid, durableKey, attempt }) => {
            updateSubagentRunContinuation(runId, { childPid: pid, durableKey, timeoutMinutes });
            recordActivity({
              runId,
              sessionKey: childSessionKey,
              kind: "boot",
              label: `Verification: continuing (attempt ${attempt})`,
              coderBackend: backendId,
            });
          },
        });
        const spawner: ContinuationSpawner = async (req) => {
          const o = await base(req);
          last = {
            ...last,
            exitCode: o.exitCode,
            killed: Boolean(o.killed),
            output: o.outputText ?? last.output,
            sessionId: o.sessionId ?? last.sessionId,
            durationMs: Date.now() - startedAt,
          };
          return o;
        };
        const rec = await superviseRunExit({
          runId,
          outcome: {
            exitCode: info.exitCode,
            killed: info.killed,
            rawOutput: opts.durable
              ? readDurableStdout(runId) || rawOut.toString()
              : rawOut.toString(),
            outputText: info.output,
            sessionId: info.sessionId ?? null,
          },
          spawnContinuation: spawner,
        });
        const state = rec?.state;
        return {
          info: last,
          verified: state ? state === "verified" || state === "accepted" : null,
          failed: state === "failed" || state === "stalled",
        };
      };

      // Register mid-run check-in behaviour for this run so report_checkpoint
      // (which only knows its sessionKey) can resolve the gate mode + off-limits
      // list. Strict gate (requireCheckpointApproval) pauses the agent on every
      // check-in until the operator approves from the focus modal.
      registerCheckpointConfig({
        runId,
        sessionKey: childSessionKey,
        requireApproval: requireCheckpointApproval,
        offLimits,
        approvalTimeoutMs: (() => {
          const m = cfg.approvals?.checkpointTimeoutMinutes;
          return typeof m === "number" && m > 0 ? m * 60_000 : undefined;
        })(),
      });

      const finishKanban = async (
        info: SessionInfo | null,
        error?: Error,
        verification?: { verified: boolean | null; failed: boolean },
      ) => {
        // A FAILED / stalled verification is never reported as success, even on exit 0.
        const succeeded = !error && info?.exitCode === 0 && !verification?.failed;
        const finalLabel = succeeded ? `✓ ${labelText}` : `✗ ${labelText}`;
        void updateSessionStore(storePath, (store) => {
          const existing = store[childSessionKey];
          if (!existing) return undefined;
          store[childSessionKey] = {
            ...existing,
            updatedAt: Date.now(),
            label: finalLabel,
            displayName: `${backendDisplayName}: ${finalLabel}`,
            claudeCliSessionId: info?.sessionId ?? existing.claudeCliSessionId,
          };
          return store[childSessionKey];
        }).catch(() => {});

        if (kanbanTaskId) {
          const noteParts: string[] = [
            succeeded ? "✓ run completed" : "✗ run ended with issues",
            `exitCode: ${info?.exitCode ?? "n/a"}`,
            `killed: ${info?.killed ?? false}`,
            `durationMs: ${info?.durationMs ?? "n/a"}`,
          ];
          if (error) noteParts.push(`error: ${error.message}`);
          if (info?.output) {
            noteParts.push("", "Output:", info.output.slice(0, 1500));
          }
          void mcpAppendTaskNote(kanbanTaskId, noteParts.join("\n"));

          // MANDATORY verification gate — replaces the old unconditional
          // `done` flip. The task is parked in "review" and only promoted to
          // "done" after an independent verifier PASSES (fail-closed otherwise).
          const taskIdForVerify = kanbanTaskId;
          void verifyAndFinalizeKanban({
            runId,
            taskId: taskIdForVerify,
            succeeded,
            brief: task,
            extraEvidence: info?.output,
            workdir,
            sessionKey: childSessionKey,
            backend: backendId,
            transcriptPath: transcriptCtx ? resolveTranscriptPath(transcriptCtx) : undefined,
          })
            .then((verdict) => {
              void mcpAppendTaskNote(
                taskIdForVerify,
                verdict.pass
                  ? `✅ [independent verifier] PASS — ${verdict.reason}`
                  : `🔶 [independent verifier] did not pass — ${verdict.reason}${verdict.failClosed ? " (fail-closed)" : ""}`,
              );
            })
            .catch((err) => {
              log.warn("verification gate failed in finishKanban", {
                runId,
                taskId: taskIdForVerify,
                error: (err as Error)?.message,
              });
            });
        }

        completeProgress(
          runId,
          error
            ? `Failed: ${error.message}`
            : succeeded
              ? "Task completed"
              : "Completed with errors",
        );

        // FIX A: mirror terminal state into the subagent registry so the sweeper
        // and restart recovery see a completed run rather than a stuck one.
        markSubagentRunComplete(
          runId,
          { status: succeeded ? "ok" : "error", error: error?.message },
          Date.now(),
        );

        // Final transcript line so the activity page shows the closing state.
        void (async () => {
          const ctx = await ensureTranscriptCtx();
          if (!ctx) return;
          const summary: string[] = [];
          summary.push(
            succeeded
              ? "✓ Task completed."
              : error
                ? `✗ Failed: ${error.message}`
                : "✗ Completed with errors.",
          );
          if (info?.exitCode !== undefined) summary.push(`exitCode: ${info.exitCode}`);
          if (info?.durationMs !== undefined) summary.push(`durationMs: ${info.durationMs}`);
          if (info?.output) summary.push("", info.output.slice(-1500));
          await appendCoderTranscriptEntry(ctx, {
            role: "assistant",
            content: summary.join("\n"),
            ts: Date.now(),
            meta: { runId, finalize: true, succeeded },
          });
          // Ensure all buffered writes land before the process could die.
          await flushTranscriptQueue();
          // Update the canonical index with the finishedAt timestamp.
          const tPath = resolveTranscriptPath(ctx);
          void finalizeTranscriptIndex(
            runId,
            tPath,
            childSessionKey,
            requesterAgentId,
            labelText,
            startedAt,
            Date.now(),
          );
        })();
      };

      // ── DETACH MODE ───────────────────────────────────────
      if (mode === "detach") {
        // COORDINATION: opencode-swap — routes through backend registry.
        const buildSubagentConfig = (cliCommand: string): CLIAgentConfig => ({
          id: runId,
          name: "claude-coder-subagent",
          type: "cli",
          cliCommand,
          autoApprove,
          timeoutMinutes,
          enabledMCPs,
          env: subagentEnv,
        });
        const cliCommandFor = coderCliCommand;

        // The first stdout chunk (from whichever backend actually starts)
        // resolves this; the launch-failure probe uses it to confirm the
        // backend is live. Kept subscribed (idempotent) so the main stream
        // parser below still receives every chunk.
        let resolveFirstOutput: (() => void) | null = null;
        const firstOutput = new Promise<void>((resolve) => {
          resolveFirstOutput = resolve;
        });
        // DURABILITY: detach-mode runs launch INSIDE a detached tmux session
        // (socket `-L infinibot`, session `infinibot_spawn_<runId>`) instead of
        // as a direct child of the gateway. The tmux server is owned by init, so
        // a gateway restart no longer kills in-flight sub-agents — it only drops
        // the log tailer, which boot recovery rebinds. Falls back transparently
        // to a direct child when tmux is unavailable (or on Windows).
        const durable = isDurableSpawnEnabled();
        const spawnAttempt = (backend: CoderBackendId): BackgroundSession => {
          const session = createCoderBackend(backend).spawnBackground(
            buildSubagentConfig(cliCommandFor(backend)),
            task,
            workdir,
            {
              runId,
              model: model ?? undefined,
              systemPrompt,
              env: subagentEnv,
              durableRunId: durable ? runId : undefined,
            },
          );
          session.onStdout(() => resolveFirstOutput?.());
          return session;
        };

        let bg: BackgroundSession;
        let launchAttempts: CoderLaunchAttempt[] = [];

        // Ledger: record intent before any fork so a hard crash mid-spawn is recoverable.
        appendSpawnEvent({
          v: 1,
          ts: Date.now(),
          event: "spawn.intent",
          runId,
          kind: "coder",
          backend: primaryBackendId,
          task: task.slice(0, 500),
          label: labelText || undefined,
          requesterSessionKey,
          childSessionKey,
          workdir: workdir || undefined,
          respawnOfRunId: respawnOfRunId || undefined,
        });

        if (!fallbackBackendId) {
          // No fallback configured → preserve the original zero-overhead path:
          // spawn directly, no startup probe, no added latency.
          try {
            bg = spawnAttempt(primaryBackendId);
          } catch (err: any) {
            log.error("Coder backend background spawn failed", { error: err?.message });
            appendSpawnEvent({
              v: 1,
              ts: Date.now(),
              event: "spawn.failed",
              runId,
              error: err?.message ?? String(err),
            });
            await finishKanban(null, err);
            return jsonResult({
              status: "error",
              error: err?.message ?? String(err),
              ...coderFailureHint(err?.message ?? String(err)),
              runId,
              childSessionKey,
              kanbanTaskId,
              projectId,
              projectMatched,
            });
          }
        } else {
          // Fallback configured → probe the primary's startup; on launch failure
          // (binary missing, auth error, non-zero exit before first turn) retry
          // once with the fallback backend.
          const result = await spawnCoderWithFallback<BackgroundSession>({
            primary: primaryBackendId,
            fallback: fallbackBackendId,
            attempt: async (backend) => {
              let session: BackgroundSession;
              try {
                session = spawnAttempt(backend);
              } catch (err: any) {
                return { ok: false, error: err?.message ?? String(err) };
              }
              const probe = await probeBackgroundStart(session, {
                graceMs: LAUNCH_PROBE_GRACE_MS,
                firstOutput,
              });
              if (!probe.started) {
                try {
                  session.kill("SIGKILL");
                } catch {
                  /* already dead */
                }
                return {
                  ok: false,
                  error: probe.error ?? "backend failed to start",
                  exitCode: probe.exitCode,
                };
              }
              return { ok: true, session };
            },
          });
          launchAttempts = result.attempts;
          if (!result.ok) {
            log.error("Coder backend failed to start (incl. fallback)", {
              error: result.error,
              attempts: result.attempts,
            });
            appendSpawnEvent({
              v: 1,
              ts: Date.now(),
              event: "spawn.failed",
              runId,
              error: result.error,
            });
            await finishKanban(null, new Error(result.error));
            return jsonResult({
              status: "error",
              error: result.error,
              ...coderFailureHint(result.error),
              runId,
              childSessionKey,
              kanbanTaskId,
              projectId,
              projectMatched,
              backendAttempts: result.attempts,
            });
          }
          bg = result.session;
          // Reassign identity when the run actually launched on the fallback so
          // labels, the session row, and the run record all reflect reality.
          if (result.backendUsed !== backendId) {
            log.warn("Coder backend fell back", { from: backendId, to: result.backendUsed });
            backendId = result.backendUsed;
            if (verificationOn) {
              const used = backendId;
              void import("../../verification/store.js").then(({ updateRecord }) =>
                updateRecord(runId, (r) => {
                  r.backend = used;
                }),
              );
            }
            resolvedBackend = createCoderBackend(backendId);
            backendDisplayName = resolvedBackend.getCapabilities().displayName;
            void updateSessionStore(storePath, (store) => {
              const existing = store[childSessionKey];
              if (existing) {
                store[childSessionKey] = {
                  ...existing,
                  displayName: `${backendDisplayName}: ${labelText}`,
                  coderBackend: backendId,
                };
              }
              return store[childSessionKey];
            }).catch(() => {});
          }
        }

        // FIX A: Persist this run to the subagent registry immediately after
        // spawn so it survives a gateway restart. Without this call the run is
        // never written to runs.json and any restart leaves the kanban task
        // stuck in "in_progress" with no recovery path.
        //
        // The child itself is now durable (tmux-backed — see `durable` above), so
        // `terminalId`/`tmuxSession` on this record are the recovery key: boot
        // recovery reattaches to the still-live session instead of resuming.
        const usedFallback = launchAttempts.length > 1;
        // Present only when the tmux launch actually succeeded — a silent
        // fallback to a direct child must not be recorded as durable, or boot
        // recovery would look for a tmux session that never existed.
        const durableInfo = getDurableSpawnInfo(runId);
        registerSubagentRunForCoder({
          runId,
          childSessionKey,
          requesterSessionKey,
          requesterDisplayKey: requesterSessionKey,
          task,
          label: labelText,
          kanbanTaskId: kanbanTaskId ?? undefined,
          childPid: bg.pid,
          timeoutMinutes,
          requesterOrigin: undefined,
          workdir,
          coderBackend: backendId,
          coderBackendAttempts: usedFallback ? launchAttempts : undefined,
          fallbackFromBackend: usedFallback ? launchAttempts[0]?.backend : undefined,
          respawnOfRunId: respawnOfRunId || undefined,
          durableSpawn: durableInfo ? "tmux-coder" : undefined,
          terminalId: durableInfo?.terminalId,
        });
        if (bg.pid) {
          appendSpawnEvent({ v: 1, ts: Date.now(), event: "spawn.pid", runId, pid: bg.pid });
        }

        // Emit a boot activity so the Activity card flips out of the bare
        // "starting 0%" state before the first stream event lands. Matters
        // most for OpenCode, which can take several seconds to emit its
        // first step_start.
        recordActivity({
          runId,
          sessionKey: childSessionKey,
          kind: "boot",
          label: `${backendDisplayName} starting…`,
          coderBackend: backendId,
        });

        // Surface progress as the child runs. The launcher now uses
        // --output-format stream-json so we get one NDJSON event per
        // Claude Code action (tool_use, tool_result, assistant text,
        // result). We:
        //   (1) Parse each line and append a human-readable summary to the
        //       activity transcript (e.g. "🔧 Read: src/foo.ts").
        //   (2) Call recordActivity() per event so subagents_list shows
        //       "Reading src/foo.ts · 4s ago" without churning checkpoints.
        //   (3) Promote significant events (assistant text turns) to
        //       reportProgress every ~30s so kanban gets a coarse signal.
        let lineBuf = "";
        let lastSummaryEmit = Date.now();
        let lastSummaryMessage = "";
        const toolStartTs = new Map<string, number>();
        // Single per-backend parser resolved once; everything downstream of it
        // (broadcasts, transcript, activity, heartbeat) is backend-agnostic so
        // the activity page renders OpenCode/Codex/Claude runs identically.
        const parseStreamLine = getStreamParser(backendId);
        const handleStdoutChunk = (chunk: string) => {
          // In-flight operator inbox: "ACK im_…" in the agent's output
          // acknowledges a delivered operator message.
          scanChildOutputForAcks(runId, chunk);
          lineBuf += chunk;
          let idx: number;
          while ((idx = lineBuf.indexOf("\n")) >= 0) {
            const line = lineBuf.slice(0, idx).trim();
            lineBuf = lineBuf.slice(idx + 1);
            if (!line) continue;
            const formatted = parseStreamLine(line);
            if (!formatted) continue;
            if (formatted.activity) {
              recordActivity({
                runId,
                sessionKey: childSessionKey,
                kind: formatted.activity.kind,
                label: formatted.activity.label,
                coderBackend: backendId,
              });
            }
            if (formatted.transcript) {
              const text = formatted.transcript;
              void (async () => {
                const ctx = await ensureTranscriptCtx();
                if (ctx) await appendCoderStdoutChunk(ctx, text, { mark: "stdout" });
              })();
            }
            if (formatted.summary) {
              lastSummaryMessage = formatted.summary;
            }
            // FIX A/B: persist Claude Code session ID as soon as it appears
            // so a gateway restart can use `claude --resume` to recover.
            if (formatted.claudeSessionId) {
              updateSubagentRunClaudeSessionId(runId, formatted.claudeSessionId);
            }
            // Real-time tool broadcasts so the Activity page's live WS
            // subscription shows each Read/Edit/Bash without waiting for
            // the 5s sessions.preview poll.
            if (formatted.toolStarts) {
              const ts = Date.now();
              for (const t of formatted.toolStarts) {
                toolStartTs.set(t.toolCallId, ts);
                broadcastSubagentToolEvent({
                  runId,
                  sessionKey: childSessionKey,
                  toolCallId: t.toolCallId,
                  name: t.name,
                  phase: "start",
                  ts,
                  arguments: t.arguments,
                  coderBackend: backendId,
                });
                // Capture file touches for the subagent detail modal
                const a = t.arguments as Record<string, unknown>;
                const fp =
                  typeof a?.file_path === "string"
                    ? a.file_path
                    : typeof a?.notebook_path === "string"
                      ? a.notebook_path
                      : null;
                if (fp) {
                  const fileAction =
                    t.name === "Write"
                      ? ("created" as const)
                      : t.name === "Edit" || t.name === "MultiEdit" || t.name === "NotebookEdit"
                        ? ("edited" as const)
                        : t.name === "Read"
                          ? ("read" as const)
                          : null;
                  if (fileAction) appendFileTouched(runId, fp, fileAction);
                }
              }
            }
            if (formatted.toolEnds) {
              const ts = Date.now();
              for (const t of formatted.toolEnds) {
                const startTs = toolStartTs.get(t.toolCallId);
                // Prefer a backend-reported duration (e.g. OpenCode's state.time)
                // over the start→end gap, which is ~0 when a backend emits a
                // tool's whole lifecycle on a single already-completed event.
                const durationMs = t.durationMs ?? (startTs ? ts - startTs : undefined);
                toolStartTs.delete(t.toolCallId);
                broadcastSubagentToolEvent({
                  runId,
                  sessionKey: childSessionKey,
                  toolCallId: t.toolCallId,
                  name: "",
                  phase: "end",
                  ts,
                  result: t.result,
                  error: t.error,
                  durationMs,
                  coderBackend: backendId,
                });
              }
            }
          }

          // Coarse progress ping every ~30s so kanban / requester chat
          // get a heartbeat. Uses the last meaningful event we parsed.
          if (Date.now() - lastSummaryEmit > 30_000 && lastSummaryMessage) {
            lastSummaryEmit = Date.now();
            const msg = lastSummaryMessage;
            lastSummaryMessage = "";
            void reportProgress({
              runId,
              sessionKey: childSessionKey,
              status: "working",
              message: msg,
              notifyRequester: false,
            });
          }
        };
        bg.onStdout((chunk) => rawOut.push(chunk));
        bg.onStdout(handleStdoutChunk);

        // Capture stderr too — failures are usually loud here.
        if (typeof bg.onStderr === "function") {
          bg.onStderr((chunk: string) => {
            rawErr.push(chunk);
            const text = chunk.trim();
            if (!text) return;
            void (async () => {
              const ctx = await ensureTranscriptCtx();
              if (ctx) await appendCoderStdoutChunk(ctx, text, { mark: "stderr" });
            })();
          });
        }

        // Hook completion off the background session, fire-and-forget. The
        // verified-completion pipeline runs first: it may resume the session
        // (premature exit / unverified) before kanban + registry settle.
        void bg.finalPromise.then(
          async (info) => {
            const stderrTail = rawErr.toString().trim().slice(-4000);
            const settledInfo =
              info.exitCode !== 0 && !info.output.trim() && stderrTail
                ? { ...info, output: stderrTail }
                : info;
            const v = await superviseCoderRun(settledInfo, {
              // Captured at spawn: the durable map forgets a run once its process exits.
              durable: Boolean(durableInfo),
              onStdout: handleStdoutChunk,
            }).catch((err) => {
              log.warn("verified completion failed (settling run as-is)", {
                runId,
                error: (err as Error)?.message,
              });
              return { info, verified: null, failed: false };
            });
            await finishKanban(v.info, undefined, v);
          },
          (err) => finishKanban(null, err instanceof Error ? err : new Error(String(err))),
        );

        return jsonResult({
          status: "accepted",
          mode: "detach",
          runId,
          childSessionKey,
          pid: bg.pid,
          startedAt: bg.startedAt,
          mcpServers: bg.mcpServers,
          kanbanTaskId,
          projectId,
          projectMatched,
          ...(modelWarning || workdirWarning
            ? { warning: [modelWarning, workdirWarning].filter(Boolean).join(" ") }
            : {}),
          hint: "Await completion with subagents_wait({runIds:[runId]}) (or subagents_events with a cursor) — do not poll PIDs/tmux/logs. The run is verified on exit (RESULT block + evidence review); relay work as done only when the verdict is VERIFIED.",
        });
      }

      // ── SYNC MODE ─────────────────────────────────────────
      {
        // COORDINATION: opencode-swap — routes through backend registry.
        const cliCommandFor = coderCliCommand;
        const runOnce = (backend: CoderBackendId): Promise<SessionInfo> =>
          createCoderBackend(backend).spawn(
            {
              id: runId,
              name: "claude-coder-subagent",
              type: "cli",
              cliCommand: cliCommandFor(backend),
              autoApprove,
              timeoutMinutes,
              enabledMCPs,
              env: subagentEnv,
            },
            task,
            workdir,
            { runId, model: model ?? undefined, systemPrompt, env: subagentEnv },
          );

        // A thrown spawn is treated as a launch failure (binary missing / auth):
        // when a fallback backend is configured, retry it once.
        const syncAttempts: CoderLaunchAttempt[] = [];
        let session: SessionInfo;
        try {
          session = await runOnce(primaryBackendId);
          syncAttempts.push({ backend: primaryBackendId, ok: true, exitCode: session.exitCode });
        } catch (err: any) {
          syncAttempts.push({
            backend: primaryBackendId,
            ok: false,
            error: err?.message ?? String(err),
          });
          if (!fallbackBackendId) {
            log.error("Coder spawn failed", { error: err?.message });
            await finishKanban(null, err);
            return jsonResult({
              status: "error",
              error: err?.message ?? String(err),
              ...coderFailureHint(err?.message ?? String(err)),
              runId,
              childSessionKey,
              kanbanTaskId,
              projectId,
              projectMatched,
              backendAttempts: syncAttempts,
            });
          }
          log.warn("Coder backend fell back (sync)", {
            from: primaryBackendId,
            to: fallbackBackendId,
            error: err?.message,
          });
          try {
            session = await runOnce(fallbackBackendId);
            backendId = fallbackBackendId;
            syncAttempts.push({ backend: fallbackBackendId, ok: true, exitCode: session.exitCode });
          } catch (err2: any) {
            syncAttempts.push({
              backend: fallbackBackendId,
              ok: false,
              error: err2?.message ?? String(err2),
            });
            log.error("Coder spawn failed (incl. fallback)", { error: err2?.message });
            await finishKanban(null, err2);
            return jsonResult({
              status: "error",
              error: err2?.message ?? String(err2),
              ...coderFailureHint(err2?.message ?? String(err2)),
              runId,
              childSessionKey,
              kanbanTaskId,
              projectId,
              projectMatched,
              backendAttempts: syncAttempts,
            });
          }
        }

        const syncV = await superviseCoderRun(session, { durable: false }).catch(() => ({
          info: session,
          verified: null as boolean | null,
          failed: false,
        }));
        session = syncV.info;
        await finishKanban(session, undefined, syncV);
        const { getRecord: getCompletionRecord } = await import("../../verification/store.js");
        const completion = getCompletionRecord(runId);
        return jsonResult({
          status: session.exitCode === 0 && !syncV.failed ? "ok" : "error",
          verification: completion
            ? {
                state: completion.state,
                verdict: completion.review?.verdict ?? null,
                reasons: completion.review?.reasons ?? [],
                attempts: completion.attempts.length,
              }
            : undefined,
          mode: "sync",
          ...(session.exitCode === 127 ? coderFailureHint("process exited with code 127") : {}),
          runId: session.runId,
          childSessionKey,
          sessionId: session.sessionId,
          exitCode: session.exitCode,
          killed: session.killed,
          durationMs: session.durationMs,
          output: session.output,
          mcpServers: session.mcpServers,
          kanbanTaskId,
          projectId,
          projectMatched,
          backend: backendId,
          ...(modelWarning || workdirWarning
            ? { warning: [modelWarning, workdirWarning].filter(Boolean).join(" ") }
            : {}),
          ...(syncAttempts.length > 1 ? { backendAttempts: syncAttempts } : {}),
        });
      }
    },
  };
}

// ── Public factories ──────────────────────────────────────────────────────────

const CODER_MODEL_GUIDANCE = `Omit model to use the backend's configured default. Never pass a backend/tool name such as "codex", "claude", "claude-code", "opencode", "gemini", "grok", or "default" as model.`;

const CLAUDE_CODER_DESCRIPTION = `Spawn a Claude Code CLI sub-agent for engineering work (write/edit files, run builds, refactor, fix bugs). Default mode is "detach": returns immediately with a childSessionKey + runId — await it with subagents_wait (or subagents_events); every run is verified on exit (RESULT block + evidence review, auto-continued if it stopped early). The run is auto-tracked as a kanban task. Pass projectHint to attach to (or reuse) an existing project; the server will fuzzy-match before creating a new project. Use mode:"sync" only for short blocking work where you need the output inline. Be specific in the task: file paths, acceptance criteria, whether to build/test. ${CODER_MODEL_GUIDANCE}`;

const OPENCODE_CODER_DESCRIPTION = `Spawn an OpenCode CLI sub-agent for engineering work (write/edit files, run builds, refactor, fix bugs). Default mode is "detach": returns immediately with a childSessionKey + runId — await it with subagents_wait (or subagents_events); every run is verified on exit (RESULT block + evidence review, auto-continued if it stopped early). The run is auto-tracked as a kanban task. Pass projectHint to attach to (or reuse) an existing project; the server will fuzzy-match before creating a new project. Use mode:"sync" only for short blocking work where you need the output inline. Be specific in the task: file paths, acceptance criteria, whether to build/test. ${CODER_MODEL_GUIDANCE}`;

const CODEX_CODER_DESCRIPTION = `Spawn a Codex CLI sub-agent for engineering work (write/edit files, run builds, refactor, fix bugs). Default mode is "detach": returns immediately with a childSessionKey + runId — await it with subagents_wait (or subagents_events); every run is verified on exit (RESULT block + evidence review, auto-continued if it stopped early). The run is auto-tracked as a kanban task. Pass projectHint to attach to (or reuse) an existing project; the server will fuzzy-match before creating a new project. Use mode:"sync" only for short blocking work where you need the output inline. Be specific in the task: file paths, acceptance criteria, whether to build/test. ${CODER_MODEL_GUIDANCE}`;

/**
 * Generic coder tool. Backend is resolved at call time from the optional
 * `backend` param (voice surfaces / agent-cli-selector) or the global
 * `coder.backend` config. Kept for back-compat — do not remove the `backend`
 * param from the schema.
 */
export function createClaudeCoderTool(options?: CoderToolOptions): AnyAgentTool {
  return createCoderToolForBackend(
    null,
    {
      name: "claude_coder",
      label: "ClaudeCoder",
      description: CLAUDE_CODER_DESCRIPTION,
      schema: ClaudeCoderSchema,
    },
    options,
  );
}

/**
 * OpenCode-pinned coder tool. Backend is fixed to "opencode" at registration
 * time; no `backend` param in the schema. Use in workflow `requires` as
 * `{ kind: "tool", name: "opencode_coder" }`.
 */
export function createOpenCodeCoderTool(options?: CoderToolOptions): AnyAgentTool {
  return createCoderToolForBackend(
    "opencode",
    {
      name: "opencode_coder",
      label: "OpenCodeCoder",
      description: OPENCODE_CODER_DESCRIPTION,
      schema: BaseCoderSchema,
    },
    options,
  );
}

/**
 * Codex-pinned coder tool. Backend is fixed to "codex" at registration time;
 * no `backend` param in the schema. Use in workflow `requires` as
 * `{ kind: "tool", name: "codex_coder" }`.
 */
export function createCodexCoderTool(options?: CoderToolOptions): AnyAgentTool {
  return createCoderToolForBackend(
    "codex",
    {
      name: "codex_coder",
      label: "CodexCoder",
      description: CODEX_CODER_DESCRIPTION,
      schema: BaseCoderSchema,
    },
    options,
  );
}

const GROK_CODER_DESCRIPTION = `Spawn an xAI Grok Build CLI sub-agent for engineering work (write/edit files, run builds, refactor, fix bugs). Runs on the user's SuperGrok / X Premium+ sign-in (or a Grok Build API key from Setup › Coders). Default mode is "detach": returns immediately with a childSessionKey + runId — await it with subagents_wait (or subagents_events); every run is verified on exit (RESULT block + evidence review, auto-continued if it stopped early). The run is auto-tracked as a kanban task. Pass projectHint to attach to (or reuse) an existing project; the server will fuzzy-match before creating a new project. Use mode:"sync" only for short blocking work where you need the output inline. Be specific in the task: file paths, acceptance criteria, whether to build/test. ${CODER_MODEL_GUIDANCE}`;

/**
 * Grok-pinned coder tool. Backend is fixed to "grok" (xAI Grok Build CLI) at
 * registration time; no `backend` param in the schema. Use in workflow
 * `requires` as `{ kind: "tool", name: "grok_coder" }`.
 */
export function createGrokCoderTool(options?: CoderToolOptions): AnyAgentTool {
  return createCoderToolForBackend(
    "grok",
    {
      name: "grok_coder",
      label: "GrokCoder",
      description: GROK_CODER_DESCRIPTION,
      schema: BaseCoderSchema,
    },
    options,
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// System-prompt composition
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Compose the `--append-system-prompt` that Claude Code spawns receive.
 *
 * Every spawn is wired to an `infinibot` MCP server (auto-injected by
 * src/agents/claude-code/mcp-bridge.ts) which exposes the gateway's full
 * tool registry. This preamble tells the child Claude that those tools
 * exist + when to reach for them — without it, the spawn behaves like a
 * vanilla Claude Code session and never participates in InfiniBot's
 * memory / workflow / skill systems even though the access is there.
 *
 * The caller's own systemPrompt (when provided) is appended verbatim
 * after the preamble so per-task instructions override / extend the
 * default integration guidance.
 */
const INFINIBOT_SPAWN_PREAMBLE = `You are running inside an InfiniBot \`claude_coder\` spawn. The \`infinibot\` MCP server is wired into this session and exposes the gateway's full tool registry. Use it the same way a native InfiniBot agent does:

## Self-learning (memory)
- \`memory_search\` / \`memory_get\` — search and read prior session memory before starting a non-trivial task. Recall what worked / what failed / which files matter for this codebase.
- Memory updates happen automatically via the gateway's session-memory hook — you don't have to write to it explicitly, but you SHOULD read from it.

## Workflows
- \`workflows\` (action: list / get / run) — the operator has saved reusable workflows on the gateway. Before reinventing a multi-step process, list workflows and pick one that fits.
- Use action \`run\` with workflowId + inputs to execute. The run streams back through the gateway.

## Skills
- \`skills_status\` — see the installed skill catalogue. Skills under \`~/.claude/skills/\` are auto-available (you don't need a tool to invoke them, just follow their SKILL.md), but the status RPC tells you what's installed.

## Context tools
- \`notes\` / \`research\` / \`kanban\` / \`databases\` — read prior notes, research artifacts, kanban tickets, and CRM rows.
- \`sessions_history\` — what other agents have been doing recently.
- \`agents_list\` — discover sibling agents you could hand off to via \`message\`.
- \`message\` — talk to another agent (use sparingly; only when a different specialist would clearly do it better).
- \`mcp\` — passthrough to any other MCP server the gateway has connected.

## Parent coordination
- You are a sub-agent. Runtime context is available in env vars: \`INFINIBOT_SUBAGENT_RUN_ID\`, \`INFINIBOT_SUBAGENT_SESSION_KEY\`, and \`INFINIBOT_PARENT_SESSION_KEY\`.
- Use \`subagent_progress\` for meaningful milestones. It reports to the spawning agent/requester; set \`notify:true\` when blocked or when the parent must act.
- If you need missing context or a decision, call \`subagent_progress\` with blocked status, a concise message, and \`notify:true\` before stopping. Do not wait silently at a CLI prompt.

## Mid-run check-ins (don't drift silently)
- On any long task, call \`report_checkpoint\` every ~10–15 minutes OR every ~10 file edits. Pass a one-paragraph \`summary\` (what you just finished), \`next\` (what you're about to do), and \`deviations\` (anything departing from the brief or scope — off-limits files, scope creep, a changed approach; empty when on-plan).
- This is what keeps the run from being a black box: the operator sees each check-in live and can intervene before drift compounds.
- If this run requires approval, \`report_checkpoint\` will BLOCK until the operator responds. Honor the returned decision: \`approve\` → proceed; \`redirect\` → discard your plan and follow the returned \`revisedPlan\`; \`stop\` → wind down promptly and summarize.
- \`report_checkpoint\` is for the cadence-based "still on track?" check-in; \`subagent_progress\` is for milestone / blocked signals. Use both as appropriate.

## Operator messages (mid-run instructions)
- The operator can message you WHILE you work. Messages arrive as \`[OPERATOR MESSAGE id=… from=… sent=…]\` blocks — appended after a tool result, as extra context, or in the result of any \`infinibot\` MCP tool.
- Treat each one as an authoritative amendment to your task: act on it right away; it overrides conflicting parts of the original brief.
- Acknowledge each message by writing the token \`ACK\` followed by its id in your next reply (or call \`subagent_inbox\` with action "ack").
- If your backend gives you no hook-based delivery, call \`subagent_inbox\` (action "check") between major steps.

## Workflow for non-trivial tasks
1. \`memory_search\` for prior work on this area.
2. \`workflows\` (list) for an existing recipe — if one fits, run it instead of redoing the work.
3. Do the task. Edit files, run tests.
4. Emit \`report_checkpoint\` check-ins on a cadence as you go (see above).
5. The session-memory hook auto-captures your work; no manual save needed.

Do NOT skip step 1 on substantive tasks — that's the whole point of running inside InfiniBot rather than as a bare Claude Code session.`;

function composeSpawnSystemPrompt(callerPrompt: string | null | undefined): string {
  const caller = (callerPrompt ?? "").trim();
  // Layer 1 operator context for the ACTIVE profile, prepended so every spawned
  // sub-agent inherits the user's role / goals / languages / notes. Best-effort:
  // returns "" when no operator context is set, so single-profile installs are
  // unaffected. Sits ABOVE the integration preamble so it frames everything.
  const profileBlock = buildActiveProfileContextBlock();
  const preamble = isVerificationEnabled()
    ? `${INFINIBOT_SPAWN_PREAMBLE}\n\n${COMPLETION_CONTRACT_PROMPT}`
    : INFINIBOT_SPAWN_PREAMBLE;
  const head = profileBlock ? `${profileBlock}\n\n---\n\n${preamble}` : preamble;
  if (!caller) return head;
  return `${head}\n\n---\n\n${caller}`;
}
