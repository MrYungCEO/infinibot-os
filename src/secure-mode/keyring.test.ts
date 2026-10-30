import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  clearMasterKey,
  type ExecFn,
  KEYRING_SERVICE,
  keyringAccount,
  resolveMasterKey,
  SecureKeyUnavailableError,
} from "./keyring.js";

const dirs: string[] = [];
function stateDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "ib-secure-key-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** A fake Secret Service reachable through `secret-tool` only. */
function fakeSecretTool() {
  const items = new Map<string, string>();
  const calls: string[][] = [];
  const exec: ExecFn = async (cmd, args, opts) => {
    calls.push([cmd, ...args]);
    if (cmd !== "secret-tool") return { code: 127, stdout: "", stderr: "not found" };
    const attr = (k: string) => args[args.indexOf(k) + 1];
    const id = `${attr("service")}|${attr("account")}`;
    if (args[0] === "lookup") {
      const v = items.get(id);
      return v ? { code: 0, stdout: v, stderr: "" } : { code: 1, stdout: "", stderr: "" };
    }
    if (args[0] === "store") {
      items.set(id, String(opts.input ?? "").trim());
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "clear") {
      items.delete(id);
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 2, stdout: "", stderr: "" };
  };
  return { exec, items, calls };
}

describe("Secure Mode master key (OS keyring)", () => {
  it("reads an existing key from the keyring via secret-tool", async () => {
    const dir = stateDir();
    const kr = fakeSecretTool();
    const key = randomBytes(32);
    kr.items.set(`${KEYRING_SERVICE}|${keyringAccount(dir)}`, key.toString("base64"));
    const res = await resolveMasterKey({ stateDir: dir, env: {}, exec: kr.exec });
    expect(res.source).toBe("secret-tool");
    expect(res.created).toBe(false);
    expect(res.key.equals(key)).toBe(true);
    expect(kr.calls[0]).toEqual(["secret-tool", "lookup", "service", KEYRING_SERVICE, "account", keyringAccount(dir)]);
  });

  it("creates a key in the keyring on first use and never writes it to disk", async () => {
    const dir = stateDir();
    const kr = fakeSecretTool();
    const first = await resolveMasterKey({ stateDir: dir, env: {}, exec: kr.exec });
    expect(first.created).toBe(true);
    expect(first.source).toBe("secret-tool");
    expect(kr.items.size).toBe(1);
    const again = await resolveMasterKey({ stateDir: dir, env: {}, exec: kr.exec });
    expect(again.created).toBe(false);
    expect(again.key.equals(first.key)).toBe(true);
    // nothing in the state dir
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("separate state dirs get separate keyring entries", () => {
    expect(keyringAccount("/tmp/a")).not.toBe(keyringAccount("/tmp/b"));
  });

  it("falls back to libsecret through python-gi when secret-tool is missing", async () => {
    const dir = stateDir();
    const key = randomBytes(32);
    const exec: ExecFn = async (cmd, args) => {
      if (cmd === "secret-tool") return { code: 127, stdout: "", stderr: "" };
      if (cmd === "python3" && args.includes("lookup")) return { code: 0, stdout: key.toString("base64"), stderr: "" };
      return { code: 1, stdout: "", stderr: "" };
    };
    const res = await resolveMasterKey({ stateDir: dir, env: {}, exec });
    expect(res.source).toBe("libsecret-gi");
    expect(res.key.equals(key)).toBe(true);
  });

  it("fails closed when no keyring is reachable and no fallback is opted in", async () => {
    const exec: ExecFn = async () => ({ code: 127, stdout: "", stderr: "" });
    await expect(resolveMasterKey({ stateDir: stateDir(), env: {}, exec })).rejects.toBeInstanceOf(
      SecureKeyUnavailableError,
    );
  });

  it("only uses the weak file fallback when explicitly opted in", async () => {
    const dir = stateDir();
    const exec: ExecFn = async () => ({ code: 127, stdout: "", stderr: "" });
    const res = await resolveMasterKey({ stateDir: dir, env: { INFINIBOT_SECURE_KEY_FALLBACK: "file" }, exec });
    expect(res.source).toBe("file");
    const file = path.join(dir, "secure", "master.key");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("accepts INFINIBOT_SECURE_MASTER_KEY and rejects a malformed one", async () => {
    const key = randomBytes(32);
    const exec: ExecFn = async () => ({ code: 127, stdout: "", stderr: "" });
    const ok = await resolveMasterKey({ stateDir: stateDir(), env: { INFINIBOT_SECURE_MASTER_KEY: key.toString("base64") }, exec });
    expect(ok.source).toBe("env");
    await expect(
      resolveMasterKey({ stateDir: stateDir(), env: { INFINIBOT_SECURE_MASTER_KEY: "short" }, exec }),
    ).rejects.toBeInstanceOf(SecureKeyUnavailableError);
  });

  // Real desktop keyring (gnome-keyring via libsecret). Opt-in because it
  // writes to the user's login keyring; the entry is removed afterwards.
  it.runIf(process.env.INFINIBOT_TEST_REAL_KEYRING === "1")(
    "stores and reads the key in the real OS keyring",
    async () => {
      const dir = stateDir();
      try {
        const first = await resolveMasterKey({ stateDir: dir, env: { ...process.env, INFINIBOT_SECURE_MASTER_KEY: "" } });
        expect(["secret-tool", "libsecret-gi"]).toContain(first.source);
        expect(first.created).toBe(true);
        const again = await resolveMasterKey({ stateDir: dir, env: { ...process.env, INFINIBOT_SECURE_MASTER_KEY: "" }, create: false });
        expect(again.key.equals(first.key)).toBe(true);
        expect(fs.readdirSync(dir)).toEqual([]);
      } finally {
        await clearMasterKey({ stateDir: dir });
      }
    },
    30_000,
  );
});
