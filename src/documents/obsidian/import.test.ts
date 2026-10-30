import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DocumentStore } from "../store.js";
import type { DocNode } from "../types.js";
import { importObsidianVault, vaultKeyFor } from "./import.js";
import {
  cloneGitVault,
  listFolderVault,
  listZipVault,
  safeVaultPath,
  validateGitUrl,
} from "./vault-source.js";

const FIXTURE = path.join(import.meta.dirname, "__fixtures__", "vault");

let tmp: string;
let store: DocumentStore;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "obsidian-import-"));
  store = new DocumentStore(path.join(tmp, "documents"));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const opts = { vaultKey: vaultKeyFor("folder:test"), vaultName: "My Vault", parentId: null };
const byTitle = (title: string): DocNode => {
  const n = store.tree().find((x) => x.title === title);
  if (!n) throw new Error(`no node ${title}`);
  return n;
};

async function zipOf(dir: string, prefix = "My Vault/"): Promise<Buffer> {
  const zip = new JSZip();
  for (const f of listFolderVault(dir)) zip.file(`${prefix}${f.path}`, await f.read());
  zip.file(`${prefix}.obsidian/workspace.json`, "{}");
  zip.file("__MACOSX/._Home.md", "x");
  return zip.generateAsync({ type: "nodebuffer" });
}

describe("vault sources", () => {
  it("lists a folder vault, skipping dot-folders", () => {
    const paths = listFolderVault(FIXTURE).map((f) => f.path);
    expect(paths).toContain("Home.md");
    expect(paths).toContain("attachments/diagram.png");
    expect(paths.some((p) => p.includes(".obsidian") || p.includes(".trash"))).toBe(false);
  });

  it("strips the wrapping folder of a vault zip and drops unsafe entries", async () => {
    const files = await listZipVault(await zipOf(FIXTURE));
    const paths = files.map((f) => f.path);
    expect(paths).toContain("Home.md");
    expect(paths).toContain("Projects/Alpha.md");
    expect(
      paths.some(
        (p) => p.startsWith("My Vault/") || p.includes("__MACOSX") || p.includes(".obsidian"),
      ),
    ).toBe(false);
    expect(safeVaultPath("../etc/passwd")).toBeNull();
    expect(safeVaultPath("a/./b.md")).toBe("a/b.md");
  });

  it("only accepts public https git URLs", () => {
    expect(validateGitUrl("https://github.com/me/vault.git")).toBe(
      "https://github.com/me/vault.git",
    );
    expect(() => validateGitUrl("git@github.com:me/vault.git")).toThrow(/https/);
    expect(() => validateGitUrl("file:///etc")).toThrow(/https/);
    expect(() => validateGitUrl("https://user:pw@github.com/x.git")).toThrow(/credentials/);
    expect(() => validateGitUrl("https://127.0.0.1/x.git")).toThrow(/Private/);
  });

  it("clones a git vault with the injected cloner and cleans up", async () => {
    const seen: string[] = [];
    const { dir, cleanup } = await cloneGitVault("https://example.com/v.git", {
      tmpRoot: tmp,
      clone: async (url, dest) => {
        seen.push(url);
        fs.cpSync(FIXTURE, dest, { recursive: true });
      },
    });
    expect(seen).toEqual(["https://example.com/v.git"]);
    expect(listFolderVault(dir).length).toBeGreaterThan(5);
    cleanup();
    expect(fs.existsSync(dir)).toBe(false);
  });
});

describe("importObsidianVault", () => {
  it("imports notes, folders, links, embeds, tags, daily notes, attachments and tasks", async () => {
    const r = await importObsidianVault(store, listFolderVault(FIXTURE), opts);
    expect(r.errors).toEqual([]);
    expect(r.notes).toBe(4);
    expect(r.dailyNotes).toBe(1);
    // vault root + Projects + Daily + attachments + Reference
    expect(
      store
        .tree()
        .filter((n) => n.kind === "folder")
        .map((n) => n.title)
        .sort(),
    ).toEqual(["Daily", "My Vault", "Projects", "Reference", "attachments"]);
    const home = byTitle("Home");
    const alpha = byTitle("Alpha");
    const beta = byTitle("Beta");
    expect(home.parentId).toBe(byTitle("My Vault").id);
    expect(alpha.parentId).toBe(byTitle("Projects").id);
    // Frontmatter → properties/tags; inline tags merged; title heading stripped.
    expect(home.properties).toMatchObject({
      created: "2026-09-01",
      rating: 5,
      obsidianPath: "Home.md",
    });
    expect(home.tags?.sort()).toEqual(["finance", "hub", "inline-tag", "nested/tag", "personal"]);
    const body = store.getBody(home.id);
    expect(body.startsWith("# Home")).toBe(false);
    expect(body).toContain(`[Alpha](doc:${alpha.id})`);
    expect(body).toContain(`[the alpha project](doc:${alpha.id})`);
    expect(body).toContain(`[Beta](doc:${beta.id})`);
    expect(body).toContain(`[Start](doc:${home.id})`); // alias [[Start]] → Home
    expect(body).toContain("[[Missing Note]]"); // unresolved stays as text
    expect(body).toContain(`[beta notes](doc:${beta.id})`);
    expect(body).toMatch(/!\[diagram\.png\]\(\/api\/documents\/assets\/[a-f0-9]{24}\.png\)/);
    expect(body).toMatch(/!\[chart\]\(\/api\/documents\/assets\/[a-f0-9]{24}\.png\)/);
    const spec = byTitle("spec.pdf");
    expect(spec.kind).toBe("file");
    expect(body).toContain(`[spec.pdf](doc:${spec.id})`);
    expect(body).toContain("[[Not A Link]]"); // inside code fence, untouched
    expect(r.links.unresolved).toBe(2); // [[Missing Note]] + [[In Code]] (outside the code span)
    // Embedded note + case-insensitive basename link.
    expect(store.getBody(alpha.id)).toContain(`> ↪ Embedded note: [Beta](doc:${beta.id})`);
    expect(store.getBody(beta.id)).toContain(`[alpha](doc:${alpha.id})`);
    // Backlinks work through the documents store's link index.
    expect(
      store
        .backlinks(alpha.id)
        .map((n) => n.title)
        .sort(),
    ).toEqual(["Beta", "Home"]);
    // Daily note.
    const daily = byTitle("2026-10-07");
    expect(daily.properties?.date).toBe("2026-10-07");
    expect(daily.tags).toContain("daily-note");
    // Loose PDF imported; unused image skipped.
    expect(byTitle("notes.pdf").kind).toBe("file");
    expect(store.tree().some((n) => n.title === "unused.png")).toBe(false);
    expect(r.assets).toBe(2);
    // Tasks (cancelled one skipped) with stable keys.
    // Notes are processed in vault path order (Daily/ sorts before Home.md).
    expect(r.tasks.map((t) => [t.text, t.done, t.due])).toEqual([
      ["Follow up with design #work", false, null],
      ["Call the bank #finance", false, "2026-10-15"],
      ["Pay rent", true, null],
      ["Ship alpha v1", false, "2026-12-01"],
    ]);
    expect(new Set(r.tasks.map((t) => t.key)).size).toBe(4);
  });

  it("re-sync is idempotent (path+hash) and picks up edits and removals", async () => {
    const vault = path.join(tmp, "vault");
    fs.cpSync(FIXTURE, vault, { recursive: true });
    const first = await importObsidianVault(store, listFolderVault(vault), opts);
    const count = store.tree().length;
    const again = await importObsidianVault(store, listFolderVault(vault), opts);
    expect(again.created).toBe(0);
    expect(again.updated).toBe(0);
    expect(again.unchanged).toBeGreaterThanOrEqual(first.notes);
    expect(store.tree().length).toBe(count);

    fs.appendFileSync(path.join(vault, "Projects/Beta.md"), "\nNew line.\n");
    fs.rmSync(path.join(vault, "Daily/2026-10-07.md"));
    const third = await importObsidianVault(store, listFolderVault(vault), opts);
    expect(third.updated).toBe(1);
    expect(third.created).toBe(0);
    expect(third.missing).toBe(1);
    expect(store.getBody(byTitle("Beta").id)).toContain("New line.");
  });

  it("a ZIP of the same vault produces the same tree", async () => {
    const r = await importObsidianVault(store, await listZipVault(await zipOf(FIXTURE)), opts);
    expect(r.errors).toEqual([]);
    expect(r.notes).toBe(4);
    expect(store.getBody(byTitle("Home").id)).toContain(`(doc:${byTitle("Alpha").id})`);
  });

  it("honours cancellation", async () => {
    const ctl = new AbortController();
    ctl.abort();
    await expect(
      importObsidianVault(store, listFolderVault(FIXTURE), { ...opts, signal: ctl.signal }),
    ).rejects.toThrow(/cancel/i);
  });
});
