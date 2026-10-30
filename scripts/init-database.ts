#!/usr/bin/env node
/**
 * Database Initialization Script
 * 
 * Creates all InfiniBot SQLite databases upfront with proper schemas.
 * Run after installation or before first use.
 * 
 * Usage:
 *   node scripts/init-database.ts           # Create tables if missing
 *   node scripts/init-database.ts --force   # Drop and recreate all tables
 *   node scripts/init-database.ts --check  # Verify tables exist, exit 0 if ok
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";

// Configuration
const STATE_DIR = process.env.INFINIBOT_STATE_DIR || join(process.env.HOME || process.env.USERPROFILE || ".", ".infinibot");
const DB_PATH = join(STATE_DIR, "infinibot.db");

const FORCE = process.argv.includes("--force");
const CHECK = process.argv.includes("--check");

interface TableDefinition {
  name: string;
  sql: string;
}

// Table definitions
const TABLES: TableDefinition[] = [
  // Kanban / Tasks
  {
    name: "projects",
    sql: `
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        notionId TEXT,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT DEFAULT 'Not started',
        priority TEXT DEFAULT 'Medium',
        type TEXT,
        progress INTEGER DEFAULT 0,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      )
    `,
  },
  {
    name: "tasks",
    sql: `
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        notionId TEXT,
        projectId TEXT,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT DEFAULT 'todo',
        priority TEXT DEFAULT 'medium',
        assignedAgent TEXT,
        dueDate INTEGER,
        done INTEGER DEFAULT 0,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        FOREIGN KEY (projectId) REFERENCES projects(id)
      )
    `,
  },
  {
    name: "project_notes",
    sql: `
      CREATE TABLE IF NOT EXISTS project_notes (
        id TEXT PRIMARY KEY,
        projectId TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT,
        pinned INTEGER DEFAULT 0,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        FOREIGN KEY (projectId) REFERENCES projects(id) ON DELETE CASCADE
      )
    `,
  },
  {
    name: "project_attachments",
    sql: `
      CREATE TABLE IF NOT EXISTS project_attachments (
        id TEXT PRIMARY KEY,
        projectId TEXT NOT NULL,
        name TEXT NOT NULL,
        path TEXT,
        size INTEGER,
        mimeType TEXT,
        createdAt INTEGER NOT NULL,
        FOREIGN KEY (projectId) REFERENCES projects(id) ON DELETE CASCADE
      )
    `,
  },

  // Budget tracking
  {
    name: "budget_entries",
    sql: `
      CREATE TABLE IF NOT EXISTS budget_entries (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        model TEXT,
        cost_usd REAL,
        tokens_in INTEGER,
        tokens_out INTEGER,
        description TEXT,
        timestamp INTEGER NOT NULL
      )
    `,
  },
  {
    name: "monthly_summaries",
    sql: `
      CREATE TABLE IF NOT EXISTS monthly_summaries (
        month TEXT PRIMARY KEY,
        year INTEGER,
        total_cost REAL DEFAULT 0,
        total_requests INTEGER DEFAULT 0
      )
    `,
  },

  // Characters
  {
    name: "characters",
    sql: `
      CREATE TABLE IF NOT EXISTS characters (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT,
        tags TEXT,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      )
    `,
  },
  {
    name: "character_images",
    sql: `
      CREATE TABLE IF NOT EXISTS character_images (
        id TEXT PRIMARY KEY,
        characterId TEXT NOT NULL,
        path TEXT NOT NULL,
        label TEXT,
        isPrimary INTEGER DEFAULT 0,
        createdAt INTEGER NOT NULL,
        FOREIGN KEY (characterId) REFERENCES characters(id) ON DELETE CASCADE
      )
    `,
  },

  // Subagent registry
  {
    name: "subagent_registry",
    sql: `
      CREATE TABLE IF NOT EXISTS subagent_registry (
        sessionKey TEXT PRIMARY KEY,
        runId TEXT,
        label TEXT,
        task TEXT,
        status TEXT DEFAULT 'starting',
        progress INTEGER DEFAULT 0,
        parentSessionKey TEXT,
        projectId TEXT,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      )
    `,
  },

  // Vault (Kingly Vault community)
  {
    name: "vault_members",
    sql: `
      CREATE TABLE IF NOT EXISTS vault_members (
        id TEXT PRIMARY KEY,
        discordId TEXT UNIQUE,
        email TEXT,
        username TEXT,
        tier TEXT DEFAULT 'free',
        status TEXT DEFAULT 'active',
        tags TEXT,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      )
    `,
  },

  // SSH devices
  {
    name: "ssh_devices",
    sql: `
      CREATE TABLE IF NOT EXISTS ssh_devices (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        ip TEXT NOT NULL,
        port INTEGER DEFAULT 22,
        username TEXT NOT NULL,
        password TEXT,
        privateKey TEXT,
        description TEXT,
        tags TEXT,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      )
    `,
  },

  // Auth profiles
  {
    name: "auth_profiles",
    sql: `
      CREATE TABLE IF NOT EXISTS auth_profiles (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        name TEXT,
        apiKey TEXT,
        oauthToken TEXT,
        refreshToken TEXT,
        expiresAt INTEGER,
        isActive INTEGER DEFAULT 1,
        lastUsed INTEGER,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      )
    `,
  },

  // Image Studio
  {
    name: "image_generations",
    sql: `
      CREATE TABLE IF NOT EXISTS image_generations (
        id TEXT PRIMARY KEY,
        prompt TEXT NOT NULL,
        model TEXT,
        url TEXT,
        localPath TEXT,
        status TEXT DEFAULT 'pending',
        error TEXT,
        metadata TEXT,
        createdAt INTEGER NOT NULL
      )
    `,
  },
];

const INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(projectId)`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON tasks(assignedAgent)`,
  `CREATE INDEX IF NOT EXISTS idx_budget_timestamp ON budget_entries(timestamp)`,
  `CREATE INDEX IF NOT EXISTS idx_subagent_parent ON subagent_registry(parentSessionKey)`,
  `CREATE INDEX IF NOT EXISTS idx_subagent_status ON subagent_registry(status)`,
  `CREATE INDEX IF NOT EXISTS idx_character_images_character ON character_images(characterId)`,
  `CREATE INDEX IF NOT EXISTS idx_project_notes_project ON project_notes(projectId)`,
];

function initializeDatabase(): boolean {
  console.log("📦 InfiniBot Database Initialization\n");

  // Ensure state directory exists
  if (!existsSync(STATE_DIR)) {
    console.log(`Creating state directory: ${STATE_DIR}`);
    mkdirSync(STATE_DIR, { recursive: true });
  }

  const dbExists = existsSync(DB_PATH);

  if (CHECK) {
    if (!dbExists) {
      console.log("❌ Database does not exist");
      return false;
    }
    const db = new Database(DB_PATH);
    const tables = TABLES.map((t) => t.name);
    const existing = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((row: any) => row.name);
    const missing = tables.filter((t) => !existing.includes(t));
    db.close();

    if (missing.length > 0) {
      console.log(`❌ Missing tables: ${missing.join(", ")}`);
      return false;
    }
    console.log("✅ Database schema verified");
    return true;
  }

  if (FORCE && dbExists) {
    console.log(`⚠️  Force mode: Dropping existing database...`);
    const db = new Database(DB_PATH);
    for (const table of [...TABLES].reverse()) {
      db.exec(`DROP TABLE IF EXISTS ${table.name}`);
    }
    db.close();
    console.log("   Tables dropped\n");
  }

  // Open database
  console.log(`Opening database: ${DB_PATH}`);
  const db = new Database(DB_PATH);

  // Enable WAL mode for better concurrency
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // Create tables
  console.log("\n🗄️  Creating tables...");
  let created = 0;
  let skipped = 0;

  for (const { name, sql } of TABLES) {
    const exists = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?")
      .get(name);

    if (exists) {
      console.log(`  ⏭️  ${name} (exists)`);
      skipped++;
    } else {
      db.exec(sql);
      console.log(`  ✓ ${name}`);
      created++;
    }
  }

  // Create indexes
  console.log("\n🔍 Creating indexes...");
  for (const sql of INDEXES) {
    try {
      db.exec(sql);
    } catch (err: any) {
      // Index might already exist
      if (!err.message?.includes("already exists")) {
        console.warn(`  ⚠️  Index creation warning: ${err.message}`);
      }
    }
  }

  db.close();

  console.log("\n" + "━".repeat(50));
  console.log(`✅ Database initialization complete!`);
  console.log(`   Created: ${created} tables`);
  console.log(`   Skipped: ${skipped} existing tables`);
  console.log(`   Location: ${DB_PATH}`);
  console.log("━".repeat(50) + "\n");

  return true;
}

// Run
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const success = initializeDatabase();
    process.exit(success ? 0 : 1);
  } catch (err: any) {
    console.error("\n❌ Database initialization failed:");
    console.error(err.message);
    process.exit(1);
  }
}

export { initializeDatabase, TABLES };
