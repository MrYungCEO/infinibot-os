/**
 * Secure Mode master key, kept in the OS keyring.
 *
 * The master key (32 random bytes) never touches disk in the clear. It lives
 * in the desktop Secret Service (gnome-keyring / KWallet via libsecret) and is
 * looked up once per process. Providers are tried in order:
 *
 *   1. `secret-tool`  (libsecret-tools; `sudo apt install libsecret-tools`)
 *   2. python3 + GObject-introspection libsecret (`gir1.2-secret-1`), which is
 *      present on stock Ubuntu desktops even when secret-tool is not
 *   3. INFINIBOT_SECURE_MASTER_KEY  (base64 of 32 bytes; headless hosts, CI)
 *   4. a 0600 key file under <stateDir>/secure/ — ONLY when the owner opts in
 *      with INFINIBOT_SECURE_KEY_FALLBACK=file. This is the documented weak
 *      fallback: the key sits next to the data it protects.
 *
 * With none of these available Secure Mode refuses to enable (fail closed).
 * The keyring entry is keyed by a hash of the state dir, so a side gateway
 * with its own state dir gets its own key and cannot open the live lane.
 */

import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const KEYRING_SERVICE = "infinibot-secure-mode";

export type MasterKeySource = "secret-tool" | "libsecret-gi" | "env" | "file";

export type ExecFn = (
  cmd: string,
  args: string[],
  opts: { input?: string; timeoutMs?: number },
) => Promise<{ code: number; stdout: string; stderr: string }>;

export const defaultExec: ExecFn = (cmd, args, opts) =>
  new Promise((resolve) => {
    const child = execFile(
      cmd,
      args,
      { timeout: opts.timeoutMs ?? 10_000, encoding: "utf8", maxBuffer: 64 * 1024 },
      (err, stdout, stderr) => {
        const code =
          err && typeof (err as NodeJS.ErrnoException).code === "number"
            ? ((err as unknown as { code: number }).code as number)
            : err
              ? 127
              : 0;
        resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      },
    );
    if (opts.input !== undefined) {
      child.stdin?.end(opts.input);
    } else {
      child.stdin?.end();
    }
  });

export interface KeyringOptions {
  stateDir: string;
  env?: NodeJS.ProcessEnv;
  exec?: ExecFn;
}

export function keyringAccount(stateDir: string): string {
  return `state-${createHash("sha256").update(path.resolve(stateDir)).digest("hex").slice(0, 16)}`;
}

function decodeKey(b64: string | undefined): Buffer | null {
  const raw = b64?.trim();
  if (!raw) return null;
  const key = Buffer.from(raw, "base64");
  return key.length === 32 ? key : null;
}

interface Provider {
  source: MasterKeySource;
  lookup(): Promise<Buffer | null | "unavailable">;
  store(key: Buffer): Promise<boolean>;
}

const GI_SCRIPT = `
import sys
import gi
gi.require_version('Secret', '1')
from gi.repository import Secret
schema = Secret.Schema.new('org.infinibot.SecureMode', Secret.SchemaFlags.NONE,
  {'service': Secret.SchemaAttributeType.STRING, 'account': Secret.SchemaAttributeType.STRING})
attrs = {'service': sys.argv[2], 'account': sys.argv[3]}
if sys.argv[1] == 'lookup':
  v = Secret.password_lookup_sync(schema, attrs, None)
  if v: sys.stdout.write(v)
elif sys.argv[1] == 'store':
  ok = Secret.password_store_sync(schema, attrs, Secret.COLLECTION_DEFAULT, sys.argv[4], sys.stdin.read().strip(), None)
  sys.exit(0 if ok else 3)
elif sys.argv[1] == 'clear':
  Secret.password_clear_sync(schema, attrs, None)
`;

function providers(opts: KeyringOptions): Provider[] {
  const exec = opts.exec ?? defaultExec;
  const account = keyringAccount(opts.stateDir);
  const label = `InfiniBot Secure Mode master key (${account})`;
  const list: Provider[] = [
    {
      source: "secret-tool",
      async lookup() {
        const r = await exec(
          "secret-tool",
          ["lookup", "service", KEYRING_SERVICE, "account", account],
          {},
        );
        if (r.code === 127) return "unavailable";
        // secret-tool exits 1 with empty output when the item is missing.
        return decodeKey(r.stdout);
      },
      async store(key) {
        const r = await exec(
          "secret-tool",
          ["store", `--label=${label}`, "service", KEYRING_SERVICE, "account", account],
          { input: key.toString("base64") },
        );
        return r.code === 0;
      },
    },
    {
      source: "libsecret-gi",
      async lookup() {
        const r = await exec(
          "python3",
          ["-I", "-c", GI_SCRIPT, "lookup", KEYRING_SERVICE, account],
          {},
        );
        if (r.code !== 0) return "unavailable";
        return decodeKey(r.stdout);
      },
      async store(key) {
        const r = await exec(
          "python3",
          ["-I", "-c", GI_SCRIPT, "store", KEYRING_SERVICE, account, label],
          { input: key.toString("base64") },
        );
        return r.code === 0;
      },
    },
  ];
  return list;
}

export interface ResolvedMasterKey {
  key: Buffer;
  source: MasterKeySource;
  account: string;
  created: boolean;
}

export class SecureKeyUnavailableError extends Error {
  constructor(detail: string) {
    super(
      `Secure Mode needs a master key in the OS keyring and none is reachable (${detail}). ` +
        "Install libsecret-tools (secret-tool) or gir1.2-secret-1 with a running Secret Service, " +
        "or set INFINIBOT_SECURE_MASTER_KEY, or opt into the weak file fallback with INFINIBOT_SECURE_KEY_FALLBACK=file.",
    );
    this.name = "SecureKeyUnavailableError";
  }
}

function fileKeyPath(stateDir: string): string {
  return path.join(stateDir, "secure", "master.key");
}

/**
 * Find the master key, creating and storing a fresh one in the first working
 * keyring when none exists yet. `create: false` only looks.
 */
export async function resolveMasterKey(
  opts: KeyringOptions & { create?: boolean },
): Promise<ResolvedMasterKey> {
  const env = opts.env ?? process.env;
  const account = keyringAccount(opts.stateDir);
  const fromEnv = decodeKey(env.INFINIBOT_SECURE_MASTER_KEY);
  if (env.INFINIBOT_SECURE_MASTER_KEY && !fromEnv) {
    throw new SecureKeyUnavailableError("INFINIBOT_SECURE_MASTER_KEY is not base64 of 32 bytes");
  }
  if (fromEnv) return { key: fromEnv, source: "env", account, created: false };

  const reached: Provider[] = [];
  for (const p of providers(opts)) {
    const found = await p.lookup().catch(() => "unavailable" as const);
    if (found === "unavailable") continue;
    if (found) return { key: found, source: p.source, account, created: false };
    reached.push(p);
  }

  const fileFallback = env.INFINIBOT_SECURE_KEY_FALLBACK?.trim().toLowerCase() === "file";
  if (fileFallback) {
    const file = fileKeyPath(opts.stateDir);
    const existing = fs.existsSync(file) ? decodeKey(fs.readFileSync(file, "utf8")) : null;
    if (existing) return { key: existing, source: "file", account, created: false };
  }

  if (opts.create === false) {
    throw new SecureKeyUnavailableError("no key has been created yet");
  }
  const key = randomBytes(32);
  for (const p of reached) {
    if (await p.store(key).catch(() => false)) {
      // Read back so we never encrypt under a key the keyring did not keep.
      const check = await p.lookup().catch(() => null);
      if (check instanceof Buffer && check.equals(key)) {
        return { key, source: p.source, account, created: true };
      }
    }
  }
  if (fileFallback) {
    const file = fileKeyPath(opts.stateDir);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, key.toString("base64"), { mode: 0o600 });
    return { key, source: "file", account, created: true };
  }
  throw new SecureKeyUnavailableError(
    reached.length ? "the keyring refused to store a new key" : "no keyring provider responded",
  );
}

/** Remove this state dir's key from the keyring (tests / side gateways). */
export async function clearMasterKey(opts: KeyringOptions): Promise<void> {
  const exec = opts.exec ?? defaultExec;
  const account = keyringAccount(opts.stateDir);
  await exec("secret-tool", ["clear", "service", KEYRING_SERVICE, "account", account], {}).catch(
    () => {},
  );
  await exec("python3", ["-I", "-c", GI_SCRIPT, "clear", KEYRING_SERVICE, account], {}).catch(
    () => {},
  );
}
