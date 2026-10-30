/**
 * Engagement Engine Tests
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  FlowMatcher,
  RateLimiter,
  TemplateProcessor,
  type IncomingMessage,
  type EngagementFlow,
} from "./engagement-engine.js";

describe("FlowMatcher", () => {
  let matcher: FlowMatcher;

  beforeEach(() => {
    matcher = new FlowMatcher();
  });

  const createFlow = (overrides: Partial<EngagementFlow> = {}): EngagementFlow => ({
    id: 1,
    platform: "instagram",
    accountId: "test123",
    name: "Test Flow",
    triggerType: "keyword",
    triggerKeywords: JSON.stringify(["FREE", "INFO"]),
    responseType: "template",
    responseTemplate: "Hello {{username}}!",
    enabled: true,
    triggerCount: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  });

  const createMessage = (content: string): IncomingMessage => ({
    platform: "instagram",
    accountId: "test123",
    senderId: "user456",
    senderUsername: "testuser",
    messageId: "msg789",
    content,
    messageType: "dm",
    timestamp: Date.now(),
  });

  it("matches exact keyword (case-insensitive)", () => {
    const flows = [createFlow()];
    const message = createMessage("I want FREE stuff");

    const result = matcher.match(message, flows);

    expect(result.matched).toBe(true);
    expect(result.matchedKeywords).toContain("free");
  });

  it("matches multiple keywords", () => {
    const flows = [createFlow()];
    const message = createMessage("Give me FREE INFO please");

    const result = matcher.match(message, flows);

    expect(result.matched).toBe(true);
    expect(result.matchedKeywords).toContain("free");
    expect(result.matchedKeywords).toContain("info");
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  it("does not match when no keywords present", () => {
    const flows = [createFlow()];
    const message = createMessage("Hello there");

    const result = matcher.match(message, flows);

    expect(result.matched).toBe(false);
    expect(result.matchedKeywords).toHaveLength(0);
  });

  it("matches wildcard patterns", () => {
    const flows = [createFlow({
      triggerKeywords: JSON.stringify(["PASS*"]),
    })];

    expect(matcher.match(createMessage("Tell me about PASSIVE income"), flows).matched).toBe(true);
    expect(matcher.match(createMessage("Get your PASSPORT"), flows).matched).toBe(true);
    expect(matcher.match(createMessage("No match here"), flows).matched).toBe(false);
  });

  it("respects enabled flag", () => {
    const flows = [createFlow({ enabled: false })];
    const message = createMessage("FREE stuff");

    const result = matcher.match(message, flows);

    expect(result.matched).toBe(false);
  });

  it("matches trigger type correctly", () => {
    const flows = [createFlow({ triggerType: "comment" })];
    
    // DM should not match comment trigger
    const dmMessage = createMessage("FREE");
    expect(matcher.match(dmMessage, flows).matched).toBe(false);

    // Comment should match
    const commentMessage = { ...createMessage("FREE"), messageType: "comment" as const };
    expect(matcher.match(commentMessage, flows).matched).toBe(true);
  });

  it("testFlow works independently", () => {
    const flow = createFlow();
    
    const result = matcher.testFlow("Give me FREE stuff", flow);
    
    expect(result.matched).toBe(true);
    expect(result.matchedKeywords).toContain("free");
  });
});

describe("RateLimiter", () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter({
      perUserCooldownSec: 60,
      dailyLimitPerUser: 5,
      dailyLimitPerAccount: 20,
    });
  });

  it("allows first response", () => {
    const result = limiter.canRespond("instagram", "acc1", "user1");
    expect(result.allowed).toBe(true);
  });

  it("blocks during cooldown", () => {
    limiter.recordResponse("instagram", "acc1", "user1");
    
    const result = limiter.canRespond("instagram", "acc1", "user1");
    
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("cooldown");
    expect(result.retryAfterMs).toBeDefined();
  });

  it("tracks daily user limits", () => {
    // Fill up daily limit
    for (let i = 0; i < 5; i++) {
      limiter.recordResponse("instagram", "acc1", "user1");
      // Reset cooldown for each by manipulating internal state
      (limiter as any).userLimits.get("instagram:acc1:user1").lastResponseTime = 0;
    }

    const result = limiter.canRespond("instagram", "acc1", "user1");
    
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Daily limit");
  });

  it("tracks account daily limits", () => {
    // Record responses from different users until account limit
    for (let i = 0; i < 20; i++) {
      limiter.recordResponse("instagram", "acc1", `user${i}`);
    }

    const result = limiter.canRespond("instagram", "acc1", "newuser");
    
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("account");
  });

  it("provides usage stats", () => {
    limiter.recordResponse("instagram", "acc1", "user1");
    limiter.recordResponse("instagram", "acc1", "user2");

    const stats = limiter.getStats("instagram", "acc1");
    
    expect(stats.accountResponsesToday).toBe(2);
    expect(stats.activeUsers).toBe(2);
    expect(stats.accountDailyLimit).toBe(20);
  });
});

describe("TemplateProcessor", () => {
  let processor: TemplateProcessor;

  beforeEach(() => {
    processor = new TemplateProcessor();
  });

  it("replaces username variable", () => {
    const result = processor.process("Hello {{username}}!", { username: "John" });
    expect(result).toBe("Hello John!");
  });

  it("replaces keyword variable", () => {
    const result = processor.process("You asked about {{keyword}}", { 
      keyword: "PASSIVE",
      matchedKeywords: ["passive", "income"],
    });
    expect(result).toBe("You asked about PASSIVE");
  });

  it("replaces multiple keywords", () => {
    const result = processor.process("Keywords: {{keywords}}", {
      matchedKeywords: ["free", "info"],
    });
    expect(result).toBe("Keywords: free, info");
  });

  it("uses fallback for missing username", () => {
    const result = processor.process("Hi {{username}}", {});
    expect(result).toBe("Hi friend");
  });

  it("handles date and time", () => {
    const result = processor.process("Today is {{date}}", {});
    expect(result).toMatch(/\d/); // Contains at least one digit
  });

  it("is case-insensitive for variable names", () => {
    const result = processor.process("Hi {{USERNAME}}", { username: "Test" });
    expect(result).toBe("Hi Test");
  });
});
