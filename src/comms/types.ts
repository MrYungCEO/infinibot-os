/**
 * Comms Hub — unified multi-platform client communication types.
 *
 * Every supported channel (email/gmail, whatsapp, telegram, discord, instagram)
 * normalizes to the SAME message model so the inbox, threading and reply UI
 * never branch on channel except for capability hints.
 *
 * See docs/features/comms-hub.md for the architecture.
 */

export const COMMS_CHANNELS = [
  "email",
  "whatsapp",
  "telegram",
  "discord",
  "instagram",
] as const;

export type CommsChannel = (typeof COMMS_CHANNELS)[number];

export function isCommsChannel(value: unknown): value is CommsChannel {
  return typeof value === "string" && (COMMS_CHANNELS as readonly string[]).includes(value);
}

export type MessageDirection = "inbound" | "outbound";

export type MessageStatus =
  | "received" // inbound, landed in the inbox
  | "queued" // outbound, accepted, not yet sent
  | "sent" // outbound, delivered to the channel
  | "failed" // outbound, send threw
  | "draft" // outbound, saved but not submitted
  | "pending_approval"; // outbound, an agent drafted it, awaiting operator approval

/**
 * Autonomy levels for an agent granted the `communication` capability.
 */
export type AutonomyLevel =
  | "suggest_only" // agent may only propose; nothing is written into a thread
  | "draft_for_approval" // agent writes a draft; operator must approve to send
  | "full_auto"; // agent sends without human approval

export type AutonomyOutcome = "allow" | "needs_approval" | "deny";

export interface AutonomyDecision {
  outcome: AutonomyOutcome;
  reason: string;
  autonomy: AutonomyLevel | null;
}

/**
 * The unified message. Adapters produce this from their channel-native payload
 * and consume it (the outbound half) when sending.
 */
export interface NormalizedMessage {
  id: string;
  channel: CommsChannel;
  direction: MessageDirection;
  /** `${clientId}:${channel}` — groups a conversation into a thread. */
  threadKey: string;
  clientId: string | null;
  agencyId: string;
  /** Which of OUR accounts sent/received this (e.g. telegram accountId). */
  channelAccountId: string | null;
  /** The client's handle on this channel (telegram chatId, email addr, @ig …). */
  peerHandle: string;
  peerDisplayName: string | null;
  text: string;
  mediaUrls: string[];
  /** The id the channel assigned (telegram messageId, email Message-ID …). */
  channelMessageId: string | null;
  status: MessageStatus;
  sentByAgentId: string | null;
  autonomyDecision: AutonomyDecision | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * A thread rollup — derived from messages sharing a `threadKey`.
 */
export interface CommsThread {
  threadKey: string;
  channel: CommsChannel;
  clientId: string | null;
  clientName: string | null;
  peerHandle: string;
  peerDisplayName: string | null;
  assignedAgentId: string | null;
  lastMessageAt: number;
  lastMessagePreview: string;
  lastDirection: MessageDirection;
  unreadCount: number;
  messageCount: number;
}

// ── Client channel preferences (stored in Client.data.comms) ──────────────────

export interface ClientCommsPrefs {
  preferredChannel: CommsChannel | null;
  /** Per-channel handle overrides. Falls back to the Client column when absent. */
  handles: Partial<Record<CommsChannel, string>>;
  /** The "PM" agent that owns this client's communication. */
  assignedAgentId: string | null;
  /** Channels the client asked NOT to be contacted on. */
  optOut: CommsChannel[];
}

export function emptyClientCommsPrefs(): ClientCommsPrefs {
  return { preferredChannel: null, handles: {}, assignedAgentId: null, optOut: [] };
}

// ── Agent communication permission (autonomy) ─────────────────────────────────

export interface AgentCommsPermission {
  agentId: string;
  enabled: boolean;
  autonomy: AutonomyLevel;
  /** Channels this agent may use. Empty = none. */
  channels: CommsChannel[];
  /** "all" clients, or an explicit clientId allowlist. */
  clientScope: "all" | string[];
  /** Max outbound sends per rolling day. null = unlimited. */
  dailySendLimit: number | null;
  updatedAt: number;
}

// ── Channel adapter interface ─────────────────────────────────────────────────

export interface AdapterStatus {
  channel: CommsChannel;
  /** Are creds present so this channel could send/receive? */
  configured: boolean;
  /** Is the channel enabled (not disabled in config)? */
  enabled: boolean;
  /** Which account will be used (channel-native id), if resolvable. */
  accountId: string | null;
  /** Human-readable next-step when not configured. */
  setupNotes: string | null;
}

export interface OutboundSend {
  channel: CommsChannel;
  agencyId: string;
  clientId: string | null;
  /** The client's handle on this channel (chatId, email, @ig …). */
  peerHandle: string;
  text: string;
  mediaUrls?: string[];
  channelAccountId?: string | null;
}

export interface SendResult {
  channelMessageId: string | null;
  channelAccountId: string | null;
}

/**
 * A pluggable per-channel transport. Registered in adapters/index.ts.
 */
export interface ChannelAdapter {
  channel: CommsChannel;
  /** Is this channel usable right now? */
  status(): Promise<AdapterStatus>;
  /** Send an outbound message. Throws on hard failure. */
  send(req: OutboundSend): Promise<SendResult>;
  /** Normalize a raw inbound channel payload into a NormalizedMessage. */
  normalizeInbound(raw: unknown): NormalizedMessage | null;
  /** Best-effort map a channel-native handle to one of our clients. */
  resolveClient?(peerHandle: string, agencyId: string): string | null;
}

/** Build the canonical thread key for a client+channel conversation. */
export function threadKeyFor(clientId: string | null, channel: CommsChannel, peerHandle: string): string {
  // Unmatched inbound messages (no clientId) still get a stable thread keyed by handle.
  return `${clientId ?? `anon:${peerHandle}`}:${channel}`;
}
