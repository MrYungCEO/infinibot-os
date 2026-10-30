import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { loadSkillsFromDir } from "@mariozechner/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { importSkillUpload, SkillImportError } from "./skills-import.js";

const MD = (name: string) =>
  `---\nname: ${name}\ndescription: Does a thing when asked\n---\n# ${name}\n\nDo the thing.\n`;

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-import-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

async function zipOf(files: Record<string, string | Buffer>, opts?: Record<string, unknown>) {
  const z = new JSZip();
  for (const [k, v] of Object.entries(files)) z.file(k, v, opts);
  return Buffer.from(await z.generateAsync({ type: "uint8array" }));
}

function loadable(managed: string): string[] {
  const loaded = loadSkillsFromDir({ dir: managed, source: "t" }) as unknown;
  const skills = Array.isArray(loaded) ? loaded : (loaded as { skills: { name: string }[] }).skills;
  return skills.map((s: { name: string }) => s.name);
}

describe("importSkillUpload", () => {
  it("imports a single SKILL.md and the agent loader sees it", async () => {
    const r = await importSkillUpload({
      fileName: "SKILL.md",
      data: Buffer.from(MD("Hello Skill")),
      managedDir: dir,
    });
    expect(r.status).toBe("imported");
    expect(fs.existsSync(path.join(dir, "hello-skill", "SKILL.md"))).toBe(true);
    expect(loadable(dir)).toContain("hello-skill");
  });

  it("imports a folder-style zip with scripts + assets and keeps exec bit", async () => {
    const buf = await zipOf({
      "my-skill/SKILL.md": MD("my-skill"),
      "my-skill/scripts/run.sh": "#!/bin/sh\necho hi\n",
      "my-skill/assets/logo.bin": Buffer.from([1, 2, 3]),
    });
    const r = await importSkillUpload({ fileName: "my-skill.zip", data: buf, managedDir: dir });
    expect(r.status).toBe("imported");
    expect(fs.readFileSync(path.join(dir, "my-skill/scripts/run.sh"), "utf-8")).toContain(
      "echo hi",
    );
    expect(fs.existsSync(path.join(dir, "my-skill/assets/logo.bin"))).toBe(true);
    expect(loadable(dir)).toContain("my-skill");
  });

  it("imports a Claude-style zip (SKILL.md at root, extra frontmatter) and fixes name to match dir", async () => {
    const buf = await zipOf({
      "SKILL.md": `---\nname: PDF Helper\ndescription: Work with PDFs\nallowed-tools: Read, Bash\nlicense: MIT\n---\nUse pdftotext.\n`,
      "reference.md": "# ref",
    });
    const r = await importSkillUpload({ fileName: "pdf-helper.zip", data: buf, managedDir: dir });
    expect(r.status === "imported" && r.skills[0].slug).toBe("pdf-helper");
    const md = fs.readFileSync(path.join(dir, "pdf-helper/SKILL.md"), "utf-8");
    expect(md).toContain("name: pdf-helper");
    expect(md).toContain("license: MIT");
    expect(loadable(dir)).toContain("pdf-helper");
  });

  it("imports a multi-skill zip", async () => {
    const buf = await zipOf({ "skills/a/SKILL.md": MD("a"), "skills/b/SKILL.md": MD("b") });
    const r = await importSkillUpload({ fileName: "x.zip", data: buf, managedDir: dir });
    expect(r.status === "imported" && r.skills.map((s) => s.slug).sort()).toEqual(["a", "b"]);
  });

  it("asks on collision, then replaces or keeps both", async () => {
    const data = Buffer.from(MD("dup"));
    await importSkillUpload({ fileName: "SKILL.md", data, managedDir: dir });
    const ask = await importSkillUpload({ fileName: "SKILL.md", data, managedDir: dir });
    expect(ask.status).toBe("conflict");
    const keep = await importSkillUpload({
      fileName: "SKILL.md",
      data,
      managedDir: dir,
      onConflict: "keep-both",
    });
    expect(keep.status === "imported" && keep.skills[0].slug).toBe("dup-2");
    expect(fs.readFileSync(path.join(dir, "dup-2/SKILL.md"), "utf-8")).toContain("name: dup-2");
    const rep = await importSkillUpload({
      fileName: "SKILL.md",
      data: Buffer.from(MD("dup").replace("Do the thing.", "New body.")),
      managedDir: dir,
      onConflict: "replace",
    });
    expect(rep.status === "imported" && rep.skills[0].replaced).toBe(true);
    expect(fs.readFileSync(path.join(dir, "dup/SKILL.md"), "utf-8")).toContain("New body.");
    expect(fs.readdirSync(dir).filter((f) => f.startsWith(".import-"))).toEqual([]);
  });

  it("rejects zip path traversal and writes nothing", async () => {
    const buf = await zipOf({ "ok/SKILL.md": MD("ok"), "../../evil.txt": "x" });
    await expect(
      importSkillUpload({ fileName: "x.zip", data: buf, managedDir: dir }),
    ).rejects.toThrow(/unsafe path/);
    expect(fs.existsSync(path.join(dir, "..", "evil.txt"))).toBe(false);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("rejects absolute paths", async () => {
    const buf = await zipOf({ "/etc/x": "x", "SKILL.md": MD("ok") });
    await expect(
      importSkillUpload({ fileName: "x.zip", data: buf, managedDir: dir }),
    ).rejects.toThrow(/unsafe path/);
  });

  it.each([
    ["no frontmatter", Buffer.from("# just a doc\nhello"), /header/],
    ["json", Buffer.from('{"a":1}'), /JSON/],
    ["binary", Buffer.from([0, 1, 2, 3, 0, 0]), /isn't text/],
    ["empty", Buffer.alloc(0), /empty/],
    ["no description", Buffer.from("---\nname: x\n---\nbody"), /description/],
    ["bad yaml", Buffer.from("---\nname: [oops\n---\nbody"), /isn't valid/],
    ["no body", Buffer.from("---\nname: x\ndescription: d\n---\n"), /no instructions/],
  ])("rejects %s with a plain message", async (_n, data, re) => {
    const p = importSkillUpload({ fileName: "SKILL.md", data, managedDir: dir });
    await expect(p).rejects.toBeInstanceOf(SkillImportError);
    await expect(p).rejects.toThrow(re);
  });

  it("rejects a zip with no SKILL.md and a corrupt zip", async () => {
    await expect(
      importSkillUpload({
        fileName: "x.zip",
        data: await zipOf({ "readme.md": "x" }),
        managedDir: dir,
      }),
    ).rejects.toThrow(/No SKILL.md/);
    await expect(
      importSkillUpload({
        fileName: "x.zip",
        data: Buffer.from("PK\x03\x04garbage"),
        managedDir: dir,
      }),
    ).rejects.toThrow(/can't be opened/);
  });

  it("enforces size limits", async () => {
    await expect(
      importSkillUpload({
        fileName: "x.zip",
        data: Buffer.alloc(26 * 1024 * 1024, 1),
        managedDir: dir,
      }),
    ).rejects.toThrow(/upload limit/);
    const many: Record<string, string> = { "SKILL.md": MD("m") };
    for (let i = 0; i < 520; i++) many[`f${i}.txt`] = "x";
    await expect(
      importSkillUpload({ fileName: "x.zip", data: await zipOf(many), managedDir: dir }),
    ).rejects.toThrow(/limit/);
  });
});
