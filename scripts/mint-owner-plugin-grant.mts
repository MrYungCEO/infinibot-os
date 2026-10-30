/**
 * Mint the owner/admin plugin grant for THIS machine and write it into the
 * InfiniBot state dir (see src/plugins/entitlements/owner-grant.ts).
 *
 * Needs the KinglyVault licence PRIVATE key (fingerprint 360c5ff5…), which
 * only the owner has: KinglyVault `.env` KINGLYVAULT_LICENSE_PRIVATE_KEY. The
 * key is read from a file and never printed or stored by this script.
 *
 *   node --import tsx scripts/mint-owner-plugin-grant.mts \
 *     --kv-env ~/Desktop/KinglyVault-main/.env \
 *     [--state-dir ~/.infinibot] [--years 5] [--sub owner] [--plugins "*"] \
 *     [--machine-id <id>]   # mint for another of YOUR machines (its /etc/machine-id)
 *     [--out <file>]        # write somewhere else instead of the state dir
 *
 * Takes effect at the next gateway restart (the loader reads it at boot).
 */
import { createPrivateKey, createPublicKey, createHash, createSign, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KINGLYVAULT_PUBLIC_KEY_SHA256 } from "../src/plugins/entitlements/kinglyvault-key.js";
import {
  OWNER_GRANT_AUDIENCE,
  OWNER_GRANT_SOURCE,
  ownerGrantStateOf,
  ownerMachineHash,
  __setOwnerGrantMachineIdForTests,
} from "../src/plugins/entitlements/owner-grant.js";

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const expand = (p: string) => (p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p);

function readPrivateKey(): string {
  const keyFile = arg("--key-file");
  if (keyFile) return fs.readFileSync(expand(keyFile), "utf8");
  const envFile = arg("--kv-env");
  if (!envFile) throw new Error("pass --kv-env <KinglyVault .env> or --key-file <pem>");
  const text = fs.readFileSync(expand(envFile), "utf8");
  const m = /^KINGLYVAULT_LICENSE_PRIVATE_KEY=(.*)$/m.exec(text);
  if (!m) throw new Error(`KINGLYVAULT_LICENSE_PRIVATE_KEY not found in ${envFile}`);
  return m[1]
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/\\n/g, "\n");
}

const pem = readPrivateKey();
const key = createPrivateKey(pem);
const fp = createHash("sha256")
  .update(createPublicKey(key).export({ type: "spki", format: "der" }))
  .digest("hex");
if (fp !== KINGLYVAULT_PUBLIC_KEY_SHA256) {
  throw new Error(`private key fingerprint ${fp.slice(0, 12)}… is not the KinglyVault licence key`);
}

const machineId = arg("--machine-id");
if (machineId) __setOwnerGrantMachineIdForTests(machineId.trim());
const machine = ownerMachineHash();
if (!machine) throw new Error("could not read this machine's id; pass --machine-id");

const now = Math.floor(Date.now() / 1000);
const years = Number(arg("--years") ?? 5);
const plugins = (arg("--plugins") ?? "*")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const claims = {
  iss: "kinglyvault",
  aud: OWNER_GRANT_AUDIENCE,
  sub: arg("--sub") ?? "owner",
  role: "owner",
  machine,
  iat: now,
  exp: now + Math.round(years * 365 * 86400),
  jti: randomUUID(),
  ent: plugins.map((p) => ({ p, src: OWNER_GRANT_SOURCE, until: null })),
};
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const head = `${b64({ alg: "RS256", typ: "JWT" })}.${b64(claims)}`;
const signer = createSign("RSA-SHA256");
signer.update(head);
const token = `${head}.${signer.sign(key).toString("base64url")}`;

const check = ownerGrantStateOf(token);
if (check.state !== "valid") throw new Error(`minted grant does not verify here: ${check.state}`);

const stateDir = expand(arg("--state-dir") ?? process.env.INFINIBOT_STATE_DIR ?? "~/.infinibot");
const out = expand(arg("--out") ?? path.join(stateDir, "plugin-owner-grant.json"));
fs.mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 });
fs.writeFileSync(out, `${JSON.stringify({ version: 1, token }, null, 2)}\n`, { mode: 0o600 });
fs.chmodSync(out, 0o600);
console.log(
  JSON.stringify({
    wrote: out,
    sub: claims.sub,
    plugins,
    machine: `${machine.slice(0, 12)}…`,
    expires: new Date(claims.exp * 1000).toISOString(),
  }),
);
