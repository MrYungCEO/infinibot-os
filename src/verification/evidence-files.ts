/**
 * Evidence files — claims whose evidence_ref points at files the agent wrote
 * (result JSON, test-report JSON, build logs, screenshots under /tmp/...).
 *
 * Agents often put several paths plus prose in one ref:
 *   "/tmp/result.json; disabledAfterData.rpcUnavailable=true, retainedRows={...}"
 *   "pnpm build (exit 0, /tmp/rp2-build2.log)"
 *   "/tmp/a.png, /tmp/b.png"
 * The whole ref used to be treated as ONE path ("file does not exist"), or a
 * command ref with a log path was "not listed in checks_run". Here every path
 * is pulled out and read (bounded): JSON is parsed and the `field=value`
 * assertions in the claim are checked, logs are tailed, images get
 * existence + size + mtime ≥ run start. The excerpts feed the LLM reviewer.
 */

import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { EvidenceStatus } from "./evidence.js";

export interface EvidenceFileCheck {
  path: string;
  status: EvidenceStatus;
  detail: string;
  /** Bounded content excerpt for the LLM reviewer (JSON summary / log tail). */
  excerpt?: string;
  isImage?: boolean;
}

const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif)$/i;
const MAX_READ_BYTES = 256 * 1024;
const TAIL_LINES = 30;
const EXCERPT_CAP = 1500;
const MTIME_SLACK_MS = 2000;

const PATH_TRAIL_RE = /[.,;:)\]}'"`]+$/;

/**
 * Absolute (`/…`, `~/…`) and repo-relative (`dir/file.ext`) paths mentioned in
 * a ref, in order, de-duplicated. `file:12` / `#L3` suffixes are dropped.
 */
export function extractPathRefs(ref: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string) => {
    let p = raw.replace(PATH_TRAIL_RE, "");
    p = p.replace(/#L\d+(?:-L?\d+)?$/i, "").replace(/:\d+(?::\d+)?(?:-\d+)?$/, "");
    if (!p || p === "/" || p === "~" || seen.has(p)) return;
    seen.add(p);
    out.push(p);
  };
  // Absolute / home paths: must start at a boundary (not inside a URL or a/b).
  for (const m of ref.matchAll(
    /(?:^|[\s,;(=[{'"`])((?:~|\/)(?:(?:[\w.@+*-]|\{[\w.@+*,-]+\})+\/)*(?:[\w.@+*-]|\{[\w.@+*,-]+\})+\/?)/g,
  )) {
    if (m[1].startsWith("//")) continue;
    for (const e of expandBraces(m[1])) push(e);
  }
  // Repo-relative paths with an extension: src/a/b.ts, ./dist/x.js
  for (const m of ref.matchAll(
    /(?:^|[\s,;(=[{'"`])((?:\.\/)?[A-Za-z0-9_@.-]+(?:\/[A-Za-z0-9_@.-]+)+\.[A-Za-z0-9]{1,6})(?=$|[\s,;:)\]}'"`#])/g,
  )) {
    if (/^https?:/.test(m[1])) continue;
    push(m[1]);
  }
  return out;
}

/**
 * Expand a `*` / `?` glob in the LAST path segment (`/tmp/ev/owner-*.json`).
 * Returns the path itself when it has no glob; [] when nothing matches.
 */
export function expandEvidenceGlob(abs: string, max = 8): string[] {
  const base = path.basename(abs);
  if (/[*?]/.test(path.dirname(abs))) {
    // Glob in a directory segment: expand the parent first, then the rest.
    const parents = expandEvidenceGlob(path.dirname(abs), max);
    return parents.flatMap((p) => expandEvidenceGlob(path.join(p, base), max)).slice(0, max);
  }
  if (!/[*?]/.test(base)) return [abs];
  const re = new RegExp(
    `^${base
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".")}$`,
  );
  try {
    return readdirSync(path.dirname(abs))
      .filter((f) => re.test(f))
      .sort()
      .slice(0, max)
      .map((f) => path.join(path.dirname(abs), f));
  } catch {
    return [];
  }
}

/** `a/{x,y}.png` → `a/x.png`, `a/y.png` (one level, ≤ 16 expansions). */
export function expandBraces(p: string): string[] {
  const m = p.match(/^(.*?)\{([^{}]+)\}(.*)$/);
  if (!m) return [p];
  const out: string[] = [];
  for (const alt of m[2].split(",")) {
    for (const rest of expandBraces(`${m[1]}${alt}${m[3]}`)) {
      out.push(rest);
      if (out.length >= 16) return out;
    }
  }
  return out;
}

export function resolveEvidencePath(p: string, base: string | null): string {
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  if (path.isAbsolute(p)) return p;
  return path.join(base ?? process.cwd(), p);
}

function readHead(file: string, max = MAX_READ_BYTES): { text: string; truncated: boolean } {
  const st = statSync(file);
  const len = Math.min(st.size, max);
  const buf = Buffer.alloc(len);
  const fd = openSync(file, "r");
  try {
    readSync(fd, buf, 0, len, 0);
  } finally {
    closeSync(fd);
  }
  return { text: buf.toString("utf8"), truncated: st.size > max };
}

function readTail(file: string, max = 64 * 1024): string {
  const st = statSync(file);
  const len = Math.min(st.size, max);
  const buf = Buffer.alloc(len);
  const fd = openSync(file, "r");
  try {
    readSync(fd, buf, 0, len, st.size - len);
  } finally {
    closeSync(fd);
  }
  return buf.toString("utf8");
}

function getPath(obj: unknown, dotted: string): { found: boolean; value: unknown } {
  let cur: unknown = obj;
  for (const part of dotted.split(".")) {
    if (cur && typeof cur === "object" && part in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[part];
    } else {
      return { found: false, value: undefined };
    }
  }
  return { found: true, value: cur };
}

/** Search the whole tree for a key (claims often name a leaf: `rpcUnavailable=true`). */
function findKey(obj: unknown, key: string, depth = 0): { found: boolean; value: unknown } {
  if (!obj || typeof obj !== "object" || depth > 6) return { found: false, value: undefined };
  if (!Array.isArray(obj) && key in (obj as Record<string, unknown>))
    return { found: true, value: (obj as Record<string, unknown>)[key] };
  for (const v of Object.values(obj as Record<string, unknown>)) {
    const r = findKey(v, key, depth + 1);
    if (r.found) return r;
  }
  return { found: false, value: undefined };
}

function looseEqual(actual: unknown, expected: string): boolean {
  const e = expected.trim().replace(/^["']|["']$/g, "");
  if (actual === null || actual === undefined) return e === "null" || e === "undefined";
  if (typeof actual === "boolean") return String(actual) === e.toLowerCase();
  if (typeof actual === "number") return Number(e) === actual;
  if (typeof actual === "string") return actual === e || actual.toLowerCase() === e.toLowerCase();
  // Objects: `{a:1,b:2}` style — compare each listed key.
  const inner = e.replace(/^\{|\}$/g, "");
  if (typeof actual === "object" && /[:=]/.test(inner)) {
    return inner.split(",").every((pair) => {
      const m = pair.match(/^\s*([\w.-]+)\s*[:=]\s*(.+?)\s*$/);
      if (!m) return true;
      const r = getPath(actual, m[1]);
      return r.found && looseEqual(r.value, m[2]);
    });
  }
  return JSON.stringify(actual) === e;
}

/** `a.b=value`, `key: value`, `key={x:1,y:2}` assertions mentioned in the claim text. */
export function extractFieldAssertions(
  text: string,
): Array<{ key: string; expected: string; strict: boolean }> {
  const out: Array<{ key: string; expected: string; strict: boolean }> = [];
  const re =
    /([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*)\s*(=|:)\s*(\{[^{}]*\}|"[^"]*"|'[^']*'|[\w.+-]+)/g;
  for (const m of text.matchAll(re)) {
    const key = m[1];
    // Skip prose ("Note: the ...") — only keys that look like identifiers with a value.
    if (/^(https?|note|exit|e\.g|i\.e)$/i.test(key)) continue;
    // `a=b` and dotted keys are deliberate assertions; `word: value` may be prose.
    out.push({ key, expected: m[3], strict: m[2] === "=" || key.includes(".") });
  }
  return out.slice(0, 20);
}

function summarizeJson(value: unknown): string {
  if (Array.isArray(value)) return `JSON array (${value.length} items)`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    const scalars = Object.entries(o)
      .filter(([, v]) => v === null || ["string", "number", "boolean"].includes(typeof v))
      .slice(0, 12)
      .map(
        ([k, v]) => `${k}=${typeof v === "string" ? JSON.stringify(v.slice(0, 60)) : String(v)}`,
      );
    return `JSON object keys: ${Object.keys(o).slice(0, 20).join(", ")}${scalars.length ? `; ${scalars.join(", ")}` : ""}`;
  }
  return `JSON ${typeof value}: ${String(value).slice(0, 80)}`;
}

/** Explicit failure markers in common result shapes (vitest/jest JSON, harness results). */
function jsonFailureMarkers(value: unknown): string[] {
  const out: string[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  const o = value as Record<string, unknown>;
  if (o.ok === false) out.push("ok=false");
  if (o.success === false) out.push("success=false");
  if (o.pass === false || o.passed === false) out.push("pass=false");
  if (typeof o.numFailedTests === "number" && o.numFailedTests > 0)
    out.push(`numFailedTests=${o.numFailedTests}`);
  if (typeof o.numFailedTestSuites === "number" && o.numFailedTestSuites > 0)
    out.push(`numFailedTestSuites=${o.numFailedTestSuites}`);
  return out;
}

/**
 * Inspect one evidence file. `claimText` is the claim + ref: its
 * `field=value` assertions are checked against JSON files.
 */
export function inspectEvidenceFile(
  abs: string,
  runStartedAt: number,
  claimText = "",
): EvidenceFileCheck {
  if (!existsSync(abs)) return { path: abs, status: "fail", detail: "file does not exist" };
  let st;
  try {
    st = statSync(abs);
  } catch (err) {
    return { path: abs, status: "fail", detail: `unreadable: ${String(err)}` };
  }
  if (st.isDirectory()) {
    let n = 0;
    try {
      n = readdirSync(abs).length;
    } catch {
      /* unreadable dir */
    }
    return { path: abs, status: "pass", detail: `directory exists (${n} entries)` };
  }
  const fresh = st.mtimeMs + MTIME_SLACK_MS >= runStartedAt;
  const when = new Date(st.mtimeMs).toISOString();
  if (IMAGE_EXT_RE.test(abs)) {
    if (st.size < 1024)
      return {
        path: abs,
        status: "fail",
        detail: `empty or tiny image (${st.size} bytes)`,
        isImage: true,
      };
    return {
      path: abs,
      status: fresh ? "pass" : "fail",
      detail: fresh
        ? `image ${Math.round(st.size / 1024)} KB, written ${when}`
        : `image older than the run (${when})`,
      isImage: true,
    };
  }
  if (st.size === 0) return { path: abs, status: "fail", detail: "file is empty" };
  const age = fresh ? `written ${when}` : `older than the run start (${when})`;

  if (/\.json$/i.test(abs)) {
    const { text, truncated } = readHead(abs);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return {
        path: abs,
        status: truncated ? "warn" : "fail",
        detail: truncated
          ? `JSON too large to verify (${Math.round(st.size / 1024)} KB), ${age}`
          : "not valid JSON",
        excerpt: text.slice(0, EXCERPT_CAP),
      };
    }
    const checks = extractFieldAssertions(claimText);
    const matched: string[] = [];
    const mismatched: string[] = [];
    const softMismatched: string[] = [];
    for (const c of checks) {
      const r = c.key.includes(".") ? getPath(parsed, c.key) : findKey(parsed, c.key);
      const r2 = r.found || !c.key.includes(".") ? r : findKey(parsed, c.key.split(".").pop()!);
      if (!r2.found) continue;
      if (looseEqual(r2.value, c.expected)) matched.push(`${c.key}=${c.expected}`);
      else
        (c.strict ? mismatched : softMismatched).push(
          `${c.key}: claimed ${c.expected}, file has ${JSON.stringify(r2.value)?.slice(0, 80)}`,
        );
    }
    const markers = jsonFailureMarkers(parsed);
    const summary = summarizeJson(parsed);
    const excerpt = `${summary}\n${JSON.stringify(parsed, null, 1).slice(0, EXCERPT_CAP)}`;
    if (mismatched.length) {
      return {
        path: abs,
        status: "fail",
        detail: `JSON contradicts the claim: ${mismatched.slice(0, 4).join("; ")}`,
        excerpt,
      };
    }
    const parts = [
      matched.length
        ? `${matched.length} claimed field(s) match (${matched.slice(0, 4).join(", ")})`
        : summary.slice(0, 200),
      markers.length ? `failure markers present: ${markers.join(", ")}` : "",
      softMismatched.length ? `possible mismatch: ${softMismatched.slice(0, 2).join("; ")}` : "",
      age,
    ].filter(Boolean);
    return {
      path: abs,
      status: markers.length || softMismatched.length || !fresh ? "warn" : "pass",
      detail: parts.join("; "),
      excerpt,
    };
  }

  // Text / log: tail it.
  const tail = readTail(abs).split("\n").slice(-TAIL_LINES).join("\n").slice(-EXCERPT_CAP);
  const failed =
    /\b[1-9]\d* (?:failed|failing)\b|\bERR!|Build failed|error TS\d+|exit(?:ed)? (?:with )?code [1-9]/i.test(
      tail,
    );
  return {
    path: abs,
    status: failed ? "warn" : fresh ? "pass" : "warn",
    detail: `${Math.max(1, Math.round(st.size / 1024))} KB text, ${age}${failed ? "; tail mentions failures" : ""}`,
    excerpt: tail,
  };
}

const RANK: Record<EvidenceStatus, number> = { pass: 0, skipped: 1, warn: 2, fail: 3 };

/** Worst status across checks (fail > warn > skipped > pass). */
export function worstStatus(checks: Array<{ status: EvidenceStatus }>): EvidenceStatus {
  return checks.reduce<EvidenceStatus>((w, c) => (RANK[c.status] > RANK[w] ? c.status : w), "pass");
}
