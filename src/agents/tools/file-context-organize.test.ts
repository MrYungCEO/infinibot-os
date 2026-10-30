import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveOcrConfig } from "../../ocr/local-only.js";
import { setOcrServiceForTests } from "../../ocr/runtime.js";
import { OcrService } from "../../ocr/service.js";
import { createFileContextTool } from "./file-context-tool.js";

let dir: string;
const prevRoot = process.env.INFINIBOT_FILES_ROOT;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fc-organize-"));
  process.env.INFINIBOT_FILES_ROOT = path.join(dir, "files");
  fs.mkdirSync(process.env.INFINIBOT_FILES_ROOT, { recursive: true });
  setOcrServiceForTests(
    new OcrService({
      stateDir: dir,
      cfg: resolveOcrConfig({}),
      engines: { vl: null, ocrEngineName: async () => null } as never,
      secureVault: () => null,
    }),
  );
});
afterEach(() => {
  setOcrServiceForTests(null);
  fs.rmSync(dir, { recursive: true, force: true });
  if (prevRoot === undefined) delete process.env.INFINIBOT_FILES_ROOT;
  else process.env.INFINIBOT_FILES_ROOT = prevRoot;
});

const tool = createFileContextTool({ agentSessionKey: "agent:main:main" });
async function run(args: Record<string, unknown>) {
  const r = (await tool.execute("t", args as never, undefined as never, undefined as never)) as {
    content: Array<{ text: string }>;
  };
  return JSON.parse(r.content[0].text);
}

describe("file_context rename/move (normal lane)", () => {
  it("renames in place (keeping the extension) and moves into a folder", async () => {
    fs.writeFileSync(path.join(dir, "files", "IMG_0001.jpg"), "x");
    const r = await run({ action: "rename", path: "IMG_0001.jpg", newName: "Beach sunset" });
    expect(r).toMatchObject({ ok: true, changed: 1, path: "Beach sunset.jpg" });
    const m = await run({ action: "move", path: "Beach sunset.jpg", folder: "Trips/2026" });
    expect(m).toMatchObject({ ok: true, path: "Trips/2026/Beach sunset.jpg" });
    expect(fs.existsSync(path.join(dir, "files", "Trips/2026/Beach sunset.jpg"))).toBe(true);
  });

  it("refuses escapes, clobbers and missing files", async () => {
    fs.writeFileSync(path.join(dir, "files", "a.txt"), "a");
    fs.writeFileSync(path.join(dir, "files", "b.txt"), "b");
    expect(await run({ action: "move", path: "a.txt", folder: "../../etc" })).toMatchObject({
      ok: false,
    });
    expect(await run({ action: "rename", path: "a.txt", newName: "b.txt" })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/already exists/),
    });
    expect(await run({ action: "rename", path: "a.txt", newName: "x/y.txt" })).toMatchObject({
      ok: false,
    });
    expect(await run({ action: "rename", path: "zzz.txt", newName: "q" })).toMatchObject({
      ok: false,
      error: "file not found",
    });
    expect(fs.readFileSync(path.join(dir, "files", "b.txt"), "utf8")).toBe("b");
  });
});
