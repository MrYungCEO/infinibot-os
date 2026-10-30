/**
 * Obsidian vault sources: a local folder, a ZIP archive, or a git URL.
 *
 * Every source is flattened into a list of `VaultFile`s with POSIX paths
 * relative to the vault root. Paths are only used as lookup keys — the
 * importer never writes to disk under a vault path — and `..` segments,
 * dot-folders (`.obsidian`, `.git`, `.trash`) and symlinks are skipped.
 * Entry count and total bytes are capped while reading.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";

export interface VaultFile {
  path: string;
  size: number;
  read(): Promise<Buffer>;
}

export interface VaultSourceLimits {
  maxEntries?: number;
  maxTotalBytes?: number;
}

const DEFAULT_MAX_ENTRIES = 20_000;
const DEFAULT_MAX_TOTAL_BYTES = 500 * 1024 * 1024;

export class VaultLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultLimitError";
  }
}

/** Normalize a vault-relative path; null when unsafe or hidden (dot-folder/file). */
export function safeVaultPath(p: string): string | null {
  const parts = p
    .replace(/\\/g, "/")
    .split("/")
    .filter((s) => s && s !== ".");
  if (!parts.length) return null;
  if (parts.some((s) => s === ".." || s.startsWith("."))) return null;
  if (parts[0] === "__MACOSX") return null;
  return parts.join("/");
}

function limitsOf(l: VaultSourceLimits | undefined) {
  return {
    maxEntries: l?.maxEntries ?? DEFAULT_MAX_ENTRIES,
    maxTotalBytes: l?.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES,
  };
}

/** Walk a vault folder on disk (symlinks are not followed). */
export function listFolderVault(root: string, limits?: VaultSourceLimits): VaultFile[] {
  const { maxEntries, maxTotalBytes } = limitsOf(limits);
  const abs = path.resolve(root);
  const st = fs.statSync(abs);
  if (!st.isDirectory()) throw new Error(`Not a folder: ${root}`);
  const out: VaultFile[] = [];
  let total = 0;
  const stack: string[] = [""];
  while (stack.length) {
    const rel = stack.pop()!;
    const dir = path.join(abs, rel);
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name.startsWith(".")) continue;
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) {
        stack.push(childRel);
        continue;
      }
      if (!ent.isFile()) continue;
      const safe = safeVaultPath(childRel);
      if (!safe) continue;
      const full = path.join(abs, childRel);
      const size = fs.statSync(full).size;
      total += size;
      if (out.length + 1 > maxEntries) {
        throw new VaultLimitError(`Vault has more than ${maxEntries} files`);
      }
      if (total > maxTotalBytes) {
        throw new VaultLimitError(
          `Vault is larger than ${Math.round(maxTotalBytes / 1024 / 1024)} MB`,
        );
      }
      out.push({ path: safe, size, read: () => fs.promises.readFile(full) });
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Read a vault ZIP. A single top-level folder wrapping everything (the usual
 * "MyVault/…" layout) is stripped so paths are vault-relative.
 */
export async function listZipVault(data: Buffer, limits?: VaultSourceLimits): Promise<VaultFile[]> {
  const { maxEntries, maxTotalBytes } = limitsOf(limits);
  const zip = await JSZip.loadAsync(data);
  const files = Object.values(zip.files).filter((f) => !f.dir);
  if (files.length > maxEntries) throw new VaultLimitError(`ZIP has more than ${maxEntries} files`);
  const entries: Array<{ path: string; obj: JSZip.JSZipObject }> = [];
  for (const f of files) {
    const safe = safeVaultPath(f.name);
    if (safe) entries.push({ path: safe, obj: f });
  }
  const firstSegs = new Set(entries.map((e) => e.path.split("/")[0]));
  const strip =
    firstSegs.size === 1 && entries.every((e) => e.path.includes("/"))
      ? `${[...firstSegs][0]}/`
      : "";
  let budget = maxTotalBytes;
  return entries
    .map(({ path: p, obj }) => {
      const declared =
        (obj as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0;
      return {
        path: strip ? p.slice(strip.length) : p,
        size: declared,
        read: async () => {
          const buf = await obj.async("nodebuffer");
          budget -= buf.length;
          if (budget < 0) {
            throw new VaultLimitError(
              `ZIP inflates to more than ${Math.round(maxTotalBytes / 1024 / 1024)} MB`,
            );
          }
          return buf;
        },
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** Only https git URLs (no ssh/file/ext transports, no credentials in the URL). */
export function validateGitUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new Error("Enter an https:// git URL (e.g. https://github.com/you/vault.git)");
  }
  if (u.protocol !== "https:") throw new Error("Only https:// git URLs are supported");
  if (u.username || u.password) {
    throw new Error("Don't put credentials in the URL — use a public repo or a local folder");
  }
  if (u.hostname === "localhost" || /^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(u.hostname)) {
    throw new Error("Private network git hosts are not allowed");
  }
  return u.toString();
}

export type GitCloneFn = (url: string, dest: string, signal?: AbortSignal) => Promise<void>;

const defaultGitClone: GitCloneFn = (url, dest, signal) =>
  new Promise((resolve, reject) => {
    execFile(
      "git",
      [
        "-c",
        "protocol.allow=never",
        "-c",
        "protocol.https.allow=always",
        "clone",
        "--depth",
        "1",
        "--single-branch",
        "--",
        url,
        dest,
      ],
      {
        timeout: 5 * 60_000,
        signal,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "echo" },
        maxBuffer: 4 * 1024 * 1024,
      },
      (err, _stdout, stderr) => {
        if (err) {
          const msg = String(stderr || err.message)
            .split("\n")
            .filter((l) => /fatal|error/i.test(l))
            .join(" ")
            .slice(0, 300);
          reject(new Error(`git clone failed${msg ? `: ${msg}` : ""}`));
        } else resolve();
      },
    );
  });

/** Shallow-clone a git vault into a temp dir; caller must call `cleanup()`. */
export async function cloneGitVault(
  url: string,
  opts: { signal?: AbortSignal; clone?: GitCloneFn; tmpRoot?: string } = {},
): Promise<{ dir: string; cleanup: () => void }> {
  const safeUrl = validateGitUrl(url);
  const base = fs.mkdtempSync(path.join(opts.tmpRoot ?? os.tmpdir(), "ib-obsidian-git-"));
  const dir = path.join(base, "vault");
  try {
    await (opts.clone ?? defaultGitClone)(safeUrl, dir, opts.signal);
  } catch (err) {
    fs.rmSync(base, { recursive: true, force: true });
    throw err;
  }
  return { dir, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}
