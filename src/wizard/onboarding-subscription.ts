/**
 * `infinibot onboard` — "Which of these do you already have?"
 *
 * The terminal twin of the onboarding "AI brain" step: pick ChatGPT, Grok, a
 * Google account (free) or Claude, and the wizard gets that account's app
 * ready (installs it without admin rights), opens its sign-in in the browser,
 * waits for it, sends one tiny test message and switches InfiniBot to it.
 * Same wording as the web/desktop step; no "API", "CLI" or "token" on the
 * default path. "Something else" falls through to the classic model/key menu.
 */

import type { InfinibotConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import { getCliProviderInfo, resolveCliRoutingOrder } from "../agents/cli-routing.js";
import {
  applyCliRoutingSet,
  cliRoutingAvailable,
  testCliProvider,
} from "../agents/cli-routing-setup.js";
import { getCoderEntry, type CoderId } from "../agents/coder-install/catalog.js";
import { startJob } from "../agents/coder-install/installer.js";
import {
  cancelLogin,
  pollLogin,
  startLogin,
  submitLoginCode,
} from "../agents/coder-install/login.js";
import { coderStatus, invalidateCoderStatus } from "../agents/coder-install/status.js";
import { openUrl } from "../commands/onboard-helpers.js";
import type { WizardPrompter } from "./prompts.js";

/** Card order on the brain step: Google is the free default. */
export const SUBSCRIPTION_CHOICES = ["codex-cli", "grok-cli", "gemini-cli", "claude-cli"] as const;

const OTHER = "__other";
const SIGN_IN_WAIT_MS = 10 * 60_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type SubscriptionDeps = {
  openUrl: (url: string) => Promise<boolean>;
  testCliProvider: typeof testCliProvider;
  pollMs: number;
};

const defaultDeps: SubscriptionDeps = { openUrl, testCliProvider, pollMs: 1500 };

async function ensureInstalled(
  coderId: CoderId,
  account: string,
  prompter: WizardPrompter,
): Promise<boolean> {
  const entry = getCoderEntry(coderId)!;
  if ((await coderStatus(entry)).installed) return true;
  const progress = prompter.progress(`Getting ${account} ready on this computer…`);
  const started = startJob(coderId, "install");
  if (!started.ok) {
    progress.stop(`Couldn't set up ${account} automatically: ${started.message}`);
    return false;
  }
  const job = await started.done;
  invalidateCoderStatus();
  if (!job.ok) {
    progress.stop(`Couldn't set up ${account}: ${job.error ?? "the download failed"}.`);
    return false;
  }
  progress.stop(`${account} is ready.`);
  return true;
}

async function ensureSignedIn(
  coderId: CoderId,
  account: string,
  prompter: WizardPrompter,
  deps: SubscriptionDeps,
): Promise<boolean> {
  const entry = getCoderEntry(coderId)!;
  invalidateCoderStatus();
  const auth = (await coderStatus(entry)).auth;
  if (auth === "signed-in") return true;
  const res = await startLogin(coderId);
  if (!res.ok) {
    await prompter.note(res.message, "Sign in");
    return false;
  }
  const sessionId = res.session.sessionId;
  const progress = prompter.progress("Opening the sign-in page…");
  let opened = false;
  let askedCode = false;
  const deadline = Date.now() + SIGN_IN_WAIT_MS;
  try {
    while (Date.now() < deadline) {
      const s = pollLogin(sessionId);
      if (!s) return false;
      if (s.url && !opened) {
        opened = true;
        const ok = await deps.openUrl(s.url);
        progress.stop(
          ok
            ? `Sign in with your ${account} account in the window that just opened, then come back here.`
            : `Open this page and sign in with your ${account} account:\n${s.url}`,
        );
        if (s.userCode)
          await prompter.note(`Enter this code on that page: ${s.userCode}`, "Sign in");
      }
      if (s.needsCode && !askedCode) {
        askedCode = true;
        const code = await prompter.text({
          message: "Paste the code the sign-in page showed you",
          validate: (v) => (v.trim() ? undefined : "Paste the code to continue"),
        });
        const sent = submitLoginCode(sessionId, code);
        if (!sent.ok) await prompter.note(sent.message ?? "That code didn't work.", "Sign in");
      }
      if (s.status === "succeeded") return true;
      if (s.status === "failed" || s.status === "expired" || s.status === "cancelled") {
        await prompter.note(s.error ?? "Sign-in didn't finish.", "Sign in");
        return false;
      }
      // Some CLIs finish sign-in without exiting: a credential is the signal.
      invalidateCoderStatus();
      if ((await coderStatus(entry)).auth === "signed-in") return true;
      await sleep(deps.pollMs);
    }
    await prompter.note("Sign-in timed out. You can try again from the app later.", "Sign in");
    return false;
  } finally {
    if (!opened) progress.stop();
    cancelLogin(sessionId);
  }
}

/**
 * Ask the beginner question. Returns the updated config when an account was
 * connected, or null when the user chose "Something else" or it didn't work
 * out (the caller then shows the classic model menu).
 */
export async function promptSubscriptionBrain(params: {
  config: InfinibotConfig;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  deps?: Partial<SubscriptionDeps>;
}): Promise<InfinibotConfig | null> {
  if (!cliRoutingAvailable()) return null;
  const deps = { ...defaultDeps, ...params.deps };
  const { prompter } = params;
  while (true) {
    const choice = await prompter.select<string>({
      message: "Which of these do you already have?",
      options: [
        ...SUBSCRIPTION_CHOICES.map((id) => {
          const info = getCliProviderInfo(id)!;
          return {
            value: id,
            label:
              info.id === "gemini-cli"
                ? `${info.account} (paid Google plan or Gemini key)`
                : info.free
                  ? `${info.account} (free)`
                  : info.account,
            hint:
              info.id === "gemini-cli"
                ? "Free Google accounts don't work here: needs a paid Google plan or a Gemini key"
                : info.free
                  ? "Recommended if you have none of these"
                  : info.signInLabel,
          };
        }),
        {
          value: OTHER,
          label: "Something else",
          hint: "Run a model on this computer, or use a key",
        },
      ],
      initialValue: "gemini-cli",
    });
    if (choice === OTHER) return null;
    const info = getCliProviderInfo(choice)!;
    const coderId = info.coderId as CoderId;
    if (!(await ensureInstalled(coderId, info.account, prompter))) {
      if (await retryOrOther(prompter)) continue;
      return null;
    }
    if (!(await ensureSignedIn(coderId, info.account, prompter, deps))) {
      if (await retryOrOther(prompter)) continue;
      return null;
    }
    const progress = prompter.progress("Connecting InfiniBot…");
    const test = await deps.testCliProvider(params.config, choice);
    if (!test.ok) {
      progress.stop(test.message);
      if (await retryOrOther(prompter)) continue;
      return null;
    }
    progress.stop(`Connected. ${info.account} says: "${test.reply.slice(0, 80)}"`);
    const order = resolveCliRoutingOrder(params.config).filter((id) => id !== choice);
    return applyCliRoutingSet(params.config, { enabled: true, providers: [choice, ...order] });
  }
}

async function retryOrOther(prompter: WizardPrompter): Promise<boolean> {
  const next = await prompter.select<string>({
    message: "What would you like to do?",
    options: [
      { value: "retry", label: "Pick an account again" },
      { value: "other", label: "Something else" },
    ],
  });
  return next === "retry";
}
