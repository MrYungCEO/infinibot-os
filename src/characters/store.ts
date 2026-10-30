/**
 * Character Store - Persistent storage for character references
 * Used for consistent image generation across sessions
 */

import { resolve, join, extname } from "path";
import { mkdirSync, existsSync, copyFileSync, rmSync, writeFileSync } from "fs";
import Database from "better-sqlite3";
import { randomUUID } from "crypto";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("characters");

export interface CharacterImage {
  id: string;
  characterId: string;
  path: string;
  label: string;
  isPrimary: boolean;
  addedAt: string;
}

export interface Character {
  id: string;
  name: string;
  slug: string;
  description: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  images: CharacterImage[];
}

export interface CharacterSummary {
  id: string;
  name: string;
  slug: string;
  tags: string[];
  imageCount: number;
  primaryImage: string | null;
  createdAt: string;
}

let _db: Database.Database | null = null;
let _stateDir: string | null = null;

function getCharactersDir(): string {
  const dir = resolve(_stateDir || process.env.INFINIBOT_STATE_DIR || "state", "characters");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function getCharacterDir(slug: string): string {
  const dir = resolve(getCharactersDir(), slug);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function ensureSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS characters (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      description TEXT DEFAULT '',
      tags TEXT DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    
    CREATE TABLE IF NOT EXISTS character_images (
      id TEXT PRIMARY KEY,
      character_id TEXT NOT NULL,
      path TEXT NOT NULL,
      label TEXT DEFAULT 'reference',
      is_primary INTEGER DEFAULT 0,
      added_at TEXT NOT NULL,
      FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE
    );
    
    CREATE INDEX IF NOT EXISTS idx_character_images_char ON character_images(character_id);
    CREATE INDEX IF NOT EXISTS idx_characters_slug ON characters(slug);
  `);
}

export function initCharacterStore(stateDir?: string): Database.Database {
  const targetDir = stateDir || process.env.INFINIBOT_STATE_DIR || "state";
  
  // If already initialized with the same dir, return cached
  if (_db && _stateDir === targetDir) return _db;
  
  // Close existing connection if switching dirs
  if (_db && _stateDir !== targetDir) {
    log.info("Reinitializing character store", { oldDir: _stateDir, newDir: targetDir });
    try { _db.close(); } catch {}
    _db = null;
  }
  
  _stateDir = targetDir;
  mkdirSync(_stateDir, { recursive: true });
  const dbPath = join(_stateDir, "characters.db");
  _db = new Database(dbPath);
  _db.pragma("journal_mode = WAL");
  _db.pragma("busy_timeout = 5000");
  _db.pragma("foreign_keys = ON");
  ensureSchema(_db);
  const count = (_db.prepare("SELECT COUNT(*) as cnt FROM characters").get() as { cnt: number }).cnt;
  log.info("Character store loaded (SQLite)", { characters: count });
  return _db;
}

function db(): Database.Database {
  if (!_db) {
    return initCharacterStore();
  }
  return _db;
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/\s+/g, "-").replace(/_/g, "-").replace(/[^a-z0-9-]/g, "");
}

export function createCharacter(
  name: string,
  imagePath: string,
  description: string = "",
  tags: string[] = [],
  label: string = "primary"
): Character | null {
  const d = db();
  const slug = slugify(name);
  
  // Check if exists
  const existing = d.prepare("SELECT id FROM characters WHERE slug = ?").get(slug);
  if (existing) {
    return null; // Already exists
  }
  
  const charId = randomUUID();
  const now = new Date().toISOString();
  
  // Copy image to character directory
  const charDir = getCharacterDir(slug);
  const ext = extname(imagePath) || ".png";
  const destPath = resolve(charDir, `reference_001${ext}`);
  
  if (existsSync(imagePath)) {
    copyFileSync(imagePath, destPath);
  } else {
    log.error("Source image not found:", { imagePath });
    return null; // Source image not found
  }
  
  // Insert character
  d.prepare(`
    INSERT INTO characters (id, name, slug, description, tags, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(charId, name, slug, description, JSON.stringify(tags), now, now);
  
  // Insert image
  const imageId = randomUUID();
  d.prepare(`
    INSERT INTO character_images (id, character_id, path, label, is_primary, added_at)
    VALUES (?, ?, ?, ?, 1, ?)
  `).run(imageId, charId, destPath, label, now);
  
  log.info("Character created:", { name, slug });
  return getCharacter(charId);
}

/**
 * Create character from base64 image data (for browser uploads)
 */
export function createCharacterFromBase64(
  name: string,
  base64Data: string,
  filename: string,
  description: string = "",
  tags: string[] = [],
  label: string = "primary"
): Character | null {
  const d = db();
  const slug = slugify(name);
  
  // Check if exists
  const existing = d.prepare("SELECT id FROM characters WHERE slug = ?").get(slug);
  if (existing) {
    return null;
  }
  
  // Parse base64 data
  const matches = base64Data.match(/^data:image\/(\w+);base64,(.+)$/);
  let ext = ".png";
  let data: string;
  
  if (matches) {
    ext = "." + matches[1].replace("jpeg", "jpg");
    data = matches[2];
  } else {
    data = base64Data;
    const fnExt = extname(filename);
    if (fnExt) ext = fnExt;
  }
  
  const charId = randomUUID();
  const now = new Date().toISOString();
  
  // Save image
  const charDir = getCharacterDir(slug);
  const destPath = resolve(charDir, `reference_001${ext}`);
  
  try {
    const buffer = Buffer.from(data, "base64");
    writeFileSync(destPath, buffer);
  } catch (e) {
    log.error("Failed to write image from base64 (create):", { error: String(e) });
    return null;
  }
  
  // Insert character
  d.prepare(`
    INSERT INTO characters (id, name, slug, description, tags, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(charId, name, slug, description, JSON.stringify(tags), now, now);
  
  // Insert image
  const imageId = randomUUID();
  d.prepare(`
    INSERT INTO character_images (id, character_id, path, label, is_primary, added_at)
    VALUES (?, ?, ?, ?, 1, ?)
  `).run(imageId, charId, destPath, label, now);
  
  log.info("Character created from base64:", { name, slug });
  return getCharacter(charId);
}

export function getCharacter(idOrSlug: string): Character | null {
  const d = db();
  
  const row = d.prepare(`
    SELECT * FROM characters WHERE id = ? OR slug = ?
  `).get(idOrSlug, idOrSlug) as any;
  
  if (!row) return null;
  
  const images = d.prepare(`
    SELECT * FROM character_images WHERE character_id = ? ORDER BY is_primary DESC, added_at ASC
  `).all(row.id) as any[];
  
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description || "",
    tags: JSON.parse(row.tags || "[]"),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    images: images.map(img => ({
      id: img.id,
      characterId: img.character_id,
      path: img.path,
      label: img.label,
      isPrimary: !!img.is_primary,
      addedAt: img.added_at
    }))
  };
}

export function listCharacters(tag?: string): CharacterSummary[] {
  const d = db();
  
  let rows: any[];
  if (tag) {
    rows = d.prepare(`
      SELECT c.*, 
        (SELECT COUNT(*) FROM character_images WHERE character_id = c.id) as image_count,
        (SELECT path FROM character_images WHERE character_id = c.id AND is_primary = 1 LIMIT 1) as primary_image
      FROM characters c
      WHERE c.tags LIKE ?
      ORDER BY c.updated_at DESC
    `).all(`%"${tag}"%`);
  } else {
    rows = d.prepare(`
      SELECT c.*, 
        (SELECT COUNT(*) FROM character_images WHERE character_id = c.id) as image_count,
        (SELECT path FROM character_images WHERE character_id = c.id AND is_primary = 1 LIMIT 1) as primary_image
      FROM characters c
      ORDER BY c.updated_at DESC
    `).all();
  }
  
  return rows.map(row => ({
    id: row.id,
    name: row.name,
    slug: row.slug,
    tags: JSON.parse(row.tags || "[]"),
    imageCount: row.image_count,
    primaryImage: row.primary_image,
    createdAt: row.created_at
  }));
}

export function addCharacterImage(
  idOrSlug: string,
  imagePath: string,
  label: string = "reference"
): CharacterImage | null {
  const d = db();
  const char = getCharacter(idOrSlug);
  if (!char) return null;
  
  // Copy image
  const charDir = getCharacterDir(char.slug);
  const imgNum = char.images.length + 1;
  const ext = extname(imagePath) || ".png";
  const destPath = resolve(charDir, `reference_${String(imgNum).padStart(3, "0")}${ext}`);
  
  if (existsSync(imagePath)) {
    copyFileSync(imagePath, destPath);
  } else {
    return null;
  }
  
  const imageId = randomUUID();
  const now = new Date().toISOString();
  
  d.prepare(`
    INSERT INTO character_images (id, character_id, path, label, is_primary, added_at)
    VALUES (?, ?, ?, ?, 0, ?)
  `).run(imageId, char.id, destPath, label, now);
  
  // Update character timestamp
  d.prepare("UPDATE characters SET updated_at = ? WHERE id = ?").run(now, char.id);
  
  log.info("Image added to character:", { slug: char.slug, path: destPath });
  return {
    id: imageId,
    characterId: char.id,
    path: destPath,
    label,
    isPrimary: false,
    addedAt: now
  };
}

/**
 * Add image from base64 data (for browser uploads)
 */
export function addCharacterImageFromBase64(
  idOrSlug: string,
  base64Data: string,
  filename: string,
  label: string = "reference"
): CharacterImage | null {
  const d = db();
  const char = getCharacter(idOrSlug);
  if (!char) return null;
  
  // Parse base64 data
  const matches = base64Data.match(/^data:image\/(\w+);base64,(.+)$/);
  let ext = ".png";
  let data: string;
  
  if (matches) {
    ext = "." + matches[1].replace("jpeg", "jpg");
    data = matches[2];
  } else {
    // Assume raw base64
    data = base64Data;
    // Try to get extension from filename
    const fnExt = extname(filename);
    if (fnExt) ext = fnExt;
  }
  
  // Save image
  const charDir = getCharacterDir(char.slug);
  const imgNum = char.images.length + 1;
  const destPath = resolve(charDir, `reference_${String(imgNum).padStart(3, "0")}${ext}`);
  
  try {
    const buffer = Buffer.from(data, "base64");
    writeFileSync(destPath, buffer);
  } catch (e) {
    log.error("Failed to write image from base64 (addImage):", { error: String(e) });
    return null;
  }
  
  const imageId = randomUUID();
  const now = new Date().toISOString();
  
  d.prepare(`
    INSERT INTO character_images (id, character_id, path, label, is_primary, added_at)
    VALUES (?, ?, ?, ?, 0, ?)
  `).run(imageId, char.id, destPath, label, now);
  
  d.prepare("UPDATE characters SET updated_at = ? WHERE id = ?").run(now, char.id);
  
  log.info("Image added to character from base64:", { slug: char.slug, path: destPath });
  return {
    id: imageId,
    characterId: char.id,
    path: destPath,
    label,
    isPrimary: false,
    addedAt: now
  };
}

export function updateCharacter(
  idOrSlug: string,
  updates: { name?: string; description?: string; tags?: string[] }
): Character | null {
  const d = db();
  const char = getCharacter(idOrSlug);
  if (!char) return null;
  
  const now = new Date().toISOString();
  const sets: string[] = ["updated_at = ?"];
  const values: any[] = [now];
  
  if (updates.name !== undefined) {
    sets.push("name = ?");
    values.push(updates.name);
  }
  if (updates.description !== undefined) {
    sets.push("description = ?");
    values.push(updates.description);
  }
  if (updates.tags !== undefined) {
    sets.push("tags = ?");
    values.push(JSON.stringify(updates.tags));
  }
  
  values.push(char.id);
  d.prepare(`UPDATE characters SET ${sets.join(", ")} WHERE id = ?`).run(...values);
  
  return getCharacter(char.id);
}

export function deleteCharacter(idOrSlug: string): boolean {
  const d = db();
  const char = getCharacter(idOrSlug);
  if (!char) return false;
  
  // Delete images from filesystem
  const charDir = resolve(getCharactersDir(), char.slug);
  if (existsSync(charDir)) {
    rmSync(charDir, { recursive: true, force: true });
  }
  
  // Delete from database (cascade deletes images)
  d.prepare("DELETE FROM characters WHERE id = ?").run(char.id);
  
  log.info("Character deleted:", { slug: char.slug });
  return true;
}

export function deleteCharacterImage(imageId: string): boolean {
  const d = db();
  
  const img = d.prepare("SELECT * FROM character_images WHERE id = ?").get(imageId) as any;
  if (!img) return false;
  
  // Delete file
  if (existsSync(img.path)) {
    rmSync(img.path, { force: true });
  }
  
  // Delete from database
  d.prepare("DELETE FROM character_images WHERE id = ?").run(imageId);
  
  // Update character timestamp
  const now = new Date().toISOString();
  d.prepare("UPDATE characters SET updated_at = ? WHERE id = ?").run(now, img.character_id);
  
  return true;
}

export function setPrimaryImage(characterIdOrSlug: string, imageId: string): boolean {
  const d = db();
  const char = getCharacter(characterIdOrSlug);
  if (!char) return false;
  
  // Unset all primaries
  d.prepare("UPDATE character_images SET is_primary = 0 WHERE character_id = ?").run(char.id);
  
  // Set new primary
  d.prepare("UPDATE character_images SET is_primary = 1 WHERE id = ? AND character_id = ?").run(imageId, char.id);
  
  return true;
}

export function searchCharacters(query: string): CharacterSummary[] {
  const d = db();
  const searchTerm = `%${query.toLowerCase()}%`;
  
  const rows = d.prepare(`
    SELECT c.*, 
      (SELECT COUNT(*) FROM character_images WHERE character_id = c.id) as image_count,
      (SELECT path FROM character_images WHERE character_id = c.id AND is_primary = 1 LIMIT 1) as primary_image
    FROM characters c
    WHERE LOWER(c.name) LIKE ? OR LOWER(c.description) LIKE ? OR LOWER(c.tags) LIKE ?
    ORDER BY c.updated_at DESC
  `).all(searchTerm, searchTerm, searchTerm) as any[];
  
  return rows.map(row => ({
    id: row.id,
    name: row.name,
    slug: row.slug,
    tags: JSON.parse(row.tags || "[]"),
    imageCount: row.image_count,
    primaryImage: row.primary_image,
    createdAt: row.created_at
  }));
}
