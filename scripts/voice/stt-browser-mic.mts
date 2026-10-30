#!/usr/bin/env -S node --import tsx
/**
 * Real browser mic path, end to end: Chromium with a FAKE microphone that
 * plays a known WAV (--use-file-for-fake-audio-capture) → the chat composer's
 * Talk button (MediaRecorder → clipToWav → POST /api/voice/stt → gateway →
 * built-in engine) → the transcript in the composer, scored with WER.
 *
 *   node --import tsx scripts/voice/stt-browser-mic.mts --url http://127.0.0.1:19486 \
 *     --token <gateway token> --wav fakemic.wav --expect "mister quilter is the apostle…" \
 *     --record-ms 8000 --shot /tmp/stt-browser-mic.png [--max-wer 0.15]
 *
 * The WAV should be speech followed by ≥20 s of silence: Chromium loops the
 * file, and the silence keeps a second pass out of the recording.
 */

import { chromium } from "playwright";

import { wordErrorRate } from "../../src/gateway/voice/native-engine/wer.ts";

const argv = process.argv.slice(2);
const get = (k: string, d = "") => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1]! : d;
};
const url = get("url", "http://127.0.0.1:19486");
const token = get("token");
const wav = get("wav");
const expected = get("expect");
const recordMs = Number(get("record-ms", "8000"));
const shot = get("shot", "/tmp/stt-browser-mic.png");
const maxWer = Number(get("max-wer", "0.15"));
if (!wav || !expected) {
  console.error("--wav <file> and --expect <transcript> are required");
  process.exit(2);
}

const browser = await chromium.launch({
  headless: true,
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    `--use-file-for-fake-audio-capture=${wav}`,
    "--autoplay-policy=no-user-gesture-required",
  ],
});
let exit = 1;
try {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    permissions: ["microphone"],
  });
  const page = await ctx.newPage();
  const sttCalls: { status: number; body: string }[] = [];
  page.on("response", async (r) => {
    if (r.url().includes("/api/voice/stt"))
      sttCalls.push({ status: r.status(), body: (await r.text().catch(() => "")).slice(0, 300) });
  });
  const q = token ? `?token=${encodeURIComponent(token)}` : "";
  await page.goto(`${url}/chat${q}`, { waitUntil: "domcontentloaded" });
  const talk = page.locator('button.talk[aria-label="Talk"]').first();
  await talk.waitFor({ state: "visible", timeout: 60_000 });
  await page.waitForTimeout(1500);
  await talk.click();
  await page
    .locator('button.talk[aria-label="Stop recording"]')
    .first()
    .waitFor({ timeout: 10_000 });
  await page.waitForTimeout(recordMs);
  await page.locator('button.talk[aria-label="Stop recording"]').first().click();
  // Transcript lands in the composer textarea.
  const box = page.locator(".chat-compose textarea").first();
  const t0 = Date.now();
  let text = "";
  while (Date.now() - t0 < 60_000) {
    text = (await box.inputValue().catch(() => "")).trim();
    if (text) break;
    await page.waitForTimeout(250);
  }
  const ms = Date.now() - t0;
  await box.scrollIntoViewIfNeeded().catch(() => undefined);
  await page.screenshot({ path: shot });
  const w = wordErrorRate(expected, text);
  console.log(
    JSON.stringify(
      { transcript: text, expected, wer: w.wer, transcribeWaitMs: ms, sttCalls, screenshot: shot },
      null,
      2,
    ),
  );
  exit = text && w.wer <= maxWer ? 0 : 1;
  console.log(
    exit === 0
      ? `PASS: browser mic WER ${(w.wer * 100).toFixed(1)}%`
      : `FAIL: WER ${(w.wer * 100).toFixed(1)}%`,
  );
} finally {
  await browser.close();
}
process.exit(exit);
