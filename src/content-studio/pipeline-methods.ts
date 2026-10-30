/**
 * Gateway handlers for the plugin-native Content Studio methods
 * (CONTENT_STUDIO_NATIVE_METHODS): pipeline board, stages, items, content
 * pages (Block[] docs), Ideas pages and media.
 *
 * docs.getBlocks / docs.saveBlocks take `{ ownerKind, ownerId }` and answer in
 * the same shape kanban.*.content.getBlocks/saveBlocks use, which is what the
 * shared rich-doc-editor speaks.
 */

import type {
  GatewayRequestHandler,
  GatewayRequestHandlerOptions,
} from "../gateway/server-methods/types.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import { viewMedia } from "./media-files.js";
import type { ContentStudioPipelineMethod } from "./methods.js";
import { ContentStudioError, type DocOwnerKind } from "./pipeline-store.js";
import {
  boardItem,
  buildBoard,
  getContentStudio,
  getDocMarkdown,
  ideaView,
  listIdeaViews,
  setDocMarkdown,
  type ContentStudio,
} from "./studio.js";

type P = Record<string, unknown>;
type Impl = (params: P, studio: ContentStudio) => unknown;

const str = (v: unknown): string => (typeof v === "string" ? v : "");

function ownerOf(p: P): { kind: DocOwnerKind; id: string } {
  const kind = p.ownerKind === "idea" ? "idea" : p.ownerKind === "item" ? "item" : null;
  if (!kind) throw new ContentStudioError("BAD_REQUEST", 'ownerKind must be "item" or "idea"');
  const id = str(p.ownerId);
  if (!id) throw new ContentStudioError("BAD_REQUEST", "ownerId required");
  return { kind, id };
}

/** True when the FlyPic plugin is loaded and can generate images. */
export function flypicAvailable(): boolean {
  const handlers = getActivePluginRegistry()?.gatewayHandlers ?? {};
  return (
    typeof handlers["flypic.generate"] === "function" &&
    typeof handlers["flypic.job.get"] === "function"
  );
}

const IMPLS: Record<ContentStudioPipelineMethod, Impl> = {
  "content-studio.board.get": (_p, s) => buildBoard(s),

  "content-studio.stages.create": (p, s) => ({ stage: s.store.createStage(p) }),
  "content-studio.stages.update": (p, s) => ({ stage: s.store.updateStage(p.stageId, p) }),
  "content-studio.stages.reorder": (p, s) => ({ stages: s.store.reorderStages(p.order) }),
  "content-studio.stages.delete": (p, s) => s.store.deleteStage(p.stageId, p.moveItemsTo),

  "content-studio.items.get": (p, s) => {
    const item = s.store.requireItem(p.itemId);
    return {
      item: boardItem(s, item),
      stage: s.store.getStage(item.stageId),
      media: s.store.listMediaFor("item", item.id).map(viewMedia),
    };
  },
  "content-studio.items.create": (p, s) => {
    const item = s.store.createItem(p);
    if (typeof p.markdown === "string" && p.markdown.trim()) {
      setDocMarkdown(s, "item", item.id, p.markdown, "replace");
    }
    return { item: boardItem(s, item) };
  },
  "content-studio.items.update": (p, s) => ({
    item: boardItem(s, s.store.updateItem(p.itemId, p)),
  }),
  "content-studio.items.move": (p, s) => ({
    item: boardItem(s, s.store.moveItem(p.itemId, p.toStageId, p.toIndex)),
  }),
  "content-studio.items.delete": (p, s) => s.store.deleteItem(p.itemId),

  "content-studio.docs.getBlocks": (p, s) => {
    const o = ownerOf(p);
    return s.store.getDoc(o.kind, o.id);
  },
  "content-studio.docs.saveBlocks": (p, s) => {
    const o = ownerOf(p);
    return s.store.saveDoc(o.kind, o.id, p.blocks);
  },
  "content-studio.docs.getMarkdown": (p, s) => {
    const o = ownerOf(p);
    s.store.getDoc(o.kind, o.id); // existence check
    return getDocMarkdown(s, o.kind, o.id);
  },
  "content-studio.docs.setMarkdown": (p, s) => {
    const o = ownerOf(p);
    if (typeof p.markdown !== "string")
      throw new ContentStudioError("BAD_REQUEST", "markdown required");
    return setDocMarkdown(s, o.kind, o.id, p.markdown, "replace");
  },
  "content-studio.docs.appendMarkdown": (p, s) => {
    const o = ownerOf(p);
    if (typeof p.markdown !== "string")
      throw new ContentStudioError("BAD_REQUEST", "markdown required");
    return setDocMarkdown(s, o.kind, o.id, p.markdown, "append");
  },

  "content-studio.ideas.list": (_p, s) => ({ ideas: listIdeaViews(s) }),
  "content-studio.ideas.create": (p, s) => {
    const idea = s.store.createIdea(p);
    if (typeof p.markdown === "string" && p.markdown.trim()) {
      setDocMarkdown(s, "idea", idea.id, p.markdown, "replace");
    }
    return { idea: ideaView(s, idea) };
  },
  "content-studio.ideas.update": (p, s) => ({ idea: ideaView(s, s.store.updateIdea(p.ideaId, p)) }),
  "content-studio.ideas.delete": (p, s) => s.store.deleteIdea(p.ideaId),
  "content-studio.ideas.promote": (p, s) => {
    const res = s.store.promoteIdea(p.ideaId, p.stageId);
    return { idea: ideaView(s, res.idea), item: boardItem(s, res.item) };
  },

  "content-studio.media.list": (p, s) => {
    if (p.ownerKind !== undefined || p.ownerId !== undefined) {
      const o = ownerOf(p);
      return { media: s.store.listMediaFor(o.kind, o.id).map(viewMedia) };
    }
    const limit = typeof p.limit === "number" ? p.limit : 200;
    return { media: s.store.listMedia(limit).map(viewMedia) };
  },
  "content-studio.media.capabilities": () => ({
    upload: { route: "/plugins/content-studio/media", method: "POST" },
    flypic: flypicAvailable(),
  }),
  "content-studio.media.reference": (p, s) => {
    const kind =
      p.kind === "video" || p.kind === "audio" || p.kind === "image" ? p.kind : undefined;
    const media = s.media.reference({ url: str(p.url), caption: str(p.caption), kind });
    if (p.ownerKind !== undefined) {
      const o = ownerOf(p);
      s.store.linkMedia(media.id, o.kind, o.id);
    }
    return { media: viewMedia(media) };
  },
  "content-studio.media.importUrl": async (p, s) => {
    const owner = p.ownerKind !== undefined ? ownerOf(p) : null;
    if (owner) s.store.listMediaFor(owner.kind, owner.id); // validate before downloading
    const media = await s.media.importUrl({
      url: str(p.url),
      caption: str(p.caption),
      source: p.source === "flypic" ? "flypic" : "url",
    });
    if (owner) s.store.linkMedia(media.id, owner.kind, owner.id);
    return { media: viewMedia(media) };
  },
  "content-studio.media.attach": (p, s) => {
    const o = ownerOf(p);
    return { media: s.store.linkMedia(p.mediaId, o.kind, o.id).map(viewMedia) };
  },
  "content-studio.media.detach": (p, s) => {
    const o = ownerOf(p);
    return { media: s.store.unlinkMedia(p.mediaId, o.kind, o.id).map(viewMedia) };
  },
  "content-studio.media.delete": (p, s) => ({ deleted: s.media.delete(p.mediaId).id }),
};

export function createPipelineHandlers(
  resolveStudio: () => ContentStudio = () => getContentStudio(),
): Record<ContentStudioPipelineMethod, GatewayRequestHandler> {
  const out = {} as Record<ContentStudioPipelineMethod, GatewayRequestHandler>;
  for (const [method, impl] of Object.entries(IMPLS) as Array<
    [ContentStudioPipelineMethod, Impl]
  >) {
    out[method] = async ({ params, respond }: GatewayRequestHandlerOptions) => {
      try {
        respond(true, await impl(params ?? {}, resolveStudio()));
      } catch (err) {
        if (err instanceof ContentStudioError) {
          respond(false, undefined, {
            code: err.code === "NOT_FOUND" ? "NOT_FOUND" : "INVALID_REQUEST",
            message: err.message,
          });
          return;
        }
        respond(false, undefined, {
          code: "INTERNAL_ERROR",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    };
  }
  return out;
}
