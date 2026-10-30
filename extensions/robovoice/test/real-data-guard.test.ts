/**
 * Real-data guard ("NO MOCK DATA"): the Robovoice plugin and the Voice page
 * show only what the owner's linked Robovoice account says. The mock
 * Robovoice server is a test fixture — no runtime module may import it, and
 * no runtime file may carry a built-in voice catalogue, sample agent or
 * guessed default that could pass for real account data.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = process.cwd();
const EXT = join(REPO, "extensions/robovoice");
const BANNED_PATH = /demo|mock|fixture|fake|sample/i;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|mts|js|mjs)$/.test(name) && !/\.test\.[mc]?[jt]s$/.test(name)) out.push(full);
  }
  return out;
}

/** Shipped runtime code: the plugin entry + src, and every Voice-page UI module. */
const pluginRuntime = [join(EXT, "index.ts"), ...walk(join(EXT, "src"))];
const uiRuntime = [
  ...walk(join(REPO, "ui/src/ui/views/voice-robovoice")),
  ...walk(join(REPO, "ui/src/ui/views/robovoice")),
  join(REPO, "ui/src/ui/components/robovoice-agent-voice.ts"),
  join(REPO, "ui/src/ui/components/robovoice-link.ts"),
];
const runtime = [...pluginRuntime, ...uiRuntime];
const rel = (f: string) => relative(REPO, f);
const specifiers = (src: string) =>
  [...src.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g)].map((m) => m[1]);
const grepLines = (files: string[], re: RegExp) =>
  files.flatMap((f) =>
    readFileSync(f, "utf8")
      .split("\n")
      .map((l, i) => [l, i] as const)
      .filter(([l]) => re.test(l) && !/^\s*(\*|\/\/)/.test(l))
      .map(([l, i]) => `${rel(f)}:${i + 1}: ${l.trim().slice(0, 140)}`),
  );

describe("Robovoice voice runs on real data only", () => {
  it("has runtime files to check", () => {
    expect(pluginRuntime.length).toBeGreaterThan(10);
    expect(uiRuntime.length).toBeGreaterThan(5);
  });

  it("the mock Robovoice server lives under test/ only", () => {
    const shipped = walk(EXT).filter((f) => !rel(f).startsWith("extensions/robovoice/test/"));
    expect(shipped.map(rel).filter((f) => /mock/i.test(f))).toEqual([]);
    expect(statSync(join(EXT, "test/mock-robovoice-server.ts")).isFile()).toBe(true);
  });

  it("no runtime module lives at, or imports, a demo/mock/fixture/fake/sample path", () => {
    expect(runtime.map(rel).filter((f) => BANNED_PATH.test(f))).toEqual([]);
    const bad = runtime.flatMap((f) =>
      specifiers(readFileSync(f, "utf8"))
        .filter((s) => BANNED_PATH.test(s) || /(^|\/)test\//.test(s))
        .map((s) => `${rel(f)} → ${s}`),
    );
    expect(bad).toEqual([]);
  });

  it("the plugin manifest only loads index.ts (the mock is unreachable at runtime)", () => {
    const pkg = JSON.parse(readFileSync(join(EXT, "package.json"), "utf8")) as { infinibot?: { extensions?: string[] } };
    expect(pkg.infinibot?.extensions).toEqual(["./index.ts"]);
    expect(readFileSync(join(EXT, "infinibot.plugin.json"), "utf8")).not.toMatch(/mock/i);
  });

  it("no mock switches, mock orgs or demo wording in runtime code", () => {
    expect(grepLines(runtime, /MOCK_|__mock|Mock Org|\bDEMO\b|demo data|sample (data|agents?|characters?)/i)).toEqual([]);
  });

  it("no built-in voice catalogue or guessed voice defaults", () => {
    // Kokoro/ElevenLabs voice ids, a language list, or a "kokoro" fallback would pass for the account's real voice.
    expect(grepLines(uiRuntime, /af_heart|am_puck|bf_emma|bm_george|21m00Tcm4TlvDq8ikWAM|pNInz6obpgDQGcFmaJgB|onwK4e9ZLuTAKqWW03F9|"Hebrew"|VOICE_LANGUAGES|DEFAULT_SETTINGS/)).toEqual([]);
    expect(grepLines(uiRuntime, /\?\?\s*"kokoro"|\|\|\s*"kokoro"|\?\?\s*"auto"|\|\|\s*"auto"/)).toEqual([]);
    expect(grepLines([join(EXT, "src/voice-pipeline-rpc.ts"), join(EXT, "src/pipeline.ts"), join(EXT, "src/link.ts")], /\?\?\s*"(kokoro|groq|speaches)"|\|\|\s*"(kokoro|groq|speaches)"/)).toEqual([]);
  });

  it("agent sync invents no language for Robovoice", () => {
    expect(grepLines([join(EXT, "src/link.ts")], /language:\s*o\.language\s*\?\?|\?\?\s*"en"/)).toEqual([]);
  });

  it("no invented agents or credit prices", () => {
    expect(grepLines(runtime, /\{\s*id:\s*"main",\s*name:\s*"(INFINI|main)"\s*\}/)).toEqual([]);
    expect(grepLines(pluginRuntime, /USD_PER_CREDIT/)).toEqual([]);
    expect(grepLines(uiRuntime, /testAgent\s*=\s*"main"|\?\?\s*"Mock|\?\?\s*"Location"|org\?\.name \?\? "Robovoice"/)).toEqual([]);
  });
});
