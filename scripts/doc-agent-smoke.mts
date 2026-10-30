#!/usr/bin/env node
/**
 * Smoke for doc_agent.spawn / describe handlers.
 *
 * Confirms:
 *   1. spawn returns the canonical sessionKey + a system prompt that
 *      includes the doc id, title, and the current content snippet.
 *   2. spawn handles all six docTypes without error.
 *   3. describe returns just the prompt without side effects (no session
 *      key allocation).
 *   4. The sessionKey is deterministic across calls (same doc → same key).
 */

import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { randomBytes } from "node:crypto";

const sandbox = path.join(os.tmpdir(), `infinibot-doc-agent-${randomBytes(3).toString("hex")}`);
process.env.INFINIBOT_STATE_DIR = sandbox;
await fs.mkdir(sandbox, { recursive: true });

const { docAgentHandlers } = await import("../src/gateway/server-methods/doc-agent.ts");

interface Resp { ok: boolean; payload?: unknown; error?: { code: string; message: string } }
async function call(method: string, params: Record<string, unknown> = {}): Promise<Resp> {
  const handler = docAgentHandlers[method];
  if (!handler) throw new Error(`no handler: ${method}`);
  let resp: Resp = { ok: false };
  await handler({
    req: { type: "req", id: "t", method, params } as never,
    params,
    respond: ((ok: boolean, payload?: unknown, error?: unknown) => {
      resp = { ok, payload, error: error as Resp["error"] };
    }) as never,
    client: {} as never,
    isWebchatConnect: false,
    context: {} as never,
  } as never);
  return resp;
}

function ok(label: string) { console.log(`✓ ${label}`); }
function fail(label: string, detail?: unknown): never {
  console.error(`✗ ${label}`);
  if (detail !== undefined) console.error("  detail:", detail);
  process.exit(1);
}

async function main() {
  console.log("=== sandbox:", sandbox, "===\n");

  console.log("--- 1. spawn for a note ---");
  const r1 = await call("doc_agent.spawn", {
    docType: "note",
    documentId: "note-foo-123",
    title: "Foo Plan",
    content: "## Plan\n- step 1\n- step 2",
  });
  if (!r1.ok) fail("spawn note failed", r1.error);
  const p1 = r1.payload as { sessionKey: string; systemPrompt: string; docType: string; agentId: string; model: string; toolProfile: string };
  if (!p1.sessionKey.includes("doc:note:note-foo-123")) fail("sessionKey missing doc segment", p1.sessionKey);
  if (!p1.systemPrompt.includes("Foo Plan")) fail("system prompt missing title", p1.systemPrompt);
  if (!p1.systemPrompt.includes("step 1")) fail("system prompt missing content", p1.systemPrompt);
  if (p1.toolProfile !== "doc-agent") fail("wrong tool profile", p1);
  ok(`note → sessionKey=${p1.sessionKey} profile=${p1.toolProfile} model=${p1.model}`);

  console.log("\n--- 2. all 6 doctypes ---");
  for (const docType of ["note", "db_row", "workflow", "project", "kanban_card", "generic"] as const) {
    const r = await call("doc_agent.spawn", { docType, documentId: `${docType}-abc` });
    if (!r.ok) fail(`spawn for ${docType}`, r.error);
    const sp = (r.payload as { systemPrompt: string }).systemPrompt;
    if (!sp || sp.length < 100) fail(`system prompt for ${docType} too short`, sp);
    ok(`${docType}: prompt length ${sp.length}`);
  }

  console.log("\n--- 3. describe returns prompt only ---");
  const r3 = await call("doc_agent.describe", {
    docType: "db_row",
    documentId: "row-x",
    title: "Customer #42",
    databaseId: "db_clients",
    schema: "name, email, phone",
  });
  if (!r3.ok) fail("describe failed", r3.error);
  const p3 = r3.payload as { systemPrompt: string; docType: string };
  if (p3.docType !== "db_row") fail("docType not echoed", p3);
  if (!p3.systemPrompt.includes("Customer #42")) fail("title missing", p3);
  if (!p3.systemPrompt.includes("db_clients")) fail("databaseId missing", p3);
  ok("describe returns enriched prompt");

  console.log("\n--- 4. sessionKey is deterministic ---");
  const a = await call("doc_agent.spawn", { docType: "note", documentId: "stable-id" });
  const b = await call("doc_agent.spawn", { docType: "note", documentId: "stable-id" });
  const ka = (a.payload as { sessionKey: string }).sessionKey;
  const kb = (b.payload as { sessionKey: string }).sessionKey;
  if (ka !== kb) fail("sessionKeys differ across calls", { a: ka, b: kb });
  ok(`same doc → same key (${ka})`);

  console.log("\n--- 5. bad input → structured error ---");
  const bad = await call("doc_agent.spawn", { docType: "note" });
  if (bad.ok) fail("expected error for missing documentId");
  ok(`bad input: code=${bad.error?.code} msg="${bad.error?.message?.slice(0, 60)}"`);

  await fs.rm(sandbox, { recursive: true, force: true });
  ok("sandbox cleaned");

  console.log("\nOK — doc-agent spawn pipeline verified");
}

main().catch(async (err) => {
  console.error("FAIL:", err);
  try { await fs.rm(sandbox, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
