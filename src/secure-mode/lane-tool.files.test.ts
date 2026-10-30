import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveOcrConfig } from "../ocr/local-only.js";
import { setOcrServiceForTests } from "../ocr/runtime.js";
import { OcrService } from "../ocr/service.js";
import { extractToolActivity, type RawTranscriptMessage } from "../shared/group-chat/activity.js";
import { SecureLaneStore } from "./lane-store.js";
import { createSecureLaneTool } from "./lane-tool.js";
import { setSecureModeRuntimeForTests } from "./runtime.js";
import { secureReplyTruthNote } from "./truth-check.js";
import { SecureVault } from "./vault.js";

let dir: string;
let vault: SecureVault;
let svc: OcrService;
let lane: SecureLaneStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "secure-lane-files-"));
  vault = new SecureVault(randomBytes(32), path.join(dir, "vault"));
  lane = new SecureLaneStore(vault, Date.now);
  svc = new OcrService({
    stateDir: dir,
    cfg: resolveOcrConfig({}),
    engines: { vl: null, ocrEngineName: async () => null } as never,
    secureVault: () => vault,
  });
  setOcrServiceForTests(svc);
  setSecureModeRuntimeForTests({
    isUnlocked: () => true,
    requireVault: () => vault,
    requireLane: () => lane,
  } as never);
});
afterEach(() => {
  setOcrServiceForTests(null);
  setSecureModeRuntimeForTests(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

const tool = createSecureLaneTool();
async function run(args: Record<string, unknown>) {
  const r = (await tool.execute("t1", args as never, undefined as never, undefined as never)) as {
    content: Array<{ text: string }>;
  };
  return JSON.parse(r.content[0].text);
}
function put(name: string) {
  return svc.enqueueSecure({ name, data: Buffer.from(name), source: { kind: "secure-files" } }).id;
}

describe("secure_lane file organisation", () => {
  it("renames, moves (creating the collection), tags and sets the project — real state back", async () => {
    const a = put("WhatsApp Video 2026-10-01 at 21.15.mp4");
    const b = put("WhatsApp Image 2026-10-02 at 09.00.jpeg");
    const project = lane.createProject({ name: "Wealth Building" });

    const ren = await run({
      action: "rename_file",
      file: "whatsapp video 2026-10-01 at 21.15.mp4",
      name: "Compound interest explainer",
    });
    expect(ren).toMatchObject({ ok: true, changed: 1 });
    expect(ren.files[0]).toMatchObject({ id: a, displayName: "Compound interest explainer" });

    const mv = await run({
      action: "move_files",
      files: [a, b],
      collection: "Wealth Building",
      createCollection: true,
    });
    expect(mv).toMatchObject({ ok: true, changed: 2 });
    expect(mv.files.map((f: any) => f.collection)).toEqual(["Wealth Building", "Wealth Building"]);

    // Same move again: nothing really changes, and the result says so.
    expect(
      await run({ action: "move_files", files: [a, b], collection: "wealth building" }),
    ).toMatchObject({ ok: true, changed: 0, unchanged: 2 });

    expect(
      await run({ action: "tag_files", files: [a, b], tags: ["finance", "#Finance", "video"] }),
    ).toMatchObject({ changed: 2 });
    const sp = await run({ action: "set_project", files: [a, b], project: "wealth building" });
    expect(sp.files.every((f: any) => f.projectId === project.id)).toBe(true);

    const cols = await run({ action: "list_collections" });
    expect(cols.collections).toEqual([
      expect.objectContaining({ name: "Wealth Building", files: 2 }),
    ]);
    const listed = await run({
      action: "list_files",
      collection: "Wealth Building",
      tag: "finance",
    });
    expect(listed.files).toHaveLength(2);
  });

  it("fails honestly: unknown file / collection changes nothing and says ok:false", async () => {
    const a = put("a.png");
    const bad = await run({
      action: "move_files",
      files: [a, "nope.png"],
      collection: "X",
      createCollection: true,
    });
    expect(bad).toMatchObject({ ok: false, status: "error", changed: 0 });
    expect(bad.error).toMatch(/no secure file "nope.png"/);
    expect((await run({ action: "list_collections" })).collections).toEqual([]);
    expect(await run({ action: "move_files", files: [a], collection: "Missing" })).toMatchObject({
      ok: false,
    });
    expect(await run({ action: "rename_file", files: [a] })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/name/),
    });
  });

  it("deleting a collection keeps its files", async () => {
    const a = put("a.png");
    await run({ action: "move_files", files: [a], collection: "Tmp", createCollection: true });
    const del = await run({ action: "delete_collection", collection: "Tmp" });
    expect(del).toMatchObject({ ok: true, movedFiles: 1 });
    expect((await run({ action: "list_files" })).files[0]).toMatchObject({
      id: a,
      collection: "Unfiled",
    });
  });
});

function call(id: string, name: string, args: Record<string, unknown>): RawTranscriptMessage {
  return { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] };
}
function result(id: string, name: string, body: unknown): RawTranscriptMessage {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: name,
    content: [{ type: "text", text: JSON.stringify(body) }],
  };
}

describe("secure chat truth guard", () => {
  // The INFINI failure: project + task created, no file touched, then "Done".
  const infiniTurn = extractToolActivity([
    call("1", "secure_lane", { action: "create_project", name: "Wealth Building" }),
    result("1", "secure_lane", { ok: true, project: { id: "sp_be357ca63db140e9" } }),
    call("2", "secure_lane", { action: "create_task", title: "Rename and group 14 files" }),
    result("2", "secure_lane", { ok: true, task: { id: "st_90fdbd7de0624a66" } }),
  ]);

  it("flags 'renamed and grouped' when only a project and a task were created", () => {
    const v = secureReplyTruthNote({
      reply: "Done! I renamed all 14 files and grouped them into the Wealth Building folder.",
      activity: infiniTurn,
    });
    expect(v?.flags.map((f) => f.kind)).toEqual(["organize"]);
    expect(v?.note).toMatch(/UNVERIFIED/);
    expect(v?.note).toMatch(/no rename\/move\/tag tool call changed any file/);
  });

  it("still accepts the honest parts (task created) without a flag", () => {
    expect(
      secureReplyTruthNote({
        reply: "I created a task in the Wealth Building project with the rename mapping.",
        activity: infiniTurn,
      }),
    ).toBeNull();
  });

  it("flags a rename claim when the rename call changed nothing", () => {
    const zero = extractToolActivity([
      call("1", "secure_lane", { action: "move_files", files: ["a"], collection: "W" }),
      result("1", "secure_lane", { ok: true, changed: 0, unchanged: 1, files: [] }),
    ]);
    const v = secureReplyTruthNote({ reply: "Moved the file into W.", activity: zero });
    expect(v?.flags[0].reason).toMatch(/changed no file/);
    const failed = extractToolActivity([
      call("1", "secure_lane", { action: "rename_file", file: "a", name: "b" }),
      result("1", "secure_lane", {
        ok: false,
        status: "error",
        error: "no secure file",
        changed: 0,
      }),
    ]);
    expect(
      secureReplyTruthNote({ reply: "Renamed it to b.", activity: failed })?.flags[0].kind,
    ).toBe("organize");
  });

  it("passes when the tools really renamed and moved the files", () => {
    const real = extractToolActivity([
      call("1", "secure_lane", { action: "rename_file", file: "a", name: "b" }),
      result("1", "secure_lane", { ok: true, changed: 1, files: [] }),
      call("2", "secure_lane", {
        action: "move_files",
        files: ["a"],
        collection: "W",
        createCollection: true,
      }),
      result("2", "secure_lane", { ok: true, changed: 1, files: [] }),
    ]);
    expect(
      secureReplyTruthNote({
        reply: "Done — renamed the file and moved it into Wealth Building.",
        activity: real,
      }),
    ).toBeNull();
  });

  it("does not treat 'moved the task to Done' as a file claim", () => {
    const board = extractToolActivity([
      call("1", "secure_lane", { action: "update_task", id: "st_1", status: "done" }),
      result("1", "secure_lane", { ok: true, task: { id: "st_1" } }),
    ]);
    expect(
      secureReplyTruthNote({ reply: "I moved the task to Done.", activity: board }),
    ).toBeNull();
  });
});
