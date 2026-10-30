import { z } from "zod";
import { ToolsSchema } from "./zod-schema.agent-runtime.js";
import { ApprovalsSchema } from "./zod-schema.approvals.js";
import { AgentsSchema, AudioSchema, BindingsSchema, BroadcastSchema } from "./zod-schema.agents.js";
import { HexColorSchema, ModelsConfigSchema } from "./zod-schema.core.js";
import { VoiceSetupFieldsSchema } from "../voice/schema.js";
import { HookMappingSchema, HooksGmailSchema, InternalHooksSchema } from "./zod-schema.hooks.js";
import { ChannelsSchema } from "./zod-schema.providers.js";
import { CommandsSchema, MessagesSchema, SessionSchema } from "./zod-schema.session.js";

const BrowserSnapshotDefaultsSchema = z
  .object({
    mode: z.literal("efficient").optional(),
  })
  .strict()
  .optional();

const NodeHostSchema = z
  .object({
    browserProxy: z
      .object({
        enabled: z.boolean().optional(),
        allowProfiles: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .optional();

const NodeCapabilitiesSchema = z
  .object({
    hasOllama: z.boolean().optional(),
    ollamaModels: z.array(z.string()).optional(),
    hasComfyUI: z.boolean().optional(),
    /** ComfyUI install path advertised when the binary is present but not running. */
    comfyUIPath: z.string().optional(),
    hasVoice: z.boolean().optional(),
    gpu: z.string().optional(),
    gpuVRAM: z.number().optional(),
    systemRAM: z.number().optional(),
    mcpServers: z.array(z.string()).optional(),
    agents: z.array(z.string()).optional(),
    workspaces: z.array(z.string()).optional(),
    platform: z.string().optional(),
    arch: z.string().optional(),
    // ── Media processing capabilities ──
    // Normally auto-detected by src/federation/compute-manifest.ts, but the config
    // block is an operator override for nodes where detection can't see the tools;
    // NodeCapabilities declares them, so `.strict()` must accept them too.
    ffmpeg: z
      .object({
        available: z.boolean().optional(),
        version: z.string().optional(),
        hasNvenc: z.boolean().optional(),
        hasNvdec: z.boolean().optional(),
        hasCuda: z.boolean().optional(),
        codecs: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    imageTools: z
      .object({
        rembg: z.boolean().optional(),
        realesrgan: z.boolean().optional(),
        pillow: z.boolean().optional(),
        imagemagick: z.boolean().optional(),
      })
      .strict()
      .optional(),
    mediaServices: z.array(z.string()).optional(),
  })
  .partial()
  .strict()
  .optional();

const FederationConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    mode: z
      .union([z.literal("master"), z.literal("satellite"), z.literal("standalone")])
      .optional(),
    nodeId: z.string().optional(),
    masterUrl: z.string().optional(),
    masters: z.array(z.string()).optional(),
    masterFailoverTimeoutMs: z.number().int().positive().optional(),
    nodeName: z.string().optional(),
    federationPort: z.number().int().positive().optional(),
    discovery: z.boolean().optional(),
    requireRegisterToken: z.boolean().optional(),
    capabilities: NodeCapabilitiesSchema,
    delegate: z
      .array(
        z.union([z.literal("ollama"), z.literal("voice"), z.literal("imageGen"), z.literal("mcp")]),
      )
      .optional(),
    publicUrl: z.string().optional(),
    /** Free-form human label set by `federation join` from the invite. */
    label: z.string().optional(),
    /**
     * Signed satellite token persisted by `federation join`. Lax-validated
     * here (passthrough object) so the canonical shape lives in security.ts
     * without dragging a second copy of the schema into config.
     */
    authToken: z.record(z.string(), z.unknown()).optional(),
    /**
     * What this satellite shares with its master (src/federation/share-policy.ts).
     * Unset categories stay shared.
     */
    share: z
      .object({
        terminals: z.boolean().optional(),
        coders: z.boolean().optional(),
        agents: z.boolean().optional(),
        compute: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .optional();

export const InfinibotSchema = z
  .object({
    meta: z
      .object({
        lastTouchedVersion: z.string().optional(),
        lastTouchedAt: z.string().optional(),
      })
      .strict()
      .optional(),
    env: z
      .object({
        shellEnv: z
          .object({
            enabled: z.boolean().optional(),
            timeoutMs: z.number().int().nonnegative().optional(),
          })
          .strict()
          .optional(),
        vars: z.record(z.string(), z.string()).optional(),
      })
      .catchall(z.string())
      .optional(),
    wizard: z
      .object({
        lastRunAt: z.string().optional(),
        lastRunVersion: z.string().optional(),
        lastRunCommit: z.string().optional(),
        lastRunCommand: z.string().optional(),
        lastRunMode: z.union([z.literal("local"), z.literal("remote")]).optional(),
      })
      .strict()
      .optional(),
    diagnostics: z
      .object({
        enabled: z.boolean().optional(),
        flags: z.array(z.string()).optional(),
        otel: z
          .object({
            enabled: z.boolean().optional(),
            endpoint: z.string().optional(),
            protocol: z.union([z.literal("http/protobuf"), z.literal("grpc")]).optional(),
            headers: z.record(z.string(), z.string()).optional(),
            serviceName: z.string().optional(),
            traces: z.boolean().optional(),
            metrics: z.boolean().optional(),
            logs: z.boolean().optional(),
            sampleRate: z.number().min(0).max(1).optional(),
            flushIntervalMs: z.number().int().nonnegative().optional(),
          })
          .strict()
          .optional(),
        cacheTrace: z
          .object({
            enabled: z.boolean().optional(),
            filePath: z.string().optional(),
            includeMessages: z.boolean().optional(),
            includePrompt: z.boolean().optional(),
            includeSystem: z.boolean().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    logging: z
      .object({
        level: z
          .union([
            z.literal("silent"),
            z.literal("fatal"),
            z.literal("error"),
            z.literal("warn"),
            z.literal("info"),
            z.literal("debug"),
            z.literal("trace"),
          ])
          .optional(),
        file: z.string().optional(),
        consoleLevel: z
          .union([
            z.literal("silent"),
            z.literal("fatal"),
            z.literal("error"),
            z.literal("warn"),
            z.literal("info"),
            z.literal("debug"),
            z.literal("trace"),
          ])
          .optional(),
        consoleStyle: z
          .union([z.literal("pretty"), z.literal("compact"), z.literal("json")])
          .optional(),
        redactSensitive: z.union([z.literal("off"), z.literal("tools")]).optional(),
        redactPatterns: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    update: z
      .object({
        channel: z.union([z.literal("stable"), z.literal("beta"), z.literal("dev")]).optional(),
        checkOnStart: z.boolean().optional(),
        /**
         * Auto-update scheduler. Mirrors `InfinibotConfig["update"]["auto"]` and the
         * runtime in src/infra/auto-update.ts; the `update.auto.*` gateway RPCs
         * persist into this block, so every field the updater reads must be
         * accepted here or the write bounces off `.strict()`.
         */
        auto: z
          .object({
            enabled: z.boolean().optional(),
            /** Documented minimum is 15 minutes. */
            intervalMinutes: z.number().int().min(15).optional(),
            autoApply: z.boolean().optional(),
            quietHours: z
              .object({
                enabled: z.boolean().optional(),
                start: z.number().int().min(0).max(23).optional(),
                end: z.number().int().min(0).max(23).optional(),
              })
              .strict()
              .optional(),
            notifications: z
              .object({
                onAvailable: z.boolean().optional(),
                onBeforeApply: z.boolean().optional(),
                onApplied: z.boolean().optional(),
                onFailure: z.boolean().optional(),
                targetSession: z.string().optional(),
              })
              .strict()
              .optional(),
            applyDelaySeconds: z.number().int().nonnegative().optional(),
            maxConsecutiveFailures: z.number().int().positive().optional(),
            backoffMultiplier: z.number().positive().optional(),
            maxBackoffMinutes: z.number().int().positive().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    browser: z
      .object({
        enabled: z.boolean().optional(),
        evaluateEnabled: z.boolean().optional(),
        cdpUrl: z.string().optional(),
        remoteCdpTimeoutMs: z.number().int().nonnegative().optional(),
        remoteCdpHandshakeTimeoutMs: z.number().int().nonnegative().optional(),
        color: z.string().optional(),
        executablePath: z.string().optional(),
        headless: z.boolean().optional(),
        noSandbox: z.boolean().optional(),
        attachOnly: z.boolean().optional(),
        defaultProfile: z.string().optional(),
        agentProfiles: z.record(z.string(), z.string()).optional(),
        snapshotDefaults: BrowserSnapshotDefaultsSchema,
        profiles: z
          .record(
            z
              .string()
              .regex(/^[a-z0-9-]+$/, "Profile names must be alphanumeric with hyphens only"),
            z
              .object({
                cdpPort: z.number().int().min(1).max(65535).optional(),
                cdpUrl: z.string().optional(),
                driver: z.union([z.literal("clawd"), z.literal("extension")]).optional(),
                color: HexColorSchema,
              })
              .strict()
              .refine((value) => value.cdpPort || value.cdpUrl, {
                message: "Profile must set cdpPort or cdpUrl",
              }),
          )
          .optional(),
      })
      .strict()
      .optional(),
    ui: z
      .object({
        seamColor: HexColorSchema.optional(),
        assistant: z
          .object({
            name: z.string().max(50).optional(),
            avatar: z.string().max(200).optional(),
          })
          .strict()
          .optional(),
        // Branding payload persisted by the `branding.set` gateway handler.
        // The handler runs sanitizeTokens / sanitizeBranding on input, so the
        // schema only has to allow the fields through — passthrough() keeps
        // forward-compat with new token keys without a schema bump per change.
        theme: z
          .object({
            mode: z.enum(["system", "dark", "light", "hud"]).optional(),
            paletteId: z.string().max(80).optional(),
            background: z.string().max(80).optional(),
            tokens: z.record(z.string(), z.unknown()).optional(),
          })
          .passthrough()
          .optional(),
        branding: z
          .object({
            appName: z.string().max(80).optional(),
            tagline: z.string().max(160).optional(),
            logoUrl: z.string().max(2048).optional(),
            logoDataUrl: z.string().optional(),
            faviconUrl: z.string().max(2048).optional(),
          })
          .passthrough()
          .optional(),
      })
      .strict()
      .optional(),
    // Container endpoints for the voice stack (Kokoro TTS, Speaches STT,
    // LiveKit). On master, these can be omitted — handlers fall back to
    // env vars and localhost defaults. On satellites, the federation
    // satellite manager writes URLs derived from the master's hostname
    // here on connect so voice features point at master's containers
    // automatically without manual env-var wiring.
    voice: z
      .object({
        kokoroUrl: z.string().url().optional(),
        speachesUrl: z.string().url().optional(),
        livekitUrl: z.string().optional(),
        livekitUrlExternal: z.string().optional(),
        // True when the URLs were written automatically by the satellite
        // bootstrap; lets the UI show "auto-pointing at master" instead
        // of "user-configured" so users know it'll update on reconnect.
        autoFromMaster: z.boolean().optional(),
        masterHost: z.string().optional(),
        robovoiceUrl: z.string().url().optional(),
        // Voice-provider selection: "auto" (default) or a provider id
        // ("local", "robovoice", …). See src/gateway/voice/provider-registry.ts.
        backend: z.string().optional(),
      })
      // Unified voice-setup fields (provider/cloud/native/fallback) live in
      // the same block — merged in from the single source of truth so the
      // top-level config validator enforces them too. See src/voice/schema.ts.
      .merge(VoiceSetupFieldsSchema)
      .passthrough()
      .optional(),
    auth: z
      .object({
        profiles: z
          .record(
            z.string(),
            z
              .object({
                provider: z.string(),
                mode: z.union([z.literal("api_key"), z.literal("oauth"), z.literal("token")]),
                email: z.string().optional(),
              })
              .strict(),
          )
          .optional(),
        order: z.record(z.string(), z.array(z.string())).optional(),
        cooldowns: z
          .object({
            billingBackoffHours: z.number().positive().optional(),
            billingBackoffHoursByProvider: z.record(z.string(), z.number().positive()).optional(),
            billingMaxHours: z.number().positive().optional(),
            failureWindowHours: z.number().positive().optional(),
          })
          .strict()
          .optional(),
        multiUser: z
          .object({
            enabled: z.boolean().optional(),
            sessionTtlHours: z.number().positive().optional(),
            publicBaseUrl: z.string().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    models: ModelsConfigSchema,
    localRuntimes: z
      .object({
        enabled: z.boolean().optional(),
        runtimes: z
          .record(
            z.string(),
            z.union([
              z.literal(false),
              z
                .object({
                  label: z.string().optional(),
                  kind: z.enum(["systemd", "ollama"]).optional(),
                  unit: z.string().optional(),
                  baseUrl: z.string().optional(),
                  healthUrl: z.string().optional(),
                  providers: z.array(z.string()).optional(),
                  models: z.array(z.string()).optional(),
                  visionModels: z.array(z.string()).optional(),
                  vramMb: z.number().nonnegative().optional(),
                  vramFraction: z.number().positive().max(1).optional(),
                  modelVramMb: z.record(z.string(), z.number().nonnegative()).optional(),
                  startupTimeoutSec: z.number().positive().optional(),
                  etaSec: z.number().positive().optional(),
                  idleStopMinutes: z.number().nonnegative().optional(),
                  startAtBoot: z.boolean().optional(),
                  keepAlive: z.string().optional(),
                })
                .strict(),
            ]),
          )
          .optional(),
        drainTimeoutSec: z.number().nonnegative().optional(),
        backgroundPriority: z.enum(["interactive-first", "fifo"]).optional(),
        backgroundSwapIdleSec: z.number().nonnegative().optional(),
        backgroundWaitTimeoutSec: z.number().positive().optional(),
        reservedVramMb: z.number().nonnegative().optional(),
        gpuIndex: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
    secureMode: z
      .object({
        allowedModelHosts: z.array(z.string()).optional(),
        localHosts: z.array(z.string()).optional(),
        defaultModel: z.string().optional(),
        allowTools: z.array(z.string()).optional(),
        research: z
          .object({
            enabled: z.boolean().optional(),
            approval: z.union([z.literal("ask"), z.literal("auto-sanitized")]).optional(),
            searxngUrl: z.string().optional(),
            proxy: z.string().optional(),
            model: z.string().optional(),
            maxQueries: z.number().int().positive().optional(),
            pagesPerQuery: z.number().int().nonnegative().optional(),
            maxPages: z.number().int().nonnegative().optional(),
            fetchTimeoutMs: z.number().int().positive().optional(),
            maxPageBytes: z.number().int().positive().optional(),
            approvalTimeoutSec: z.number().int().positive().optional(),
            sensitiveTerms: z.array(z.string()).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    nodeHost: NodeHostSchema,
    agents: AgentsSchema,
    tools: ToolsSchema,
    bindings: BindingsSchema,
    broadcast: BroadcastSchema,
    audio: AudioSchema,
    media: z
      .object({
        preserveFilenames: z.boolean().optional(),
      })
      .strict()
      .optional(),
    messages: MessagesSchema,
    commands: CommandsSchema,
    approvals: ApprovalsSchema,
    session: SessionSchema,
    cron: z
      .object({
        enabled: z.boolean().optional(),
        store: z.string().optional(),
        maxConcurrentRuns: z.number().int().positive().optional(),
        /** Opt-in for seeded autonomy jobs; see CronConfig.autonomy. */
        autonomy: z.boolean().optional(),
        /** Seeds the agency-operating-loop job cadence on first registration. */
        agencyOperatingLoopMs: z.number().int().positive().optional(),
        /**
         * Work-item execution. `executeWorkItems` is the master switch that
         * lets AI employees spawn their bound coder CLI; it stays off unless
         * explicitly set. Mirrors AgencyOperatingLoopConfig in
         * src/config/types.cron.ts — this schema is `.strict()`, so a key
         * missing here cannot be set through `config set` or the config RPCs
         * no matter what the TypeScript type allows.
         */
        agencyOperatingLoop: z
          .object({
            executeWorkItems: z.boolean().optional(),
            maxConcurrency: z.number().int().positive().optional(),
            maxItemsPerPass: z.number().int().positive().optional(),
            timeoutMinutes: z.number().int().positive().optional(),
            fallbackBackend: z
              .enum(["claude-code", "opencode", "codex", "gemini", "grok"])
              .optional(),
            defaultBackend: z
              .enum(["claude-code", "opencode", "codex", "gemini", "grok"])
              .optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    hooks: z
      .object({
        enabled: z.boolean().optional(),
        path: z.string().optional(),
        token: z.string().optional(),
        maxBodyBytes: z.number().int().positive().optional(),
        presets: z.array(z.string()).optional(),
        transformsDir: z.string().optional(),
        mappings: z.array(HookMappingSchema).optional(),
        gmail: HooksGmailSchema,
        internal: InternalHooksSchema,
      })
      .strict()
      .optional(),
    web: z
      .object({
        enabled: z.boolean().optional(),
        heartbeatSeconds: z.number().int().positive().optional(),
        reconnect: z
          .object({
            initialMs: z.number().positive().optional(),
            maxMs: z.number().positive().optional(),
            factor: z.number().positive().optional(),
            jitter: z.number().min(0).max(1).optional(),
            maxAttempts: z.number().int().min(0).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    channels: ChannelsSchema,
    discovery: z
      .object({
        wideArea: z
          .object({
            enabled: z.boolean().optional(),
          })
          .strict()
          .optional(),
        mdns: z
          .object({
            mode: z.enum(["off", "minimal", "full"]).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    canvasHost: z
      .object({
        enabled: z.boolean().optional(),
        root: z.string().optional(),
        port: z.number().int().positive().optional(),
        liveReload: z.boolean().optional(),
      })
      .strict()
      .optional(),
    talk: z
      .object({
        voiceId: z.string().optional(),
        voiceAliases: z.record(z.string(), z.string()).optional(),
        modelId: z.string().optional(),
        outputFormat: z.string().optional(),
        apiKey: z.string().optional(),
        interruptOnSpeech: z.boolean().optional(),
      })
      .strict()
      .optional(),
    gateway: z
      .object({
        port: z.number().int().positive().optional(),
        mode: z.union([z.literal("local"), z.literal("remote")]).optional(),
        bind: z
          .union([
            z.literal("auto"),
            z.literal("lan"),
            z.literal("loopback"),
            z.literal("custom"),
            z.literal("tailnet"),
          ])
          .optional(),
        /**
         * Required companion to `bind: "custom"` — resolveGatewayBindHost() in
         * src/cli/daemon-cli/shared.ts reads it, so without this key the "custom"
         * bind mode above is unreachable.
         */
        customBindHost: z.string().optional(),
        controlUi: z
          .object({
            enabled: z.boolean().optional(),
            basePath: z.string().optional(),
            allowInsecureAuth: z.boolean().optional(),
            dangerouslyDisableDeviceAuth: z.boolean().optional(),
          })
          .strict()
          .optional(),
        auth: z
          .object({
            mode: z.union([z.literal("token"), z.literal("password")]).optional(),
            token: z.string().optional(),
            password: z.string().optional(),
            allowTailscale: z.boolean().optional(),
          })
          .strict()
          .optional(),
        trustedProxies: z.array(z.string()).optional(),
        tailscale: z
          .object({
            mode: z.union([z.literal("off"), z.literal("serve"), z.literal("funnel")]).optional(),
            /** Shorthand for mode: "serve" (tailnet-only auto-exposure at boot). */
            autoServe: z.boolean().optional(),
            /** Shorthand for mode: "funnel" — PUBLIC INTERNET exposure. Opt-in only. */
            funnel: z.boolean().optional(),
            port: z.number().int().positive().max(65_535).optional(),
            exposeExpo: z.boolean().optional(),
            expoPort: z.number().int().positive().max(65_535).optional(),
            resetOnExit: z.boolean().optional(),
          })
          .strict()
          .optional(),
        remote: z
          .object({
            url: z.string().optional(),
            transport: z.union([z.literal("ssh"), z.literal("direct")]).optional(),
            token: z.string().optional(),
            password: z.string().optional(),
            tlsFingerprint: z.string().optional(),
            sshTarget: z.string().optional(),
            sshIdentity: z.string().optional(),
          })
          .strict()
          .optional(),
        reload: z
          .object({
            mode: z
              .union([
                z.literal("off"),
                z.literal("restart"),
                z.literal("hot"),
                z.literal("hybrid"),
              ])
              .optional(),
            debounceMs: z.number().int().min(0).optional(),
          })
          .strict()
          .optional(),
        tls: z
          .object({
            enabled: z.boolean().optional(),
            autoGenerate: z.boolean().optional(),
            certPath: z.string().optional(),
            keyPath: z.string().optional(),
            caPath: z.string().optional(),
          })
          .optional(),
        http: z
          .object({
            endpoints: z
              .object({
                chatCompletions: z
                  .object({
                    enabled: z.boolean().optional(),
                  })
                  .strict()
                  .optional(),
                responses: z
                  .object({
                    enabled: z.boolean().optional(),
                    maxBodyBytes: z.number().int().positive().optional(),
                    files: z
                      .object({
                        allowUrl: z.boolean().optional(),
                        allowedMimes: z.array(z.string()).optional(),
                        maxBytes: z.number().int().positive().optional(),
                        maxChars: z.number().int().positive().optional(),
                        maxRedirects: z.number().int().nonnegative().optional(),
                        timeoutMs: z.number().int().positive().optional(),
                        pdf: z
                          .object({
                            maxPages: z.number().int().positive().optional(),
                            maxPixels: z.number().int().positive().optional(),
                            minTextChars: z.number().int().nonnegative().optional(),
                          })
                          .strict()
                          .optional(),
                      })
                      .strict()
                      .optional(),
                    images: z
                      .object({
                        allowUrl: z.boolean().optional(),
                        allowedMimes: z.array(z.string()).optional(),
                        maxBytes: z.number().int().positive().optional(),
                        maxRedirects: z.number().int().nonnegative().optional(),
                        timeoutMs: z.number().int().positive().optional(),
                      })
                      .strict()
                      .optional(),
                  })
                  .strict()
                  .optional(),
              })
              .strict()
              .optional(),
          })
          .strict()
          .optional(),
        nodes: z
          .object({
            browser: z
              .object({
                mode: z
                  .union([z.literal("auto"), z.literal("manual"), z.literal("off")])
                  .optional(),
                node: z.string().optional(),
              })
              .strict()
              .optional(),
            allowCommands: z.array(z.string()).optional(),
            denyCommands: z.array(z.string()).optional(),
          })
          .strict()
          .optional(),
        tunnel: z
          .object({
            enabled: z.boolean().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    skills: z
      .object({
        allowBundled: z.array(z.string()).optional(),
        profile: z.union([z.literal("core"), z.literal("full")]).optional(),
        load: z
          .object({
            extraDirs: z.array(z.string()).optional(),
            watch: z.boolean().optional(),
            watchDebounceMs: z.number().int().min(0).optional(),
          })
          .strict()
          .optional(),
        install: z
          .object({
            preferBrew: z.boolean().optional(),
            nodeManager: z
              .union([z.literal("npm"), z.literal("pnpm"), z.literal("yarn"), z.literal("bun")])
              .optional(),
          })
          .strict()
          .optional(),
        entries: z
          .record(
            z.string(),
            z
              .object({
                enabled: z.boolean().optional(),
                apiKey: z.string().optional(),
                env: z.record(z.string(), z.string()).optional(),
                config: z.record(z.string(), z.unknown()).optional(),
              })
              .strict(),
          )
          .optional(),
      })
      .strict()
      .optional(),
    plugins: z
      .object({
        enabled: z.boolean().optional(),
        allow: z.array(z.string()).optional(),
        deny: z.array(z.string()).optional(),
        load: z
          .object({
            paths: z.array(z.string()).optional(),
          })
          .strict()
          .optional(),
        slots: z
          .object({
            memory: z.string().optional(),
          })
          .strict()
          .optional(),
        // Plugin whose declared `contributes.landing` page is the start page
        // (e.g. "omniclinic" = clinic mode). Unset → the normal dashboard.
        landing: z.string().optional(),
        entries: z
          .record(
            z.string(),
            z
              .object({
                enabled: z.boolean().optional(),
                config: z.record(z.string(), z.unknown()).optional(),
                // Hot per-plugin choices from Setup › Plugins (no restart):
                // validated against the plugin's manifest by the plugins.* RPCs.
                appearance: z.record(z.string(), z.unknown()).optional(),
                contributions: z
                  .object({
                    disabled: z.array(z.string()).optional(),
                    enabled: z.array(z.string()).optional(),
                  })
                  .strict()
                  .optional(),
                permissions: z
                  .object({
                    revoked: z.array(z.string()).optional(),
                    granted: z.array(z.string()).optional(),
                  })
                  .strict()
                  .optional(),
                autoUpdate: z.boolean().optional(),
              })
              .strict(),
          )
          .optional(),
        installs: z
          .record(
            z.string(),
            z
              .object({
                source: z.union([
                  z.literal("npm"),
                  z.literal("archive"),
                  z.literal("path"),
                  z.literal("zip"),
                  z.literal("url"),
                  z.literal("registry"),
                ]),
                spec: z.string().optional(),
                sourcePath: z.string().optional(),
                installPath: z.string().optional(),
                version: z.string().optional(),
                installedAt: z.string().optional(),
                sourceUrl: z.string().optional(),
                registryUrl: z.string().optional(),
                sha256: z.string().optional(),
                sizeBytes: z.number().optional(),
                reviewedPermissions: z.array(z.string()).optional(),
                overridesBundled: z.boolean().optional(),
                previous: z
                  .object({
                    version: z.string(),
                    sha256: z.string().optional(),
                    path: z.string().optional(),
                    bundled: z.boolean().optional(),
                    installedAt: z.string().optional(),
                  })
                  .strict()
                  .optional(),
              })
              .strict(),
          )
          .optional(),
        registryUrl: z.string().optional(),
        updates: z
          .object({
            check: z.boolean().optional(),
            intervalHours: z.number().min(1).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    integrations: z
      .object({
        calendar: z
          .object({
            clientId: z.string().optional(),
            clientSecret: z.string().optional(),
            refreshToken: z.string().optional(),
          })
          .strict()
          .optional(),
        ollama: z
          .object({
            host: z.string().url().optional(),
            pollIntervalMs: z.number().int().positive().optional(),
            autoStartPolling: z.boolean().optional(),
          })
          .strict()
          .optional(),
        contentIntel: z
          .object({
            pipelineDir: z.string().min(1).optional(),
            venvPath: z.string().min(1).optional(),
          })
          .strict()
          .optional(),
        gmail: z
          .object({
            defaultAccountId: z.string().optional(),
            accounts: z
              .array(
                z
                  .object({
                    id: z.string(),
                    email: z.string().optional(),
                    clientId: z.string(),
                    clientSecret: z.string(),
                    refreshToken: z.string(),
                  })
                  .strict(),
              )
              .optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    federation: FederationConfigSchema,
    autonomy: z
      .object({
        defaultBackend: z
          .discriminatedUnion("kind", [
            z.object({ kind: z.literal("claude"), profileId: z.string().optional() }).strict(),
            z.object({ kind: z.literal("opencode") }).strict(),
            z.object({ kind: z.literal("codex") }).strict(),
            z.object({ kind: z.literal("grok") }).strict(),
            z.object({ kind: z.literal("gateway-agent"), agentId: z.string().min(1) }).strict(),
          ])
          .optional(),
      })
      .strict()
      .optional(),
    /**
     * Verified completion. `judgeModel` (`provider/model`) picks the model that
     * reviews runs, judges goals and assesses screenshots; `judgeFallbacks` are
     * tried next, then the agent default model, other keyed providers and the
     * logged-in CLIs. See src/autonomy/judge-models.ts.
     */
    verification: z
      .object({
        judgeModel: z.string().optional(),
        judgeFallbacks: z.array(z.string()).optional(),
        judgeTimeoutMs: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    /**
     * Gateway-native build conductors. OFF by default — the top-level schema is
     * `.strict()`, so these keys must be declared here to be settable through
     * `config set` / the config RPCs. See src/agency/build-conductor.ts.
     */
    conductor: z
      .object({
        fh12: z
          .object({
            enabled: z.boolean().optional(),
            projectDir: z.string().optional(),
            intervalMs: z.number().int().positive().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    /**
     * Internal MCP servers — same shape as Claude Code's `mcpServers` block
     * in `~/.claude.json`, so entries declared here can be mirrored into
     * Claude Code via `mcp.internal.sync` and used directly by Claude Coder.
     *
     *   "mcpServers": {
     *     "my-server": {
     *       "type": "stdio",
     *       "command": "node",
     *       "args": ["./mcp/my-server.js"],
     *       "env": { "API_KEY": "..." }
     *     }
     *   }
     *
     * `type` may be omitted; we default to "stdio" on sync.
     */
    mcpServers: z
      .record(
        z.string(),
        z
          .object({
            type: z.union([z.literal("stdio"), z.literal("http"), z.literal("sse")]).optional(),
            command: z.string().optional(),
            args: z.array(z.string()).optional(),
            env: z.record(z.string(), z.string()).optional(),
            url: z.string().optional(),
            headers: z.record(z.string(), z.string()).optional(),
            description: z.string().optional(),
            enabled: z.boolean().optional(),
            /** When true, register this server in Claude Code on startup. */
            syncToClaudeCode: z.boolean().optional(),
          })
          .strict(),
      )
      .optional(),
    cliRoutingEnabled: z.boolean().optional(),
    cliRouting: z
      .object({
        providers: z.array(z.string().min(1)).optional(),
        models: z.record(z.string(), z.string()).optional(),
        fallbackToApi: z.boolean().optional(),
        tools: z.boolean().optional(),
        allTraffic: z.boolean().optional(),
      })
      .strict()
      .optional(),
    onboarding: z
      .object({
        completed: z.boolean().optional(),
        completedAt: z.number().optional(),
        via: z.string().optional(),
      })
      .strict()
      .optional(),
    loops: z
      .object({
        apiKey: z.string().optional(),
        /** Webhook secret for verifying Loops → InfiniBot delivery events. */
        webhookSecret: z.string().optional(),
        /** Auto-sync CRM rows (clients/leads) to Loops contacts on this cadence. 0/unset = manual only. */
        autoSyncMinutes: z.number().int().nonnegative().optional(),
        /** Default `userGroup` for newly-created Loops contacts when CRM doesn't say otherwise. */
        defaultUserGroup: z.string().optional(),
      })
      .strict()
      .optional(),
    /**
     * Netlify integration — used by the Lead-Qualifier form builder to
     * deploy a static, secure copy of any form to Netlify while keeping the
     * submission endpoint pointed at the user's local gateway. Token is a
     * personal access token from app.netlify.com/user/applications.
     */
    netlify: z
      .object({
        accessToken: z.string().optional(),
        /** Public-internet URL of the local gateway (Tailscale funnel / ngrok / cloudflared). */
        apiBaseUrl: z.string().optional(),
        /** Map of form id → Netlify site id so re-deploys land on the same site. */
        formSites: z.record(z.string(), z.string()).optional(),
      })
      .strict()
      .optional(),
    /**
     * Workload tracking. Read by src/workload/emitter.ts (`enabled !== false`),
     * surfaced on the Discipline page as the "Auto-logged" lane.
     */
    workloadTracking: z
      .object({
        enabled: z.boolean().optional(),
        streakMinEvents: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    notion: z
      .object({
        apiKey: z.string().optional(),
        syncMode: z
          .union([z.literal("off"), z.literal("mirror"), z.literal("import-once")])
          .optional(),
        projectsDbId: z.string().optional(),
        tasksDbId: z.string().optional(),
        parentPageId: z.string().optional(),
        integrationName: z.string().optional(),
        clientsDbId: z.string().optional(),
        leadsDbId: z.string().optional(),
        companiesDbId: z.string().optional(),
        dealsDbId: z.string().optional(),
        contactsDbId: z.string().optional(),
        incomeStreamsDbId: z.string().optional(),
        /**
         * Unified bindings registry: every Notion DB this install talks
         * to, indexed by Notion DB id. Read by the bidirectional poller,
         * conflict queue, schema reconciler, and the import wizard.
         * Auto-synthesized from the legacy *DbId fields above on first
         * read so existing installs need no migration step. Loose schema
         * (`.passthrough()`) so a new field on a binding doesn't need
         * a corresponding zod schema bump every time.
         */
        bindings: z
          .record(
            z.string(),
            z
              .object({
                notionDbId: z.string(),
                role: z.union([
                  z.literal("projects"),
                  z.literal("tasks"),
                  z.literal("clients"),
                  z.literal("leads"),
                  z.literal("companies"),
                  z.literal("deals"),
                  z.literal("contacts"),
                  z.literal("products"),
                  z.literal("custom"),
                ]),
                fieldMap: z.record(z.string(), z.string()).optional(),
                customFields: z
                  .record(
                    z.string(),
                    z.object({ name: z.string(), type: z.string() }).passthrough(),
                  )
                  .optional(),
                lastSyncedAt: z.number().nullable().optional(),
                conflictPolicy: z
                  .union([z.literal("queue"), z.literal("last-write-wins")])
                  .optional(),
                title: z.string().nullable().optional(),
                businessId: z.string().nullable().optional(),
              })
              .passthrough(),
          )
          .optional(),
      })
      .strict()
      .optional(),
    coder: z
      .object({
        backend: z
          .union([
            z.literal("claude-code"),
            z.literal("opencode"),
            z.literal("codex"),
            z.literal("gemini"),
            z.literal("grok"),
          ])
          .optional(),
        models: z
          .object({
            opencode: z.string().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    notifications: z
      .object({
        telegram: z
          .object({
            attachVerificationScreenshots: z.boolean().optional(),
            maxVerificationScreenshots: z.number().int().min(1).max(10).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    claudeCoder: z
      .object({
        skillSystem: z
          .object({
            enabled: z.boolean().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    secrets: z
      .object({
        emailAccountsKey: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    const agents = cfg.agents?.list ?? [];
    if (agents.length === 0) return;
    const agentIds = new Set(agents.map((agent) => agent.id));

    const broadcast = cfg.broadcast;
    if (!broadcast) return;

    for (const [peerId, ids] of Object.entries(broadcast)) {
      if (peerId === "strategy") continue;
      if (!Array.isArray(ids)) continue;
      for (let idx = 0; idx < ids.length; idx += 1) {
        const agentId = ids[idx];
        if (!agentIds.has(agentId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["broadcast", peerId, idx],
            message: `Unknown agent id "${agentId}" (not in agents.list).`,
          });
        }
      }
    }
  });
