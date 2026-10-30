import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  agentSecretRef,
  deleteAgentSecret,
  getAgentSecret,
  hasAgentSecret,
  isAgentSecretRef,
  setAgentSecret,
  TELEGRAM_BOT_TOKEN_KEY,
} from "./agent-secret-store.js";

function freshStateDir(): string {
  return mkdtempSync(join(tmpdir(), "agent-secrets-"));
}

describe("agent secret store", () => {
  it("builds canonical references", () => {
    expect(agentSecretRef("Main", TELEGRAM_BOT_TOKEN_KEY)).toBe(
      "vault://agents/main/telegram-bot-token",
    );
    expect(isAgentSecretRef("vault://agents/main/telegram-bot-token")).toBe(true);
    expect(isAgentSecretRef("vault://other/x")).toBe(false);
    expect(isAgentSecretRef(undefined)).toBe(false);
  });

  it("round-trips a token through encryption and never persists plaintext", () => {
    const stateDir = freshStateDir();
    const ref = agentSecretRef("main", TELEGRAM_BOT_TOKEN_KEY);
    const token = "7654321:AAExampleTelegramBotToken";

    expect(hasAgentSecret(ref, { stateDir })).toBe(false);
    expect(getAgentSecret(ref, { stateDir })).toBeNull();

    setAgentSecret(ref, token, { stateDir });

    expect(hasAgentSecret(ref, { stateDir })).toBe(true);
    expect(getAgentSecret(ref, { stateDir })).toBe(token);

    // On-disk blob must be ciphertext, not the raw token.
    const onDisk = readFileSync(join(stateDir, "agent-secrets.json"), "utf8");
    expect(onDisk).not.toContain(token);
    expect(onDisk).toContain(ref);
  });

  it("clears a secret via empty plaintext or delete", () => {
    const stateDir = freshStateDir();
    const ref = agentSecretRef("worker", TELEGRAM_BOT_TOKEN_KEY);

    setAgentSecret(ref, "abc", { stateDir });
    expect(getAgentSecret(ref, { stateDir })).toBe("abc");

    setAgentSecret(ref, "", { stateDir });
    expect(hasAgentSecret(ref, { stateDir })).toBe(false);

    setAgentSecret(ref, "def", { stateDir });
    deleteAgentSecret(ref, { stateDir });
    expect(getAgentSecret(ref, { stateDir })).toBeNull();
  });

  it("isolates secrets per agent reference", () => {
    const stateDir = freshStateDir();
    const a = agentSecretRef("alpha", TELEGRAM_BOT_TOKEN_KEY);
    const b = agentSecretRef("beta", TELEGRAM_BOT_TOKEN_KEY);
    setAgentSecret(a, "token-a", { stateDir });
    setAgentSecret(b, "token-b", { stateDir });
    expect(getAgentSecret(a, { stateDir })).toBe("token-a");
    expect(getAgentSecret(b, { stateDir })).toBe("token-b");
  });
});
