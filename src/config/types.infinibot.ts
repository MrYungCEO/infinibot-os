import type { AgentBinding, AgentCoderBackend, AgentsConfig } from "./types.agents.js";
import type { LocalRuntimesConfig } from "./types.local-runtimes.js";
import type { ApprovalsConfig } from "./types.approvals.js";
import type { AuthConfig } from "./types.auth.js";
import type { DiagnosticsConfig, LoggingConfig, SessionConfig, WebConfig } from "./types.base.js";
import type { BrowserConfig } from "./types.browser.js";
import type { ChannelsConfig } from "./types.channels.js";
import type { CronConfig } from "./types.cron.js";
import type {
  CanvasHostConfig,
  DiscoveryConfig,
  GatewayConfig,
  TalkConfig,
} from "./types.gateway.js";
import type { FederationConfig } from "../federation/types.js";
import type { HooksConfig } from "./types.hooks.js";
import type {
  AudioConfig,
  BroadcastConfig,
  CommandsConfig,
  MessagesConfig,
} from "./types.messages.js";
import type { ModelsConfig } from "./types.models.js";
import type { NodeHostConfig } from "./types.node-host.js";
import type { PluginsConfig } from "./types.plugins.js";
import type { SkillsConfig } from "./types.skills.js";
import type { ToolsConfig } from "./types.tools.js";

export type InfinibotConfig = {
  meta?: {
    /** Last infinibot version that wrote this config. */
    lastTouchedVersion?: string;
    /** ISO timestamp when this config was last written. */
    lastTouchedAt?: string;
  };
  auth?: AuthConfig;
  env?: {
    /** Opt-in: import missing secrets from a login shell environment (exec `$SHELL -l -c 'env -0'`). */
    shellEnv?: {
      enabled?: boolean;
      /** Timeout for the login shell exec (ms). Default: 15000. */
      timeoutMs?: number;
    };
    /** Inline env vars to apply when not already present in the process env. */
    vars?: Record<string, string>;
    /** Sugar: allow env vars directly under env (string values only). */
    [key: string]:
      | string
      | Record<string, string>
      | { enabled?: boolean; timeoutMs?: number }
      | undefined;
  };
  wizard?: {
    lastRunAt?: string;
    lastRunVersion?: string;
    lastRunCommit?: string;
    lastRunCommand?: string;
    lastRunMode?: "local" | "remote";
  };
  diagnostics?: DiagnosticsConfig;
  logging?: LoggingConfig;
  update?: {
    /** Update channel for git + npm installs ("stable", "beta", or "dev"). */
    channel?: "stable" | "beta" | "dev";
    /** Check for updates on gateway start (npm installs only). */
    checkOnStart?: boolean;
    /** Auto-update configuration */
    auto?: {
      /** Enable automatic update checking and optional auto-apply. Default: false */
      enabled?: boolean;
      /** Check interval in minutes. Default: 360 (6 hours). Minimum: 15 */
      intervalMinutes?: number;
      /** Automatically apply updates when found. Default: false */
      autoApply?: boolean;
      /** Quiet hours - don't auto-apply during these times */
      quietHours?: {
        enabled?: boolean;
        /** Start hour (0-23). Default: 2 */
        start?: number;
        /** End hour (0-23). Default: 6 */
        end?: number;
      };
      /** Notification settings */
      notifications?: {
        /** Notify on update available */
        onAvailable?: boolean;
        /** Notify before auto-applying */
        onBeforeApply?: boolean;
        /** Notify after update applied */
        onApplied?: boolean;
        /** Notify on update failure */
        onFailure?: boolean;
        /** Session key to notify */
        targetSession?: string;
      };
      /** Delay after update check before applying (seconds). Default: 30 */
      applyDelaySeconds?: number;
      /** Max consecutive failures before backing off. Default: 3 */
      maxConsecutiveFailures?: number;
      /** Backoff multiplier after failures. Default: 2 */
      backoffMultiplier?: number;
      /** Max backoff interval in minutes. Default: 1440 (24 hours) */
      maxBackoffMinutes?: number;
    };
  };
  browser?: BrowserConfig;
  ui?: {
    /** Accent color for InfiniBot UI chrome (hex). */
    seamColor?: string;
    assistant?: {
      /** Assistant display name for UI surfaces. */
      name?: string;
      /** Assistant avatar (emoji, short text, or image URL/data URI). */
      avatar?: string;
    };
    /** Glass-HUD theme tokens + mode selection. */
    theme?: {
      /** system | dark | light | hud */
      mode?: "system" | "dark" | "light" | "hud";
      /** Currently selected palette id (or "custom"). */
      paletteId?: string;
      /** Animated background style. Default "gradient". */
      background?:
        | "none"
        | "gradient"
        | "aurora"
        | "faulty-terminal"
        | "grainient"
        | "dither"
        | "iridescence"
        | "liquid-chrome"
        | "lightning"
        | "beams"
        | "silk"
        | "waves"
        | "hyperspeed"
        | "threads"
        | "particles"
        | "metaballs"
        | "orb"
        | "balatro"
        | "letter-glitch"
        | "squares"
        | "dot-grid";
      /** Raw token overrides — applied on top of the resolved mode. */
      tokens?: {
        primary?: string;
        accent?: string;
        surfaceTint?: string;
        bg?: string;
        fg?: string;
        blur?: number;
        blurHeavy?: number;
        radius?: number;
        surfaceAlpha?: number;
        shadowDepth?: number;
        fontFamily?: string;
      };
    };
    /** App-level branding: name, tagline, logo. Surfaces on gate + app shell. */
    branding?: {
      /** Product name displayed in UI (default "InfiniBot"). */
      appName?: string;
      /** Optional tagline displayed under the name. */
      tagline?: string;
      /** Served URL for the logo (e.g. "/branding/logo.png"). */
      logoUrl?: string;
      /** Inline data URL fallback when no file is hosted. */
      logoDataUrl?: string;
      /** Favicon override. */
      faviconUrl?: string;
    };
  };
  skills?: SkillsConfig;
  plugins?: PluginsConfig;
  models?: ModelsConfig;
  /**
   * Secure Mode: an isolated, encrypted, local-models-only lane. The on/off
   * switch itself lives in gateway state (secure.set), not in config; these
   * are the owner's policy knobs.
   */
  /** On-demand local model runtimes sharing the GPU (vLLM unit, Ollama). */
  localRuntimes?: LocalRuntimesConfig;
  secureMode?: {
    /**
     * Model servers on OTHER machines the owner trusts for secure runs (e.g. a
     * tailnet GPU box). Exact hostnames or IPs. Loopback and every address
     * bound to this machine's interfaces (docker0, tailscale0, LAN) are local
     * without being listed.
     */
    allowedModelHosts?: string[];
    /** Older name for allowedModelHosts; both are honoured. */
    localHosts?: string[];
    /**
     * "provider/model" a secure run moves to when the agent's own model is
     * remote. Must be served locally; unset = the best installed local model.
     */
    defaultModel?: string;
    /**
     * Extra tools the owner explicitly allows in secure runs on top of the
     * local-only allowlist (e.g. "write"). Network tools stay blocked.
     */
    allowTools?: string[];
    /**
     * Secure research (`secure_research` tool): sanitized web search through a
     * local SearXNG + hardened page fetches, read by local models only.
     * See docs/security/secure-mode.md.
     */
    research?: {
      /** Default true. false removes the tool from secure runs. */
      enabled?: boolean;
      /** "ask" (default): the owner approves each batch in chat. "auto-sanitized": send when the sanitizer passes (still logged). */
      approval?: "ask" | "auto-sanitized";
      /** Local SearXNG base URL (default http://127.0.0.1:8888). Must be on this machine. */
      searxngUrl?: string;
      /** Page-fetch proxy: socks5://127.0.0.1:9050 (Tor) or http(s)://host:port. */
      proxy?: string;
      /** Local model for planning/reading ("provider/model"); default = the secure default model. */
      model?: string;
      maxQueries?: number;
      pagesPerQuery?: number;
      maxPages?: number;
      fetchTimeoutMs?: number;
      maxPageBytes?: number;
      approvalTimeoutSec?: number;
      /** Extra words that must never leave the machine (names, places, ids). */
      sensitiveTerms?: string[];
    };
  };
  nodeHost?: NodeHostConfig;
  agents?: AgentsConfig;
  tools?: ToolsConfig;
  bindings?: AgentBinding[];
  broadcast?: BroadcastConfig;
  audio?: AudioConfig;
  messages?: MessagesConfig;
  commands?: CommandsConfig;
  approvals?: ApprovalsConfig;
  session?: SessionConfig;
  web?: WebConfig;
  channels?: ChannelsConfig;
  cron?: CronConfig;
  hooks?: HooksConfig;
  discovery?: DiscoveryConfig;
  canvasHost?: CanvasHostConfig;
  talk?: TalkConfig;
  gateway?: GatewayConfig;
  federation?: FederationConfig;
  autonomy?: AutonomyConfig;
  /** Verified completion — judge model for reviews (see src/autonomy/judge-models.ts). */
  verification?: {
    /** `provider/model` that reviews runs; bare ids mean Anthropic. */
    judgeModel?: string;
    judgeFallbacks?: string[];
    /** Per-attempt API timeout (CLI judges get at least 180s). */
    judgeTimeoutMs?: number;
  };
  /**
   * Gateway-native build conductors. Each is OFF by default; the conductor does
   * nothing (no reads, no spawns, no Telegram) unless explicitly enabled here or
   * via its env var. See src/agency/build-conductor.ts.
   */
  conductor?: {
    /** Optional milestone-gated build conductor. */
    fh12?: {
      /** Master switch. Default false. Also enable-able via INFINIBOT_FH12_CONDUCTOR=1. */
      enabled?: boolean;
      /** Project directory. Required when the conductor is enabled. */
      projectDir?: string;
      /** Tick cadence in ms. Default 600000 (10 min). Floored at 60000. */
      intervalMs?: number;
    };
  };
  integrations?: {
    calendar?: {
      clientId?: string;
      clientSecret?: string;
      refreshToken?: string;
    };
    ollama?: {
      /** Ollama server URL. Default: http://127.0.0.1:11434 */
      host?: string;
      /** Polling interval in milliseconds. Default: 5000 */
      pollIntervalMs?: number;
      /** Auto-start polling on gateway start. Default: false */
      autoStartPolling?: boolean;
    };
    contentIntel?: {
      /** Existing reel-pipeline directory. External video operations are disabled when unset. */
      pipelineDir?: string;
      /** Optional Python virtual environment for content-intelligence helpers. */
      venvPath?: string;
    };
    /**
     * Multi-account Gmail. The legacy single-account credentials still live
     * under `calendar.*` (and are registered as the "default" account); this
     * block lets the user wire up additional accounts that the Emails page
     * surfaces as switcher pills.
     */
    gmail?: {
      /** ID of the account to use when no `accountId` is supplied on a call. */
      defaultAccountId?: string;
      accounts?: Array<{
        id: string;
        email?: string;
        clientId: string;
        clientSecret: string;
        refreshToken: string;
      }>;
    };
  };
  /**
   * Loops.so integration — email marketing + transactional via the
   * `loops` agent tool, gateway methods, and the Email Marketing UI tab.
   */
  loops?: {
    apiKey?: string;
    webhookSecret?: string;
    autoSyncMinutes?: number;
    defaultUserGroup?: string;
  };
  /**
   * Netlify — personal access token + reusable site-id map. Used by the
   * Lead-Qualifier form builder to deploy a public copy of each form
   * while the submission endpoint stays on the user's local gateway.
   */
  netlify?: {
    accessToken?: string;
    apiBaseUrl?: string;
    formSites?: Record<string, string>;
  };
  /**
   * Internal MCP servers — same shape as Claude Code's `mcpServers` block in
   * `~/.claude.json`. Mirrored into Claude Code via `mcp.internal.sync` so any
   * server declared here can be used directly by Claude Coder/Claude Code.
   */
  mcpServers?: Record<string, McpServerEntry>;
  /**
   * Run gateway agents' chat through the user's logged-in CLI coding agents
   * (Claude Code, Codex, Gemini CLI, Grok Build, OpenCode) — their
   * subscriptions — instead of API keys. Off by default. Per-agent override:
   * `agents.list[].cliRouting`. See docs/cli-routing.md.
   */
  cliRoutingEnabled?: boolean;
  cliRouting?: CliRoutingConfig;
  onboarding?: {
    /** True once the wizard has been finalized. */
    completed?: boolean;
    /** Epoch ms when finalize ran. */
    completedAt?: number;
    /** Which path completed onboarding ("quickstart-web", "onboard-tui", etc). */
    via?: string;
  };
  /**
   * Coding agent backend selection. Defaults to "claude-code".
   * Set to "opencode" to route all claude_coder spawns through the OpenCode CLI.
   * See docs/research/opencode-vs-claude-code.md for capability matrix.
   */
  coder?: {
    /**
     * Which CLI backend to use for claude_coder spawns.
     * "claude-code" (default) — Anthropic's Claude Code CLI.
     * "opencode"              — OpenCode open-source coding agent (github.com/sst/opencode).
     * "codex" / "gemini"      — OpenAI Codex CLI / Google Gemini CLI.
     * "grok"                  — xAI Grok Build CLI (same set as
     *                           the coder backend registry and Setup › Coders).
     */
    backend?: AgentCoderBackend;
    /**
     * Per-backend model defaults for coding agent spawns.
     * OpenCode expects provider/model format, for example "openrouter/deepseek/deepseek-v4-flash:free".
     */
    models?: {
      opencode?: string;
    };
  };
  /**
   * Claude Code CLI agent runtime settings. Controls the skill+memory injection
   * system that makes every claude_coder spawn a first-class InfiniBot extension.
   */
  /** Outbound notification behaviour shared by every Telegram sender. */
  notifications?: {
    telegram?: {
      /**
       * Attach a run's verification screenshots (result-shots + visual_verify
       * captures) as a media group under its Telegram completion / verdict
       * message. Never applies to Secure Mode runs. Default: true.
       */
      attachVerificationScreenshots?: boolean;
      /** Most screenshots attached per message (1-10). Default: 6. */
      maxVerificationScreenshots?: number;
    };
  };
  claudeCoder?: {
    skillSystem?: {
      /**
       * Enable automatic skill index injection, memory guidance, post-mortem
       * analysis on failure, and reflection on substantial success.
       * Default: true. Set to false to disable the entire integration.
       */
      enabled?: boolean;
    };
  };
  notion?: {
    apiKey?: string;
    syncMode?: "off" | "mirror" | "import-once";
    projectsDbId?: string;
    tasksDbId?: string;
    parentPageId?: string;
    integrationName?: string;
    /** Notion database ids for the InfiniBot CRM system. */
    clientsDbId?: string;
    leadsDbId?: string;
    companiesDbId?: string;
    dealsDbId?: string;
    contactsDbId?: string;
    /** Optional database used when income entries are mirrored to Notion. */
    incomeStreamsDbId?: string;
  };
  /**
   * Workload-tracking feature — auto-logs agent runs, kanban completions,
   * workflow runs, and voice sessions to ~/.infinibot/work-activity/.
   * Surfaced on the Discipline page as the "Auto-logged" lane.
   */
  workloadTracking?: {
    /** Whether to emit work events at all. Default: true. */
    enabled?: boolean;
    /** Minimum events per day to count toward the streak. Default: 5. */
    streakMinEvents?: number;
  };
  /**
   * Voice stack endpoint overrides. Optional — when absent the voice
   * handlers fall back to KOKORO_URL/SPEACHES_URL/LIVEKIT_URL env vars,
   * then to localhost defaults (8882/8002/7882).
   *
   * Populated automatically on satellite nodes when they connect to a
   * master: URLs are derived from the master hostname so satellite voice
   * features point at master's containers without manual config.
   */
  voice?: {
    kokoroUrl?: string;
    speachesUrl?: string;
    livekitUrl?: string;
    livekitUrlExternal?: string;
    autoFromMaster?: boolean;
    masterHost?: string;
    /** Optional legacy Robovoice HTTP backend. The proxy is disabled when unset. */
    robovoiceUrl?: string;
    /**
     * Which voice provider serves voice: "auto" (default — the first loaded
     * voice-provider plugin, else the built-in "local"), or a provider id.
     */
    backend?: string;
    /**
     * Unified voice-setup selection (written by the onboarding wizard, the
     * browser setup-ui Voice step, and `infinibot voice doctor`). Two
     * clearly-differentiated paths:
     *   - "cloud"  — managed providers (OpenAI STT + OpenAI/ElevenLabs/Edge TTS).
     *   - "native" — local models (Kokoro/Piper TTS + local Whisper STT).
     * Validated by `VoiceSetupSchema` in `src/voice/schema.ts`.
     */
    provider?: "cloud" | "native";
    cloud?: {
      stt?: "openai";
      tts?: "openai" | "elevenlabs" | "edge";
      apiKey?: string;
      ttsVoice?: string;
      ttsModel?: string;
    };
    native?: {
      tts?: "kokoro" | "piper";
      ttsVoice?: string;
      sttModel?: string;
      wakeWord?: boolean;
    };
    /** Cross-backend fallback behaviour when the primary path fails. */
    fallback?: "cloud-to-native" | "native-to-cloud" | "off";
  };
};

/**
 * Default backend used by the goal-mode autonomy orchestrator. Per-goal
 * overrides are accepted via `autonomy:queue.add { backend }`. The shape
 * mirrors `AutonomyBackend` in src/autonomy/types.ts.
 */
export type AutonomyBackendConfig =
  | { kind: "claude"; profileId?: string }
  | { kind: "opencode" }
  | { kind: "codex" }
  | { kind: "grok" }
  | { kind: "gateway-agent"; agentId: string };

export type AutonomyConfig = {
  /** Default backend for new goals when the caller does not specify one.
   *  Falls back to `{ kind: "claude" }` when unset. */
  defaultBackend?: AutonomyBackendConfig;
};

export type McpServerEntry = {
  /** Transport type. Defaults to "stdio". */
  type?: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  description?: string;
  enabled?: boolean;
  /** When true, register this server in Claude Code on sync. Default: true. */
  syncToClaudeCode?: boolean;
};

export type ConfigValidationIssue = {
  path: string;
  message: string;
};

export type LegacyConfigIssue = {
  path: string;
  message: string;
};

export type ConfigFileSnapshot = {
  path: string;
  exists: boolean;
  raw: string | null;
  parsed: unknown;
  valid: boolean;
  config: InfinibotConfig;
  hash?: string;
  issues: ConfigValidationIssue[];
  warnings: ConfigValidationIssue[];
  legacyIssues: LegacyConfigIssue[];
};

export type CliRoutingConfig = {
  /**
   * CLI providers to try, in order; the next one is the fallback when a run
   * fails (usage limit, signed out, timeout). Only installed CLIs are used.
   * Default: ["claude-cli", "codex-cli", "gemini-cli", "grok-cli", "opencode-cli"].
   */
  providers?: string[];
  /** Model per provider, e.g. { "claude-cli": "sonnet", "codex-cli": "gpt-5.5" }. */
  models?: Record<string, string>;
  /** After every CLI fails, try the agent's normal (API) model. Default false. */
  fallbackToApi?: boolean;
  /** Give the CLI InfiniBot's tools (memory, kanban, …) through the infinibot MCP server. Default true. */
  tools?: boolean;
  /**
   * With cliRoutingEnabled: route ALL gateway traffic through the CLIs — every
   * agent (local-model agents and per-agent opt-outs included) and every run
   * pinned to an API model (sub-agent / cron / heartbeat / voice brain / a
   * chat's picked model). Runs already on a CLI keep it; Secure Mode sessions
   * stay local. Default false.
   */
  allTraffic?: boolean;
};
