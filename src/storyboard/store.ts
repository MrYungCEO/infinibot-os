/**
 * Storyboard Store — SQLite persistence for storyboard projects
 */

import Database from "better-sqlite3";
import { randomUUID } from "crypto";
import { resolve } from "path";
import type {
  StoryboardProject,
  Scene,
  CharacterRef,
  ProjectStatus,
  SceneStatus,
  Platform,
  ImageBackend,
  EffectPreset,
  TimelineBeat,
  TimelinePromptingProject,
} from "./types.js";

let db: Database.Database | null = null;

// ═══════════════════════════════════════════════════════════════
// INITIALIZATION
// ═══════════════════════════════════════════════════════════════

export function getStoryboardStore(stateDir: string): Database.Database {
  if (db) return db;

  const dbPath = resolve(stateDir, "storyboard.db");
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  initSchema(db);
  runMigrations(db);
  return db;
}

function runMigrations(db: Database.Database): void {
  // Add audio_url column to scenes if it doesn't exist
  try {
    const sceneColumns = db.prepare("PRAGMA table_info(scenes)").all() as { name: string }[];
    if (!sceneColumns.some((c) => c.name === "audio_url")) {
      db.exec("ALTER TABLE scenes ADD COLUMN audio_url TEXT");
    }
    // Add effect_preset column for Remotion effects
    if (!sceneColumns.some((c) => c.name === "effect_preset")) {
      db.exec("ALTER TABLE scenes ADD COLUMN effect_preset TEXT DEFAULT 'none'");
    }
    // Add overlay_preset column for overlay effects (pairs with motion)
    if (!sceneColumns.some((c) => c.name === "overlay_preset")) {
      db.exec("ALTER TABLE scenes ADD COLUMN overlay_preset TEXT DEFAULT 'none'");
    }
    // Timeline Prompting (Phase 8 addendum) — per-scene beat plan as JSON
    if (!sceneColumns.some((c) => c.name === "timeline_beats")) {
      db.exec("ALTER TABLE scenes ADD COLUMN timeline_beats TEXT");
    }
  } catch {
    // Table might not exist yet, that's fine
  }

  // Timeline Prompting (Phase 8 addendum) — project-level beat plan as JSON
  try {
    const projColumns = db.prepare("PRAGMA table_info(projects)").all() as { name: string }[];
    if (!projColumns.some((c) => c.name === "timeline_prompting")) {
      db.exec("ALTER TABLE projects ADD COLUMN timeline_prompting TEXT");
    }
  } catch {
    // Table might not exist yet
  }

  // Add language/TTS columns to projects if they don't exist
  try {
    const projColumns = db.prepare("PRAGMA table_info(projects)").all() as { name: string }[];
    if (!projColumns.some((c) => c.name === "language")) {
      db.exec("ALTER TABLE projects ADD COLUMN language TEXT NOT NULL DEFAULT 'en'");
    }
    if (!projColumns.some((c) => c.name === "tts_provider")) {
      db.exec("ALTER TABLE projects ADD COLUMN tts_provider TEXT NOT NULL DEFAULT 'kokoro'");
    }
    if (!projColumns.some((c) => c.name === "tts_voice")) {
      db.exec("ALTER TABLE projects ADD COLUMN tts_voice TEXT NOT NULL DEFAULT 'af_nova'");
    }
  } catch {
    // Table might not exist yet, that's fine
  }
}

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      prompt TEXT NOT NULL,
      target_duration REAL NOT NULL,
      platform TEXT NOT NULL,
      aspect_ratio TEXT NOT NULL DEFAULT '16:9',
      image_style TEXT NOT NULL DEFAULT 'cinematic',
      image_backend TEXT NOT NULL DEFAULT 'auto',
      language TEXT NOT NULL DEFAULT 'en',
      tts_provider TEXT NOT NULL DEFAULT 'kokoro',
      tts_voice TEXT NOT NULL DEFAULT 'af_nova',
      script TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      error TEXT,
      progress INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER
    );
    
    CREATE TABLE IF NOT EXISTS scenes (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      idx INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      dialogue TEXT,
      voiceover TEXT,
      duration_seconds REAL NOT NULL,
      image_prompt TEXT NOT NULL,
      image_url TEXT,
      thumbnail_url TEXT,
      audio_url TEXT,
      image_status TEXT NOT NULL DEFAULT 'pending',
      image_error TEXT,
      metadata TEXT,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    
    CREATE TABLE IF NOT EXISTS characters (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      reference_image_url TEXT,
      reference_image_path TEXT,
      style_tokens TEXT,
      color TEXT,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    
    CREATE INDEX IF NOT EXISTS idx_scenes_project ON scenes(project_id);
    CREATE INDEX IF NOT EXISTS idx_characters_project ON characters(project_id);
    CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
    CREATE INDEX IF NOT EXISTS idx_projects_created ON projects(created_at);
  `);
}

// ═══════════════════════════════════════════════════════════════
// PROJECT CRUD
// ═══════════════════════════════════════════════════════════════

export function createProject(
  stateDir: string,
  data: {
    name: string;
    prompt: string;
    targetDuration: number;
    platform: Platform;
    aspectRatio?: string;
    imageStyle?: string;
    imageBackend?: ImageBackend;
    language?: string;
    ttsProvider?: string;
    ttsVoice?: string;
    characters?: Omit<CharacterRef, "id">[];
  },
): StoryboardProject {
  const store = getStoryboardStore(stateDir);
  const now = Date.now();
  const id = randomUUID();

  const stmt = store.prepare(`
    INSERT INTO projects (
      id, name, prompt, target_duration, platform, aspect_ratio,
      image_style, image_backend, language, tts_provider, tts_voice,
      status, progress, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', 0, ?, ?)
  `);

  stmt.run(
    id,
    data.name,
    data.prompt,
    data.targetDuration,
    data.platform,
    data.aspectRatio || "16:9",
    data.imageStyle || "cinematic",
    data.imageBackend || "auto",
    data.language || "en",
    data.ttsProvider || "kokoro",
    data.ttsVoice || "af_nova",
    now,
    now,
  );

  // Add characters if provided
  if (data.characters && data.characters.length > 0) {
    const charStmt = store.prepare(`
      INSERT INTO characters (id, project_id, name, description, reference_image_url, reference_image_path, style_tokens, color)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const char of data.characters) {
      charStmt.run(
        randomUUID(),
        id,
        char.name,
        char.description,
        char.referenceImageUrl || null,
        char.referenceImagePath || null,
        char.styleTokens || null,
        char.color || null,
      );
    }
  }

  return getProject(stateDir, id)!;
}

export function getProject(stateDir: string, id: string): StoryboardProject | null {
  const store = getStoryboardStore(stateDir);

  const row = store.prepare(`SELECT * FROM projects WHERE id = ?`).get(id) as any;
  if (!row) return null;

  const scenes = getProjectScenes(stateDir, id);
  const characters = getProjectCharacters(stateDir, id);

  return rowToProject(row, scenes, characters);
}

export function listProjects(
  stateDir: string,
  options?: { status?: ProjectStatus; limit?: number; offset?: number },
): StoryboardProject[] {
  const store = getStoryboardStore(stateDir);

  let sql = `SELECT * FROM projects`;
  const params: any[] = [];

  if (options?.status) {
    sql += ` WHERE status = ?`;
    params.push(options.status);
  }

  sql += ` ORDER BY created_at DESC`;

  if (options?.limit) {
    sql += ` LIMIT ?`;
    params.push(options.limit);
    if (options.offset) {
      sql += ` OFFSET ?`;
      params.push(options.offset);
    }
  }

  const rows = store.prepare(sql).all(...params) as any[];

  return rows.map((row) => {
    const scenes = getProjectScenes(stateDir, row.id);
    const characters = getProjectCharacters(stateDir, row.id);
    return rowToProject(row, scenes, characters);
  });
}

export function updateProject(
  stateDir: string,
  id: string,
  patch: Partial<
    Pick<
      StoryboardProject,
      | "name"
      | "prompt"
      | "targetDuration"
      | "platform"
      | "aspectRatio"
      | "imageStyle"
      | "imageBackend"
      | "script"
      | "status"
      | "error"
      | "progress"
    >
  >,
): StoryboardProject | null {
  const store = getStoryboardStore(stateDir);

  const updates: string[] = [];
  const params: any[] = [];

  if (patch.name !== undefined) {
    updates.push("name = ?");
    params.push(patch.name);
  }
  if (patch.prompt !== undefined) {
    updates.push("prompt = ?");
    params.push(patch.prompt);
  }
  if (patch.targetDuration !== undefined) {
    updates.push("target_duration = ?");
    params.push(patch.targetDuration);
  }
  if (patch.platform !== undefined) {
    updates.push("platform = ?");
    params.push(patch.platform);
  }
  if (patch.aspectRatio !== undefined) {
    updates.push("aspect_ratio = ?");
    params.push(patch.aspectRatio);
  }
  if (patch.imageStyle !== undefined) {
    updates.push("image_style = ?");
    params.push(patch.imageStyle);
  }
  if (patch.imageBackend !== undefined) {
    updates.push("image_backend = ?");
    params.push(patch.imageBackend);
  }
  if (patch.script !== undefined) {
    updates.push("script = ?");
    params.push(patch.script);
  }
  if (patch.status !== undefined) {
    updates.push("status = ?");
    params.push(patch.status);
    if (patch.status === "complete") {
      updates.push("completed_at = ?");
      params.push(Date.now());
    }
  }
  if (patch.error !== undefined) {
    updates.push("error = ?");
    params.push(patch.error);
  }
  if (patch.progress !== undefined) {
    updates.push("progress = ?");
    params.push(patch.progress);
  }

  if (updates.length === 0) return getProject(stateDir, id);

  updates.push("updated_at = ?");
  params.push(Date.now());
  params.push(id);

  store.prepare(`UPDATE projects SET ${updates.join(", ")} WHERE id = ?`).run(...params);

  return getProject(stateDir, id);
}

export function deleteProject(stateDir: string, id: string): boolean {
  const store = getStoryboardStore(stateDir);
  const result = store.prepare(`DELETE FROM projects WHERE id = ?`).run(id);
  return result.changes > 0;
}

// ═══════════════════════════════════════════════════════════════
// SCENE CRUD
// ═══════════════════════════════════════════════════════════════

export function getProjectScenes(stateDir: string, projectId: string): Scene[] {
  const store = getStoryboardStore(stateDir);
  const rows = store
    .prepare(`SELECT * FROM scenes WHERE project_id = ? ORDER BY idx`)
    .all(projectId) as any[];
  return rows.map(rowToScene);
}

export function addScenes(
  stateDir: string,
  projectId: string,
  scenes: Omit<Scene, "id" | "projectId" | "imageUrl" | "thumbnailUrl" | "imageStatus">[],
): Scene[] {
  const store = getStoryboardStore(stateDir);

  const stmt = store.prepare(`
    INSERT INTO scenes (
      id, project_id, idx, title, description, dialogue, voiceover,
      duration_seconds, image_prompt, image_status, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `);

  const result: Scene[] = [];

  for (const scene of scenes) {
    const id = randomUUID();
    stmt.run(
      id,
      projectId,
      scene.index,
      scene.title,
      scene.description,
      scene.dialogue || null,
      scene.voiceover || null,
      scene.durationSeconds,
      scene.imagePrompt,
      scene.metadata ? JSON.stringify(scene.metadata) : null,
    );

    result.push({
      id,
      projectId,
      ...scene,
      imageStatus: "pending",
    });
  }

  return result;
}

export function updateScene(
  stateDir: string,
  sceneId: string,
  patch: Partial<
    Pick<
      Scene,
      | "title"
      | "description"
      | "dialogue"
      | "voiceover"
      | "durationSeconds"
      | "imagePrompt"
      | "imageUrl"
      | "thumbnailUrl"
      | "audioUrl"
      | "imageStatus"
      | "imageError"
      | "effectPreset"
      | "overlayPreset"
    >
  >,
): Scene | null {
  const store = getStoryboardStore(stateDir);

  const updates: string[] = [];
  const params: any[] = [];

  if (patch.title !== undefined) {
    updates.push("title = ?");
    params.push(patch.title);
  }
  if (patch.description !== undefined) {
    updates.push("description = ?");
    params.push(patch.description);
  }
  if (patch.dialogue !== undefined) {
    updates.push("dialogue = ?");
    params.push(patch.dialogue);
  }
  if (patch.voiceover !== undefined) {
    updates.push("voiceover = ?");
    params.push(patch.voiceover);
  }
  if (patch.durationSeconds !== undefined) {
    updates.push("duration_seconds = ?");
    params.push(patch.durationSeconds);
  }
  if (patch.imagePrompt !== undefined) {
    updates.push("image_prompt = ?");
    params.push(patch.imagePrompt);
  }
  if (patch.imageUrl !== undefined) {
    updates.push("image_url = ?");
    params.push(patch.imageUrl);
  }
  if (patch.thumbnailUrl !== undefined) {
    updates.push("thumbnail_url = ?");
    params.push(patch.thumbnailUrl);
  }
  if (patch.audioUrl !== undefined) {
    updates.push("audio_url = ?");
    params.push(patch.audioUrl);
  }
  if (patch.imageStatus !== undefined) {
    updates.push("image_status = ?");
    params.push(patch.imageStatus);
  }
  if (patch.imageError !== undefined) {
    updates.push("image_error = ?");
    params.push(patch.imageError);
  }
  if (patch.effectPreset !== undefined) {
    updates.push("effect_preset = ?");
    params.push(patch.effectPreset);
  }
  if (patch.overlayPreset !== undefined) {
    updates.push("overlay_preset = ?");
    params.push(patch.overlayPreset);
  }

  if (updates.length === 0) return getScene(stateDir, sceneId);

  params.push(sceneId);
  store.prepare(`UPDATE scenes SET ${updates.join(", ")} WHERE id = ?`).run(...params);

  return getScene(stateDir, sceneId);
}

export function getScene(stateDir: string, sceneId: string): Scene | null {
  const store = getStoryboardStore(stateDir);
  const row = store.prepare(`SELECT * FROM scenes WHERE id = ?`).get(sceneId) as any;
  return row ? rowToScene(row) : null;
}

export function clearScenes(stateDir: string, projectId: string): void {
  const store = getStoryboardStore(stateDir);
  store.prepare(`DELETE FROM scenes WHERE project_id = ?`).run(projectId);
}

// ═══════════════════════════════════════════════════════════════
// CHARACTER CRUD
// ═══════════════════════════════════════════════════════════════

export function getProjectCharacters(stateDir: string, projectId: string): CharacterRef[] {
  const store = getStoryboardStore(stateDir);
  const rows = store
    .prepare(`SELECT * FROM characters WHERE project_id = ?`)
    .all(projectId) as any[];
  return rows.map(rowToCharacter);
}

export function addCharacter(
  stateDir: string,
  projectId: string,
  data: Omit<CharacterRef, "id">,
): CharacterRef {
  const store = getStoryboardStore(stateDir);
  const id = randomUUID();

  store
    .prepare(`
    INSERT INTO characters (id, project_id, name, description, reference_image_url, reference_image_path, style_tokens, color)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)
    .run(
      id,
      projectId,
      data.name,
      data.description,
      data.referenceImageUrl || null,
      data.referenceImagePath || null,
      data.styleTokens || null,
      data.color || null,
    );

  return { id, ...data };
}

export function updateCharacter(
  stateDir: string,
  characterId: string,
  patch: Partial<Omit<CharacterRef, "id">>,
): CharacterRef | null {
  const store = getStoryboardStore(stateDir);

  const updates: string[] = [];
  const params: any[] = [];

  if (patch.name !== undefined) {
    updates.push("name = ?");
    params.push(patch.name);
  }
  if (patch.description !== undefined) {
    updates.push("description = ?");
    params.push(patch.description);
  }
  if (patch.referenceImageUrl !== undefined) {
    updates.push("reference_image_url = ?");
    params.push(patch.referenceImageUrl);
  }
  if (patch.referenceImagePath !== undefined) {
    updates.push("reference_image_path = ?");
    params.push(patch.referenceImagePath);
  }
  if (patch.styleTokens !== undefined) {
    updates.push("style_tokens = ?");
    params.push(patch.styleTokens);
  }
  if (patch.color !== undefined) {
    updates.push("color = ?");
    params.push(patch.color);
  }

  if (updates.length === 0) return getCharacter(stateDir, characterId);

  params.push(characterId);
  store.prepare(`UPDATE characters SET ${updates.join(", ")} WHERE id = ?`).run(...params);

  return getCharacter(stateDir, characterId);
}

export function getCharacter(stateDir: string, characterId: string): CharacterRef | null {
  const store = getStoryboardStore(stateDir);
  const row = store.prepare(`SELECT * FROM characters WHERE id = ?`).get(characterId) as any;
  return row ? rowToCharacter(row) : null;
}

export function deleteCharacter(stateDir: string, characterId: string): boolean {
  const store = getStoryboardStore(stateDir);
  const result = store.prepare(`DELETE FROM characters WHERE id = ?`).run(characterId);
  return result.changes > 0;
}

// ═══════════════════════════════════════════════════════════════
// ROW CONVERTERS
// ═══════════════════════════════════════════════════════════════

function rowToProject(row: any, scenes: Scene[], characters: CharacterRef[]): StoryboardProject {
  return {
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    targetDuration: row.target_duration,
    platform: row.platform as Platform,
    aspectRatio: row.aspect_ratio,
    imageStyle: row.image_style,
    imageBackend: row.image_backend as ImageBackend,
    language: row.language || "en",
    ttsProvider: row.tts_provider || "kokoro",
    ttsVoice: row.tts_voice || "af_nova",
    script: row.script || undefined,
    scenes,
    characters,
    status: row.status as ProjectStatus,
    error: row.error || undefined,
    progress: row.progress,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at || undefined,
    timelinePrompting: row.timeline_prompting
      ? safeParseJson<TimelinePromptingProject>(row.timeline_prompting)
      : undefined,
  };
}

function rowToScene(row: any): Scene {
  return {
    id: row.id,
    projectId: row.project_id,
    index: row.idx,
    title: row.title,
    description: row.description,
    dialogue: row.dialogue || undefined,
    voiceover: row.voiceover || undefined,
    durationSeconds: row.duration_seconds,
    imagePrompt: row.image_prompt,
    imageUrl: row.image_url || undefined,
    thumbnailUrl: row.thumbnail_url || undefined,
    audioUrl: row.audio_url || undefined,
    imageStatus: row.image_status as SceneStatus,
    imageError: row.image_error || undefined,
    effectPreset: (row.effect_preset as EffectPreset) || "none",
    overlayPreset: (row.overlay_preset as EffectPreset) || undefined,
    metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    timelineBeats: row.timeline_beats
      ? safeParseJson<TimelineBeat[]>(row.timeline_beats)
      : undefined,
  };
}

function safeParseJson<T>(raw: string): T | undefined {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

// ═══════════════════════════════════════════════════════════════
// TIMELINE PROMPTING CRUD (Phase 8 addendum)
// ═══════════════════════════════════════════════════════════════

export function getTimelinePrompting(
  stateDir: string,
  projectId: string,
): TimelinePromptingProject | null {
  const store = getStoryboardStore(stateDir);
  const row = store
    .prepare(`SELECT timeline_prompting FROM projects WHERE id = ?`)
    .get(projectId) as any;
  if (!row?.timeline_prompting) return null;
  return safeParseJson<TimelinePromptingProject>(row.timeline_prompting) ?? null;
}

export function saveTimelinePrompting(
  stateDir: string,
  projectId: string,
  plan: TimelinePromptingProject | null,
): void {
  const store = getStoryboardStore(stateDir);
  store
    .prepare(`UPDATE projects SET timeline_prompting = ?, updated_at = ? WHERE id = ?`)
    .run(plan ? JSON.stringify(plan) : null, Date.now(), projectId);
}

export function getTimelineBeats(stateDir: string, projectId: string): TimelineBeat[] {
  const plan = getTimelinePrompting(stateDir, projectId);
  return plan?.beats ?? [];
}

export function saveTimelineBeats(
  stateDir: string,
  projectId: string,
  beats: TimelineBeat[],
): void {
  const current = getTimelinePrompting(stateDir, projectId);
  const plan: TimelinePromptingProject = current ?? {
    beats: [],
    totalDurationSec: 0,
    characterSlots: {},
    assetSlots: {},
    locationSlots: {},
  };
  plan.beats = beats;
  plan.totalDurationSec = beats.reduce((m, b) => Math.max(m, b.endSec), 0);
  saveTimelinePrompting(stateDir, projectId, plan);
}

export function getSceneBeats(stateDir: string, sceneId: string): TimelineBeat[] {
  const store = getStoryboardStore(stateDir);
  const row = store.prepare(`SELECT timeline_beats FROM scenes WHERE id = ?`).get(sceneId) as any;
  if (!row?.timeline_beats) return [];
  return safeParseJson<TimelineBeat[]>(row.timeline_beats) ?? [];
}

export function saveSceneBeats(stateDir: string, sceneId: string, beats: TimelineBeat[]): void {
  const store = getStoryboardStore(stateDir);
  store
    .prepare(`UPDATE scenes SET timeline_beats = ? WHERE id = ?`)
    .run(beats.length ? JSON.stringify(beats) : null, sceneId);
}

function rowToCharacter(row: any): CharacterRef {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    referenceImageUrl: row.reference_image_url || undefined,
    referenceImagePath: row.reference_image_path || undefined,
    styleTokens: row.style_tokens || undefined,
    color: row.color || undefined,
  };
}
