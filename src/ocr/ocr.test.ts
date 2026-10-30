import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SecureVault } from "../secure-mode/vault.js";
import { createVisionClient, layoutLines, meanConfidence } from "./engines.js";
import { parseEntities } from "./extract.js";
import {
  assertLocalEndpoint,
  isLocalEndpoint,
  OcrLocalOnlyError,
  resolveOcrConfig,
} from "./local-only.js";
import { attachmentContextBlock, OcrService } from "./service.js";
import { SIDECAR_DIR } from "./store.js";
import type { OcrEngines, OcrImageResult } from "./types.js";

function tmpDir(tag: string) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ib-ocr-${tag}-`));
}

function line(text: string, y: number, x = 10, conf = 0.97): OcrImageResult["lines"][number] {
  return { text, confidence: conf, box: [x, y, x + text.length * 10, y + 20] };
}

/** Deterministic fake engines; behaviour per test via the knobs. */
function fakeEngines(knobs: {
  ocrText?: (p: string) => string[];
  ocrConfidence?: number;
  failOcrTimes?: number;
  pdfPages?: number;
  textLayer?: (page: number) => string;
  vl?: boolean;
  onOcr?: (paths: string[]) => void;
  onVl?: (prompt: string) => void;
}): OcrEngines & { calls: { ocr: number; vl: number; pageText: number[] } } {
  const calls = { ocr: 0, vl: 0, pageText: [] as number[] };
  let failures = knobs.failOcrTimes ?? 0;
  return {
    calls,
    async ocrEngineName() {
      return "fake-ocr";
    },
    async ocrImages(paths) {
      calls.ocr++;
      knobs.onOcr?.(paths);
      if (failures > 0) {
        failures--;
        throw new Error("ocr engine crashed");
      }
      return paths.map((p) => ({
        width: 1000,
        height: 800,
        lines: (knobs.ocrText?.(p) ?? ["hello world"]).map((t, i) =>
          line(t, 20 + i * 40, 10, knobs.ocrConfidence ?? 0.97),
        ),
      }));
    },
    async toPng(input, outDir) {
      const out = path.join(outDir, `${path.basename(input)}.png`);
      fs.copyFileSync(input, out);
      return out;
    },
    async pdfPageCount() {
      return knobs.pdfPages ?? 1;
    },
    async pdfPageText(_pdf, page) {
      calls.pageText.push(page);
      return knobs.textLayer?.(page) ?? "";
    },
    async pdfRenderPage(_pdf, page, outDir) {
      const out = path.join(outDir, `p${page}.png`);
      fs.writeFileSync(out, `page-${page}`);
      return out;
    },
    async nativeText() {
      return "# Docx heading\n\nQuarterly revenue grew 12 percent.";
    },
    vl:
      knobs.vl === false
        ? null
        : {
            async model() {
              return "qwen-vl-fake";
            },
            async ask({ prompt }) {
              calls.vl++;
              knobs.onVl?.(prompt);
              return {
                text: "## Summary\nA screenshot of an invoice.\n## Text\nInvoice 4471\n## Key entities\n- Kingly Vault LLC\n- $1,284.50",
                model: "qwen-vl-fake",
              };
            },
          },
  };
}

function makeService(
  stateDir: string,
  engines: OcrEngines,
  extra: Partial<ConstructorParameters<typeof OcrService>[0]> = {},
) {
  return new OcrService({
    stateDir,
    engines,
    cfg: { ...resolveOcrConfig({}), retryBaseMs: 1000, maxAttempts: 3 },
    secureVault: () => null,
    ...extra,
  });
}

describe("local-only enforcement", () => {
  it("accepts loopback endpoints only", () => {
    expect(assertLocalEndpoint("http://127.0.0.1:11434")).toBe("http://127.0.0.1:11434");
    expect(isLocalEndpoint("http://localhost:11434")).toBe(true);
    expect(isLocalEndpoint("http://[::1]:11434")).toBe(true);
    for (const bad of [
      "https://api.openai.com/v1",
      "http://192.168.1.20:11434",
      "http://ollama.com",
      "http://100.88.1.2:11434",
      "file:///etc/passwd",
      "not a url",
    ]) {
      expect(() => assertLocalEndpoint(bad)).toThrow(OcrLocalOnlyError);
    }
  });

  it("refuses a remote OLLAMA_HOST instead of using it", () => {
    const cfg = resolveOcrConfig({ OLLAMA_HOST: "https://my-cloud-gpu.example.com" });
    expect(cfg.ollamaUrl).toBeNull();
    expect(cfg.ollamaRefused).toMatch(/local-only/);
    expect(createVisionClient(cfg)).toBeNull();
    // Bare host:port forms are normalised, 0.0.0.0 → loopback.
    expect(resolveOcrConfig({ OLLAMA_HOST: "0.0.0.0:11434" }).ollamaUrl).toBe(
      "http://127.0.0.1:11434",
    );
  });

  it("the vision client only ever calls the loopback origin", async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      urls.push(url);
      if (url.endsWith("/api/tags")) {
        return new Response(
          JSON.stringify({ models: [{ name: "llama3:8b" }, { name: "qwen3-vl:8b" }] }),
        );
      }
      if (url.endsWith("/api/show")) {
        return new Response(JSON.stringify({ capabilities: ["completion", "vision"] }));
      }
      return new Response(JSON.stringify({ message: { content: "42" } }));
    }) as unknown as typeof fetch;
    const dir = tmpDir("vl");
    const img = path.join(dir, "a.png");
    fs.writeFileSync(img, "png");
    const vl = createVisionClient(resolveOcrConfig({}), fetchImpl)!;
    expect(await vl.model()).toBe("qwen3-vl:8b"); // Qwen VL preferred over other vision models
    const r = await vl.ask({ images: [img], prompt: "what?" });
    expect(r.text).toBe("42");
    expect(urls.every((u) => u.startsWith("http://127.0.0.1:11434/"))).toBe(true);
  });

  it("vision calls hold a GPU lease from the runtime manager, or use an already-running vision runtime", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push(url);
      if (url.endsWith("/chat/completions")) {
        return new Response(JSON.stringify({ choices: [{ message: { content: "from vllm" } }] }));
      }
      return new Response(JSON.stringify({ message: { content: "from ollama" } }));
    }) as unknown as typeof fetch;
    const dir = tmpDir("vlgate");
    const img = path.join(dir, "a.png");
    fs.writeFileSync(img, "png");
    const order: string[] = [];
    let alt: { baseUrl: string; model: string; verifiedLocal?: boolean } | null = null;
    const vl = createVisionClient(
      resolveOcrConfig({ INFINIBOT_OCR_VL_MODEL: "qwen-vl" }),
      fetchImpl,
      {
        acquire: async (model) => {
          order.push(`acquire ${model}`);
          return { release: () => order.push("release") };
        },
        alternate: async () => alt,
      },
    )!;
    expect((await vl.ask({ images: [img], prompt: "p" })).text).toBe("from ollama");
    expect(order).toEqual(["acquire qwen-vl", "release"]);
    // A docker0 address is only accepted when the gate verified it is this machine.
    alt = { baseUrl: "http://172.17.0.1:8010/v1", model: "qwen3.8-vl" };
    await expect(vl.ask({ images: [img], prompt: "p" })).rejects.toThrow(/local-only/);
    alt = { ...alt, verifiedLocal: true };
    const r = await vl.ask({ images: [img], prompt: "p" });
    expect(r).toEqual({ text: "from vllm", model: "qwen3.8-vl" });
    expect(calls.at(-1)).toBe("http://172.17.0.1:8010/v1/chat/completions");
    expect(order).toEqual(["acquire qwen-vl", "release"]); // no Ollama lease for the vLLM path
  });
});

describe("layout + parsing", () => {
  it("orders boxes into rows and keeps table columns", () => {
    const text = layoutLines({
      width: 800,
      height: 400,
      lines: [
        { text: "Total", confidence: 0.9, box: [10, 100, 60, 120] },
        { text: "$12.00", confidence: 0.9, box: [400, 102, 460, 121] },
        { text: "Header", confidence: 0.9, box: [10, 10, 80, 30] },
      ],
    });
    expect(text).toBe("Header\nTotal | $12.00");
    expect(
      meanConfidence({
        width: 1,
        height: 1,
        lines: [line("abcd", 0, 0, 1), line("ab", 0, 0, 0.5)],
      }),
    ).toBeCloseTo(0.833, 2);
  });

  it("extracts key entities from the VL description", () => {
    expect(parseEntities("## Summary\nx\n## Key entities\n- Acme Ltd\n- 2026-11-01\n")).toEqual([
      "Acme Ltd",
      "2026-11-01",
    ]);
    expect(parseEntities(null)).toEqual([]);
  });
});

describe("durable queue", () => {
  let state: string;
  let files: string;
  beforeEach(() => {
    state = tmpDir("state");
    files = tmpDir("files");
  });
  afterEach(() => {
    fs.rmSync(state, { recursive: true, force: true });
    fs.rmSync(files, { recursive: true, force: true });
  });

  it("enqueue returns immediately and the worker processes the job to done", async () => {
    const engines = fakeEngines({ ocrText: () => ["Invoice 4471", "Total due $1,284.50"] });
    const svc = makeService(state, engines);
    const img = path.join(files, "shot.png");
    fs.writeFileSync(img, randomBytes(64));
    const entry = svc.enqueuePath({ absPath: img, source: { kind: "files", projectId: "p1" } })!;
    expect(entry.status).toBe("queued");
    expect(engines.calls.ocr).toBe(0); // nothing ran synchronously
    expect(await svc.processNext()).toBe(true);
    const ctx = svc.getContext("normal", { path: img })!;
    expect(ctx.entry.status).toBe("done");
    expect(ctx.sidecar?.markdown).toContain("Invoice 4471");
    expect(ctx.sidecar?.description).toContain("Summary");
    expect(ctx.sidecar?.entities).toContain("Kingly Vault LLC");
    expect(ctx.sidecar?.engines).toMatchObject({ ocr: "fake-ocr", vl: "qwen-vl-fake" });
    expect(ctx.sidecar?.source.projectId).toBe("p1");
    expect(await svc.processNext()).toBe(false);
  });

  it("retries with exponential backoff, then marks failed with the error", async () => {
    let now = 1_000_000;
    const engines = fakeEngines({ failOcrTimes: 10 });
    const svc = makeService(state, engines, { now: () => now });
    const img = path.join(files, "bad.png");
    fs.writeFileSync(img, "x");
    const { id } = svc.enqueuePath({ absPath: img, source: { kind: "files" } })!;
    await svc.processNext();
    let e = svc.find("normal", { id })!;
    expect(e).toMatchObject({ status: "queued", attempts: 1, error: "ocr engine crashed" });
    expect(e.nextAttemptAt).toBe(now + 1000);
    expect(await svc.processNext()).toBe(false); // not due yet
    now += 1000;
    await svc.processNext();
    e = svc.find("normal", { id })!;
    expect(e.attempts).toBe(2);
    expect(e.nextAttemptAt).toBe(now + 2000); // doubled
    now += 2000;
    await svc.processNext();
    e = svc.find("normal", { id })!;
    expect(e).toMatchObject({ status: "failed", attempts: 3, error: "ocr engine crashed" });
  });

  it("survives a restart: an interrupted job is re-queued and resumes page by page", async () => {
    const engines = fakeEngines({
      pdfPages: 4,
      textLayer: (p) =>
        p <= 2 ? `Page ${p} has a real text layer with enough characters to count.` : "",
    });
    const svc1 = makeService(state, engines);
    const pdf = path.join(files, "scan.pdf");
    fs.writeFileSync(pdf, "%PDF-fake");
    const { id } = svc1.enqueuePath({ absPath: pdf, source: { kind: "files" } })!;
    // Crash after page 2: progress callback throws a hard stop by aborting the process mid-run.
    let pagesSeen = 0;
    const crashing = makeService(state, {
      ...engines,
      async pdfRenderPage(_pdf, page) {
        pagesSeen = page;
        throw new Error("SIGKILL"); // the process dies while rendering page 3
      },
    });
    // Simulate the kill: run, then force the registry back into "processing" as a dead process would leave it.
    await crashing.processNext().catch(() => {});
    const reg = JSON.parse(fs.readFileSync(path.join(state, "ocr", "registry.json"), "utf8"));
    reg.entries[id].status = "processing";
    reg.entries[id].nextAttemptAt = 0;
    fs.writeFileSync(path.join(state, "ocr", "registry.json"), JSON.stringify(reg));
    expect(pagesSeen).toBe(3);

    const engines2 = fakeEngines({
      pdfPages: 4,
      textLayer: (p) =>
        p <= 2 ? `Page ${p} has a real text layer with enough characters to count.` : "",
    });
    const svc2 = makeService(state, engines2);
    svc2.start();
    svc2.stop();
    expect(svc2.find("normal", { id })!.status).toBe("queued"); // recovered
    await svc2.processNext();
    const ctx = svc2.getContext("normal", { id })!;
    expect(ctx.entry.status).toBe("done");
    // Pages 1-2 came from the saved partial sidecar: only pages 3-4 were read again.
    expect(engines2.calls.pageText).toEqual([3, 4]);
    expect(ctx.sidecar!.pages.map((p) => [p.page, p.method])).toEqual([
      [1, "text-layer"],
      [2, "text-layer"],
      [3, "ocr"],
      [4, "ocr"],
    ]);
    expect(ctx.sidecar!.markdown).toContain("## Page 4");
  });

  it("chat attachments (higher priority) run before older uploads", async () => {
    const order: string[] = [];
    const svc = makeService(state, fakeEngines({ onOcr: (p) => order.push(path.basename(p[0])) }));
    for (const n of ["a.png", "b.png"]) fs.writeFileSync(path.join(files, n), n);
    svc.enqueuePath({ absPath: path.join(files, "a.png"), source: { kind: "files" } });
    svc.enqueuePath({ absPath: path.join(files, "b.png"), source: { kind: "chat" }, priority: 10 });
    await svc.processNext();
    await svc.processNext();
    expect(order).toEqual(["b.png", "a.png"]);
  });

  it("scanned PDF pages: OCR, plus a capped VL reading for low-confidence pages", async () => {
    const engines = fakeEngines({ pdfPages: 5, ocrConfidence: 0.5 });
    const svc = new OcrService({
      stateDir: state,
      engines,
      cfg: { ...resolveOcrConfig({}), maxVlPages: 2 },
      secureVault: () => null,
    });
    const pdf = path.join(files, "fax.pdf");
    fs.writeFileSync(pdf, "%PDF");
    svc.enqueuePath({ absPath: pdf, source: { kind: "files" } });
    await svc.processNext();
    const sc = svc.getContext("normal", { path: pdf })!.sidecar!;
    expect(sc.pages).toHaveLength(5);
    expect(sc.pages.filter((p) => p.vlText).length).toBe(2);
    expect(engines.calls.vl).toBe(2);
    expect(sc.confidence).toBe(0.5);
  });

  it("office documents use native text and skip OCR", async () => {
    const engines = fakeEngines({});
    const svc = makeService(state, engines);
    const docx = path.join(files, "report.docx");
    fs.writeFileSync(docx, "PK");
    svc.enqueuePath({ absPath: docx, source: { kind: "files" } });
    await svc.processNext();
    const sc = svc.getContext("normal", { path: docx })!.sidecar!;
    expect(sc.markdown).toContain("Quarterly revenue");
    expect(sc.engines.text).toEqual(["native"]);
    expect(engines.calls.ocr).toBe(0);
  });

  it("extracts every document format accepted by the chat composer", async () => {
    const engines = fakeEngines({});
    const svc = makeService(state, engines);
    for (const name of [
      "brief.docx",
      "sheet.xlsx",
      "slides.pptx",
      "notes.txt",
      "notes.md",
      "data.csv",
    ]) {
      const file = path.join(files, name);
      fs.writeFileSync(file, `fixture:${name}`);
      const entry = svc.enqueuePath({ absPath: file, source: { kind: "chat" } });
      expect(entry, name).not.toBeNull();
      await svc.processNext();
      const sc = svc.getContext("normal", { path: file })!.sidecar!;
      expect(sc.complete, name).toBe(true);
      expect(sc.markdown, name).toContain("Quarterly revenue grew 12 percent");
      expect(sc.engines.text, name).toEqual(["native"]);
    }
  });

  it("an unchanged re-upload keeps results; identical bytes elsewhere reuse them instantly", async () => {
    const engines = fakeEngines({});
    const svc = makeService(state, engines);
    const a = path.join(files, "a.png");
    fs.writeFileSync(a, "same-bytes");
    svc.enqueuePath({ absPath: a, source: { kind: "files" } });
    await svc.processNext();
    expect(svc.enqueuePath({ absPath: a, source: { kind: "files" } })!.status).toBe("done");
    const b = path.join(files, "copy.png");
    fs.writeFileSync(b, "same-bytes");
    expect(svc.enqueuePath({ absPath: b, source: { kind: "chat" } })!.status).toBe("done");
    expect(engines.calls.ocr).toBe(1);
  });
});

describe("sidecar storage", () => {
  it("writes JSON + markdown next to the file, hidden in a .ocr folder; move and delete follow the file", async () => {
    const state = tmpDir("state");
    const files = tmpDir("files");
    const mirrored: Array<[string, boolean]> = [];
    const svc = makeService(state, fakeEngines({ ocrText: () => ["Receipt 99"] }), {
      indexNormal: (e, sc) => mirrored.push([e.id, sc !== null]),
    });
    const img = path.join(files, "receipt.jpg");
    fs.writeFileSync(img, "jpg");
    svc.enqueuePath({ absPath: img, source: { kind: "files", sessionKey: "agent:main:main" } });
    await svc.processNext();
    const json = path.join(files, SIDECAR_DIR, "receipt.jpg.ocr.json");
    const md = path.join(files, SIDECAR_DIR, "receipt.jpg.ocr.md");
    const sc = JSON.parse(fs.readFileSync(json, "utf8"));
    expect(sc).toMatchObject({ version: 1, name: "receipt.jpg", complete: true, pageCount: 1 });
    expect(sc.engines.vl).toBe("qwen-vl-fake");
    expect(typeof sc.updatedAt).toBe("number");
    expect(sc.pages[0]).toMatchObject({ page: 1, method: "ocr", confidence: 0.97 });
    const mdText = fs.readFileSync(md, "utf8");
    expect(mdText).toContain("## Extracted text");
    expect(mdText).toContain("Receipt 99");
    expect(mdText).toContain("Session: agent:main:main");

    const moved = path.join(files, "renamed.jpg");
    fs.renameSync(img, moved);
    svc.moved(img, moved);
    expect(fs.existsSync(json)).toBe(false);
    expect(fs.existsSync(path.join(files, SIDECAR_DIR, "renamed.jpg.ocr.json"))).toBe(true);
    expect(svc.search("normal", "receipt 99")[0]?.name).toBe("renamed.jpg");

    svc.remove("normal", { path: moved });
    expect(fs.existsSync(path.join(files, SIDECAR_DIR))).toBe(false);
    expect(mirrored.at(-1)).toEqual([expect.any(String), false]);
  });

  it("falls back to the state dir when the file's folder is read-only", async () => {
    const state = tmpDir("state");
    const files = tmpDir("ro");
    const img = path.join(files, "ro.png");
    fs.writeFileSync(img, "x");
    fs.chmodSync(files, 0o555);
    try {
      const svc = makeService(state, fakeEngines({}));
      svc.enqueuePath({ absPath: img, source: { kind: "files" } });
      await svc.processNext();
      const e = svc.find("normal", { path: img })!;
      expect(e.status).toBe("done");
      expect(e.sidecarPath).toContain(path.join(state, "ocr", "sidecars"));
    } finally {
      fs.chmodSync(files, 0o755);
    }
  });

  it("search finds files by content and returns a snippet", async () => {
    const state = tmpDir("state");
    const files = tmpDir("files");
    const svc = makeService(
      state,
      fakeEngines({
        ocrText: (p) =>
          p.includes("lease")
            ? ["Commercial lease agreement", "Tenant: Gengu Holdings"]
            : ["Lunch menu"],
        vl: false,
      }),
    );
    for (const n of ["lease.png", "menu.png"]) {
      fs.writeFileSync(path.join(files, n), n);
      svc.enqueuePath({ absPath: path.join(files, n), source: { kind: "files" } });
      await svc.processNext();
    }
    const hits = svc.search("normal", "gengu lease");
    expect(hits.map((h) => h.name)).toEqual(["lease.png"]);
    expect(hits[0].snippet.toLowerCase()).toContain("lease");
    expect(svc.search("normal", "spaceship")).toEqual([]);
  });
});

describe("secure lane isolation", () => {
  it("secure uploads live only in the vault and never reach normal search, memory or plaintext disk", async () => {
    const state = tmpDir("state");
    const vaultDir = path.join(state, "secure", "vault");
    const vault = new SecureVault(randomBytes(32), vaultDir);
    const mirrored: string[] = [];
    let unlocked = true;
    const svc = makeService(state, fakeEngines({ ocrText: () => ["TOPSECRET-MARKER-7731"] }), {
      secureVault: () => (unlocked ? vault : null),
      indexNormal: (e) => mirrored.push(e.id),
    });
    const entry = svc.enqueueSecure({
      name: "passport.png",
      data: Buffer.from("secret-image-bytes"),
      source: { kind: "secure-files" },
    });
    expect(entry.lane).toBe("secure");
    expect(entry.path).toBeNull();
    await svc.processNext();
    expect(svc.getContext("secure", { id: entry.id })!.sidecar!.markdown).toContain(
      "TOPSECRET-MARKER-7731",
    );
    expect(svc.search("secure", "TOPSECRET-MARKER-7731").map((h) => h.id)).toEqual([entry.id]);

    // Normal lane knows nothing about it.
    expect(svc.search("normal", "TOPSECRET-MARKER-7731")).toEqual([]);
    expect(svc.list("normal")).toEqual([]);
    expect(svc.find("normal", { id: entry.id })).toBeNull();
    expect(mirrored).toEqual([]);

    // No plaintext anywhere under the state dir (vault files are sealed).
    const walk = (d: string): string[] =>
      fs
        .readdirSync(d, { withFileTypes: true })
        .flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    for (const f of walk(state)) {
      const raw = fs.readFileSync(f, "utf8");
      expect(raw).not.toContain("TOPSECRET-MARKER-7731");
      expect(raw).not.toContain("passport.png");
      expect(raw).not.toContain("secret-image-bytes");
    }

    // Locked lane fails closed.
    unlocked = false;
    expect(() => svc.list("secure")).toThrow(/locked/);
    expect(() =>
      svc.enqueueSecure({
        name: "x.png",
        data: Buffer.from("y"),
        source: { kind: "secure-files" },
      }),
    ).toThrow(/locked/);
  });

  it("secure jobs wait while the lane is locked and run after unlock", async () => {
    const state = tmpDir("state");
    const vault = new SecureVault(randomBytes(32), path.join(state, "vault"));
    let unlocked = true;
    const svc = makeService(state, fakeEngines({}), {
      secureVault: () => (unlocked ? vault : null),
    });
    const e = svc.enqueueSecure({
      name: "a.png",
      data: Buffer.from("a"),
      source: { kind: "secure-files" },
    });
    unlocked = false;
    expect(await svc.processNext()).toBe(false);
    unlocked = true;
    expect(await svc.processNext()).toBe(true);
    expect(svc.find("secure", { id: e.id })!.status).toBe("done");
  });

  it("change events for the secure lane omit file names", async () => {
    const state = tmpDir("state");
    const vault = new SecureVault(randomBytes(32), path.join(state, "vault"));
    const events: unknown[] = [];
    const svc = makeService(state, fakeEngines({}), {
      secureVault: () => vault,
      emit: (ev) => events.push(ev),
    });
    svc.enqueueSecure({
      name: "diary.png",
      data: Buffer.from("d"),
      source: { kind: "secure-files" },
    });
    await svc.processNext();
    expect(JSON.stringify(events)).not.toContain("diary");
  });
});

describe("attachment context block", () => {
  it("inlines OCR text and points at file_context for details", () => {
    const block = attachmentContextBlock([
      {
        entry: { id: "f_1", name: "shot.png", status: "done" } as never,
        sidecar: {
          markdown: "Hello invoice",
          description: "## Summary\nAn invoice",
          confidence: 0.9,
        } as never,
      },
      { entry: { id: "f_2", name: "big.pdf", status: "processing" } as never, sidecar: null },
    ]);
    expect(block).toContain("shot.png · file id f_1 · OCR confidence 0.9");
    expect(block).toContain("Hello invoice");
    expect(block).toContain('id "f_2"');
    expect(block).toContain("file_context");
  });
});

describe("extension point", () => {
  it("dispatches registered handlers by extension/MIME and resumes them via prior", async () => {
    const { registerExtractionHandler, resolveExtractionHandler } = await import("./handlers.js");
    const { newSidecar } = await import("./extract.js");
    const seenPrior: Array<number> = [];
    const off = registerExtractionHandler({
      id: "test-video",
      exts: [".mp4"],
      mimes: [/^video\//],
      defaultMime: { ".mp4": "video/mp4" },
      async extract(params, { saveProgress }) {
        const sc = newSidecar(params);
        seenPrior.push(sc.pages.length);
        sc.pages.push({ page: sc.pages.length + 1, method: "vl", text: "chunk", confidence: null });
        saveProgress(sc, { done: sc.pages.length, total: 2, stage: "chunks" });
        if (sc.pages.length < 2) throw new Error("interrupted");
        sc.video = { durationSec: 12 };
        sc.complete = true;
        sc.stage = "vl";
        return sc;
      },
    });
    try {
      expect(resolveExtractionHandler(".mov", "video/quicktime")?.id).toBe("test-video");
      expect(resolveExtractionHandler(".png")?.id).toBe("image");
      const state = tmpDir("state");
      const files = tmpDir("files");
      let now = 1;
      const svc = makeService(state, fakeEngines({}), { now: () => now });
      const clip = path.join(files, "clip.mp4");
      fs.writeFileSync(clip, "mp4");
      const e = svc.enqueuePath({ absPath: clip, source: { kind: "files" } })!;
      expect(e.mime).toBe("video/mp4");
      await svc.processNext(); // first chunk saved, then fails
      now += 10_000;
      await svc.processNext(); // resumes from the partial sidecar
      const ctx = svc.getContext("normal", { id: e.id })!;
      expect(ctx.entry.status).toBe("done");
      expect(seenPrior).toEqual([0, 1]);
      expect(ctx.sidecar!.video).toEqual({ durationSec: 12 });

      // Post-hoc analyzer results merge without re-queueing and become searchable.
      svc.addAnalysis(
        "normal",
        { id: e.id },
        {
          id: "agent:review:1",
          analyzer: "specialist-review",
          agentId: "legal",
          createdAt: now,
          summary: "Mentions the Quokka merger",
          findings: [{ title: "Unsigned NDA", severity: "high" }],
        },
      );
      expect(svc.find("normal", { id: e.id })!.status).toBe("done");
      expect(svc.getContext("normal", { id: e.id })!.sidecar!.analyses).toHaveLength(1);
      expect(svc.search("normal", "quokka merger")[0]?.id).toBe(e.id);
      expect(svc.search("normal", "unsigned nda")[0]?.id).toBe(e.id);
    } finally {
      off();
    }
  });
});
