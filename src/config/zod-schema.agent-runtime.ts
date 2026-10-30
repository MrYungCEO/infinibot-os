import { z } from "zod";

import { parseDurationMs } from "../cli/parse-duration.js";
import {
  GroupChatSchema,
  HumanDelaySchema,
  IdentitySchema,
  ToolsLinksSchema,
  ToolsMediaSchema,
} from "./zod-schema.core.js";

export const HeartbeatSchema = z
  .object({
    every: z.string().optional(),
    activeHours: z
      .object({
        start: z.string().optional(),
        end: z.string().optional(),
        timezone: z.string().optional(),
      })
      .strict()
      .optional(),
    model: z.string().optional(),
    session: z.string().optional(),
    includeReasoning: z.boolean().optional(),
    target: z.string().optional(),
    to: z.string().optional(),
    prompt: z.string().optional(),
    ackMaxChars: z.number().int().nonnegative().optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (!val.every) return;
    try {
      parseDurationMs(val.every, { defaultUnit: "m" });
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["every"],
        message: "invalid duration (use ms, s, m, h)",
      });
    }

    const active = val.activeHours;
    if (!active) return;
    const timePattern = /^([01]\d|2[0-3]|24):([0-5]\d)$/;
    const validateTime = (raw: string | undefined, opts: { allow24: boolean }, path: string) => {
      if (!raw) return;
      if (!timePattern.test(raw)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["activeHours", path],
          message: 'invalid time (use "HH:MM" 24h format)',
        });
        return;
      }
      const [hourStr, minuteStr] = raw.split(":");
      const hour = Number(hourStr);
      const minute = Number(minuteStr);
      if (hour === 24 && minute !== 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["activeHours", path],
          message: "invalid time (24:00 is the only allowed 24:xx value)",
        });
        return;
      }
      if (hour === 24 && !opts.allow24) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["activeHours", path],
          message: "invalid time (start cannot be 24:00)",
        });
      }
    };

    validateTime(active.start, { allow24: false }, "start");
    validateTime(active.end, { allow24: true }, "end");
  })
  .optional();

export const SandboxDockerSchema = z
  .object({
    image: z.string().optional(),
    containerPrefix: z.string().optional(),
    workdir: z.string().optional(),
    readOnlyRoot: z.boolean().optional(),
    tmpfs: z.array(z.string()).optional(),
    network: z.string().optional(),
    user: z.string().optional(),
    capDrop: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    setupCommand: z.string().optional(),
    pidsLimit: z.number().int().positive().optional(),
    memory: z.union([z.string(), z.number()]).optional(),
    memorySwap: z.union([z.string(), z.number()]).optional(),
    cpus: z.number().positive().optional(),
    ulimits: z
      .record(
        z.string(),
        z.union([
          z.string(),
          z.number(),
          z
            .object({
              soft: z.number().int().nonnegative().optional(),
              hard: z.number().int().nonnegative().optional(),
            })
            .strict(),
        ]),
      )
      .optional(),
    seccompProfile: z.string().optional(),
    apparmorProfile: z.string().optional(),
    dns: z.array(z.string()).optional(),
    extraHosts: z.array(z.string()).optional(),
    binds: z.array(z.string()).optional(),
  })
  .strict()
  .optional();

export const SandboxBrowserSchema = z
  .object({
    enabled: z.boolean().optional(),
    image: z.string().optional(),
    containerPrefix: z.string().optional(),
    cdpPort: z.number().int().positive().optional(),
    vncPort: z.number().int().positive().optional(),
    noVncPort: z.number().int().positive().optional(),
    headless: z.boolean().optional(),
    enableNoVnc: z.boolean().optional(),
    allowHostControl: z.boolean().optional(),
    autoStart: z.boolean().optional(),
    autoStartTimeoutMs: z.number().int().positive().optional(),
  })
  .strict()
  .optional();

export const SandboxPruneSchema = z
  .object({
    idleHours: z.number().int().nonnegative().optional(),
    maxAgeDays: z.number().int().nonnegative().optional(),
  })
  .strict()
  .optional();

const ToolPolicyBaseSchema = z
  .object({
    allow: z.array(z.string()).optional(),
    alsoAllow: z.array(z.string()).optional(),
    deny: z.array(z.string()).optional(),
  })
  .strict();

export const ToolPolicySchema = ToolPolicyBaseSchema.superRefine((value, ctx) => {
  if (value.allow && value.allow.length > 0 && value.alsoAllow && value.alsoAllow.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "tools policy cannot set both allow and alsoAllow in the same scope (merge alsoAllow into allow, or remove allow and use profile + alsoAllow)",
    });
  }
}).optional();

export const ToolsWebSearchSchema = z
  .object({
    enabled: z.boolean().optional(),
    provider: z
      .union([
        z.literal("brave"),
        z.literal("perplexity"),
        z.literal("keyless"),
        z.literal("duckduckgo"),
        z.literal("searxng"),
      ])
      .optional(),
    apiKey: z.string().optional(),
    maxResults: z.number().int().positive().optional(),
    timeoutSeconds: z.number().int().positive().optional(),
    cacheTtlMinutes: z.number().nonnegative().optional(),
    searxngUrl: z.string().url().optional(),
    perplexity: z
      .object({
        apiKey: z.string().optional(),
        baseUrl: z.string().optional(),
        model: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .optional();

export const ToolsWebFetchSchema = z
  .object({
    enabled: z.boolean().optional(),
    maxChars: z.number().int().positive().optional(),
    timeoutSeconds: z.number().int().positive().optional(),
    cacheTtlMinutes: z.number().nonnegative().optional(),
    maxRedirects: z.number().int().nonnegative().optional(),
    userAgent: z.string().optional(),
    /** Readability main-content extraction (default true) — src/agents/tools/web-fetch.ts. */
    readability: z.boolean().optional(),
    /** Firecrawl fallback for web_fetch — src/agents/tools/web-fetch.ts. */
    firecrawl: z
      .object({
        enabled: z.boolean().optional(),
        apiKey: z.string().optional(),
        baseUrl: z.string().optional(),
        onlyMainContent: z.boolean().optional(),
        maxAgeMs: z.number().int().nonnegative().optional(),
        timeoutSeconds: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .optional();

export const ToolsWebSchema = z
  .object({
    search: ToolsWebSearchSchema,
    fetch: ToolsWebFetchSchema,
  })
  .strict()
  .optional();

export const ToolProfileSchema = z
  .union([z.literal("minimal"), z.literal("coding"), z.literal("messaging"), z.literal("full")])
  .optional();

export const ToolPolicyWithProfileSchema = z
  .object({
    allow: z.array(z.string()).optional(),
    alsoAllow: z.array(z.string()).optional(),
    deny: z.array(z.string()).optional(),
    profile: ToolProfileSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.allow && value.allow.length > 0 && value.alsoAllow && value.alsoAllow.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "tools.byProvider policy cannot set both allow and alsoAllow in the same scope (merge alsoAllow into allow, or remove allow and use profile + alsoAllow)",
      });
    }
  });

// Provider docking: allowlists keyed by provider id (no schema updates when adding providers).
export const ElevatedAllowFromSchema = z
  .record(z.string(), z.array(z.union([z.string(), z.number()])))
  .optional();

export const AgentSandboxSchema = z
  .object({
    mode: z.union([z.literal("off"), z.literal("non-main"), z.literal("all")]).optional(),
    workspaceAccess: z.union([z.literal("none"), z.literal("ro"), z.literal("rw")]).optional(),
    sessionToolsVisibility: z.union([z.literal("spawned"), z.literal("all")]).optional(),
    scope: z.union([z.literal("session"), z.literal("agent"), z.literal("shared")]).optional(),
    perSession: z.boolean().optional(),
    workspaceRoot: z.string().optional(),
    docker: SandboxDockerSchema,
    browser: SandboxBrowserSchema,
    prune: SandboxPruneSchema,
  })
  .strict()
  .optional();

export const AgentToolsSchema = z
  .object({
    profile: ToolProfileSchema,
    allow: z.array(z.string()).optional(),
    alsoAllow: z.array(z.string()).optional(),
    deny: z.array(z.string()).optional(),
    byProvider: z.record(z.string(), ToolPolicyWithProfileSchema).optional(),
    elevated: z
      .object({
        enabled: z.boolean().optional(),
        allowFrom: ElevatedAllowFromSchema,
      })
      .strict()
      .optional(),
    exec: z
      .object({
        host: z.enum(["sandbox", "gateway", "node"]).optional(),
        security: z.enum(["deny", "allowlist", "full"]).optional(),
        ask: z.enum(["off", "on-miss", "always"]).optional(),
        node: z.string().optional(),
        pathPrepend: z.array(z.string()).optional(),
        safeBins: z.array(z.string()).optional(),
        backgroundMs: z.number().int().positive().optional(),
        timeoutSec: z.number().int().positive().optional(),
        approvalRunningNoticeMs: z.number().int().nonnegative().optional(),
        cleanupMs: z.number().int().positive().optional(),
        notifyOnExit: z.boolean().optional(),
        untrustedHost: z.enum(["deny", "ask"]).optional(),
        applyPatch: z
          .object({
            enabled: z.boolean().optional(),
            allowModels: z.array(z.string()).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    sandbox: z
      .object({
        tools: ToolPolicySchema,
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.allow && value.allow.length > 0 && value.alsoAllow && value.alsoAllow.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "agent tools cannot set both allow and alsoAllow in the same scope (merge alsoAllow into allow, or remove allow and use profile + alsoAllow)",
      });
    }
  })
  .optional();

export const MemorySearchSchema = z
  .object({
    enabled: z.boolean().optional(),
    sources: z.array(z.union([z.literal("memory"), z.literal("sessions")])).optional(),
    experimental: z
      .object({
        sessionMemory: z.boolean().optional(),
      })
      .strict()
      .optional(),
    provider: z.union([z.literal("openai"), z.literal("local"), z.literal("gemini")]).optional(),
    remote: z
      .object({
        baseUrl: z.string().optional(),
        apiKey: z.string().optional(),
        headers: z.record(z.string(), z.string()).optional(),
        batch: z
          .object({
            enabled: z.boolean().optional(),
            wait: z.boolean().optional(),
            concurrency: z.number().int().positive().optional(),
            pollIntervalMs: z.number().int().nonnegative().optional(),
            timeoutMinutes: z.number().int().positive().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    fallback: z
      .union([z.literal("openai"), z.literal("gemini"), z.literal("local"), z.literal("none")])
      .optional(),
    model: z.string().optional(),
    local: z
      .object({
        modelPath: z.string().optional(),
        modelCacheDir: z.string().optional(),
      })
      .strict()
      .optional(),
    store: z
      .object({
        driver: z.literal("sqlite").optional(),
        path: z.string().optional(),
        vector: z
          .object({
            enabled: z.boolean().optional(),
            extensionPath: z.string().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    chunking: z
      .object({
        tokens: z.number().int().positive().optional(),
        overlap: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
    sync: z
      .object({
        onSessionStart: z.boolean().optional(),
        onSearch: z.boolean().optional(),
        watch: z.boolean().optional(),
        watchDebounceMs: z.number().int().nonnegative().optional(),
        intervalMinutes: z.number().int().nonnegative().optional(),
        sessions: z
          .object({
            deltaBytes: z.number().int().nonnegative().optional(),
            deltaMessages: z.number().int().nonnegative().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    query: z
      .object({
        maxResults: z.number().int().positive().optional(),
        minScore: z.number().min(0).max(1).optional(),
        hybrid: z
          .object({
            enabled: z.boolean().optional(),
            vectorWeight: z.number().min(0).max(1).optional(),
            textWeight: z.number().min(0).max(1).optional(),
            candidateMultiplier: z.number().int().positive().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    cache: z
      .object({
        enabled: z.boolean().optional(),
        maxEntries: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .optional();
export const AgentModelSchema = z.union([
  z.string(),
  z
    .object({
      primary: z.string().optional(),
      fallbacks: z.array(z.string()).optional(),
    })
    .strict(),
]);
export const AgentEntrySchema = z
  .object({
    id: z.string(),
    default: z.boolean().optional(),
    name: z.string().optional(),
    workspace: z.string().optional(),
    agentDir: z.string().optional(),
    model: AgentModelSchema.optional(),
    memorySearch: MemorySearchSchema,
    humanDelay: HumanDelaySchema.optional(),
    heartbeat: HeartbeatSchema,
    identity: IdentitySchema,
    groupChat: GroupChatSchema,
    // Reference to the encrypted per-agent Telegram bot token (vault://… form).
    // The plaintext is never stored in config.
    telegramBotTokenRef: z.string().optional(),
    // Per-agent Telegram bot for the TelegramBotRouter (src/telegram/bot-router.ts).
    telegramBot: z
      .object({
        botToken: z.string().optional(),
        botUsername: z.string().optional(),
        allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
      })
      .strict()
      .optional(),
    // Per-agent CLI coder backend overrides.
    defaultCoderBackend: z.enum(["claude-code", "opencode", "codex", "gemini", "grok"]).optional(),
    fallbackCoderBackend: z.enum(["claude-code", "opencode", "codex", "gemini", "grok"]).optional(),
    subagents: z
      .object({
        allowAgents: z.array(z.string()).optional(),
        model: z
          .union([
            z.string(),
            z
              .object({
                primary: z.string().optional(),
                fallbacks: z.array(z.string()).optional(),
              })
              .strict(),
          ])
          .optional(),
      })
      .strict()
      .optional(),
    sandbox: AgentSandboxSchema,
    tools: AgentToolsSchema,
    // Accept either the canonical `string[]` (list of enabled skill names) or
    // the legacy `{ allow: string[] }` filter shape some older configs still
    // carry. The object form is coerced to its `allow` array so downstream
    // code only ever sees the flat list — keeping existing configs valid
    // without forcing a manual migration.
    skills: z
      .union([
        z.array(z.string()),
        z
          .object({
            allow: z.array(z.string()).optional(),
            deny: z.array(z.string()).optional(),
          })
          .passthrough()
          .transform((v) => (Array.isArray(v.allow) ? v.allow : [])),
      ])
      .optional(),
    enabledMCPs: z.array(z.string()).optional(),
    thinking: z.union([z.boolean(), z.string()]).optional(),
    systemPrompt: z.string().optional(),
    execution: z
      .object({
        mode: z.union([z.literal("agent-loop"), z.literal("terminal")]).optional(),
        cli: z
          .union([
            z.literal("claude"),
            z.literal("opencode"),
            z.literal("gemini"),
            z.literal("codex"),
            z.literal("grok"),
          ])
          .optional(),
        autoClose: z.boolean().optional(),
        autoCloseDelayMs: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
    // Roster-seed metadata + CLI-agent fields written by standard-roster.ts.
    // Why: schema must accept what the seeder writes, otherwise satellites that
    // boot with a seeded config fail validation on startup.
    type: z.union([z.literal("native"), z.literal("cli")]).optional(),
    cliCommand: z.string().optional(),
    // Secure Mode: refuse normal-lane runs for this agent (src/secure-mode/agent-policy.ts).
    secureOnly: z.boolean().optional(),
    cliRouting: z.boolean().optional(),
    autoApprove: z.boolean().optional(),
    _seedVersion: z.string().optional(),
    // Roster default tools already offered to this seed-managed agent, so new
    // defaults can be added later without re-adding ones the operator removed.
    _seedTools: z.array(z.string()).optional(),
    // Owning plugin of a plugin-contributed roster agent (plugins/agent-contributions.ts).
    _plugin: z.string().optional(),
  })
  .strict();

export const ToolsSchema = z
  .object({
    profile: ToolProfileSchema,
    allow: z.array(z.string()).optional(),
    alsoAllow: z.array(z.string()).optional(),
    deny: z.array(z.string()).optional(),
    byProvider: z.record(z.string(), ToolPolicyWithProfileSchema).optional(),
    web: ToolsWebSchema,
    media: ToolsMediaSchema,
    links: ToolsLinksSchema,
    message: z
      .object({
        allowCrossContextSend: z.boolean().optional(),
        crossContext: z
          .object({
            allowWithinProvider: z.boolean().optional(),
            allowAcrossProviders: z.boolean().optional(),
            marker: z
              .object({
                enabled: z.boolean().optional(),
                prefix: z.string().optional(),
                suffix: z.string().optional(),
              })
              .strict()
              .optional(),
          })
          .strict()
          .optional(),
        broadcast: z
          .object({
            enabled: z.boolean().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    agentToAgent: z
      .object({
        enabled: z.boolean().optional(),
        allow: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    elevated: z
      .object({
        enabled: z.boolean().optional(),
        allowFrom: ElevatedAllowFromSchema,
      })
      .strict()
      .optional(),
    exec: z
      .object({
        host: z.enum(["sandbox", "gateway", "node"]).optional(),
        security: z.enum(["deny", "allowlist", "full"]).optional(),
        ask: z.enum(["off", "on-miss", "always"]).optional(),
        node: z.string().optional(),
        pathPrepend: z.array(z.string()).optional(),
        safeBins: z.array(z.string()).optional(),
        backgroundMs: z.number().int().positive().optional(),
        timeoutSec: z.number().int().positive().optional(),
        // Keep in sync with the per-agent exec block above (AgentToolsSchema).
        approvalRunningNoticeMs: z.number().int().nonnegative().optional(),
        cleanupMs: z.number().int().positive().optional(),
        notifyOnExit: z.boolean().optional(),
        untrustedHost: z.enum(["deny", "ask"]).optional(),
        applyPatch: z
          .object({
            enabled: z.boolean().optional(),
            allowModels: z.array(z.string()).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    coder: z
      .object({
        autoApprove: z.enum(["operator", "always", "never"]).optional(),
      })
      .strict()
      .optional(),
    trust: z
      .object({
        owners: z.array(z.string()).optional(),
        nonOwnerSenders: z.enum(["restricted", "trusted"]).optional(),
        untrustedTools: ToolPolicySchema,
      })
      .strict()
      .optional(),
    subagents: z
      .object({
        tools: ToolPolicySchema,
      })
      .strict()
      .optional(),
    sandbox: z
      .object({
        tools: ToolPolicySchema,
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.allow && value.allow.length > 0 && value.alsoAllow && value.alsoAllow.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "tools cannot set both allow and alsoAllow in the same scope (merge alsoAllow into allow, or remove allow and use profile + alsoAllow)",
      });
    }
  })
  .optional();
