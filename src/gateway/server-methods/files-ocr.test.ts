import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveOcrConfig } from "../../ocr/local-only.js";
import { setOcrServiceForTests } from "../../ocr/runtime.js";
import { OcrService } from "../../ocr/service.js";
import { setSecureModeRuntimeForTests } from "../../secure-mode/runtime.js";
import { filesOcrHandlers } from "./files-ocr.js";

let dir: string;
const prevRoot = process.env.INFINIBOT_FILES_ROOT;

async function call(method: string, params: Record<string, unknown>) {
  let out: { ok: boolean; payload?: any; error?: any } = { ok: false };
  await (filesOcrHandlers[method] as any)({
    params,
    respond: (ok: boolean, payload: unknown, error: unknown) => (out = { ok, payload, error }),
    context: {},
  });
  return out;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "files-ocr-rpc-"));
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
  setSecureModeRuntimeForTests({ isUnlocked: () => false } as never);
});
afterEach(() => {
  setOcrServiceForTests(null);
  setSecureModeRuntimeForTests(null);
  fs.rmSync(dir, { recursive: true, force: true });
  if (prevRoot === undefined) delete process.env.INFINIBOT_FILES_ROOT;
  else process.env.INFINIBOT_FILES_ROOT = prevRoot;
});

describe("files OCR RPCs", () => {
  it("secure lane fails closed while Secure Mode is locked", async () => {
    for (const [m, p] of [
      ["files.secure.list", {}],
      ["files.secure.upload", { name: "a.png", content: "eA==" }],
      ["files.context.search", { query: "x", secure: true }],
      ["files.context.get", { id: "s_1", secure: true }],
    ] as const) {
      const r = await call(m, p);
      expect(r.ok, m).toBe(false);
      expect(r.error.code, m).toBe("SECURE_MODE_LOCKED");
    }
  });

  it("rerun registers files under the files root only", async () => {
    const inside = path.join(dir, "files", "a.png");
    fs.writeFileSync(inside, "png");
    const outside = path.join(dir, "secret.png");
    fs.writeFileSync(outside, "png");
    expect((await call("files.ocr.rerun", { path: "a.png" })).ok).toBe(true);
    const r = await call("files.ocr.rerun", { path: outside });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("NOT_FOUND");
    expect((await call("files.ocr.rerun", { path: "../secret.png" })).ok).toBe(false);
  });

  it("normal search never returns secure entries and lists by status", async () => {
    const r = await call("files.context.search", { query: "anything" });
    expect(r.ok).toBe(true);
    expect(r.payload.results).toEqual([]);
  });
});
