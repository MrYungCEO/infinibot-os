import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveOcrConfig } from "../../ocr/local-only.js";
import { setOcrServiceForTests } from "../../ocr/runtime.js";
import {
  SECURE_ORGANIZE_STORE,
  SecureFilesOrganizer,
  normalizeTags,
} from "../../ocr/secure-organize.js";
import { OcrService } from "../../ocr/service.js";
import { setSecureModeRuntimeForTests } from "../../secure-mode/runtime.js";
import { SecureVault } from "../../secure-mode/vault.js";
import { filesOcrHandlers } from "./files-ocr.js";

const COLLECTION = "Tax-Returns-ZQ9";
const TAG = "privileged-XK7";
const NOTE = "call the lawyer about NOTE-MARKER-31";

let dir: string;
let vault: SecureVault;
let unlocked = true;
const prevRoot = process.env.INFINIBOT_FILES_ROOT;

async function call(method: string, params: Record<string, unknown> = {}) {
  let out: { ok: boolean; payload?: any; error?: any } = { ok: false };
  await (filesOcrHandlers[method] as any)({
    params,
    respond: (ok: boolean, payload: unknown, error: unknown) => (out = { ok, payload, error }),
    context: {},
  });
  return out;
}

async function upload(name: string, extra: Record<string, unknown> = {}) {
  const r = await call("files.secure.upload", {
    name,
    content: Buffer.from(`bytes of ${name}`).toString("base64"),
    ...extra,
  });
  expect(r.ok, JSON.stringify(r.error)).toBe(true);
  return r.payload.entry as { id: string; collectionId: string | null; tags: string[] };
}

function grepTree(root: string, needle: string): string[] {
  const hits: string[] = [];
  for (const f of fs.readdirSync(root, { recursive: true }) as string[]) {
    const p = path.join(root, f);
    if (!fs.statSync(p).isFile()) continue;
    const raw = fs.readFileSync(p);
    if (raw.includes(Buffer.from(needle))) hits.push(p);
    if (raw.includes(Buffer.from(Buffer.from(needle).toString("base64").slice(0, 12))))
      hits.push(`${p} (b64)`);
  }
  return hits;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "files-secure-org-"));
  process.env.INFINIBOT_FILES_ROOT = path.join(dir, "files");
  fs.mkdirSync(process.env.INFINIBOT_FILES_ROOT, { recursive: true });
  vault = new SecureVault(randomBytes(32), path.join(dir, "secure", "vault"));
  unlocked = true;
  setOcrServiceForTests(
    new OcrService({
      stateDir: dir,
      cfg: resolveOcrConfig({}),
      engines: { vl: null, ocrEngineName: async () => null } as never,
      secureVault: () => (unlocked ? vault : null),
    }),
  );
  setSecureModeRuntimeForTests({
    isUnlocked: () => unlocked,
    requireVault: () => {
      if (!unlocked) throw new Error("Secure Mode is locked");
      return vault;
    },
  } as never);
});

afterEach(() => {
  setOcrServiceForTests(null);
  setSecureModeRuntimeForTests(null);
  fs.rmSync(dir, { recursive: true, force: true });
  if (prevRoot === undefined) delete process.env.INFINIBOT_FILES_ROOT;
  else process.env.INFINIBOT_FILES_ROOT = prevRoot;
});

describe("secure files organisation RPCs", () => {
  it("fails closed while Secure Mode is locked", async () => {
    unlocked = false;
    for (const [m, p] of [
      ["files.secure.update", { id: "s_1", tags: ["x"] }],
      ["files.secure.bulkUpdate", { ids: ["s_1"], collectionId: null }],
      ["files.secure.collections.list", {}],
      ["files.secure.collections.create", { name: "x" }],
      ["files.secure.collections.rename", { id: "c_1", name: "y" }],
      ["files.secure.collections.delete", { id: "c_1" }],
    ] as const) {
      const r = await call(m, p);
      expect(r.ok, m).toBe(false);
      expect(r.error.code, m).toBe("SECURE_MODE_LOCKED");
    }
  });

  it("round-trips collection, tags, project, name and notes through the vault", async () => {
    const c = await call("files.secure.collections.create", { name: COLLECTION });
    expect(c.ok).toBe(true);
    const cid = c.payload.collection.id as string;
    const e = await upload("scan.png", {
      collectionId: cid,
      tags: [TAG, ` #${TAG} `],
      projectId: "p_secure_1",
    });
    expect(e.collectionId).toBe(cid);
    expect(e.tags).toEqual([TAG]);

    const u = await call("files.secure.update", {
      id: e.id,
      name: "  Return 2025  ",
      notes: NOTE,
      tags: [TAG, "Receipts"],
    });
    expect(u.ok).toBe(true);

    // A fresh organizer over the same sealed file sees everything (round trip).
    const fresh = new SecureFilesOrganizer(vault).get(e.id)!;
    expect(fresh).toMatchObject({
      collectionId: cid,
      tags: [TAG, "Receipts"],
      projectId: "p_secure_1",
      displayName: "Return 2025",
      notes: NOTE,
    });

    const list = await call("files.secure.list");
    expect(list.payload.organize).toBe(true);
    expect(list.payload.entries[0]).toMatchObject({
      id: e.id,
      name: "scan.png",
      displayName: "Return 2025",
      collectionId: cid,
      collectionPath: COLLECTION,
      tags: [TAG, "Receipts"],
      projectId: "p_secure_1",
      notes: NOTE,
    });
    // Server-side filters.
    expect((await call("files.secure.list", { collectionId: cid })).payload.entries).toHaveLength(
      1,
    );
    expect((await call("files.secure.list", { collectionId: null })).payload.entries).toHaveLength(
      0,
    );
    expect((await call("files.secure.list", { tag: "receipts" })).payload.entries).toHaveLength(1);

    // Clearing: null name/notes/project go back to defaults.
    await call("files.secure.update", { id: e.id, name: null, notes: "", projectId: null });
    const cleared = (await call("files.secure.list")).payload.entries[0];
    expect(cleared.displayName).toBeNull();
    expect(cleared.notes).toBe("");
    expect(cleared.projectId).toBeNull();
  });

  it("keeps collection names, tag names and notes encrypted at rest", async () => {
    const c = await call("files.secure.collections.create", { name: COLLECTION });
    const e = await upload("a.txt", { collectionId: c.payload.collection.id, tags: [TAG] });
    await call("files.secure.update", { id: e.id, notes: NOTE, name: "Display-NAME-55" });
    const stateFiles = fs.readdirSync(vault.dir);
    expect(stateFiles).toContain(`${SECURE_ORGANIZE_STORE}.ibsec`);
    for (const marker of [COLLECTION, TAG, "NOTE-MARKER-31", "Display-NAME-55"]) {
      expect(grepTree(dir, marker), marker).toEqual([]);
    }
    // The normal lane registry never learns about secure files.
    const normalReg = path.join(dir, "ocr");
    if (fs.existsSync(normalReg)) expect(grepTree(normalReg, e.id)).toEqual([]);
  });

  it("bulk moves and tags many files in one call; a bad id changes nothing", async () => {
    const a = await upload("a.png");
    const b = await upload("b.png");
    const c = await upload("c.pdf");
    const col = (await call("files.secure.collections.create", { name: "Evidence" })).payload
      .collection.id;

    const bad = await call("files.secure.bulkUpdate", {
      ids: [a.id, "s_missing"],
      collectionId: col,
    });
    expect(bad.ok).toBe(false);
    expect(bad.error.code).toBe("NOT_FOUND");
    expect(new SecureFilesOrganizer(vault).get(a.id)?.collectionId).toBeNull();

    const moved = await call("files.secure.bulkUpdate", {
      ids: [a.id, b.id, c.id],
      collectionId: col,
    });
    expect(moved.ok).toBe(true);
    expect(moved.payload.updated).toBe(3);
    const tagged = await call("files.secure.bulkUpdate", {
      ids: [a.id, b.id, c.id],
      addTags: ["case-42", "Case-42", "urgent"],
    });
    expect(tagged.ok).toBe(true);
    await call("files.secure.bulkUpdate", { ids: [c.id], removeTags: ["urgent"] });
    await call("files.secure.bulkUpdate", { ids: [b.id], projectId: "p_9" });

    const entries = (await call("files.secure.list")).payload.entries as Array<any>;
    const by = new Map(entries.map((x) => [x.id, x]));
    for (const id of [a.id, b.id, c.id]) expect(by.get(id).collectionId).toBe(col);
    expect(by.get(a.id).tags).toEqual(["case-42", "urgent"]);
    expect(by.get(c.id).tags).toEqual(["case-42"]);
    expect(by.get(b.id).projectId).toBe("p_9");

    const cols = (await call("files.secure.collections.list")).payload;
    expect(cols.collections.find((x: any) => x.id === col).count).toBe(3);
    expect(cols.rootCount).toBe(0);
    expect(cols.total).toBe(3);
    expect(cols.tags[0]).toEqual({ tag: "case-42", count: 3 });

    // Remove from collection = move to root.
    await call("files.secure.bulkUpdate", { ids: [a.id], collectionId: null });
    expect((await call("files.secure.collections.list")).payload.rootCount).toBe(1);
  });

  it("deleting a collection moves its files to the root and never deletes them", async () => {
    const parent = (await call("files.secure.collections.create", { name: "Legal" })).payload
      .collection.id;
    const child = (
      await call("files.secure.collections.create", { name: "Contracts", parentId: parent })
    ).payload.collection.id;
    const grand = (
      await call("files.secure.collections.create", { name: "Signed", parentId: child })
    ).payload.collection.id;
    const f1 = await upload("one.pdf", { collectionId: child });
    const f2 = await upload("two.pdf", { collectionId: child });
    const f3 = await upload("three.pdf", { collectionId: grand });

    let cols = (await call("files.secure.collections.list")).payload;
    expect(cols.collections.find((x: any) => x.id === grand).path).toBe(
      "Legal / Contracts / Signed",
    );

    const del = await call("files.secure.collections.delete", { id: child });
    expect(del.ok).toBe(true);
    expect(del.payload).toMatchObject({ movedFiles: 2, movedCollections: 1 });

    const entries = (await call("files.secure.list")).payload.entries as Array<any>;
    expect(entries.map((e) => e.id).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))).toEqual(
      [f1.id, f2.id, f3.id].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    );
    const by = new Map(entries.map((x) => [x.id, x]));
    expect(by.get(f1.id).collectionId).toBeNull();
    expect(by.get(f2.id).collectionId).toBeNull();
    expect(by.get(f3.id).collectionPath).toBe("Legal / Signed");
    // Bytes are still readable.
    const dl = await call("files.secure.download", { id: f1.id });
    expect(Buffer.from(dl.payload.content, "base64").toString()).toBe("bytes of one.pdf");

    cols = (await call("files.secure.collections.list")).payload;
    expect(
      cols.collections.map((x: any) => x.id).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    ).toEqual([parent, grand].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    expect(cols.rootCount).toBe(2);
    expect((await call("files.secure.collections.delete", { id: child })).error.code).toBe(
      "NOT_FOUND",
    );
  });

  it("renames, re-parents and rejects duplicates and cycles", async () => {
    const a = (await call("files.secure.collections.create", { name: "A" })).payload.collection.id;
    const b = (await call("files.secure.collections.create", { name: "B", parentId: a })).payload
      .collection.id;
    expect((await call("files.secure.collections.create", { name: "a" })).error.code).toBe(
      "INVALID_REQUEST",
    );
    expect((await call("files.secure.collections.create", { name: "  " })).error.code).toBe(
      "INVALID_REQUEST",
    );
    expect((await call("files.secure.collections.rename", { id: a, parentId: b })).error.code).toBe(
      "INVALID_REQUEST",
    );
    const r = await call("files.secure.collections.rename", { id: b, name: "Bee", parentId: null });
    expect(r.ok).toBe(true);
    expect(r.payload.collection).toMatchObject({ name: "Bee", parentId: null });
    expect(
      (
        await call("files.secure.upload", {
          name: "x.png",
          content: "eA==",
          collectionId: "c_nope",
        })
      ).error.code,
    ).toBe("INVALID_REQUEST");
  });

  it("migrates existing secure entries to the root with no tags, and forgets deleted files", async () => {
    // Entries uploaded before organisation existed: no organise doc at all.
    const a = await upload("old-a.png");
    const b = await upload("old-b.png");
    vault.remove(SECURE_ORGANIZE_STORE);
    expect(vault.has(SECURE_ORGANIZE_STORE)).toBe(false);

    const list = (await call("files.secure.list")).payload.entries as Array<any>;
    for (const e of list)
      expect(e).toMatchObject({
        collectionId: null,
        collectionPath: "",
        tags: [],
        displayName: null,
        notes: "",
      });
    expect(vault.has(SECURE_ORGANIZE_STORE)).toBe(true);
    const org = new SecureFilesOrganizer(vault);
    expect(org.get(a.id)).toMatchObject({ collectionId: null, tags: [] });

    await call("files.secure.delete", { id: b.id });
    expect(org.get(b.id)).toBeNull();
    expect(org.migrate([a.id])).toEqual({ added: 0, pruned: 0 });
  });
});

describe("normalizeTags", () => {
  it("trims, strips #, dedupes case-insensitively and caps length", () => {
    expect(normalizeTags([" #Tax ", "tax", "", "a  b", "x".repeat(60)])).toEqual([
      "Tax",
      "a b",
      "x".repeat(40),
    ]);
    expect(normalizeTags("one, two ,one")).toEqual(["one", "two"]);
  });
});
