/**
 * Image Studio Store — SQLite-backed asset and context management
 */

import Database from "better-sqlite3";
import { randomUUID } from "crypto";
import { resolve, extname } from "path";
import { existsSync, mkdirSync, copyFileSync, statSync } from "fs";
import type {
  ImageAsset,
  AssetType,
  ContextTerm,
  GenerationRecord,
  AddAssetParams,
  CreateContextTermParams,
  SearchAssetsParams,
} from "./types.js";

// ═══════════════════════════════════════════════════════════════════════════════
// STORE CLASS
// ═══════════════════════════════════════════════════════════════════════════════

export class ImageStudioStore {
  private db: Database.Database;
  private assetsDir: string;
  private referencesDir: string;

  constructor(stateDir: string) {
    const baseDir = resolve(stateDir, "image-studio");
    this.assetsDir = resolve(baseDir, "assets");
    this.referencesDir = resolve(baseDir, "references");

    // Ensure directories exist
    mkdirSync(this.assetsDir, { recursive: true });
    mkdirSync(this.referencesDir, { recursive: true });

    // Initialize database
    const dbPath = resolve(baseDir, "image-studio.db");
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      -- Assets table
      CREATE TABLE IF NOT EXISTS assets (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        file_path TEXT NOT NULL,
        thumbnail_path TEXT,
        mime_type TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        width INTEGER NOT NULL,
        height INTEGER NOT NULL,
        type TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        context_terms TEXT NOT NULL DEFAULT '[]',
        usage_count INTEGER NOT NULL DEFAULT 0,
        last_used_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      -- Context terms table
      CREATE TABLE IF NOT EXISTS context_terms (
        id TEXT PRIMARY KEY,
        term TEXT NOT NULL UNIQUE,
        aliases TEXT NOT NULL DEFAULT '[]',
        description TEXT,
        asset_ids TEXT NOT NULL DEFAULT '[]',
        primary_asset_id TEXT,
        prompt_injection TEXT,
        negative_prompt TEXT,
        auto_inject INTEGER NOT NULL DEFAULT 1,
        priority INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      -- Style presets table
      CREATE TABLE IF NOT EXISTS style_presets (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT,
        prompt_prefix TEXT,
        prompt_suffix TEXT,
        negative_prompt TEXT,
        style_reference_ids TEXT NOT NULL DEFAULT '[]',
        preferred_model TEXT,
        model_settings TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      -- Generation history table
      CREATE TABLE IF NOT EXISTS generation_history (
        id TEXT PRIMARY KEY,
        original_prompt TEXT NOT NULL,
        processed_prompt TEXT NOT NULL,
        negative_prompt TEXT,
        context_terms_used TEXT NOT NULL DEFAULT '[]',
        assets_used TEXT NOT NULL DEFAULT '[]',
        output_path TEXT NOT NULL,
        thumbnail_path TEXT,
        model TEXT NOT NULL,
        model_version TEXT,
        resolution TEXT NOT NULL,
        settings TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'pending',
        error TEXT,
        generation_time_ms INTEGER,
        cost REAL,
        created_at INTEGER NOT NULL,
        completed_at INTEGER
      );

      -- Indexes
      CREATE INDEX IF NOT EXISTS idx_assets_type ON assets(type);
      CREATE INDEX IF NOT EXISTS idx_assets_name ON assets(name);
      CREATE INDEX IF NOT EXISTS idx_context_terms_term ON context_terms(term);
      CREATE INDEX IF NOT EXISTS idx_generation_history_created ON generation_history(created_at DESC);
    `);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // ASSET OPERATIONS
  // ─────────────────────────────────────────────────────────────────────────────

  addAsset(params: AddAssetParams): ImageAsset {
    const { name, filePath, type, description, tags = [], contextTerms = [] } = params;

    // Verify source file exists
    if (!existsSync(filePath)) {
      throw new Error(`Source file not found: ${filePath}`);
    }

    const id = randomUUID();
    const now = Date.now();

    // Copy file to assets directory
    const ext = extname(filePath);
    const destFileName = `${id}${ext}`;
    const destPath = resolve(this.assetsDir, destFileName);
    copyFileSync(filePath, destPath);

    // Get file info
    const stats = statSync(destPath);
    const mimeType = this.getMimeType(ext);

    // Get image dimensions (basic - would need sharp/jimp for real implementation)
    const { width, height } = this.getImageDimensions(destPath);

    const asset: ImageAsset = {
      id,
      name,
      description,
      filePath: destPath,
      mimeType,
      fileSize: stats.size,
      width,
      height,
      type,
      tags,
      contextTerms,
      usageCount: 0,
      createdAt: now,
      updatedAt: now,
    };

    this.db
      .prepare(`
      INSERT INTO assets (
        id, name, description, file_path, mime_type, file_size,
        width, height, type, tags, context_terms, usage_count,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        id,
        name,
        description || null,
        destPath,
        mimeType,
        stats.size,
        width,
        height,
        type,
        JSON.stringify(tags),
        JSON.stringify(contextTerms),
        0,
        now,
        now,
      );

    // Auto-link to context terms if specified
    for (const term of contextTerms) {
      this.linkAssetToContextTerm(id, term);
    }

    return asset;
  }

  getAsset(id: string): ImageAsset | null {
    const row = this.db.prepare("SELECT * FROM assets WHERE id = ?").get(id) as any;
    return row ? this.rowToAsset(row) : null;
  }

  searchAssets(params: SearchAssetsParams): ImageAsset[] {
    const { query, type, tags, contextTerm, limit = 50 } = params;

    let sql = "SELECT * FROM assets WHERE 1=1";
    const bindings: any[] = [];

    if (query) {
      sql += " AND (name LIKE ? OR description LIKE ?)";
      bindings.push(`%${query}%`, `%${query}%`);
    }

    if (type) {
      sql += " AND type = ?";
      bindings.push(type);
    }

    if (tags && tags.length > 0) {
      for (const tag of tags) {
        sql += " AND tags LIKE ?";
        bindings.push(`%"${tag}"%`);
      }
    }

    if (contextTerm) {
      sql += " AND context_terms LIKE ?";
      bindings.push(`%"${contextTerm}"%`);
    }

    sql += " ORDER BY updated_at DESC LIMIT ?";
    bindings.push(limit);

    const rows = this.db.prepare(sql).all(...bindings) as any[];
    return rows.map(this.rowToAsset);
  }

  listAssets(type?: AssetType, limit = 100): ImageAsset[] {
    let sql = "SELECT * FROM assets";
    const bindings: any[] = [];

    if (type) {
      sql += " WHERE type = ?";
      bindings.push(type);
    }

    sql += " ORDER BY updated_at DESC LIMIT ?";
    bindings.push(limit);

    const rows = this.db.prepare(sql).all(...bindings) as any[];
    return rows.map(this.rowToAsset);
  }

  updateAsset(id: string, updates: Partial<ImageAsset>): ImageAsset | null {
    const asset = this.getAsset(id);
    if (!asset) return null;

    const now = Date.now();
    const updatable = ["name", "description", "type", "tags", "contextTerms"];
    const sets: string[] = [];
    const bindings: any[] = [];

    for (const key of updatable) {
      if (key in updates) {
        const dbKey = key.replace(/([A-Z])/g, "_$1").toLowerCase();
        sets.push(`${dbKey} = ?`);
        const value = (updates as any)[key];
        bindings.push(Array.isArray(value) ? JSON.stringify(value) : value);
      }
    }

    if (sets.length === 0) return asset;

    sets.push("updated_at = ?");
    bindings.push(now);
    bindings.push(id);

    this.db.prepare(`UPDATE assets SET ${sets.join(", ")} WHERE id = ?`).run(...bindings);
    return this.getAsset(id);
  }

  deleteAsset(id: string): boolean {
    const result = this.db.prepare("DELETE FROM assets WHERE id = ?").run(id);
    return result.changes > 0;
  }

  incrementAssetUsage(id: string): void {
    const now = Date.now();
    this.db
      .prepare(`
      UPDATE assets SET usage_count = usage_count + 1, last_used_at = ? WHERE id = ?
    `)
      .run(now, id);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // CONTEXT TERM OPERATIONS
  // ─────────────────────────────────────────────────────────────────────────────

  createContextTerm(params: CreateContextTermParams): ContextTerm {
    const {
      term,
      aliases = [],
      description,
      assetIds = [],
      primaryAssetId,
      promptInjection,
      autoInject = true,
    } = params;

    const id = randomUUID();
    const now = Date.now();

    const contextTerm: ContextTerm = {
      id,
      term: term.toLowerCase(),
      aliases: aliases.map((a) => a.toLowerCase()),
      description,
      assetIds,
      primaryAssetId,
      promptInjection,
      autoInject,
      priority: 0,
      createdAt: now,
      updatedAt: now,
    };

    this.db
      .prepare(`
      INSERT INTO context_terms (
        id, term, aliases, description, asset_ids, primary_asset_id,
        prompt_injection, auto_inject, priority, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        id,
        contextTerm.term,
        JSON.stringify(aliases),
        description || null,
        JSON.stringify(assetIds),
        primaryAssetId || null,
        promptInjection || null,
        autoInject ? 1 : 0,
        0,
        now,
        now,
      );

    return contextTerm;
  }

  getContextTerm(termOrId: string): ContextTerm | null {
    const row = this.db
      .prepare(`
      SELECT * FROM context_terms WHERE id = ? OR term = ?
    `)
      .get(termOrId, termOrId.toLowerCase()) as any;
    return row ? this.rowToContextTerm(row) : null;
  }

  findContextTermByAlias(alias: string): ContextTerm | null {
    const normalizedAlias = alias.toLowerCase();

    // First check direct term match
    const direct = this.getContextTerm(normalizedAlias);
    if (direct) return direct;

    // Then search aliases
    const rows = this.db.prepare("SELECT * FROM context_terms").all() as any[];
    for (const row of rows) {
      const aliases: string[] = JSON.parse(row.aliases || "[]");
      if (aliases.includes(normalizedAlias)) {
        return this.rowToContextTerm(row);
      }
    }

    return null;
  }

  listContextTerms(): ContextTerm[] {
    const rows = this.db
      .prepare("SELECT * FROM context_terms ORDER BY priority DESC, term ASC")
      .all() as any[];
    return rows.map(this.rowToContextTerm);
  }

  updateContextTerm(id: string, updates: Partial<ContextTerm>): ContextTerm | null {
    const term = this.getContextTerm(id);
    if (!term) return null;

    const now = Date.now();
    const sets: string[] = [];
    const bindings: any[] = [];

    const fieldMap: Record<string, string> = {
      term: "term",
      aliases: "aliases",
      description: "description",
      assetIds: "asset_ids",
      primaryAssetId: "primary_asset_id",
      promptInjection: "prompt_injection",
      negativePrompt: "negative_prompt",
      autoInject: "auto_inject",
      priority: "priority",
    };

    for (const [key, dbKey] of Object.entries(fieldMap)) {
      if (key in updates) {
        sets.push(`${dbKey} = ?`);
        const value = (updates as any)[key];
        if (Array.isArray(value)) {
          bindings.push(JSON.stringify(value));
        } else if (typeof value === "boolean") {
          bindings.push(value ? 1 : 0);
        } else {
          bindings.push(value ?? null);
        }
      }
    }

    if (sets.length === 0) return term;

    sets.push("updated_at = ?");
    bindings.push(now);
    bindings.push(id);

    this.db.prepare(`UPDATE context_terms SET ${sets.join(", ")} WHERE id = ?`).run(...bindings);
    return this.getContextTerm(id);
  }

  deleteContextTerm(id: string): boolean {
    const result = this.db.prepare("DELETE FROM context_terms WHERE id = ?").run(id);
    return result.changes > 0;
  }

  linkAssetToContextTerm(assetId: string, termOrId: string): void {
    let contextTerm = this.getContextTerm(termOrId);

    if (!contextTerm) {
      // Create new context term
      contextTerm = this.createContextTerm({
        term: termOrId,
        assetIds: [assetId],
        primaryAssetId: assetId,
      });
    } else {
      // Add asset to existing term
      const assetIds = [...new Set([...contextTerm.assetIds, assetId])];
      this.updateContextTerm(contextTerm.id, {
        assetIds,
        primaryAssetId: contextTerm.primaryAssetId || assetId,
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // CONTEXT PROCESSING
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Process a prompt and inject context based on detected terms
   */
  processPromptWithContext(prompt: string): {
    processedPrompt: string;
    contextTermsUsed: ContextTerm[];
    assetsToUse: ImageAsset[];
    promptAdditions: string[];
  } {
    const contextTerms = this.listContextTerms();
    const contextTermsUsed: ContextTerm[] = [];
    const assetsToUse: ImageAsset[] = [];
    const promptAdditions: string[] = [];
    let processedPrompt = prompt;

    // Sort by priority (higher first) and term length (longer first for better matching)
    const sortedTerms = contextTerms
      .filter((ct) => ct.autoInject)
      .sort((a, b) => {
        if (b.priority !== a.priority) return b.priority - a.priority;
        return b.term.length - a.term.length;
      });

    for (const ct of sortedTerms) {
      // Check if term or any alias appears in prompt
      const allTerms = [ct.term, ...ct.aliases];
      const promptLower = prompt.toLowerCase();

      const matched = allTerms.some((t) => {
        // Word boundary matching
        const regex = new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
        return regex.test(prompt);
      });

      if (matched) {
        contextTermsUsed.push(ct);

        // Add prompt injection if specified
        if (ct.promptInjection) {
          promptAdditions.push(ct.promptInjection);
        }

        // Collect assets
        for (const assetId of ct.assetIds) {
          const asset = this.getAsset(assetId);
          if (asset && !assetsToUse.find((a) => a.id === assetId)) {
            assetsToUse.push(asset);
            this.incrementAssetUsage(assetId);
          }
        }
      }
    }

    // Build processed prompt
    if (promptAdditions.length > 0) {
      processedPrompt = `${prompt}, ${promptAdditions.join(", ")}`;
    }

    return {
      processedPrompt,
      contextTermsUsed,
      assetsToUse,
      promptAdditions,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // GENERATION HISTORY
  // ─────────────────────────────────────────────────────────────────────────────

  addGenerationRecord(record: Omit<GenerationRecord, "id" | "createdAt">): GenerationRecord {
    const id = randomUUID();
    const now = Date.now();

    this.db
      .prepare(`
      INSERT INTO generation_history (
        id, original_prompt, processed_prompt, negative_prompt,
        context_terms_used, assets_used, output_path, thumbnail_path,
        model, model_version, resolution, settings, status,
        error, generation_time_ms, cost, created_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        id,
        record.originalPrompt,
        record.processedPrompt,
        record.negativePrompt || null,
        JSON.stringify(record.contextTermsUsed),
        JSON.stringify(record.assetsUsed),
        record.outputPath,
        record.thumbnailPath || null,
        record.model,
        record.modelVersion || null,
        record.resolution,
        JSON.stringify(record.settings),
        record.status,
        record.error || null,
        record.generationTimeMs || null,
        record.cost || null,
        now,
        record.completedAt || null,
      );

    return { ...record, id, createdAt: now };
  }

  getGenerationHistory(limit = 50): GenerationRecord[] {
    const rows = this.db
      .prepare(`
      SELECT * FROM generation_history ORDER BY created_at DESC LIMIT ?
    `)
      .all(limit) as any[];
    return rows.map(this.rowToGenerationRecord);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // HELPERS
  // ─────────────────────────────────────────────────────────────────────────────

  private rowToAsset(row: any): ImageAsset {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      filePath: row.file_path,
      thumbnailPath: row.thumbnail_path,
      mimeType: row.mime_type,
      fileSize: row.file_size,
      width: row.width,
      height: row.height,
      type: row.type as AssetType,
      tags: JSON.parse(row.tags || "[]"),
      contextTerms: JSON.parse(row.context_terms || "[]"),
      usageCount: row.usage_count,
      lastUsedAt: row.last_used_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private rowToContextTerm(row: any): ContextTerm {
    return {
      id: row.id,
      term: row.term,
      aliases: JSON.parse(row.aliases || "[]"),
      description: row.description,
      assetIds: JSON.parse(row.asset_ids || "[]"),
      primaryAssetId: row.primary_asset_id,
      promptInjection: row.prompt_injection,
      negativePrompt: row.negative_prompt,
      autoInject: row.auto_inject === 1,
      priority: row.priority,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private rowToGenerationRecord(row: any): GenerationRecord {
    return {
      id: row.id,
      originalPrompt: row.original_prompt,
      processedPrompt: row.processed_prompt,
      negativePrompt: row.negative_prompt,
      contextTermsUsed: JSON.parse(row.context_terms_used || "[]"),
      assetsUsed: JSON.parse(row.assets_used || "[]"),
      outputPath: row.output_path,
      thumbnailPath: row.thumbnail_path,
      model: row.model,
      modelVersion: row.model_version,
      resolution: row.resolution,
      settings: JSON.parse(row.settings || "{}"),
      status: row.status,
      error: row.error,
      generationTimeMs: row.generation_time_ms,
      cost: row.cost,
      createdAt: row.created_at,
      completedAt: row.completed_at,
    };
  }

  private getMimeType(ext: string): string {
    const types: Record<string, string> = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".svg": "image/svg+xml",
    };
    return types[ext.toLowerCase()] || "application/octet-stream";
  }

  private getImageDimensions(filePath: string): { width: number; height: number } {
    // Placeholder - would use sharp/jimp in real implementation
    // For now return defaults
    return { width: 1024, height: 1024 };
  }

  close(): void {
    this.db.close();
  }
}

// Singleton instance
let storeInstance: ImageStudioStore | null = null;

export function getImageStudioStore(stateDir?: string): ImageStudioStore {
  if (!storeInstance) {
    const dir = stateDir || process.env.INFINIBOT_STATE_DIR || "state";
    storeInstance = new ImageStudioStore(dir);
  }
  return storeInstance;
}
