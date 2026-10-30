export { CHANNEL_MESSAGE_ACTION_NAMES } from "../channels/plugins/message-action-names.js";
export {
  BLUEBUBBLES_ACTIONS,
  BLUEBUBBLES_ACTION_NAMES,
  BLUEBUBBLES_GROUP_ACTIONS,
} from "../channels/plugins/bluebubbles-actions.js";
export type {
  ChannelAccountSnapshot,
  ChannelAccountState,
  ChannelAgentTool,
  ChannelAgentToolFactory,
  ChannelAuthAdapter,
  ChannelCapabilities,
  ChannelCommandAdapter,
  ChannelConfigAdapter,
  ChannelDirectoryAdapter,
  ChannelDirectoryEntry,
  ChannelDirectoryEntryKind,
  ChannelElevatedAdapter,
  ChannelGatewayAdapter,
  ChannelGatewayContext,
  ChannelGroupAdapter,
  ChannelGroupContext,
  ChannelHeartbeatAdapter,
  ChannelHeartbeatDeps,
  ChannelId,
  ChannelLogSink,
  ChannelLoginWithQrStartResult,
  ChannelLoginWithQrWaitResult,
  ChannelLogoutContext,
  ChannelLogoutResult,
  ChannelMentionAdapter,
  ChannelMessageActionAdapter,
  ChannelMessageActionContext,
  ChannelMessageActionName,
  ChannelMessagingAdapter,
  ChannelMeta,
  ChannelOutboundAdapter,
  ChannelOutboundContext,
  ChannelOutboundTargetMode,
  ChannelPairingAdapter,
  ChannelPollContext,
  ChannelPollResult,
  ChannelResolveKind,
  ChannelResolveResult,
  ChannelResolverAdapter,
  ChannelSecurityAdapter,
  ChannelSecurityContext,
  ChannelSecurityDmPolicy,
  ChannelSetupAdapter,
  ChannelSetupInput,
  ChannelStatusAdapter,
  ChannelStatusIssue,
  ChannelStreamingAdapter,
  ChannelThreadingAdapter,
  ChannelThreadingContext,
  ChannelThreadingToolContext,
  ChannelToolSend,
} from "../channels/plugins/types.js";
export type { ChannelConfigSchema, ChannelPlugin } from "../channels/plugins/types.plugin.js";
export type {
  InfiniBotPluginApi,
  InfiniBotPluginSetupCheck,
  InfiniBotPluginService,
  InfiniBotPluginServiceContext,
} from "../plugins/types.js";
export type {
  MediaCostEstimate,
  MediaEditRequest,
  MediaGenerateRequest,
  MediaGenerationJob,
  MediaGenerationProvider,
  MediaKind,
  MediaModel,
  MediaOutput,
} from "../media-generation/types.js";
export { getMediaProviderRegistry } from "../media-generation/registry.js";
export { getFederationHub } from "../federation/hub.js";
// Owner grants (incl. default-off `permissions.gated`) — see plugins/host-state.ts.
export { isPluginPermissionGranted } from "../plugins/host-state.js";
// Plugin host API v0 (manifest v2): agent-tool + chat-panel helpers.
export { callGatewayTool } from "../agents/tools/gateway.js";
export type { GatewayCallOptions } from "../agents/tools/gateway.js";
export type { AnyAgentTool } from "../agents/tools/common.js";
export type {
  ChatPanelRef,
  PanelCaller,
  PanelKindDef,
  PanelKindOutput,
  PanelLink,
  PanelQuery,
} from "../chat-panels/types.js";
// Content Studio backend seam (first-party content-studio plugin).
export { contentStudio, type ContentStudioSeam } from "../content-studio/index.js";
// Discord community seam (first-party community-manager plugin).
export {
  discordCommunity,
  type DiscordCommunitySeam,
  type DiscordCommunityEvent,
  type DiscordCommunityComponentReply,
  type DiscordCommunityUser,
} from "../discord/community-seam.js";
// Paid-plugin entitlement lookup (Pro-tier checks inside free first-party plugins).
export { entitlementFor as pluginEntitlementFor } from "../plugins/entitlements/store.js";
// Business & Agency backend seam type (first-party business-agency plugin).
// The plugin uses core's instance via api.runtime.host.businessAgency.
export type { BusinessAgencySeam } from "../business-agency/index.js";
export type { FederationHub } from "../federation/hub.js";
export type { FederationEventType } from "../federation/event-bus.js";
export type {
  GatewayRequestHandler,
  GatewayRequestHandlerOptions,
  RespondFn,
} from "../gateway/server-methods/types.js";
export type { PluginRuntime } from "../plugins/runtime/types.js";
export { normalizePluginHttpPath } from "../plugins/http-path.js";
export { registerPluginHttpRoute } from "../plugins/http-registry.js";
export { emptyPluginConfigSchema } from "../plugins/config-schema.js";
// Optional Products capability seam. Core surfaces consume the seam; the
// first-party Products plugin supplies the implementation while loaded.
export {
  registerProductStoreProvider,
  isProductStoreAvailable,
  type ProductStoreFactory,
  type ProductStoreProvider,
} from "../product/store.js";
export type {
  Product,
  ProductCreateParams,
  ProductSearchParams,
  ProductUpdateParams,
} from "../product/types.js";
// Narrow host data seams used by the first-party Products plugin. Keeping
// these exports here prevents the plugin from reaching through arbitrary core
// paths while Catalog continues to share the Databases/Notion system role.
export {
  ensureBusinessRoleDatabase,
  listRowsForBusinessRole,
  getRowForBusinessRole,
  upsertRowForBusinessRole,
  deleteRowForBusinessRole,
} from "../databases/system-role-bridge.js";
export type { PropertyValue, SystemRole } from "../databases/types.js";
export { getRelationsStore } from "../relations/store.js";
export { getAuditStore } from "../business-objects/audit.js";
export { assertSingleOwner, priorityRank } from "../business-objects/rules.js";
export { PRIORITIES } from "../business-objects/common.js";
// Voice-provider interface (api.registerVoiceProvider).
export type {
  VoiceCapability,
  VoiceProvider,
  VoiceProviderStatus,
  VoiceRealtimeRequest,
  VoiceRealtimeSession,
  VoiceWakeWordInfo,
} from "../gateway/voice/provider-registry.js";
export { VoiceProviderError } from "../gateway/voice/provider-registry.js";
// Voice LLM turns (api.runtime.host.voiceTurn) — InfiniBot as a voice pipeline's LLM step.
export type {
  RunVoiceTurn,
  VoiceLlmBackend,
  VoiceLlmTurnRequest,
  VoiceLlmTurnResult,
  VoiceTurnMessage,
  VoiceTurnMode,
  VoiceTurnTimings,
} from "../gateway/voice/voice-llm-turn.js";
export type { VoiceTimingConfig } from "../gateway/voice/voice-timing.js";
export type { VoiceSafetyFlag, VoiceModelRefs } from "../gateway/voice/commercial-safety.js";
export {
  flagVoiceModels,
  isLessacVoice,
  isOpenWakeWordDefaultModel,
} from "../gateway/voice/commercial-safety.js";
// Per-install secret encryption (AES-256-GCM, key in the shared infinibot.json) —
// the same store email accounts and per-agent secrets use.
export {
  encryptSecret as encryptInstallSecret,
  decryptSecret as decryptInstallSecret,
} from "../services/email/secret-crypto.js";
// Authorization header for a plugin calling its own gateway's HTTP routes.
export { resolveSelfCallAuthHeaders } from "../gateway/http-auth.js";
export type { AgentPersona } from "../plugins/agent-personas.js";
export { listAgentPersonas } from "../plugins/agent-personas.js";
export type { InfinibotConfig } from "../config/config.js";
export type { ChannelDock } from "../channels/dock.js";
export { getChatChannelMeta } from "../channels/registry.js";
export type {
  BlockStreamingCoalesceConfig,
  DmPolicy,
  DmConfig,
  GroupPolicy,
  GroupToolPolicyConfig,
  GroupToolPolicyBySenderConfig,
  MarkdownConfig,
  MarkdownTableMode,
  GoogleChatAccountConfig,
  GoogleChatConfig,
  GoogleChatDmConfig,
  GoogleChatGroupConfig,
  GoogleChatActionConfig,
  MSTeamsChannelConfig,
  MSTeamsConfig,
  MSTeamsReplyStyle,
  MSTeamsTeamConfig,
} from "../config/types.js";
export {
  DiscordConfigSchema,
  GoogleChatConfigSchema,
  IMessageConfigSchema,
  MSTeamsConfigSchema,
  SignalConfigSchema,
  SlackConfigSchema,
  TelegramConfigSchema,
} from "../config/zod-schema.providers-core.js";
export { WhatsAppConfigSchema } from "../config/zod-schema.providers-whatsapp.js";
export {
  BlockStreamingCoalesceSchema,
  DmConfigSchema,
  DmPolicySchema,
  GroupPolicySchema,
  MarkdownConfigSchema,
  MarkdownTableModeSchema,
  normalizeAllowFrom,
  requireOpenAllowFrom,
} from "../config/zod-schema.core.js";
export { ToolPolicySchema } from "../config/zod-schema.agent-runtime.js";
export type { RuntimeEnv } from "../runtime.js";
export type { WizardPrompter } from "../wizard/prompts.js";
export { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../routing/session-key.js";
export { resolveAckReaction } from "../agents/identity.js";
export type { ReplyPayload } from "../auto-reply/types.js";
export type { ChunkMode } from "../auto-reply/chunk.js";
export { SILENT_REPLY_TOKEN, isSilentReplyText } from "../auto-reply/tokens.js";
export { resolveToolsBySender } from "../config/group-policy.js";
export {
  buildPendingHistoryContextFromMap,
  clearHistoryEntries,
  clearHistoryEntriesIfEnabled,
  DEFAULT_GROUP_HISTORY_LIMIT,
  recordPendingHistoryEntry,
  recordPendingHistoryEntryIfEnabled,
} from "../auto-reply/reply/history.js";
export type { HistoryEntry } from "../auto-reply/reply/history.js";
export { mergeAllowlist, summarizeMapping } from "../channels/allowlists/resolve-utils.js";
export {
  resolveMentionGating,
  resolveMentionGatingWithBypass,
} from "../channels/mention-gating.js";
export type {
  AckReactionGateParams,
  AckReactionScope,
  WhatsAppAckReactionMode,
} from "../channels/ack-reactions.js";
export {
  removeAckReactionAfterReply,
  shouldAckReaction,
  shouldAckReactionForWhatsApp,
} from "../channels/ack-reactions.js";
export { createTypingCallbacks } from "../channels/typing.js";
export { createReplyPrefixContext } from "../channels/reply-prefix.js";
export { logAckFailure, logInboundDrop, logTypingFailure } from "../channels/logging.js";
export { resolveChannelMediaMaxBytes } from "../channels/plugins/media-limits.js";
export type { NormalizedLocation } from "../channels/location.js";
export { formatLocationText, toLocationContext } from "../channels/location.js";
export { resolveControlCommandGate } from "../channels/command-gating.js";
export {
  resolveBlueBubblesGroupRequireMention,
  resolveDiscordGroupRequireMention,
  resolveGoogleChatGroupRequireMention,
  resolveIMessageGroupRequireMention,
  resolveSlackGroupRequireMention,
  resolveTelegramGroupRequireMention,
  resolveWhatsAppGroupRequireMention,
  resolveBlueBubblesGroupToolPolicy,
  resolveDiscordGroupToolPolicy,
  resolveGoogleChatGroupToolPolicy,
  resolveIMessageGroupToolPolicy,
  resolveSlackGroupToolPolicy,
  resolveTelegramGroupToolPolicy,
  resolveWhatsAppGroupToolPolicy,
} from "../channels/plugins/group-mentions.js";
export { recordInboundSession } from "../channels/session.js";
export {
  buildChannelKeyCandidates,
  normalizeChannelSlug,
  resolveChannelEntryMatch,
  resolveChannelEntryMatchWithFallback,
  resolveNestedAllowlistDecision,
} from "../channels/plugins/channel-config.js";
export {
  listDiscordDirectoryGroupsFromConfig,
  listDiscordDirectoryPeersFromConfig,
  listSlackDirectoryGroupsFromConfig,
  listSlackDirectoryPeersFromConfig,
  listTelegramDirectoryGroupsFromConfig,
  listTelegramDirectoryPeersFromConfig,
  listWhatsAppDirectoryGroupsFromConfig,
  listWhatsAppDirectoryPeersFromConfig,
} from "../channels/plugins/directory-config.js";
export type { AllowlistMatch } from "../channels/plugins/allowlist-match.js";
export { formatAllowlistMatchMeta } from "../channels/plugins/allowlist-match.js";
export { optionalStringEnum, stringEnum } from "../agents/schema/typebox.js";
export type { PollInput } from "../polls.js";

export { buildChannelConfigSchema } from "../channels/plugins/config-schema.js";
export {
  deleteAccountFromConfigSection,
  setAccountEnabledInConfigSection,
} from "../channels/plugins/config-helpers.js";
export {
  applyAccountNameToChannelSection,
  migrateBaseNameToDefaultAccount,
} from "../channels/plugins/setup-helpers.js";
export { formatPairingApproveHint } from "../channels/plugins/helpers.js";
export { PAIRING_APPROVED_MESSAGE } from "../channels/plugins/pairing-message.js";

export type {
  ChannelOnboardingAdapter,
  ChannelOnboardingDmPolicy,
} from "../channels/plugins/onboarding-types.js";
export { addWildcardAllowFrom, promptAccountId } from "../channels/plugins/onboarding/helpers.js";
export { promptChannelAccessConfig } from "../channels/plugins/onboarding/channel-access.js";

export {
  createActionGate,
  imageResult,
  jsonResult,
  readNumberParam,
  readReactionParams,
  readStringParam,
} from "../agents/tools/common.js";
export { formatDocsLink } from "../terminal/links.js";
export type { HookEntry } from "../hooks/types.js";
export { normalizeE164 } from "../utils.js";
export { missingTargetError } from "../infra/outbound/target-errors.js";
export { registerLogTransport } from "../logging/logger.js";
export type { LogTransport, LogTransportRecord } from "../logging/logger.js";
export {
  emitDiagnosticEvent,
  isDiagnosticsEnabled,
  onDiagnosticEvent,
} from "../infra/diagnostic-events.js";
export type {
  DiagnosticEventPayload,
  DiagnosticHeartbeatEvent,
  DiagnosticLaneDequeueEvent,
  DiagnosticLaneEnqueueEvent,
  DiagnosticMessageProcessedEvent,
  DiagnosticMessageQueuedEvent,
  DiagnosticRunAttemptEvent,
  DiagnosticSessionState,
  DiagnosticSessionStateEvent,
  DiagnosticSessionStuckEvent,
  DiagnosticUsageEvent,
  DiagnosticWebhookErrorEvent,
  DiagnosticWebhookProcessedEvent,
  DiagnosticWebhookReceivedEvent,
} from "../infra/diagnostic-events.js";
export { detectMime, extensionForMime, getFileExtension } from "../media/mime.js";
export { extractOriginalFilename } from "../media/store.js";

// Channel: Discord
export {
  listDiscordAccountIds,
  resolveDefaultDiscordAccountId,
  resolveDiscordAccount,
  type ResolvedDiscordAccount,
} from "../discord/accounts.js";
export { collectDiscordAuditChannelIds } from "../discord/audit.js";
export { discordOnboardingAdapter } from "../channels/plugins/onboarding/discord.js";
export {
  looksLikeDiscordTargetId,
  normalizeDiscordMessagingTarget,
} from "../channels/plugins/normalize/discord.js";
export { collectDiscordStatusIssues } from "../channels/plugins/status-issues/discord.js";

// Channel: iMessage
export {
  listIMessageAccountIds,
  resolveDefaultIMessageAccountId,
  resolveIMessageAccount,
  type ResolvedIMessageAccount,
} from "../imessage/accounts.js";
export { imessageOnboardingAdapter } from "../channels/plugins/onboarding/imessage.js";
export {
  looksLikeIMessageTargetId,
  normalizeIMessageMessagingTarget,
} from "../channels/plugins/normalize/imessage.js";

// Channel: Slack
export {
  listEnabledSlackAccounts,
  listSlackAccountIds,
  resolveDefaultSlackAccountId,
  resolveSlackAccount,
  resolveSlackReplyToMode,
  type ResolvedSlackAccount,
} from "../slack/accounts.js";
export { slackOnboardingAdapter } from "../channels/plugins/onboarding/slack.js";
export {
  looksLikeSlackTargetId,
  normalizeSlackMessagingTarget,
} from "../channels/plugins/normalize/slack.js";
export { buildSlackThreadingToolContext } from "../slack/threading-tool-context.js";

// Channel: Telegram
export {
  listTelegramAccountIds,
  resolveDefaultTelegramAccountId,
  resolveTelegramAccount,
  type ResolvedTelegramAccount,
} from "../telegram/accounts.js";
export { telegramOnboardingAdapter } from "../channels/plugins/onboarding/telegram.js";
export {
  looksLikeTelegramTargetId,
  normalizeTelegramMessagingTarget,
} from "../channels/plugins/normalize/telegram.js";
export { collectTelegramStatusIssues } from "../channels/plugins/status-issues/telegram.js";

// Channel: Signal
export {
  listSignalAccountIds,
  resolveDefaultSignalAccountId,
  resolveSignalAccount,
  type ResolvedSignalAccount,
} from "../signal/accounts.js";
export { signalOnboardingAdapter } from "../channels/plugins/onboarding/signal.js";
export {
  looksLikeSignalTargetId,
  normalizeSignalMessagingTarget,
} from "../channels/plugins/normalize/signal.js";

// Channel: WhatsApp
export {
  listWhatsAppAccountIds,
  resolveDefaultWhatsAppAccountId,
  resolveWhatsAppAccount,
  type ResolvedWhatsAppAccount,
} from "../web/accounts.js";
export { isWhatsAppGroupJid, normalizeWhatsAppTarget } from "../whatsapp/normalize.js";
export { whatsappOnboardingAdapter } from "../channels/plugins/onboarding/whatsapp.js";
export { resolveWhatsAppHeartbeatRecipients } from "../channels/plugins/whatsapp-heartbeat.js";
export {
  looksLikeWhatsAppTargetId,
  normalizeWhatsAppMessagingTarget,
} from "../channels/plugins/normalize/whatsapp.js";
export { collectWhatsAppStatusIssues } from "../channels/plugins/status-issues/whatsapp.js";

// Channel: BlueBubbles
export { collectBlueBubblesStatusIssues } from "../channels/plugins/status-issues/bluebubbles.js";

// Channel: LINE
export {
  listLineAccountIds,
  normalizeAccountId as normalizeLineAccountId,
  resolveDefaultLineAccountId,
  resolveLineAccount,
} from "../line/accounts.js";
export { LineConfigSchema } from "../line/config-schema.js";
export type {
  LineConfig,
  LineAccountConfig,
  ResolvedLineAccount,
  LineChannelData,
} from "../line/types.js";
export {
  createInfoCard,
  createListCard,
  createImageCard,
  createActionCard,
  createReceiptCard,
  type CardAction,
  type ListItem,
} from "../line/flex-templates.js";
export {
  processLineMessage,
  hasMarkdownToConvert,
  stripMarkdown,
} from "../line/markdown-to-line.js";
export type { ProcessedLineMessage } from "../line/markdown-to-line.js";

// Media utilities
export { loadWebMedia, type WebMediaResult } from "../web/media.js";

// Plugin appearance (browser-side helpers for plugin UIs; pure DOM).
export {
  PLUGIN_APPEARANCE_EVENT,
  PLUGIN_APPEARANCE_MESSAGE,
  appearanceBridgeMessage,
  findPluginScope,
  listenPluginAppearanceBridge,
  onPluginAppearanceChange,
  readPluginAppearance,
  type PluginAppearanceBridgeMessage,
  type PluginAppearanceSnapshot,
} from "./appearance-client.js";
export type {
  PluginAppearanceManifest,
  PluginAppearanceOverride,
  ResolvedPluginAppearance,
} from "../plugins/appearance.js";

// ── canvas-library plugin seam ──────────────────────────────────────────────
// Core canvas runtime (saved canvases, converters, narration) for the
// HoloCanvas library plugin (extensions/canvas-library). Lazy-loading.
export {
  canvasRuntime,
  type CanvasRuntime,
  type CanvasSource,
  type ConvertedCanvas,
  type SavedCanvas,
  type SavedCanvasStore,
} from "../canvas-host/plugin-seam.js";
// ── end canvas-library ──────────────────────────────────────────────────────
// ── network guards ──────────────────────────────────────────────────────────
// For plugins that fetch URLs they did not choose (search results, cited
// pages): refuse loopback, private, link-local and Fly 6PN addresses.
export {
  SsrFBlockedError,
  assertPublicHostname,
  isBlockedHostname,
  isPrivateIpAddress,
} from "../infra/net/ssrf.js";
