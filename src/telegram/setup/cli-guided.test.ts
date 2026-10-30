import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  startMockTelegramBotApi,
  type MockTelegram,
} from "../../../test/helpers/mock-telegram-bot-api.js";
import type { WizardPrompter } from "../../wizard/prompts.js";
import { createGrammySetupApi } from "./bot-api.js";
import { runGuidedTelegramSetup } from "./cli-guided.js";
import { TelegramSetupManager } from "./sessions.js";

const TOKEN = "7123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw1";
let mock: MockTelegram;
let prevRoot: string | undefined;

beforeAll(async () => {
  mock = await startMockTelegramBotApi({
    bots: [{ token: TOKEN, id: 7123456789, username: "cli_bot", first_name: "CLI" }],
    maxHoldMs: 200,
  });
  prevRoot = process.env.INFINIBOT_TELEGRAM_API_ROOT;
  process.env.INFINIBOT_TELEGRAM_API_ROOT = mock.url;
});
afterAll(async () => {
  await mock.close();
  if (prevRoot === undefined) delete process.env.INFINIBOT_TELEGRAM_API_ROOT;
  else process.env.INFINIBOT_TELEGRAM_API_ROOT = prevRoot;
});

/** Scripted prompter: answers selects/confirms/texts in order and records notes. */
function scripted(answers: unknown[]) {
  const notes: string[] = [];
  const queue = [...answers];
  const next = () => {
    if (!queue.length) throw new Error("prompter ran out of answers");
    return queue.shift();
  };
  const prompter: WizardPrompter = {
    intro: async () => {},
    outro: async () => {},
    note: async (m) => {
      notes.push(m);
    },
    select: async () => next() as never,
    multiselect: async () => next() as never,
    text: async () => String(next()),
    confirm: async () => Boolean(next()),
    progress: (label) => {
      notes.push(label);
      return { update: () => {}, stop: (m) => m && notes.push(m) };
    },
  };
  return { prompter, notes };
}

const manager = () =>
  new TelegramSetupManager({
    createApi: (t) => createGrammySetupApi(t),
    pollTimeoutSec: 0,
    retryDelayMs: 50,
  });

describe("runGuidedTelegramSetup (CLI onboard)", () => {
  it("checks the token, finds the owner via /start, sets allowlist + defaultChatId and sends a test", async () => {
    const { prompter, notes } = scripted(["start", "allowlist", true]);
    const m = manager();
    let delivered = false;
    const r = await runGuidedTelegramSetup({
      prompter,
      cfg: { channels: { telegram: { botToken: TOKEN } } } as never,
      token: TOKEN,
      manager: m,
      pollMs: 50,
      sleep: async (ms) => {
        if (!delivered) {
          delivered = true;
          const link = notes.find((n) => n.includes("?start="))!;
          const code = /start=([A-Z0-9]+)/.exec(link)![1]!;
          await mock.message({
            token: TOKEN,
            text: `/start ${code}`,
            from: { id: 909090, username: "boss", first_name: "Bo" },
          });
        }
        await new Promise((res) => setTimeout(res, ms));
      },
    });
    m.dispose();
    expect(r.verified).toBe(true);
    expect(r.bot?.username).toBe("cli_bot");
    expect(r.owner?.userId).toBe(909090);
    expect(r.cfg.channels?.telegram).toMatchObject({
      enabled: true,
      botToken: TOKEN,
      dmPolicy: "allowlist",
      allowFrom: ["909090"],
      defaultChatId: "909090",
    });
    expect(r.tested).toBe(true);
    expect(mock.sent.some((s) => String(s.chat_id) === "909090")).toBe(true);
    expect(notes.join("\n")).toContain("Found you: Bo @boss");
  });

  it("falls back to a typed id, and 'open' adds the wildcard", async () => {
    await mock.message({ token: TOKEN, text: "hello", from: { id: 313131, username: "typed" } });
    const { prompter } = scripted(["manual", "313131", "open", false]);
    const m = manager();
    const r = await runGuidedTelegramSetup({
      prompter,
      cfg: {} as never,
      token: TOKEN,
      manager: m,
    });
    m.dispose();
    expect(r.cfg.channels?.telegram).toMatchObject({
      dmPolicy: "open",
      allowFrom: ["313131", "*"],
      defaultChatId: "313131",
    });
  });

  it("reports a bad token instead of saving it", async () => {
    const { prompter, notes } = scripted([]);
    const m = manager();
    const r = await runGuidedTelegramSetup({
      prompter,
      cfg: {} as never,
      token: "123:bad",
      manager: m,
    });
    m.dispose();
    expect(r.verified).toBe(false);
    expect(r.cfg).toEqual({});
    expect(notes.join(" ")).toMatch(/token/i);
  });

  it("skip leaves pairing on so strangers can't chat", async () => {
    const { prompter } = scripted(["skip"]);
    const m = manager();
    const r = await runGuidedTelegramSetup({
      prompter,
      cfg: {} as never,
      token: TOKEN,
      manager: m,
    });
    m.dispose();
    expect(r.owner).toBeNull();
    expect(r.cfg.channels?.telegram?.dmPolicy).toBe("pairing");
  });
});
