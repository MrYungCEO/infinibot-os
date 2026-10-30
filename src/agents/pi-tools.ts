import {
  codingTools,
  createEditTool,
  createReadTool,
  createWriteTool,
  readTool,
} from "@mariozechner/pi-coding-agent";
import { createSecureLaneTool } from "../secure-mode/lane-tool.js";
import { createSecureResearchTool } from "../secure-mode/research/tool.js";
import { isLaunchPanelBrowserSession } from "../launch-panel/runtime.js";
import { filterToolsForSecureSession } from "../secure-mode/policy.js";
import { isSecureSessionKey } from "../secure-mode/session-key.js";
import type { InfinibotConfig } from "../config/config.js";
import { resolveRepoRoot } from "../config/paths.js";
import { isLiveActionActive } from "../gateway/live-action-context.js";
import { isSubagentSessionKey } from "../routing/session-key.js";
import { resolveTurnTrust, type TurnTrust } from "../routing/sender-trust.js";
import { applyTurnTrustToTools } from "./pi-tools.trust.js";
import { resolveGatewayMessageChannel } from "../utils/message-channel.js";
import { createApplyPatchTool } from "./apply-patch.js";
import {
  createExecTool,
  createProcessTool,
  type ExecToolDefaults,
  type ProcessToolDefaults,
} from "./bash-tools.js";
import { listChannelAgentTools } from "./channel-tools.js";
import { createInfiniBotTools } from "./infinibot-tools.js";
import { dropEmptyToolSlots } from "../plugins/core-tool-slots.js";
import type { ModelAuthMode } from "./model-auth.js";
import { wrapToolWithAbortSignal } from "./pi-tools.abort.js";
import { wrapToolWithExecutionTimeout } from "./pi-tools.timeout.js";
import { wrapToolWithResultCap } from "./tool-result-cap.js";
import {
  filterToolsByPolicy,
  isToolAllowedByPolicies,
  resolveEffectiveToolPolicy,
  resolveGroupToolPolicy,
  resolveSubagentToolPolicy,
} from "./pi-tools.policy.js";
import {
  assertRequiredParams,
  CLAUDE_PARAM_GROUPS,
  createInfiniBotReadTool,
  createSandboxedEditTool,
  createSandboxedReadTool,
  createSandboxedWriteTool,
  normalizeToolParams,
  patchToolSchemaForClaudeCompatibility,
  wrapToolParamNormalization,
} from "./pi-tools.read.js";
import { cleanToolSchemaForGemini, normalizeToolParameters } from "./pi-tools.schema.js";
import type { AnyAgentTool } from "./pi-tools.types.js";
import type { SandboxContext } from "./sandbox.js";
import {
  buildPluginToolGroups,
  collectExplicitAllowlist,
  expandPolicyWithPluginGroups,
  normalizeToolName,
  resolveToolProfilePolicy,
  stripPluginOnlyAllowlist,
} from "./tool-policy.js";
import { getPluginToolMeta } from "../plugins/tools.js";
import { logWarn } from "../logger.js";

function isOpenAIProvider(provider?: string) {
  const normalized = provider?.trim().toLowerCase();
  return normalized === "openai" || normalized === "openai-codex";
}

function isApplyPatchAllowedForModel(params: {
  modelProvider?: string;
  modelId?: string;
  allowModels?: string[];
}) {
  const allowModels = Array.isArray(params.allowModels) ? params.allowModels : [];
  if (allowModels.length === 0) return true;
  const modelId = params.modelId?.trim();
  if (!modelId) return false;
  const normalizedModelId = modelId.toLowerCase();
  const provider = params.modelProvider?.trim().toLowerCase();
  const normalizedFull =
    provider && !normalizedModelId.includes("/")
      ? `${provider}/${normalizedModelId}`
      : normalizedModelId;
  return allowModels.some((entry) => {
    const normalized = entry.trim().toLowerCase();
    if (!normalized) return false;
    return normalized === normalizedModelId || normalized === normalizedFull;
  });
}

function resolveExecConfig(cfg: InfinibotConfig | undefined) {
  const globalExec = cfg?.tools?.exec;
  return {
    host: globalExec?.host,
    security: globalExec?.security,
    ask: globalExec?.ask,
    node: globalExec?.node,
    pathPrepend: globalExec?.pathPrepend,
    safeBins: globalExec?.safeBins,
    backgroundMs: globalExec?.backgroundMs,
    timeoutSec: globalExec?.timeoutSec,
    approvalRunningNoticeMs: globalExec?.approvalRunningNoticeMs,
    cleanupMs: globalExec?.cleanupMs,
    notifyOnExit: globalExec?.notifyOnExit,
    applyPatch: globalExec?.applyPatch,
  };
}

export const __testing = {
  cleanToolSchemaForGemini,
  normalizeToolParams,
  patchToolSchemaForClaudeCompatibility,
  wrapToolParamNormalization,
  assertRequiredParams,
} as const;

function resolveTurnTrustForTools(options?: {
  config?: InfinibotConfig;
  sessionKey?: string;
  spawnedBy?: string | null;
  messageProvider?: string;
  agentAccountId?: string;
  senderId?: string | null;
  senderE164?: string | null;
  senderUsername?: string | null;
}): TurnTrust {
  const own = resolveTurnTrust({
    config: options?.config,
    sessionKey: options?.sessionKey,
    messageProvider: options?.messageProvider,
    accountId: options?.agentAccountId,
    senderId: options?.senderId,
    senderE164: options?.senderE164,
    senderUsername: options?.senderUsername,
  });
  if (!own.trusted || !options?.spawnedBy) return own;
  // A sub-agent spawned from an external-hook session inherits its distrust.
  const parent = resolveTurnTrust({ config: options.config, sessionKey: options.spawnedBy });
  return parent.trusted ? own : { ...parent, reason: `spawned by ${parent.reason}` };
}

export function createInfiniBotCodingTools(options?: {
  exec?: ExecToolDefaults & ProcessToolDefaults;
  messageProvider?: string;
  agentAccountId?: string;
  messageTo?: string;
  messageThreadId?: string | number;
  sandbox?: SandboxContext | null;
  sessionKey?: string;
  agentDir?: string;
  workspaceDir?: string;
  /**
   * Directory exec/read/write/edit/apply_patch operate in when it differs from
   * the agent workspace (group chats bound to a shared repo). Identity files
   * keep loading from `workspaceDir`.
   */
  toolCwd?: string;
  config?: InfinibotConfig;
  abortSignal?: AbortSignal;
  /**
   * Provider of the currently selected model (used for provider-specific tool quirks).
   * Example: "anthropic", "openai", "google", "openai-codex".
   */
  modelProvider?: string;
  /** Model id for the current provider (used for model-specific tool gating). */
  modelId?: string;
  /**
   * Auth mode for the current provider. We only need this for Anthropic OAuth
   * tool-name blocking quirks.
   */
  modelAuthMode?: ModelAuthMode;
  /** Current channel ID for auto-threading (Slack). */
  currentChannelId?: string;
  /** Current thread timestamp for auto-threading (Slack). */
  currentThreadTs?: string;
  /** Group id for channel-level tool policy resolution. */
  groupId?: string | null;
  /** Group channel label (e.g. #general) for channel-level tool policy resolution. */
  groupChannel?: string | null;
  /** Group space label (e.g. guild/team id) for channel-level tool policy resolution. */
  groupSpace?: string | null;
  /** Parent session key for subagent group policy inheritance. */
  spawnedBy?: string | null;
  senderId?: string | null;
  senderName?: string | null;
  senderUsername?: string | null;
  senderE164?: string | null;
  /** Reply-to mode for Slack auto-threading. */
  replyToMode?: "off" | "first" | "all";
  /** Mutable ref to track if a reply was sent (for "first" mode). */
  hasRepliedRef?: { value: boolean };
  /** If true, the model has native vision capability */
  modelHasVision?: boolean;
  /**
   * Per-result text cap (chars). Defaults to DEFAULT_MAX_TOOL_RESULT_CHARS;
   * the embedded runner shrinks it for small context windows (local Ollama).
   */
  toolResultMaxChars?: number;
  /** Per-tool execution deadline override (ms); see pi-tools.timeout.ts. */
  toolTimeoutMs?: number;
}): AnyAgentTool[] {
  const execToolName = "exec";
  const sandbox = options?.sandbox?.enabled ? options.sandbox : undefined;
  // Who is driving this turn? Operator/owner turns keep full defaults;
  // non-owner senders and external hook content get hardened tools.
  const trust = resolveTurnTrustForTools(options);
  const launchPanelBrowserSession = isLaunchPanelBrowserSession(options?.sessionKey);
  const {
    agentId,
    globalPolicy,
    globalProviderPolicy,
    agentPolicy,
    agentProviderPolicy,
    profile,
    providerProfile,
    profileAlsoAllow,
    providerProfileAlsoAllow,
  } = resolveEffectiveToolPolicy({
    config: options?.config,
    sessionKey: options?.sessionKey,
    modelProvider: options?.modelProvider,
    modelId: options?.modelId,
  });
  const groupPolicy = resolveGroupToolPolicy({
    config: options?.config,
    sessionKey: options?.sessionKey,
    spawnedBy: options?.spawnedBy,
    messageProvider: options?.messageProvider,
    groupId: options?.groupId,
    groupChannel: options?.groupChannel,
    groupSpace: options?.groupSpace,
    accountId: options?.agentAccountId,
    senderId: options?.senderId,
    senderName: options?.senderName,
    senderUsername: options?.senderUsername,
    senderE164: options?.senderE164,
  });
  const profilePolicy = resolveToolProfilePolicy(profile);
  const providerProfilePolicy = resolveToolProfilePolicy(providerProfile);

  const mergeAlsoAllow = (policy: typeof profilePolicy, alsoAllow?: string[]) => {
    if (!policy?.allow || !Array.isArray(alsoAllow) || alsoAllow.length === 0) return policy;
    return { ...policy, allow: Array.from(new Set([...policy.allow, ...alsoAllow])) };
  };

  const profilePolicyWithAlsoAllow = mergeAlsoAllow(profilePolicy, profileAlsoAllow);
  const providerProfilePolicyWithAlsoAllow = mergeAlsoAllow(
    providerProfilePolicy,
    providerProfileAlsoAllow,
  );
  const scopeKey = options?.exec?.scopeKey ?? (agentId ? `agent:${agentId}` : undefined);
  const subagentPolicy =
    isSubagentSessionKey(options?.sessionKey) && options?.sessionKey
      ? resolveSubagentToolPolicy(options.config)
      : undefined;
  const allowBackground = isToolAllowedByPolicies("process", [
    profilePolicyWithAlsoAllow,
    providerProfilePolicyWithAlsoAllow,
    globalPolicy,
    globalProviderPolicy,
    agentPolicy,
    agentProviderPolicy,
    groupPolicy,
    sandbox?.tools,
    subagentPolicy,
  ]);
  const execConfig = resolveExecConfig(options?.config);
  const sandboxRoot = sandbox?.workspaceDir;
  const allowWorkspaceWrites = sandbox?.workspaceAccess !== "ro";
  // Fall back to the resolved repo root instead of process.cwd(): when the
  // gateway is launched via Electron, systemd, or an MCP entry, cwd is
  // typically "/" or "~" and tools spawned for voice-mode sessions would
  // land in the wrong directory. resolveRepoRoot() walks up from the
  // module location to find the InfiniBot package.json deterministically.
  const workspaceRoot = options?.toolCwd ?? options?.workspaceDir ?? resolveRepoRoot();
  const applyPatchConfig = options?.config?.tools?.exec?.applyPatch;
  const applyPatchEnabled =
    !!applyPatchConfig?.enabled &&
    isOpenAIProvider(options?.modelProvider) &&
    isApplyPatchAllowedForModel({
      modelProvider: options?.modelProvider,
      modelId: options?.modelId,
      allowModels: applyPatchConfig?.allowModels,
    });

  const base = (codingTools as unknown as AnyAgentTool[]).flatMap((tool) => {
    if (tool.name === readTool.name) {
      if (sandboxRoot) {
        return [createSandboxedReadTool(sandboxRoot)];
      }
      const freshReadTool = createReadTool(workspaceRoot);
      return [createInfiniBotReadTool(freshReadTool)];
    }
    if (tool.name === "bash" || tool.name === execToolName) return [];
    if (tool.name === "write") {
      if (sandboxRoot) return [];
      // Wrap with param normalization for Claude Code compatibility
      return [
        wrapToolParamNormalization(createWriteTool(workspaceRoot), CLAUDE_PARAM_GROUPS.write),
      ];
    }
    if (tool.name === "edit") {
      if (sandboxRoot) return [];
      // Wrap with param normalization for Claude Code compatibility
      return [wrapToolParamNormalization(createEditTool(workspaceRoot), CLAUDE_PARAM_GROUPS.edit)];
    }
    return [tool as AnyAgentTool];
  });
  const { cleanupMs: cleanupMsOverride, ...execDefaults } = options?.exec ?? {};
  const execTool = createExecTool({
    ...execDefaults,
    host: options?.exec?.host ?? execConfig.host,
    security: options?.exec?.security ?? execConfig.security,
    ask: options?.exec?.ask ?? execConfig.ask,
    node: options?.exec?.node ?? execConfig.node,
    pathPrepend: options?.exec?.pathPrepend ?? execConfig.pathPrepend,
    safeBins: options?.exec?.safeBins ?? execConfig.safeBins,
    agentId,
    // Exec tool cwd resolution mirrors workspaceRoot — voice sessions
    // without an explicit workspaceDir would otherwise inherit the
    // gateway's cwd ("/" or "~" under Electron). Repo root is the right
    // default for both interactive and autonomous agent flows.
    cwd: options?.toolCwd ?? options?.workspaceDir ?? workspaceRoot,
    allowBackground,
    scopeKey,
    sessionKey: options?.sessionKey,
    messageProvider: options?.messageProvider,
    backgroundMs: options?.exec?.backgroundMs ?? execConfig.backgroundMs,
    timeoutSec: options?.exec?.timeoutSec ?? execConfig.timeoutSec,
    approvalRunningNoticeMs:
      options?.exec?.approvalRunningNoticeMs ?? execConfig.approvalRunningNoticeMs,
    notifyOnExit: options?.exec?.notifyOnExit ?? execConfig.notifyOnExit,
    trustedOrigin: trust.trusted ? undefined : false,
    trustReason: trust.reason,
    untrustedHost: options?.config?.tools?.exec?.untrustedHost,
    sandbox: sandbox
      ? {
          containerName: sandbox.containerName,
          workspaceDir: sandbox.workspaceDir,
          containerWorkdir: sandbox.containerWorkdir,
          env: sandbox.docker.env,
        }
      : undefined,
  });
  const processTool = createProcessTool({
    cleanupMs: cleanupMsOverride ?? execConfig.cleanupMs,
    scopeKey,
  });
  const applyPatchTool =
    !applyPatchEnabled || (sandboxRoot && !allowWorkspaceWrites)
      ? null
      : createApplyPatchTool({
          cwd: sandboxRoot ?? workspaceRoot,
          sandboxRoot: sandboxRoot && allowWorkspaceWrites ? sandboxRoot : undefined,
        });
  const tools: AnyAgentTool[] = [
    ...base,
    ...(sandboxRoot
      ? allowWorkspaceWrites
        ? [createSandboxedEditTool(sandboxRoot), createSandboxedWriteTool(sandboxRoot)]
        : []
      : []),
    ...(applyPatchTool ? [applyPatchTool as unknown as AnyAgentTool] : []),
    execTool as unknown as AnyAgentTool,
    processTool as unknown as AnyAgentTool,
    // Channel docking: include channel-defined agent tools (login, etc.).
    ...listChannelAgentTools({ cfg: options?.config }),
    // Empty plugin tool slots (plugin off) are dropped — core-tool-slots.ts.
    ...dropEmptyToolSlots(
      createInfiniBotTools({
        sandboxBrowserBridgeUrl: sandbox?.browser?.bridgeUrl,
        allowHostBrowserControl: sandbox ? sandbox.browserAllowHostControl : true,
        agentSessionKey: options?.sessionKey,
        agentChannel: resolveGatewayMessageChannel(options?.messageProvider),
        agentAccountId: options?.agentAccountId,
        agentTo: options?.messageTo,
        agentThreadId: options?.messageThreadId,
        agentGroupId: options?.groupId ?? null,
        agentGroupChannel: options?.groupChannel ?? null,
        agentGroupSpace: options?.groupSpace ?? null,
        agentDir: options?.agentDir,
        sandboxRoot,
        workspaceDir: options?.workspaceDir,
        sandboxed: !!sandbox,
        config: options?.config,
        pluginToolAllowlist: collectExplicitAllowlist([
          profilePolicy,
          providerProfilePolicy,
          globalPolicy,
          globalProviderPolicy,
          agentPolicy,
          agentProviderPolicy,
          groupPolicy,
          sandbox?.tools,
          subagentPolicy,
        ]),
        currentChannelId: options?.currentChannelId,
        currentThreadTs: options?.currentThreadTs,
        replyToMode: options?.replyToMode,
        hasRepliedRef: options?.hasRepliedRef,
        modelHasVision: options?.modelHasVision,
        requesterAgentIdOverride: agentId,
      }),
    ),
  ];
  const coreToolNames = new Set(
    tools
      .filter((tool) => !getPluginToolMeta(tool as AnyAgentTool))
      .map((tool) => normalizeToolName(tool.name))
      .filter(Boolean),
  );
  const pluginGroups = buildPluginToolGroups({
    tools,
    toolMeta: (tool) => getPluginToolMeta(tool as AnyAgentTool),
  });
  const resolvePolicy = (policy: typeof profilePolicy, label: string) => {
    const resolved = stripPluginOnlyAllowlist(policy, pluginGroups, coreToolNames);
    if (resolved.unknownAllowlist.length > 0) {
      const entries = resolved.unknownAllowlist.join(", ");
      const suffix = resolved.strippedAllowlist
        ? "Ignoring allowlist so core tools remain available. Use tools.alsoAllow for additive plugin tool enablement."
        : "These entries won't match any tool unless the plugin is enabled.";
      logWarn(`tools: ${label} allowlist contains unknown entries (${entries}). ${suffix}`);
    }
    return expandPolicyWithPluginGroups(resolved.policy, pluginGroups);
  };
  const profilePolicyExpanded = resolvePolicy(
    profilePolicyWithAlsoAllow,
    profile ? `tools.profile (${profile})` : "tools.profile",
  );
  const providerProfileExpanded = resolvePolicy(
    providerProfilePolicyWithAlsoAllow,
    providerProfile ? `tools.byProvider.profile (${providerProfile})` : "tools.byProvider.profile",
  );
  const globalPolicyExpanded = resolvePolicy(globalPolicy, "tools.allow");
  const globalProviderExpanded = resolvePolicy(globalProviderPolicy, "tools.byProvider.allow");
  const agentPolicyExpanded = resolvePolicy(
    agentPolicy,
    agentId ? `agents.${agentId}.tools.allow` : "agent tools.allow",
  );
  const agentProviderExpanded = resolvePolicy(
    agentProviderPolicy,
    agentId ? `agents.${agentId}.tools.byProvider.allow` : "agent tools.byProvider.allow",
  );
  const groupPolicyExpanded = resolvePolicy(groupPolicy, "group tools.allow");
  const sandboxPolicyExpanded = expandPolicyWithPluginGroups(sandbox?.tools, pluginGroups);
  const subagentPolicyExpanded = expandPolicyWithPluginGroups(subagentPolicy, pluginGroups);

  const toolsFiltered = profilePolicyExpanded
    ? filterToolsByPolicy(tools, profilePolicyExpanded)
    : tools;
  const providerProfileFiltered = providerProfileExpanded
    ? filterToolsByPolicy(toolsFiltered, providerProfileExpanded)
    : toolsFiltered;
  const globalFiltered = globalPolicyExpanded
    ? filterToolsByPolicy(providerProfileFiltered, globalPolicyExpanded)
    : providerProfileFiltered;
  const globalProviderFiltered = globalProviderExpanded
    ? filterToolsByPolicy(globalFiltered, globalProviderExpanded)
    : globalFiltered;
  const agentFiltered =
    !launchPanelBrowserSession && agentPolicyExpanded
      ? filterToolsByPolicy(globalProviderFiltered, agentPolicyExpanded)
      : globalProviderFiltered;
  const agentProviderFiltered = agentProviderExpanded
    ? filterToolsByPolicy(agentFiltered, agentProviderExpanded)
    : agentFiltered;
  const groupFiltered = groupPolicyExpanded
    ? filterToolsByPolicy(agentProviderFiltered, groupPolicyExpanded)
    : agentProviderFiltered;
  const sandboxed = sandboxPolicyExpanded
    ? filterToolsByPolicy(groupFiltered, sandboxPolicyExpanded)
    : groupFiltered;
  const subagentFiltered = subagentPolicyExpanded
    ? filterToolsByPolicy(sandboxed, subagentPolicyExpanded)
    : sandboxed;
  const trustHardened = applyTurnTrustToTools({
    tools: subagentFiltered,
    trust,
    config: options?.config,
  });
  // Always normalize tool JSON Schemas before handing them to pi-agent/pi-ai.
  // Without this, some providers (notably OpenAI) will reject root-level union schemas.
  const normalized = trustHardened.map(normalizeToolParameters);

  // Live Action Mode filter — when the voice-chat sidebar is engaged the
  // agent's tool calls drive the running InfiniBot UI via `ui_control`.
  // We must NOT leave the `browser` tool or shell tools that can launch a
  // browser exposed: the model has a strong prior on URL navigation and
  // will pick whichever tool reads as "open a page" if given the choice.
  //
  // The flag is keyed by sessionKey (set in the voice stream handler).
  // Keying by sessionKey rather than ALS is deliberate: this code runs
  // after the command-queue boundary in pi-embedded-runner, which would
  // drop an ALS context. A Map keyed by sessionKey survives the boundary.
  const liveActionOn = isLiveActionActive(options?.sessionKey);
  // Browser binaries the model commonly reaches for. Used for word-boundary
  // checks against shell command strings and standalone-token checks against
  // hyprland_launch's `path` / `desktopEntry` / `args`.
  const BROWSER_BIN_RE =
    /(^|[\s;&|`(])(firefox|firefox-esr|chromium|chromium-browser|google-chrome|chrome|microsoft-edge|edge|safari|xdg-open|open|start|brave-browser|brave|epiphany|gnome-web|falkon|vivaldi|opera)(\s|$)/i;
  const BROWSER_DESKTOP_RE =
    /^(firefox|firefox-esr|chromium|chromium-browser|google-chrome|chrome|microsoft-edge|edge|brave-browser|brave|vivaldi|opera|epiphany|gnome-web|falkon|org\.mozilla\.firefox|org\.chromium\.Chromium|com\.google\.Chrome|com\.brave\.Browser|com\.microsoft\.Edge|com\.vivaldi\.Vivaldi)(\.desktop)?$/i;
  const URL_LIKE_RE = /(https?:\/\/|localhost[:/]|127\.0\.0\.1|0\.0\.0\.0)/i;
  const liveActionRefusal = {
    ok: false,
    error:
      "Refused: Live Action Mode is on — do not launch a browser. Use the `ui_control` tool (action='list_views' then action='dispatch') to drive the InfiniBot UI the user is already watching.",
  };
  const liveActionFiltered = liveActionOn
    ? normalized.flatMap((tool) => {
        const name = (tool as { name?: string }).name ?? "";
        // Drop browser-named tools outright (the InfiniBot Browser Relay
        // tool, plus any MCP plugin that registers under a browser-shaped
        // namespace — browsermcp, browser.*, etc.).
        if (name === "browser" || /^browser[._-]/i.test(name) || /^browsermcp/i.test(name)) {
          return [];
        }
        // Wrap exec/process so the model can't launch a browser binary via
        // the shell ("firefox http://...", "xdg-open <url>", etc.). The
        // wrapper intercepts the command string and returns an error
        // result steering the agent toward ui_control. The tools stay
        // available for legitimate uses.
        if (name === "exec" || name === "process") {
          const orig = (tool as { execute?: (...args: unknown[]) => Promise<unknown> }).execute;
          if (typeof orig !== "function") return [tool];
          const wrapped = {
            ...tool,
            execute: (toolCallId: string, args: unknown, ...rest: unknown[]) => {
              const cmd = String((args as { command?: unknown })?.command ?? "").trim();
              if (BROWSER_BIN_RE.test(cmd) && URL_LIKE_RE.test(cmd)) {
                return Promise.resolve(liveActionRefusal);
              }
              return (orig as (...a: unknown[]) => Promise<unknown>).call(
                tool,
                toolCallId,
                args,
                ...rest,
              );
            },
          };
          return [wrapped as typeof tool];
        }
        // Wrap the generic `mcp` tool: when the model can't reach `browser`
        // directly it pivots to `mcp invoke { mcp: "playwright"|"browsermcp",
        // tool: "browser_navigate", args: { url } }`. That route bypassed
        // every other guard. Refuse invokes that target a browser-shaped
        // MCP server, or any tool name shaped like a navigation call paired
        // with a URL arg. `list`/`tools`/`status` actions stay open so the
        // agent can still introspect.
        const BROWSER_MCP_RE =
          /(^|[._-])(browser|browsermcp|browser-use|playwright|puppeteer|chromedp|webdriver|selenium)([._-]|$)/i;
        const BROWSER_TOOL_RE = /^(browser[._-]?\w*|navigate|open[._-]?url|goto|page[._-]?goto)$/i;
        if (name === "mcp") {
          const orig = (tool as { execute?: (...args: unknown[]) => Promise<unknown> }).execute;
          if (typeof orig !== "function") return [tool];
          const wrapped = {
            ...tool,
            execute: (toolCallId: string, args: unknown, ...rest: unknown[]) => {
              const a = (args ?? {}) as {
                action?: unknown;
                mcp?: unknown;
                tool?: unknown;
                args?: unknown;
              };
              const action = typeof a.action === "string" ? a.action : "";
              const mcpName = typeof a.mcp === "string" ? a.mcp : "";
              const toolName = typeof a.tool === "string" ? a.tool : "";
              const innerArgs = (a.args ?? {}) as Record<string, unknown>;
              const innerUrl = typeof innerArgs.url === "string" ? innerArgs.url : "";
              if (action === "invoke") {
                const mcpLooksBrowser = !!mcpName && BROWSER_MCP_RE.test(mcpName);
                const toolLooksNav = !!toolName && BROWSER_TOOL_RE.test(toolName);
                const argLooksUrl = !!innerUrl && URL_LIKE_RE.test(innerUrl);
                if (mcpLooksBrowser || (toolLooksNav && argLooksUrl)) {
                  return Promise.resolve(liveActionRefusal);
                }
              }
              return (orig as (...a: unknown[]) => Promise<unknown>).call(
                tool,
                toolCallId,
                args,
                ...rest,
              );
            },
          };
          return [wrapped as typeof tool];
        }
        // Plugin/MCP tools registered directly under namespaced names (e.g.
        // `mcp__playwright__browser_navigate`, `playwright_browser_navigate`).
        // Drop the whole tool — there's no legitimate non-browser use under
        // these prefixes during a Live Action turn.
        if (
          BROWSER_MCP_RE.test(name) ||
          /(?:^|__|\.)playwright(?:__|\.|_)/i.test(name) ||
          /(?:^|__|\.)browsermcp(?:__|\.|_)/i.test(name) ||
          /(?:^|__|\.)browser[._-]?use(?:__|\.|_)/i.test(name)
        ) {
          return [];
        }
        // Wrap hyprland_launch (and any MCP-namespaced variant) the same
        // way: this tool can spawn arbitrary binaries or `.desktop` entries,
        // so without this guard the model can sidestep the exec block by
        // saying "launch firefox at <url>" via hyprland_launch instead.
        if (name === "hyprland_launch" || /(?:^|__)hyprland_launch$/i.test(name)) {
          const orig = (tool as { execute?: (...args: unknown[]) => Promise<unknown> }).execute;
          if (typeof orig !== "function") return [tool];
          const wrapped = {
            ...tool,
            execute: (toolCallId: string, args: unknown, ...rest: unknown[]) => {
              const a = (args ?? {}) as {
                mode?: unknown;
                path?: unknown;
                desktopEntry?: unknown;
                args?: unknown;
              };
              const path = typeof a.path === "string" ? a.path.trim() : "";
              const desktopEntry = typeof a.desktopEntry === "string" ? a.desktopEntry.trim() : "";
              const extraArgs = typeof a.args === "string" ? a.args : "";
              const pathFirstToken = path.split(/\s+/)[0] ?? "";
              const pathLooksLikeBrowser =
                !!pathFirstToken && BROWSER_DESKTOP_RE.test(pathFirstToken.replace(/.*\//, ""));
              const desktopLooksLikeBrowser =
                !!desktopEntry && BROWSER_DESKTOP_RE.test(desktopEntry);
              const argsHaveUrl = URL_LIKE_RE.test(`${path} ${extraArgs}`);
              const execHasBrowserBin = BROWSER_BIN_RE.test(`${path} ${extraArgs}`) && argsHaveUrl;
              if (pathLooksLikeBrowser || desktopLooksLikeBrowser || execHasBrowserBin) {
                return Promise.resolve(liveActionRefusal);
              }
              return (orig as (...a: unknown[]) => Promise<unknown>).call(
                tool,
                toolCallId,
                args,
                ...rest,
              );
            },
          };
          return [wrapped as typeof tool];
        }
        return [tool];
      })
    : normalized;

  // Secure Mode — a secure-lane session only ever sees the local-only
  // allowlist (plus the encrypted secure_lane tool, which normal sessions
  // never get). Network, messaging, coder, MCP and plugin tools are dropped.
  const secureFiltered = isSecureSessionKey(options?.sessionKey)
    ? filterToolsForSecureSession(
        [
          ...liveActionFiltered,
          normalizeToolParameters(createSecureLaneTool()),
          // Sanitized, owner-approved web research (local SearXNG + local models).
          ...(options?.config?.secureMode?.research?.enabled === false
            ? []
            : [
                normalizeToolParameters(
                  createSecureResearchTool({
                    sessionKey: options?.sessionKey,
                    config: options?.config,
                  }),
                ),
              ]),
        ],
        options?.sessionKey,
        options?.config,
      )
    : liveActionFiltered;

  const purposeFiltered = launchPanelBrowserSession
    ? secureFiltered.filter((tool) =>
        ["browser", "request_approval", "wait_approval"].includes(tool.name),
      )
    : secureFiltered;

  const withAbort = options?.abortSignal
    ? purposeFiltered.map((tool) => wrapToolWithAbortSignal(tool, options.abortSignal))
    : purposeFiltered;

  // Every tool gets a deadline: a tool promise that never settles must not
  // wedge the turn (and the session lane) until the 20-min turn timeout.
  const withTimeout = withAbort.map((tool) =>
    wrapToolWithExecutionTimeout(tool, { timeoutMs: options?.toolTimeoutMs }),
  );

  // Cap every tool's result text before it can enter the transcript. Without
  // this a single oversized result (e.g. kanban list_projects returning every
  // project as a full object) can exceed the context window on its own and
  // permanently wedge the session with "prompt too long" on every later turn.
  const capped = withTimeout.map((tool) =>
    wrapToolWithResultCap(tool, options?.toolResultMaxChars),
  );

  // NOTE: Keep canonical (lowercase) tool names here.
  // pi-ai's Anthropic OAuth transport remaps tool names to Claude Code-style names
  // on the wire and maps them back for tool dispatch.
  return capped;
}
