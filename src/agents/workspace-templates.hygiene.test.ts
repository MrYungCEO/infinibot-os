import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// Seed templates are copied into every new user's agent workspace, so they
// must never carry an operator's private notes, infrastructure or keys.
const TEMPLATE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../docs/reference/templates",
);

const FORBIDDEN: Array<[string, RegExp]> = [
  [
    "private IPv4 address",
    /\b(?:10|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}(?:\.\d{1,3})?\b/,
  ],
  ["Windows user path", /[A-Z]:\\Users\\/i],
  ["home directory path", /\/home\/[a-z0-9_-]+\//i],
  ["API key-looking token", /\b(?:sk|pk|rk|apify|ntn|secret|key)[-_][A-Za-z0-9]{16,}/],
  ["long hex/base64 secret", /\b[A-Za-z0-9]{40,}\b/],
  ["Supabase project ref", /\b[a-z]{20}\.supabase\.co\b/],
  ["owner persona", /Ra Kai'Un|KinglyVault|Kingly Vault|Gengu|FlyPic|Robovoice|HeyGen/i],
];

// The example SSH block in TOOLS.md intentionally uses documentation-safe
// placeholders; nothing here should need a whitelist.
function templateFiles(): string[] {
  return fs
    .readdirSync(TEMPLATE_DIR)
    .filter((name) => name.endsWith(".md"))
    .map((name) => path.join(TEMPLATE_DIR, name));
}

describe("workspace seed templates", () => {
  it("ships the core seed files on disk", () => {
    const names = new Set(fs.readdirSync(TEMPLATE_DIR));
    for (const required of [
      "AGENTS.md",
      "SOUL.md",
      "TOOLS.md",
      "IDENTITY.md",
      "USER.md",
      "HEARTBEAT.md",
      "BOOTSTRAP.md",
    ]) {
      expect(names.has(required), required).toBe(true);
    }
  });

  for (const file of templateFiles()) {
    it(`${path.basename(file)} contains no owner-private data`, () => {
      const content = fs.readFileSync(file, "utf-8");
      for (const [label, pattern] of FORBIDDEN) {
        const match = content.match(pattern);
        expect(match?.[0], `${label} in ${path.basename(file)}`).toBeUndefined();
      }
    });
  }

  it("HEARTBEAT.md is comments-only so fresh installs make no heartbeat model calls", () => {
    const content = fs.readFileSync(path.join(TEMPLATE_DIR, "HEARTBEAT.md"), "utf-8");
    const body = content.replace(/^---[\s\S]*?\n---\n/, "");
    const active = body
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
    expect(active).toEqual([]);
  });
});
