import Database from "better-sqlite3";
import { mkdirSync, existsSync } from "fs";
import { dirname } from "path";
import { randomUUID } from "crypto";
import { stateFilePathWithLegacyMigration } from "../config/paths.js";

export interface PromptTemplate {
  id: string;
  name: string;
  description: string;
  body: string;
  tags: string[];
  category?: string;
  createdAt: number;
  updatedAt: number;
}

export interface PromptTemplateInput {
  name: string;
  description?: string;
  body: string;
  tags?: string[];
  category?: string;
}

export interface PromptTemplatePatch {
  name?: string;
  description?: string;
  body?: string;
  tags?: string[];
  category?: string;
}

export interface PromptTemplateListFilter {
  category?: string;
  tag?: string;
}

const SEED: PromptTemplateInput = {
  name: "Glass-morphism Control Deck Upgrade",
  description: "High-end glass + depth gradient HUD style for any page header / control deck",
  tags: ["ui", "vault", "glass-morphism", "style"],
  category: "UI Upgrades",
  body: `## Glass-morphism Control Deck

Use this pattern to upgrade any page header into a high-end glass-morphism control deck with depth, gradient richness, and a HUD/futuristic feel — matching the Kingly Vault aesthetic but elevated.

### Glass Morphism
- Layered translucent panels with \`backdrop-filter: blur(18px) saturate(140%)\`
- Subtle inner borders: \`box-shadow: inset 0 1px 0 color-mix(in srgb, white 8%, transparent)\`
- Low-opacity backgrounds: \`background: color-mix(in srgb, var(--g-primary) 4%, transparent)\`

### Depth Gradients
Multi-stop radial + linear gradients suggesting a curved glass surface:
\`\`\`css
background:
  radial-gradient(ellipse at top left,
    color-mix(in srgb, var(--vault-accent) 12%, transparent) 0%,
    transparent 60%),
  linear-gradient(135deg,
    color-mix(in srgb, var(--g-primary) 6%, transparent) 0%,
    color-mix(in srgb, var(--vault-accent) 3%, transparent) 100%);
\`\`\`

### Edge Glow / Ambient Lighting
\`\`\`css
box-shadow:
  0 20px 60px -20px color-mix(in srgb, var(--vault-accent) 30%, transparent),
  0 0 0 1px color-mix(in srgb, var(--vault-accent) 15%, transparent),
  inset 0 1px 0 color-mix(in srgb, white 8%, transparent);
\`\`\`

### Layered Content Stack
Inside the deck, layer these elements:
1. **Hero line**: page title with accent glyph (◆) + microcopy subtitle
2. **Live stat strip**: key metrics with sparkline-style mini bars; animate in on mount
3. **Quick filter chips**: status filters (All / Published / Draft / Archived)
4. **Action cluster**: primary CTA + secondary action + search input (instant filter)

### Design Tokens
Reuse these CSS custom properties — never hardcode hex (except subtle white overlays):
- \`var(--g-primary)\` — brand accent
- \`var(--vault-accent)\`, \`var(--vault-accent-bright)\` — vault-specific accent
- \`var(--vault-panel)\`, \`var(--vault-panel-border)\` — glass panel backgrounds
- \`var(--vault-text-dim)\` — muted text
- \`var(--vault-mono)\` — monospace font stack

### Motion
- Entry animation: \`translateY(-8px) → 0\` at 0.4s ease; plays once on mount
- Stat numbers animate in: \`translateY(5px) → 0\` at 0.5s ease, staggered delays
- Always gate animations behind \`@media (prefers-reduced-motion: reduce)\`

### Mobile-Safe
- Collapse to single column under ~640px using flex-wrap
- Disable parallax on mobile (parallax requires a separate scroll-listener setup)
- Stat strip becomes horizontal scroll with \`scrollbar-width: none\`
- Hide decorative glow / ambient elements if viewport is narrow
`,
};

let _db: Database.Database | null = null;

function getDb(): Database.Database {
  if (_db) return _db;
  // Canonical state dir, carrying forward any database left by the old
  // `<cwd>/state` fallback so upgrading does not present as an empty library.
  const dbPath = stateFilePathWithLegacyMigration("prompt-templates/templates.db");
  const dir = dirname(dbPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  _db = new Database(dbPath);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  setupSchema(_db);
  return _db;
}

function setupSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS prompt_templates (
      id          TEXT    PRIMARY KEY,
      name        TEXT    NOT NULL,
      description TEXT    NOT NULL DEFAULT '',
      body        TEXT    NOT NULL DEFAULT '',
      tags_json   TEXT    NOT NULL DEFAULT '[]',
      category    TEXT,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    )
  `);

  const count = (db.prepare("SELECT COUNT(*) as c FROM prompt_templates").get() as { c: number }).c;
  if (count === 0) {
    const now = Date.now();
    db.prepare(
      `INSERT INTO prompt_templates (id,name,description,body,tags_json,category,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run(
      randomUUID(),
      SEED.name,
      SEED.description ?? "",
      SEED.body,
      JSON.stringify(SEED.tags ?? []),
      SEED.category ?? null,
      now,
      now,
    );
  }
}

function rowToTemplate(row: Record<string, unknown>): PromptTemplate {
  return {
    id: row.id as string,
    name: row.name as string,
    description: (row.description as string) ?? "",
    body: (row.body as string) ?? "",
    tags: row.tags_json ? (JSON.parse(row.tags_json as string) as string[]) : [],
    category: (row.category as string | null) ?? undefined,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

export function init(): void {
  getDb();
}

export function list(filter?: PromptTemplateListFilter): PromptTemplate[] {
  const db = getDb();
  let rows: Record<string, unknown>[];
  if (filter?.category) {
    rows = db
      .prepare("SELECT * FROM prompt_templates WHERE category = ? ORDER BY updated_at DESC")
      .all(filter.category) as Record<string, unknown>[];
  } else {
    rows = db.prepare("SELECT * FROM prompt_templates ORDER BY updated_at DESC").all() as Record<
      string,
      unknown
    >[];
  }
  if (filter?.tag) {
    rows = rows.filter((r) => {
      try {
        return (JSON.parse(r.tags_json as string) as string[]).includes(filter.tag!);
      } catch {
        return false;
      }
    });
  }
  return rows.map(rowToTemplate);
}

export function get(id: string): PromptTemplate | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM prompt_templates WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToTemplate(row) : null;
}

export function create(input: PromptTemplateInput): PromptTemplate {
  const db = getDb();
  const id = randomUUID();
  const now = Date.now();
  db.prepare(
    `INSERT INTO prompt_templates (id,name,description,body,tags_json,category,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    input.name,
    input.description ?? "",
    input.body,
    JSON.stringify(input.tags ?? []),
    input.category ?? null,
    now,
    now,
  );
  return get(id)!;
}

export function update(id: string, patch: PromptTemplatePatch): PromptTemplate | null {
  const db = getDb();
  const existing = get(id);
  if (!existing) return null;
  const now = Date.now();
  db.prepare(
    `UPDATE prompt_templates
     SET name=?, description=?, body=?, tags_json=?, category=?, updated_at=?
     WHERE id=?`,
  ).run(
    patch.name ?? existing.name,
    patch.description ?? existing.description,
    patch.body ?? existing.body,
    JSON.stringify(patch.tags ?? existing.tags),
    patch.category !== undefined ? (patch.category ?? null) : (existing.category ?? null),
    now,
    id,
  );
  return get(id)!;
}

export function remove(id: string): boolean {
  const db = getDb();
  const result = db.prepare("DELETE FROM prompt_templates WHERE id = ?").run(id);
  return result.changes > 0;
}

export function search(query: string): PromptTemplate[] {
  const db = getDb();
  const q = `%${query}%`;
  const rows = db
    .prepare(
      `SELECT * FROM prompt_templates
       WHERE name LIKE ? OR description LIKE ? OR body LIKE ? OR category LIKE ?
       ORDER BY updated_at DESC`,
    )
    .all(q, q, q, q) as Record<string, unknown>[];
  return rows.map(rowToTemplate);
}
