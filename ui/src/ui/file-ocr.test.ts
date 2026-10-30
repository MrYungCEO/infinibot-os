import { describe, expect, it } from "vitest";
import { formatConfidence, isImageFileName, isOcrFileName, isOcrPending, ocrStatusLabel, sha256OfBase64 } from "./file-ocr";

describe("file-ocr helpers", () => {
  it("recognises OCR-able files", () => {
    for (const n of [
      "a.PNG",
      "scan.pdf",
      "x.heic",
      "deck.pptx",
      "r.docx",
      "s.xlsx",
      "notes.md",
      "notes.txt",
      "data.csv",
    ]) expect(isOcrFileName(n)).toBe(true);
    for (const n of ["a.ts", "", null]) expect(isOcrFileName(n)).toBe(false);
    expect(isImageFileName("shot.webp")).toBe(true);
    expect(isImageFileName("doc.pdf")).toBe(false);
  });

  it("labels statuses and progress", () => {
    expect(ocrStatusLabel({ status: "processing", progress: { done: 3, total: 9, stage: "pages" } })).toBe("Reading 3/9");
    expect(ocrStatusLabel({ status: "done" })).toBe("Text ready");
    expect(ocrStatusLabel(null)).toBe("Not scanned");
    expect(isOcrPending("queued")).toBe(true);
    expect(isOcrPending("done")).toBe(false);
    expect(formatConfidence(0.973)).toBe("97%");
    expect(formatConfidence(null)).toBe("—");
  });

  it("hashes base64 content like the gateway (sha256 hex)", async () => {
    // "hello" → 2cf24dba…
    expect(await sha256OfBase64(btoa("hello"))).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    expect(await sha256OfBase64(`data:image/png;base64,${btoa("hello")}`)).toMatch(/^2cf24dba/);
  });
});
