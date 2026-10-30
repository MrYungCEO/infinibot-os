import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WizardPrompter } from "./prompts.js";
import { checkSource, setupNotesImport } from "./onboarding.import.js";

const VAULT = path.join(
  import.meta.dirname,
  "..",
  "documents",
  "obsidian",
  "__fixtures__",
  "vault",
);
let tmp: string;
const prev: Record<string, string | undefined> = {};

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "onboard-import-"));
  for (const k of ["INFINIBOT_STATE_DIR", "INFINIBOT_CONFIG_PATH"]) prev[k] = process.env[k];
  process.env.INFINIBOT_STATE_DIR = path.join(tmp, "state");
  process.env.INFINIBOT_CONFIG_PATH = path.join(tmp, "state", "infinibot.json");
});
afterAll(() => {
  for (const [k, v] of Object.entries(prev)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

function scripted(answers: unknown[]) {
  const q = [...answers];
  const notes: string[] = [];
  const prompter = {
    note: async (m: string) => void notes.push(m),
    select: async () => q.shift(),
    text: async () => String((q.shift() as string | undefined) ?? ""),
    confirm: async () => Boolean(q.shift()),
  } as unknown as WizardPrompter;
  return { prompter, notes };
}

describe("onboard: Import your notes", () => {
  it("validates sources", () => {
    expect(checkSource("obsidian-folder", VAULT)).toBeNull();
    expect(checkSource("obsidian-folder", path.join(VAULT, "Home.md"))).toMatch(/folder/);
    expect(checkSource("notion-zip", VAULT)).toMatch(/zip/);
    expect(checkSource("obsidian-git", "git@github.com:x/y.git")).toMatch(/URL/);
    expect(checkSource("obsidian-git", "http://github.com/x.git")).toMatch(/https/);
    expect(checkSource("obsidian-folder", "/no/such/dir")).toMatch(/Not found/);
  });

  it("skipping does nothing", async () => {
    const { prompter } = scripted(["skip"]);
    expect(await setupNotesImport({ prompter, runtime: {} as never })).toEqual({ started: false });
  });

  it("queues a background vault import without waiting for it", async () => {
    const { prompter, notes } = scripted(["obsidian-folder", "/no/such/dir", VAULT, false]);
    const r = await setupNotesImport({ prompter, runtime: {} as never });
    expect(r.started).toBe(true);
    expect(notes[0]).toMatch(/Not found/);
    expect(notes.at(-1)).toMatch(/background/);
    const { importJobs } = await import("../documents/import-jobs.js");
    const job = await (await importJobs()).wait(r.jobId!, 15_000);
    expect(job).toMatchObject({ kind: "obsidian", status: "done", details: { notes: 4 } });
    expect(fs.existsSync(path.join(tmp, "state", "documents", "index.json"))).toBe(true);
  });
});
