import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { studioBlocksToMarkdown, studioMarkdownToBlocks } from "./blocks.js";
import { createPipelineHandlers } from "./pipeline-methods.js";
import { ContentPipelineStore, DEFAULT_STAGES, PIPELINE_SCHEMA_VERSION } from "./pipeline-store.js";
import { createContentPipelineTool } from "./pipeline-tool.js";
import { getContentStudio, resetContentStudios, type ContentStudio } from "./studio.js";

const tmpDirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-pipe-"));
  tmpDirs.push(dir);
  return dir;
}

const prevState = process.env.INFINIBOT_STATE_DIR;
afterEach(() => {
  resetContentStudios();
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  if (prevState === undefined) delete process.env.INFINIBOT_STATE_DIR;
  else process.env.INFINIBOT_STATE_DIR = prevState;
});

// A 1×1 PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

type Rpc = <T = any>(method: string, params?: Record<string, unknown>) => Promise<T>;

function rpcFor(studio: ContentStudio): Rpc {
  const handlers = createPipelineHandlers(() => studio) as Record<string, any>;
  return (method, params = {}) =>
    new Promise((resolve, reject) => {
      const h = handlers[method];
      if (!h) return reject(new Error(`no handler ${method}`));
      void h({
        params,
        req: { type: "req", id: "1", method },
        client: null,
        isWebchatConnect: () => false,
        context: {},
        respond: (ok: boolean, payload: unknown, error?: { code: string; message: string }) =>
          ok ? resolve(payload as never) : reject(Object.assign(new Error(error?.message), error)),
      });
    });
}

describe("pipeline store", () => {
  let dir: string;
  let studio: ContentStudio;
  let rpc: Rpc;
  beforeEach(() => {
    dir = tmp();
    studio = getContentStudio(dir);
    rpc = rpcFor(studio);
  });

  it("creates the schema and seeds the default stages exactly once", async () => {
    const board = await rpc("content-studio.board.get");
    expect(board.stages.map((s: any) => s.name)).toEqual(DEFAULT_STAGES.map((s) => s.name));
    expect(board.stages.map((s: any) => s.position)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(board.stages.at(-1).isDone).toBe(true);
    expect(board.items).toEqual([]);
    expect(studio.store.db.pragma("user_version", { simple: true })).toBe(PIPELINE_SCHEMA_VERSION);

    // Reopening the file neither re-seeds nor resurrects deleted stages.
    await rpc("content-studio.stages.delete", { stageId: board.stages[3].id });
    resetContentStudios();
    const again = new ContentPipelineStore(path.join(dir, "studio.db"));
    expect(again.listStages().map((s) => s.name)).toEqual([
      "Idea",
      "Script",
      "Produce",
      "Schedule",
      "Published",
    ]);
    again.close();
  });

  it("adds, renames, recolours, sets WIP and reorders stages", async () => {
    const { stage } = await rpc("content-studio.stages.create", {
      name: "Review",
      color: "#ff0000",
      wipLimit: 2,
      index: 1,
    });
    let board = await rpc("content-studio.board.get");
    expect(board.stages.map((s: any) => s.name)).toEqual([
      "Idea",
      "Review",
      "Script",
      "Produce",
      "Edit",
      "Schedule",
      "Published",
    ]);
    const upd = await rpc("content-studio.stages.update", {
      stageId: stage.id,
      name: "Approval",
      color: "not-a-colour",
      wipLimit: 0,
    });
    expect(upd.stage).toMatchObject({ name: "Approval", color: "#ff0000", wipLimit: null });

    const order = board.stages.map((s: any) => s.id).reverse();
    const re = await rpc("content-studio.stages.reorder", { order });
    expect(re.stages.map((s: any) => s.id)).toEqual(order);
    expect(re.stages.map((s: any) => s.position)).toEqual([0, 1, 2, 3, 4, 5, 6]);

    await expect(rpc("content-studio.stages.reorder", { order: order.slice(1) })).rejects.toThrow(
      /every stage id/,
    );
    await expect(
      rpc("content-studio.stages.update", { stageId: stage.id, name: " " }),
    ).rejects.toThrow(/cannot be empty/);
    await expect(rpc("content-studio.stages.create", { name: "" })).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
    board = await rpc("content-studio.board.get");
    expect(board.stages[0].name).toBe("Published");
  });

  it("flags stages over their WIP limit", async () => {
    const [idea] = studio.store.listStages();
    await rpc("content-studio.stages.update", { stageId: idea!.id, wipLimit: 1 });
    await rpc("content-studio.items.create", { title: "A" });
    let board = await rpc("content-studio.board.get");
    expect(board.stages[0]).toMatchObject({ count: 1, wipLimit: 1, overWip: false });
    await rpc("content-studio.items.create", { title: "B" });
    board = await rpc("content-studio.board.get");
    expect(board.stages[0]).toMatchObject({ count: 2, overWip: true });
  });

  it("moves items between stages and reorders within a stage with dense positions", async () => {
    const stages = studio.store.listStages();
    const [idea, script] = [stages[0]!, stages[1]!];
    const ids: string[] = [];
    for (const t of ["one", "two", "three", "four"]) {
      ids.push((await rpc("content-studio.items.create", { title: t })).item.id);
    }
    const titles = (stageId: string) =>
      studio.store.listItems(stageId).map((i) => `${i.position}:${i.title}`);
    expect(titles(idea.id)).toEqual(["0:one", "1:two", "2:three", "3:four"]);

    // Reorder within a stage: "four" to the top.
    await rpc("content-studio.items.move", { itemId: ids[3], toStageId: idea.id, toIndex: 0 });
    expect(titles(idea.id)).toEqual(["0:four", "1:one", "2:two", "3:three"]);

    // Cross-stage move into the middle of a stage.
    await rpc("content-studio.items.move", { itemId: ids[0], toStageId: script.id });
    await rpc("content-studio.items.move", { itemId: ids[2], toStageId: script.id });
    const moved = await rpc("content-studio.items.move", {
      itemId: ids[1],
      toStageId: script.id,
      toIndex: 1,
    });
    expect(moved.item.stageId).toBe(script.id);
    expect(moved.item.stageEnteredAt).toBeGreaterThan(0);
    expect(titles(idea.id)).toEqual(["0:four"]);
    expect(titles(script.id)).toEqual(["0:one", "1:two", "2:three"]);

    // Out-of-range index clamps to the end.
    await rpc("content-studio.items.move", { itemId: ids[3], toStageId: script.id, toIndex: 99 });
    expect(titles(script.id)).toEqual(["0:one", "1:two", "2:three", "3:four"]);
    expect(titles(idea.id)).toEqual([]);

    // Deleting re-packs the stage.
    await rpc("content-studio.items.delete", { itemId: ids[1] });
    expect(titles(script.id)).toEqual(["0:one", "1:three", "2:four"]);
    await expect(
      rpc("content-studio.items.move", { itemId: "nope", toStageId: idea.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("deleting a non-empty stage needs a destination and keeps item order", async () => {
    const [idea, script] = studio.store.listStages();
    await rpc("content-studio.items.create", { title: "s1", stageId: script!.id });
    await rpc("content-studio.items.create", { title: "i1" });
    await rpc("content-studio.items.create", { title: "i2" });
    await expect(rpc("content-studio.stages.delete", { stageId: idea!.id })).rejects.toThrow(
      /pass moveItemsTo/,
    );
    const res = await rpc("content-studio.stages.delete", {
      stageId: idea!.id,
      moveItemsTo: script!.id,
    });
    expect(res.movedItems).toBe(2);
    expect(studio.store.listItems(script!.id).map((i) => [i.position, i.title])).toEqual([
      [0, "s1"],
      [1, "i1"],
      [2, "i2"],
    ]);
    // Never delete the last stage.
    for (const s of studio.store.listStages().slice(1)) {
      await rpc("content-studio.stages.delete", { stageId: s.id, moveItemsTo: script!.id });
    }
    expect(studio.store.listStages().length).toBe(1);
    await expect(
      rpc("content-studio.stages.delete", { stageId: studio.store.listStages()[0]!.id }),
    ).rejects.toThrow(/at least one stage/);
  });

  it("updates item metadata", async () => {
    const { item } = await rpc("content-studio.items.create", {
      title: "Hook test",
      platform: "instagram",
      tags: ["ai", "ai", " ", "hooks"],
      dueAt: "2026-10-10T09:00:00Z",
    });
    expect(item.tags).toEqual(["ai", "hooks"]);
    expect(item.dueAt).toBe(Date.parse("2026-10-10T09:00:00Z"));
    const { item: upd } = await rpc("content-studio.items.update", {
      itemId: item.id,
      summary: "60s reel",
      format: "reel",
      dueAt: null,
    });
    expect(upd).toMatchObject({
      title: "Hook test",
      summary: "60s reel",
      format: "reel",
      dueAt: null,
    });
    expect(upd.platform).toBe("instagram");
  });
});

describe("content pages (Block[] docs)", () => {
  let studio: ContentStudio;
  let rpc: Rpc;
  beforeEach(() => {
    studio = getContentStudio(tmp());
    rpc = rpcFor(studio);
  });

  it("persists blocks per item and survives reopening the database", async () => {
    const { item } = await rpc("content-studio.items.create", { title: "Script me" });
    expect(
      await rpc("content-studio.docs.getBlocks", { ownerKind: "item", ownerId: item.id }),
    ).toEqual({ blocks: [], updatedAt: 0 });
    const blocks = [
      { id: "b1", type: "h1", text: "Brief" },
      { id: "b2", type: "paragraph", text: "Open on the <b>result</b>." },
      { id: "b3", type: "video", text: "Take 3", src: "/plugins/content-studio/media?id=med_x" },
    ];
    const saved = await rpc("content-studio.docs.saveBlocks", {
      ownerKind: "item",
      ownerId: item.id,
      blocks,
    });
    expect(saved.updatedAt).toBeGreaterThan(0);

    const dbPath = studio.store.dbPath;
    resetContentStudios();
    const reopened = new ContentPipelineStore(dbPath);
    expect(reopened.getDoc("item", item.id).blocks).toEqual(blocks);
    const board = reopened.docStats("item").get(item.id);
    expect(board).toMatchObject({ blocks: 3, words: 7 });
    reopened.close();
  });

  it("rejects unknown owners and bad payloads", async () => {
    await expect(
      rpc("content-studio.docs.getBlocks", { ownerKind: "item", ownerId: "x" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      rpc("content-studio.docs.getBlocks", { ownerKind: "task", ownerId: "x" }),
    ).rejects.toThrow(/ownerKind/);
    const { item } = await rpc("content-studio.items.create", { title: "x" });
    await expect(
      rpc("content-studio.docs.saveBlocks", { ownerKind: "item", ownerId: item.id, blocks: "no" }),
    ).rejects.toThrow(/blocks array/);
  });

  it("markdown round-trips through set/append/get, including media embeds", async () => {
    const { item } = await rpc("content-studio.items.create", {
      title: "Reel",
      markdown: "# Hook\n\nStop scrolling — **this** changes _everything_.",
    });
    await rpc("content-studio.docs.appendMarkdown", {
      ownerKind: "item",
      ownerId: item.id,
      markdown:
        "- [ ] shoot B-roll\n\n![video: Take 3](/plugins/content-studio/media?id=med_abc123)\n\n![audio: VO](https://x.test/vo.mp3)",
    });
    const { blocks } = await rpc("content-studio.docs.getBlocks", {
      ownerKind: "item",
      ownerId: item.id,
    });
    expect(blocks.map((b: any) => b.type)).toEqual(["h1", "paragraph", "todo", "video", "audio"]);
    expect(blocks[1].text).toBe("Stop scrolling — <b>this</b> changes <i>everything</i>.");
    expect(blocks[3]).toMatchObject({ text: "Take 3", mediaId: "med_abc123" });
    const md = await rpc("content-studio.docs.getMarkdown", {
      ownerKind: "item",
      ownerId: item.id,
    });
    expect(md.markdown).toBe(
      [
        "# Hook",
        "Stop scrolling — **this** changes _everything_.",
        "- [ ] shoot B-roll",
        "![video: Take 3](/plugins/content-studio/media?id=med_abc123)",
        "![audio: VO](https://x.test/vo.mp3)",
      ].join("\n\n"),
    );
    expect(md.blockCount).toBe(5);
    const replaced = await rpc("content-studio.docs.setMarkdown", {
      ownerKind: "item",
      ownerId: item.id,
      markdown: "Just one line",
    });
    expect(replaced.blockCount).toBe(1);
  });

  it("tables and inline html serialise to readable markdown", () => {
    const md = studioBlocksToMarkdown([
      {
        id: "t",
        type: "table",
        text: "<table><tr><th>Shot</th><th>Len</th></tr><tr><td>Hook</td><td>2s</td></tr></table>",
      },
      { id: "p", type: "paragraph", text: 'See <a href="https://x.test/a?b=1&amp;c=2">brief</a>' },
    ]);
    expect(md).toBe(
      "| Shot | Len |\n| --- | --- |\n| Hook | 2s |\n\nSee [brief](https://x.test/a?b=1&c=2)",
    );
    const callout = studioMarkdownToBlocks("> 💡 Hook **first**");
    expect(callout[0]).toMatchObject({ type: "callout", text: "Hook <b>first</b>" });
    expect(studioBlocksToMarkdown(callout)).toBe("> 💡 Hook **first**");
    expect(studioMarkdownToBlocks("![clip](https://x.test/c.webm)")[0]!.type).toBe("video");
    expect(studioMarkdownToBlocks("![pic](https://x.test/c.png)")[0]!.type).toBe("image");
    expect(studioMarkdownToBlocks("a <script>x</script>")[0]!.text).toBe(
      "a &lt;script&gt;x&lt;/script&gt;",
    );
  });
});

describe("ideas pages", () => {
  it("create, list (pinned first), update, promote onto the board, delete", async () => {
    const studio = getContentStudio(tmp());
    const rpc = rpcFor(studio);
    const a = (await rpc("content-studio.ideas.create", { title: "Series: AI tools" })).idea;
    const b = (
      await rpc("content-studio.ideas.create", {
        title: "Founder story",
        markdown: "## Angle\n\nOrigin story in 3 beats.",
        tags: ["story"],
      })
    ).idea;
    expect(b.excerpt).toBe("Angle Origin story in 3 beats.");
    await rpc("content-studio.ideas.update", { ideaId: a.id, pinned: true, icon: "🔥" });
    let { ideas } = await rpc("content-studio.ideas.list");
    expect(ideas.map((i: any) => i.title)).toEqual(["Series: AI tools", "Founder story"]);
    expect(ideas[0]).toMatchObject({ pinned: true, icon: "🔥" });

    const media = await studio.media.saveBuffer({
      buffer: PNG,
      filename: "ref.png",
      source: "upload",
    });
    await rpc("content-studio.media.attach", {
      mediaId: media.id,
      ownerKind: "idea",
      ownerId: b.id,
    });

    const stages = studio.store.listStages();
    const promoted = await rpc("content-studio.ideas.promote", {
      ideaId: b.id,
      stageId: stages[1]!.id,
    });
    expect(promoted.item).toMatchObject({
      title: "Founder story",
      stageId: stages[1]!.id,
      tags: ["story"],
    });
    expect(promoted.item.mediaCount).toBe(1);
    expect(promoted.item.cover?.id).toBe(media.id);
    expect(promoted.idea.promotedItemId).toBe(promoted.item.id);
    const page = await rpc("content-studio.docs.getMarkdown", {
      ownerKind: "item",
      ownerId: promoted.item.id,
    });
    expect(page.markdown).toBe("## Angle\n\nOrigin story in 3 beats.");

    await rpc("content-studio.ideas.delete", { ideaId: a.id });
    ({ ideas } = await rpc("content-studio.ideas.list"));
    expect(ideas.map((i: any) => i.id)).toEqual([b.id]);
    // Deleting the promoted item clears the back-link.
    await rpc("content-studio.items.delete", { itemId: promoted.item.id });
    expect(studio.store.getIdea(b.id)?.promotedItemId).toBeNull();
  });
});

describe("media", () => {
  let studio: ContentStudio;
  let rpc: Rpc;
  let dir: string;
  beforeEach(() => {
    dir = tmp();
    studio = getContentStudio(dir);
    rpc = rpcFor(studio);
  });

  it("stores uploads under the plugin data dir, links them and sets the item cover", async () => {
    const { item } = await rpc("content-studio.items.create", { title: "x" });
    const m = await studio.media.saveBuffer({
      buffer: PNG,
      filename: "../../evil name.png",
      source: "upload",
    });
    expect(m).toMatchObject({
      kind: "image",
      mime: "image/png",
      filename: "evil name.png",
      size: PNG.length,
    });
    expect(fs.existsSync(path.join(dir, "media", m.file!))).toBe(true);
    const attached = await rpc("content-studio.media.attach", {
      mediaId: m.id,
      ownerKind: "item",
      ownerId: item.id,
    });
    expect(attached.media[0].url).toBe(`/plugins/content-studio/media?id=${m.id}`);
    const got = await rpc("content-studio.items.get", { itemId: item.id });
    expect(got.item.cover.id).toBe(m.id);
    expect(got.media).toHaveLength(1);

    await rpc("content-studio.media.detach", {
      mediaId: m.id,
      ownerKind: "item",
      ownerId: item.id,
    });
    expect((await rpc("content-studio.items.get", { itemId: item.id })).item.cover).toBeNull();

    await rpc("content-studio.media.delete", { mediaId: m.id });
    expect(fs.existsSync(path.join(dir, "media", m.file!))).toBe(false);
  });

  it("references URLs without downloading and refuses non-http schemes", async () => {
    const { idea } = await rpc("content-studio.ideas.create", { title: "refs" });
    const res = await rpc("content-studio.media.reference", {
      url: "https://cdn.test/clip.mp4",
      ownerKind: "idea",
      ownerId: idea.id,
    });
    expect(res.media).toMatchObject({
      kind: "video",
      source: "url",
      url: "https://cdn.test/clip.mp4",
    });
    await expect(
      rpc("content-studio.media.reference", { url: "javascript:alert(1)" }),
    ).rejects.toThrow(/http/);
    await expect(
      rpc("content-studio.media.reference", { url: "file:///etc/passwd" }),
    ).rejects.toThrow();
  });

  it("importUrl follows redirects through the host guard and blocks private hosts", async () => {
    const seen: string[] = [];
    const fetchImpl = async (url: RequestInfo | URL) => {
      const u = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      if (u.endsWith("/start")) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://cdn.test/img.png" },
        });
      }
      return new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });
    };
    const assertHost = async (h: string) => {
      seen.push(h);
      if (h === "169.254.169.254") throw new Error("blocked private host");
    };
    const m = await studio.media.importUrl({
      url: "https://a.test/start",
      fetchImpl,
      assertHost,
      source: "flypic",
    });
    expect(seen).toEqual(["a.test", "cdn.test"]);
    expect(m).toMatchObject({ kind: "image", source: "flypic", size: PNG.length });
    await expect(
      studio.media.importUrl({ url: "http://169.254.169.254/latest", fetchImpl, assertHost }),
    ).rejects.toThrow(/blocked/);
  });

  it("serves files with Range support and accepts raw-body uploads over HTTP", async () => {
    const { item } = await rpc("content-studio.items.create", { title: "x" });
    const server = http.createServer((req, res) => void studio.media.handleHttp(req, res));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/plugins/content-studio/media`;
    try {
      const up = await fetch(`${base}?filename=clip.png&ownerKind=item&ownerId=${item.id}`, {
        method: "POST",
        body: PNG,
        headers: { "content-type": "image/png" },
      });
      expect(up.status).toBe(200);
      const { media } = (await up.json()) as { media: { id: string; url: string } };
      expect(studio.store.listMediaFor("item", item.id).map((m) => m.id)).toEqual([media.id]);

      const full = await fetch(`${base}?id=${media.id}`);
      expect(full.status).toBe(200);
      expect(full.headers.get("content-type")).toBe("image/png");
      expect(Buffer.from(await full.arrayBuffer()).equals(PNG)).toBe(true);

      const part = await fetch(`${base}?id=${media.id}`, { headers: { range: "bytes=0-7" } });
      expect(part.status).toBe(206);
      expect(part.headers.get("content-range")).toBe(`bytes 0-7/${PNG.length}`);
      expect((await part.arrayBuffer()).byteLength).toBe(8);

      expect((await fetch(`${base}?id=med_missing`)).status).toBe(404);
      const bad = await fetch(`${base}?filename=x.png&ownerKind=item&ownerId=nope`, {
        method: "POST",
        body: PNG,
      });
      expect(bad.status).toBe(400);
      expect(studio.store.listMedia().length).toBe(1); // bad owner leaves no orphan
    } finally {
      server.close();
    }
  });
});

describe("content_pipeline agent tool", () => {
  it("drives the board by stage name, writes pages and attaches local files", async () => {
    const stateDir = tmp();
    process.env.INFINIBOT_STATE_DIR = stateDir;
    const tool = createContentPipelineTool();
    const run = async (args: Record<string, unknown>) =>
      ((await tool.execute("t", args as never)) as { details: any }).details;

    const created = await run({
      action: "create_item",
      title: "Agent reel",
      stage: "script",
      platform: "tiktok",
      markdown: "# Hook\n\nThree tools in 30 seconds.",
    });
    expect(created.stage).toBe("Script");
    const id = created.item.id;
    const moved = await run({ action: "move_item", itemId: id, stage: "Produce" });
    expect(moved.stage).toBe("Produce");
    await expect(run({ action: "move_item", itemId: id, stage: "Nowhere" })).rejects.toThrow(
      /unknown stage "Nowhere". Stages: Idea, Script/,
    );
    await run({ action: "append_page", itemId: id, markdown: "- shot 1\n- shot 2" });

    const png = path.join(stateDir, "frame.png");
    fs.writeFileSync(png, PNG);
    const att = await run({ action: "attach_media", itemId: id, path: png, caption: "Frame 1" });
    expect(att.media).toMatchObject({ kind: "image", source: "agent" });

    const got = await run({ action: "get_item", itemId: id });
    expect(got.stage).toBe("Produce");
    expect(got.page).toBe(
      `# Hook\n\nThree tools in 30 seconds.\n\n- shot 1\n\n- shot 2\n\n![Frame 1](${att.media.url})`,
    );
    expect(got.item.cover.id).toBe(att.media.id);

    await run({ action: "create_stage", title: "Review", wipLimit: 3, index: 4 });
    const board = await run({ action: "board" });
    expect(board.stages.map((s: any) => s.name)).toEqual([
      "Idea",
      "Script",
      "Produce",
      "Edit",
      "Review",
      "Schedule",
      "Published",
    ]);
    expect(board.stages[2].items[0]).toMatchObject({ title: "Agent reel", media: 1 });

    const idea = await run({ action: "create_idea", title: "Later", markdown: "maybe" });
    await run({ action: "append_idea", ideaId: idea.idea.id, markdown: "**yes**" });
    const promoted = await run({ action: "promote_idea", ideaId: idea.idea.id, stage: "Edit" });
    expect(promoted.stage).toBe("Edit");
    expect((await run({ action: "get_page", itemId: promoted.item.id })).markdown).toBe(
      "maybe\n\n**yes**",
    );
    // Data lands in the tenant's plugin data dir.
    expect(fs.existsSync(path.join(stateDir, "plugin-data", "content-studio", "studio.db"))).toBe(
      true,
    );
  });
});
