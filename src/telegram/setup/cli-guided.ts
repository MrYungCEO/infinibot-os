/**
 * Guided Telegram setup for the terminal (`infinibot onboard`).
 *
 * Same flow and code as Setup › Channels, the quickstart page and cloud
 * onboarding (TelegramSetupManager): the token is checked with getMe, the
 * owner is found from a `t.me/<bot>?start=<code>` message (or a typed id
 * checked with getChat), the result is written with the shared
 * `applyTelegramSetupToConfig`, plus a DM policy and an optional test message.
 *
 * Pure with respect to config: it returns the next config object; the wizard
 * writes it with everything else at the end.
 */
import type { InfinibotConfig } from "../../config/config.js";
import type { DmPolicy } from "../../config/types.js";
import type { WizardPrompter } from "../../wizard/prompts.js";
import { applyTelegramSetupToConfig } from "./config-fill.js";
import type { TelegramSetupManager } from "./sessions.js";
import type { CapturedChat } from "./start-code.js";

const SCOPE = "cli-onboard";

export interface GuidedTelegramResult {
  cfg: InfinibotConfig;
  verified: boolean;
  bot: { username: string | null; name: string | null } | null;
  owner: CapturedChat | null;
  dmPolicy: DmPolicy | null;
  tested: boolean;
  /** Set when the token failed getMe (caller may ask for another token). */
  error?: string;
}

export interface GuidedTelegramOptions {
  prompter: WizardPrompter;
  cfg: InfinibotConfig;
  token: string;
  manager: TelegramSetupManager;
  /** Poll interval while waiting for /start (ms). */
  pollMs?: number;
  /** Give up waiting after this long (ms); defaults to the capture TTL. */
  waitMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function who(c: CapturedChat): string {
  const name = [c.firstName, c.username ? `@${c.username}` : null].filter(Boolean).join(" ");
  return `${name || "you"} (id ${c.userId ?? c.chatId})`;
}

export async function runGuidedTelegramSetup(
  opts: GuidedTelegramOptions,
): Promise<GuidedTelegramResult> {
  const { prompter, manager } = opts;
  const sleep = opts.sleep ?? defaultSleep;
  const out: GuidedTelegramResult = {
    cfg: opts.cfg,
    verified: false,
    bot: null,
    owner: null,
    dmPolicy: null,
    tested: false,
  };

  const spin = prompter.progress("Checking the bot token with Telegram…");
  const verified = await manager.verify(SCOPE, { token: opts.token, source: "pasted" });
  if (!verified.ok) {
    spin.stop("Token check failed");
    out.error = `${verified.error.title}: ${verified.error.message}${verified.error.fix ? ` — ${verified.error.fix}` : ""}`;
    await prompter.note(out.error, "Telegram");
    return out;
  }
  const session = verified.value;
  out.verified = true;
  out.bot = { username: session.bot.username, name: session.bot.name };
  const botLabel = session.bot.username ? `@${session.bot.username}` : "your bot";
  spin.stop(`Token works — ${botLabel}${session.bot.name ? ` (${session.bot.name})` : ""}`);
  out.cfg = applyTelegramSetupToConfig(out.cfg, { botUsername: session.bot.username });

  try {
    if (session.webhookHost) {
      const drop = await prompter.confirm({
        message: `Another app (${session.webhookHost}) is connected to ${botLabel}. Disconnect it so InfiniBot can use the bot?`,
        initialValue: true,
      });
      if (drop) {
        const r = await manager.deleteWebhook(SCOPE, session.sessionId);
        if (!r.ok) await prompter.note(r.error.message, "Telegram");
      }
    }

    const how = await prompter.select({
      message: `Link your Telegram account to ${botLabel} (so only you can chat with it)`,
      options: [
        { value: "start", label: "Send /start to the bot", hint: "automatic — recommended" },
        { value: "manual", label: "Type my Telegram user id", hint: "from @userinfobot" },
        { value: "skip", label: "Skip for now", hint: "new people get a pairing code" },
      ],
      initialValue: "start",
    });

    if (how === "start") {
      const started = await manager.startCapture(SCOPE, session.sessionId, "dm");
      if (!started.ok) {
        await prompter.note(`${started.error.title}: ${started.error.message}`, "Telegram");
      } else {
        const link =
          started.value.capture?.deepLink ?? `https://t.me/${session.bot.username ?? ""}`;
        await prompter.note(
          [
            `1) Open ${link}`,
            "2) Press Start in Telegram",
            "3) Come back here — it continues by itself",
          ].join("\n"),
          "Find you on Telegram",
        );
        const wait = prompter.progress(`Waiting for your /start message to ${botLabel}…`);
        const deadline = Date.now() + (opts.waitMs ?? 5 * 60_000);
        let status = "waiting";
        while (Date.now() < deadline) {
          const v = manager.get(SCOPE, session.sessionId);
          status = v.ok ? (v.value.capture?.status ?? "cancelled") : "expired";
          if (status !== "waiting") break;
          await sleep(opts.pollMs ?? 1500);
        }
        if (status === "found") {
          const c = manager.confirm(SCOPE, session.sessionId);
          if (c.ok) {
            out.owner = c.value.found;
            wait.stop(`Found you: ${who(c.value.found)}`);
          } else wait.stop("Couldn't confirm the account");
        } else {
          manager.cancelCapture(SCOPE, session.sessionId);
          wait.stop(
            status === "waiting" || status === "expired"
              ? "Timed out waiting for /start"
              : "Couldn't read the message",
          );
        }
      }
    }
    if (how === "manual" || (how === "start" && !out.owner)) {
      const typed = String(
        await prompter.text({
          message: "Your Telegram user id (numbers only — leave empty to skip)",
          placeholder: "123456789",
        }),
      ).trim();
      if (typed) {
        const m = await manager.manual(SCOPE, session.sessionId, { mode: "dm", id: typed });
        if (!m.ok) await prompter.note(`${m.error.title}: ${m.error.message}`, "Telegram");
        else {
          const c = manager.confirm(SCOPE, session.sessionId);
          if (c.ok) out.owner = c.value.found;
        }
      }
    }

    if (out.owner && out.owner.userId !== null) {
      out.cfg = applyTelegramSetupToConfig(out.cfg, {
        owner: { userId: out.owner.userId, chatId: out.owner.chatId },
      });
      const policy = (await prompter.select({
        message: "Who can message your bot?",
        options: [
          { value: "allowlist", label: "Only me", hint: "recommended" },
          { value: "pairing", label: "Me + people I approve", hint: "pairing code" },
          { value: "open", label: "Anyone", hint: "uses your AI credits" },
        ],
        initialValue: "allowlist",
      })) as DmPolicy;
      out.dmPolicy = policy;
      const tg = out.cfg.channels?.telegram ?? {};
      const allowFrom =
        policy === "open" ? [...new Set([...(tg.allowFrom ?? []).map(String), "*"])] : tg.allowFrom;
      out.cfg = {
        ...out.cfg,
        channels: {
          ...out.cfg.channels,
          telegram: { ...tg, dmPolicy: policy, ...(allowFrom ? { allowFrom } : {}) },
        },
      };
      const test = await prompter.confirm({
        message: "Send yourself a test message now?",
        initialValue: true,
      });
      if (test) {
        const t = await manager.sendTest(SCOPE, session.sessionId, out.owner.chatId);
        out.tested = t.ok;
        await prompter.note(
          t.ok
            ? "Sent “✅ InfiniBot is connected” — check Telegram."
            : `${t.error.title}: ${t.error.message}`,
          "Telegram",
        );
      }
    } else {
      // No owner: keep strangers out until a code is approved.
      const tg = out.cfg.channels?.telegram ?? {};
      out.dmPolicy = (tg.dmPolicy as DmPolicy | undefined) ?? "pairing";
      out.cfg = {
        ...out.cfg,
        channels: { ...out.cfg.channels, telegram: { ...tg, dmPolicy: out.dmPolicy } },
      };
    }
  } finally {
    manager.close(SCOPE, session.sessionId);
  }
  return out;
}
