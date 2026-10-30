import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handleVerificationHttpRequest, resolveVerificationFile } from "../gateway/verification-http.js";
import { verificationHandlers } from "../gateway/server-methods/verification.js";
import {
  listScreenshots,
  noteRunScreenshots,
  resetScreenshotIndexForTests,
  setScreenshotBroadcaster,
} from "./screenshot-index.js";
import { createRecord, resetVerificationStoreForTests, updateRecord, verificationRunDir } from "./store.js";

let stateDir: string;
const prev = process.env.INFINIBOT_STATE_DIR;

async function png(file: string, w = 800, h = 500) {
  const sharp = (await import("sharp")).default;
  await sharp({ create: { width: w, height: h, channels: 3, background: { r: 200, g: 160, b: 40 } } })
    .png()
    .toFile(file);
}

beforeEach(() => {
  stateDir = mkdtempSync(path.join(tmpdir(), "shot-index-"));
  process.env.INFINIBOT_STATE_DIR = stateDir;
  resetVerificationStoreForTests();
  resetScreenshotIndexForTests();
});

afterEach(() => {
  if (prev === undefined) delete process.env.INFINIBOT_STATE_DIR;
  else process.env.INFINIBOT_STATE_DIR = prev;
  rmSync(stateDir, { recursive: true, force: true });
});

async function seed() {
  createRecord({ runId: "ui-run", childSessionKey: "agent:main:subagent:ui", requesterSessionKey: "r", label: "Restyle mesh", task: "t" });
  const cap = path.join(verificationRunDir("ui-run"), "visual-aaa111");
  mkdirSync(cap, { recursive: true });
  await png(path.join(cap, "mesh__desktop__dark.png"));
  await png(path.join(cap, "mesh__mobile__light.png"), 390, 844);
  writeFileSync(
    path.join(cap, "report.json"),
    JSON.stringify({ shots: [{ route: "/mesh", viewport: "desktop", theme: "dark", path: path.join(cap, "mesh__desktop__dark.png"), consoleErrors: ["[.WebGL-0x1]GL Driver Message (x): GPU stall due to ReadPixels"], pageErrors: [] }] }),
  );
  writeFileSync(path.join(cap, "result.json"), JSON.stringify({ assessment: { available: true, pass: false, summary: "panel overlaps", issues: ["overlap"] } }));
  // A non-visual run: never in the gallery.
  createRecord({ runId: "backend-run", childSessionKey: "agent:main:subagent:be", requesterSessionKey: "r", label: "Backend fix", task: "t" });
  // A visual run whose RESULT screenshot lives outside the verification dir.
  const outside = mkdtempSync(path.join(tmpdir(), "shot-outside-"));
  const shot = path.join(outside, "plugins-desktop-dark.png");
  await png(shot);
  createRecord({ runId: "result-run", childSessionKey: "agent:main:subagent:rr", requesterSessionKey: "r", label: "Plugins page", task: "t" });
  updateRecord("result-run", (r) => {
    r.result = { status: "done", summary: "", commits: [], files_changed: [], claims: [], checks_run: [], screenshots: [shot], open_issues: [] };
    r.review = { verdict: "VERIFIED", reasons: [], evidence: [{ kind: "screenshot", ref: shot, status: "pass", detail: "" }], visualFiles: ["ui/src/ui/views/plugins.ts"], visualSatisfied: true, screenshots: [shot], llm: null, changedFiles: [], commits: [], reviewedAt: Date.now() };
    r.state = "verified";
  });
  return { cap, outside };
}

describe("screenshot index", () => {
  it("indexes visual_verify captures + copied RESULT shots of UI runs only, with filters", async () => {
    const { outside } = await seed();
    const all = listScreenshots({});
    expect(all.total).toBe(3);
    expect(new Set(all.items.map((i) => i.runId))).toEqual(new Set(["ui-run", "result-run"]));
    const desk = all.items.find((i) => i.path.endsWith("mesh__desktop__dark.png"))!;
    expect(desk).toMatchObject({ route: "/mesh", viewport: "desktop", theme: "dark", verdict: "fail", consoleErrors: 0, label: "Restyle mesh", source: "visual_verify" });
    expect(desk.thumbUrl).toMatch(/&thumb=1$/);
    const copied = all.items.find((i) => i.runId === "result-run")!;
    expect(copied.path.startsWith(verificationRunDir("result-run"))).toBe(true);
    expect(copied).toMatchObject({ viewport: "desktop", theme: "dark", verdict: "pass", source: "result" });
    expect(listScreenshots({ viewport: "mobile" }).items.map((i) => i.theme)).toEqual(["light"]);
    expect(listScreenshots({ verdict: "pass" }).total).toBe(1);
    expect(listScreenshots({ q: "overlaps" }).total).toBe(2);
    expect(listScreenshots({ limit: 2 }).nextCursor).toBe(2);
    expect(listScreenshots({ cursor: 2, limit: 2 }).items).toHaveLength(1);
    rmSync(outside, { recursive: true, force: true });
  });

  it("pushes newly captured screenshots live", async () => {
    await seed();
    listScreenshots({});
    const pushed: unknown[] = [];
    setScreenshotBroadcaster((ev, payload) => pushed.push([ev, payload]));
    const cap2 = path.join(verificationRunDir("ui-run"), "visual-bbb222");
    mkdirSync(cap2, { recursive: true });
    await png(path.join(cap2, "grid__desktop__dark.png"));
    const added = noteRunScreenshots("ui-run");
    expect(added.map((a) => path.basename(a.path))).toEqual(["grid__desktop__dark.png"]);
    expect((pushed[0] as [string])[0]).toBe("verification.screenshots");
  });

  it("serves the RPC and safe thumbnails (no traversal outside the verification dir)", async () => {
    const { cap } = await seed();
    let out: { items: Array<{ path: string }>; total: number } | undefined;
    await verificationHandlers["verification.screenshots.list"]({
      params: { viewport: "desktop", limit: 10 },
      respond: (ok: boolean, payload: unknown) => {
        expect(ok).toBe(true);
        out = payload as typeof out;
      },
    } as never);
    expect(out?.total).toBe(2);

    expect(resolveVerificationFile("/etc/passwd")).toBeNull();
    expect(resolveVerificationFile(`${verificationRunDir("ui-run")}/../../../../etc/passwd`)).toBeNull();
    const file = path.join(cap, "mesh__desktop__dark.png");
    const { PassThrough } = await import("node:stream");
    const sink = new PassThrough();
    const body: Buffer[] = [];
    sink.on("data", (c: Buffer) => body.push(c));
    const res = Object.assign(sink, {
      code: 0,
      headers: {} as Record<string, string>,
      writeHead(code: number, h?: Record<string, string>) {
        res.code = code;
        Object.assign(res.headers, h ?? {});
        return res;
      },
    });
    const req = { url: `/api/verification/file?path=${encodeURIComponent(file)}&thumb=1`, method: "GET" } as IncomingMessage;
    expect(await handleVerificationHttpRequest(req, res as unknown as ServerResponse)).toBe(true);
    expect(res.code).toBe(200);
    expect(res.headers["Content-Type"]).toBe("image/webp");
    await new Promise((r) => sink.on("end", r));
    const sharp = (await import("sharp")).default;
    const meta = await sharp(Buffer.concat(body)).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.width).toBe(360);
    expect(existsSync(path.join(stateDir, "verification", ".thumbs"))).toBe(true);
  });
});
