#!/usr/bin/env node
/**
 * Pre-commit secret guard.
 *
 * Scans staged changes for high-confidence secret patterns. Blocks the commit
 * if anything matches, unless the file is a test fixture or the matched string
 * is explicitly an allowlisted placeholder.
 *
 * Override with `git commit --no-verify` only if you are 100% sure (and even
 * then, prefer fixing the leak — secrets in git history live forever).
 */
import { spawnSync } from "node:child_process";

const PATTERNS = [
  // Anthropic / OpenAI API + OAuth tokens
  { name: "anthropic_api_key", re: /sk-ant-api-[A-Za-z0-9_-]{40,}/ },
  { name: "anthropic_oauth_access", re: /sk-ant-oat[0-9]+-[A-Za-z0-9_-]{30,}/ },
  { name: "anthropic_oauth_refresh", re: /sk-ant-ort[0-9]+-[A-Za-z0-9_-]{30,}/ },
  { name: "openai_api_key", re: /sk-[A-Za-z0-9]{32,}T3BlbkFJ[A-Za-z0-9]{20,}/ },
  // Common provider tokens (prefixed formats)
  { name: "github_pat", re: /gh[pousr]_[A-Za-z0-9]{30,}/ },
  { name: "npm_token", re: /npm_[A-Za-z0-9]{30,}/ },
  { name: "slack_bot_token", re: /xox[abp]-[0-9]+-[0-9]+-[A-Za-z0-9]+/ },
  { name: "google_api_key", re: /AIza[0-9A-Za-z_-]{30,}/ },
  { name: "stripe_live_secret", re: /sk_live_[A-Za-z0-9]{30,}/ },
  { name: "stripe_webhook_secret", re: /whsec_[A-Za-z0-9]{30,}/ },
  { name: "aws_access_key", re: /AKIA[0-9A-Z]{16}/ },
  { name: "notion_integration_token", re: /ntn_[A-Za-z0-9]{40,}/ },
  // Project-specific patterns the audit found
  { name: "gateway_password_pattern", re: /(Kingly|Khalifa)888\$?[8]*/ },
  // .npmrc auth lines
  { name: "npmrc_authtoken", re: /\/\/.*?\/:_authToken=[A-Za-z0-9_-]{20,}/ },
];

// Test fixtures / placeholders are not real secrets.
const SKIP_PATH_PATTERNS = [
  /\.test\.[cm]?[jt]sx?$/,
  /\.spec\.[cm]?[jt]sx?$/,
  /\/__fixtures__\//,
  /\/__mocks__\//,
  /\/test\//,
  /\/fixtures?\//,
];
const PLACEHOLDER_HINTS = [
  /example|placeholder|YOUR_|<your-|REPLACE_|XXX|fake|dummy|0123456789abcdef|abcdefghij/i,
];

function shouldSkipPath(path) {
  return SKIP_PATH_PATTERNS.some((re) => re.test(path));
}
function looksLikePlaceholder(line) {
  return PLACEHOLDER_HINTS.some((re) => re.test(line));
}

function stagedFiles() {
  const r = spawnSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR"], {
    encoding: "utf8",
  });
  if (r.status !== 0) return [];
  return r.stdout.split("\n").filter(Boolean);
}

function stagedContent(path) {
  const r = spawnSync("git", ["diff", "--cached", "--unified=0", "--", path], { encoding: "utf8" });
  return r.stdout;
}

const findings = [];
for (const file of stagedFiles()) {
  if (shouldSkipPath(file)) continue;
  const diff = stagedContent(file);
  const lines = diff.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Only check added lines (+...), not context or removed.
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    if (looksLikePlaceholder(line)) continue;
    for (const { name, re } of PATTERNS) {
      const m = line.match(re);
      if (m) findings.push({ file, line: line.slice(0, 200), pattern: name, match: m[0] });
    }
  }
}

if (findings.length === 0) process.exit(0);

console.error("");
console.error("\x1b[31m\x1b[1m✗ pre-commit secret guard: blocked\x1b[0m");
console.error("");
console.error("Staged changes contain what look like secrets. Commit blocked.\n");
for (const f of findings) {
  console.error(`  \x1b[33m${f.pattern}\x1b[0m in \x1b[36m${f.file}\x1b[0m`);
  console.error(`    matched: ${f.match.slice(0, 60)}${f.match.length > 60 ? "…" : ""}`);
}
console.error("");
console.error("Options:");
console.error("  1. Remove the secret + rotate it (recommended — see README).");
console.error("  2. Move it to a .env file (gitignored) or your password manager.");
console.error("  3. If it really is a test fixture, name the file *.test.* or move it");
console.error("     under a /test/ or /__fixtures__/ path.");
console.error("");
process.exit(1);
