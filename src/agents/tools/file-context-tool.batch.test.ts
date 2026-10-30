import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveOcrConfig } from "../../ocr/local-only.js";
import { setOcrServiceForTests } from "../../ocr/runtime.js";
import { OcrService } from "../../ocr/service.js";
import type { OcrEngines } from "../../ocr/types.js";
import { createFileContextTool } from "./file-context-tool.js";
import { capToolPayload, TOOL_RESULT_MAX_CHARS } from "./file-digest.js";

const vision = { calls: 0 };

function engines(): OcrEngines {
  return {
    ocrEngineName: async () => "fake-ocr",
    async ocrImages(paths) {
      return paths.map((p) => ({
        width: 100,
        height: 100,
        lines: Array.from({ length: 60 }, (_, i) => ({
          text: `${path.basename(p)} line ${i} ${"lorem ipsum ".repeat(8)}`,
          confidence: 0.97,
          box: [0, i * 20, 10, i * 20 + 10] as [number, number, number, number],
        })),
      }));
    },
    toPng: async (i) => i,
    pdfPageCount: async () => 1,
    pdfPageText: async () => "",
    pdfRenderPage: async () => "",
    nativeText: async () => null,
    vl: {
      model: async () => "qwen-vl-fake",
      async ask() {
        vision.calls++;
        return {
          text: `## Summary\nA gold ring with a stone. ${"Detail. ".repeat(200)}\n## Key entities\n- 18k gold\n- diamond`,
          model: "qwen-vl-fake",
        };
      },
    },
  };
}

function parse(res: unknown): Record<string, any> {
  const r = res as { content: Array<{ text: string }> };
  return JSON.parse(r.content[0].text);
}

describe("file_context batch + cached reads", () => {
  let dir: string;
  let svc: OcrService;
  const ids: string[] = [];

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fc-batch-"));
    process.env.INFINIBOT_FILES_ROOT = path.join(dir, "files");
    fs.mkdirSync(process.env.INFINIBOT_FILES_ROOT, { recursive: true });
    svc = new OcrService({
      stateDir: dir,
      cfg: resolveOcrConfig({}),
      engines: engines(),
      secureVault: () => null,
    });
    setOcrServiceForTests(svc);
    ids.length = 0;
    for (let i = 0; i < 16; i++) {
      const p = path.join(process.env.INFINIBOT_FILES_ROOT, `asset-${i}.png`);
      fs.writeFileSync(p, randomBytes(64));
      ids.push(svc.enqueuePath({ absPath: p, source: { kind: "files" } })!.id);
    }
    while (await svc.processNext()) {
      /* analyze all 16 */
    }
    vision.calls = 0;
  });
  afterEach(() => {
    setOcrServiceForTests(null);
    delete process.env.INFINIBOT_FILES_ROOT;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("digest returns all 16 analyzed files in one bounded call, without re-running vision", async () => {
    const tool = createFileContextTool({ agentSessionKey: "agent:main:main" });
    const t0 = Date.now();
    const raw = await tool.execute("c1", { action: "digest" });
    const out = parse(raw);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(out.count).toBe(16);
    expect(
      out.files.every((f: any) => f.status === "done" && f.description?.includes("gold ring")),
    ).toBe(true);
    expect(out.files[0].entities).toEqual(expect.arrayContaining(["18k gold"]));
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(TOOL_RESULT_MAX_CHARS + 200);
    expect(vision.calls).toBe(0);
  });

  it("get with ids[] batches; full single get is capped", async () => {
    const tool = createFileContextTool({});
    const out = parse(
      await tool.execute("c2", { action: "get", ids: [...ids.slice(0, 5), "f_missing"] }),
    );
    expect(out.files.map((f: any) => f.id)).toEqual([...ids.slice(0, 5), "f_missing"]);
    expect(out.files.at(-1)).toEqual({ id: "f_missing", found: false });
    const one = parse(await tool.execute("c3", { action: "get", id: ids[0], maxChars: 50_000 }));
    expect(one.found).toBe(true);
    expect(JSON.stringify(one).length).toBeLessThanOrEqual(TOOL_RESULT_MAX_CHARS + 200);
    expect(vision.calls).toBe(0);
  });

  it("description steers models to the batch path", () => {
    const tool = createFileContextTool({});
    expect(tool.description).toMatch(/digest/);
    expect(tool.description).toMatch(/never one call per file/);
  });

  it("capToolPayload shrinks the longest strings and marks the result", () => {
    const big = { a: "x".repeat(50_000), b: ["y".repeat(30_000), "short"], n: 3 };
    const capped = capToolPayload(big, 10_000);
    expect(JSON.stringify(capped).length).toBeLessThanOrEqual(10_000);
    expect(capped).toMatchObject({ truncated: true, n: 3 });
    expect((capped.b as string[])[1]).toBe("short");
    expect(big.a.length).toBe(50_000); // input untouched
  });
});
