/**
 * AI Engagement Automation Engine
 * Processes Instagram DMs/comments and triggers AI responses
 */

import {
  getSocialAnalyticsStore,
  type EngagementFlow,
  type Conversation,
  type Message,
} from "./analytics-store.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("engagement-engine");

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface IncomingMessage {
  platform: string;
  accountId: string;
  senderId: string;
  senderUsername: string;
  messageId: string;
  content: string;
  mediaUrl?: string;
  messageType: "dm" | "comment" | "mention" | "story_reply";
  timestamp: number;
  /** Optional context for AI (e.g., post caption for comments) */
  context?: string;
}

export interface FlowMatchResult {
  matched: boolean;
  flow?: EngagementFlow;
  matchedKeywords: string[];
  confidence: number; // 0-1 score
}

export interface ExecutionResult {
  success: boolean;
  response?: string;
  flowId?: number;
  error?: string;
  rateLimited?: boolean;
  queuedForLater?: boolean;
}

export interface ConversationContext {
  conversation: Conversation;
  recentMessages: Message[];
  tags: string[];
}

/** Callback for AI response generation - allows injecting agent infrastructure */
export type AIResponseCallback = (opts: {
  prompt: string;
  context: ConversationContext;
  message: IncomingMessage;
}) => Promise<string>;

export interface EngagementEngineConfig {
  stateDir: string;
  /** Callback for AI response generation */
  aiResponder?: AIResponseCallback;
  /** Default rate limit settings */
  rateLimits?: {
    /** Minimum seconds between responses to same user (default: 60) */
    perUserCooldownSec: number;
    /** Max responses per user per day (default: 10) */
    dailyLimitPerUser: number;
    /** Max total responses per day per account (default: 100) */
    dailyLimitPerAccount: number;
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// FLOW MATCHER
// ═══════════════════════════════════════════════════════════════════════════

export class FlowMatcher {
  /**
   * Match incoming message against trigger rules
   * Supports:
   * - Exact keywords (case-insensitive)
   * - Wildcards (* matches any sequence)
   * - Multiple keywords (any match triggers)
   */
  match(message: IncomingMessage, flows: EngagementFlow[]): FlowMatchResult {
    const content = message.content.toLowerCase().trim();

    // Filter flows by message type and enabled status
    const eligibleFlows = flows.filter(
      (f) => f.enabled && this.matchesTriggerType(f.triggerType, message.messageType),
    );

    for (const flow of eligibleFlows) {
      const keywords = this.parseKeywords(flow.triggerKeywords);
      const matchResult = this.matchKeywords(content, keywords);

      if (matchResult.matched) {
        return {
          matched: true,
          flow,
          matchedKeywords: matchResult.matchedKeywords,
          confidence: matchResult.confidence,
        };
      }
    }

    return { matched: false, matchedKeywords: [], confidence: 0 };
  }

  private matchesTriggerType(triggerType: string, messageType: string): boolean {
    // 'keyword' trigger matches any message type
    if (triggerType === "keyword") return true;
    // Otherwise must match exactly
    return triggerType === messageType;
  }

  private parseKeywords(keywordsJson: string): string[] {
    try {
      const parsed = JSON.parse(keywordsJson);
      return Array.isArray(parsed) ? parsed.map((k) => String(k).toLowerCase()) : [];
    } catch {
      // Fallback: treat as single keyword
      return keywordsJson ? [keywordsJson.toLowerCase()] : [];
    }
  }

  private matchKeywords(
    content: string,
    keywords: string[],
  ): { matched: boolean; matchedKeywords: string[]; confidence: number } {
    const matched: string[] = [];

    for (const keyword of keywords) {
      if (this.matchSingleKeyword(content, keyword)) {
        matched.push(keyword);
      }
    }

    if (matched.length === 0) {
      return { matched: false, matchedKeywords: [], confidence: 0 };
    }

    // Confidence based on how many keywords matched and their specificity
    const confidence = Math.min(1, matched.length / keywords.length + 0.2);

    return { matched: true, matchedKeywords: matched, confidence };
  }

  private matchSingleKeyword(content: string, keyword: string): boolean {
    // Handle wildcards
    if (keyword.includes("*")) {
      const pattern = keyword
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&") // Escape regex special chars
        .replace(/\\\*/g, ".*"); // Convert * to .*
      const regex = new RegExp(`\\b${pattern}\\b`, "i");
      return regex.test(content);
    }

    // Exact word match (case-insensitive, word boundaries)
    const escapedKeyword = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`\\b${escapedKeyword}\\b`, "i");
    return regex.test(content);
  }

  /**
   * Test a message against a specific flow (for testing UI)
   */
  testFlow(content: string, flow: EngagementFlow): FlowMatchResult {
    const keywords = this.parseKeywords(flow.triggerKeywords);
    const result = this.matchKeywords(content.toLowerCase(), keywords);

    return {
      matched: result.matched,
      flow: result.matched ? flow : undefined,
      matchedKeywords: result.matchedKeywords,
      confidence: result.confidence,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// RATE LIMITER
// ═══════════════════════════════════════════════════════════════════════════

interface RateLimitEntry {
  lastResponseTime: number;
  responsesToday: number;
  dateKey: string; // YYYY-MM-DD for daily reset
}

export class RateLimiter {
  private userLimits: Map<string, RateLimitEntry> = new Map();
  private accountDailyCount: Map<string, { count: number; dateKey: string }> = new Map();

  private perUserCooldownMs: number;
  private dailyLimitPerUser: number;
  private dailyLimitPerAccount: number;

  constructor(config?: {
    perUserCooldownSec?: number;
    dailyLimitPerUser?: number;
    dailyLimitPerAccount?: number;
  }) {
    this.perUserCooldownMs = (config?.perUserCooldownSec ?? 60) * 1000;
    this.dailyLimitPerUser = config?.dailyLimitPerUser ?? 10;
    this.dailyLimitPerAccount = config?.dailyLimitPerAccount ?? 100;
  }

  private getDateKey(): string {
    return new Date().toISOString().split("T")[0];
  }

  private getUserKey(platform: string, accountId: string, userId: string): string {
    return `${platform}:${accountId}:${userId}`;
  }

  private getAccountKey(platform: string, accountId: string): string {
    return `${platform}:${accountId}`;
  }

  /**
   * Check if a response can be sent
   */
  canRespond(
    platform: string,
    accountId: string,
    userId: string,
  ): { allowed: boolean; reason?: string; retryAfterMs?: number } {
    const now = Date.now();
    const dateKey = this.getDateKey();
    const userKey = this.getUserKey(platform, accountId, userId);
    const accountKey = this.getAccountKey(platform, accountId);

    // Check per-user cooldown
    const userEntry = this.userLimits.get(userKey);
    if (userEntry) {
      // Reset daily count if new day
      if (userEntry.dateKey !== dateKey) {
        userEntry.responsesToday = 0;
        userEntry.dateKey = dateKey;
      }

      // Check cooldown
      const timeSinceLastResponse = now - userEntry.lastResponseTime;
      if (timeSinceLastResponse < this.perUserCooldownMs) {
        return {
          allowed: false,
          reason: "User cooldown active",
          retryAfterMs: this.perUserCooldownMs - timeSinceLastResponse,
        };
      }

      // Check daily user limit
      if (userEntry.responsesToday >= this.dailyLimitPerUser) {
        return {
          allowed: false,
          reason: `Daily limit reached for user (${this.dailyLimitPerUser})`,
        };
      }
    }

    // Check account daily limit
    const accountEntry = this.accountDailyCount.get(accountKey);
    if (accountEntry) {
      if (accountEntry.dateKey !== dateKey) {
        accountEntry.count = 0;
        accountEntry.dateKey = dateKey;
      }
      if (accountEntry.count >= this.dailyLimitPerAccount) {
        return {
          allowed: false,
          reason: `Daily limit reached for account (${this.dailyLimitPerAccount})`,
        };
      }
    }

    return { allowed: true };
  }

  /**
   * Record that a response was sent
   */
  recordResponse(platform: string, accountId: string, userId: string): void {
    const now = Date.now();
    const dateKey = this.getDateKey();
    const userKey = this.getUserKey(platform, accountId, userId);
    const accountKey = this.getAccountKey(platform, accountId);

    // Update user entry
    const userEntry = this.userLimits.get(userKey);
    if (userEntry) {
      userEntry.lastResponseTime = now;
      userEntry.responsesToday++;
      userEntry.dateKey = dateKey;
    } else {
      this.userLimits.set(userKey, {
        lastResponseTime: now,
        responsesToday: 1,
        dateKey,
      });
    }

    // Update account entry
    const accountEntry = this.accountDailyCount.get(accountKey);
    if (accountEntry) {
      accountEntry.count++;
      accountEntry.dateKey = dateKey;
    } else {
      this.accountDailyCount.set(accountKey, { count: 1, dateKey });
    }
  }

  /**
   * Get current usage stats
   */
  getStats(
    platform: string,
    accountId: string,
  ): {
    accountResponsesToday: number;
    accountDailyLimit: number;
    activeUsers: number;
  } {
    const dateKey = this.getDateKey();
    const accountKey = this.getAccountKey(platform, accountId);

    const accountEntry = this.accountDailyCount.get(accountKey);
    const accountResponsesToday = accountEntry?.dateKey === dateKey ? accountEntry.count : 0;

    // Count active users for this account today
    let activeUsers = 0;
    for (const [key, entry] of this.userLimits) {
      if (key.startsWith(accountKey) && entry.dateKey === dateKey && entry.responsesToday > 0) {
        activeUsers++;
      }
    }

    return {
      accountResponsesToday,
      accountDailyLimit: this.dailyLimitPerAccount,
      activeUsers,
    };
  }

  /**
   * Clear all rate limit data (for testing)
   */
  clear(): void {
    this.userLimits.clear();
    this.accountDailyCount.clear();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// RESPONSE QUEUE
// ═══════════════════════════════════════════════════════════════════════════

interface QueuedResponse {
  message: IncomingMessage;
  flow: EngagementFlow;
  scheduledTime: number;
  attempts: number;
}

export class ResponseQueue {
  private queue: QueuedResponse[] = [];
  private processing = false;

  constructor(private processCallback: (item: QueuedResponse) => Promise<void>) {}

  /**
   * Add a response to the queue for later processing
   */
  enqueue(message: IncomingMessage, flow: EngagementFlow, delayMs: number): void {
    this.queue.push({
      message,
      flow,
      scheduledTime: Date.now() + delayMs,
      attempts: 0,
    });
    this.scheduleProcessing();
  }

  private scheduleProcessing(): void {
    if (this.processing) return;

    const nextItem = this.queue.find((item) => item.scheduledTime <= Date.now());
    if (!nextItem) {
      // Schedule for next item
      const earliest = Math.min(...this.queue.map((i) => i.scheduledTime));
      if (earliest > Date.now()) {
        setTimeout(() => this.process(), earliest - Date.now() + 100);
      }
      return;
    }

    void this.process();
  }

  private async process(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    try {
      const now = Date.now();
      const ready = this.queue.filter((item) => item.scheduledTime <= now);

      for (const item of ready) {
        try {
          await this.processCallback(item);
          // Remove from queue on success
          const idx = this.queue.indexOf(item);
          if (idx !== -1) this.queue.splice(idx, 1);
        } catch {
          item.attempts++;
          if (item.attempts >= 3) {
            // Remove after 3 failed attempts
            const idx = this.queue.indexOf(item);
            if (idx !== -1) this.queue.splice(idx, 1);
            log.error("Dropping queued response after 3 attempts", {
              messageId: item.message.messageId,
            });
          } else {
            // Retry in 30 seconds
            item.scheduledTime = Date.now() + 30000;
          }
        }
      }
    } finally {
      this.processing = false;
      if (this.queue.length > 0) {
        this.scheduleProcessing();
      }
    }
  }

  /**
   * Get queue size
   */
  size(): number {
    return this.queue.length;
  }

  /**
   * Clear queue (for testing)
   */
  clear(): void {
    this.queue = [];
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// TEMPLATE PROCESSOR
// ═══════════════════════════════════════════════════════════════════════════

export class TemplateProcessor {
  /**
   * Process template with variable substitution
   * Supports: {{username}}, {{keyword}}, {{date}}, {{time}}
   */
  process(
    template: string,
    vars: {
      username?: string;
      keyword?: string;
      matchedKeywords?: string[];
      content?: string;
      platform?: string;
    },
  ): string {
    let result = template;

    // Replace variables
    result = result.replace(/\{\{username\}\}/gi, vars.username || "friend");
    result = result.replace(/\{\{keyword\}\}/gi, vars.keyword || vars.matchedKeywords?.[0] || "");
    result = result.replace(/\{\{keywords\}\}/gi, vars.matchedKeywords?.join(", ") || "");
    result = result.replace(/\{\{content\}\}/gi, vars.content || "");
    result = result.replace(/\{\{platform\}\}/gi, vars.platform || "");

    // Date/time
    const now = new Date();
    result = result.replace(/\{\{date\}\}/gi, now.toLocaleDateString());
    result = result.replace(/\{\{time\}\}/gi, now.toLocaleTimeString());

    return result;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// FLOW EXECUTOR
// ═══════════════════════════════════════════════════════════════════════════

export class FlowExecutor {
  private store: ReturnType<typeof getSocialAnalyticsStore>;
  private templateProcessor: TemplateProcessor;
  private aiResponder?: AIResponseCallback;

  constructor(stateDir: string, aiResponder?: AIResponseCallback) {
    this.store = getSocialAnalyticsStore(stateDir);
    this.templateProcessor = new TemplateProcessor();
    this.aiResponder = aiResponder;
  }

  /**
   * Execute a matched flow and generate a response
   */
  async execute(
    message: IncomingMessage,
    flow: EngagementFlow,
    matchResult: FlowMatchResult,
  ): Promise<{ response: string; conversationId: number }> {
    // 1. Upsert conversation
    const conversation = this.store.upsertConversation({
      platform: message.platform,
      accountId: message.accountId,
      recipientId: message.senderId,
      recipientUsername: message.senderUsername,
      lastMessage: message.content,
      lastMessageAt: message.timestamp,
      isLead: true, // Mark as lead since they triggered a flow
      tags: JSON.stringify([flow.name, ...matchResult.matchedKeywords]),
      flowState: flow.name,
    });

    // 2. Save inbound message
    this.store.saveMessage({
      conversationId: conversation.id!,
      platform: message.platform,
      messageId: message.messageId,
      direction: "inbound",
      content: message.content,
      mediaUrl: message.mediaUrl,
      triggeredFlow: flow.name,
      sentAt: message.timestamp,
    });

    // 3. Generate response based on flow type
    let response: string;

    if (flow.responseType === "template" && flow.responseTemplate) {
      // Template response
      response = this.templateProcessor.process(flow.responseTemplate, {
        username: message.senderUsername,
        matchedKeywords: matchResult.matchedKeywords,
        content: message.content,
        platform: message.platform,
      });
    } else if (flow.responseType === "ai" && flow.aiPrompt) {
      // AI response
      if (!this.aiResponder) {
        throw new Error("AI responder not configured");
      }

      const recentMessages = this.store.getMessages(conversation.id!, 10);
      const context: ConversationContext = {
        conversation,
        recentMessages,
        tags: this.parseTags(conversation.tags),
      };

      response = await this.aiResponder({
        prompt: flow.aiPrompt,
        context,
        message,
      });
    } else {
      throw new Error(`Unsupported response type: ${flow.responseType}`);
    }

    // 4. Update flow trigger count
    this.store.updateFlowTriggerCount(flow.id!);

    log.info("Flow executed", {
      flowName: flow.name,
      userId: message.senderId,
      responseType: flow.responseType,
    });

    return { response, conversationId: conversation.id! };
  }

  /**
   * Tag a lead in the database
   */
  tagLead(conversationId: number, tags: string[]): void {
    // Get existing conversation and merge tags
    // This is a simplified version - could be enhanced with a dedicated method
    log.info("Lead tagged", { conversationId, tags });
  }

  private parseTags(tagsJson: string | null): string[] {
    if (!tagsJson) return [];
    try {
      return JSON.parse(tagsJson);
    } catch {
      return [];
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN ENGINE
// ═══════════════════════════════════════════════════════════════════════════

export class EngagementEngine {
  private store: ReturnType<typeof getSocialAnalyticsStore>;
  private matcher: FlowMatcher;
  private rateLimiter: RateLimiter;
  private executor: FlowExecutor;
  private queue: ResponseQueue;
  private config: EngagementEngineConfig;

  constructor(config: EngagementEngineConfig) {
    this.config = config;
    this.store = getSocialAnalyticsStore(config.stateDir);
    this.matcher = new FlowMatcher();
    this.rateLimiter = new RateLimiter(config.rateLimits);
    this.executor = new FlowExecutor(config.stateDir, config.aiResponder);

    // Setup queue with retry callback
    this.queue = new ResponseQueue(async (item) => {
      await this.processMessage(item.message);
    });
  }

  /**
   * Process an incoming message
   * This is the main entry point for the engine
   */
  async processMessage(message: IncomingMessage): Promise<ExecutionResult> {
    try {
      log.debug("Processing message", {
        platform: message.platform,
        senderId: message.senderId,
        type: message.messageType,
      });

      // 1. Check rate limits
      const rateCheck = this.rateLimiter.canRespond(
        message.platform,
        message.accountId,
        message.senderId,
      );

      if (!rateCheck.allowed) {
        log.debug("Rate limited", {
          reason: rateCheck.reason,
          retryAfterMs: rateCheck.retryAfterMs,
        });

        // Queue for later if just cooldown
        if (rateCheck.retryAfterMs) {
          const flows = this.store.getEngagementFlows(message.platform, message.accountId);
          const matchResult = this.matcher.match(message, flows);
          if (matchResult.matched && matchResult.flow) {
            this.queue.enqueue(message, matchResult.flow, rateCheck.retryAfterMs);
            return {
              success: false,
              rateLimited: true,
              queuedForLater: true,
              error: rateCheck.reason,
            };
          }
        }

        return {
          success: false,
          rateLimited: true,
          error: rateCheck.reason,
        };
      }

      // 2. Get flows and match
      const flows = this.store.getEngagementFlows(message.platform, message.accountId);
      const matchResult = this.matcher.match(message, flows);

      if (!matchResult.matched || !matchResult.flow) {
        log.debug("No flow matched", {
          content: message.content.slice(0, 50),
          flowCount: flows.length,
        });
        return { success: false, error: "No matching flow" };
      }

      log.info("Flow matched", {
        flowName: matchResult.flow.name,
        keywords: matchResult.matchedKeywords,
        confidence: matchResult.confidence,
      });

      // 3. Execute flow
      const { response, conversationId } = await this.executor.execute(
        message,
        matchResult.flow,
        matchResult,
      );

      // 4. Record rate limit
      this.rateLimiter.recordResponse(message.platform, message.accountId, message.senderId);

      // 5. Save outbound message
      const outboundMessageId = `out_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      this.store.saveMessage({
        conversationId,
        platform: message.platform,
        messageId: outboundMessageId,
        direction: "outbound",
        content: response,
        sentAt: Date.now(),
      });

      return {
        success: true,
        response,
        flowId: matchResult.flow.id,
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error("Error processing message", { error: errorMessage });
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Test a flow with sample input (doesn't execute, just checks match)
   */
  testFlow(
    flowId: number,
    sampleContent: string,
    platform: string,
    accountId: string,
  ): FlowMatchResult & { responsePreview?: string } {
    const flows = this.store.getEngagementFlows(platform, accountId);
    const flow = flows.find((f) => f.id === flowId);

    if (!flow) {
      return { matched: false, matchedKeywords: [], confidence: 0 };
    }

    const result = this.matcher.testFlow(sampleContent, flow);

    // Generate preview if template response
    let responsePreview: string | undefined;
    if (result.matched && flow.responseType === "template" && flow.responseTemplate) {
      const templateProcessor = new TemplateProcessor();
      responsePreview = templateProcessor.process(flow.responseTemplate, {
        username: "TestUser",
        matchedKeywords: result.matchedKeywords,
        content: sampleContent,
        platform,
      });
    }

    return { ...result, responsePreview };
  }

  /**
   * Toggle flow enabled/disabled
   */
  toggleFlow(flowId: number, enabled: boolean): boolean {
    try {
      const db = (this.store as any).db;
      db.prepare(`
        UPDATE engagement_flows 
        SET enabled = ?, updated_at = ?
        WHERE id = ?
      `).run(enabled ? 1 : 0, Date.now(), flowId);

      log.info("Flow toggled", { flowId, enabled });
      return true;
    } catch (err) {
      log.error("Failed to toggle flow", { flowId, error: err });
      return false;
    }
  }

  /**
   * Get flow performance stats
   */
  getFlowStats(
    platform: string,
    accountId: string,
  ): {
    flows: Array<{
      id: number;
      name: string;
      enabled: boolean;
      triggerCount: number;
      lastTriggered: number | null;
      responseType: string;
    }>;
    rateLimitStats: {
      accountResponsesToday: number;
      accountDailyLimit: number;
      activeUsers: number;
    };
    queueSize: number;
  } {
    const flows = this.store.getEngagementFlows(platform, accountId);
    const rateLimitStats = this.rateLimiter.getStats(platform, accountId);

    return {
      flows: flows.map((f) => ({
        id: f.id!,
        name: f.name,
        enabled: f.enabled,
        triggerCount: f.triggerCount,
        lastTriggered: f.lastTriggered || null,
        responseType: f.responseType,
      })),
      rateLimitStats,
      queueSize: this.queue.size(),
    };
  }

  /**
   * Set AI responder callback
   */
  setAIResponder(callback: AIResponseCallback): void {
    this.config.aiResponder = callback;
    (this.executor as any).aiResponder = callback;
  }

  /**
   * Get the flow matcher (for direct access/testing)
   */
  getMatcher(): FlowMatcher {
    return this.matcher;
  }

  /**
   * Get rate limiter (for testing/reset)
   */
  getRateLimiter(): RateLimiter {
    return this.rateLimiter;
  }

  /**
   * Get queue (for monitoring)
   */
  getQueue(): ResponseQueue {
    return this.queue;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SINGLETON ACCESS
// ═══════════════════════════════════════════════════════════════════════════

let _engine: EngagementEngine | null = null;

export function getEngagementEngine(config?: EngagementEngineConfig): EngagementEngine {
  if (!_engine && config) {
    _engine = new EngagementEngine(config);
  }
  if (!_engine) {
    throw new Error("EngagementEngine not initialized - call with config first");
  }
  return _engine;
}

export function resetEngagementEngine(): void {
  _engine = null;
}
