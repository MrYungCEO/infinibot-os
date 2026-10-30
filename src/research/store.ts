/**
 * Research Intelligence Store
 * SQLite-backed storage for topics, watchlist, and articles
 */

import Database from "better-sqlite3";
import { resolve } from "path";
import { randomUUID } from "crypto";

// =============================================================================
// TYPES
// =============================================================================

export interface ResearchTopic {
  id: string;
  name: string;
  keywords: string[];
  category: "crypto" | "finance" | "tech" | "geopolitics" | "custom";
  enabled: boolean;
  priority: "high" | "medium" | "low";
  lastFetched?: number;
  articleCount?: number;
  createdAt: number;
}

export interface WatchlistAsset {
  id: string;
  symbol: string;
  name: string;
  type: "crypto" | "stock" | "forex" | "commodity";
  enabled: boolean;
  alerts: boolean;
  lastPrice?: number;
  change24h?: number;
  createdAt: number;
}

export interface ResearchArticle {
  id: string;
  title: string;
  summary: string;
  source: string;
  sourceUrl: string;
  publishedAt: number;
  fetchedAt: number;
  topics: string[];
  assets: string[];
  sentiment?: "bullish" | "bearish" | "neutral";
  importance: "breaking" | "high" | "medium" | "low";
  notionPageId?: string;
  read: boolean;
  bookmarked: boolean;
}

export interface ResearchSettings {
  autoFetch: boolean;
  fetchInterval: number;
  notionSync: boolean;
  notionDatabaseId?: string;
  maxArticlesPerTopic: number;
  summarizeArticles: boolean;
  sentimentAnalysis: boolean;
}

// =============================================================================
// STORE
// =============================================================================

let db: Database.Database | null = null;

function getDb(stateDir: string): Database.Database {
  if (!db) {
    const dbPath = resolve(stateDir, "research.db");
    db = new Database(dbPath);
    initSchema(db);
  }
  return db;
}

function initSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS topics (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      keywords TEXT NOT NULL,
      category TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      priority TEXT DEFAULT 'medium',
      lastFetched INTEGER,
      articleCount INTEGER DEFAULT 0,
      createdAt INTEGER NOT NULL
    );
    
    CREATE TABLE IF NOT EXISTS watchlist (
      id TEXT PRIMARY KEY,
      symbol TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      alerts INTEGER DEFAULT 0,
      lastPrice REAL,
      change24h REAL,
      createdAt INTEGER NOT NULL
    );
    
    CREATE TABLE IF NOT EXISTS articles (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      summary TEXT,
      source TEXT NOT NULL,
      sourceUrl TEXT NOT NULL,
      publishedAt INTEGER NOT NULL,
      fetchedAt INTEGER NOT NULL,
      topics TEXT,
      assets TEXT,
      sentiment TEXT,
      importance TEXT DEFAULT 'medium',
      notionPageId TEXT,
      read INTEGER DEFAULT 0,
      bookmarked INTEGER DEFAULT 0
    );
    
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    
    CREATE INDEX IF NOT EXISTS idx_articles_published ON articles(publishedAt DESC);
    CREATE INDEX IF NOT EXISTS idx_articles_importance ON articles(importance);
  `);
}

// =============================================================================
// TOPICS
// =============================================================================

export function getTopics(stateDir: string): ResearchTopic[] {
  const database = getDb(stateDir);
  const rows = database.prepare("SELECT * FROM topics ORDER BY priority DESC, name ASC").all() as any[];
  return rows.map((row) => ({
    ...row,
    keywords: JSON.parse(row.keywords || "[]"),
    enabled: Boolean(row.enabled),
  }));
}

export function addTopic(stateDir: string, topic: Partial<ResearchTopic>): ResearchTopic {
  const database = getDb(stateDir);
  const id = topic.id || randomUUID();
  const now = Date.now();
  
  const newTopic: ResearchTopic = {
    id,
    name: topic.name || "New Topic",
    keywords: topic.keywords || [],
    category: topic.category || "custom",
    enabled: topic.enabled !== false,
    priority: topic.priority || "medium",
    createdAt: now,
  };
  
  database.prepare(`
    INSERT INTO topics (id, name, keywords, category, enabled, priority, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    newTopic.id,
    newTopic.name,
    JSON.stringify(newTopic.keywords),
    newTopic.category,
    newTopic.enabled ? 1 : 0,
    newTopic.priority,
    newTopic.createdAt
  );
  
  return newTopic;
}

export function removeTopic(stateDir: string, id: string): boolean {
  const database = getDb(stateDir);
  const result = database.prepare("DELETE FROM topics WHERE id = ?").run(id);
  return result.changes > 0;
}

export function toggleTopic(stateDir: string, id: string): boolean {
  const database = getDb(stateDir);
  const result = database.prepare("UPDATE topics SET enabled = NOT enabled WHERE id = ?").run(id);
  return result.changes > 0;
}

export function updateTopicStats(stateDir: string, id: string, articleCount: number): void {
  const database = getDb(stateDir);
  database.prepare("UPDATE topics SET lastFetched = ?, articleCount = ? WHERE id = ?")
    .run(Date.now(), articleCount, id);
}

// =============================================================================
// WATCHLIST
// =============================================================================

export function getWatchlist(stateDir: string): WatchlistAsset[] {
  const database = getDb(stateDir);
  const rows = database.prepare("SELECT * FROM watchlist ORDER BY type ASC, symbol ASC").all() as any[];
  return rows.map((row) => ({
    ...row,
    enabled: Boolean(row.enabled),
    alerts: Boolean(row.alerts),
  }));
}

export function addWatchlistAsset(stateDir: string, asset: Partial<WatchlistAsset>): WatchlistAsset {
  const database = getDb(stateDir);
  const id = asset.id || randomUUID();
  const now = Date.now();
  
  const newAsset: WatchlistAsset = {
    id,
    symbol: asset.symbol || "NEW",
    name: asset.name || "New Asset",
    type: asset.type || "crypto",
    enabled: asset.enabled !== false,
    alerts: asset.alerts || false,
    createdAt: now,
  };
  
  database.prepare(`
    INSERT INTO watchlist (id, symbol, name, type, enabled, alerts, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    newAsset.id,
    newAsset.symbol,
    newAsset.name,
    newAsset.type,
    newAsset.enabled ? 1 : 0,
    newAsset.alerts ? 1 : 0,
    newAsset.createdAt
  );
  
  return newAsset;
}

export function removeWatchlistAsset(stateDir: string, id: string): boolean {
  const database = getDb(stateDir);
  const result = database.prepare("DELETE FROM watchlist WHERE id = ?").run(id);
  return result.changes > 0;
}

export function toggleWatchlistAsset(stateDir: string, id: string): boolean {
  const database = getDb(stateDir);
  const result = database.prepare("UPDATE watchlist SET enabled = NOT enabled WHERE id = ?").run(id);
  return result.changes > 0;
}

export function updateAssetPrice(stateDir: string, id: string, price: number, change: number): void {
  const database = getDb(stateDir);
  database.prepare("UPDATE watchlist SET lastPrice = ?, change24h = ? WHERE id = ?")
    .run(price, change, id);
}

// =============================================================================
// ARTICLES
// =============================================================================

export function getArticles(stateDir: string, limit = 100): ResearchArticle[] {
  const database = getDb(stateDir);
  const rows = database.prepare("SELECT * FROM articles ORDER BY publishedAt DESC LIMIT ?").all(limit) as any[];
  return rows.map((row) => ({
    ...row,
    topics: JSON.parse(row.topics || "[]"),
    assets: JSON.parse(row.assets || "[]"),
    read: Boolean(row.read),
    bookmarked: Boolean(row.bookmarked),
  }));
}

export function addArticle(stateDir: string, article: Partial<ResearchArticle>): ResearchArticle {
  const database = getDb(stateDir);
  const id = article.id || randomUUID();
  const now = Date.now();
  
  const newArticle: ResearchArticle = {
    id,
    title: article.title || "Untitled",
    summary: article.summary || "",
    source: article.source || "Unknown",
    sourceUrl: article.sourceUrl || "",
    publishedAt: article.publishedAt || now,
    fetchedAt: now,
    topics: article.topics || [],
    assets: article.assets || [],
    sentiment: article.sentiment,
    importance: article.importance || "medium",
    read: false,
    bookmarked: false,
  };
  
  database.prepare(`
    INSERT OR REPLACE INTO articles (id, title, summary, source, sourceUrl, publishedAt, fetchedAt, topics, assets, sentiment, importance, read, bookmarked)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    newArticle.id,
    newArticle.title,
    newArticle.summary,
    newArticle.source,
    newArticle.sourceUrl,
    newArticle.publishedAt,
    newArticle.fetchedAt,
    JSON.stringify(newArticle.topics),
    JSON.stringify(newArticle.assets),
    newArticle.sentiment || null,
    newArticle.importance,
    0,
    0
  );
  
  return newArticle;
}

export function markArticleRead(stateDir: string, id: string): boolean {
  const database = getDb(stateDir);
  const result = database.prepare("UPDATE articles SET read = NOT read WHERE id = ?").run(id);
  return result.changes > 0;
}

export function bookmarkArticle(stateDir: string, id: string): boolean {
  const database = getDb(stateDir);
  const result = database.prepare("UPDATE articles SET bookmarked = NOT bookmarked WHERE id = ?").run(id);
  return result.changes > 0;
}

export function updateArticleNotion(stateDir: string, id: string, notionPageId: string): void {
  const database = getDb(stateDir);
  database.prepare("UPDATE articles SET notionPageId = ? WHERE id = ?").run(notionPageId, id);
}

// =============================================================================
// SETTINGS
// =============================================================================

const DEFAULT_SETTINGS: ResearchSettings = {
  autoFetch: true,
  fetchInterval: 6,
  notionSync: true,
  maxArticlesPerTopic: 10,
  summarizeArticles: true,
  sentimentAnalysis: true,
};

export function getSettings(stateDir: string): ResearchSettings {
  const database = getDb(stateDir);
  const row = database.prepare("SELECT value FROM settings WHERE key = 'research'").get() as { value: string } | undefined;
  if (row) {
    try {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(row.value) };
    } catch {
      return DEFAULT_SETTINGS;
    }
  }
  return DEFAULT_SETTINGS;
}

export function updateSettings(stateDir: string, settings: Partial<ResearchSettings>): ResearchSettings {
  const database = getDb(stateDir);
  const current = getSettings(stateDir);
  const updated = { ...current, ...settings };
  
  database.prepare(`
    INSERT OR REPLACE INTO settings (key, value)
    VALUES ('research', ?)
  `).run(JSON.stringify(updated));
  
  return updated;
}

// =============================================================================
// STATS
// =============================================================================

export function getStats(stateDir: string): {
  totalArticles: number;
  todayArticles: number;
  unreadCount: number;
  lastSync: number;
  topicsCount: number;
  watchlistCount: number;
} {
  const database = getDb(stateDir);
  
  const totalArticles = (database.prepare("SELECT COUNT(*) as count FROM articles").get() as any).count;
  const todayStart = new Date().setHours(0, 0, 0, 0);
  const todayArticles = (database.prepare("SELECT COUNT(*) as count FROM articles WHERE fetchedAt >= ?").get(todayStart) as any).count;
  const unreadCount = (database.prepare("SELECT COUNT(*) as count FROM articles WHERE read = 0").get() as any).count;
  const topicsCount = (database.prepare("SELECT COUNT(*) as count FROM topics WHERE enabled = 1").get() as any).count;
  const watchlistCount = (database.prepare("SELECT COUNT(*) as count FROM watchlist WHERE enabled = 1").get() as any).count;
  
  const lastArticle = database.prepare("SELECT MAX(fetchedAt) as lastSync FROM articles").get() as any;
  
  return {
    totalArticles,
    todayArticles,
    unreadCount,
    lastSync: lastArticle?.lastSync || 0,
    topicsCount,
    watchlistCount,
  };
}

// =============================================================================
// SEED DATA
// =============================================================================

export function seedDefaultData(stateDir: string): void {
  const database = getDb(stateDir);
  
  const topicCount = (database.prepare("SELECT COUNT(*) as count FROM topics").get() as any).count;
  
  if (topicCount === 0) {
    // Add default topics
    const defaultTopics = [
      { name: "Bitcoin", keywords: ["bitcoin", "btc"], category: "crypto", priority: "high" },
      { name: "Ethereum", keywords: ["ethereum", "eth"], category: "crypto", priority: "high" },
      { name: "DeFi", keywords: ["defi", "decentralized finance"], category: "crypto", priority: "medium" },
      { name: "Federal Reserve", keywords: ["fed", "federal reserve", "fomc", "powell"], category: "finance", priority: "high" },
      { name: "AI & Machine Learning", keywords: ["artificial intelligence", "ai", "machine learning", "llm"], category: "tech", priority: "high" },
      { name: "US-China Relations", keywords: ["china", "us china", "tariffs", "taiwan"], category: "geopolitics", priority: "high" },
    ];
    
    for (const topic of defaultTopics) {
      addTopic(stateDir, topic as any);
    }
  }
  
  const watchlistCount = (database.prepare("SELECT COUNT(*) as count FROM watchlist").get() as any).count;
  
  if (watchlistCount === 0) {
    // Add default watchlist
    const defaultWatchlist = [
      { symbol: "BTC", name: "Bitcoin", type: "crypto", alerts: true },
      { symbol: "ETH", name: "Ethereum", type: "crypto", alerts: true },
      { symbol: "SOL", name: "Solana", type: "crypto", alerts: false },
      { symbol: "SPY", name: "S&P 500 ETF", type: "stock", alerts: true },
      { symbol: "NVDA", name: "NVIDIA", type: "stock", alerts: true },
      { symbol: "DXY", name: "US Dollar Index", type: "forex", alerts: true },
      { symbol: "GOLD", name: "Gold", type: "commodity", alerts: true },
    ];
    
    for (const asset of defaultWatchlist) {
      addWatchlistAsset(stateDir, asset as any);
    }
  }
}

// =============================================================================
// RESEARCH DOCUMENTS STORE (markdown-based, similar to notes)
// =============================================================================

import fs from "node:fs";
import path from "node:path";
import type {
  Research,
  ResearchCreateParams,
  ResearchListItem,
  ResearchMeta,
  ResearchSearchParams,
  ResearchUpdateParams,
} from "./types.js";

// ── Frontmatter helpers ──────────────────────────────────────

function parseFrontmatter(raw: string): { meta: Record<string, unknown>; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: raw };

  const yamlBlock = match[1];
  const body = match[2];

  const meta: Record<string, unknown> = {};
  for (const line of yamlBlock.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx < 0) continue;
    const key = trimmed.slice(0, colonIdx).trim();
    let value: string | string[] = trimmed.slice(colonIdx + 1).trim();

    if (value.startsWith("[") && value.endsWith("]")) {
      const inner = value.slice(1, -1);
      meta[key] = inner
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    } else if (value === "true") {
      meta[key] = true;
    } else if (value === "false") {
      meta[key] = false;
    } else {
      meta[key] = value.replace(/^["']|["']$/g, "");
    }
  }
  return { meta, body };
}

function serializeResearchFrontmatter(meta: ResearchMeta, body: string): string {
  const lines = ["---"];
  lines.push(`id: ${meta.id}`);
  lines.push(`name: "${meta.name.replace(/"/g, '\\"')}"`);
  if (meta.description) lines.push(`description: "${meta.description.replace(/"/g, '\\"')}"`);
  if (meta.tags?.length) {
    lines.push(`tags: [${meta.tags.map((t) => `"${t}"`).join(", ")}]`);
  }
  if (meta.author) lines.push(`author: ${meta.author}`);
  if (meta.category) lines.push(`category: "${meta.category.replace(/"/g, '\\"')}"`);
  lines.push(`status: ${meta.status}`);
  if (meta.topic) lines.push(`topic: "${meta.topic.replace(/"/g, '\\"')}"`);
  if (meta.sources?.length) {
    lines.push(`sources: [${meta.sources.map((s) => `"${s}"`).join(", ")}]`);
  }
  lines.push(`createdAt: ${meta.createdAt}`);
  lines.push(`updatedAt: ${meta.updatedAt}`);
  if (meta.notionPageId) lines.push(`notionPageId: ${meta.notionPageId}`);
  if (meta.notionSyncedAt) lines.push(`notionSyncedAt: ${meta.notionSyncedAt}`);
  lines.push("---");
  lines.push(body);
  return lines.join("\n");
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

function metaToListItem(meta: ResearchMeta, body: string): ResearchListItem {
  return {
    ...meta,
    preview: body.slice(0, 200).replace(/\n/g, " ").trim(),
    bodyLength: body.length,
  };
}

// ── Research Store class ──────────────────────────────────────────────

export class ResearchStore {
  private readonly dir: string;

  constructor(stateDir: string) {
    this.dir = path.join(stateDir, "research-docs");
    if (!fs.existsSync(this.dir)) {
      fs.mkdirSync(this.dir, { recursive: true });
    }
  }

  private filePath(id: string): string {
    const safe = id.replace(/[^a-z0-9_-]/gi, "");
    return path.join(this.dir, `${safe}.md`);
  }

  /** List all research documents (optionally filtered). */
  list(params?: ResearchSearchParams): ResearchListItem[] {
    const files = fs
      .readdirSync(this.dir)
      .filter((f) => f.endsWith(".md"))
      .sort();

    let items: ResearchListItem[] = [];
    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(this.dir, file), "utf-8");
        const { meta, body } = parseFrontmatter(raw);
        const resMeta = this.rawToMeta(file, meta);
        items.push(metaToListItem(resMeta, body));
      } catch {
        // skip broken files
      }
    }

    // Filter
    if (params?.query) {
      const q = params.query.toLowerCase();
      items = items.filter(
        (i) =>
          i.name.toLowerCase().includes(q) ||
          i.description?.toLowerCase().includes(q) ||
          i.preview.toLowerCase().includes(q) ||
          i.topic?.toLowerCase().includes(q)
      );
    }
    if (params?.tags?.length) {
      items = items.filter((i) =>
        params.tags!.some((t) => i.tags?.includes(t))
      );
    }
    if (params?.category) {
      items = items.filter((i) => i.category === params.category);
    }
    if (params?.status) {
      items = items.filter((i) => i.status === params.status);
    }
    if (params?.topic) {
      items = items.filter((i) => i.topic === params.topic);
    }
    if (params?.limit) {
      items = items.slice(0, params.limit);
    }

    return items;
  }

  /** Get a single research document by id. */
  get(id: string): Research | null {
    const fp = this.filePath(id);
    if (!fs.existsSync(fp)) return null;
    const raw = fs.readFileSync(fp, "utf-8");
    const { meta, body } = parseFrontmatter(raw);
    return {
      ...this.rawToMeta(path.basename(fp), meta),
      body,
    };
  }

  /** Create a new research document. */
  create(params: ResearchCreateParams): Research {
    const now = Date.now();
    const id = params.id || `${slugify(params.name)}-${now}`;
    const meta: ResearchMeta = {
      id,
      name: params.name,
      description: params.description,
      tags: params.tags,
      author: params.author,
      category: params.category,
      status: params.status || "draft",
      topic: params.topic,
      sources: params.sources,
      createdAt: now,
      updatedAt: now,
    };
    const content = serializeResearchFrontmatter(meta, params.body);
    fs.writeFileSync(this.filePath(id), content, "utf-8");
    return { ...meta, body: params.body };
  }

  /** Update an existing research document. */
  update(params: ResearchUpdateParams): Research | null {
    const existing = this.get(params.id);
    if (!existing) return null;

    const now = Date.now();
    const meta: ResearchMeta = {
      id: params.id,
      name: params.name ?? existing.name,
      description: params.description ?? existing.description,
      tags: params.tags ?? existing.tags,
      author: existing.author,
      category: params.category ?? existing.category,
      status: params.status ?? existing.status,
      topic: params.topic ?? existing.topic,
      sources: params.sources ?? existing.sources,
      createdAt: existing.createdAt,
      updatedAt: now,
      notionPageId: existing.notionPageId,
      notionSyncedAt: existing.notionSyncedAt,
    };
    const body = params.body ?? existing.body;
    const content = serializeResearchFrontmatter(meta, body);
    fs.writeFileSync(this.filePath(params.id), content, "utf-8");
    return { ...meta, body };
  }

  /** Delete a research document by id. */
  delete(id: string): boolean {
    const fp = this.filePath(id);
    if (!fs.existsSync(fp)) return false;
    fs.unlinkSync(fp);
    return true;
  }

  /** Convert raw frontmatter to typed meta. */
  private rawToMeta(filename: string, raw: Record<string, unknown>): ResearchMeta {
    const id = (raw.id as string) || filename.replace(/\.md$/, "");
    return {
      id,
      name: (raw.name as string) || id,
      description: raw.description as string | undefined,
      tags: raw.tags as string[] | undefined,
      author: raw.author as string | undefined,
      category: raw.category as string | undefined,
      status: (raw.status as ResearchMeta["status"]) || "draft",
      topic: raw.topic as string | undefined,
      sources: raw.sources as string[] | undefined,
      createdAt: (raw.createdAt as number) || Date.now(),
      updatedAt: (raw.updatedAt as number) || Date.now(),
      notionPageId: raw.notionPageId as string | undefined,
      notionSyncedAt: raw.notionSyncedAt as number | undefined,
    };
  }
}
