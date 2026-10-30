/**
 * One-shot, idempotent: the owner's request from secure chat — rename the
 * WhatsApp-named secure files to descriptive names and put them in a
 * "Wealth Building" collection, linked to the secure project
 * sp_be357ca63db140e9. The mapping comes from secure task
 * st_90fdbd7de0624a66 (written by INFINI when it could not do the rename).
 *
 * Talks to a gateway over the normal authenticated WS RPCs only (secure lane,
 * nothing leaves the vault). Never deletes a file. Near-duplicates are only
 * flagged (tag "needs-review" + a note) for the owner to decide.
 *
 *   tsx scripts/secure-files-wealth-building.mts --peek     # show task + files, change nothing
 *   tsx scripts/secure-files-wealth-building.mts            # DRY RUN: print the plan
 *   tsx scripts/secure-files-wealth-building.mts --apply    # do it (needs the organise RPCs)
 *
 * Options: --url ws://127.0.0.1:18789 (default), --task <id>, --project <id>,
 * --collection "Wealth Building", --mapping <file.json> ({"old": "new", …}).
 * Auth: INFINIBOT_GATEWAY_PASSWORD / INFINIBOT_GATEWAY_TOKEN, else read from
 * ~/.infinibot/infinibot.json (read-only).
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(`--${n}`);
const opt = (n: string, d: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const URL = opt("url", "ws://127.0.0.1:18789");
const TASK = opt("task", "st_90fdbd7de0624a66");
const PROJECT = opt("project", "sp_be357ca63db140e9");
const COLLECTION = opt("collection", "Wealth Building");
const MAPPING_FILE = opt("mapping", "");
const APPLY = flag("apply");
const PEEK = flag("peek");

function auth(): { password?: string; token?: string } {
  if (process.env.INFINIBOT_GATEWAY_PASSWORD) return { password: process.env.INFINIBOT_GATEWAY_PASSWORD };
  if (process.env.INFINIBOT_GATEWAY_TOKEN) return { token: process.env.INFINIBOT_GATEWAY_TOKEN };
  const raw = readFileSync(join(homedir(), ".infinibot", "infinibot.json"), "utf8");
  // JSON5-tolerant enough for the auth block: strip comments + trailing commas.
  const cfg = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1"));
  const a = cfg?.gateway?.auth ?? {};
  return a.password ? { password: a.password } : { token: a.token };
}

const { callGateway } = await import("../src/gateway/call.js");
const creds = auth();
async function rpc<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  return callGateway<T>({ url: URL, ...creds, config: { gateway: { mode: "local" } } as never, method, params, timeoutMs: 60_000 });
}

type Entry = { id: string; name: string; size: number; status: string; sha256?: string; displayName?: string | null; collectionId?: string | null; collectionPath?: string; tags?: string[]; projectId?: string | null; notes?: string };

const norm = (s: string) => s.normalize("NFKC").trim().toLowerCase().replace(/[  ]/g, " ").replace(/\s+/g, " ");
const stem = (s: string) => norm(s).replace(/\.[a-z0-9]{2,5}$/, "");

/** Pull "old → new" pairs out of the task text (arrows, "=>", "->", md tables, JSON). */
export function parseMapping(text: string): Array<{ from: string; to: string }> {
  const out: Array<{ from: string; to: string }> = [];
  const clean = (s: string) => s.trim().replace(/^[-*•\d.)\s]+/, "").replace(/^[`"'“”*_]+|[`"'“”*_]+$/g, "").trim();
  const json = /\{[\s\S]*\}/.exec(text);
  if (json) {
    try {
      const obj = JSON.parse(json[0]);
      for (const [k, v] of Object.entries(obj)) if (typeof v === "string") out.push({ from: k, to: v });
      if (out.length) return out;
    } catch {
      /* not JSON */
    }
  }
  for (const line of text.split("\n")) {
    const row = /^\s*\|(.+)\|\s*$/.exec(line);
    if (row) {
      const cells = row[1].split("|").map(clean).filter(Boolean);
      if (cells.length >= 2 && !/^-+$/.test(cells[0]) && !/^(old|original|current|from|file)/i.test(cells[0])) out.push({ from: cells[0], to: cells[cells.length - 1] });
      continue;
    }
    const m = /^(.+?)\s*(?:→|->|=>|⟶|➜|➔|:=)\s*(.+)$/.exec(line);
    if (m) {
      const from = clean(m[1]);
      const to = clean(m[2]);
      // Only file-name pairs ("MAPPING (old name -> new name):" is a header, not a pair).
      if (from && to && /\.[a-z0-9]{2,5}$/i.test(from) && /\.[a-z0-9]{2,5}$/i.test(to)) out.push({ from, to });
    }
  }
  return out;
}

function match(entries: Entry[], from: string): Entry[] {
  const exact = entries.filter((e) => e.name === from || e.id === from);
  if (exact.length) return exact;
  const n = norm(from);
  const byNorm = entries.filter((e) => norm(e.name) === n || (e.displayName && norm(e.displayName) === n));
  if (byNorm.length) return byNorm;
  const s = stem(from);
  return entries.filter((e) => stem(e.name) === s);
}

/**
 * Duplicates: two target files with identical bytes (same sha256; same size
 * if a hash is missing), e.g. the "…21.5" / "…21.l" videos. Flagged for the
 * owner, never deleted.
 */
function nearDuplicates(entries: Entry[]): Array<[Entry, Entry]> {
  const pairs: Array<[Entry, Entry]> = [];
  const seen = new Set<string>();
  const push = (a: Entry, b: Entry) => {
    const k = [a.id, b.id].sort().join("|");
    if (seen.has(k)) return;
    seen.add(k);
    pairs.push([a, b]);
  };
  // Byte-identical (same sha256) — or same size when a hash is missing.
  const same = (a: Entry, b: Entry) => (a.sha256 && b.sha256 ? a.sha256 === b.sha256 : a.size > 0 && a.size === b.size);
  for (let i = 0; i < entries.length; i++) for (let j = i + 1; j < entries.length; j++) if (same(entries[i], entries[j])) push(entries[i], entries[j]);
  return pairs;
}

const status = await rpc<any>("secure.status");
if (!status.enabled || !status.unlocked) throw new Error("Secure Mode is off or locked on this gateway; unlock it first");
const kanban = await rpc<any>("secure.kanban.list");
const task = kanban.tasks?.find((t: any) => t.id === TASK);
const project = kanban.projects?.find((p: any) => p.id === PROJECT);
const list = await rpc<{ entries: Entry[]; organize?: boolean }>("files.secure.list", { limit: 2000 });
const entries = list.entries;

if (PEEK) {
  console.log(JSON.stringify({ secure: { enabled: status.enabled, unlocked: status.unlocked }, organize: list.organize === true, project: project ?? null, task: task ?? null, files: entries.map((e) => ({ id: e.id, name: e.name, size: e.size, status: e.status, displayName: e.displayName, collection: e.collectionPath })) }, null, 2));
  process.exit(0);
}

const mappingText = MAPPING_FILE ? readFileSync(MAPPING_FILE, "utf8") : `${task?.title ?? ""}\n${task?.description ?? ""}\n${task?.notes ?? ""}`;
const mapping = parseMapping(mappingText);
if (!mapping.length) throw new Error(`no "old → new" mapping found in ${MAPPING_FILE || `task ${TASK}`}; pass --mapping file.json`);

type Step = { id: string; from: string; to: string; action: "rename" | "skip-same" };
const steps: Step[] = [];
const unmatched: string[] = [];
const ambiguous: Array<{ from: string; ids: string[] }> = [];
for (const m of mapping) {
  const hits = match(entries, m.from);
  if (!hits.length) unmatched.push(m.from);
  else if (hits.length > 1) ambiguous.push({ from: m.from, ids: hits.map((h) => h.id) });
  else steps.push({ id: hits[0].id, from: hits[0].name, to: m.to, action: hits[0].displayName === m.to ? "skip-same" : "rename" });
}
const targetIds = [...new Set(steps.map((s) => s.id))];
const dups = nearDuplicates(entries.filter((e) => targetIds.includes(e.id)));

const plan = {
  mode: APPLY ? "apply" : "dry-run",
  gateway: URL,
  organizeRpcs: list.organize === true,
  task: task ? { id: task.id, title: task.title, status: task.status } : `NOT FOUND (${TASK})`,
  project: project ? { id: project.id, name: project.name } : `NOT FOUND (${PROJECT})`,
  collection: COLLECTION,
  renames: steps,
  moveIntoCollection: targetIds.length,
  unmatched,
  ambiguous,
  nearDuplicates: dups.map(([a, b]) => ({ identicalBytes: Boolean(a.sha256 && a.sha256 === b.sha256), a: { id: a.id, name: a.name, size: a.size }, b: { id: b.id, name: b.name, size: b.size }, action: "flag only (tag needs-review + note); NOT deleted — ask the owner" })),
};
console.log(JSON.stringify(plan, null, 2));

if (!APPLY) {
  console.log("\nDRY RUN — nothing changed. Re-run with --apply after the gateway restart.");
  process.exit(0);
}
if (list.organize !== true) {
  console.error("This gateway predates Secure Files organisation (files.secure.list has no organize:true). Restart it on the new build, then re-run.");
  process.exit(2);
}

// ── apply (idempotent) ──────────────────────────────────────────────────
const cols = await rpc<any>("files.secure.collections.list");
let col = cols.collections.find((c: any) => !c.parentId && norm(c.name) === norm(COLLECTION));
if (!col) col = (await rpc<any>("files.secure.collections.create", { name: COLLECTION })).collection;
const failures: Array<{ id: string; error: string }> = [];
for (const s of steps) {
  if (s.action !== "rename") continue;
  try {
    await rpc("files.secure.update", { id: s.id, name: s.to });
  } catch (err) {
    failures.push({ id: s.id, error: String((err as Error).message ?? err) });
  }
}
if (targetIds.length) {
  await rpc("files.secure.bulkUpdate", { ids: targetIds, collectionId: col.id, ...(project ? { projectId: PROJECT } : {}) });
}
for (const [a, b] of dups) {
  await rpc("files.secure.bulkUpdate", { ids: [a.id, b.id], addTags: ["needs-review"] });
  for (const [x, y] of [[a, b], [b, a]] as const) {
    const cur = entries.find((e) => e.id === x.id)?.notes ?? "";
    const line = `${x.sha256 && x.sha256 === y.sha256 ? "Byte-identical copy" : "Possible duplicate"} of "${y.name}" (${y.size} bytes). Kept; owner to decide.`;
    if (!cur.includes(line)) await rpc("files.secure.update", { id: x.id, notes: cur ? `${cur}\n${line}` : line });
  }
}

// Verify from the gateway's own state, not from what we sent.
const after = (await rpc<{ entries: Entry[] }>("files.secure.list", { limit: 2000 })).entries;
const byId = new Map(after.map((e) => [e.id, e]));
const verified = steps.map((s) => {
  const e = byId.get(s.id);
  return { id: s.id, from: s.from, want: s.to, displayName: e?.displayName ?? null, collection: e?.collectionPath ?? "", projectId: e?.projectId ?? null, ok: e?.displayName === s.to && e?.collectionId === col.id };
});
const okCount = verified.filter((v) => v.ok).length;
const report = { collection: { id: col.id, name: col.name }, verified, okCount, total: steps.length, failures, unmatched, ambiguous, nearDuplicates: plan.nearDuplicates };
console.log(JSON.stringify(report, null, 2));

// Close the autonomy task honestly with what the gateway now reports.
const alreadyClosed = task?.status === "done" && String(task?.description ?? "").includes("Executed by scripts/secure-files-wealth-building.mts");
if (task && alreadyClosed) console.log(`\ntask ${task.id} already closed with a verified result; left as is`);
if (task && !alreadyClosed) {
  const done = okCount === steps.length && !unmatched.length && !ambiguous.length;
  const note = [
    `Executed by scripts/secure-files-wealth-building.mts on ${new Date().toISOString()} (verified by re-reading files.secure.list).`,
    `${okCount}/${steps.length} files renamed and in the "${col.name}" collection${project ? `, linked to project ${project.name}` : ""}.`,
    ...(failures.length ? [`Failed: ${failures.map((f) => `${f.id} (${f.error})`).join("; ")}`] : []),
    ...(unmatched.length ? [`No secure file matched: ${unmatched.join("; ")}`] : []),
    ...(ambiguous.length ? [`Ambiguous (not renamed): ${ambiguous.map((a) => a.from).join("; ")}`] : []),
    ...(dups.length ? [`Flagged near-duplicates for the owner (not deleted): ${dups.map(([a, b]) => `${a.name} / ${b.name}`).join("; ")}`] : []),
  ].join("\n");
  await rpc("secure.kanban.tasks.update", { id: task.id, status: done ? "done" : "blocked", description: `${task.description ?? ""}\n\n---\n${note}`.trim() });
  console.log(`\ntask ${task.id} → ${done ? "done" : "blocked"} with the verified result`);
}
process.exit(okCount === steps.length && !failures.length ? 0 : 1);
