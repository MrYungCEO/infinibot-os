/**
 * Documents import stress test: Obsidian vault + Notion "Markdown & CSV" ZIP.
 *
 *   node --import tsx scripts/import-stress.ts [--notes 5000] [--keep] [--seed 42]
 *   node --import tsx scripts/import-stress.ts --generate-only <dir>   # just write vault + zip
 *
 * What it does (everything under a fresh temp dir, never ~/.infinibot):
 *   1. generates a synthetic Obsidian vault (nested folders, duplicate titles,
 *      aliases, headings, embeds, attachments, unicode / NFD / long names,
 *      ~3% intentionally broken links) and a Notion export ZIP (page tree,
 *      two databases with relations, mentions, images, broken links);
 *   2. imports both into state dir A twice (run1, run2) through
 *      ImportJobManager — the same runner the gateway uses;
 *   3. starts run3 into state dir B in a child process and SIGKILLs it
 *      mid-way, then run4 resumes the interrupted jobs via
 *      ImportJobManager.resumeAll() (the gateway boot path);
 *   4. checks: idempotency, zero duplicate source keys / nodes, counts,
 *      link resolution (expected-resolvable links ~100%), duplicate-title
 *      resolution, no dangling doc: refs, no orphaned bodies; prints JSON.
 *
 * Each run is its own process so duration and peak RSS are per run.
 * Exits non-zero when any check fails.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(import.meta.url);
const REPO = path.resolve(path.dirname(SCRIPT), "..");

// ── CLI ───────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const opt = (name: string, def: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : def;
};

// ── Deterministic RNG ─────────────────────────────────────────

function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (n: number) => Math.floor(next() * n),
    pick: <T>(arr: T[]): T => arr[Math.floor(next() * arr.length)]!,
    chance: (p: number) => next() < p,
  };
}

const PNG_HEAD = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const encPath = (p: string) => p.split("/").map(encodeURIComponent).join("/");
const relLink = (fromFile: string, toFile: string) =>
  encPath(path.posix.relative(path.posix.dirname(fromFile) || ".", toFile));

// ── Obsidian vault generator ─────────────────────────────────

interface VaultManifest {
  notes: number;
  folders: number;
  attachments: number;
  pngs: number;
  pdfs: number;
  referencedPngs: number;
  linksTotal: number;
  linksBroken: number;
  dupTitleGroups: number;
  dupExpectations: Array<{ from: string; to: string }>;
  nfdNotes: number;
  longNameNotes: number;
}

function generateVault(dir: string, noteCount: number, seed: number): VaultManifest {
  const r = rng(seed);
  fs.mkdirSync(dir, { recursive: true });
  // Folders: 8 top-level areas, nested up to depth 5.
  const folderNames = ["Area", "Projects", "Ünïcødé 文件夹", "مجلد", "Archive", "Daily", "Ref", "Deep"];
  const folders: string[] = [""];
  for (let t = 0; t < folderNames.length; t++) {
    const top = `${folderNames[t]} ${t}`;
    folders.push(top);
    const walk = (base: string, depth: number) => {
      if (depth >= 5) return;
      const n = 1 + r.int(3);
      for (let i = 0; i < n; i++) {
        if (!r.chance(0.75)) continue;
        const sub = `${base}/${r.chance(0.1) ? "Sous-dossier é" : "Sub"} ${depth}.${i}`;
        folders.push(sub);
        walk(sub, depth + 1);
      }
    };
    walk(top, 1);
  }
  const longBase = "Very long title — 長い名前 — עברית — ";
  type Note = {
    i: number;
    title: string;
    dir: string;
    path: string;
    alias: string | null;
    nfd: boolean;
    dupOf: number | null;
    extra: string[];
  };
  const notes: Note[] = [];
  const dupCount = Math.round(noteCount * 0.05);
  let nfdNotes = 0;
  let longNameNotes = 0;
  for (let i = 0; i < noteCount; i++) {
    let title: string;
    let nfd = false;
    let dupOf: number | null = null;
    if (i >= noteCount - dupCount) {
      // Duplicate an earlier (non-duplicate, plain) note's title in another folder.
      let src: Note;
      do src = notes[r.int(noteCount - dupCount)]!;
      while (src.nfd || src.title.startsWith("Very long") || notes.some((n) => n.dupOf === src.i));
      title = src.title;
      dupOf = src.i;
    } else if (i % 500 === 7) {
      title = longBase;
      while (Buffer.byteLength(`${title}${longBase} ${i}.md`) < 250) title += longBase;
      title = `${title}${i}`;
      while (Buffer.byteLength(`${title}.md`) > 250) title = title.slice(0, -1);
      longNameNotes++;
    } else if (i % 61 === 3) {
      title = `Résumé ${i}`; // NFD on disk
      nfd = true;
      nfdNotes++;
    } else if (i % 50 === 1) title = `笔记 ${i} 🚀`;
    else if (i % 97 === 5) title = `ملاحظة ${i}`;
    else if (i % 211 === 9) title = `2026-0${1 + (i % 9)}-${String(1 + (i % 28)).padStart(2, "0")}`;
    else title = `Note ${i}`;
    let dir = r.pick(folders);
    if (dupOf !== null) {
      const srcDir = notes[dupOf]!.dir;
      while (dir === srcDir) dir = r.pick(folders);
    }
    const p = dir ? `${dir}/${title}.md` : `${title}.md`;
    if (notes.some((n) => n.path.normalize("NFC") === p.normalize("NFC"))) {
      // Daily-note titles can collide inside one folder; keep paths unique.
      i--;
      continue;
    }
    notes.push({
      i,
      title,
      dir,
      path: p,
      alias: r.chance(0.33) ? `Alias ${i}` : null,
      nfd,
      dupOf,
      extra: [],
    });
  }
  const nfc = (s: string) => s.normalize("NFC");
  const titleUses = new Map<string, number>();
  for (const n of notes) titleUses.set(nfc(n.title).toLowerCase(), (titleUses.get(nfc(n.title).toLowerCase()) ?? 0) + 1);
  const unique = notes.filter((n) => titleUses.get(nfc(n.title).toLowerCase()) === 1);
  // Attachments.
  const pngs: string[] = [];
  const pdfs: string[] = [];
  const attDirs = ["attachments", "attachments/images", "Area 0/assets", "Ünïcødé 文件夹 2/附件"];
  for (let i = 0; i < 150; i++) {
    const name = i % 10 === 0 ? `图片 ${i}.png` : i % 13 === 0 ? `café shot ${i}.png` : `img ${i}.png`;
    const p = `${attDirs[i % attDirs.length]}/${name}`;
    pngs.push(p);
    const full = path.join(dir, p);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, Buffer.concat([PNG_HEAD, Buffer.from(`png-${i}`)]));
  }
  for (let i = 0; i < 50; i++) {
    const name = i % 7 === 0 ? `résumé ${i}.pdf` : `doc ${i}.pdf`;
    const p = `${attDirs[i % attDirs.length]}/${name}`;
    pdfs.push(p);
    const full = path.join(dir, p);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, `%PDF-1.4\n% fake pdf ${i}\n`);
  }
  const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);
  // Duplicate-title expectations: a linker in each copy's own folder.
  const dupExpectations: Array<{ from: string; to: string }> = [];
  let dupTitleGroups = 0;
  for (const copy of notes.filter((n) => n.dupOf !== null)) {
    dupTitleGroups++;
    const orig = notes.find((n) => n.i === copy.dupOf)!;
    for (const member of [orig, copy]) {
      const other = member === orig ? copy : orig;
      const linker = notes.find(
        (n) => n.dir === member.dir && n !== member && n.dupOf === null && n.i !== orig.i,
      );
      if (linker && linker.dir !== other.dir) {
        linker.extra.push(`[[${nfc(member.title)}]]`);
        dupExpectations.push({ from: linker.path, to: member.path });
      }
    }
    // A vault-path link is exact regardless of proximity.
    const from = r.pick(unique);
    from.extra.push(`[[${copy.dir ? `${copy.dir}/` : ""}${copy.title}]]`);
    dupExpectations.push({ from: from.path, to: copy.path });
  }
  let linksTotal = 0;
  let linksBroken = 0;
  const referencedPngs = new Set<string>();
  let brokenSeq = 0;
  for (const n of notes) {
    const lines: string[] = [];
    const fmLines = ["---", `tags: [stress, t${n.i % 10}]`, `status: ${r.pick(["todo", "doing", "done"])}`, `n: ${n.i}`];
    if (n.alias) fmLines.push(`aliases: [${JSON.stringify(n.alias)}]`);
    if (r.chance(0.2)) {
      const t = r.pick(unique);
      fmLines.push(`related: ${JSON.stringify(`[[${nfc(t.title)}]]`)}`);
      linksTotal++;
    }
    fmLines.push("---");
    lines.push(...fmLines, `# ${nfc(n.title)}`, "", `Body of note ${n.i}. #inline-tag`, "", "## Heading 1", "");
    const linkCount = 4 + r.int(5);
    const tokens: string[] = [];
    for (let k = 0; k < linkCount; k++) {
      if (r.chance(0.03)) {
        tokens.push(`[[Missing Note ${brokenSeq++}]]`);
        linksBroken++;
        linksTotal++;
        continue;
      }
      const t = r.pick(unique);
      const tt = nfc(t.title);
      const kind = r.int(8);
      if (kind === 0) tokens.push(`[[${tt}|see ${t.i}]]`);
      else if (kind === 1) tokens.push(`[[${tt}#Heading 1]]`);
      else if (kind === 2) tokens.push(`![[${tt}]]`);
      else if (kind === 3 && t.alias) tokens.push(`[[${t.alias}]]`);
      else if (kind === 4) tokens.push(`[md link](${relLink(n.path, t.path.normalize("NFC"))})`);
      else if (kind === 5) {
        const img = r.pick(pngs);
        referencedPngs.add(img);
        tokens.push(r.chance(0.5) ? `![[${nfc(base(img))}]]` : `![shot](${relLink(n.path, nfc(img))})`);
      } else if (kind === 6) {
        const pdf = r.pick(pdfs);
        tokens.push(`![[${nfc(base(pdf))}]]`);
      } else tokens.push(`[[${tt}]]`);
      linksTotal++;
    }
    for (const e of n.extra) {
      tokens.push(e);
      linksTotal++;
    }
    lines.push(tokens.join(" · "), "", "```", "[[Not A Link In Code]]", "```", "", "- [ ] a task 📅 2026-12-01", "");
    const full = path.join(dir, n.path);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, lines.join("\n"));
  }
  return {
    notes: notes.length,
    folders: folders.length - 1,
    attachments: pngs.length + pdfs.length,
    pngs: pngs.length,
    pdfs: pdfs.length,
    referencedPngs: referencedPngs.size,
    linksTotal,
    linksBroken,
    dupTitleGroups,
    dupExpectations,
    nfdNotes,
    longNameNotes,
  };
}

// ── Notion export generator ──────────────────────────────────

interface NotionManifest {
  pages: number;
  rows: number;
  csvOnlyRows: number;
  docs: number;
  linksTotal: number;
  linksBroken: number;
  relationItems: number;
  relationBroken: number;
}

async function generateNotionZip(file: string, seed: number): Promise<NotionManifest> {
  const { default: JSZip } = await import("jszip");
  const r = rng(seed + 1);
  const zip = new JSZip();
  let hexSeq = 0;
  const hex = () => (0xabc0000 + ++hexSeq).toString(16).padStart(32, "0");
  const files = new Map<string, string | Buffer>();
  type Page = { title: string; id: string; md: string; dir: string; children: Page[] };
  const mkPage = (title: string, parentDir: string): Page => {
    const id = hex();
    const stem = `${title} ${id}`;
    const md = parentDir ? `${parentDir}/${stem}.md` : `${stem}.md`;
    return { title, id, md, dir: md.replace(/\.md$/, ""), children: [] };
  };
  const root = mkPage("Workspace Home", "");
  const pages: Page[] = [root];
  const longTitle = `🚀 ${"Ünïcødé 长标题 עברית ".repeat(16)}end`;
  for (let s = 0; s < 10; s++) {
    const sec = mkPage(s === 3 ? longTitle : s === 4 ? `🚀 发布 ${s}` : `Section ${s}`, root.dir);
    root.children.push(sec);
    pages.push(sec);
    for (let c = 0; c < 6; c++) {
      const ch = mkPage(`Section ${s}.${c}`, sec.dir);
      sec.children.push(ch);
      pages.push(ch);
      for (let g = 0; g < 4; g++) {
        const gc = mkPage(`Page ${s}.${c}.${g}`, ch.dir);
        ch.children.push(gc);
        pages.push(gc);
      }
    }
  }
  // Databases under the root page.
  const projDb = { title: "Projects", id: hex() };
  const taskDb = { title: "Tasks", id: hex() };
  const projKey = `${root.dir}/${projDb.title} ${projDb.id}`;
  const taskKey = `${root.dir}/${taskDb.title} ${taskDb.id}`;
  type Row = { title: string; id: string; md: string; hasPage: boolean };
  const projects: Row[] = Array.from({ length: 100 }, (_, i) => {
    const id = hex();
    return { title: `Project ${i}`, id, md: `${projKey}/Project ${i} ${id}.md`, hasPage: i % 10 !== 9 };
  });
  const tasks: Row[] = Array.from({ length: 600 }, (_, i) => {
    const id = hex();
    return { title: `Task ${i}`, id, md: `${taskKey}/Task ${i} ${id}.md`, hasPage: i % 10 !== 9 };
  });
  let linksTotal = 0;
  let linksBroken = 0;
  let relationItems = 0;
  let relationBroken = 0;
  const images: string[] = [];
  for (let i = 0; i < 20; i++) {
    const p = `${pages[1 + i]!.dir}/image ${i} é.png`;
    images.push(p);
    files.set(p, Buffer.concat([PNG_HEAD, Buffer.from(`notion-${i}`)]));
  }
  const all = [...pages];
  for (const pg of pages) {
    const lines = [`# ${pg.title}`, "", `Intro for ${pg.title}.`, ""];
    for (const ch of pg.children) {
      lines.push(`[${ch.title}](${relLink(pg.md, ch.md)})`);
      linksTotal++;
    }
    for (let k = 0; k < 3; k++) {
      const t = r.pick(all);
      if (r.chance(0.5)) lines.push(`Mention [${t.title}](https://www.notion.so/${encodeURIComponent(t.title.replace(/\s+/g, "-"))}-${t.id})`);
      else lines.push(`Link [${t.title}](${relLink(pg.md, t.md)})`);
      linksTotal++;
    }
    if (r.chance(0.04)) {
      lines.push(`Broken [gone](${relLink(pg.md, `Missing ${hex()}.md`)})`);
      linksTotal++;
      linksBroken++;
    }
    if (r.chance(0.3)) lines.push(`![img](${relLink(pg.md, r.pick(images))})`);
    if (pg === root) {
      lines.push(`[Projects](${relLink(pg.md, `${projKey}.csv`)}) · [Tasks](${relLink(pg.md, `${taskKey}.csv`)})`);
      linksTotal += 2;
    }
    files.set(pg.md, lines.join("\n"));
  }
  // Relations: each task → 1–2 projects; ~2% point at rows missing from the export.
  const taskProjects = new Map<number, Row[]>();
  const projTasks = new Map<number, Row[]>();
  const relCell = (fromCsvDir: string, targets: Row[]) =>
    targets.map((t) => `${t.title} (${relLink(`${fromCsvDir}/x.csv`, t.md)})`).join(", ");
  tasks.forEach((t, i) => {
    const ps: Row[] = [];
    const n = 1 + r.int(2);
    for (let k = 0; k < n; k++) {
      if (r.chance(0.02)) {
        const id = hex();
        ps.push({ title: `Ghost project ${i}.${k}`, id, md: `${projKey}/Ghost project ${i}.${k} ${id}.md`, hasPage: false });
        relationBroken++;
      } else {
        const pr = projects[r.int(projects.length)]!;
        if (!ps.includes(pr)) ps.push(pr);
        const pi = projects.indexOf(pr);
        const list = projTasks.get(pi) ?? [];
        if (list.length < 5) list.push(t);
        projTasks.set(pi, list);
      }
    }
    taskProjects.set(i, ps);
    relationItems += ps.length;
  });
  for (const list of projTasks.values()) relationItems += list.length;
  const csvDir = root.dir;
  const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
  files.set(
    `${projKey}.csv`,
    [
      "Name,Status,Tasks,Budget",
      ...projects.map((p, i) => [q(p.title), r.pick(["Active", "Done", "Paused"]), q(relCell(csvDir, projTasks.get(i) ?? [])), String(1000 + i)].join(",")),
    ].join("\n"),
  );
  files.set(
    `${taskKey}.csv`,
    [
      "Name,Project,Done,Due",
      ...tasks.map((t, i) => [q(t.title), q(relCell(csvDir, taskProjects.get(i) ?? [])), i % 2 ? "Yes" : "No", "2026-11-0" + (1 + (i % 9))].join(",")),
    ].join("\n"),
  );
  for (const [list, kind] of [[projects, "project"], [tasks, "task"]] as const) {
    for (const row of list) {
      if (!row.hasPage) continue;
      const target = r.pick(all);
      files.set(
        row.md,
        `# ${row.title}\n\nStatus: x\n\nThis ${kind} links [${target.title}](${relLink(row.md, target.md)}).`,
      );
      linksTotal++;
    }
  }
  for (const [p, d] of files) zip.file(`Export-stress/${p}`, d);
  fs.writeFileSync(file, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
  const rows = projects.length + tasks.length;
  return {
    pages: pages.length,
    rows,
    csvOnlyRows: [...projects, ...tasks].filter((x) => !x.hasPage).length,
    docs: pages.length + rows,
    linksTotal,
    linksBroken,
    relationItems,
    relationBroken,
  };
}

// ── Child: run imports through ImportJobManager ──────────────

function emit(obj: unknown): void {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

async function childMain(mode: "import" | "resume", state: string, vault: string, zipFile: string) {
  process.env.INFINIBOT_STATE_DIR = state; // before any app module loads
  let peakRss = 0;
  const sample = () => (peakRss = Math.max(peakRss, process.memoryUsage().rss));
  const sampler = setInterval(sample, 100);
  const t0 = Date.now();
  const { ImportJobManager } = await import("../src/documents/import-jobs.js");
  const manager = new ImportJobManager({
    dir: path.join(state, "documents-import-jobs"),
    resolveApiKey: () => null,
    createClient: () => {
      throw new Error("Notion API is not used by the stress test");
    },
    broadcast: (_event, payload) => {
      const job = (payload as { job?: { id: string; kind: string; status: string; progress: { phase: string; done: number; total: number } } }).job;
      if (job) emit({ t: "progress", id: job.id, kind: job.kind, status: job.status, ...job.progress });
    },
    documentsChanged: () => {},
    extractAttachment: null,
    progressThrottleMs: 250,
  });
  const ids: string[] = [];
  if (mode === "import") {
    ids.push(manager.startObsidian({ source: "folder", origin: vault, vaultName: "Stress Vault", parentId: null }).job.id);
    ids.push(manager.startZip({ data: fs.readFileSync(zipFile), name: "notion-export.zip", parentId: null }).id);
    emit({ t: "started", ids });
  } else {
    const { resumed, failed } = manager.resumeAll();
    emit({ t: "resumed", resumed, failed });
    ids.push(...resumed);
  }
  const jobs = [];
  for (const id of ids) jobs.push(await manager.wait(id, 30 * 60_000));
  clearInterval(sampler);
  sample();
  emit({
    t: "result",
    durationMs: Date.now() - t0,
    peakRssMB: Math.round(peakRss / 1024 / 1024),
    maxRssMB: Math.round(process.resourceUsage().maxRSS / 1024),
    jobs: jobs.map((j) => ({
      id: j?.id,
      kind: j?.kind,
      status: j?.status,
      error: j?.error,
      attempts: j?.attempts,
      report: j?.report,
      details: j?.details,
    })),
  });
}

// ── Parent orchestration ─────────────────────────────────────

interface ChildResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  killedAt?: { done: number; total: number; kind: string };
  result?: {
    durationMs: number;
    peakRssMB: number;
    maxRssMB: number;
    jobs: Array<{ id: string; kind: string; status: string; error?: string; attempts: number; report: Record<string, unknown> & { errors: unknown[] }; details?: Record<string, unknown> }>;
  };
  stderr: string;
}

function runChild(
  mode: "import" | "resume",
  state: string,
  vault: string,
  zipFile: string,
  killWhen?: (p: { kind: string; phase: string; done: number; total: number }) => boolean,
): Promise<ChildResult> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", SCRIPT, "--child", mode, "--state", state, "--vault", vault, "--zip", zipFile],
      { cwd: REPO, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, INFINIBOT_STATE_DIR: state } },
    );
    const out: ChildResult = { code: null, signal: null, stderr: "" };
    let buf = "";
    child.stdout.on("data", (d: Buffer) => {
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (msg.t === "result") out.result = msg as unknown as ChildResult["result"];
        if (msg.t === "progress" && killWhen && !out.killedAt) {
          const p = msg as unknown as { kind: string; phase: string; done: number; total: number };
          if (killWhen(p)) {
            out.killedAt = { done: p.done, total: p.total, kind: p.kind };
            child.kill("SIGKILL");
          }
        }
      }
    });
    child.stderr.on("data", (d: Buffer) => {
      out.stderr = (out.stderr + d.toString()).slice(-4000);
    });
    child.on("exit", (code, signal) => {
      out.code = code;
      out.signal = signal;
      resolve(out);
    });
  });
}

type Store = import("../src/documents/store.js").DocumentStore;

function storeStats(store: Store) {
  const nodes = store.all();
  const live = nodes.filter((n) => !store.isHidden(n));
  const keyCount = new Map<string, number>();
  for (const n of live) {
    if (!n.source?.id) continue;
    const k = `${n.source.type}:${n.source.id}`;
    keyCount.set(k, (keyCount.get(k) ?? 0) + 1);
  }
  const dupSourceKeys = [...keyCount.values()].filter((c) => c > 1).length;
  // Duplicate nodes: same parent + kind + title + source type among live nodes.
  const nodeKey = new Map<string, number>();
  for (const n of live) {
    const k = `${n.parentId}|${n.kind}|${n.title}|${n.source?.type}|${n.source?.id}`;
    nodeKey.set(k, (nodeKey.get(k) ?? 0) + 1);
  }
  const dupNodes = [...nodeKey.values()].filter((c) => c > 1).length;
  const ids = new Set(nodes.map((n) => n.id));
  let dangling = 0;
  for (const n of live) {
    if (n.kind !== "doc") continue;
    for (const m of store.getBody(n.id).matchAll(/\]\(doc:([a-zA-Z0-9_-]+)\)/g)) if (!ids.has(m[1]!)) dangling++;
    for (const v of Object.values(n.properties ?? {})) {
      for (const x of Array.isArray(v) ? v : [v]) {
        const m = typeof x === "string" ? /^doc:(.+)$/.exec(x) : null;
        if (m && !ids.has(m[1]!)) dangling++;
      }
    }
  }
  const docFiles = fs.readdirSync(path.join(store.root, "docs")).filter((f) => f.endsWith(".md"));
  const orphanBodies = docFiles.filter((f) => !ids.has(f.slice(0, -3))).length;
  const fileDirs = fs.readdirSync(path.join(store.root, "files"));
  const orphanFiles = fileDirs.filter((f) => !ids.has(f)).length;
  const by = (type: string, kind: string) => live.filter((n) => n.source?.type === type && n.kind === kind).length;
  return {
    nodes: nodes.length,
    obsidian: { docs: by("obsidian", "doc"), folders: by("obsidian", "folder"), files: by("obsidian", "file") },
    notion: {
      docs: by("notion", "doc") + by("notion-zip", "doc"),
      folders: by("notion", "folder") + by("notion-zip", "folder"),
    },
    assets: fs.existsSync(path.join(store.root, "assets")) ? fs.readdirSync(path.join(store.root, "assets")).length : 0,
    dupSourceKeys,
    dupNodes,
    danglingDocRefs: dangling,
    orphanBodies,
    orphanFileDirs: orphanFiles,
  };
}

function runSummary(name: string, c: ChildResult) {
  const job = (kind: string) => {
    const j = c.result?.jobs.find((x) => x.kind === kind);
    if (!j) return null;
    const rep = j.report as Record<string, unknown> & { errors: unknown[]; links?: Record<string, unknown> };
    return {
      status: j.status,
      attempts: j.attempts,
      error: j.error,
      created: rep.created,
      updated: rep.updated,
      unchanged: rep.unchanged,
      skipped: rep.skipped,
      failed: rep.errors.length,
      links: rep.links
        ? { resolved: rep.links.resolved, unresolved: rep.links.unresolved, rate: rep.links.rate }
        : null,
      firstErrors: rep.errors.slice(0, 3),
    };
  };
  return {
    run: name,
    exit: c.signal ?? c.code,
    killedAt: c.killedAt,
    durationMs: c.result?.durationMs ?? null,
    peakRssMB: c.result?.peakRssMB ?? null,
    maxRssMB: c.result?.maxRssMB ?? null,
    obsidian: job("obsidian"),
    notionZip: job("notion-zip"),
  };
}

async function parentMain() {
  const notes = Number(opt("notes", "5000"));
  const seed = Number(opt("seed", "42"));
  const genOnly = argv.includes("--generate-only") ? opt("generate-only", "") : null;
  const tmp = genOnly ? path.resolve(genOnly) : fs.mkdtempSync(path.join(os.tmpdir(), "ib-import-stress-"));
  // Isolation: nothing in this process or its children may touch the real state dir.
  process.env.INFINIBOT_STATE_DIR = path.join(tmp, "state-parent");
  const vault = path.join(tmp, "vault");
  const zipFile = path.join(tmp, "notion-export.zip");
  const tGen = Date.now();
  const vm = generateVault(vault, notes, seed);
  const nm = await generateNotionZip(zipFile, seed);
  const generation = { ms: Date.now() - tGen, dir: tmp, zipBytes: fs.statSync(zipFile).size };
  if (genOnly) {
    emit({ generated: { ...generation, vault, zipFile, vaultManifest: { ...vm, dupExpectations: vm.dupExpectations.length }, notionManifest: nm } });
    return;
  }
  const stateA = path.join(tmp, "state-a");
  const stateB = path.join(tmp, "state-b");
  const failures: string[] = [];
  const check = (ok: boolean, msg: string) => {
    if (!ok) failures.push(msg);
  };

  const run1 = await runChild("import", stateA, vault, zipFile);
  const run2 = await runChild("import", stateA, vault, zipFile);
  // run3: fresh state dir, killed once the vault import is ~40% through writing.
  const run3 = await runChild("import", stateB, vault, zipFile, (p) =>
    p.kind === "obsidian" && p.phase === "write" && p.total > 0 && p.done >= p.total * 0.4,
  );
  const jobsDir = path.join(stateB, "documents-import-jobs");
  const onDisk = fs.existsSync(jobsDir)
    ? fs
        .readdirSync(jobsDir)
        .filter((f) => /^imp_[^.]+\.json$/.test(f))
        .map((f) => JSON.parse(fs.readFileSync(path.join(jobsDir, f), "utf-8")) as { kind: string; status: string })
    : [];
  const run4 = await runChild("resume", stateB, vault, zipFile);

  const { DocumentStore } = await import("../src/documents/store.js");
  const storeA = new DocumentStore(path.join(stateA, "documents"));
  const storeB = new DocumentStore(path.join(stateB, "documents"));
  const a = storeStats(storeA);
  const b = storeStats(storeB);

  const runs = [runSummary("run1", run1), runSummary("run2", run2), runSummary("run3-killed", run3), runSummary("run4-resume", run4)];
  // ── Checks ─────────────────────────────────────────────
  for (const [name, r] of [["run1", runs[0]!], ["run2", runs[1]!]] as const) {
    check(r.exit === 0, `${name} exited ${String(r.exit)}`);
    check(r.obsidian?.status === "done" && r.notionZip?.status === "done", `${name} jobs not done`);
    check(r.obsidian?.failed === 0 && r.notionZip?.failed === 0, `${name} had item failures`);
  }
  check(runs[1]!.obsidian?.created === 0 && runs[1]!.obsidian?.updated === 0, "run2 obsidian not idempotent");
  check(runs[1]!.notionZip?.created === 0 && runs[1]!.notionZip?.updated === 0, "run2 notion not idempotent");
  check(
    runs[1]!.obsidian?.unchanged === runs[0]!.obsidian?.created,
    "run2 obsidian unchanged != run1 created",
  );
  check(
    runs[1]!.notionZip?.unchanged === runs[0]!.notionZip?.created,
    "run2 notion unchanged != run1 created",
  );
  check(run3.signal === "SIGKILL" && !!run3.killedAt, "run3 was not killed mid-way");
  check(onDisk.some((j) => j.kind === "obsidian" && j.status === "running"), "killed job not left running on disk");
  check(runs[3]!.exit === 0, `resume exited ${String(runs[3]!.exit)}`);
  check(
    runs[3]!.obsidian?.status === "done" && runs[3]!.notionZip?.status === "done",
    "resumed jobs not done",
  );
  check((runs[3]!.obsidian?.attempts ?? 0) >= 2, "obsidian job was not resumed (attempts < 2)");
  for (const [name, s] of [["A", a], ["B", b]] as const) {
    check(s.dupSourceKeys === 0, `state ${name}: ${s.dupSourceKeys} duplicate source keys`);
    check(s.dupNodes === 0, `state ${name}: ${s.dupNodes} duplicate nodes`);
    check(s.danglingDocRefs === 0, `state ${name}: ${s.danglingDocRefs} dangling doc: refs`);
    check(s.obsidian.docs === vm.notes, `state ${name}: ${s.obsidian.docs} obsidian docs, expected ${vm.notes}`);
    check(s.obsidian.files === vm.pdfs, `state ${name}: ${s.obsidian.files} file nodes, expected ${vm.pdfs}`);
    check(s.notion.docs === nm.docs, `state ${name}: ${s.notion.docs} notion docs, expected ${nm.docs}`);
    check(s.orphanBodies === 0, `state ${name}: ${s.orphanBodies} orphaned doc bodies`);
  }
  check(
    JSON.stringify({ ...a, nodes: 0, orphanFileDirs: 0 }) === JSON.stringify({ ...b, nodes: 0, orphanFileDirs: 0 }),
    "killed+resumed state differs from the clean import",
  );
  // Links (run1 rendered every note).
  const ol = runs[0]!.obsidian?.links as { resolved: number; unresolved: number } | null;
  const nl = runs[0]!.notionZip?.links as { resolved: number; unresolved: number } | null;
  const obsTotal = ol ? ol.resolved + ol.unresolved : 0;
  const notionTotal = nl ? nl.resolved + nl.unresolved : 0;
  const notionExpectedBroken = nm.linksBroken + nm.relationBroken;
  const linkReport = {
    obsidian: {
      expectedTotal: vm.linksTotal,
      expectedBroken: vm.linksBroken,
      rendered: obsTotal,
      resolved: ol?.resolved ?? 0,
      unresolved: ol?.unresolved ?? 0,
      resolutionRateExcludingBroken: ol ? ol.resolved / Math.max(1, obsTotal - vm.linksBroken) : 0,
    },
    notionZip: {
      expectedTotal: nm.linksTotal + nm.relationItems,
      expectedBroken: notionExpectedBroken,
      rendered: notionTotal,
      resolved: nl?.resolved ?? 0,
      unresolved: nl?.unresolved ?? 0,
      resolutionRateExcludingBroken: nl ? nl.resolved / Math.max(1, notionTotal - notionExpectedBroken) : 0,
    },
  };
  check(obsTotal === vm.linksTotal, `obsidian rendered ${obsTotal} links, generated ${vm.linksTotal}`);
  check(ol?.unresolved === vm.linksBroken, `obsidian unresolved ${ol?.unresolved} != broken ${vm.linksBroken}`);
  check(linkReport.obsidian.resolutionRateExcludingBroken >= 0.999, "obsidian resolution rate < 99.9%");
  check(nl?.unresolved === notionExpectedBroken, `notion unresolved ${nl?.unresolved} != broken ${notionExpectedBroken}`);
  check(linkReport.notionZip.resolutionRateExcludingBroken >= 0.999, "notion resolution rate < 99.9%");
  // Duplicate titles resolved Obsidian-style.
  const vk = (await import("../src/documents/obsidian/import.js")).vaultKeyFor(`folder:${vault}`);
  let dupOk = 0;
  const dupBad: Array<{ from: string; to: string }> = [];
  for (const e of vm.dupExpectations) {
    const from = storeA.findBySource("obsidian", `${vk}:${e.from.normalize("NFC")}`);
    const to = storeA.findBySource("obsidian", `${vk}:${e.to.normalize("NFC")}`);
    if (from && to && storeA.getBody(from.id).includes(`(doc:${to.id})`)) dupOk++;
    else dupBad.push(e);
  }
  check(dupBad.length === 0, `${dupBad.length}/${vm.dupExpectations.length} duplicate-title links resolved to the wrong note`);
  // Backlinks + relation links through the store API.
  const someTask = storeA.all().find((n) => n.title === "Task 1" && n.source?.type === "notion");
  const relTarget = someTask?.properties?.Project;
  const relDocs = Array.isArray(relTarget) ? relTarget.filter((x) => String(x).startsWith("doc:")) : [];
  const relBacklinkOk = relDocs.every((ref) =>
    storeA.backlinks(String(ref).slice(4)).some((n) => n.id === someTask!.id),
  );
  check(relDocs.length > 0 && relBacklinkOk, "relation doc: refs not visible as backlinks");

  const summary = {
    ok: failures.length === 0,
    failures,
    generated: {
      ...generation,
      vault: { ...vm, dupExpectations: vm.dupExpectations.length },
      notion: nm,
    },
    runs,
    stores: { cleanTwice: a, killedThenResumed: b },
    links: linkReport,
    duplicateTitleLinks: { checked: vm.dupExpectations.length, correct: dupOk, wrong: dupBad.slice(0, 5) },
    relationBacklinks: { sampleRow: someTask?.title, refs: relDocs.length, ok: relBacklinkOk },
    killedJobsOnDisk: onDisk.map((j) => ({ kind: j.kind, status: j.status })),
    childStderr: [run1, run2, run3, run4].map((c) => c.stderr.trim().slice(-500)).filter(Boolean),
  };
  emit(summary);
  if (!flag("keep")) fs.rmSync(tmp, { recursive: true, force: true });
  process.exitCode = failures.length ? 1 : 0;
}

if (flag("child")) {
  await childMain(
    opt("child", "import") as "import" | "resume",
    opt("state", ""),
    opt("vault", ""),
    opt("zip", ""),
  );
} else {
  await parentMain();
}
