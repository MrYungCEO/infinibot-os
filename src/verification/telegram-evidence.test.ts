import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cfg: { value: Record<string, unknown> } = { value: {} };
vi.mock("../config/config.js", () => ({ loadConfig: () => cfg.value }));

import { createRecord, resetVerificationStoreForTests, verificationRunDir } from "./store.js";
import {
  attachVerificationEvidence,
  captionFromFilename,
  evidenceSummaryLine,
  prepareTelegramImage,
  resetEvidenceLedgerForTests,
  resolveEvidenceRunId,
  selectVerificationEvidence,
} from "./telegram-evidence.js";

let stateDir: string;
const prev = process.env.INFINIBOT_STATE_DIR;

/** Deterministic noise image: distinct seeds → distinct dHashes. */
async function noisePng(file: string, seed: number, w = 640, h = 400, tweak = false) {
  const sharp = (await import("sharp")).default;
  const buf = Buffer.alloc(w * h * 3);
  let x = seed * 2654435761;
  // Coarse 40px blocks so the 9×8 dHash sees real structure.
  for (let py = 0; py < h; py++)
    for (let px = 0; px < w; px++) {
      const block = Math.floor(py / 40) * 1000 + Math.floor(px / 40);
      x = (block * 2246822519 + seed * 3266489917) >>> 0;
      const v = (x ^ (x >>> 13)) & 0xff;
      const i = (py * w + px) * 3;
      buf[i] = v;
      buf[i + 1] = (v * 7) & 0xff;
      buf[i + 2] = (v * 13) & 0xff;
    }
  if (tweak) buf[0] = buf[0] ^ 0xff; // one pixel differs → new sha, same dHash
  await sharp(buf, { raw: { width: w, height: h, channels: 3 } })
    .png()
    .toFile(file);
}

async function solidPng(file: string, w = 800, h = 500) {
  const sharp = (await import("sharp")).default;
  await sharp({
    create: { width: w, height: h, channels: 3, background: { r: 255, g: 255, b: 255 } },
  })
    .png()
    .toFile(file);
}

function seedRun(runId: string, childSessionKey = "agent:main:subagent:x") {
  createRecord({
    runId,
    childSessionKey,
    requesterSessionKey: "agent:main:main",
    label: "UI run",
    task: "t",
  });
  return verificationRunDir(runId);
}

beforeEach(() => {
  stateDir = mkdtempSync(path.join(tmpdir(), "tg-evidence-"));
  process.env.INFINIBOT_STATE_DIR = stateDir;
  cfg.value = { channels: { telegram: { defaultChatId: "111" } } };
  resetVerificationStoreForTests();
  resetEvidenceLedgerForTests();
});

afterEach(() => {
  if (prev === undefined) delete process.env.INFINIBOT_STATE_DIR;
  else process.env.INFINIBOT_STATE_DIR = prev;
  rmSync(stateDir, { recursive: true, force: true });
});

describe("selectVerificationEvidence", () => {
  it("skips sign-in walls and blank/tiny images, prefers result-shots, then after/live over before", async () => {
    const dir = seedRun("run-a");
    const results = path.join(dir, "result-shots");
    const v1 = path.join(dir, "visual-old");
    const v2 = path.join(dir, "visual-new");
    for (const d of [results, v1, v2]) mkdirSync(d, { recursive: true });
    await noisePng(path.join(v1, "dashboard__desktop__dark.png"), 1);
    await noisePng(path.join(v2, "sign_in__desktop__dark.png"), 2);
    await solidPng(path.join(v2, "blank__desktop.png"));
    writeFileSync(path.join(v2, "tiny.png"), Buffer.from("not-really-a-png"));
    await noisePng(path.join(results, "a053b8b5-api-keys-before.png"), 3);
    await noisePng(path.join(results, "ddfc6653-api-keys-after.png"), 4);
    await noisePng(path.join(results, "f7d4bb05-motion-picker-live.png"), 5);
    // The visual capture is newest, but result-shots still win.
    const later = new Date(Date.now() + 60_000);
    utimesSync(path.join(v1, "dashboard__desktop__dark.png"), later, later);

    const sel = await selectVerificationEvidence("run-a", { max: 6 });
    const names = sel.picked.map((p) => p.name);
    // after/live (newest first) → before → visual_verify captures.
    expect(new Set(names.slice(0, 2))).toEqual(
      new Set(["ddfc6653-api-keys-after.png", "f7d4bb05-motion-picker-live.png"]),
    );
    expect(names.slice(2)).toEqual([
      "a053b8b5-api-keys-before.png",
      "dashboard__desktop__dark.png",
    ]);
    const reasons = Object.fromEntries(sel.skipped.map((s) => [path.basename(s.path), s.reason]));
    expect(reasons).toMatchObject({
      "sign_in__desktop__dark.png": "sign_in",
      "blank__desktop.png": "blank",
      "tiny.png": "tiny",
    });
    expect(sel.picked.find((p) => p.name.includes("after"))?.caption).toBe("api keys after");
  });

  it("dedupes identical and near-identical images by hash", async () => {
    const dir = seedRun("run-b");
    const results = path.join(dir, "result-shots");
    const vis = path.join(dir, "visual-1");
    mkdirSync(results, { recursive: true });
    mkdirSync(vis, { recursive: true });
    await noisePng(path.join(results, "aaaaaaaa-home.png"), 7);
    await noisePng(path.join(vis, "home__desktop__dark.png"), 7); // byte-identical
    await noisePng(path.join(vis, "home-again__desktop__dark.png"), 7, 640, 400, true); // 1px off
    await noisePng(path.join(vis, "settings__desktop__dark.png"), 8);

    const sel = await selectVerificationEvidence("run-b");
    expect(sel.picked.map((p) => p.name)).toEqual([
      "aaaaaaaa-home.png",
      "settings__desktop__dark.png",
    ]);
    expect(sel.skipped.filter((s) => s.reason === "duplicate")).toHaveLength(2);
  });

  it("caps at max and reports how many more there are", async () => {
    const dir = path.join(seedRun("run-c"), "result-shots");
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 9; i++) await noisePng(path.join(dir, `shot-${i}.png`), 100 + i);
    const sel = await selectVerificationEvidence("run-c", { max: 6 });
    expect(sel.picked).toHaveLength(6);
    expect(sel.total).toBe(9);
    expect(sel.more).toBe(3);
    expect(evidenceSummaryLine(sel)).toBe(
      "📸 6 screenshots attached below · +3 more in the run's evidence",
    );
    expect(evidenceSummaryLine({ picked: [], more: 0 })).toBe("📷 no visual evidence");
  });
});

describe("attachVerificationEvidence", () => {
  async function seedShots(runId: string, n: number, childKey?: string) {
    const dir = path.join(seedRun(runId, childKey), "result-shots");
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < n; i++) await noisePng(path.join(dir, `00000000-step-${i}.png`), 300 + i);
  }

  it("sends an album threaded under the text message, labelled with the verdict", async () => {
    await seedShots("run-d", 8);
    const send = vi.fn(async (_chat: string, items: Array<{ caption?: string }>) => ({
      chatId: "111",
      messageIds: items.map((_, i) => String(500 + i)),
    }));
    const res = await attachVerificationEvidence("run-d", "42", { send, state: "unverified" });
    expect(res).toMatchObject({ ok: true, sent: 6, more: 2 });
    expect(res.messageIds).toEqual(["500", "501", "502", "503", "504", "505"]);
    const [chat, items, opts] = send.mock.calls[0] as unknown as [
      string,
      Array<{ caption: string }>,
      { replyToMessageId?: number },
    ];
    expect(chat).toBe("111");
    expect(opts.replyToMessageId).toBe(42);
    expect(items[0].caption).toContain("UNVERIFIED");
    expect(items[0].caption).toContain("1/6 · step");
    expect(items[5].caption).toContain("+2 more in the run's evidence");
    // A second message about the same run does not resend the same images.
    const again = await attachVerificationEvidence("run-d", "43", { send });
    expect(again.skipped).toBe("already_sent");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("never sends screenshots from a Secure Mode run", async () => {
    await seedShots("run-secure", 2, "agent:main:secure-abc123");
    const send = vi.fn();
    const res = await attachVerificationEvidence("run-secure", 1, { send: send as never });
    expect(res.skipped).toBe("secure");
    expect(send).not.toHaveBeenCalled();
    // Also when only the caller knows the lane.
    await seedShots("run-sec-2", 2);
    const res2 = await attachVerificationEvidence("run-sec-2", 1, {
      send: send as never,
      sessionKeys: ["agent:main:groupchat-sec-team"],
    });
    expect(res2.skipped).toBe("secure");
    expect(send).not.toHaveBeenCalled();
    // And for a run of an agent set to always run in Secure Mode.
    cfg.value = { ...cfg.value, agents: { list: [{ id: "vaultkeeper", secureOnly: true }] } };
    await seedShots("run-sec-3", 2, "agent:vaultkeeper:subagent:x");
    const res3 = await attachVerificationEvidence("run-sec-3", 1, { send: send as never });
    expect(res3.skipped).toBe("secure");
    expect(send).not.toHaveBeenCalled();
  });

  it("respects notifications.telegram.attachVerificationScreenshots=false and the max", async () => {
    await seedShots("run-cfg", 5);
    const send = vi.fn(async (_c: string, items: unknown[]) => ({
      chatId: "111",
      messageIds: items.map((_, i) => String(i)),
    }));
    cfg.value = {
      ...cfg.value,
      notifications: { telegram: { attachVerificationScreenshots: false } },
    };
    expect((await attachVerificationEvidence("run-cfg", 1, { send })).skipped).toBe("disabled");
    cfg.value = { ...cfg.value, notifications: { telegram: { maxVerificationScreenshots: 2 } } };
    const res = await attachVerificationEvidence("run-cfg", 1, { send });
    expect(res).toMatchObject({ sent: 2, more: 3 });
  });

  it("never throws when Telegram fails — the main message is unaffected", async () => {
    await seedShots("run-fail", 2);
    const send = vi.fn(async () => {
      throw new Error("400: Bad Request: wrong file identifier");
    });
    const res = await attachVerificationEvidence("run-fail", 9, { send });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("wrong file identifier");
  });

  it("retries a 429 after retry_after through the real media-group sender", async () => {
    await seedShots("run-429", 3);
    cfg.value = {
      ...cfg.value,
      channels: { telegram: { defaultChatId: "111", botToken: "123:abc" } },
    };
    let calls = 0;
    const api = {
      sendMediaGroup: vi.fn(async (_chat: unknown, media: unknown[]) => {
        calls += 1;
        if (calls === 1) {
          const err = Object.assign(
            new Error(
              "Call to 'sendMediaGroup' failed! (429: Too Many Requests: retry after 0.05)",
            ),
            { error_code: 429, parameters: { retry_after: 0.05 } },
          );
          throw err;
        }
        return media.map((_, i) => ({ message_id: 900 + i, chat: { id: 111 } }));
      }),
    };
    const started = Date.now();
    const res = await attachVerificationEvidence("run-429", 77, {
      api: api as never,
      retry: { attempts: 3, minDelayMs: 1, maxDelayMs: 2000, jitter: 0 },
    });
    expect(api.sendMediaGroup).toHaveBeenCalledTimes(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(45);
    expect(res).toMatchObject({ ok: true, sent: 3, messageIds: ["900", "901", "902"] });
    const params = api.sendMediaGroup.mock.calls[1] as unknown as [
      unknown,
      unknown,
      Record<string, unknown>,
    ];
    expect(params[2].reply_parameters).toMatchObject({
      message_id: 77,
      allow_sending_without_reply: true,
    });
  });
});

describe("helpers", () => {
  it("captions from filenames", () => {
    expect(captionFromFilename("a053b8b5-api-keys-mobile.png")).toBe("api keys mobile");
    expect(captionFromFilename("chat__desktop__dark.png")).toBe("chat · desktop · dark");
  });

  it("compresses an oversized PNG under the photo limits and sends extreme panoramas as documents", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tg-big-"));
    const big = path.join(dir, "huge.png");
    await noisePng(big, 9, 4000, 3000);
    const out = await prepareTelegramImage({
      path: big,
      name: "huge.png",
      width: 4000,
      height: 3000,
    });
    expect(out.asDocument).toBe(false);
    expect(out.fileName).toBe("huge.jpg");
    const sharp = (await import("sharp")).default;
    const meta = await sharp(out.buffer).metadata();
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(2560);
    expect(out.buffer.length).toBeLessThan(10 * 1024 * 1024);
    const tall = path.join(dir, "tall.png");
    await noisePng(tall, 10, 100, 2200);
    const t = await prepareTelegramImage({
      path: tall,
      name: "tall.png",
      width: 100,
      height: 2200,
    });
    expect(t.asDocument).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("finds the run a message is about", () => {
    seedRun("coder-ui-fix-ab12");
    expect(resolveEvidenceRunId(undefined, "Done ✅ runId: coder-ui-fix-ab12")).toBe(
      "coder-ui-fix-ab12",
    );
    expect(resolveEvidenceRunId(undefined, "finished coder-ui-fix-ab12 ok")).toBe(
      "coder-ui-fix-ab12",
    );
    expect(resolveEvidenceRunId(undefined, "runId: unknown-run-999")).toBeNull();
    expect(resolveEvidenceRunId("explicit", "x")).toBe("explicit");
  });
});
