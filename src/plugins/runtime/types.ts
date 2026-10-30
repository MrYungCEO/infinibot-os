import type { LogLevel } from "../../logging/levels.js";

type ShouldLogVerbose = typeof import("../../globals.js").shouldLogVerbose;
type OnAgentEvent = typeof import("../../infra/agent-events.js").onAgentEvent;
type OnWorkCompleted = typeof import("../../infra/work-completions.js").onWorkCompleted;
type EmitNotification = typeof import("../../notifications/emit.js").emitNotification;
type GatherBusinessSnapshot =
  typeof import("../../proactive/business-snapshot.js").gatherBusinessSnapshot;
type SetDayPlannerProvider = typeof import("../../infra/day-planner-seam.js").setDayPlannerProvider;
type SetCoreToolSlot = typeof import("../core-tool-slots.js").setCoreToolSlot;
type RunLLM = typeof import("../../services/email/llm-analysis.js").runLLM;
type RunVoiceTurn = import("../../gateway/voice/voice-llm-turn.js").RunVoiceTurn;
type DispatchReplyWithBufferedBlockDispatcher =
  typeof import("../../auto-reply/reply/provider-dispatcher.js").dispatchReplyWithBufferedBlockDispatcher;
type CreateReplyDispatcherWithTyping =
  typeof import("../../auto-reply/reply/reply-dispatcher.js").createReplyDispatcherWithTyping;
type ResolveEffectiveMessagesConfig =
  typeof import("../../agents/identity.js").resolveEffectiveMessagesConfig;
type ResolveHumanDelayConfig = typeof import("../../agents/identity.js").resolveHumanDelayConfig;
type ResolveAgentRoute = typeof import("../../routing/resolve-route.js").resolveAgentRoute;
type BuildPairingReply = typeof import("../../pairing/pairing-messages.js").buildPairingReply;
type ReadChannelAllowFromStore =
  typeof import("../../pairing/pairing-store.js").readChannelAllowFromStore;
type UpsertChannelPairingRequest =
  typeof import("../../pairing/pairing-store.js").upsertChannelPairingRequest;
type FetchRemoteMedia = typeof import("../../media/fetch.js").fetchRemoteMedia;
type SaveMediaBuffer = typeof import("../../media/store.js").saveMediaBuffer;
type TextToSpeechTelephony = typeof import("../../tts/tts.js").textToSpeechTelephony;
type BuildMentionRegexes = typeof import("../../auto-reply/reply/mentions.js").buildMentionRegexes;
type MatchesMentionPatterns =
  typeof import("../../auto-reply/reply/mentions.js").matchesMentionPatterns;
type MatchesMentionWithExplicit =
  typeof import("../../auto-reply/reply/mentions.js").matchesMentionWithExplicit;
type ShouldAckReaction = typeof import("../../channels/ack-reactions.js").shouldAckReaction;
type RemoveAckReactionAfterReply =
  typeof import("../../channels/ack-reactions.js").removeAckReactionAfterReply;
type ResolveChannelGroupPolicy =
  typeof import("../../config/group-policy.js").resolveChannelGroupPolicy;
type ResolveChannelGroupRequireMention =
  typeof import("../../config/group-policy.js").resolveChannelGroupRequireMention;
type CreateInboundDebouncer =
  typeof import("../../auto-reply/inbound-debounce.js").createInboundDebouncer;
type ResolveInboundDebounceMs =
  typeof import("../../auto-reply/inbound-debounce.js").resolveInboundDebounceMs;
type ResolveCommandAuthorizedFromAuthorizers =
  typeof import("../../channels/command-gating.js").resolveCommandAuthorizedFromAuthorizers;
type ResolveTextChunkLimit = typeof import("../../auto-reply/chunk.js").resolveTextChunkLimit;
type ResolveChunkMode = typeof import("../../auto-reply/chunk.js").resolveChunkMode;
type ChunkMarkdownText = typeof import("../../auto-reply/chunk.js").chunkMarkdownText;
type ChunkMarkdownTextWithMode =
  typeof import("../../auto-reply/chunk.js").chunkMarkdownTextWithMode;
type ChunkText = typeof import("../../auto-reply/chunk.js").chunkText;
type ChunkTextWithMode = typeof import("../../auto-reply/chunk.js").chunkTextWithMode;
type ChunkByNewline = typeof import("../../auto-reply/chunk.js").chunkByNewline;
type ResolveMarkdownTableMode =
  typeof import("../../config/markdown-tables.js").resolveMarkdownTableMode;
type ConvertMarkdownTables = typeof import("../../markdown/tables.js").convertMarkdownTables;
type HasControlCommand = typeof import("../../auto-reply/command-detection.js").hasControlCommand;
type IsControlCommandMessage =
  typeof import("../../auto-reply/command-detection.js").isControlCommandMessage;
type ShouldComputeCommandAuthorized =
  typeof import("../../auto-reply/command-detection.js").shouldComputeCommandAuthorized;
type ShouldHandleTextCommands =
  typeof import("../../auto-reply/commands-registry.js").shouldHandleTextCommands;
type DispatchReplyFromConfig =
  typeof import("../../auto-reply/reply/dispatch-from-config.js").dispatchReplyFromConfig;
type FinalizeInboundContext =
  typeof import("../../auto-reply/reply/inbound-context.js").finalizeInboundContext;
type FormatAgentEnvelope = typeof import("../../auto-reply/envelope.js").formatAgentEnvelope;
type FormatInboundEnvelope = typeof import("../../auto-reply/envelope.js").formatInboundEnvelope;
type ResolveEnvelopeFormatOptions =
  typeof import("../../auto-reply/envelope.js").resolveEnvelopeFormatOptions;
type ResolveStateDir = typeof import("../../config/paths.js").resolveStateDir;
type ResolveSharedDir = typeof import("../../config/paths.js").resolveSharedDir;
type RecordInboundSession = typeof import("../../channels/session.js").recordInboundSession;
type RecordSessionMetaFromInbound =
  typeof import("../../config/sessions.js").recordSessionMetaFromInbound;
type ResolveStorePath = typeof import("../../config/sessions.js").resolveStorePath;
type ReadSessionUpdatedAt = typeof import("../../config/sessions.js").readSessionUpdatedAt;
type UpdateLastRoute = typeof import("../../config/sessions.js").updateLastRoute;
type LoadConfig = typeof import("../../config/config.js").loadConfig;
type WriteConfigFile = typeof import("../../config/config.js").writeConfigFile;
type RecordChannelActivity = typeof import("../../infra/channel-activity.js").recordChannelActivity;
type GetChannelActivity = typeof import("../../infra/channel-activity.js").getChannelActivity;
type EnqueueSystemEvent = typeof import("../../infra/system-events.js").enqueueSystemEvent;
type RunCommandWithTimeout = typeof import("../../process/exec.js").runCommandWithTimeout;
type FormatNativeDependencyHint = typeof import("./native-deps.js").formatNativeDependencyHint;
type LoadWebMedia = typeof import("../../web/media.js").loadWebMedia;
type DetectMime = typeof import("../../media/mime.js").detectMime;
type MediaKindFromMime = typeof import("../../media/constants.js").mediaKindFromMime;
type IsVoiceCompatibleAudio = typeof import("../../media/audio.js").isVoiceCompatibleAudio;
type GetImageMetadata = typeof import("../../media/image-ops.js").getImageMetadata;
type ResizeToJpeg = typeof import("../../media/image-ops.js").resizeToJpeg;
type CreateMemoryGetTool = typeof import("../../agents/tools/memory-tool.js").createMemoryGetTool;
type CreateMemorySearchTool =
  typeof import("../../agents/tools/memory-tool.js").createMemorySearchTool;
type RegisterMemoryCli = typeof import("../../cli/memory-cli.js").registerMemoryCli;
type DiscordMessageActions =
  typeof import("../../channels/plugins/actions/discord.js").discordMessageActions;
type AuditDiscordChannelPermissions =
  typeof import("../../discord/audit.js").auditDiscordChannelPermissions;
type ListDiscordDirectoryGroupsLive =
  typeof import("../../discord/directory-live.js").listDiscordDirectoryGroupsLive;
type ListDiscordDirectoryPeersLive =
  typeof import("../../discord/directory-live.js").listDiscordDirectoryPeersLive;
type ProbeDiscord = typeof import("../../discord/probe.js").probeDiscord;
type ResolveDiscordChannelAllowlist =
  typeof import("../../discord/resolve-channels.js").resolveDiscordChannelAllowlist;
type ResolveDiscordUserAllowlist =
  typeof import("../../discord/resolve-users.js").resolveDiscordUserAllowlist;
type SendMessageDiscord = typeof import("../../discord/send.js").sendMessageDiscord;
type SendPollDiscord = typeof import("../../discord/send.js").sendPollDiscord;
type MonitorDiscordProvider = typeof import("../../discord/monitor.js").monitorDiscordProvider;
type ListSlackDirectoryGroupsLive =
  typeof import("../../slack/directory-live.js").listSlackDirectoryGroupsLive;
type ListSlackDirectoryPeersLive =
  typeof import("../../slack/directory-live.js").listSlackDirectoryPeersLive;
type ProbeSlack = typeof import("../../slack/probe.js").probeSlack;
type ResolveSlackChannelAllowlist =
  typeof import("../../slack/resolve-channels.js").resolveSlackChannelAllowlist;
type ResolveSlackUserAllowlist =
  typeof import("../../slack/resolve-users.js").resolveSlackUserAllowlist;
type SendMessageSlack = typeof import("../../slack/send.js").sendMessageSlack;
type MonitorSlackProvider = typeof import("../../slack/index.js").monitorSlackProvider;
type HandleSlackAction = typeof import("../../agents/tools/slack-actions.js").handleSlackAction;
type AuditTelegramGroupMembership =
  typeof import("../../telegram/audit.js").auditTelegramGroupMembership;
type CollectTelegramUnmentionedGroupIds =
  typeof import("../../telegram/audit.js").collectTelegramUnmentionedGroupIds;
type ProbeTelegram = typeof import("../../telegram/probe.js").probeTelegram;
type ResolveTelegramToken = typeof import("../../telegram/token.js").resolveTelegramToken;
type SendMessageTelegram = typeof import("../../telegram/send.js").sendMessageTelegram;
type MonitorTelegramProvider = typeof import("../../telegram/monitor.js").monitorTelegramProvider;
type TelegramMessageActions =
  typeof import("../../channels/plugins/actions/telegram.js").telegramMessageActions;
type ProbeSignal = typeof import("../../signal/probe.js").probeSignal;
type SendMessageSignal = typeof import("../../signal/send.js").sendMessageSignal;
type MonitorSignalProvider = typeof import("../../signal/index.js").monitorSignalProvider;
type SignalMessageActions =
  typeof import("../../channels/plugins/actions/signal.js").signalMessageActions;
type MonitorIMessageProvider = typeof import("../../imessage/monitor.js").monitorIMessageProvider;
type ProbeIMessage = typeof import("../../imessage/probe.js").probeIMessage;
type SendMessageIMessage = typeof import("../../imessage/send.js").sendMessageIMessage;
type GetActiveWebListener = typeof import("../../web/active-listener.js").getActiveWebListener;
type GetWebAuthAgeMs = typeof import("../../web/auth-store.js").getWebAuthAgeMs;
type LogoutWeb = typeof import("../../web/auth-store.js").logoutWeb;
type LogWebSelfId = typeof import("../../web/auth-store.js").logWebSelfId;
type ReadWebSelfId = typeof import("../../web/auth-store.js").readWebSelfId;
type WebAuthExists = typeof import("../../web/auth-store.js").webAuthExists;
type SendMessageWhatsApp = typeof import("../../web/outbound.js").sendMessageWhatsApp;
type SendPollWhatsApp = typeof import("../../web/outbound.js").sendPollWhatsApp;
type LoginWeb = typeof import("../../web/login.js").loginWeb;
type StartWebLoginWithQr = typeof import("../../web/login-qr.js").startWebLoginWithQr;
type StartWebLoginWithPairingCode =
  typeof import("../../web/login-qr.js").startWebLoginWithPairingCode;
type WaitForWebLogin = typeof import("../../web/login-qr.js").waitForWebLogin;
type MonitorWebChannel = typeof import("../../channels/web/index.js").monitorWebChannel;
type HandleWhatsAppAction =
  typeof import("../../agents/tools/whatsapp-actions.js").handleWhatsAppAction;
type CreateWhatsAppLoginTool =
  typeof import("../../channels/plugins/agent-tools/whatsapp-login.js").createWhatsAppLoginTool;

// LINE channel types
type ListLineAccountIds = typeof import("../../line/accounts.js").listLineAccountIds;
type ResolveDefaultLineAccountId =
  typeof import("../../line/accounts.js").resolveDefaultLineAccountId;
type ResolveLineAccount = typeof import("../../line/accounts.js").resolveLineAccount;
type NormalizeLineAccountId = typeof import("../../line/accounts.js").normalizeAccountId;
type ProbeLineBot = typeof import("../../line/probe.js").probeLineBot;
type SendMessageLine = typeof import("../../line/send.js").sendMessageLine;
type PushMessageLine = typeof import("../../line/send.js").pushMessageLine;
type PushMessagesLine = typeof import("../../line/send.js").pushMessagesLine;
type PushFlexMessage = typeof import("../../line/send.js").pushFlexMessage;
type PushTemplateMessage = typeof import("../../line/send.js").pushTemplateMessage;
type PushLocationMessage = typeof import("../../line/send.js").pushLocationMessage;
type PushTextMessageWithQuickReplies =
  typeof import("../../line/send.js").pushTextMessageWithQuickReplies;
type CreateQuickReplyItems = typeof import("../../line/send.js").createQuickReplyItems;
type BuildTemplateMessageFromPayload =
  typeof import("../../line/template-messages.js").buildTemplateMessageFromPayload;
type MonitorLineProvider = typeof import("../../line/monitor.js").monitorLineProvider;

export type RuntimeLogger = {
  debug?: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

export type PluginRuntime = {
  version: string;
  config: {
    loadConfig: LoadConfig;
    writeConfigFile: WriteConfigFile;
  };
  system: {
    enqueueSystemEvent: EnqueueSystemEvent;
    runCommandWithTimeout: RunCommandWithTimeout;
    formatNativeDependencyHint: FormatNativeDependencyHint;
  };
  media: {
    loadWebMedia: LoadWebMedia;
    detectMime: DetectMime;
    mediaKindFromMime: MediaKindFromMime;
    isVoiceCompatibleAudio: IsVoiceCompatibleAudio;
    getImageMetadata: GetImageMetadata;
    resizeToJpeg: ResizeToJpeg;
  };
  tts: {
    textToSpeechTelephony: TextToSpeechTelephony;
  };
  tools: {
    createMemoryGetTool: CreateMemoryGetTool;
    createMemorySearchTool: CreateMemorySearchTool;
    registerMemoryCli: RegisterMemoryCli;
  };
  channel: {
    text: {
      chunkByNewline: ChunkByNewline;
      chunkMarkdownText: ChunkMarkdownText;
      chunkMarkdownTextWithMode: ChunkMarkdownTextWithMode;
      chunkText: ChunkText;
      chunkTextWithMode: ChunkTextWithMode;
      resolveChunkMode: ResolveChunkMode;
      resolveTextChunkLimit: ResolveTextChunkLimit;
      hasControlCommand: HasControlCommand;
      resolveMarkdownTableMode: ResolveMarkdownTableMode;
      convertMarkdownTables: ConvertMarkdownTables;
    };
    reply: {
      dispatchReplyWithBufferedBlockDispatcher: DispatchReplyWithBufferedBlockDispatcher;
      createReplyDispatcherWithTyping: CreateReplyDispatcherWithTyping;
      resolveEffectiveMessagesConfig: ResolveEffectiveMessagesConfig;
      resolveHumanDelayConfig: ResolveHumanDelayConfig;
      dispatchReplyFromConfig: DispatchReplyFromConfig;
      finalizeInboundContext: FinalizeInboundContext;
      formatAgentEnvelope: FormatAgentEnvelope;
      formatInboundEnvelope: FormatInboundEnvelope;
      resolveEnvelopeFormatOptions: ResolveEnvelopeFormatOptions;
    };
    routing: {
      resolveAgentRoute: ResolveAgentRoute;
    };
    pairing: {
      buildPairingReply: BuildPairingReply;
      readAllowFromStore: ReadChannelAllowFromStore;
      upsertPairingRequest: UpsertChannelPairingRequest;
    };
    media: {
      fetchRemoteMedia: FetchRemoteMedia;
      saveMediaBuffer: SaveMediaBuffer;
    };
    activity: {
      record: RecordChannelActivity;
      get: GetChannelActivity;
    };
    session: {
      resolveStorePath: ResolveStorePath;
      readSessionUpdatedAt: ReadSessionUpdatedAt;
      recordSessionMetaFromInbound: RecordSessionMetaFromInbound;
      recordInboundSession: RecordInboundSession;
      updateLastRoute: UpdateLastRoute;
    };
    mentions: {
      buildMentionRegexes: BuildMentionRegexes;
      matchesMentionPatterns: MatchesMentionPatterns;
      matchesMentionWithExplicit: MatchesMentionWithExplicit;
    };
    reactions: {
      shouldAckReaction: ShouldAckReaction;
      removeAckReactionAfterReply: RemoveAckReactionAfterReply;
    };
    groups: {
      resolveGroupPolicy: ResolveChannelGroupPolicy;
      resolveRequireMention: ResolveChannelGroupRequireMention;
    };
    debounce: {
      createInboundDebouncer: CreateInboundDebouncer;
      resolveInboundDebounceMs: ResolveInboundDebounceMs;
    };
    commands: {
      resolveCommandAuthorizedFromAuthorizers: ResolveCommandAuthorizedFromAuthorizers;
      isControlCommandMessage: IsControlCommandMessage;
      shouldComputeCommandAuthorized: ShouldComputeCommandAuthorized;
      shouldHandleTextCommands: ShouldHandleTextCommands;
    };
    discord: {
      messageActions: DiscordMessageActions;
      auditChannelPermissions: AuditDiscordChannelPermissions;
      listDirectoryGroupsLive: ListDiscordDirectoryGroupsLive;
      listDirectoryPeersLive: ListDiscordDirectoryPeersLive;
      probeDiscord: ProbeDiscord;
      resolveChannelAllowlist: ResolveDiscordChannelAllowlist;
      resolveUserAllowlist: ResolveDiscordUserAllowlist;
      sendMessageDiscord: SendMessageDiscord;
      sendPollDiscord: SendPollDiscord;
      monitorDiscordProvider: MonitorDiscordProvider;
    };
    slack: {
      listDirectoryGroupsLive: ListSlackDirectoryGroupsLive;
      listDirectoryPeersLive: ListSlackDirectoryPeersLive;
      probeSlack: ProbeSlack;
      resolveChannelAllowlist: ResolveSlackChannelAllowlist;
      resolveUserAllowlist: ResolveSlackUserAllowlist;
      sendMessageSlack: SendMessageSlack;
      monitorSlackProvider: MonitorSlackProvider;
      handleSlackAction: HandleSlackAction;
    };
    telegram: {
      auditGroupMembership: AuditTelegramGroupMembership;
      collectUnmentionedGroupIds: CollectTelegramUnmentionedGroupIds;
      probeTelegram: ProbeTelegram;
      resolveTelegramToken: ResolveTelegramToken;
      sendMessageTelegram: SendMessageTelegram;
      monitorTelegramProvider: MonitorTelegramProvider;
      messageActions: TelegramMessageActions;
    };
    signal: {
      probeSignal: ProbeSignal;
      sendMessageSignal: SendMessageSignal;
      monitorSignalProvider: MonitorSignalProvider;
      messageActions: SignalMessageActions;
    };
    imessage: {
      monitorIMessageProvider: MonitorIMessageProvider;
      probeIMessage: ProbeIMessage;
      sendMessageIMessage: SendMessageIMessage;
    };
    whatsapp: {
      getActiveWebListener: GetActiveWebListener;
      getWebAuthAgeMs: GetWebAuthAgeMs;
      logoutWeb: LogoutWeb;
      logWebSelfId: LogWebSelfId;
      readWebSelfId: ReadWebSelfId;
      webAuthExists: WebAuthExists;
      sendMessageWhatsApp: SendMessageWhatsApp;
      sendPollWhatsApp: SendPollWhatsApp;
      loginWeb: LoginWeb;
      startWebLoginWithQr: StartWebLoginWithQr;
      startWebLoginWithPairingCode: StartWebLoginWithPairingCode;
      waitForWebLogin: WaitForWebLogin;
      monitorWebChannel: MonitorWebChannel;
      handleWhatsAppAction: HandleWhatsAppAction;
      createLoginTool: CreateWhatsAppLoginTool;
    };
    line: {
      listLineAccountIds: ListLineAccountIds;
      resolveDefaultLineAccountId: ResolveDefaultLineAccountId;
      resolveLineAccount: ResolveLineAccount;
      normalizeAccountId: NormalizeLineAccountId;
      probeLineBot: ProbeLineBot;
      sendMessageLine: SendMessageLine;
      pushMessageLine: PushMessageLine;
      pushMessagesLine: PushMessagesLine;
      pushFlexMessage: PushFlexMessage;
      pushTemplateMessage: PushTemplateMessage;
      pushLocationMessage: PushLocationMessage;
      pushTextMessageWithQuickReplies: PushTextMessageWithQuickReplies;
      createQuickReplyItems: CreateQuickReplyItems;
      buildTemplateMessageFromPayload: BuildTemplateMessageFromPayload;
      monitorLineProvider: MonitorLineProvider;
    };
  };
  logging: {
    shouldLogVerbose: ShouldLogVerbose;
    getChildLogger: (
      bindings?: Record<string, unknown>,
      opts?: { level?: LogLevel },
    ) => RuntimeLogger;
  };
  state: {
    resolveStateDir: ResolveStateDir;
    /**
     * Install-wide root (never per user profile): for state that is shared by
     * every profile on this install — provider credentials, device links.
     */
    resolveSharedDir: ResolveSharedDir;
  };
  /**
   * Host hooks for first-party plugins that moved out of core. Plugins run
   * in their own module instances (jiti), so in-process buses and seams are
   * handed over here rather than imported.
   */
  host: {
    /** Agent run stream (lifecycle/tool/…); returns unsubscribe. */
    onAgentEvent: OnAgentEvent;
    /** Kanban task done / agent run completed; returns unsubscribe. */
    onWorkCompleted: OnWorkCompleted;
    /** In-app + push notification (notifications/emit). */
    emitNotification: EmitNotification;
    /** Kanban + CRM snapshot used by insight engines. */
    gatherBusinessSnapshot: GatherBusinessSnapshot;
    /** Day-planner seam provider (null clears). */
    setDayPlannerProvider: SetDayPlannerProvider;
    /** Fill (or clear with null) a core agent-tool slot. */
    setCoreToolSlot: SetCoreToolSlot;
    /** Business & Agency backend seam (core's instance; business-agency plugin). */
    businessAgency: import("../../business-agency/index.js").BusinessAgencySeam;
    /** Core's unified approval registry (create / get / cancel / events). */
    approvals: import("./security-host.js").HostApprovals;
    /** Platform BYOK KEK: wrap/unwrap per-tenant data keys (never the KEK itself). */
    kek: import("./security-host.js").HostKek;
    /** SaaS identity: mode, dedicated tenant, Clerk step-up verification. */
    saas: import("./security-host.js").HostSaas;
    /** In-app + Telegram owner alert (best-effort); `link` adds a deep link + Open link. */
    alertOwner: import("./security-host.js").HostAlert;
    /**
     * Deep link (`infinibot://…`) + https web opener for a link or web path —
     * for plugin-owned Telegram messages (docs/mobile/DEEP-LINKS.md).
     */
    linkPair?: import("./security-host.js").HostLinkPair;
    /**
     * One-shot completion on the owner's configured default model (the same
     * runLLM core uses for email/insight analysis). Plugins never see API keys.
     */
    runLLM: RunLLM;
    /**
     * One LLM turn for an external voice pipeline (the voice provider does
     * STT/TTS and calls back for the reply): runs on a gateway agent or a CLI
     * agent, streams text via onDelta, and applies voice-caller trust (W5).
     */
    voiceTurn: RunVoiceTurn;
    /**
     * Open one page in the browser the agent browser tool drives (Chrome
     * Relay / hosted Chromium), evaluate a function, close the tab. For
     * lookups plain fetches can't do (e.g. image search pages).
     */
    browser?: import("./browser-host.js").HostBrowser;
  };
};
