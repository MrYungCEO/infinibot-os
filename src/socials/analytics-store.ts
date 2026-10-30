/**
 * Social Analytics Store
 * Persistent database for tracking social media metrics over time
 */

import Database from "better-sqlite3";
import { resolve } from "node:path";
import { mkdirSync } from "node:fs";

export interface ProfileSnapshot {
  id?: number;
  platform: string;
  accountId: string;
  username: string;
  followers: number;
  following: number;
  posts: number;
  reach?: number;
  profileViews?: number;
  websiteClicks?: number;
  accountsEngaged?: number;
  timestamp: number;
  date: string; // YYYY-MM-DD for daily aggregation
}

export interface PostMetric {
  id?: number;
  platform: string;
  accountId: string;
  postId: string;
  mediaType: 'IMAGE' | 'VIDEO' | 'CAROUSEL_ALBUM' | 'REELS' | 'STORY';
  permalink: string;
  caption?: string;
  thumbnailUrl?: string;
  likes: number;
  comments: number;
  shares?: number;
  saves?: number;
  reach?: number;
  impressions?: number;
  plays?: number;
  engagementRate?: number;
  postedAt: number;
  syncedAt: number;
}

export interface DailyAggregate {
  date: string;
  platform: string;
  accountId: string;
  followers: number;
  followerChange: number;
  totalLikes: number;
  totalComments: number;
  totalReach: number;
  avgEngagementRate: number;
  postsPublished: number;
}

export interface EngagementFlow {
  id?: number;
  platform: string;
  accountId: string;
  name: string;
  triggerType: 'keyword' | 'comment' | 'dm' | 'mention' | 'story_reply';
  triggerKeywords: string; // JSON array
  responseType: 'ai' | 'template' | 'flow';
  responseTemplate?: string;
  aiPrompt?: string;
  enabled: boolean;
  triggerCount: number;
  lastTriggered?: number;
  createdAt: number;
  updatedAt: number;
}

export interface Conversation {
  id?: number;
  platform: string;
  accountId: string;
  recipientId: string;
  recipientUsername: string;
  lastMessage: string;
  lastMessageAt: number;
  messageCount: number;
  isLead: boolean;
  tags: string; // JSON array
  flowState?: string;
  createdAt: number;
  updatedAt: number;
}

export interface Message {
  id?: number;
  conversationId: number;
  platform: string;
  messageId: string;
  direction: 'inbound' | 'outbound';
  content: string;
  mediaUrl?: string;
  triggeredFlow?: string;
  sentAt: number;
}

let _store: SocialAnalyticsStore | null = null;

export function getSocialAnalyticsStore(stateDir: string): SocialAnalyticsStore {
  if (!_store) {
    _store = new SocialAnalyticsStore(stateDir);
  }
  return _store;
}

export class SocialAnalyticsStore {
  private db: Database.Database;

  constructor(stateDir: string) {
    const dir = resolve(stateDir, "socials");
    mkdirSync(dir, { recursive: true });
    
    this.db = new Database(resolve(dir, "analytics.db"));
    this.db.pragma("journal_mode = WAL");
    this.init();
  }

  private init() {
    // Profile snapshots - point-in-time metrics
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS profile_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        platform TEXT NOT NULL,
        account_id TEXT NOT NULL,
        username TEXT NOT NULL,
        followers INTEGER NOT NULL,
        following INTEGER NOT NULL,
        posts INTEGER NOT NULL,
        reach INTEGER,
        profile_views INTEGER,
        website_clicks INTEGER,
        accounts_engaged INTEGER,
        timestamp INTEGER NOT NULL,
        date TEXT NOT NULL,
        UNIQUE(platform, account_id, date)
      )
    `);

    // Post metrics - individual post performance
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS post_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        platform TEXT NOT NULL,
        account_id TEXT NOT NULL,
        post_id TEXT NOT NULL,
        media_type TEXT NOT NULL,
        permalink TEXT,
        caption TEXT,
        thumbnail_url TEXT,
        likes INTEGER NOT NULL DEFAULT 0,
        comments INTEGER NOT NULL DEFAULT 0,
        shares INTEGER DEFAULT 0,
        saves INTEGER DEFAULT 0,
        reach INTEGER DEFAULT 0,
        impressions INTEGER DEFAULT 0,
        plays INTEGER DEFAULT 0,
        engagement_rate REAL DEFAULT 0,
        posted_at INTEGER NOT NULL,
        synced_at INTEGER NOT NULL,
        UNIQUE(platform, account_id, post_id)
      )
    `);

    // Daily aggregates - pre-computed daily stats
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS daily_aggregates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL,
        platform TEXT NOT NULL,
        account_id TEXT NOT NULL,
        followers INTEGER NOT NULL,
        follower_change INTEGER NOT NULL DEFAULT 0,
        total_likes INTEGER NOT NULL DEFAULT 0,
        total_comments INTEGER NOT NULL DEFAULT 0,
        total_reach INTEGER NOT NULL DEFAULT 0,
        avg_engagement_rate REAL NOT NULL DEFAULT 0,
        posts_published INTEGER NOT NULL DEFAULT 0,
        UNIQUE(date, platform, account_id)
      )
    `);

    // Engagement flows - automation rules
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS engagement_flows (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        platform TEXT NOT NULL,
        account_id TEXT NOT NULL,
        name TEXT NOT NULL,
        trigger_type TEXT NOT NULL,
        trigger_keywords TEXT,
        response_type TEXT NOT NULL,
        response_template TEXT,
        ai_prompt TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        trigger_count INTEGER NOT NULL DEFAULT 0,
        last_triggered INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    // Conversations - DM threads
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        platform TEXT NOT NULL,
        account_id TEXT NOT NULL,
        recipient_id TEXT NOT NULL,
        recipient_username TEXT,
        last_message TEXT,
        last_message_at INTEGER,
        message_count INTEGER NOT NULL DEFAULT 0,
        is_lead INTEGER NOT NULL DEFAULT 0,
        tags TEXT,
        flow_state TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(platform, account_id, recipient_id)
      )
    `);

    // Messages - individual messages
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id INTEGER NOT NULL,
        platform TEXT NOT NULL,
        message_id TEXT NOT NULL,
        direction TEXT NOT NULL,
        content TEXT NOT NULL,
        media_url TEXT,
        triggered_flow TEXT,
        sent_at INTEGER NOT NULL,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id),
        UNIQUE(platform, message_id)
      )
    `);

    // Indexes for performance
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_snapshots_date ON profile_snapshots(platform, account_id, date);
      CREATE INDEX IF NOT EXISTS idx_posts_account ON post_metrics(platform, account_id, posted_at);
      CREATE INDEX IF NOT EXISTS idx_daily_date ON daily_aggregates(date, platform, account_id);
      CREATE INDEX IF NOT EXISTS idx_conversations_account ON conversations(platform, account_id);
      CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, sent_at);
    `);

    console.log("[social-analytics] Database initialized");
  }

  // ═══════════════════════════════════════════════════════════════
  // PROFILE SNAPSHOTS
  // ═══════════════════════════════════════════════════════════════

  saveProfileSnapshot(snapshot: Omit<ProfileSnapshot, 'id'>): ProfileSnapshot {
    const stmt = this.db.prepare(`
      INSERT INTO profile_snapshots (platform, account_id, username, followers, following, posts, reach, profile_views, website_clicks, accounts_engaged, timestamp, date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(platform, account_id, date) DO UPDATE SET
        followers = excluded.followers,
        following = excluded.following,
        posts = excluded.posts,
        reach = excluded.reach,
        profile_views = excluded.profile_views,
        website_clicks = excluded.website_clicks,
        accounts_engaged = excluded.accounts_engaged,
        timestamp = excluded.timestamp
    `);
    
    const result = stmt.run(
      snapshot.platform,
      snapshot.accountId,
      snapshot.username,
      snapshot.followers,
      snapshot.following,
      snapshot.posts,
      snapshot.reach || 0,
      snapshot.profileViews || 0,
      snapshot.websiteClicks || 0,
      snapshot.accountsEngaged || 0,
      snapshot.timestamp,
      snapshot.date
    );
    
    return { ...snapshot, id: result.lastInsertRowid as number };
  }

  getProfileHistory(platform: string, accountId: string, days: number = 30): ProfileSnapshot[] {
    const stmt = this.db.prepare(`
      SELECT * FROM profile_snapshots 
      WHERE platform = ? AND account_id = ?
      ORDER BY date DESC
      LIMIT ?
    `);
    
    return stmt.all(platform, accountId, days).map(this.mapProfileSnapshot);
  }

  getLatestSnapshot(platform: string, accountId: string): ProfileSnapshot | null {
    const stmt = this.db.prepare(`
      SELECT * FROM profile_snapshots 
      WHERE platform = ? AND account_id = ?
      ORDER BY timestamp DESC
      LIMIT 1
    `);
    
    const row = stmt.get(platform, accountId);
    return row ? this.mapProfileSnapshot(row) : null;
  }

  private mapProfileSnapshot(row: any): ProfileSnapshot {
    return {
      id: row.id,
      platform: row.platform,
      accountId: row.account_id,
      username: row.username,
      followers: row.followers,
      following: row.following,
      posts: row.posts,
      reach: row.reach,
      profileViews: row.profile_views,
      websiteClicks: row.website_clicks,
      accountsEngaged: row.accounts_engaged,
      timestamp: row.timestamp,
      date: row.date,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // POST METRICS
  // ═══════════════════════════════════════════════════════════════

  savePostMetric(post: Omit<PostMetric, 'id'>): PostMetric {
    const stmt = this.db.prepare(`
      INSERT INTO post_metrics (platform, account_id, post_id, media_type, permalink, caption, thumbnail_url, likes, comments, shares, saves, reach, impressions, plays, engagement_rate, posted_at, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(platform, account_id, post_id) DO UPDATE SET
        likes = excluded.likes,
        comments = excluded.comments,
        shares = excluded.shares,
        saves = excluded.saves,
        reach = excluded.reach,
        impressions = excluded.impressions,
        plays = excluded.plays,
        engagement_rate = excluded.engagement_rate,
        synced_at = excluded.synced_at
    `);
    
    const result = stmt.run(
      post.platform,
      post.accountId,
      post.postId,
      post.mediaType,
      post.permalink,
      post.caption,
      post.thumbnailUrl,
      post.likes,
      post.comments,
      post.shares || 0,
      post.saves || 0,
      post.reach || 0,
      post.impressions || 0,
      post.plays || 0,
      post.engagementRate || 0,
      post.postedAt,
      post.syncedAt
    );
    
    return { ...post, id: result.lastInsertRowid as number };
  }

  getPostMetrics(platform: string, accountId: string, limit: number = 50): PostMetric[] {
    const stmt = this.db.prepare(`
      SELECT * FROM post_metrics 
      WHERE platform = ? AND account_id = ?
      ORDER BY posted_at DESC
      LIMIT ?
    `);
    
    return stmt.all(platform, accountId, limit).map(this.mapPostMetric);
  }

  getTopPosts(platform: string, accountId: string, metric: 'likes' | 'comments' | 'reach' | 'engagement_rate' = 'likes', limit: number = 10): PostMetric[] {
    const stmt = this.db.prepare(`
      SELECT * FROM post_metrics 
      WHERE platform = ? AND account_id = ?
      ORDER BY ${metric} DESC
      LIMIT ?
    `);
    
    return stmt.all(platform, accountId, limit).map(this.mapPostMetric);
  }

  private mapPostMetric(row: any): PostMetric {
    return {
      id: row.id,
      platform: row.platform,
      accountId: row.account_id,
      postId: row.post_id,
      mediaType: row.media_type,
      permalink: row.permalink,
      caption: row.caption,
      thumbnailUrl: row.thumbnail_url,
      likes: row.likes,
      comments: row.comments,
      shares: row.shares,
      saves: row.saves,
      reach: row.reach,
      impressions: row.impressions,
      plays: row.plays,
      engagementRate: row.engagement_rate,
      postedAt: row.posted_at,
      syncedAt: row.synced_at,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // DAILY AGGREGATES
  // ═══════════════════════════════════════════════════════════════

  saveDailyAggregate(agg: Omit<DailyAggregate, 'id'>): void {
    const stmt = this.db.prepare(`
      INSERT INTO daily_aggregates (date, platform, account_id, followers, follower_change, total_likes, total_comments, total_reach, avg_engagement_rate, posts_published)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(date, platform, account_id) DO UPDATE SET
        followers = excluded.followers,
        follower_change = excluded.follower_change,
        total_likes = excluded.total_likes,
        total_comments = excluded.total_comments,
        total_reach = excluded.total_reach,
        avg_engagement_rate = excluded.avg_engagement_rate,
        posts_published = excluded.posts_published
    `);
    
    stmt.run(
      agg.date,
      agg.platform,
      agg.accountId,
      agg.followers,
      agg.followerChange,
      agg.totalLikes,
      agg.totalComments,
      agg.totalReach,
      agg.avgEngagementRate,
      agg.postsPublished
    );
  }

  getDailyAggregates(platform: string, accountId: string, startDate: string, endDate: string): DailyAggregate[] {
    const stmt = this.db.prepare(`
      SELECT * FROM daily_aggregates 
      WHERE platform = ? AND account_id = ? AND date >= ? AND date <= ?
      ORDER BY date ASC
    `);
    
    return stmt.all(platform, accountId, startDate, endDate).map((row: any) => ({
      date: row.date,
      platform: row.platform,
      accountId: row.account_id,
      followers: row.followers,
      followerChange: row.follower_change,
      totalLikes: row.total_likes,
      totalComments: row.total_comments,
      totalReach: row.total_reach,
      avgEngagementRate: row.avg_engagement_rate,
      postsPublished: row.posts_published,
    }));
  }

  // ═══════════════════════════════════════════════════════════════
  // ENGAGEMENT FLOWS
  // ═══════════════════════════════════════════════════════════════

  saveEngagementFlow(flow: Omit<EngagementFlow, 'id' | 'triggerCount' | 'lastTriggered' | 'createdAt' | 'updatedAt'>): EngagementFlow {
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO engagement_flows (platform, account_id, name, trigger_type, trigger_keywords, response_type, response_template, ai_prompt, enabled, trigger_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `);
    
    const result = stmt.run(
      flow.platform,
      flow.accountId,
      flow.name,
      flow.triggerType,
      flow.triggerKeywords,
      flow.responseType,
      flow.responseTemplate,
      flow.aiPrompt,
      flow.enabled ? 1 : 0,
      now,
      now
    );
    
    return {
      ...flow,
      id: result.lastInsertRowid as number,
      triggerCount: 0,
      createdAt: now,
      updatedAt: now,
    };
  }

  getEngagementFlows(platform: string, accountId: string): EngagementFlow[] {
    const stmt = this.db.prepare(`
      SELECT * FROM engagement_flows 
      WHERE platform = ? AND account_id = ?
      ORDER BY created_at DESC
    `);
    
    return stmt.all(platform, accountId).map(this.mapEngagementFlow);
  }

  updateFlowTriggerCount(flowId: number): void {
    this.db.prepare(`
      UPDATE engagement_flows 
      SET trigger_count = trigger_count + 1, last_triggered = ?, updated_at = ?
      WHERE id = ?
    `).run(Date.now(), Date.now(), flowId);
  }

  private mapEngagementFlow(row: any): EngagementFlow {
    return {
      id: row.id,
      platform: row.platform,
      accountId: row.account_id,
      name: row.name,
      triggerType: row.trigger_type,
      triggerKeywords: row.trigger_keywords,
      responseType: row.response_type,
      responseTemplate: row.response_template,
      aiPrompt: row.ai_prompt,
      enabled: !!row.enabled,
      triggerCount: row.trigger_count,
      lastTriggered: row.last_triggered,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // CONVERSATIONS
  // ═══════════════════════════════════════════════════════════════

  upsertConversation(conv: Omit<Conversation, 'id' | 'messageCount' | 'createdAt' | 'updatedAt'>): Conversation {
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO conversations (platform, account_id, recipient_id, recipient_username, last_message, last_message_at, message_count, is_lead, tags, flow_state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
      ON CONFLICT(platform, account_id, recipient_id) DO UPDATE SET
        recipient_username = excluded.recipient_username,
        last_message = excluded.last_message,
        last_message_at = excluded.last_message_at,
        message_count = conversations.message_count + 1,
        is_lead = excluded.is_lead,
        tags = COALESCE(excluded.tags, conversations.tags),
        flow_state = COALESCE(excluded.flow_state, conversations.flow_state),
        updated_at = excluded.updated_at
    `);
    
    const result = stmt.run(
      conv.platform,
      conv.accountId,
      conv.recipientId,
      conv.recipientUsername,
      conv.lastMessage,
      conv.lastMessageAt,
      conv.isLead ? 1 : 0,
      conv.tags,
      conv.flowState,
      now,
      now
    );
    
    return {
      ...conv,
      id: result.lastInsertRowid as number,
      messageCount: 1,
      createdAt: now,
      updatedAt: now,
    };
  }

  getConversations(platform: string, accountId: string, limit: number = 50): Conversation[] {
    const stmt = this.db.prepare(`
      SELECT * FROM conversations 
      WHERE platform = ? AND account_id = ?
      ORDER BY last_message_at DESC
      LIMIT ?
    `);
    
    return stmt.all(platform, accountId, limit).map(this.mapConversation);
  }

  getLeads(platform: string, accountId: string): Conversation[] {
    const stmt = this.db.prepare(`
      SELECT * FROM conversations 
      WHERE platform = ? AND account_id = ? AND is_lead = 1
      ORDER BY last_message_at DESC
    `);
    
    return stmt.all(platform, accountId).map(this.mapConversation);
  }

  private mapConversation(row: any): Conversation {
    return {
      id: row.id,
      platform: row.platform,
      accountId: row.account_id,
      recipientId: row.recipient_id,
      recipientUsername: row.recipient_username,
      lastMessage: row.last_message,
      lastMessageAt: row.last_message_at,
      messageCount: row.message_count,
      isLead: !!row.is_lead,
      tags: row.tags,
      flowState: row.flow_state,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // MESSAGES
  // ═══════════════════════════════════════════════════════════════

  saveMessage(msg: Omit<Message, 'id'>): Message {
    const stmt = this.db.prepare(`
      INSERT INTO messages (conversation_id, platform, message_id, direction, content, media_url, triggered_flow, sent_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(platform, message_id) DO NOTHING
    `);
    
    const result = stmt.run(
      msg.conversationId,
      msg.platform,
      msg.messageId,
      msg.direction,
      msg.content,
      msg.mediaUrl,
      msg.triggeredFlow,
      msg.sentAt
    );
    
    return { ...msg, id: result.lastInsertRowid as number };
  }

  getMessages(conversationId: number, limit: number = 100): Message[] {
    const stmt = this.db.prepare(`
      SELECT * FROM messages 
      WHERE conversation_id = ?
      ORDER BY sent_at DESC
      LIMIT ?
    `);
    
    return stmt.all(conversationId, limit).map((row: any) => ({
      id: row.id,
      conversationId: row.conversation_id,
      platform: row.platform,
      messageId: row.message_id,
      direction: row.direction,
      content: row.content,
      mediaUrl: row.media_url,
      triggeredFlow: row.triggered_flow,
      sentAt: row.sent_at,
    }));
  }

  // ═══════════════════════════════════════════════════════════════
  // ANALYTICS QUERIES
  // ═══════════════════════════════════════════════════════════════

  getFollowerGrowth(platform: string, accountId: string, days: number = 30): { date: string; followers: number; change: number }[] {
    const stmt = this.db.prepare(`
      SELECT date, followers,
        followers - LAG(followers, 1, followers) OVER (ORDER BY date) as change
      FROM profile_snapshots 
      WHERE platform = ? AND account_id = ?
      ORDER BY date DESC
      LIMIT ?
    `);
    
    return stmt.all(platform, accountId, days).map((row: any) => ({
      date: row.date,
      followers: row.followers,
      change: row.change || 0,
    }));
  }

  getTotalStats(platform: string, accountId: string): {
    totalPosts: number;
    totalLikes: number;
    totalComments: number;
    avgEngagement: number;
    totalLeads: number;
    totalConversations: number;
  } {
    const postStats = this.db.prepare(`
      SELECT 
        COUNT(*) as total_posts,
        SUM(likes) as total_likes,
        SUM(comments) as total_comments,
        AVG(engagement_rate) as avg_engagement
      FROM post_metrics 
      WHERE platform = ? AND account_id = ?
    `).get(platform, accountId) as any;

    const convStats = this.db.prepare(`
      SELECT 
        COUNT(*) as total_conversations,
        SUM(CASE WHEN is_lead = 1 THEN 1 ELSE 0 END) as total_leads
      FROM conversations 
      WHERE platform = ? AND account_id = ?
    `).get(platform, accountId) as any;

    return {
      totalPosts: postStats?.total_posts || 0,
      totalLikes: postStats?.total_likes || 0,
      totalComments: postStats?.total_comments || 0,
      avgEngagement: postStats?.avg_engagement || 0,
      totalLeads: convStats?.total_leads || 0,
      totalConversations: convStats?.total_conversations || 0,
    };
  }

  close() {
    this.db.close();
  }
}
