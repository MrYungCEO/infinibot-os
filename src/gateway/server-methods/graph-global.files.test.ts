import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../business-agency/runtime.js", () => ({ isBusinessAgencyActive: () => false }));

let dir: string;
const prevFilesRoot = process.env.INFINIBOT_FILES_ROOT;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "graph-files-"));
  process.env.INFINIBOT_FILES_ROOT = path.join(dir, "files");
  fs.mkdirSync(path.join(dir, "files"), { recursive: true });
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  if (prevFilesRoot === undefined) delete process.env.INFINIBOT_FILES_ROOT;
  else process.env.INFINIBOT_FILES_ROOT = prevFilesRoot;
});

function fakeEngines() {
  return {
    async ocrEngineName() {
      return "fake";
    },
    async ocrImages(paths: string[]) {
      return paths.map(() => ({
        width: 1,
        height: 1,
        lines: [
          {
            text: "Invoice for Acme",
            confidence: 0.9,
            box: [0, 0, 10, 10] as [number, number, number, number],
          },
        ],
      }));
    },
    async toPng(p: string) {
      return p;
    },
    async pdfPageCount() {
      return 1;
    },
    async pdfPageText() {
      return "";
    },
    async pdfRenderPage(_p: string, _n: number, out: string) {
      const f = path.join(out, "p.png");
      fs.writeFileSync(f, "x");
      return f;
    },
    async nativeText() {
      return "";
    },
    vl: {
      async model() {
        return "vl";
      },
      async ask() {
        return {
          text: "## Summary\nAn invoice\n## Key entities\n- Acme Ltd\n- Zed Bank",
          model: "vl",
        };
      },
    },
  };
}

describe("knowledge graph — workspace files", () => {
  it("adds file nodes linked to project/agent plus topic nodes; secure files stay in the secure graph", async () => {
    const { OcrService } = await import("../../ocr/service.js");
    const { resolveOcrConfig } = await import("../../ocr/local-only.js");
    const { SecureVault } = await import("../../secure-mode/vault.js");
    const { SecureLaneStore } = await import("../../secure-mode/lane-store.js");
    const { buildSnapshot } = await import("./graph-global.js");
    const vault = new SecureVault(randomBytes(32), path.join(dir, "secure", "vault"));
    const svc = new OcrService({
      stateDir: dir,
      cfg: resolveOcrConfig({}),
      engines: fakeEngines() as never,
      secureVault: () => vault,
    });
    const img = path.join(dir, "files", "invoice.png");
    fs.writeFileSync(img, "png");
    const e = svc.enqueuePath({
      absPath: img,
      source: { kind: "files", projectId: "p1", agentId: "main" },
    })!;
    await svc.processNext();
    const s = svc.enqueueSecure({
      name: "secret-scan.png",
      data: Buffer.from("s"),
      source: { kind: "secure-files" },
    });
    await svc.processNext();

    const snap = await buildSnapshot({
      kinds: new Set(["file", "topic"] as never),
      maxRowsPerDatabase: 0,
      stateDir: dir,
    });
    const file = snap.nodes.find((n) => n.id === `file:${e.id}`)!;
    expect(file).toMatchObject({ kind: "file", label: "invoice.png" });
    expect(file.meta).toMatchObject({
      fileId: e.id,
      lane: "normal",
      relPath: "invoice.png",
      fileKind: "image",
      status: "done",
    });
    const topics = snap.nodes
      .filter((n) => n.kind === "topic")
      .map((n) => n.label)
      .sort();
    expect(topics).toEqual(["Acme Ltd", "Zed Bank"]);
    expect(
      snap.edges.some(
        (x) => x.source === file.id && x.target === "topic:acme-ltd" && x.rel === "mentions",
      ),
    ).toBe(true);
    // Secure upload is absent from the normal graph.
    expect(JSON.stringify(snap)).not.toContain("secret-scan");
    expect(snap.nodes.some((n) => n.id.includes(s.id))).toBe(false);

    // …and present in the secure graph.
    const secure = new SecureLaneStore(vault).snapshot();
    const sf = secure.nodes.find((n) => n.id === `secure:file:${s.id}`);
    expect(sf?.kind).toBe("file");
    expect(sf?.meta).toMatchObject({ lane: "secure", fileId: s.id });
    expect(secure.nodes.some((n) => n.kind === "topic" && n.label === "Acme Ltd")).toBe(true);
    expect(JSON.stringify(secure)).not.toContain("invoice.png");
  });
});
