/**
 * ManyChat API key storage — `<stateDir>/secrets/manychat.json` (0600).
 *
 * Written only after ManyChat accepted the key (manychat.connect), so
 * "connected" in the UI always means a verified, stored key. Mirrors
 * instagram-secrets.ts.
 */

import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type ManyChatSecrets = {
  apiKey: string;
  accountName?: string;
  subscriberCount?: number;
  connectedAt?: number;
};

function secretsPath(): string {
  const stateDir =
    process.env.INFINIBOT_STATE_DIR ??
    process.env.MOLTBOT_STATE_DIR ??
    join(homedir(), ".infinibot");
  return join(stateDir, "secrets", "manychat.json");
}

export function readManyChatSecrets(): ManyChatSecrets | null {
  try {
    const parsed = JSON.parse(readFileSync(secretsPath(), "utf8")) as ManyChatSecrets;
    return typeof parsed?.apiKey === "string" && parsed.apiKey.trim() ? parsed : null;
  } catch {
    return null;
  }
}

export function writeManyChatSecrets(secrets: ManyChatSecrets): void {
  const file = secretsPath();
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify(secrets, null, 2), { encoding: "utf8", mode: 0o600 });
  chmodSync(file, 0o600);
}

export function deleteManyChatSecrets(): boolean {
  try {
    unlinkSync(secretsPath());
    return true;
  } catch {
    return false;
  }
}
