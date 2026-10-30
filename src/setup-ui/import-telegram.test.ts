/**
 * Standalone quickstart (setup-ui): the Telegram step against a mock Bot API
 * and the "Import your notes" step (folder + ZIP upload), all inside a
 * throwaway state dir — never the real ~/.infinibot.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  startMockTelegramBotApi,
  type MockTelegram,
} from "../../test/helpers/mock-telegram-bot-api.js";
import { useBundledPlugins } from "../../test/helpers/bundled-plugins.js";

// Confirm writes the config, whose validation needs the default memory plugin.
useBundledPlugins();

const TOKEN = "7123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw1";
const VAULT = path.join(
  import.meta.dirname,
  "..",
  "documents",
  "obsidian",
  "__fixtures__",
  "vault",
);

let tmp: string;
let mock: MockTelegram;
const prevEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "INFINIBOT_STATE_DIR",
  "INFINIBOT_CONFIG_PATH",
  "INFINIBOT_TELEGRAM_API_ROOT",
  "HOME",
];

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "setup-ui-import-tg-"));
  for (const k of ENV_KEYS) prevEnv[k] = process.env[k];
  mock = await startMockTelegramBotApi({
    bots: [{ token: TOKEN, id: 7123456789, username: "ib_test_bot", first_name: "IB Test" }],
    maxHoldMs: 200,
  });
  process.env.HOME = tmp;
  process.env.INFINIBOT_STATE_DIR = path.join(tmp, "state");
  process.env.INFINIBOT_CONFIG_PATH = path.join(tmp, "state", "infinibot.json");
  process.env.INFINIBOT_TELEGRAM_API_ROOT = mock.url;
  fs.mkdirSync(path.join(tmp, "state"), { recursive: true });
  fs.writeFileSync(
    process.env.INFINIBOT_CONFIG_PATH,
    JSON.stringify({ gateway: { mode: "local" } }),
  );
});

afterAll(async () => {
  const { getTelegramSetupManager } = await import("../telegram/setup/index.js");
  getTelegramSetupManager().dispose();
  await mock.close();
  for (const k of ENV_KEYS) {
    if (prevEnv[k] === undefined) delete process.env[k];
    else process.env[k] = prevEnv[k];
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function call<T = Record<string, unknown>>(
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  const { dispatchSetupRpc } = await import("./dispatch.js");
  const r = await dispatchSetupRpc(method, params);
  if (!r.ok) throw new Error(`${method}: ${r.error.message}`);
  return r.data as T;
}

async function until<T>(fn: () => Promise<T | null | undefined>, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe("setup-ui Telegram step (mock Bot API)", () => {
  it("verifies the token, captures the owner via /start, saves allowlist + test message", async () => {
    const bad = await call<{ ok: boolean; error?: { code: string } }>("telegram.setup.verify", {
      token: "nope",
    });
    expect(bad.ok).toBe(false);

    const v = await call<{ ok: boolean; sessionId: string; bot: { username: string } }>(
      "telegram.setup.verify",
      { token: TOKEN },
    );
    expect(v.ok).toBe(true);
    expect(v.bot.username).toBe("ib_test_bot");
    expect(JSON.stringify(v)).not.toContain(TOKEN); // token never comes back

    const cap = await call<{
      ok: boolean;
      capture: { deepLink: string; code: string };
      qr?: string;
    }>("telegram.setup.capture.start", { sessionId: v.sessionId, mode: "dm" });
    expect(cap.ok).toBe(true);
    expect(cap.capture.deepLink).toBe(`https://t.me/ib_test_bot?start=${cap.capture.code}`);
    expect(cap.qr).toMatch(/^data:image\/png;base64,/);

    await mock.message({
      token: TOKEN,
      text: `/start ${cap.capture.code}`,
      from: { id: 424242, username: "owner", first_name: "Olive" },
    });
    const found = await until(async () => {
      const s = await call<{ capture: { status: string; found?: { userId: number } } }>(
        "telegram.setup.capture.status",
        { sessionId: v.sessionId },
      );
      return s.capture?.status === "found" ? s : null;
    });
    expect(found.capture.found?.userId).toBe(424242);

    const c = await call<{ ok: boolean; starting: string }>("telegram.setup.confirm", {
      sessionId: v.sessionId,
      makeDefault: true,
    });
    expect(c.ok).toBe(true);
    expect(c.starting).toBe("saved"); // no gateway in standalone setup
    await call("quickstart.applyPatch", {
      patch: { channels: { telegram: { enabled: true, dmPolicy: "allowlist" } } },
    });

    const cfg = JSON.parse(fs.readFileSync(process.env.INFINIBOT_CONFIG_PATH!, "utf-8"));
    expect(cfg.channels.telegram).toMatchObject({
      enabled: true,
      botToken: TOKEN,
      dmPolicy: "allowlist",
      allowFrom: ["424242"],
      defaultChatId: "424242",
    });
    expect(cfg.gateway).toEqual({ mode: "local" }); // the rest of the config is untouched

    const t = await call<{ ok: boolean }>("telegram.setup.test", { sessionId: v.sessionId });
    expect(t.ok).toBe(true);
    expect(
      mock.sent.some(
        (m) => String(m.chat_id) === "424242" && m.text.includes("InfiniBot is connected"),
      ),
    ).toBe(true);
  });

  it("accepts a typed user id checked with getChat", async () => {
    await mock.message({
      token: TOKEN,
      text: "hi",
      from: { id: 515151, username: "typed", first_name: "Ty" },
    });
    const v = await call<{ sessionId: string }>("telegram.setup.verify", { token: TOKEN });
    const m = await call<{ ok: boolean; capture: { status: string; found: { userId: number } } }>(
      "telegram.setup.manual",
      { sessionId: v.sessionId, mode: "dm", id: "515151" },
    );
    expect(m.ok).toBe(true);
    expect(m.capture.found.userId).toBe(515151);
  });
});

describe("setup-ui Import your notes step", () => {
  it("imports an Obsidian folder in the background and can undo it", async () => {
    const r = await call<{ jobId: string }>("documents.obsidian.import", {
      source: "folder",
      path: VAULT,
      createTasks: true,
    });
    const job = await until(async () => {
      const g = await call<{ job: { status: string } }>("documents.notion.jobs.get", {
        jobId: r.jobId,
      });
      return g.job.status === "done" || g.job.status === "failed" ? g.job : null;
    }, 20_000);
    expect((job as { error?: string }).error).toBeUndefined();
    expect(job).toMatchObject({ status: "done", details: { notes: 4, tasks: { created: 4 } } });
    const docsIndex = JSON.parse(
      fs.readFileSync(path.join(tmp, "state", "documents", "index.json"), "utf-8"),
    );
    const titles = Object.values(docsIndex.nodes as Record<string, { title: string }>).map(
      (n) => n.title,
    );
    expect(titles).toEqual(
      expect.arrayContaining(["vault", "Home", "Alpha", "Beta", "2026-10-07"]),
    );
    // Tasks landed in the throwaway kanban db.
    const { getKanbanStore } = await import("../tasks/store.js");
    const tasks = await getKanbanStore(path.join(tmp, "state")).getTasks();
    expect(tasks.map((t) => t.title)).toEqual(
      expect.arrayContaining(["Pay rent", "Ship alpha v1"]),
    );

    const u = await call<{ job: { undoneAt?: string; undoReport: { entitiesDeleted: number } } }>(
      "documents.import.undo",
      { jobId: r.jobId },
    );
    expect(u.job.undoneAt).toBeTruthy();
    expect(u.job.undoReport.entitiesDeleted).toBe(5);
    expect((await getKanbanStore(path.join(tmp, "state")).getTasks()).length).toBe(0);
  });

  it("accepts a vault ZIP on /api/upload (token-gated)", async () => {
    const { startSetupUiServer } = await import("./server.js");
    const srv = await startSetupUiServer({ port: 0, token: "t0k", log: () => {} });
    try {
      const zip = new JSZip();
      zip.file("Zipped/Note.md", "# Note\nSee [[Other]].\n");
      zip.file("Zipped/Other.md", "Other note");
      const body = await zip.generateAsync({ type: "nodebuffer" });
      const base = `http://127.0.0.1:${srv.port}/api/upload?mode=obsidian-zip&name=Zipped.zip`;
      const denied = await fetch(base, { method: "POST", body });
      expect(denied.status).toBe(401);
      const notZip = await fetch(`${base}&token=t0k`, {
        method: "POST",
        body: Buffer.from("hello"),
      });
      expect(notZip.status).toBe(400);
      const res = await fetch(`${base}&token=t0k`, { method: "POST", body });
      expect(res.status).toBe(202);
      const j = (await res.json()) as { data: { jobId: string } };
      const job = await until(async () => {
        const g = await call<{ job: { status: string } }>("documents.notion.jobs.get", {
          jobId: j.data.jobId,
        });
        return g.job.status === "done" ? g.job : null;
      });
      expect(job).toMatchObject({
        kind: "obsidian",
        label: "Zipped",
        details: { notes: 2, links: { resolved: 1 } },
      });
    } finally {
      await srv.stop();
    }
  });

  it("keeps non-allowlisted documents methods out of the setup server", async () => {
    const { dispatchSetupRpc } = await import("./dispatch.js");
    const r = await dispatchSetupRpc("documents.purge", { id: "x" });
    expect(r.ok).toBe(false);
  });
});
