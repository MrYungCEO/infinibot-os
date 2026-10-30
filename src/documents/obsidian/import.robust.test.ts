import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DocumentStore } from "../store.js";
import type { DocNode } from "../types.js";
import { importObsidianVault, pickClosest, vaultKeyFor, VaultResolver } from "./import.js";
import { listFolderVault, type VaultFile } from "./vault-source.js";

const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001", "hex");
const PDF = Buffer.from("%PDF-1.4\n%fake\n");

let tmp: string;
let vault: string;
let store: DocumentStore;
const opts = { vaultKey: vaultKeyFor("folder:robust"), vaultName: "Robust", parentId: null };

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "obsidian-robust-"));
  vault = path.join(tmp, "vault");
  store = new DocumentStore(path.join(tmp, "documents"));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function write(rel: string, data: string | Buffer): void {
  const full = path.join(vault, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, data);
}

/** In-memory vault (lets tests use names the local filesystem would reject). */
function memVault(
  files: Record<string, string | Buffer>,
): VaultFile[] & { reads: Map<string, number> } {
  const reads = new Map<string, number>();
  const list = Object.entries(files).map(([p, data]) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    return {
      path: p,
      size: buf.length,
      read: async () => {
        reads.set(p, (reads.get(p) ?? 0) + 1);
        return buf;
      },
    };
  });
  return Object.assign(list, { reads });
}

const docsBySource = (): Map<string, DocNode[]> => {
  const m = new Map<string, DocNode[]>();
  for (const n of store.all()) {
    if (!n.source?.id) continue;
    const k = `${n.source.type}:${n.source.id}`;
    m.set(k, [...(m.get(k) ?? []), n]);
  }
  return m;
};
const dupKeys = () => [...docsBySource().entries()].filter(([, v]) => v.length > 1);
const byPath = (p: string): DocNode => {
  const n = store.findBySource("obsidian", `${opts.vaultKey}:${p}`);
  if (!n) throw new Error(`no node for ${p}`);
  return n;
};
const linksIn = (id: string): string[] =>
  [...store.getBody(id).matchAll(/\]\(doc:([a-zA-Z0-9_-]+)\)/g)].map((m) => m[1]!);

describe("VaultResolver duplicate titles", () => {
  const r = new VaultResolver([
    "A/Note.md",
    "B/Note.md",
    "B/sub/deep/Note.md",
    "Z/Linker.md",
    "B/sub/Linker.md",
  ]);
  it("prefers the linking note's folder", () => {
    expect(r.resolve("Note", "B/Linker.md")).toBe("B/Note.md");
    expect(r.resolve("Note", "B/sub/deep/Other.md")).toBe("B/sub/deep/Note.md");
  });
  it("then the longest shared folder prefix", () => {
    expect(r.resolve("Note", "B/sub/Linker.md")).toBe("B/sub/deep/Note.md");
    expect(r.resolve("Note", "B/sub/deep/x/y.md")).toBe("B/sub/deep/Note.md");
    // Tie on shared prefix ("B") → shortest path.
    expect(r.resolve("Note", "B/other/Linker.md")).toBe("B/Note.md");
  });
  it("then the shortest path", () => {
    expect(r.resolve("Note", "Z/Linker.md")).toBe("A/Note.md");
    expect(pickClosest(["x/long/N.md", "y/N.md"], "q/a.md")).toBe("y/N.md");
  });
  it("matches NFD targets against NFC paths and vice versa", () => {
    const u = new VaultResolver(["Café.md", "Résumé.md"]);
    expect(u.resolve("Café", "x.md")).toBe("Café.md");
    expect(u.resolve("Résumé", "x.md")).toBe("Résumé.md");
  });
});

describe("Obsidian import — links, attachments, structure", () => {
  beforeEach(() => {
    write(
      "Home.md",
      [
        "---",
        "aliases: [Start, Landing]",
        "tags: [hub]",
        "status: active",
        'related: "[[Projects/Alpha]]"',
        "---",
        "# Home",
        "Links: [[Alpha]], [[Alpha|the alpha]], [[Alpha#Goals]], [[Beta#^block|blk]].",
        "Bare dup from root: [[Meeting]].",
        "Relative md link: [beta](Projects/Beta.md) and [enc](Projects/Beta%20Two.md).",
        "Alias: [[Ideas]].",
        "Embed: ![[Alpha]]",
        "Image: ![[shot one é.png]] and PDF: ![[spec.pdf]]",
        "Broken: [[Does Not Exist]]",
        "```",
        "[[Code Link]] stays",
        "```",
      ].join("\n"),
    );
    write(
      "Projects/Alpha.md",
      "# Alpha\n## Goals\nShip. Back to [[Home]] and [[Start]].\n![[shot one é.png]]\n![[spec.pdf]]",
    );
    write(
      "Projects/Beta.md",
      "---\naliases: Ideas\n---\nBeta body ^block\n- [ ] todo 📅 2026-11-01",
    );
    write("Projects/Beta Two.md", "two");
    write("Projects/Meeting.md", "project meeting — [[Meeting]] (same folder)");
    write("Areas/Meeting.md", "area meeting");
    write("Areas/Deep/Nested/Leaf.md", "leaf → [[Meeting]] (closest: Areas)");
    write("attachments/shot one é.png", PNG);
    write("attachments/spec.pdf", PDF);
    write("attachments/orphan.pdf", PDF);
  });

  it("resolves wikilinks, aliases, headings, embeds, relative links and duplicates", async () => {
    const report = await importObsidianVault(store, listFolderVault(vault), opts);
    expect(report.errors).toEqual([]);
    const home = byPath("Home.md");
    const alpha = byPath("Projects/Alpha.md");
    const beta = byPath("Projects/Beta.md");
    const beta2 = byPath("Projects/Beta Two.md");
    const projMeeting = byPath("Projects/Meeting.md");
    const areaMeeting = byPath("Areas/Meeting.md");
    const body = store.getBody(home.id);
    expect(body).toContain(`[Alpha](doc:${alpha.id})`);
    expect(body).toContain(`[the alpha](doc:${alpha.id})`);
    expect(body).toContain(`[blk](doc:${beta.id})`);
    expect(body).toContain(`[beta](doc:${beta.id})`);
    expect(body).toContain(`[enc](doc:${beta2.id})`);
    expect(body).toContain(`[Ideas](doc:${beta.id})`); // alias
    expect(body).toContain(`> ↪ Embedded note: [Alpha](doc:${alpha.id})`);
    expect(body).toContain("[[Does Not Exist]]");
    expect(body).toContain("[[Code Link]] stays");
    // Duplicate titles: shortest path from the root, same folder, closest prefix.
    expect(linksIn(home.id)).toContain(areaMeeting.id); // "Areas/Meeting.md" < "Projects/Meeting.md"
    expect(linksIn(projMeeting.id)).toEqual([projMeeting.id]);
    expect(linksIn(byPath("Areas/Deep/Nested/Leaf.md").id)).toEqual([areaMeeting.id]);
    // Frontmatter link → doc ref; aliases resolve to the aliased note.
    expect(home.properties).toMatchObject({ status: "active", related: `doc:${alpha.id}` });
    expect(home.tags).toEqual(expect.arrayContaining(["hub"]));
    // [[Home]] + [[Start]] (alias of Home) + the embedded PDF.
    expect(linksIn(alpha.id)).toEqual([home.id, home.id, byPath("attachments/spec.pdf").id]);
    // Backlinks see body links and the frontmatter link.
    expect(store.backlinks(alpha.id).map((n) => n.id)).toEqual([home.id]);
    expect(store.backlinks(home.id).map((n) => n.id)).toEqual([alpha.id]);
    // Link stats: only [[Does Not Exist]] is unresolved.
    expect(report.links.unresolved).toBe(1);
    expect(report.links.unresolvedSample).toEqual([{ from: "Home.md", target: "Does Not Exist" }]);
    expect(report.links.resolved).toBeGreaterThanOrEqual(15);
    expect(report.links.rate).toBeGreaterThan(0.9);
    expect(report.summary).toMatchObject({ failed: 0, links: { unresolved: 1 } });
  });

  it("copies attachments once even when referenced from several notes", async () => {
    const report = await importObsidianVault(store, listFolderVault(vault), opts);
    const home = store.getBody(byPath("Home.md").id);
    const alpha = store.getBody(byPath("Projects/Alpha.md").id);
    const img = /!\[shot one é\.png\]\((\/api\/documents\/assets\/[a-f0-9]{24}\.png)\)/;
    expect(home).toMatch(img);
    expect(home.match(img)![1]).toBe(alpha.match(img)![1]);
    expect(fs.readdirSync(path.join(store.root, "assets"))).toHaveLength(1);
    const pdfs = store.all().filter((n) => n.kind === "file");
    expect(pdfs.map((n) => n.title).sort()).toEqual(["orphan.pdf", "spec.pdf"]);
    const spec = byPath("attachments/spec.pdf");
    expect(home).toContain(`(doc:${spec.id})`);
    expect(alpha).toContain(`(doc:${spec.id})`);
    expect(report.attachments).toBe(2);
    expect(report.assets).toBe(1);
  });

  it("mirrors nested folders as a folder hierarchy", async () => {
    await importObsidianVault(store, listFolderVault(vault), opts);
    const leaf = byPath("Areas/Deep/Nested/Leaf.md");
    expect(store.pathOf(leaf.id).map((n) => n.title)).toEqual([
      "Robust",
      "Areas",
      "Deep",
      "Nested",
      "Leaf",
    ]);
  });

  it("re-import is idempotent; a changed note is updated in place", async () => {
    const first = await importObsidianVault(store, listFolderVault(vault), opts);
    const count = store.all().length;
    if (process.env.DEBUG_ROBUST)
      console.log(
        JSON.stringify(first.summary),
        store.all().map((n) => n.title),
      );
    expect(first.created).toBe(count);
    const second = await importObsidianVault(store, listFolderVault(vault), opts);
    if (process.env.DEBUG_ROBUST) console.log(JSON.stringify(second.summary));
    expect(second.created).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.unchanged).toBe(count);
    expect(store.all()).toHaveLength(count);
    write("Projects/Beta.md", "---\naliases: Ideas\n---\nBeta body CHANGED ^block");
    const third = await importObsidianVault(store, listFolderVault(vault), opts);
    expect(third).toMatchObject({ created: 0, updated: 1 });
    expect(store.all()).toHaveLength(count);
    expect(store.getBody(byPath("Projects/Beta.md").id)).toContain("CHANGED");
    expect(dupKeys()).toEqual([]);
  });

  it("re-renders an unchanged note once its broken link becomes resolvable", async () => {
    await importObsidianVault(store, listFolderVault(vault), opts);
    write("Does Not Exist.md", "now it does");
    const r = await importObsidianVault(store, listFolderVault(vault), opts);
    expect(r.links.unresolved).toBe(0);
    expect(linksIn(byPath("Home.md").id)).toContain(byPath("Does Not Exist.md").id);
  });
});

describe("Obsidian import — unicode, long names, memory", () => {
  const longTitle = `${"Ünïcødé-长标题-".repeat(30)}end`; // > 255 bytes
  const files = () =>
    memVault({
      [`Long/${longTitle}.md`]: `long → [[🚀 Launch]] [[日本語ノート]] [[שלום עולם]]`,
      "🚀 Launch.md": "emoji note → [[" + longTitle + "]]",
      "日本語ノート.md": "CJK ![[画像 1.png]]",
      "שלום עולם.md": "RTL [[🚀 Launch|launch]]",
      "Café NFD.md": "decomposed name",
      "Links.md": "[[Café NFD]] (NFC link to an NFD file)",
      "画像 1.png": PNG,
    });

  it("imports emoji/CJK/RTL/NFD/>255-byte names without writing title-named files", async () => {
    const f = files();
    const report = await importObsidianVault(store, f, opts);
    expect(report.errors).toEqual([]);
    expect(report.links.unresolved).toBe(0);
    const titles = store.all().map((n) => n.title);
    expect(titles).toEqual(
      expect.arrayContaining([longTitle, "🚀 Launch", "日本語ノート", "שלום עולם", "Café NFD"]),
    );
    // NFC source keys.
    expect(store.findBySource("obsidian", `${opts.vaultKey}:Café NFD.md`)).not.toBeNull();
    // Every file the store wrote is named by node id / content hash, never by title.
    const ids = new Set(store.all().map((n) => n.id));
    for (const name of fs.readdirSync(path.join(store.root, "docs"))) {
      expect(ids.has(name.replace(/\.md$/, ""))).toBe(true);
      expect(Buffer.byteLength(name)).toBeLessThan(80);
    }
    for (const name of fs.readdirSync(path.join(store.root, "assets"))) {
      expect(name).toMatch(/^[a-f0-9]{24}\.png$/);
    }
    // Each note read at most twice (pass 1 hash + pass 2 render).
    for (const [p, n] of f.reads) expect(n, p).toBeLessThanOrEqual(2);
  });

  it("re-keys notes imported earlier under an NFD source key instead of duplicating", async () => {
    const nfd = "Café NFD.md";
    const legacy = store.create({
      kind: "doc",
      title: "Café NFD",
      body: "old",
      source: { type: "obsidian", id: `${opts.vaultKey}:${nfd}` },
    });
    await importObsidianVault(store, files(), opts);
    const hits = store.all().filter((n) => n.title.normalize("NFC") === "Café NFD");
    expect(hits.map((n) => n.id)).toEqual([legacy.id]);
    expect(store.getBody(legacy.id)).toBe("decomposed name");
  });
});

describe("Obsidian import — crash and resume", () => {
  const N = 120;
  const vaultFiles = () => {
    const files: Record<string, string | Buffer> = {};
    for (let i = 0; i < N; i++) {
      files[`F${i % 4}/Sub${i % 3}/Note ${i}.md`] =
        `note ${i} → [[Note ${(i + 1) % N}]] [[Note ${(i + 7) % N}|alias]] ![[pic ${i % 5}.png]] ![[doc ${i % 3}.pdf]]`;
    }
    for (let i = 0; i < 5; i++) files[`img/pic ${i}.png`] = Buffer.concat([PNG, Buffer.from([i])]);
    for (let i = 0; i < 3; i++) files[`files/doc ${i}.pdf`] = Buffer.from(`%PDF ${i}`);
    return memVault(files);
  };

  it("an aborted import re-run to completion leaves no duplicates", async () => {
    const ctl = new AbortController();
    let writes = 0;
    await expect(
      importObsidianVault(store, vaultFiles(), {
        ...opts,
        signal: ctl.signal,
        onWrite: () => {
          if (++writes === 40) ctl.abort();
        },
      }),
    ).rejects.toThrow();
    const report = await importObsidianVault(store, vaultFiles(), opts);
    expect(report.errors).toEqual([]);
    expect(dupKeys()).toEqual([]);
    expect(store.all().filter((n) => n.kind === "doc")).toHaveLength(N);
    expect(store.all().filter((n) => n.kind === "file")).toHaveLength(3);
  });

  it("recovers when the last unflushed index writes were lost (process killed)", async () => {
    // Capture the on-disk index mid-run (what survives a SIGKILL), abort, then
    // restore it under a fresh store instance — bodies/files written after the
    // last flush are on disk but missing from the index.
    const indexPath = path.join(store.root, "index.json");
    let snapshot: string | null = null;
    let writes = 0;
    const ctl = new AbortController();
    await expect(
      importObsidianVault(store, vaultFiles(), {
        ...opts,
        signal: ctl.signal,
        onWrite: () => {
          writes += 1;
          if (writes === 90)
            snapshot = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, "utf-8") : null;
          if (writes === 110) ctl.abort();
        },
      }),
    ).rejects.toThrow();
    if (snapshot) fs.writeFileSync(indexPath, snapshot);
    else fs.rmSync(indexPath, { force: true });
    const before = snapshot ? Object.keys(JSON.parse(snapshot).nodes).length : 0;
    expect(before).toBeLessThan(110);
    store = new DocumentStore(store.root);
    const report = await importObsidianVault(store, vaultFiles(), opts);
    expect(report.errors).toEqual([]);
    expect(dupKeys()).toEqual([]);
    const docs = store.all().filter((n) => n.kind === "doc");
    expect(docs).toHaveLength(N);
    // Orphaned bodies were overwritten by the stable ids, not duplicated.
    expect(fs.readdirSync(path.join(store.root, "docs"))).toHaveLength(N);
    expect(fs.readdirSync(path.join(store.root, "files"))).toHaveLength(3);
    // Every link resolves to a live node.
    for (const d of docs)
      for (const id of linksIn(d.id)) expect(store.getNode(id), id).not.toBeNull();
  });

  it("a per-note read failure is reported without aborting the rest", async () => {
    const files = vaultFiles();
    const bad = files.find((f) => f.path.endsWith("Note 5.md"))!;
    let calls = 0;
    bad.read = async () => {
      if (++calls > 1) throw new Error("EIO: disk hiccup");
      return Buffer.from("note 5");
    };
    const report = await importObsidianVault(store, files, opts);
    expect(report.errors.map((e) => e.id)).toEqual([bad.path]);
    expect(report.summary?.failed).toBe(1);
    expect(store.all().filter((n) => n.kind === "doc")).toHaveLength(N - 1);
  });
});
