#!/usr/bin/env node
/**
 * Content Studio posting queue — end-to-end check on a THROWAWAY side gateway.
 *
 *   node extensions/content-studio/scripts/posting-e2e.mjs            # run, stop
 *   KEEP=1 node …/posting-e2e.mjs                                     # leave it up (screenshots)
 *   STOP=1 node …/posting-e2e.mjs                                     # stop a kept gateway
 *   AGENT_TURN=1 node …/posting-e2e.mjs   # + one main-agent chat turn (needs OLLAMA_CLOUD_API_KEY;
 *                                          the key is passed by env and referenced as ${…} in config)
 *
 * Isolation (never the owner's install):
 *   - HOME, INFINIBOT_STATE_DIR and INFINIBOT_CONFIG_PATH all under $CPQ_E2E_DIR
 *     (default /tmp/cpq-e2e); a fresh config with only a gateway token
 *   - loopback port $CPQ_E2E_PORT (default 19141), channels skipped,
 *     Droid Swarm's phone listener off
 *   - PATH starts with extensions/droid-swarm/test/fake-bin: the FAKE adb
 *     (version 99, so the resolver picks it over any real adb) driving the
 *     stateful fake Instagram/TikTok (fake-social.js). Every adb call is logged
 *     and the run asserts they all went to the fake.
 *   - every page runs in DRY RUN: the phone flow stops before the final Share
 *     tap. The fake app's "published" list must stay empty.
 */

import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const DIR = path.resolve(process.env.CPQ_E2E_DIR || "/tmp/cpq-e2e");
const PORT = Number(process.env.CPQ_E2E_PORT || 19141);
const TOKEN = process.env.CPQ_E2E_TOKEN || "cpq-e2e-token";
const NODE_BIN = process.env.NODE_BIN_DIR || path.join(os.homedir(), ".nvm/versions/node/v22.23.1/bin");
const FAKE_BIN = path.join(REPO, "extensions/droid-swarm/test/fake-bin");
const SOCIAL = path.join(DIR, "fake-social.json");
const ADB_LOG = path.join(DIR, "adb.log");
const FORBIDDEN_PORTS = new Set([18789, 18901, 18911]);

const live = path.join(os.homedir(), ".infinibot");
if (DIR === live || DIR.startsWith(live + path.sep)) throw new Error(`refusing: ${DIR} is inside ~/.infinibot`);
// The RPC client below (dist/gateway/call.js) reads config and STORES device
// tokens under HOME / the state dir. Point THIS process at the throwaway dir
// too, before anything from dist/ is imported — otherwise it would write the
// side gateway's device token into the owner's ~/.infinibot/identity.
const HOST_DEVICE_AUTH = path.join(live, "identity", "device-auth.json");
/** The stored device tokens only (live clients may bump updatedAtMs on their own). */
const fingerprint = (f) => {
  try {
    const d = JSON.parse(fs.readFileSync(f, "utf8"));
    return JSON.stringify([d.deviceId, Object.entries(d.tokens ?? {}).map(([r, t]) => [r, t.token])]);
  } catch {
    return null;
  }
};
const hostDeviceAuthBefore = fingerprint(HOST_DEVICE_AUTH);
process.env.HOME = path.join(DIR, "home");
process.env.INFINIBOT_STATE_DIR = path.join(DIR, "state");
process.env.INFINIBOT_CONFIG_PATH = path.join(DIR, "state/infinibot.json");
delete process.env.INFINIBOT_GATEWAY_TOKEN;
delete process.env.INFINIBOT_GATEWAY_URL;
if (FORBIDDEN_PORTS.has(PORT)) throw new Error(`refusing: port ${PORT} belongs to a live gateway`);
if (fs.existsSync(path.join(REPO, ".env"))) throw new Error(`refusing: ${REPO}/.env would load live settings`);

let fails = 0;
let passes = 0;
const pass = (m) => {
  passes++;
  console.log(`PASS ${m}`);
};
const fail = (m) => {
  fails++;
  console.log(`FAIL ${m}`);
};
const check = (ok, m, extra = "") => (ok ? pass(m) : fail(`${m}${extra ? ` — ${extra}` : ""}`));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pidOnPort(port) {
  const out = execSync(`ss -ltnp 2>/dev/null | grep "127.0.0.1:${port} " || true`).toString();
  const m = /pid=(\d+)/.exec(out);
  return m ? Number(m[1]) : null;
}
/** Only ever stop the process that owns OUR port (never by process title). */
function stopOurs() {
  const pid = pidOnPort(PORT);
  if (pid) {
    try {
      process.kill(pid);
    } catch {}
  }
}

if (process.env.STOP === "1") {
  stopOurs();
  console.log("stopped");
  process.exit(0);
}

const { callGateway } = await import(path.join(REPO, "dist/gateway/call.js"));
const rpc = (method, params = {}, timeoutMs = 30_000, expectFinal = false) =>
  callGateway({ method, params, timeoutMs, expectFinal, url: `ws://127.0.0.1:${PORT}`, token: TOKEN });
const http = async (p, init = {}) => {
  const res = await fetch(`http://127.0.0.1:${PORT}${p}`, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(init.headers || {}) },
  });
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: text };
  }
};
const social = () => JSON.parse(fs.readFileSync(SOCIAL, "utf8"));
const setSocial = (patch) => {
  const s = social();
  fs.writeFileSync(SOCIAL, JSON.stringify({ ...s, ...patch }, null, 2));
};

// ── fresh isolated state ───────────────────────────────────────────────────
stopOurs();
await sleep(800);
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(path.join(DIR, "home"), { recursive: true });
fs.mkdirSync(path.join(DIR, "state"), { recursive: true });
const config = {
  gateway: { mode: "local", auth: { mode: "token", token: TOKEN } },
  agents: { defaults: { model: { primary: process.env.CPQ_E2E_MODEL || "ollama-cloud/gpt-oss:120b" } } },
  models: {
    providers: {
      "ollama-cloud": {
        baseUrl: "https://ollama.com/v1",
        apiKey: "${OLLAMA_CLOUD_API_KEY}",
        api: "openai-completions",
        models: [{ id: "gpt-oss:120b", name: "gpt-oss 120b" }],
      },
    },
  },
  plugins: {
    entries: {
      "content-studio": { enabled: true, config: { instagramSync: false } },
      "droid-swarm": { enabled: true, config: { listener: false } },
    },
  },
};
fs.writeFileSync(path.join(DIR, "state/infinibot.json"), JSON.stringify(config, null, 2));
fs.writeFileSync(
  SOCIAL,
  JSON.stringify(
    {
      instagram: { loggedIn: true, active: "brand.co", accounts: ["brand.co", "brand.backup"], posts: { "brand.co": 41 } },
      tiktok: { loggedIn: true, active: "brand.tt", posts: { "brand.tt": 7 } },
    },
    null,
    2,
  ),
);

const env = {
  HOME: path.join(DIR, "home"),
  USER: process.env.USER || "user",
  PATH: [FAKE_BIN, NODE_BIN, "/usr/bin", "/bin"].join(path.delimiter),
  INFINIBOT_STATE_DIR: path.join(DIR, "state"),
  INFINIBOT_CONFIG_PATH: path.join(DIR, "state/infinibot.json"),
  INFINIBOT_SKIP_CHANNELS: "1",
  FAKE_ADB_LOG: ADB_LOG,
  FAKE_ADB_DEVICES: "fake-01",
  FAKE_ADB_SOCIAL_STATE: SOCIAL,
  OLLAMA_CLOUD_API_KEY: process.env.AGENT_TURN === "1" ? (process.env.OLLAMA_CLOUD_API_KEY ?? "") : "",
};
const log = fs.openSync(path.join(DIR, "gateway.log"), "a");
const gw = spawn(path.join(NODE_BIN, "node"), [path.join(REPO, "dist/entry.js"), "gateway", "--port", String(PORT), "--bind", "loopback"], {
  // The gateway resolves a few vendored libs from process.cwd(); state still
  // lives only under DIR (INFINIBOT_STATE_DIR / CONFIG_PATH / HOME).
  cwd: REPO,
  env,
  detached: true,
  stdio: ["ignore", log, log],
});
gw.unref();
fs.writeFileSync(path.join(DIR, "info.json"), JSON.stringify({ port: PORT, token: TOKEN, pid: gw.pid, dir: DIR }, null, 2));

let up = false;
for (let i = 0; i < 90 && !up; i++) {
  await sleep(2000);
  try {
    await rpc("health", {}, 5000);
    up = true;
  } catch {}
}
check(up, `side gateway up on 127.0.0.1:${PORT} (state ${DIR}/state)`);
if (!up) {
  console.log(fs.readFileSync(path.join(DIR, "gateway.log"), "utf8").slice(-3000));
  process.exit(1);
}
await sleep(4000);
const plugins = await rpc("plugins.list");
for (const id of ["content-studio", "droid-swarm"]) {
  const p = plugins.plugins.find((x) => x.id === id);
  check(p?.status === "loaded", `${id} plugin loaded`, p?.error ?? p?.status);
}

// ── fake phone + content page ──────────────────────────────────────────────
const reg = await http("/plugins/droid-swarm/api/fleet/register", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ label: "Phone 01", serial: "fake-01", model: "Pixel 8" }),
});
check(reg.status === 200, "registered fake handset fake-01", JSON.stringify(reg.body).slice(0, 200));
await http("/plugins/droid-swarm/api/fleet/refresh", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
const devs = await rpc("content-studio.posting.devices");
const dev = devs.devices?.[0];
check(dev?.online === true, `posting.devices sees Phone 01 online (${dev?.status}/${dev?.adbState})`, JSON.stringify(devs).slice(0, 300));

const page = (await rpc("content.pages.create", { businessId: "biz_e2e", name: "Brand Reels", surface: "instagram", handle: "brand.co" })).page;
check(Boolean(page?.id), `created content page ${page?.id}`);

const det = await rpc("content-studio.posting.detect", { deviceId: dev.id, platform: "instagram" }, 120_000);
check(det.ok && det.detection?.activeHandle === "brand.co", `detected active IG account @${det.detection?.activeHandle}`, det.reason);
check(JSON.stringify(det.detection?.accounts) === JSON.stringify(["brand.co", "brand.backup"]), `detected logged-in accounts ${JSON.stringify(det.detection?.accounts)}`);

// ── upload 3 videos ────────────────────────────────────────────────────────
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypmp42"), Buffer.alloc(12), Buffer.alloc(4096, 3)]);
const mediaIds = [];
for (const name of ["Ep1 hook test", "Ep2 behind the scenes", "Ep3 results"]) {
  const up = await http(`/plugins/content-studio/media?filename=${encodeURIComponent(name + ".mp4")}`, {
    method: "POST",
    headers: { "content-type": "video/mp4" },
    body: mp4,
  });
  check(up.status === 200 && up.body?.media?.kind === "video", `uploaded "${name}.mp4" (${up.body?.media?.id})`, JSON.stringify(up.body).slice(0, 200));
  mediaIds.push([up.body.media.id, name]);
}

// ── bind + schedule + template ─────────────────────────────────────────────
const cfgRes = await rpc("content-studio.posting.configure", {
  pageId: page.id,
  deviceId: dev.id,
  deviceLabel: dev.label,
  bindings: [{ platform: "instagram", handle: "brand.co" }],
  schedule: { mode: "interval", everyMinutes: 2, windowStart: "00:00", windowEnd: "00:00", timezone: "Asia/Bangkok", jitterMinutes: 0, dailyCap: 20 },
  template: "{hook}\n\n{title} · {series} ep {episode}\n{cta}\n\n{hashtags}",
  defaultHashtags: "#brand #reels",
  cta: "Follow for part 2",
  dryRun: true,
  requireApproval: false,
  enabled: true,
});
check(cfgRes.config.enabled && cfgRes.config.dryRun && cfgRes.config.schedule.everyMinutes === 2, `bound page → Phone 01 / IG @brand.co, every 2 min, dry run (${cfgRes.summary})`);

const t0 = Date.now();
for (const [i, [mediaId, title]] of mediaIds.entries()) {
  const q = await rpc("content-studio.posting.enqueue", {
    pageId: page.id,
    mediaId,
    title,
    hook: `Hook ${i + 1}: you're doing reels wrong`,
    series: "Growth Diaries",
    episode: String(i + 1),
  });
  check(q.entries?.[0]?.status === "queued", `queued "${title}"`);
}

// ── watch the scheduler drain the queue ────────────────────────────────────
let state;
for (let i = 0; i < 80; i++) {
  await sleep(10_000);
  state = await rpc("content-studio.posting.get", { pageId: page.id });
  const statuses = state.queue.map((e) => e.status).join(",");
  console.log(`  t+${Math.round((Date.now() - t0) / 1000)}s ${statuses} next=${state.preview.next ? new Date(state.preview.next.at).toISOString() : "-"}`);
  if (process.env.SNAP_DIR && i === 1) fs.writeFileSync(path.join(process.env.SNAP_DIR, "mid-queue.json"), JSON.stringify(state, null, 2));
  if (state.queue.every((e) => e.status === "posted" || e.status === "failed")) break;
}
const posted = state.queue.filter((e) => e.status === "posted").sort((a, b) => a.postedAt - b.postedAt);
check(posted.length === 3, `scheduler posted all 3 (dry run): ${state.queue.map((e) => `${e.title}=${e.status}`).join(", ")}`);
check(JSON.stringify(posted.map((e) => e.title)) === JSON.stringify(mediaIds.map((m) => m[1])), `posted in queue order: ${posted.map((e) => e.title).join(" → ")}`);
const gaps = posted.slice(1).map((e, i) => Math.round((e.postedAt - posted[i].postedAt) / 1000));
check(gaps.every((g) => g >= 115), `spacing ≥ 2 min between posts (gaps ${gaps.join("s, ")}s)`);
check(posted.every((e) => e.dryRun === true), "every post flagged dry run");
const hist = (await rpc("content-studio.posting.history", { pageId: page.id, limit: 200 })).history;
const dryEvents = hist.filter((h) => h.event === "dry_run");
check(dryEvents.length === 3, `history has 3 dry-run completions`);
const steps = dryEvents[0]?.meta?.steps ?? [];
for (const s of ["verify_account", "push_media", "open_composer", "type_caption", "publish_button", "dry_run_stop"]) {
  check(steps.some((x) => x.startsWith(`✓ ${s}`)), `device flow step ${s} ran`);
}
check(!steps.some((x) => x.includes("tap_publish")), "flow never tapped Share");
let s1 = social();
check(s1.published.length === 0, `fake Instagram published NOTHING (published=${s1.published.length})`);
check(s1.shares.length === 3 && s1.files.length === 3, `3 videos pushed + opened in the composer (shares=${s1.shares.length}, pushes=${s1.files.length})`);
check(s1.instagram.posts["brand.co"] === 41, "post count unchanged (41)");
const adb = fs.readFileSync(ADB_LOG, "utf8").trim().split("\n").filter(Boolean);
check(adb.length > 20, `${adb.length} adb invocations, all through the fake adb (FAKE_ADB_LOG)`);
const typed = adb.map((l) => JSON.parse(l)).filter((a) => a[3] === "input" && a[4] === "text").map((a) => a[5]);
check(typed.some((t) => t.includes("#brand%s#reels")), `caption typed incl. quoted hashtags (${typed.slice(0, 4).join(" | ")})`);

// ── wrong-account refusal ──────────────────────────────────────────────────
setSocial({ instagram: { ...social().instagram, active: "someone.else", accounts: ["someone.else"] } });
const wrong = (await rpc("content-studio.posting.enqueue", { pageId: page.id, mediaId: mediaIds[0][0], title: "Wrong account probe" })).entries[0];
// post-now honours the minimum interval: wait it out, then the phone check runs.
let pn;
for (let i = 0; i < 20; i++) {
  pn = await rpc("content-studio.posting.postNow", { entryId: wrong.id }, 180_000);
  if (!/min interval/.test(pn.report?.reason ?? "")) break;
  if (i === 0) pass(`post now first refused by the min interval: ${pn.report.reason}`);
  await sleep(15_000);
}
check(pn.entry.status === "failed" && /wrong account/i.test(pn.entry.lastError ?? ""), `wrong account refused: ${pn.entry.lastError}`);
const afterWrong = await rpc("content-studio.posting.get", { pageId: page.id });
check(afterWrong.config.enabled === false, "page auto-posting switched off after the wrong-account refusal");
s1 = social();
check(s1.published.length === 0 && s1.shares.length === 3, "nothing shared or published from @someone.else");

// ── approval-required mode waits ───────────────────────────────────────────
setSocial({ instagram: { ...social().instagram, active: "brand.co", accounts: ["brand.co", "brand.backup"] } });
await rpc("content-studio.posting.configure", { pageId: page.id, requireApproval: true, enabled: true });
const ap = (await rpc("content-studio.posting.enqueue", { pageId: page.id, mediaId: mediaIds[1][0], title: "Needs approval" })).entries[0];
let apEntry;
for (let i = 0; i < 40; i++) {
  await sleep(5000);
  apEntry = (await rpc("content-studio.posting.get", { pageId: page.id })).queue.find((e) => e.id === ap.id);
  if (apEntry.status === "awaiting_approval") break;
}
check(apEntry.status === "awaiting_approval" && apEntry.approvalId, `entry waits for approval (${apEntry.approvalId})`);
const pending = await rpc("approvals.list", { status: "pending" });
const rec = (pending.approvals ?? pending.items ?? pending).find?.((a) => a.id === apEntry.approvalId);
check(Boolean(rec), `approval is in the inbox: "${rec?.title}"`);
const sharesBefore = social().shares.length;
await sleep(35_000);
apEntry = (await rpc("content-studio.posting.get", { pageId: page.id })).queue.find((e) => e.id === ap.id);
check(apEntry.status === "awaiting_approval" && social().shares.length === sharesBefore, "still waiting 35s later — nothing ran on the phone without approval");
if (process.env.SNAP_DIR) {
  // Pause here so screenshots can capture the "needs approval" state.
  fs.writeFileSync(path.join(process.env.SNAP_DIR, "awaiting.json"), JSON.stringify({ pageId: page.id }, null, 2));
  const go = path.join(process.env.SNAP_DIR, "continue");
  for (let i = 0; i < 60 && !fs.existsSync(go); i++) await sleep(5000);
  fs.rmSync(go, { force: true });
}
if (process.env.HOLD_APPROVAL !== "1") {
  await rpc("approvals.resolve", { id: apEntry.approvalId, action: "approve", by: "e2e-owner" });
  for (let i = 0; i < 30; i++) {
    await sleep(5000);
    apEntry = (await rpc("content-studio.posting.get", { pageId: page.id })).queue.find((e) => e.id === ap.id);
    if (apEntry.status === "posted" || apEntry.status === "failed") break;
  }
  check(apEntry.status === "posted" && apEntry.dryRun, `after approval it ran (dry run) → ${apEntry.status}`);
  const apHist = (await rpc("content-studio.posting.history", { pageId: page.id })).history.find((h) => h.entryId === ap.id && h.event === "posting");
  check(/approval:/.test(apHist?.message ?? ""), `posting authorised by the approval: ${apHist?.message}`);
}
check(social().published.length === 0, "end of run: fake Instagram published list still empty");

// ── agent chat turn (optional: needs a model key) ─────────────────────────
if (process.env.AGENT_TURN === "1") {
  const sessionKey = "agent:main:cpq-e2e";
  const msg =
    `Use the content_posting tool. On content page ${page.id}: queue the video with mediaId ${mediaIds[2][0]} ` +
    `(title "Agent queued clip") for instagram, then set the posting frequency to every 3 hours, ` +
    `09:00-21:00 Asia/Bangkok with 10 minutes jitter. Reply with the queue entry id.`;
  try {
    const res = await rpc(
      "agent",
      { message: msg, agentId: "main", sessionKey, deliver: false, channel: "webchat", timeout: 240, idempotencyKey: `cpq-e2e-${Date.now()}` },
      300_000,
      true,
    );
    fs.writeFileSync(path.join(DIR, "agent-turn.json"), JSON.stringify(res, null, 2));
  } catch (e) {
    fail(`agent turn errored: ${e.message}`);
  }
  const after = await rpc("content-studio.posting.get", { pageId: page.id });
  const agentEntry = after.queue.find((e) => e.title === "Agent queued clip");
  check(Boolean(agentEntry), `agent queued a video via content_posting (${agentEntry?.id})`);
  check(after.config.schedule.mode === "interval" && after.config.schedule.everyMinutes === 180 && after.config.schedule.timezone === "Asia/Bangkok", `agent set frequency: ${after.effective.summary}`);
  const agentHist = after.history.find((h) => h.event === "configured" && /agent:/.test(JSON.stringify(h.meta)));
  check(Boolean(agentHist), `history attributes the change to the agent (${agentHist?.meta?.actor})`);
}

fs.writeFileSync(path.join(DIR, "info.json"), JSON.stringify({ port: PORT, token: TOKEN, pid: gw.pid, dir: DIR, pageId: page.id, deviceId: dev.id }, null, 2));
check(fingerprint(HOST_DEVICE_AUTH) === hostDeviceAuthBefore, "host ~/.infinibot/identity/device-auth.json tokens untouched by this run");
console.log(`SUMMARY pass=${passes} fail=${fails} (page ${page.id}; gateway :${PORT}${process.env.KEEP === "1" ? " kept" : ""})`);
if (process.env.KEEP !== "1") stopOurs();
process.exit(fails ? 1 : 0);
