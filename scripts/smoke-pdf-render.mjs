#!/usr/bin/env node
/**
 * Smoke-check the remote HTML→PDF render service.
 *
 * Verifies:
 *   1. The configured endpoint (default http://localhost:8091) is reachable.
 *   2. POST /render with an HTML body returns a PDF (application/pdf or
 *      a body that starts with the %PDF- magic).
 *
 * The service contract is: POST /render with JSON `{ "html": "<...>" }`
 * → responds with application/pdf bytes.
 *
 * Run:  node scripts/smoke-pdf-render.mjs
 * Override endpoint: REPORTS_PDF_RENDER_URL=http://host:port node scripts/smoke-pdf-render.mjs
 *
 * Exit code 0 = pass, 1 = fail.
 */
import { writeFileSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULT_URL = "http://localhost:8091";
const baseUrl = (process.env.REPORTS_PDF_RENDER_URL || process.env.PDF_RENDER_URL || DEFAULT_URL)
  .trim()
  .replace(/\/+$/, "");
const url = `${baseUrl}/render`;

const html = `<!doctype html><html><head><meta charset="utf-8"><title>Smoke</title></head>
<body><h1>PDF render smoke test</h1><p>Hello from moltbot at ${new Date().toISOString()}</p></body></html>`;

console.log(`[smoke] POST ${url} (JSON { html }, ${Buffer.byteLength(html)} bytes)`);

let res;
try {
  res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ html }),
  });
} catch (err) {
  console.error(`[smoke] FAIL: could not reach ${url} — ${(err && err.message) || err}`);
  console.error(`[smoke] Is the PDF render service running on ${baseUrl}?`);
  process.exit(1);
}

console.log(`[smoke] HTTP ${res.status} ${res.statusText}`);
console.log(`[smoke] Content-Type: ${res.headers.get("content-type")}`);

if (!res.ok) {
  const text = await res.text().catch(() => "<no body>");
  console.error(`[smoke] FAIL: non-2xx status. Body: ${text.slice(0, 200)}`);
  process.exit(1);
}

const buf = Buffer.from(await res.arrayBuffer());
console.log(`[smoke] received ${buf.length} bytes`);

const isPdfMagic = buf.slice(0, 5).toString("latin1") === "%PDF-";
const ct = (res.headers.get("content-type") || "").toLowerCase();
const isPdfCt = ct.includes("application/pdf");

if (!isPdfMagic && !isPdfCt) {
  const dir = mkdtempSync(join(tmpdir(), "smoke-pdf-"));
  const f = join(dir, "out.bin");
  writeFileSync(f, buf);
  console.error(`[smoke] FAIL: response is not a PDF (no %PDF- magic, ct=${ct}). Saved raw bytes to ${f}`);
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), "smoke-pdf-"));
const out = join(dir, "smoke.pdf");
writeFileSync(out, buf);
console.log(`[smoke] PASS: got a PDF (${buf.length} bytes). Saved to ${out}`);
try { rmSync(dir, { recursive: true, force: true }); } catch {}
process.exit(0);