import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

let dir: string;
let handlers: Record<string, (o: unknown) => Promise<void>>;

async function call(method: string, params: Record<string, unknown>) {
  let out: { ok: boolean; payload?: any; error?: any } = { ok: false };
  await handlers[method]({
    params,
    respond: (ok: boolean, payload: unknown, error: unknown) => (out = { ok, payload, error }),
    context: {},
  });
  return out;
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "files-search-limit-"));
  const root = path.join(dir, "files");
  for (let i = 0; i < 130; i++) {
    const sub = path.join(root, `p${i % 3}`);
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, `f${i}.txt`), "x");
  }
  vi.stubEnv("INFINIBOT_FILES_ROOT", root);
  vi.resetModules();
  handlers = (await import("./files.js")).filesHandlers as never;
});

afterAll(() => {
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("files.search limit", () => {
  it("keeps the 100-result default", async () => {
    const r = await call("files.search", { query: ".", regex: true, path: "" });
    expect(r.ok).toBe(true);
    expect(r.payload.results).toHaveLength(100);
  });

  it("honours a larger limit for the All files scope (capped at 2000)", async () => {
    const r = await call("files.search", { query: ".", regex: true, path: "", limit: 1000 });
    expect(r.payload.results).toHaveLength(130);
    expect(r.payload.results[0]).toMatchObject({ isDirectory: false });
    expect(typeof r.payload.results[0].modified).toBe("number");
  });
});

describe("files.thumb", () => {
  it("returns a small webp preview for an image and refuses non-images", async () => {
    const sharp = (await import("sharp")).default;
    const png = await sharp({
      create: { width: 1200, height: 800, channels: 3, background: "#d9b45a" },
    })
      .png()
      .toBuffer();
    fs.writeFileSync(path.join(dir, "files", "p0", "big.png"), png);
    const r = await call("files.thumb", { path: "p0/big.png", size: 200 });
    expect(r.ok).toBe(true);
    expect(r.payload.mime).toBe("image/webp");
    const meta = await sharp(Buffer.from(r.payload.content, "base64")).metadata();
    expect(meta.width).toBe(200);
    expect(meta.height).toBe(133);
    const bad = await call("files.thumb", { path: "p0/f0.txt" });
    expect(bad.ok).toBe(false);
  });
});
