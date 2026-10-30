/**
 * content_pipeline — agent tool for the Content Studio production board,
 * content pages, Ideas pages and media. Same store and semantics as the
 * `content-studio.*` pipeline RPCs the UI uses, so whatever an agent does
 * shows up on the board (stages can be referenced by id or by name).
 *
 * The store loads lazily on first call; registering the tool opens nothing.
 */

import { Type } from "@sinclair/typebox";

import type { AnyAgentTool } from "../agents/tools/common.js";
import { jsonResult, readNumberParam, readStringParam } from "../agents/tools/common.js";
import { stringEnum } from "../agents/schema/typebox.js";

export const CONTENT_PIPELINE_TOOL_NAME = "content_pipeline";

const ACTIONS = [
  "board",
  "get_item",
  "create_item",
  "update_item",
  "move_item",
  "delete_item",
  "create_stage",
  "update_stage",
  "reorder_stages",
  "delete_stage",
  "get_page",
  "set_page",
  "append_page",
  "list_ideas",
  "create_idea",
  "append_idea",
  "promote_idea",
  "attach_media",
  "list_media",
] as const;

const Schema = Type.Object({
  action: stringEnum(ACTIONS, {
    description:
      "board (stages + items), get_item, create_item, update_item, move_item, delete_item, " +
      "create_stage, update_stage (rename/colour/WIP), reorder_stages, delete_stage, " +
      "get_page / set_page / append_page (an item's or idea's markdown page), " +
      "list_ideas, create_idea, append_idea, promote_idea (idea → pipeline item), " +
      "attach_media (url or local file → item/idea), list_media.",
  }),
  itemId: Type.Optional(Type.String({ description: "Pipeline item id." })),
  ideaId: Type.Optional(Type.String({ description: "Ideas page id." })),
  stage: Type.Optional(
    Type.String({
      description:
        "Stage id or name (e.g. 'Script'). create_item/promote_idea: where it lands (default first stage); move_item: destination; update_stage/delete_stage: which stage.",
    }),
  ),
  index: Type.Optional(
    Type.Number({ description: "0-based position inside the stage (default: end)." }),
  ),
  title: Type.Optional(Type.String({ description: "Item / idea title, or stage name." })),
  summary: Type.Optional(Type.String({ description: "One-line item summary shown on the card." })),
  platform: Type.Optional(
    Type.String({ description: "instagram, tiktok, youtube, linkedin, x, newsletter, blog…" }),
  ),
  format: Type.Optional(Type.String({ description: "reel, short, carousel, thread, long-form…" })),
  tags: Type.Optional(Type.Array(Type.String())),
  dueAt: Type.Optional(Type.String({ description: "Due/publish date (ISO)." })),
  assignee: Type.Optional(Type.String({ description: "Agent id or person." })),
  markdown: Type.Optional(
    Type.String({
      description:
        "Markdown for set_page/append_page/create_item/create_idea/append_idea. Headings, lists, " +
        "todos, quotes, code, images ![alt](url); embed video/audio as ![video: caption](url) / ![audio: caption](url).",
    }),
  ),
  color: Type.Optional(Type.String({ description: "Stage colour (#hex)." })),
  wipLimit: Type.Optional(Type.Number({ description: "Stage WIP limit (0 clears it)." })),
  order: Type.Optional(
    Type.Array(Type.String(), { description: "reorder_stages: every stage id/name, in order." }),
  ),
  moveItemsTo: Type.Optional(
    Type.String({ description: "delete_stage: stage (id/name) that receives its items." }),
  ),
  url: Type.Optional(Type.String({ description: "attach_media: public http(s) URL." })),
  path: Type.Optional(
    Type.String({ description: "attach_media: local file path (render, screenshot, audio…)." }),
  ),
  download: Type.Optional(
    Type.Boolean({
      description:
        "attach_media with url: true = copy the file into the studio (default; survives expiring links), false = reference only.",
    }),
  ),
  caption: Type.Optional(Type.String()),
  embed: Type.Optional(
    Type.Boolean({
      description:
        "attach_media: also append the media as a block at the end of the page (default true).",
    }),
  ),
});

export function createContentPipelineTool(_ctx?: { agentId?: string }): AnyAgentTool {
  return {
    label: "Content Pipeline",
    name: CONTENT_PIPELINE_TOOL_NAME,
    description:
      "Drive the Content Studio production pipeline: a drag-and-drop board of content items moving through " +
      "stages (default Idea → Script → Produce → Edit → Schedule → Published). Create/move/update items, " +
      "manage stages (add, rename, reorder, WIP limits, delete), write each item's rich markdown page " +
      "(brief, script, shot list), keep free-form Ideas pages and promote them onto the board, and attach " +
      "images/video/audio to items or ideas. Everything appears live on the Content Studio page.",
    parameters: Schema,
    execute: async (_toolCallId, args) => {
      const p = args as Record<string, unknown>;
      const action = readStringParam(p, "action", { required: true });
      const {
        getContentStudio,
        buildBoard,
        boardItem,
        getDocMarkdown,
        setDocMarkdown,
        listIdeaViews,
        ideaView,
      } = await import("./studio.js");
      const { viewMedia } = await import("./media-files.js");
      const studio = getContentStudio();
      const { store } = studio;

      const stageRef = (key = "stage", required = false) => {
        const ref = readStringParam(p, key, { required });
        if (!ref) return undefined;
        const stage = store.findStage(ref);
        if (!stage) {
          throw new Error(
            `unknown stage "${ref}". Stages: ${store
              .listStages()
              .map((s) => s.name)
              .join(", ")}`,
          );
        }
        return stage.id;
      };
      const itemId = () => readStringParam(p, "itemId", { required: true });
      const ideaId = () => readStringParam(p, "ideaId", { required: true });
      const index = readNumberParam(p, "index", { required: false });
      const owner = (): { kind: "item" | "idea"; id: string } => {
        const item = readStringParam(p, "itemId");
        if (item) return { kind: "item", id: item };
        const idea = readStringParam(p, "ideaId");
        if (idea) return { kind: "idea", id: idea };
        throw new Error("itemId or ideaId required");
      };
      const itemFields = () => ({
        title: p.title,
        summary: p.summary,
        platform: p.platform,
        format: p.format,
        tags: p.tags,
        dueAt: p.dueAt,
        assignee: p.assignee,
      });
      const compactBoard = () => {
        const board = buildBoard(studio);
        return {
          stages: board.stages.map((s) => ({
            id: s.id,
            name: s.name,
            count: s.count,
            wipLimit: s.wipLimit,
            overWip: s.overWip,
            items: board.items
              .filter((i) => i.stageId === s.id)
              .map((i) => ({
                id: i.id,
                title: i.title,
                platform: i.platform,
                format: i.format,
                dueAt: i.dueAt ? new Date(i.dueAt).toISOString() : null,
                tags: i.tags,
                pageWords: i.docWords,
                media: i.mediaCount,
              })),
          })),
        };
      };

      switch (action) {
        case "board":
          return jsonResult(compactBoard());
        case "get_item": {
          const item = store.requireItem(itemId());
          return jsonResult({
            item: boardItem(studio, item),
            stage: store.getStage(item.stageId)?.name,
            page: getDocMarkdown(studio, "item", item.id).markdown,
            media: store.listMediaFor("item", item.id).map(viewMedia),
          });
        }
        case "create_item": {
          const item = store.createItem({ ...itemFields(), stageId: stageRef(), index });
          const md = readStringParam(p, "markdown", { trim: false });
          if (md) setDocMarkdown(studio, "item", item.id, md, "replace");
          return jsonResult({
            item: boardItem(studio, item),
            stage: store.getStage(item.stageId)?.name,
          });
        }
        case "update_item":
          return jsonResult({ item: boardItem(studio, store.updateItem(itemId(), itemFields())) });
        case "move_item": {
          const item = store.moveItem(itemId(), stageRef("stage", true), index);
          return jsonResult({
            item: boardItem(studio, item),
            stage: store.getStage(item.stageId)?.name,
          });
        }
        case "delete_item":
          return jsonResult(store.deleteItem(itemId()));
        case "create_stage":
          return jsonResult({
            stage: store.createStage({
              name: p.title,
              color: p.color,
              wipLimit: p.wipLimit,
              index,
            }),
          });
        case "update_stage":
          return jsonResult({
            stage: store.updateStage(stageRef("stage", true), {
              name: p.title,
              color: p.color,
              wipLimit: p.wipLimit,
            }),
          });
        case "reorder_stages": {
          const order = Array.isArray(p.order)
            ? p.order.map((r) => {
                const s = store.findStage(String(r));
                if (!s) throw new Error(`unknown stage "${String(r)}"`);
                return s.id;
              })
            : [];
          return jsonResult({ stages: store.reorderStages(order).map((s) => s.name) });
        }
        case "delete_stage":
          return jsonResult(store.deleteStage(stageRef("stage", true), stageRef("moveItemsTo")));
        case "get_page": {
          const o = owner();
          store.getDoc(o.kind, o.id);
          return jsonResult(getDocMarkdown(studio, o.kind, o.id));
        }
        case "set_page":
        case "append_page": {
          const o = owner();
          const md = readStringParam(p, "markdown", { required: true, trim: false });
          return jsonResult(
            setDocMarkdown(studio, o.kind, o.id, md, action === "set_page" ? "replace" : "append"),
          );
        }
        case "list_ideas":
          return jsonResult({
            ideas: listIdeaViews(studio).map((i) => ({
              id: i.id,
              title: i.title,
              tags: i.tags,
              pinned: i.pinned,
              words: i.docWords,
              promotedItemId: i.promotedItemId,
              excerpt: i.excerpt,
            })),
          });
        case "create_idea": {
          const idea = store.createIdea({ title: p.title, tags: p.tags });
          const md = readStringParam(p, "markdown", { trim: false });
          if (md) setDocMarkdown(studio, "idea", idea.id, md, "replace");
          return jsonResult({ idea: ideaView(studio, idea) });
        }
        case "append_idea": {
          const md = readStringParam(p, "markdown", { required: true, trim: false });
          return jsonResult(setDocMarkdown(studio, "idea", ideaId(), md, "append"));
        }
        case "promote_idea": {
          const res = store.promoteIdea(ideaId(), stageRef());
          return jsonResult({
            item: boardItem(studio, res.item),
            stage: store.getStage(res.item.stageId)?.name,
          });
        }
        case "attach_media": {
          const o = owner();
          store.listMediaFor(o.kind, o.id); // validate the owner first
          const caption = readStringParam(p, "caption") ?? "";
          const url = readStringParam(p, "url");
          const file = readStringParam(p, "path");
          let media;
          if (file) media = await studio.media.importFile({ path: file, caption });
          else if (url && p.download === false) media = studio.media.reference({ url, caption });
          else if (url) media = await studio.media.importUrl({ url, caption, source: "agent" });
          else throw new Error("url or path required");
          store.linkMedia(media.id, o.kind, o.id);
          const view = viewMedia(media);
          if (p.embed !== false && media.kind !== "file") {
            const alt =
              media.kind === "image" ? caption || media.filename : `${media.kind}: ${caption}`;
            setDocMarkdown(
              studio,
              o.kind,
              o.id,
              `![${alt.replace(/[[\]]/g, "")}](${view.url})`,
              "append",
            );
          }
          return jsonResult({ media: view });
        }
        case "list_media": {
          const item = readStringParam(p, "itemId");
          const idea = readStringParam(p, "ideaId");
          const media =
            item || idea
              ? store.listMediaFor(item ? "item" : "idea", (item ?? idea)!)
              : store.listMedia(50);
          return jsonResult({ media: media.map(viewMedia) });
        }
        default:
          throw new Error(`unknown action: ${action}`);
      }
    },
  };
}
