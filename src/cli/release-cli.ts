/**
 * `infinibot release` — first-class local publish pipeline.
 *
 *   release plan                         show what a publish would do (no side effects)
 *   release publish [--dry-run] …        run the full verify→build→bump→pack→publish flow
 *   release verify <version>             install a published version in /tmp and smoke-test it
 *   release rollback <version>           `npm deprecate` a bad version
 *
 * This is the actual publish path the watcher / voice / dashboard invoke. It mirrors the
 * structure of voice-cli.ts and leans on @clack/prompts for the few interactive bits.
 *
 * Hard rules baked in here (do not loosen without a flag):
 *   - refuse a dirty tree unless --dirty-ok
 *   - refuse a non-release branch (main, or feat/* with --allow-feat)
 *   - detect files[] whitelist drift (npm silently drops dist subdirs not in files[])
 *   - smoke-test the packed tarball in a clean tmp dir before publishing
 *   - auto-revert the calver bump if anything after the bump fails
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Command } from "commander";
import * as p from "@clack/prompts";

import { resolveInfiniBotPackageRootSync } from "../infra/infinibot-root.js";

const pExecFile = promisify(execFile);

type BumpKind = "patch" | "minor" | "major";

interface PkgJson {
  name: string;
  version: string;
  files?: string[];
  [k: string]: unknown;
}

// ── small process helpers ──────────────────────────────────────────────────

interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
}

async function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; quiet?: boolean } = {},
): Promise<RunResult> {
  try {
    const { stdout, stderr } = await pExecFile(cmd, args, {
      cwd: opts.cwd,
      maxBuffer: 64 * 1024 * 1024,
      env: process.env,
    });
    return { ok: true, stdout: stdout ?? "", stderr: stderr ?? "", code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number; message?: string };
    return {
      ok: false,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? e.message ?? "",
      code: typeof e.code === "number" ? e.code : null,
    };
  }
}

/** Run with output streamed straight to the user (build, publish, etc.). */
async function runLoud(cmd: string, args: string[], cwd: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { cwd, maxBuffer: 64 * 1024 * 1024, env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => {
      stdout += d;
      process.stdout.write(d);
    });
    child.stderr?.on("data", (d) => {
      stderr += d;
      process.stderr.write(d);
    });
    child.on("close", (code) => {
      resolve({ ok: code === 0, stdout, stderr, code });
    });
    child.on("error", (err) => {
      resolve({ ok: false, stdout, stderr: String(err), code: null });
    });
  });
}

// ── repo / package helpers ─────────────────────────────────────────────────

function repoRoot(): string {
  return (
    resolveInfiniBotPackageRootSync({
      cwd: process.cwd(),
      argv1: process.argv[1],
      moduleUrl: import.meta.url,
    }) ?? process.cwd()
  );
}

function readPkg(root: string): PkgJson {
  const raw = fs.readFileSync(path.join(root, "package.json"), "utf8");
  return JSON.parse(raw) as PkgJson;
}

/** Write only the version field back, preserving formatting/trailing newline as best we can. */
function writePkgVersion(root: string, version: string): void {
  const file = path.join(root, "package.json");
  const raw = fs.readFileSync(file, "utf8");
  const trailing = raw.endsWith("\n") ? "\n" : "";
  // Replace the first `"version": "..."` occurrence only.
  const next = raw.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`);
  if (next === raw) {
    // Fallback: structural rewrite (loses custom formatting, but correct).
    const pkg = JSON.parse(raw) as PkgJson;
    pkg.version = version;
    fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + trailing);
    return;
  }
  fs.writeFileSync(file, next);
}

function bumpCalver(version: string, kind: BumpKind): string {
  const parts = version.split(".");
  if (parts.length !== 3 || parts.some((s) => !/^\d+$/.test(s))) {
    throw new Error(
      `version "${version}" is not a 3-segment numeric calver (e.g. 2026.6.6) — cannot auto-bump`,
    );
  }
  const [a, b, c] = parts.map((s) => Number.parseInt(s, 10));
  switch (kind) {
    case "major":
      return `${a + 1}.0.0`;
    case "minor":
      return `${a}.${b + 1}.0`;
    case "patch":
    default:
      return `${a}.${b}.${c + 1}`;
  }
}

// ── git helpers ────────────────────────────────────────────────────────────

async function gitPorcelain(root: string): Promise<string> {
  const r = await run("git", ["status", "--porcelain"], { cwd: root });
  return r.stdout.trim();
}

async function gitBranch(root: string): Promise<string> {
  const r = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root });
  return r.stdout.trim();
}

async function gitLastTag(root: string): Promise<string | null> {
  const r = await run("git", ["describe", "--tags", "--abbrev=0"], { cwd: root });
  return r.ok && r.stdout.trim() ? r.stdout.trim() : null;
}

async function gitCommitsSince(root: string, tag: string | null): Promise<string[]> {
  const range = tag ? `${tag}..HEAD` : "HEAD";
  const r = await run("git", ["log", range, "--oneline", "--no-decorate", "-n", "50"], {
    cwd: root,
  });
  return r.stdout
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

function isReleaseBranch(branch: string, allowFeat: boolean): boolean {
  if (branch === "main" || branch === "master") return true;
  if (allowFeat && branch.startsWith("feat/")) return true;
  return false;
}

// ── files[] drift detection ────────────────────────────────────────────────

/** dirs that legitimately compile to dist/ but are never meant to ship. */
const DIST_DIR_ALLOWLIST = new Set(["test-utils", "test-helpers", "__mocks__", "__tests__"]);

interface DriftReport {
  distExists: boolean;
  covered: string[];
  missing: string[];
  allowlisted: string[];
}

/**
 * Compare dist/ top-level subdirectories against the `dist/<name>/**` patterns in files[].
 * A dist subdir that holds shippable code but has no whitelist entry is "dropped" by npm.
 */
function detectFilesDrift(root: string, pkg: PkgJson): DriftReport {
  const distDir = path.join(root, "dist");
  if (!fs.existsSync(distDir)) {
    return { distExists: false, covered: [], missing: [], allowlisted: [] };
  }
  const files = pkg.files ?? [];
  const hasCatchAll = files.includes("dist/**");
  const covered = new Set<string>();
  for (const f of files) {
    const m = f.match(/^dist\/([^/*]+)\/\*\*/);
    if (m) covered.add(m[1]);
  }
  const dirs = fs
    .readdirSync(distDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  const missing: string[] = [];
  const allowlisted: string[] = [];
  for (const d of dirs) {
    if (hasCatchAll || covered.has(d)) continue;
    if (DIST_DIR_ALLOWLIST.has(d)) {
      allowlisted.push(d);
      continue;
    }
    // Only flag dirs that actually contain shippable .js (skip empty/d.ts-only noise).
    if (dirHasJs(path.join(distDir, d))) missing.push(d);
  }
  return {
    distExists: true,
    covered: [...covered],
    missing: missing.sort(),
    allowlisted: allowlisted.sort(),
  };
}

function dirHasJs(dir: string): boolean {
  let stack = [dir];
  let guard = 0;
  while (stack.length && guard < 5000) {
    guard++;
    const cur = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) stack.push(path.join(cur, e.name));
      else if (e.name.endsWith(".js")) return true;
    }
  }
  return false;
}

// ── plan ───────────────────────────────────────────────────────────────────

async function cmdPlan(opts: { json?: boolean; minor?: boolean; major?: boolean }): Promise<void> {
  const root = repoRoot();
  const pkg = readPkg(root);
  const kind: BumpKind = opts.major ? "major" : opts.minor ? "minor" : "patch";
  let nextVersion: string;
  try {
    nextVersion = bumpCalver(pkg.version, kind);
  } catch (err) {
    nextVersion = `(cannot bump: ${(err as Error).message})`;
  }

  const branch = await gitBranch(root);
  const dirty = (await gitPorcelain(root)).length > 0;
  const lastTag = await gitLastTag(root);
  const commits = await gitCommitsSince(root, lastTag);
  const drift = detectFilesDrift(root, pkg);

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          name: pkg.name,
          currentVersion: pkg.version,
          nextVersion,
          bump: kind,
          branch,
          dirty,
          lastTag,
          commitsSinceTag: commits,
          filesDrift: drift,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`\n  ${pkg.name} — release plan\n`);
  console.log(`  current version : ${pkg.version}`);
  console.log(`  next version    : ${nextVersion}   (${kind} bump)`);
  console.log(`  branch          : ${branch}${dirty ? "  ⚠ dirty tree" : ""}`);
  console.log(`  last tag        : ${lastTag ?? "(none)"}`);

  console.log(`\n  commits since ${lastTag ?? "start"} (${commits.length}):`);
  if (commits.length === 0) {
    console.log("    (none — nothing to release)");
  } else {
    for (const c of commits.slice(0, 20)) console.log(`    • ${c}`);
    if (commits.length > 20) console.log(`    … and ${commits.length - 20} more`);
  }

  console.log("\n  files[] whitelist check:");
  if (!drift.distExists) {
    console.log("    dist/ not built yet — drift check runs during publish (after build).");
  } else if (drift.missing.length === 0) {
    console.log(`    ✅ no drift — ${drift.covered.length} dist dirs covered by files[]`);
    if (drift.allowlisted.length) {
      console.log(`    (ignored test dirs: ${drift.allowlisted.join(", ")})`);
    }
  } else {
    console.log(`    ⚠ DRIFT — ${drift.missing.length} dist dir(s) NOT in package.json files[]:`);
    for (const m of drift.missing) console.log(`        dist/${m}/**   ← would be dropped by npm`);
    console.log("    publish will FAIL until these are added to files[] (or --allow-files-drift).");
  }

  console.log(
    "\n  publish would: build → pack-check → bump → smoke-test → commit+tag → npm publish → push → gh release\n",
  );
}

// ── publish ──────────────────────────────────────────────────────────────────

interface PublishOpts {
  dryRun?: boolean;
  tag?: string;
  from?: string;
  minor?: boolean;
  major?: boolean;
  dirtyOk?: boolean;
  allowFeat?: boolean;
  allowFilesDrift?: boolean;
  skipBuild?: boolean;
  yes?: boolean;
}

async function cmdPublish(opts: PublishOpts): Promise<void> {
  const root = repoRoot();
  const dry = !!opts.dryRun;
  const tag = opts.tag ?? "latest";
  const kind: BumpKind = opts.major ? "major" : opts.minor ? "minor" : "patch";
  const label = dry ? "[dry-run] " : "";

  p.intro(`infinibot release publish${dry ? "  (dry-run)" : ""}`);
  if (opts.from) p.log.info(`triggered from: ${opts.from}`);

  const pkg = readPkg(root);
  const fail = (msg: string): never => {
    p.cancel(`${msg}`);
    process.exitCode = 1;
    throw new ReleaseAbort(msg);
  };

  try {
    // 1 ─ clean tree
    const porcelain = await gitPorcelain(root);
    if (porcelain.length > 0 && !opts.dirtyOk) {
      p.log.error("git tree is dirty:");
      console.log(
        porcelain
          .split("\n")
          .slice(0, 20)
          .map((l) => `    ${l}`)
          .join("\n"),
      );
      fail("Refusing to publish from a dirty tree. Commit/stash, or pass --dirty-ok.");
    }
    p.log.success(opts.dirtyOk && porcelain ? "tree dirty (allowed via --dirty-ok)" : "tree clean");

    // 2 ─ branch eligibility
    const branch = await gitBranch(root);
    if (!isReleaseBranch(branch, !!opts.allowFeat)) {
      fail(
        `branch "${branch}" is not release-eligible. Use main, or a feat/* branch with --allow-feat.`,
      );
    }
    p.log.success(`branch "${branch}" is release-eligible`);

    // 3 ─ build
    if (opts.skipBuild) {
      p.log.warn("skipping build (--skip-build) — using existing dist/");
    } else {
      const s = p.spinner();
      s.start(`${label}running npm run build`);
      if (dry) {
        // Building regenerates gitignored dist/, but to keep dry-run truly side-effect-free
        // we only build if dist is missing (needed for the files-drift check).
        if (!fs.existsSync(path.join(root, "dist"))) {
          s.stop("dry-run: dist/ missing — building once so the files[] check is meaningful");
          const r = await runLoud("npm", ["run", "build"], root);
          if (!r.ok) fail("build failed (see output above)");
        } else {
          s.stop("dry-run: skipping build, reusing existing dist/");
        }
      } else {
        s.stop("building…");
        const r = await runLoud("npm", ["run", "build"], root);
        if (!r.ok) fail("build failed (see output above)");
        p.log.success("build ok");
      }
    }

    // 4 ─ files[] drift via npm pack --dry-run + dist comparison
    const drift = detectFilesDrift(root, pkg);
    if (drift.distExists && drift.missing.length > 0 && !opts.allowFilesDrift) {
      p.log.error("files[] whitelist drift — these dist dirs would be silently dropped by npm:");
      for (const m of drift.missing) console.log(`    dist/${m}/**`);
      console.log(
        "    Add the missing entries to package.json files[] (with user confirmation), " +
          "or re-run with --allow-files-drift to publish anyway.",
      );
      fail("Aborting on files[] drift.");
    }
    if (drift.missing.length > 0) {
      p.log.warn(
        `files[] drift present but overridden via --allow-files-drift: ${drift.missing.join(", ")}`,
      );
    } else {
      p.log.success("files[] whitelist covers all shippable dist dirs");
    }

    // Cross-check with npm pack --dry-run (authoritative list of what ships).
    const packDry = await run("npm", ["pack", "--dry-run", "--json"], { cwd: root });
    if (packDry.ok) {
      const totalFiles = countPackFiles(packDry.stdout);
      if (totalFiles !== null) p.log.info(`npm pack would include ${totalFiles} files`);
    }

    // 5 ─ calver bump (revertible)
    const nextVersion = bumpCalver(pkg.version, kind);
    let bumpApplied = false;
    if (!dry) {
      writePkgVersion(root, nextVersion);
      bumpApplied = true;
      p.log.success(`bumped ${pkg.version} → ${nextVersion} (${kind})`);
    } else {
      p.log.info(`${label}would bump ${pkg.version} → ${nextVersion} (${kind})`);
    }

    const revertBump = () => {
      if (bumpApplied) {
        writePkgVersion(root, pkg.version);
        bumpApplied = false;
        p.log.warn(`reverted version bump → ${pkg.version}`);
      }
    };

    try {
      // 6 ─ smoke test the packed tarball in a clean tmp dir
      if (dry) {
        p.log.info(
          `${label}would: npm pack → npm install -g <tgz> in tmp → infinibot --version/--help`,
        );
      } else {
        const s = p.spinner();
        s.start("packing + smoke-testing in a clean tmp dir");
        const smoke = await smokeTest(root);
        if (!smoke.ok) {
          s.stop("smoke test FAILED");
          p.log.error(smoke.detail);
          revertBump();
          fail("smoke test failed — bump reverted, nothing published.");
        }
        s.stop(`smoke test passed — ${smoke.detail}`);
      }

      const newTag = `v${nextVersion}`;

      // 7 ─ commit + tag
      if (dry) {
        p.log.info(`${label}would: git commit -am "release: ${newTag}" && git tag ${newTag}`);
      } else {
        const c = await run("git", ["commit", "-am", `release: ${newTag}`], { cwd: root });
        if (!c.ok) {
          revertBump();
          fail(`git commit failed: ${c.stderr.trim()}`);
        }
        const t = await run("git", ["tag", newTag], { cwd: root });
        if (!t.ok) {
          // commit already landed; surface clearly rather than silently continuing
          fail(`git tag failed: ${t.stderr.trim()} (commit landed; resolve manually)`);
        }
        p.log.success(`committed + tagged ${newTag}`);
      }

      // 8 ─ npm publish
      if (dry) {
        p.log.info(`${label}would: npm publish --tag ${tag}`);
      } else {
        const r = await runLoud("npm", ["publish", "--tag", tag], root);
        if (!r.ok)
          fail(`npm publish failed (commit+tag landed locally; not pushed). Fix and retry.`);
        p.log.success(`published ${pkg.name}@${nextVersion} (tag: ${tag})`);
      }

      // 9 ─ push
      if (dry) {
        p.log.info(`${label}would: git push && git push --tags`);
      } else {
        const r1 = await run("git", ["push"], { cwd: root });
        const r2 = await run("git", ["push", "--tags"], { cwd: root });
        if (!r1.ok || !r2.ok) {
          p.log.warn(`git push had issues: ${(r1.stderr || r2.stderr).trim()}`);
        } else {
          p.log.success("pushed commits + tags");
        }
      }

      // 10 ─ gh release
      if (dry) {
        p.log.info(`${label}would: gh release create ${newTag} --generate-notes`);
      } else {
        const r = await run("gh", ["release", "create", newTag, "--generate-notes"], { cwd: root });
        if (!r.ok) {
          p.log.warn(`gh release create failed (publish already done): ${r.stderr.trim()}`);
        } else {
          p.log.success(`gh release ${newTag} created`);
        }
      }

      // 11 ─ summary
      p.outro(
        dry
          ? `dry-run complete — would publish ${pkg.name}@${nextVersion} (tag ${tag}). No side effects.`
          : `released ${pkg.name}@${nextVersion} (tag ${tag}) → ${newTag}`,
      );
    } catch (err) {
      if (!(err instanceof ReleaseAbort)) {
        revertBump();
        throw err;
      }
      throw err;
    }
  } catch (err) {
    if (err instanceof ReleaseAbort) return; // already reported
    p.cancel(`release failed: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}

class ReleaseAbort extends Error {}

function countPackFiles(json: string): number | null {
  try {
    const parsed = JSON.parse(json) as Array<{ files?: unknown[]; entryCount?: number }>;
    const first = parsed[0];
    if (!first) return null;
    if (typeof first.entryCount === "number") return first.entryCount;
    if (Array.isArray(first.files)) return first.files.length;
    return null;
  } catch {
    return null;
  }
}

interface SmokeResult {
  ok: boolean;
  detail: string;
}

async function smokeTest(root: string): Promise<SmokeResult> {
  const pkg = readPkg(root);
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "infinibot-release-"));
  const prefix = path.join(tmpBase, "global");
  fs.mkdirSync(prefix, { recursive: true });
  try {
    // Pack into the tmp dir.
    const packed = await run("npm", ["pack", "--pack-destination", tmpBase], { cwd: root });
    if (!packed.ok) return { ok: false, detail: `npm pack failed: ${packed.stderr.trim()}` };
    const tgz = packed.stdout.trim().split("\n").pop()?.trim();
    if (!tgz) return { ok: false, detail: "npm pack produced no tarball name" };
    const tgzPath = path.join(tmpBase, tgz);
    if (!fs.existsSync(tgzPath)) return { ok: false, detail: `tarball not found: ${tgzPath}` };

    // Install into an isolated prefix (no global pollution).
    const install = await run(
      "npm",
      ["install", "-g", tgzPath, "--prefix", prefix, "--no-audit", "--no-fund"],
      { cwd: tmpBase },
    );
    if (!install.ok)
      return { ok: false, detail: `npm install -g failed: ${install.stderr.trim()}` };

    const binDir = process.platform === "win32" ? prefix : path.join(prefix, "bin");
    const bin = path.join(binDir, process.platform === "win32" ? "infinibot.cmd" : "infinibot");
    if (!fs.existsSync(bin)) {
      // Fall back to invoking the installed entry directly.
      const entry = path.join(prefix, "lib", "node_modules", pkg.name, "dist", "entry.js");
      if (fs.existsSync(entry)) {
        const v = await run("node", [entry, "--version"], { cwd: tmpBase });
        if (!v.ok) return { ok: false, detail: `infinibot --version failed: ${v.stderr.trim()}` };
        return { ok: true, detail: `version ${v.stdout.trim()} (via entry.js)` };
      }
      return { ok: false, detail: `installed bin not found at ${bin}` };
    }

    const ver = await run(bin, ["--version"], { cwd: tmpBase });
    if (!ver.ok) return { ok: false, detail: `infinibot --version failed: ${ver.stderr.trim()}` };
    const help = await run(bin, ["--help"], { cwd: tmpBase });
    if (!help.ok) return { ok: false, detail: `infinibot --help failed: ${help.stderr.trim()}` };

    return { ok: true, detail: `infinibot --version → ${ver.stdout.trim()}` };
  } finally {
    try {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
}

// ── verify ───────────────────────────────────────────────────────────────────

async function cmdVerify(version: string): Promise<void> {
  const root = repoRoot();
  const pkg = readPkg(root);
  const spec = `${pkg.name}@${version}`;
  p.intro(`infinibot release verify ${spec}`);

  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "infinibot-verify-"));
  const prefix = path.join(tmpBase, "global");
  fs.mkdirSync(prefix, { recursive: true });
  const s = p.spinner();
  s.start(`installing ${spec} from the npm registry`);
  try {
    const install = await run(
      "npm",
      ["install", "-g", spec, "--prefix", prefix, "--no-audit", "--no-fund"],
      { cwd: tmpBase },
    );
    if (!install.ok) {
      s.stop("install failed");
      p.cancel(install.stderr.trim() || "npm install failed");
      process.exitCode = 1;
      return;
    }
    const binDir = process.platform === "win32" ? prefix : path.join(prefix, "bin");
    const bin = path.join(binDir, process.platform === "win32" ? "infinibot.cmd" : "infinibot");
    const ver = await run(bin, ["--version"], { cwd: tmpBase });
    const help = await run(bin, ["--help"], { cwd: tmpBase });
    s.stop("installed");
    if (!ver.ok || !help.ok) {
      p.cancel(`smoke test failed: ${(ver.stderr || help.stderr).trim()}`);
      process.exitCode = 1;
      return;
    }
    p.outro(`✅ ${spec} installs + runs — reported version ${ver.stdout.trim()}`);
  } finally {
    try {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

// ── rollback ─────────────────────────────────────────────────────────────────

async function cmdRollback(version: string, opts: { message?: string }): Promise<void> {
  const root = repoRoot();
  const pkg = readPkg(root);
  const spec = `${pkg.name}@${version}`;
  const message =
    opts.message ??
    `${spec} was deprecated via \`infinibot release rollback\` — please upgrade to a newer version.`;
  p.intro(`infinibot release rollback ${spec}`);
  const r = await run("npm", ["deprecate", spec, message], { cwd: root });
  if (!r.ok) {
    p.cancel(`npm deprecate failed: ${r.stderr.trim()}`);
    process.exitCode = 1;
    return;
  }
  p.outro(`deprecated ${spec}: "${message}"`);
}

// ── registration ─────────────────────────────────────────────────────────────

export function registerReleaseCli(program: Command): void {
  const release = program
    .command("release")
    .description("Local publish pipeline (plan / publish / verify / rollback)");

  release
    .command("plan")
    .description(
      "Show what a publish would do (current → next version, files[] drift, commits). No side effects.",
    )
    .option("--minor", "Plan a minor bump (X.Y+1.0)")
    .option("--major", "Plan a major bump (X+1.0.0)")
    .option("--json", "Output JSON")
    .action(async (opts) => {
      await cmdPlan(opts);
    });

  release
    .command("publish")
    .description("Run the full verify → build → bump → pack → publish flow")
    .option("--dry-run", "Walk the whole flow but stop before any irreversible side effect")
    .option("--tag <tag>", "npm dist-tag to publish under (latest | next)", "latest")
    .option("--from <bucket>", "Label the trigger source (watcher, voice, dashboard…)")
    .option("--minor", "Minor bump (X.Y+1.0)")
    .option("--major", "Major bump (X+1.0.0)")
    .option("--dirty-ok", "Allow publishing from a dirty git tree")
    .option("--allow-feat", "Allow publishing from a feat/* branch")
    .option(
      "--allow-files-drift",
      "Publish even if dist dirs are missing from package.json files[]",
    )
    .option("--skip-build", "Reuse existing dist/ instead of running npm run build")
    .action(async (opts) => {
      await cmdPublish(opts);
    });

  release
    .command("verify <version>")
    .description("Install the published version in a tmp dir and smoke-test it")
    .action(async (version: string) => {
      await cmdVerify(version);
    });

  release
    .command("rollback <version>")
    .description("npm deprecate a bad version with a message")
    .option("--message <msg>", "Deprecation message")
    .action(async (version: string, opts) => {
      await cmdRollback(version, opts);
    });
}
