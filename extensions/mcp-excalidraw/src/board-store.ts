import { copyFile, mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

export type BoardSummary = { id: string; name: string; createdAt: number; updatedAt: number };

const ID_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;

function safeId(value: unknown): string {
  const id = String(value ?? "").trim();
  if (!ID_RE.test(id)) throw new Error("board id must use lowercase letters, numbers and hyphens");
  return id;
}

export class WhiteboardStore {
  readonly root: string;
  readonly boardsDir: string;
  readonly templatesDir: string;
  readonly legacyDir: string;
  private initialized = false;

  constructor(stateDir: string) {
    this.root = join(stateDir, "plugin-data", "whiteboard");
    this.boardsDir = join(this.root, "boards");
    this.templatesDir = join(this.root, "templates");
    this.legacyDir = join(stateDir, "files", "whiteboards");
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await mkdir(this.boardsDir, { recursive: true });
    await mkdir(this.templatesDir, { recursive: true });
    await this.migrateDirectory(this.legacyDir, this.boardsDir, false);
    await this.migrateDirectory(join(this.legacyDir, "templates"), this.templatesDir, true);
    this.initialized = true;
  }

  private async migrateDirectory(from: string, to: string, templates: boolean): Promise<void> {
    let entries: string[];
    try { entries = await readdir(from); } catch { return; }
    for (const entry of entries) {
      if (!entry.endsWith(".excalidraw")) continue;
      const source = join(from, entry);
      const target = join(to, basename(entry));
      try {
        await stat(target);
      } catch {
        await copyFile(source, target);
      }
    }
    if (!templates && entries.some((entry) => entry.endsWith(".excalidraw"))) {
      try { await writeFile(join(this.root, ".legacy-migration-complete"), `${new Date().toISOString()}\n`, { flag: "wx" }); }
      catch { /* Idempotent marker already exists. */ }
    }
  }

  private path(id: unknown, templates = false): string {
    return join(templates ? this.templatesDir : this.boardsDir, `${safeId(id)}.excalidraw`);
  }

  async list(templates = false): Promise<BoardSummary[]> {
    await this.initialize();
    const dir = templates ? this.templatesDir : this.boardsDir;
    const entries = await readdir(dir, { withFileTypes: true });
    const rows = await Promise.all(entries.filter((e) => e.isFile() && e.name.endsWith(".excalidraw")).map(async (e) => {
      const id = e.name.slice(0, -11);
      const meta = await stat(join(dir, e.name));
      return { id, name: id.replace(/-/g, " ").replace(/^\w/, (c) => c.toUpperCase()), createdAt: meta.birthtimeMs || meta.mtimeMs, updatedAt: meta.mtimeMs };
    }));
    return rows.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async get(id: unknown, templates = false): Promise<unknown> {
    await this.initialize();
    return JSON.parse(await readFile(this.path(id, templates), "utf8"));
  }

  async save(id: unknown, data: unknown, templates = false): Promise<BoardSummary> {
    await this.initialize();
    const target = this.path(id, templates);
    const temp = `${target}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(data, null, 2), "utf8");
    await rename(temp, target);
    return (await this.list(templates)).find((row) => row.id === safeId(id))!;
  }

  async remove(id: unknown, templates = false): Promise<void> {
    const { unlink } = await import("node:fs/promises");
    await unlink(this.path(id, templates));
  }

  async rename(id: unknown, nextId: unknown): Promise<void> {
    await this.initialize();
    await rename(this.path(id), this.path(nextId));
  }
}
